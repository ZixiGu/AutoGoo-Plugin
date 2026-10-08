/**
 * AutoGoo-Plugin goo-plan — 生成 DAG 执行计划
 *
 * 负责：thread 检查 → wiki 召回 → 输入识别 → goal 抽取 → DAG 拆解
 * → 并行审计 → context 固化 → plan 落盘 → 用户确认
 *
 * This is the core "value" command. It guides the LLM through planning
 * by invoking Python scripts and presenting structured UI.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  TEMPLATE_THREAD_ACTION,
  TEMPLATE_PLAN_REVIEW_START,
  TEMPLATE_CONTEXT_SYNC_CONFIRM,
  TEMPLATE_REMOTE_RESOURCE_USAGE,
} from "../constants.js";
import {
  loadPlan,
  savePlan,
  archiveOldPlan,
  getCurrentThreadId,
  setCurrentThreadId,
  generateThreadId,
  generateTimestamp,
  loadThreadMeta,
  saveThreadMeta,
  updateThreadsIndex,
  type Plan,
  type Step,
  type Goal,
} from "../utils/plan.js";
import {
  REPO_ROOT,
  RESOLVE_ROOT_SH,
  REMOTE_RESOURCES_PY,
  WIKI_GRAPH_ASSIST_PY,
  getServers,
  type AutogooPluginConfig,
  projectPlanPath,
  projectBrainstormPath,
  projectThreadsDir,
  projectThreadDir,
  resolveWikiDir,
} from "../utils/paths.js";
import { resolveProjectSlug } from "../utils/dispatch.js";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execShell, execPython } from "../utils/exec.js";
import { uiSelect } from "../utils/ui.js";

export async function handleGooPlan(taskDescription: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  const pi = ctx as any;

  if (!taskDescription?.trim()) {
    ctx.ui.notify("请输入任务描述。例如：/auto-goo:goo-plan 实现一个用户登录功能", "warning");
    return;
  }

  // ── Step 1: Check existing plan / thread ───────────────────────────────────
  const { threadAction, threadId } = await resolveThread(cwd, ctx);
  if (threadAction === "cancel") {
    ctx.ui.notify("已取消规划。", "info");
    return;
  }

  const activeThreadId = threadId || generateThreadId();
  const isNewThread = threadAction === "new";

  // ── Step 2: Wiki recall ───────────────────────────────────────────────────
  ctx.ui.notify("正在召回 Goo-wiki 经验...", "info");
  const wikiContext = await recallWiki(cwd, taskDescription, ctx);

  // ── Step 3: Check for brainstorm reference ─────────────────────────────────
  let brainstormGoals: Goal[] = [];
  const brainstormRef = taskDescription.match(/--brainstorm(?:-id)?\s+(\S+)/);
  if (brainstormRef) {
    const bs = await loadBrainstorm(cwd, brainstormRef[1]);
    if (bs?.candidate_goals) {
      brainstormGoals = bs.candidate_goals.map((g: any, i: number) => ({
        id: `g${i + 1}`,
        name: g.name || `Goal ${i + 1}`,
        description: g.why || "",
        priority: i + 1,
        status: "pending",
        acceptance_criteria: g.acceptance_criteria || [],
        outputs: g.expected_output ? [g.expected_output] : [],
        depends_on: [],
      }));
    }
  }

  // ── Step 4: Generate plan structure ────────────────────────────────────────
  ctx.ui.notify("正在生成 DAG 计划...", "info");
  const plan = await generatePlan(cwd, taskDescription, wikiContext, brainstormGoals, activeThreadId, isNewThread, ctx);

  if (!plan) {
    ctx.ui.notify("计划生成失败，请重试。", "error");
    return;
  }

  // ── Step 5: Remote resource check ─────────────────────────────────────────
  await checkRemoteResources(cwd, plan, ctx);

  // ── Step 6: Save plan ──────────────────────────────────────────────────────
  // Create thread directories
  const threadDir = join(projectThreadDir(cwd, activeThreadId));
  await mkdir(threadDir, { recursive: true });
  await mkdir(join(threadDir, "logs"), { recursive: true });
  await mkdir(join(threadDir, "artifacts"), { recursive: true });

  // Save plan
  plan.thread = {
    id: activeThreadId,
    plan_path: join(threadDir, "plan.json"),
    logs_dir: join(threadDir, "logs"),
    artifacts_dir: join(threadDir, "artifacts"),
  };
  plan.review = { status: "pending_user_review" };
  await savePlan(cwd, plan, join(threadDir, "plan.json"));

  // Save thread meta
  await saveThreadMeta(cwd, {
    id: activeThreadId,
    status: "pending",
    created_at: plan.created_at,
    plan_path: join(threadDir, "plan.json"),
    logs_dir: join(threadDir, "logs"),
    artifacts_dir: join(threadDir, "artifacts"),
    task: plan.task,
  });

  // Update current thread and index
  await setCurrentThreadId(cwd, activeThreadId);
  await updateThreadsIndex(cwd);

  // Also save compat plan.json
  await savePlan(cwd, plan);

  // ── Step 7: Show plan in editor and get confirmation ───────────────────────
  // Show plan summary in the editor so user can see the full content
  const planSummary = formatPlanSummary(plan);
  ctx.ui.setEditorText(
    `📋 计划已生成，请审阅并确认：\n\n${planSummary}\n\n` +
    `─────────────────\n` +
    `请在下方选择操作：`
  );
  ctx.ui.notify(`📋 计划已生成！共 ${plan.steps.length} 步，请在编辑器中查看并确认。`, "info");

  // 高影响操作：超时会直接进入执行阶段，因此超时一律取消，等用户显式确认。
  const reviewChoice = await uiSelect(ctx, TEMPLATE_PLAN_REVIEW_START.header, TEMPLATE_PLAN_REVIEW_START.options, { onTimeout: "cancel" });

  if (reviewChoice === "cancel") {
    ctx.ui.setEditorText("");
    ctx.ui.notify("计划已保存（pending_user_review），等待后续使用。", "info");
    return;
  }

  const modifyOptions = ["modify_step", "split_merge", "modify_dag", "modify_goal"];
  if (modifyOptions.includes(reviewChoice)) {
    const hints: Record<string, string> = {
      modify_step: "（调整步骤详情后重新运行 /goo-plan）",
      split_merge: "（拆分或合并步骤后重新运行 /goo-plan）",
      modify_dag: "（调整 DAG 依赖关系后重新运行 /goo-plan）",
      modify_goal: "（调整目标或约束后重新运行 /goo-plan）",
    };
    ctx.ui.setEditorText(
      `请修改以下计划${hints[reviewChoice] || ""}：\n\n${planSummary}`
    );
    ctx.ui.notify(`请在编辑器中修改计划后重新运行 /goo-plan。`, "info");
    return;
  }

  // confirm: approve plan
  if (brainstormGoals.length > 0) {
    await archiveBrainstorm(cwd, brainstormRef![1], activeThreadId, ctx);
  }

  plan.review = { status: "approved" };
  await savePlan(cwd, plan, join(threadDir, "plan.json"));
  await savePlan(cwd, plan);
  ctx.ui.setEditorText("");

  ctx.ui.notify(`✅ 计划已确认！线程 ID: ${activeThreadId}`, "success");
  ctx.ui.notify("使用 /goo-start 执行，或 /goo-status 查看详情", "info");
}

// ── Thread resolution ──────────────────────────────────────────────────────

async function resolveThread(cwd: string, ctx: ExtensionContext): Promise<{ threadAction: string; threadId: string | null }> {
  const currentPlan = await loadPlan(cwd);
  if (!currentPlan) return { threadAction: "new", threadId: null };

  // Check if any step is not completed
  const hasUnfinished = currentPlan.steps?.some(s => s.status !== "completed");
  if (!hasUnfinished) return { threadAction: "new", threadId: null };

  const unfinishedCount = currentPlan.steps.filter(s => s.status !== "completed").length;
  const currentThreadId = await getCurrentThreadId(cwd);

  ctx.ui.notify(`当前 thread 还有 ${unfinishedCount} 个未完成步骤。`, "warning");

  // 高影响操作：新建 thread 会归档当前 plan，超时一律取消。
  const choice = await uiSelect(ctx, TEMPLATE_THREAD_ACTION.header, TEMPLATE_THREAD_ACTION.options, { onTimeout: "cancel" });
  if (!choice || choice === "cancel") return { threadAction: "cancel", threadId: null };
  if (choice === "continue") return { threadAction: "continue", threadId: currentThreadId };

  // "new": archive old plan
  await archiveOldPlan(cwd, currentPlan);
  return { threadAction: "new", threadId: null };
}

// ── Wiki recall ────────────────────────────────────────────────────────────

interface WikiContext {
  found: boolean;
  sources: string[];
  reused_knowledge: string[];
}

async function recallWiki(cwd: string, task: string, ctx: ExtensionContext): Promise<WikiContext> {
  const wikiScript = join(REPO_ROOT, "skills/auto-goo/scripts/wiki-graph-assist.py");
  if (!existsSync(wikiScript)) {
    return { found: false, sources: [], reused_knowledge: [] };
  }

  try {
    // P14：传 --wiki-dir（config wiki_dir / env 覆盖）与 --project-slug
    // （config archive.project_slug fallback basename），避免全库搜索且绕过
    // config wiki_dir 的问题。
    const wikiDir = await resolveWikiDir(cwd);
    const projectSlug = await resolveProjectSlug(cwd);
    const result = execPython(
      wikiScript,
      ["--compact", "--query", task, "--wiki-dir", wikiDir, "--project-slug", projectSlug],
      cwd,
      { timeout: 30000 },
    );
    const lines = result.stdout?.split("\n").filter(Boolean) || [];
    return {
      found: lines.length > 2,
      sources: lines.filter(l => l.startsWith("source:")).map(l => l.slice(7).trim()),
      reused_knowledge: lines.filter(l => !l.startsWith("source:") && !l.startsWith("[")),
    };
  } catch {
    return { found: false, sources: [], reused_knowledge: [] };
  }
}

// ── Brainstorm loading ──────────────────────────────────────────────────────

async function loadBrainstorm(cwd: string, brainstormId?: string): Promise<any> {
  try {
    const p = projectBrainstormPath(cwd);
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function archiveBrainstorm(cwd: string, brainstormId: string, threadId: string, ctx: ExtensionContext): Promise<void> {
  // Archive brainstorm to Goo-wiki
  ctx.ui.notify("正在归档 Brainstorm...", "info");
}

// ── Plan generation ─────────────────────────────────────────────────────────

async function generatePlan(
  cwd: string,
  task: string,
  wikiContext: WikiContext,
  brainstormGoals: Goal[],
  threadId: string,
  isNewThread: boolean,
  ctx: ExtensionContext,
): Promise<Plan | null> {
  const now = generateTimestamp();

  // Build goals
  const goals: Goal[] = brainstormGoals.length > 0 ? brainstormGoals : [
    {
      id: "g1",
      name: "主要目标",
      description: task,
      priority: 1,
      status: "pending",
      acceptance_criteria: ["任务完成"],
      outputs: [],
      depends_on: [],
    },
  ];

  // Build initial steps (LLM will refine these via tools)
  const steps: Step[] = [
    {
      id: 1,
      goal_ids: goals.map(g => g.id),
      tier: 1,
      name: "任务分析与方案设计",
      description: "分析任务需求，确定技术方案和实现路径",
      depends_on: [],
      type: "research",
      subagent: "researcher",
      task_agent: "document-analyst",
      available_skills: [],
      status: "pending",
      progress: 0,
      inputs: [],
      outputs: [],
      allowed_read_paths: ["."],
      allowed_write_paths: [".goo/"],
      validation: "输出方案文档或 design.md",
      risk_level: "low",
      requires_user_confirm: false,
      agent_id: null,
      heartbeat_at: null,
    },
    {
      id: 2,
      goal_ids: goals.map(g => g.id),
      tier: 2,
      name: "实现与开发",
      description: "根据方案设计进行编码实现",
      depends_on: [1],
      type: "exec",
      subagent: "implementer",
      task_agent: "feature-builder",
      available_skills: [],
      status: "pending",
      progress: 0,
      inputs: [],
      outputs: [],
      allowed_read_paths: ["."],
      allowed_write_paths: ["."],
      validation: "代码编写完成，能通过编译/语法检查",
      risk_level: "medium",
      requires_user_confirm: false,
      agent_id: null,
      heartbeat_at: null,
    },
    {
      id: 3,
      goal_ids: goals.map(g => g.id),
      tier: 3,
      name: "测试验证",
      description: "运行测试，验证功能正确性",
      depends_on: [2],
      type: "eval",
      subagent: "evaluator",
      task_agent: "test-runner",
      available_skills: [],
      status: "pending",
      progress: 0,
      inputs: [],
      outputs: [],
      allowed_read_paths: ["."],
      allowed_write_paths: [".goo/"],
      validation: "测试通过",
      risk_level: "medium",
      requires_user_confirm: false,
      agent_id: null,
      heartbeat_at: null,
    },
    {
      id: 4,
      goal_ids: goals.map(g => g.id),
      tier: 4,
      name: "归档到 Goo-wiki",
      description: "将任务目标、计划、关键证据、产物路径、验证结果和可复用经验归档到 Goo-wiki",
      depends_on: [3],
      type: "archive",
      subagent: "recorder",
      task_agent: "wiki-curator",
      available_skills: [],
      status: "pending",
      progress: 0,
      inputs: [],
      outputs: [],
      allowed_read_paths: [".goo/"],
      allowed_write_paths: [],
      validation: "归档页存在",
      risk_level: "low",
      requires_user_confirm: false,
      agent_id: null,
      heartbeat_at: null,
    },
  ];

  return {
    task,
    goals,
    status: "pending",
    created_at: now,
    steps,
    wiki_context: wikiContext,
    context_digest: {
      found: false,
      decisions: [],
      constraints: [],
      acceptance_criteria: [],
      open_questions: [],
    },
    review: { status: "pending_user_review" },
  };
}

// ── Remote resource check ───────────────────────────────────────────────────

async function checkRemoteResources(cwd: string, plan: Plan, ctx: ExtensionContext): Promise<void> {
  // Check if servers configured
  const configPath = join(cwd, ".goo/config.json");
  if (!existsSync(configPath)) return;

  try {
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as AutogooPluginConfig;
    const servers = getServers(config);
    if (!servers.length) return;

    // Probe remote resources
    const probeScript = join(REPO_ROOT, "skills/auto-goo/scripts/remote-resources.py");
    let probeResult = "";
    if (existsSync(probeScript)) {
      try {
        const result = execPython(probeScript, ["--probe"], cwd);
        probeResult = result.stdout || "";
      } catch {}
    }

    ctx.ui.notify(`检测到远程服务器: ${servers.map((s) => s.name).join(", ")}`, "info");
    if (probeResult) ctx.ui.notify(probeResult.slice(0, 300), "info");

    const choice = await uiSelect(ctx, TEMPLATE_REMOTE_RESOURCE_USAGE.header, TEMPLATE_REMOTE_RESOURCE_USAGE.options);
    if (choice === "remote") {
      // Mark steps that require heavy compute as remote
      for (const step of plan.steps) {
        if (step.type === "exec" || step.type === "optimize") {
          step.execution_target = "remote";
          step.remote_server = servers[0]?.name;
          step.remote_reason = "user confirmed remote execution";
          step.requires_user_confirm = true;
        }
      }
    }
  } catch {}
}

// ── Plan summary formatter ──────────────────────────────────────────────────

function formatPlanSummary(plan: Plan): string {
  const lines: string[] = [
    `## 📋 Plan 审阅 — ${plan.task.slice(0, 80)}`,
    ``,
    `### 🎯 目标`,
  ];

  for (const goal of plan.goals) {
    lines.push(`- **${goal.id}** ${goal.name}：${goal.description.slice(0, 100)}`);
    if (goal.acceptance_criteria.length > 0) {
      lines.push(`  - 验收：${goal.acceptance_criteria.join("；")}`);
    }
    if (goal.outputs.length > 0) {
      lines.push(`  - 产物：${goal.outputs.join("、")}`);
    }
  }

  // ── DAG 结构：并行组 ──
  const tiers = new Map<number, typeof plan.steps>();
  for (const step of plan.steps) {
    const t = step.tier || 1;
    if (!tiers.has(t)) tiers.set(t, []);
    tiers.get(t)!.push(step);
  }
  const sortedTiers = [...tiers.entries()].sort((a, b) => a[0] - b[0]);

  lines.push(``, `### 📊 DAG 结构`);
  lines.push(``, `**并行组（可同时执行）：**`);
  lines.push(`| Tier | 步骤 | 说明 |`);
  lines.push(`|------|------|------|`);
  for (const [tier, steps] of sortedTiers) {
    const names = steps.map(s => `${s.id}.${s.name}`).join("、");
    const note = steps.every(s => (s.depends_on?.length ?? 0) === 0)
      ? "无依赖，可并行"
      : `依赖 Tier < ${tier}`;
    lines.push(`| ${tier} | ${names} | ${note} |`);
  }

  // ── 必要串行链 ──
  const serialChains: string[] = [];
  for (const step of plan.steps) {
    if (step.depends_on && step.depends_on.length > 0) {
      for (const depId of step.depends_on) {
        const depStep = plan.steps.find(s => s.id === depId);
        const depName = depStep ? depStep.name : `#${depId}`;
        serialChains.push(`| ${depId} ${depName} → ${step.id} ${step.name} | ${depStep ? "上游产物作为输入" : ""}`);
      }
    }
  }
  if (serialChains.length > 0) {
    lines.push(``, `**必要串行链（不能并行的依赖）：**`);
    lines.push(`| 依赖 | 原因 |`);
    lines.push(`|------|------|`);
    for (const chain of serialChains) {
      lines.push(chain);
    }
  }

  // ── 归档链 ──
  const archiveSteps = plan.steps.filter(s => s.type === "archive");
  if (archiveSteps.length > 0) {
    lines.push(``, `**归档链：** 最后一步 \`${archiveSteps.map(s => s.name).join("、")}\` 依赖所有非归档叶子步骤。`);
  }

  // ── 步骤详情 ──
  lines.push(``, `### 📝 步骤详情`);
  if (plan.steps.length <= 6) {
    // 完整表格
    lines.push(`| # | 名称 | 类型 | 角色 | 风险 | 需确认 | 输入 | 输出 | 验收方式 |`);
    lines.push(`|---|------|------|------|------|--------|------|------|----------|`);
    for (const step of plan.steps) {
      const confirmIcon = step.requires_user_confirm ? "是⚠️" : "否";
      const riskIcon = step.risk_level === "high" ? "🔴高危" : step.risk_level === "medium" ? "🟡中" : "🟢低";
      const ins = (step.inputs?.length ?? 0) > 0 ? step.inputs!.slice(0, 2).join(", ") : "—";
      const outs = (step.outputs?.length ?? 0) > 0 ? step.outputs!.slice(0, 2).join(", ") : "—";
      lines.push(`| ${step.id} | ${step.name} | ${step.type} | ${step.subagent} | ${riskIcon} | ${confirmIcon} | ${ins} | ${outs} | ${step.validation.slice(0, 40)} |`);
    }
  } else {
    // 折叠模式：步骤 > 6
    lines.push(`| # | 名称 | 类型 | 角色 | 说明 |`);
    lines.push(`|---|------|------|------|------|`);
    for (const step of plan.steps) {
      const descParts = [];
      if (step.inputs?.length) descParts.push(`输:${step.inputs.slice(0, 2).join(",")}`);
      if (step.outputs?.length) descParts.push(`出:${step.outputs.slice(0, 2).join(",")}`);
      if (step.risk_level && step.risk_level !== "low") descParts.push(`⚠${step.risk_level}`);
      const desc = descParts.length > 0 ? `【${descParts.join(" ")}】` : "";
      lines.push(`| ${step.id} | ${step.name} | ${step.type} | ${step.subagent} | ${desc} |`);
    }
    lines.push(``, `> 详细输入/输出/验收方式见 .goo/plan.json 中对应步骤字段`);
  }

  // ── 关键风险 & 需要用户判断的点 ──
  const risks: string[] = [];
  for (const step of plan.steps) {
    if (step.risk_level === "high") {
      risks.push(`1. **${step.name}（步骤 #${step.id}）风险等级高**：${step.validation} — 建议提前确认`);
    }
    if (step.requires_user_confirm) {
      risks.push(`2. **${step.name}（步骤 #${step.id}）需要用户确认**：${step.validation}`);
    }
    if (step.execution_target === "remote") {
      risks.push(`3. **${step.name}（步骤 #${step.id}）远程执行**：服务器 ${step.remote_server}，${step.remote_reason}`);
    }
  }
  if (risks.length > 0) {
    lines.push(``, `### ⚠️ 关键风险 & 需要用户判断的点`);
    for (const r of risks) lines.push(r);
  } else {
    lines.push(``, `### ⚠️ 关键风险`);
    lines.push(`当前计划无高风险步骤或需要用户确认的点。`);
  }

  // ── Wiki 上下文 ──
  if (plan.wiki_context) {
    lines.push(``, `### 🔍 Wiki 上下文`);
    if (plan.wiki_context.found && plan.wiki_context.reused_knowledge.length > 0) {
      lines.push(`来源：${plan.wiki_context.sources.join(", ")}`);
      lines.push(`可复用经验：`);
      for (const k of plan.wiki_context.reused_knowledge.slice(0, 5)) {
        lines.push(`- ${k.slice(0, 100)}`);
      }
    } else {
      lines.push(`未找到相关知识`);
    }
  }

  // ── 上下文决策摘要 ──
  if (plan.context_digest) {
    lines.push(``, `### 💡 上下文决策摘要`);
    const d = plan.context_digest;
    if (d.decisions.length > 0) lines.push(`- 已确认方案：${d.decisions.join("；")}`);
    if (d.constraints.length > 0) lines.push(`- 用户约束：${d.constraints.join("；")}`);
    if (d.acceptance_criteria.length > 0) lines.push(`- 验收标准：${d.acceptance_criteria.join("；")}`);
    if (d.open_questions.length > 0) lines.push(`- 未决问题：${d.open_questions.join("；")}`);
    if (d.decisions.length === 0 && d.constraints.length === 0) {
      lines.push(`暂无额外上下文信息`);
    }
  }

  return lines.join("\n");
}



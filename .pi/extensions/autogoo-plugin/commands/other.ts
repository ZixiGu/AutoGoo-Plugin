/**
 * AutoGoo-Plugin — 目录观察、发布、研究、用法统计等命令
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Global pi reference ─────────────────────────────────────────────────────
let _pi: ExtensionAPI | null = null;

export function setPi(pi: ExtensionAPI): void {
  _pi = pi;
}
import { REPO_ROOT, GOO_STATUS_PY, GOO_PUBLISH_PY, projectPlanPath, scriptsDir } from "../utils/paths.js";
import { execPython, execShell } from "../utils/exec.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── goo-observe ─────────────────────────────────────────────────────────────

export async function handleGooObserve(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  const planPath = projectPlanPath(cwd);

  if (!existsSync(planPath)) {
    ctx.ui.notify("当前项目没有活动的 plan。", "warning");
    return;
  }

  try {
    // Show running steps with heartbeat info
    const result = execPython(
      GOO_STATUS_PY,
      ["--plan", planPath],
      cwd,
    );
    ctx.ui.notify((result.stdout || "无运行中的步骤").slice(0, 500), "info");
  } catch (err: any) {
    ctx.ui.notify(`观察失败: ${err.message}`, "error");
  }
}

// ── goo-publish ─────────────────────────────────────────────────────────────

export async function handleGooPublish(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  const hasServe = args.includes("--serve");
  const hasLive = args.includes("--live");

  const scriptPath = GOO_PUBLISH_PY;
  if (!existsSync(scriptPath)) {
    ctx.ui.notify("goo-publish.py 未找到", "error");
    return;
  }

  ctx.ui.notify("正在生成 HTML 站点...", "info");

  try {
    const scriptArgs = [`"${scriptPath}"`];
    if (hasServe) scriptArgs.push("--serve");
    if (hasLive) scriptArgs.push("--live");

    const result = execShell(`python3 ${scriptArgs.join(" ")}`, cwd);
    ctx.ui.notify((result.stdout || "发布完成").slice(0, 500), "success");
    if (result.stderr) ctx.ui.notify(result.stderr, "warning");
  } catch (err: any) {
    ctx.ui.notify(`发布失败: ${err.message}`, "error");
  }
}

// ── goo-research ────────────────────────────────────────────────────────────

export async function handleGooResearch(args: string, ctx: ExtensionContext): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.ui.notify("请输入研究主题。例如：/auto-goo:goo-research paper arXiv:2401.12345", "warning");
    return;
  }

  ctx.ui.notify(`研究主题: ${trimmed}`, "info");

  // Guide the LLM to do the research using its own capabilities
  ctx.ui.setEditorText(
    `请调研以下主题，输出结构化研究报告（包含背景、方法、关键发现、代码/数据可用性、结论）：\n\n${trimmed}\n\n` +
    `调研完成后，将结果归档到 Goo-wiki。`
  );
}

// ── goo-usage ───────────────────────────────────────────────────────────────

export async function handleGooUsage(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  const scriptPath = join(REPO_ROOT, "skills/auto-goo/scripts/goo-usage.py");
  
  if (!existsSync(scriptPath)) {
    ctx.ui.notify("goo-usage.py 未找到", "warning");
    return;
  }

  // Quick one-shot summary (default: all sources — claude + codex + pi)
  // Pass --pi / --codex / --claude in args to filter by source.
  const scriptArgs = ["--once"];
  if (args.trim()) {
    const parsed: string[] = [];
    let current = "";
    let inQuote: string | null = null;
    for (const ch of args.trim()) {
      if (inQuote) {
        if (ch === inQuote) { inQuote = null; continue; }
        current += ch;
      } else if (ch === "'" || ch === '"') {
        inQuote = ch;
      } else if (ch === " ") {
        if (current) { parsed.push(current); current = ""; }
      } else {
        current += ch;
      }
    }
    if (current) parsed.push(current);
    scriptArgs.push(...parsed.filter(a => a !== "--once"));
  }

  const result = execPython(scriptPath, scriptArgs, cwd, { timeout: 30000 });
  if (result.exitCode !== 0) {
    ctx.ui.notify("usage 统计失败", "error");
    return;
  }

  // Strip ANSI codes and send full output to conversation
  const raw = result.stdout || "";
  const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][0-9;]*[a-zA-Z]/g, "");

  if (_pi) {
    _pi.sendUserMessage(
      `📊 **Pi Usage 统计**\n\n\`\`\`\n${clean.slice(0, 4000)}\n\`\`\``,
      { deliverAs: "followUp" }
    );
  }
}

// ── goo-usage-analyse ───────────────────────────────────────────────────────

export async function handleGooUsageAnalyse(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  const scriptPath = join(REPO_ROOT, "skills/auto-goo/scripts/goo-usage.py");
  const analyseScript = join(REPO_ROOT, "skills/auto-goo/scripts/change-requests.py");

  ctx.ui.notify("正在分析 token 使用情况...", "info");

  try {
    const usage = execPython(scriptPath, ["--json", ...(args ? args.split(" ") : [])], cwd);
    ctx.ui.notify((usage.stdout || "分析完成").slice(0, 300), "info");
    ctx.ui.setEditorText(
      `基于以下 usage 数据和 Goo-wiki 知识，请生成 token 降本分析报告：\n\n` +
      `${usage.stdout?.slice(0, 2000) || "无数据"}\n\n` +
      `要求：归因 token 开销热点，给出可落地的节省方案。`
    );
  } catch (err: any) {
    ctx.ui.notify(`分析失败: ${err.message}`, "error");
  }
}

// ── goo-daily-report ────────────────────────────────────────────────────────

export async function handleGooDailyReport(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  const scriptPath = join(REPO_ROOT, "skills/auto-goo/scripts/daily-report-sessions.py");

  if (!existsSync(scriptPath)) {
    ctx.ui.notify("daily-report-sessions.py 未找到", "warning");
    return;
  }

  try {
    const result = execPython(scriptPath, args ? args.split(" ") : [], cwd);
    ctx.ui.notify((result.stdout || "日报生成完成").slice(0, 500), "info");
  } catch (err: any) {
    ctx.ui.notify(`日报生成失败: ${err.message}`, "error");
  }
}

// ── goo-improve ─────────────────────────────────────────────────────────────

export async function handleGooImprove(args: string, ctx: ExtensionContext): Promise<void> {
  ctx.ui.notify("AutoGoo-Plugin 自改进功能", "info");
  ctx.ui.setEditorText(
    `请审查 AutoGoo-Plugin 框架（位于 ${REPO_ROOT}）的执行表现，识别以下方面的问题和改进机会：\n\n` +
    `1. 工作流效率 — DAG 调度、心跳、并发执行\n` +
    `2. 可靠性 — session 恢复、失败处理、日志完整性\n` +
    `3. 用户体验 — 交互流程、提示清晰度、归档质量\n` +
    `4. 文档完整性 — SKILL.md、references、交互模板\n\n` +
    `基于分析结果，给出具体改进建议。`
  );
}

// ── goo-benchmark ───────────────────────────────────────────────────────────

export async function handleGooBenchmark(args: string, ctx: ExtensionContext): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.ui.notify("请输入 benchmark 目标。例如：/auto-goo:goo-benchmark 模型推理速度", "warning");
    return;
  }

  ctx.ui.setEditorText(
    `请对以下目标执行性能评测：\n\n${trimmed}\n\n` +
    `要求：\n` +
    `1. 定义评测指标和基线\n` +
    `2. 运行评测并记录结果\n` +
    `3. 生成评测报告\n` +
    `4. 分析瓶颈和改进方向\n` +
    `5. 结果归档到 Goo-wiki`
  );
}

// ── goo-continue ────────────────────────────────────────────────────────────

export async function handleGooContinue(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;

  // Check for existing plan
  const { loadPlan } = await import("../utils/plan.js");
  const plan = await loadPlan(cwd);
  if (!plan) {
    ctx.ui.notify("没有找到可恢复的计划。请先使用 goo-plan 生成计划。", "warning");
    return;
  }

  const runningSteps = plan.steps.filter(s => s.status === "running");
  const pendingSteps = plan.steps.filter(s => s.status === "pending");
  const blockedSteps = plan.steps.filter(s => s.status === "blocked");

  if (runningSteps.length === 0 && pendingSteps.length === 0) {
    ctx.ui.notify("所有步骤已完成或失败。无需恢复。", "info");
    return;
  }

  const resumeMsg = `恢复执行: ${runningSteps.length} 运行中, ${pendingSteps.length} 待执行, ${blockedSteps.length} 阻塞`;
  ctx.ui.notify(resumeMsg, "info");

  // 立即刷新状态栏并启动周期自动刷新（有活动步骤时）
  try {
    const { updateStatusBar } = await import("../utils/status.js");
    await updateStatusBar(ctx);
  } catch (e: any) {
    console.warn("[AutoGoo-Plugin] goo-continue updateStatusBar error:", e?.message ?? String(e));
  }

  if (_pi) {
    _pi.sendUserMessage(
      `## AutoGoo-Plugin 恢复执行\n\n` +
      `检测到未完成的 DAG 计划：\n` +
      `- 运行中: ${runningSteps.length} 个（需检查心跳和产物状态）\n` +
      `- 待执行: ${pendingSteps.length} 个（按依赖顺序派发）\n` +
      `- 阻塞: ${blockedSteps.length} 个（需确认后继续）\n\n` +
      `### 执行方式\n` +
      `1. 首先使用 auto_goo_dag_status 查看当前完整状态\n` +
      `2. 检查运行中步骤的心跳：使用 auto_goo_execute action=heartbeat_check\n` +
      `3. 僵尸步骤标记失败，就绪步骤使用 auto_goo_dispatch 派发\n` +
      `4. 阻塞步骤需要向用户确认后再继续\n\n` +
      `请开始执行！`,
      { deliverAs: "followUp" }
    );
  }
}



/**
 * AutoGoo-Plugin DAG Execution Engine — 自动调度执行工具
 *
 * 实现 6 槽位调度模型：
 * 1. 扫描就绪步骤（dependencies 全部 completed）
 * 2. 填充空槽位（最多 6 并发）
 * 3. 派发 Subagent + 写首个 heartbeat
 * 4. 监控心跳（30s 巡检）
 * 5. 处理完成/失败/阻塞
 * 6. 连续调度直到所有步骤完成
 *
 * 注册为 auto_goo_execute 工具供 LLM 调用。
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execPython, execShell } from "../utils/exec.js";
import { runSubagent, resolveSubagentModel, resolveOrPromptSubagentModel } from "../utils/subagent.js";
import { getRolePrompt, getTaskAgentPrompt } from "../utils/prompts.js";
import { updateStatusBar, formatStatusLine, snapshotPlan } from "../utils/status.js";
import {
  loadPlan,
  savePlan,
  getCurrentThreadId,
  validatePlan,
  findCycleNodes,
  type Plan,
  type Step,
} from "../utils/plan.js";
import {
  generateWikiPacket,
  buildSubagentTaskPrompt,
  heartbeatTick,
  type WikiPacketResult,
} from "../utils/dispatch.js";
import {
  UPDATE_STEP_PY,
  GOO_STATUS_PY,
  projectPlanPath,
  loadProjectConfig,
  writeExecutionModelConfig,
} from "../utils/paths.js";
import { existsSync } from "node:fs";

export function registerExecuteTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "auto_goo_execute",
    label: "Execute DAG",
    description: `自动执行 DAG 调度循环。扫描 plan 中的就绪步骤，按 6 槽位模型并发派发 Subagent。自动管理心跳检查、完成处理和失败重试。每次调用执行一轮调度。`,
    promptSnippet: "自动执行 DAG 调度循环：检查就绪步骤 → 派发 → 监控 → 完成",
    promptGuidelines: [
      "使用 auto_goo_execute 自动调度 DAG。第一次调用会执行一轮调度，应持续调用直到所有步骤完成。",
      "在调度循环中，使用 auto_goo_dag_status 查看进度，auto_goo_pending_steps 查看就绪步骤。",
      "requires_user_confirm=true 的就绪步骤由调度器直接弹确认框询问用户；确认后自动派发，拒绝则 blocked。",
      "已 blocked（用户拒绝或需确认）的步骤，确认后可调用 auto_goo_update_step --confirm / --pending 解除并继续调度。",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "调度操作",
        enum: ["schedule", "heartbeat_check", "full_cycle"],
      }),
      planPath: Type.Optional(Type.String({ description: "plan.json 路径（默认 .goo/plan.json）" })),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      signal: any,
      onUpdate: any, // pi 流式观察：Subagent 执行过程转发到 TUI
      ctx: any,
    ) {
      const cwd = ctx.cwd;
      const planPath = params.planPath ?? projectPlanPath(cwd);

      if (!existsSync(planPath)) {
        return {
          content: [{ type: "text", text: `plan 文件未找到: ${planPath}` }],
          details: { error: "plan_not_found" },
        };
      }

      const plan = await loadPlan(cwd, planPath);
      if (!plan) {
        return {
          content: [{ type: "text", text: `无法加载 plan: ${planPath}` }],
          details: { error: "plan_load_failed" },
        };
      }

      switch (params.action) {
        case "schedule":
          return await runSchedule(pi, cwd, plan, planPath, ctx, signal, onUpdate);
        case "heartbeat_check":
          return await runHeartbeatCheck(cwd, plan, planPath, ctx);
        case "full_cycle":
          return await runFullCycle(pi, cwd, plan, planPath, ctx, signal, onUpdate);
        default:
          return {
            content: [{ type: "text", text: `未知操作: ${params.action}` }],
            details: {},
          };
      }
    },
  });
}

// ── Scheduling constants ────────────────────────────────────────────────────

const MAX_CONCURRENT_DEFAULT = 6;
// 运行中超时默认 15 分钟（与 execution-engine.md 规范一致；plan.json
// execution.stale_after_seconds 可覆盖）。120s 只用于跨会话恢复（goo-continue）
// 的僵尸判断，不得用作运行中失败阈值。
const STALE_SECONDS_DEFAULT = 900;
const MAX_RETRIES = 1;

// ── Core scheduling logic ───────────────────────────────────────────────────

async function runSchedule(
  pi: ExtensionAPI,
  cwd: string,
  plan: Plan,
  planPath: string,
  ctx?: any,
  signal?: AbortSignal, // P12：透传用户中断信号，防止子进程成孤儿
  onUpdate?: any, // pi 流式观察：Subagent 执行过程转发到 TUI
): Promise<{ content: any[]; details: any }> {
  const lines: string[] = [];

  // C2 修复：调度前先校验 plan 结构与依赖（坏依赖/重复 id/环），
  // 否则死锁会静默等待而不是明确报错。
  const validation = validatePlan(plan);
  if (!validation.valid) {
    const cycleNodes = findCycleNodes(plan);
    const cycleMsg = cycleNodes.length > 0
      ? `\n循环依赖: #${cycleNodes.join(", #")}（请检查 depends_on 是否存在环）`
      : "";
    return {
      content: [{ type: "text", text: `❌ plan 校验失败:\n${validation.issues.join("\n")}${cycleMsg}\n\n请先修复 plan 再继续调度。` }],
      details: { error: "plan_invalid", issues: validation.issues, cycleNodes },
    };
  }

  // P8: failed 步骤自动重试（retry_count < MAX_RETRIES → 转回 pending，下轮可重新派发；
  //     超过则保持 failed 并提示人工处理）。
  let autoRetried = 0;
  for (const step of plan.steps) {
    if (step.status !== "failed") continue;
    const retryCount = ((step as any).retry_count ?? 0) as number;
    if (retryCount < MAX_RETRIES) {
      (step as any).retry_count = retryCount + 1;
      step.status = "pending";
      step.progress = 0;
      step.agent_id = null;
      step.error = undefined;
      autoRetried++;
      execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--status", "pending", "--note", `Auto-retry #${retryCount + 1}`], cwd, { timeout: 10000 });
    }
  }

  // C1 修复：检测“依赖失败步骤但自身仍 pending”的死锁步骤，显式提示。
  // 修复 2026-08-14：必须放在 P8 自动重试循环**之后**计算——否则会把
  // retry_count < MAX_RETRIES、即将自动重试的 failed 依赖步骤误报为
  // “死锁需人工处理”（实际会自动解锁）。先重试，再基于更新后的 failed 集合计算。
  const failedIds = new Set(plan.steps.filter((s) => s.status === "failed").map((s) => String(s.id)));
  const depOnFailed = plan.steps.filter(
    (s) => s.status === "pending" && (s.depends_on ?? []).some((d) => failedIds.has(String(d))),
  );
  if (depOnFailed.length > 0) {
    lines.push(`💀 ${depOnFailed.length} 步因依赖失败而无法执行: #${depOnFailed.map((s) => s.id).join(", #")}（需人工处理：修复依赖步骤或调整 depends_on）`);
  }

  let completedIds = new Set(
    plan.steps.filter((s) => s.status === "completed").map((s) => String(s.id)),
  );
  let running = plan.steps.filter((s) => s.status === "running");
  let failed = plan.steps.filter((s) => s.status === "failed");

  if (autoRetried > 0) {
    lines.push(`🔄 自动重试 ${autoRetried} 个 failed 步骤（转回 pending，下轮重新派发）`);
  }
  if (failed.length > 0) {
    lines.push(`💀 ${failed.length} 步失败(超过最大重试 ${MAX_RETRIES}): #${failed.map((s) => s.id).join(", #")}，请人工处理`);
  }

  // Find ready steps: pending with all dependencies completed
  let ready = plan.steps.filter((s) => {
    if (s.status !== "pending") return false;
    return s.depends_on.every((d) => completedIds.has(String(d)));
  });

  // P4: requires_user_confirm=true 且尚未确认的步骤 — 前台询问用户（真正弹确认框，
  //     而不是只打一行文本等主 Agent 猜）。确认 → 记录 confirmed 并解锁/继续派发；
  //     拒绝 → 保持 blocked（后续不再自动重复询问）。
  //     额外纳入“旧版本只标记 blocked、从未真正询问过”的步骤（error 带
  //     requires user confirm / no interactive ui），让历史遗留阻塞也能本轮解锁。
  const legacyAwaitingConfirm = plan.steps.filter(
    (s) =>
      s.status === "blocked" &&
      s.requires_user_confirm === true &&
      s.confirmed !== true &&
      (s.error === "requires user confirm" || (s.error || "").includes("no interactive ui")),
  );
  const needsConfirm = [
    ...ready.filter((s) => s.requires_user_confirm === true && s.confirmed !== true),
    ...legacyAwaitingConfirm.filter((b) => !ready.some((r) => String(r.id) === String(b.id))),
  ];
  const declinedIds = new Set<string>();
  for (const step of needsConfirm) {
    // 非交互上下文（无 ctx.ui）：不能弹框，安全默认标记 blocked 等人工处理
    if (!ctx?.ui?.confirm) {
      declinedIds.add(String(step.id));
      step.status = "blocked";
      step.error = "requires user confirm (no interactive ui)";
      execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--block", "--error", "requires user confirm (no interactive ui)"], cwd, { timeout: 10000 });
      lines.push(`🚧 #${step.id} 需用户确认，但当前无可交互 UI，已标记 blocked`);
      continue;
    }
    let answer = false;
    try {
      answer = await ctx.ui.confirm(
        `确认执行步骤 #${step.id}？`,
        `步骤: ${step.name}\n\n${step.description || ""}\n\n` +
          `此步骤在规划时标记为需用户确认（requires_user_confirm，高风险/远程/成本类操作）。\n` +
          `确认后继续派发执行；拒绝则保持 blocked。`,
      );
    } catch (e: any) {
      console.warn(`[AutoGoo-Plugin] confirm #${step.id} 失败，默认拒绝:`, e?.message ?? String(e));
      answer = false;
    }
    if (answer) {
      execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--confirmed", "--note", "user confirmed via scheduler"], cwd, { timeout: 10000 });
      step.confirmed = true;
      step.confirmed_at = new Date().toISOString();
      if (step.status === "blocked") {
        step.status = "pending";
        step.progress = 0;
      }
      lines.push(`✅ #${step.id} 用户已确认，继续派发`);
    } else {
      declinedIds.add(String(step.id));
      step.status = "blocked";
      step.error = "user declined confirmation";
      execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--block", "--error", "user declined confirmation"], cwd, { timeout: 10000 });
      lines.push(`🚧 #${step.id} 用户拒绝确认，已标记 blocked（后续不再自动询问）`);
    }
  }

  // 确认询问可能改变状态（blocked→pending）：重新加载 plan 并重算 ready，
  // 让新解锁的步骤本轮即可进入派发队列。
  const freshPlan = await loadPlan(cwd, planPath);
  if (freshPlan) {
    plan = freshPlan;
    // C6 修复：freshPlan 重载后 completedIds 也必须刷新（旧快照可能含被改动的步骤），
    // 否则 ready 判定用过期依赖状态。
    completedIds = new Set(
      plan.steps.filter((s) => s.status === "completed").map((s) => String(s.id)),
    );
    running = plan.steps.filter((s) => s.status === "running");
    failed = plan.steps.filter((s) => s.status === "failed");
  }
  ready = plan.steps.filter((s) => {
    if (s.status !== "pending") return false;
    return s.depends_on.every((d) => completedIds.has(String(d)));
  });
  const blockedAfterConfirm = plan.steps.filter((s) => s.status === "blocked");

  // P4: execution_target==='remote' — 跳过本地派发，提示用 auto_goo_ssh_exec 远程执行
  const remoteSteps = ready.filter((s) => s.execution_target === "remote" && !declinedIds.has(String(s.id)));
  for (const step of remoteSteps) {
    lines.push(`🖥️ #${step.id} 远程执行(server=${step.remote_server || "?"}): 请用 auto_goo_ssh_exec 在远程执行`);
  }

  const maxConcurrent = plan.execution?.max_concurrent ?? MAX_CONCURRENT_DEFAULT;
  const availableSlots = Math.max(0, maxConcurrent - running.length);

  const toDispatch = ready
    .filter((s) => !declinedIds.has(String(s.id)))
    .filter((s) => s.execution_target !== "remote")
    .slice(0, availableSlots);
  const dispatched: number[] = [];

  if (toDispatch.length === 0) {
    if (completedIds.size === plan.steps.length) {
      plan.status = "completed";
      plan.completed_at = new Date().toISOString();
      await savePlan(cwd, plan, planPath);
      lines.push(`✅ DAG 全部完成！${completedIds.size}/${plan.steps.length} 步`);
    } else if (blockedAfterConfirm.length > 0) {
      lines.push(`🚧 ${blockedAfterConfirm.length} 步阻塞: #${blockedAfterConfirm.map((s) => s.id).join(", #")}`);
    } else if (failed.length > 0) {
      lines.push(`💀 ${failed.length} 步失败: #${failed.map((s) => s.id).join(", #")}`);
    } else if (ready.length > 0) {
      // 区分“无空槽”与“就绪但被排除本地派发”（远程执行 / 需用户确认 / 用户拒绝），
      // 避免把 remote/confirm 步骤误报成“槽位已满”。
      const remoteReady = ready.filter((s) => s.execution_target === "remote" && s.status === "pending");
      const confirmReady = ready.filter((s) => s.requires_user_confirm === true && s.status === "pending" && s.confirmed !== true);
      const declinedReady = ready.filter((s) => declinedIds.has(String(s.id)));
      const reasons: string[] = [];
      if (running.length >= maxConcurrent) {
        reasons.push(`并发槽位已满 (${running.length}/${maxConcurrent})`);
      }
      if (remoteReady.length > 0) {
        reasons.push(`#${remoteReady.map((s) => s.id).join(", #")} 为远程执行(execution_target=remote)，请用 auto_goo_ssh_exec 执行`);
      }
      if (confirmReady.length > 0) {
        reasons.push(`#${confirmReady.map((s) => s.id).join(", #")} 需用户确认(requires_user_confirm)`);
      }
      if (declinedReady.length > 0) {
        reasons.push(`#${declinedReady.map((s) => s.id).join(", #")} 用户已拒绝，保持 blocked`);
      }
      if (reasons.length === 0) {
        reasons.push(`等待派发 (空槽 ${maxConcurrent - running.length}/${maxConcurrent})`);
      }
      lines.push(`ℹ️ ${ready.length} 步就绪但未本地派发 (空槽 ${maxConcurrent - running.length}/${maxConcurrent}): ${reasons.join("；")}`);
    } else {
      lines.push(`⏳ 等待运行中步骤完成 (${running.length} 运行中)`);
    }
  }

  // P6: 为每个 step 只生成一次 agentId（start 与 heartbeat 复用同一值）
  // C4：Map key 用 String(step.id) 统一（支持数字/字符串 id）
  const agentIds = new Map<string, string>();
  for (const step of toDispatch) {
    const agentId = `agent-${step.id}-${Date.now()}`;
    agentIds.set(String(step.id), agentId);
    dispatched.push(step.id);
    execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--start", "--progress", "5", "--agent-id", agentId], cwd, { timeout: 15000 });
    execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--precreate-log", "--note", `Dispatched to ${step.subagent} (${agentId})`], cwd, { timeout: 15000 });
  }

  // P5: 为每个待派发 step 生成 wiki graph packet（与 auto_goo_dispatch 一致，
  //     失败 fallback 不阻塞）。
  const threadId = (await getCurrentThreadId(cwd)) ?? "current";
  const packets = new Map<string, WikiPacketResult>();
  await Promise.all(
    toDispatch.map(async (step: any) => {
      const res = await generateWikiPacket(
        cwd,
        { id: step.id, type: step.type, wiki_paths: step.wiki_paths, memory_layer: step.memory_layer },
        step.description || `step ${step.id} dispatch`,
        threadId,
      );
      packets.set(String(step.id), res);
    }),
  );

  // ★ 并发子进程派发（pi 子进程模式，2026-08-10 迁移；替代 sendUserMessage + terminate）：
  //   隔离上下文 / 可靠投递 / 并行 / usage 统计。阻塞直到本批全部完成，
  //   期间 onTick 每 ~20s 保活心跳防止 STALE 误杀。
  // config.execution.subagent_model / subagent_provider：显式指定 Subagent 模型；
  // 未设置时用结构化 UI 询问用户是否配置（resolveOrPromptSubagentModel），
  // 配置写入 .goo/config.json；用户取消或仍解析不到则 blocked，绝不静默用 pi 全局默认。
  const execCfg = (await loadProjectConfig(cwd).catch(() => null))?.execution || {};
  const subModel = await resolveOrPromptSubagentModel(
    { provider: execCfg.subagent_provider, model: execCfg.subagent_model },
    ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
    ctx ?? null,
    (provider, model) => writeExecutionModelConfig(cwd, provider, model),
  );
  if (!subModel.provider || !subModel.model) {
    return {
      content: [{ type: "text", text: `blocked: Subagent 模型未配置或用户取消（config.execution.subagent_* 未设置），拒绝静默回退 pi 全局默认；请配置 execution.subagent_provider+subagent_model 后重试` }],
      details: { blocked: true, reason: "Subagent 模型未配置", pendingSteps: [] as string[] },
    };
  }
  const subagentResults = await Promise.all(
    toDispatch.map(async (step: any) => {
      const agentId = agentIds.get(String(step.id)) ?? `agent-${step.id}-${Date.now()}`;
      const { packet, packetGenerated } = packets.get(String(step.id)) ?? {
        packet: { wiki_paths: [] as string[], wiki_graph_packet_path: "", memory_layer: "L2" },
        packetGenerated: false,
      };
      const stepContract = [
        `- step_id: ${step.id}`,
        `- name: ${step.name}`,
        `- type: ${step.type || "exec"}`,
        `- task_agent: ${step.task_agent || "document-analyst"}`,
        `- 输入产物: ${(step.inputs || []).join(", ") || "无"}`,
        `- 必须产出: ${(step.outputs || []).join(", ") || "声明产物"}`,
        `- 读取边界: ${(step.allowed_read_paths || []).join(", ") || "项目根"}`,
        `- 写入边界: ${(step.allowed_write_paths || []).join(", ") || "无"}`,
        `- 验收标准: ${step.validation || "报告结构化结果"}`,
      ];
      const result = await runSubagent({
        systemPrompt: [getRolePrompt(step.subagent || "researcher"), getTaskAgentPrompt(step.task_agent || "")].filter(Boolean).join("\n"),
        task: buildSubagentTaskPrompt({
          role: step.subagent || "researcher",
          task: step.description || `执行 step #${step.id}: ${step.name}`,
          wiki_paths: packet.wiki_paths,
          wiki_graph_packet_path: packet.wiki_graph_packet_path,
          packetGenerated,
          memory_layer: packet.memory_layer,
          stepContract,
        }),
        cwd,
        signal, // P12：透传用户中断信号，防止子进程成孤儿
        provider: subModel.provider,
        model: subModel.model,
        onTick: () => void heartbeatTick(cwd, planPath, step.id, agentId),
        // pi 流式观察（2026-08-14）：把 Subagent 子进程的 JSON 流消息
        // （assistant 文本 / tool call / tool result）桥接到工具 onUpdate，
        // TUI 实时显示执行过程。之前未接线 → pi 版看不到 Subagent 内部。
        onMessage: (message: any) => {
          if (!onUpdate) return;
          try {
            const role = message?.role;
            let text = "";
            if (role === "assistant" && Array.isArray(message.content)) {
              text = message.content
                .map((p: any) => (p?.type === "text" ? p.text : p?.type === "toolCall" ? `⟦${p.name}(...⟧` : ""))
                .filter(Boolean)
                .join("\n");
            } else if (message?.type === "tool_result_end" || message?.role === "tool") {
              const c = message.content?.[0]?.text || "";
              text = `⟦tool result⟧ ${String(c).slice(0, 200)}`;
            }
            if (text) {
              onUpdate({ content: [{ type: "text", text: `  #${step.id} ▶ ${text.slice(0, 300)}` }] });
            }
          } catch {
            /* 流式转发失败不阻塞 */
          }
        },
        timeoutMs: 30 * 60 * 1000,
      });
      // 兕底：子进程退出后 step 若仍 running，按退出码标记
      const planNow = await loadPlan(cwd, planPath);
      const stepNow = planNow?.steps.find((s: any) => String(s.id) === String(step.id));
      if (stepNow?.status === "running") {
        const ok = result.exitCode === 0 && !result.errorMessage && !result.timedOut;
        if (ok) {
          execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--complete", "--note", `Subagent exit 0（兕底标记完成）`], cwd, { timeout: 10000 });
        } else {
          // 信号杀（143=SIGTERM / 137=SIGKILL）或超时：wrapper 中断 ≠ 任务失败。
          // 远程管线（execution_target=remote）或本地任务本体可能仍在运行，
          // 标 interrupted 让主 Agent 检查后 resume / 重启 / 确认失败，而不是直接 failed。
          const killedBySignal = result.exitCode === 143 || result.exitCode === 137 || result.signal === "SIGTERM" || result.signal === "SIGKILL";
          if (result.timedOut || killedBySignal) {
            execPython(
              UPDATE_STEP_PY,
              [
                "--plan", planPath,
                "--step-id", String(step.id),
                "--interrupt",
                "--error",
                result.errorMessage ||
                  `subagent wrapper 中断（exit ${result.exitCode}${result.timedOut ? "，超时" : "，被信号杀"}），任务本体可能继续运行，需检查后恢复`,
              ],
              cwd,
              { timeout: 10000 },
            );
          } else {
            execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--fail", "--error", result.errorMessage || `subagent exit ${result.exitCode}`], cwd, { timeout: 10000 });
          }
        }
      }
      return { stepId: step.id, status: stepNow?.status, result };
    }),
  );

  for (const { stepId, status, result } of subagentResults) {
    const usage = result.usage;
    const usageStr = usage.turns > 0 ? ` · ${usage.turns}t ↑${usage.input} ↓${usage.output} $${usage.cost.toFixed(4)}` : "";
    lines.push(`  #${stepId}: exit=${result.exitCode}${result.timedOut ? " ⏱超时" : ""}${result.errorMessage ? ` ❌${result.errorMessage.slice(0, 80)}` : ""}${status === "failed" ? " step=failed" : ""}${usageStr}`);
  }

  if (dispatched.length > 0) {
    lines.push(`▶️ 派发 ${dispatched.length} 步并等待子进程完成: #${dispatched.join(", #")}`);
  }

  // P13: 派发完成后重新加载 plan，用最新状态判断是否全部完成
  //     （dispatch 前的 completedIds 是旧快照，本批完成后会漏判 → plan.status
  //       不立即置 completed）。
  let freshCompleted = completedIds.size;
  if (dispatched.length > 0) {
    const freshPlan = await loadPlan(cwd, planPath);
    if (freshPlan) {
      freshCompleted = freshPlan.steps.filter((s) => s.status === "completed").length;
      if (freshPlan.steps.length > 0 && freshCompleted === freshPlan.steps.length) {
        freshPlan.status = "completed";
        freshPlan.completed_at = freshPlan.completed_at || new Date().toISOString();
        await savePlan(cwd, freshPlan, planPath);
        lines.push(`✅ DAG 全部完成！${freshCompleted}/${freshPlan.steps.length} 步`);
      }
    }
  }

  // Update status bar
  if (ctx) updateStatusBar(ctx);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      total: plan.steps.length,
      completed: freshCompleted,
      running: running.length,
      ready: ready.length,
      dispatched: toDispatch.map((s) => s.id),
      blocked: blockedAfterConfirm.length,
      failed: failed.length,
      autoRetried,
      subagents: subagentResults.map(({ stepId, status, result }) => ({
        stepId,
        status,
        exitCode: result.exitCode,
        timedOut: result.timedOut ?? false,
        stopReason: result.stopReason,
        errorMessage: result.errorMessage,
        usage: result.usage,
        model: result.model,
      })),
    },
    // 子进程模式：无 followUp 队列依赖，无需 terminate。
    // 主 Agent 可在本工具返回后继续调用 execute 调度下一批。
  };
}

// ── Heartbeat check ─────────────────────────────────────────────────────────

async function runHeartbeatCheck(
  cwd: string,
  plan: Plan,
  planPath: string,
  ctx?: any,
): Promise<{ content: any[]; details: any }> {
  const now = Date.now();
  const lines: string[] = [];
  const staleSteps: Step[] = [];
  // 优先用 plan.execution.stale_after_seconds（与 status.ts 健康指示一致），
  // 兼容文档 schema 的顶层 heartbeat_timeout_min（分钟）；都缺省时用 900s 默认。
  const execCfg = plan.execution ?? {};
  const staleSeconds =
    execCfg.stale_after_seconds ??
    (((plan as any).heartbeat_timeout_min ?? 0) > 0 ? (plan as any).heartbeat_timeout_min * 60 : undefined) ??
    STALE_SECONDS_DEFAULT;

  for (const step of plan.steps) {
    if (step.status !== "running") continue;
    if (!step.heartbeat_at) { staleSteps.push(step); continue; }

    const hbTime = new Date(step.heartbeat_at).getTime();
    const age = Math.round((now - hbTime) / 1000);
    if (age > staleSeconds) staleSteps.push(step);
  }

  // Mark stale steps: 远程步骤 wrapper 死亡 ≠ 任务失败 → interrupted（不自动重试，
  // 避免重复启动远程管线）；本地步骤保留原逻辑（重试/失败）。
  for (const step of staleSteps) {
    const isRemote =
      (step as any).execution_target === "remote" || !!((step as any).remote_server);
    if (isRemote) {
      step.status = "interrupted";
      step.error = `Heartbeat timeout > ${staleSeconds}s：wrapper 中断，远程管线可能继续运行，需检查后 resume / 重启 / 确认失败`;
      step.agent_id = null;
      lines.push(`⚠️ #${step.id} 心跳超时（远程步骤）→ interrupted，待检查`);
      execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--interrupt", "--error", step.error], cwd, { timeout: 10000 });
      continue;
    }
    if (((step as any).retry_count ?? 0) < MAX_RETRIES) {
      (step as any).retry_count = ((step as any).retry_count ?? 0) + 1;
      step.status = "pending";
      step.progress = 0;
      step.agent_id = null;
      lines.push(`🔄 #${step.id} 重试 (#${(step as any).retry_count})`);
      execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--status", "pending", "--progress", "0", "--note", `Auto-retry #${(step as any).retry_count}`], cwd, { timeout: 10000 });
    } else {
      step.status = "interrupted";
      step.error = `Heartbeat timeout > ${staleSeconds}s`;
      step.agent_id = null;
      lines.push(`💀 #${step.id} 心跳超时（重试耗尽）→ interrupted，待检查`);
      execPython(UPDATE_STEP_PY, ["--plan", planPath, "--step-id", String(step.id), "--interrupt", "--error", step.error], cwd, { timeout: 10000 });
    }
  }

  const runningCount = plan.steps.filter((s) => s.status === "running").length;
  if (runningCount === 0 && plan.steps.every((s) => s.status === "completed")) {
    plan.status = "completed";
    plan.completed_at = new Date().toISOString();
  }

  await savePlan(cwd, plan, planPath);
  if (ctx) updateStatusBar(ctx);

  const snap = await snapshotPlan(cwd);
  const statusLine = snap ? formatStatusLine(snap) : "";
  if (lines.length === 0) lines.push(`💓 心跳检查: ${staleSteps.length} 过期, ${runningCount} 正常`);
  if (statusLine) lines.push(statusLine);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      stale: staleSteps.length,
      // C7 修复：retried 只计真正转回 pending 重试的（本批内 retry_count 增加且未失败）；
      // 原逻辑 `retry_count <= MAX_RETRIES` 会把已达上限转 failed 的步骤也计入 retried。
      retried: staleSteps.filter((s) => s.status === "pending" && ((s as any).retry_count ?? 0) > 0).length,
      failed: staleSteps.filter((s) => s.status === "failed").length,
    },
  };
}

// ── Full cycle: schedule + heartbeat check ──────────────────────────────────

async function runFullCycle(
  pi: ExtensionAPI,
  cwd: string,
  plan: Plan,
  planPath: string,
  ctx?: any,
  signal?: AbortSignal, // P12：透传给 runSchedule → runSubagent
  onUpdate?: any, // pi 流式观察：透传给 runSchedule
): Promise<{ content: any[]; details: any }> {
  // 1. Heartbeat check first
  const hbResult = await runHeartbeatCheck(cwd, plan, planPath, ctx);

  // Reload plan after heartbeat check mutations
  const updatedPlan = await loadPlan(cwd, planPath);
  if (!updatedPlan) {
    return {
      content: [{ type: "text", text: hbResult.content[0].text + "\n\n❌ 无法重新加载 plan" }],
      details: hbResult.details,
    };
  }

  // 2. Schedule new steps
  const schedResult = await runSchedule(pi, cwd, updatedPlan, planPath, ctx, signal, onUpdate);

  // Update status bar
  if (ctx) updateStatusBar(ctx);

  const combined = [
    hbResult.content[0].text,
    schedResult.content[0].text,
  ].filter(Boolean).join("\n");

  return {
    content: [{ type: "text", text: combined }],
    details: {
      heartbeat: hbResult.details,
      schedule: schedResult.details,
    },
    // 子进程模式：无需 terminate（无 followUp 依赖）
  };
}

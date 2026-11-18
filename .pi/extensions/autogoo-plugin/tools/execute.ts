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
import { logWarn } from "../utils/log.js";
import { DEFAULT_MEMORY_LAYER, DEFAULT_STALE_HEARTBEAT_SECONDS } from "../constants.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execPython, execShell } from "../utils/exec.js";
import { runSubagent, resolveSubagentModel, resolveOrPromptSubagentModel, spawnSubagentDetached, isDetachedAlive, type DetachedHandle } from "../utils/subagent.js";
import { getRolePrompt, getTaskAgentPrompt } from "../utils/prompts.js";
import { updateStatusBar, formatStatusLine, snapshotPlan } from "../utils/status.js";
import { checkPlanLocks, acquirePlanLocks, releasePlanLocks, describeConflicts } from "../utils/locks.js";
import {
  setupWorktreeIsolation,
  mergeAllStepWorktrees,
  describeMergeOutcomes,
  describeConflictSummary,
  resolveWorktreeIsolation,
} from "../utils/worktree-isolation.js";
import { describeMessageContent, describeToolResult } from "../utils/tool-summary.js";
import { activityBus } from "../utils/activity.js";
import { uiConfirmDetailed } from "../utils/ui.js";
import {
  loadPlanSync, loadPlan,
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
  measureWikiPaths,
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
import { checkAndDeliverAlerts, observabilityOf, type ExecAlert } from "../utils/exec-observe.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
const STALE_SECONDS_DEFAULT = DEFAULT_STALE_HEARTBEAT_SECONDS;

/**
 * 调用 update-step.py 更新步骤状态，**并检查结果**。
 *
 * 为什么需要：`execPython(UPDATE_STEP_PY, ...)` 在本文件里有 15 处裸调用，
 * 覆盖 start / complete / fail / interrupt / block / status 全部核心状态变更，
 * 而返回值从未检查。脚本失败时（plan 被并发写坏、python 异常、锁超时）
 * 唯一的后果是「什么都没发生」：
 *
 *   --start 失败   → 子进程已启动但 step 还是 pending，状态分裂
 *   --complete 失败 → 步骤做完了但 plan 不知道，随后被判为僵尸
 *   --fail 失败    → 失败原因丢了，重试策略拿不到信息
 *
 * 这些都不会报错，只会让 plan 与事实悄悄偏离 —— 与「空 catch」是同一类病。
 *
 * 策略：**尽力而为 + 留痕**。失败不抛（状态更新不该让 DAG 崩），
 * 但一定 logWarn 并返回 false，让调用方/日志能看到「这次没更新成功」。
 */
function updateStep(
  cwd: string,
  planPath: string,
  stepId: string | number,
  args: string[],
  label: string,
): boolean {
  try {
    // ⚠ 这里必须直接调 execPython，不能调 updateStep —— 否则递归调用自己。
    const r = execPython(
      UPDATE_STEP_PY,
      ["--plan", planPath, "--step-id", String(stepId), ...args],
      cwd,
      { timeout: 15000 },
    );
    if (r.exitCode !== 0) {
      logWarn(
        `[execute] 状态更新失败 #${stepId} ${label}: exit=${r.exitCode} ` +
          `${(r.stderr || r.stdout || "").slice(0, 160)}`,
      );
      return false;
    }
    return true;
  } catch (e: any) {
    logWarn(`[execute] 状态更新异常 #${stepId} ${label}: ${e?.message ?? String(e)}`);
    return false;
  }
}
const MAX_RETRIES = 1;

/**
 * 自动重试的 step log note。
 *
 * 重试 = 同一个 step 再跑一遍，已产生的副作用不会自己回滚。把 checkpoint 条数
 * 写进 note，step log 里就能看出这次重试有幂等台账可依；update-step.py
 * --status pending 会基于 checkpoint 写 resume_state（intact 项不要重做）。
 */
function retryNote(step: any, attempt: number): string {
  const count = Array.isArray(step?.checkpoints) ? step.checkpoints.length : 0;
  return count > 0
    ? `Auto-retry #${attempt}（幂等：比对 ${count} 条 checkpoint，intact 项不要重做）`
    : `Auto-retry #${attempt}`;
}

/**
 * `update-step.py` 的执行指标参数（写入 .goo/logs/exec.jsonl）。
 *
 * 为什么从这里传：退出码、实测耗时、stderr 摘录**只有调用方知道**。
 * 让 update-step 去猜是猜不准的（它只能看 plan 时间戳），而猜不准的指标
 * 比没有指标更危险 —— 会让人以为「10 分钟的 step 其实跑了 40 分钟」。
 */
function execMetaArgs(meta: {
  exitCode?: number | null;
  durationMs?: number | null;
  timedOut?: boolean;
  stderrExcerpt?: string | null;
}): string[] {
  const out: string[] = [];
  if (typeof meta.exitCode === "number" && Number.isFinite(meta.exitCode)) {
    out.push("--exit-code", String(Math.trunc(meta.exitCode)));
  }
  if (typeof meta.durationMs === "number" && Number.isFinite(meta.durationMs) && meta.durationMs >= 0) {
    out.push("--duration-ms", String(Math.trunc(meta.durationMs)));
  }
  if (meta.timedOut) out.push("--timed-out");
  if (meta.stderrExcerpt) out.push("--stderr-excerpt", meta.stderrExcerpt.slice(0, 300));
  return out;
}

/**
 * 阈值告警（push）：判定 → ctx.ui.notify → 可选 webhook。
 *
 * 以前检测是 pull 的：只有 schedule/heartbeat_check 被调用才执行，结果只当
 * 文本返回。无人值守时没人调用 = 没人知道 DAG 停了。这里每轮调度后主动推一次，
 * 加上 index.ts 的看门狗定时轮询，才是「卡住能主动提示」。
 *
 * 失败绝不影响执行（内部 try/catch，返回空列表）。
 */
async function pushExecAlerts(ctx: any, cwd: string, planPath: string): Promise<ExecAlert[]> {
  try {
    const config = observabilityOf(await loadProjectConfig(cwd).catch(() => null));
    const result = checkAndDeliverAlerts(ctx, planPath, { config: config ?? null });
    return result.delivered;
  } catch (e: any) {
    logWarn("[AutoGoo-Plugin] 执行告警判定失败（不影响调度）:", e?.message ?? String(e));
    return [];
  }
}

/** 把已投递的告警拼进工具输出（TUI 之外也要能看到）。 */
function describeDelivered(alerts: ExecAlert[]): string[] {
  if (alerts.length === 0) return [];
  return [
    `🚨 已主动告警 ${alerts.length} 条:`,
    ...alerts.map((a) => `  · [${a.code}] ${a.message.split("\n")[0]}`),
  ];
}

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
      updateStep(cwd, planPath, step.id, ["--status", "pending", "--retry", "--note", retryNote(step, retryCount + 1)], "status");
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
      updateStep(cwd, planPath, step.id, ["--block", "--error", "requires user confirm (no interactive ui)"], "block");
      lines.push(`🚧 #${step.id} 需用户确认，但当前无可交互 UI，已标记 blocked`);
      continue;
    }
    let answer = false;
    try {
      // 高风险步骤确认：超时一律拒绝并保持 blocked。
      answer = (await uiConfirmDetailed(
        ctx,
        `确认执行步骤 #${step.id}？`,
        `步骤: ${step.name}\n\n${step.description || ""}\n\n` +
          `此步骤在规划时标记为需用户确认（requires_user_confirm，高风险/远程/成本类操作）。\n` +
          `确认后继续派发执行；拒绝则保持 blocked。`,
        { defaultOnTimeout: false },
      )).value ?? false;
    } catch (e: any) {
      logWarn(`[AutoGoo-Plugin] confirm #${step.id} 失败，默认拒绝:`, e?.message ?? String(e));
      answer = false;
    }
    if (answer) {
      updateStep(cwd, planPath, step.id, ["--confirmed", "--note", "user confirmed via scheduler"], "confirmed");
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
      updateStep(cwd, planPath, step.id, ["--block", "--error", "user declined confirmation"], "block");
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

  // 并行写冲突检测。0.30.0 只告警（「自动串行会拖慢本就该并行的任务」）；
  // 0.31.0 起：开关 `config.execution.worktree_isolation` 打开时，重叠步骤会被
  // 分到**独立 git worktree**（真隔离），关闭时行为与之前完全一致。
  // 提前读一次 execution 配置：这里要决定告警文案，且后面主流程也复用。
  const execCfg = (await loadProjectConfig(cwd).catch(() => null))?.execution || {};
  const isolationDecision = resolveWorktreeIsolation(execCfg);
  const writeConflicts = detectWriteConflicts(toDispatch);
  if (writeConflicts.length > 0) {
    lines.push(...describeWriteConflicts(writeConflicts, { isolationEnabled: isolationDecision.enabled }));
    for (const c of writeConflicts) {
      updateStep(cwd, planPath, c.a.id, ["--heartbeat", "--note",
         `写入范围与 #${c.b.id} 重叠: ${c.overlap.slice(0, 3).join(", ")}`], "heartbeat");
      updateStep(cwd, planPath, c.b.id, ["--heartbeat", "--note",
         `写入范围与 #${c.a.id} 重叠: ${c.overlap.slice(0, 3).join(", ")}`], "heartbeat");
    }
  }

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
    updateStep(cwd, planPath, step.id, ["--start", "--progress", "5", "--agent-id", agentId], "start");
    updateStep(cwd, planPath, step.id, ["--precreate-log", "--note", `Dispatched to ${step.subagent} (${agentId})`], "note");
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
  // （execCfg 已在写冲突检测处加载，见上）
  // 超时可配：默认 total 30min / idle 5min。idle 才是"卡住不等满半小时"的关键。
  const subagentTimeoutMs = (Number(execCfg.subagent_timeout_seconds) || 1800) * 1000;
  const subagentIdleTimeoutMs = (Number(execCfg.subagent_idle_timeout_seconds) || 300) * 1000;
  const heartbeatIntervalMs = (Number(execCfg.heartbeat_seconds) || 20) * 1000;
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
  // ── 资源冲突检查（plan 级，thread-locks）────────────────────────────
  // 规则一直写在 SKILL.md 里，但此前没有任何代码调用它 → 两个会话可以同时写
  // 同一批文件 / wiki 页 / 端口 / 远程服务器。这里补上真正的强制点。
  // 并行派发用 plan 级 acquire/release（release-plan 会释放该 thread 的全部锁，
  // 因此不能放在单步回调里）。
  // 活动跟踪：供 /goo-subagent 面板查看（不装常驻 widget）
  for (const step of toDispatch) {
    activityBus.begin(step.id, `${step.name ?? ""}${step.subagent ? ` · ${step.subagent}` : ""}`.trim());
  }

  const lockCheck = checkPlanLocks(cwd, planPath);
  if (!lockCheck.ok) {
    const detail = describeConflicts(lockCheck.conflicts) || lockCheck.error || "未知冲突";
    for (const step of toDispatch) {
      updateStep(cwd, planPath, step.id, ["--block", "--error", `资源冲突：${detail}`], "block");
      lines.push(`🚧 #${step.id} 资源冲突已 blocked：${detail}`);
    }
    return {
      content: [
        {
          type: "text",
          text:
            `blocked: 检测到资源冲突，本批 ${toDispatch.length} 步均未派发。\n` +
            `冲突：${detail}\n` +
            `处理：释放对方 thread 的锁，或调整这些 step 的写入范围后重试。\n` +
            `查看锁：python3 skills/auto-goo/scripts/thread-locks.py list`,
        },
      ],
      details: { blocked: true, conflicts: lockCheck.conflicts ?? [], steps: toDispatch.map((s) => s.id) },
    };
  }
  const acquired = acquirePlanLocks(cwd, planPath);
  if (!acquired.ok) {
    lines.push(`⚠ 获取资源锁失败：${acquired.error || describeConflicts(acquired.conflicts)}`);
  }

  // ── 写冲突隔离（config.execution.worktree_isolation，默认关闭）───────────
  // 边界（与 plan 契约一致）：
  //   - 开关关闭 → **不跑任何 git 命令**，行为与 0.30.0 完全一致（零回归）；
  //   - 开关打开但本批无写冲突 → 不建 worktree（零额外成本）；
  //   - 有冲突 → 只给冲突簇内步骤建独立 worktree；创建失败/非 git/脏树 → 该步降级串行。
  const isolation = setupWorktreeIsolation(cwd, toDispatch, writeConflicts, execCfg);
  if (isolation.lines.length > 0) lines.push(...isolation.lines);
  let isolationOutcomes: ReturnType<typeof mergeAllStepWorktrees> = [];

  const dispatchStep = async (step: any) => {
    const agentId = agentIds.get(String(step.id)) ?? `agent-${step.id}-${Date.now()}`;
    const { packet, packetGenerated } = packets.get(String(step.id)) ?? {
      packet: { wiki_paths: [] as string[], wiki_graph_packet_path: "", memory_layer: DEFAULT_MEMORY_LAYER },
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
    // 隔离步骤：Subagent 只在 worktree 内改代码，plan / 日志 / artifacts 经
    // `.goo/` 符号链接共享主工程（见 utils/worktree-isolation.ts linkSharedGooDir）。
    const wtState = isolation.worktreeByStep.get(String(step.id));
    const stepCwd = wtState?.worktreeDir ?? cwd;
    if (wtState) {
      stepContract.push(
        `- 工作目录（隔离 worktree）: ${wtState.worktreeDir}`,
        `- 隔离约束: 所有代码改动只能写在该 worktree 内（相对路径按 worktree 根解析）；不要 cd 到主工程 ${cwd}，否则隔离失效。`.replace(/；。/g, "。"),
        `- 合并说明: 完成后框架会按依赖顺序把你的 worktree 分支合并回主分支；若产生真冲突会保留双方并交人裁决，不会静默覆盖。`,
      );
    }
    // 保活进度显示（2026-10-08）：子进程可能长时间思考不产生事件，
    // 只在有消息时 onUpdate 会让工具输出长时间静止，用户以为卡死。
    const startedAt = Date.now();
    const fmtElapsed = () => {
      const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    };
    let lastActivity = "已派发，等待首个事件…";
    let eventCount = 0;
    const emit = (text: string) => {
      try {
        onUpdate?.({ content: [{ type: "text", text }] });
      } catch {
        /* 进度上报失败不阻塞 */
      }
    };
    const setProgressStatus = (text: string | undefined) => {
      try {
        ctx?.ui?.setStatus?.("autogoo-dispatch", text);
      } catch {
        /* 状态栏不可用不阻塞 */
      }
    };
    const roleLabel = `${step.subagent || "researcher"}${step.task_agent ? "/" + step.task_agent : ""}`;
    emit(`▶ step #${step.id} 派发中 · ${roleLabel} · ${subModel.provider}/${subModel.model} · [00:00]`);
    setProgressStatus(`▶ #${step.id} ${roleLabel} 00:00`);
    const progressTimer = setInterval(() => {
      emit(`⏳ step #${step.id} 运行中 [${fmtElapsed()}] · 事件 ${eventCount} · ${lastActivity}`);
      setProgressStatus(`⏳ #${step.id} ${fmtElapsed()} · ${lastActivity.slice(0, 40)}`);
    }, 8000);

    let result;
    try {
      result = await runSubagent({
      systemPrompt: [getRolePrompt(step.subagent || "researcher"), getTaskAgentPrompt(step.task_agent || "")].filter(Boolean).join("\n"),
      task: buildSubagentTaskPrompt({
        role: step.subagent || "researcher",
        task: step.description || `执行 step #${step.id}: ${step.name}`,
        wiki_paths: packet.wiki_paths,
        wiki_graph_packet_path: packet.wiki_graph_packet_path,
        packetGenerated,
        memory_layer: packet.memory_layer,
        stepContract,
        wikiPathSizes: await measureWikiPaths(cwd, packet.wiki_paths),
        checkpoints: (step as any).checkpoints,
        resumeState: (step as any).resume_state,
      }),
      cwd: stepCwd,
      signal, // P12：透传用户中断信号，防止子进程成孤儿
      provider: subModel.provider,
      model: subModel.model,
      onTick: () => void heartbeatTick(cwd, planPath, step.id, agentId),
      // pi 流式观察（2026-08-14）：把 Subagent 子进程的 JSON 流消息
      // （assistant 文本 / tool call / tool result）桥接到工具 onUpdate，
      // TUI 实时显示执行过程。之前未接线 → pi 版看不到 Subagent 内部。
      onMessage: (message: any) => {
        try {
          const role = message?.role;
          let text = "";
          if (role === "assistant" && Array.isArray(message.content)) {
            // toolCall 带出真实参数（命令/路径/pattern），不再只是 ⟦bash(...⟧
            text = describeMessageContent(message.content);
          } else if (message?.type === "tool_result_end" || message?.role === "tool") {
            const summary = describeToolResult(message);
            text = summary ? `⟦result⟧ ${summary}` : "";
          }
          if (text) {
            eventCount += 1;
            lastActivity = text.replace(/\s+/g, " ").slice(0, 120);
            const kind = text.startsWith("⟦result⟧") ? "result" : text.startsWith("⟦") ? "tool" : "text";
            activityBus.push(step.id, kind as any, text.slice(0, 200));
            emit(`  #${step.id} [${fmtElapsed()}] ▶ ${text.slice(0, 400)}`);
          }
        } catch {
          /* 流式转发失败不阻塞 */
        }
      },
      timeoutMs: subagentTimeoutMs,
      idleTimeoutMs: subagentIdleTimeoutMs,
      heartbeatIntervalMs: heartbeatIntervalMs,
      // 信号 D：subagent 追加 step log 即视为有进展（防「进程内纯 IO 等待」被误杀）
      logPath: (step as any).log_path ?? undefined,
      // step 已完成/失败但进程没退出时提前结束，避免白等
      shouldStop: () => {
        try {
          const snapshot = loadPlanSync(cwd, planPath);
          const target = snapshot?.steps?.find((s: any) => String(s.id) === String(step.id));
          return !!target && (target.status === "completed" || target.status === "failed");
        } catch {
          return false;
        }
      },
      });
    } finally {
      clearInterval(progressTimer);
      setProgressStatus(undefined);
      activityBus.end(
        step.id,
        result?.aborted ? "interrupted" : result && result.exitCode === 0 ? "done" : "failed",
      );
    }
    // 兕底：子进程退出后 step 若仍 running，按退出码标记
    // stderr 摘录：provider 认证/限流/模型不存在等错误只出现在 stderr。
    // 不带上它时，所有非 0 退出看起来都像「wrapper 被信号杀」——实测因此
    // 把一个 yj provider 并发失败误诊成「pi tool 调用 2 分钟超时」。
    const stderrExcerpt = excerptStderr(result.stderr);
    const planNow = await loadPlan(cwd, planPath);
    const stepNow = planNow?.steps.find((s: any) => String(s.id) === String(step.id));
    if (stepNow?.status === "running") {
      const ok = result.exitCode === 0 && !result.errorMessage && !result.timedOut;
      // 实测耗时：从本批派发到子进程结束。报告值优先于 plan 时间戳派生值，
      // 因为重试会让 started_at 保留第一次的时间（分母变错）。
      const execMeta = execMetaArgs({
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
        stderrExcerpt,
      });
      if (ok) {
        updateStep(cwd, planPath, step.id, ["--complete", "--note", `Subagent exit 0（兕底标记完成）`, ...execMeta], "complete");
      } else {
        // 信号杀（143=SIGTERM / 137=SIGKILL）或超时：wrapper 中断 ≠ 任务失败。
        // 远程管线（execution_target=remote）或本地任务本体可能仍在运行，
        // 标 interrupted 让主 Agent 检查后 resume / 重启 / 确认失败，而不是直接 failed。
        const killedBySignal = result.exitCode === 143 || result.exitCode === 137 || result.signal === "SIGTERM" || result.signal === "SIGKILL";
        if (result.timedOut || killedBySignal) {
          updateStep(cwd, planPath, step.id, ["--interrupt",
              "--timed-out",
              "--error",
              result.errorMessage ||
                `subagent wrapper 中断（exit ${result.exitCode}${result.timedOut ? "，超时" : "，被信号杀"}），任务本体可能继续运行，需检查后恢复` +
                  (stderrExcerpt ? ` | stderr: ${stderrExcerpt}` : ""),
              ...execMeta], "interrupt");
        } else {
          updateStep(cwd, planPath, step.id, ["--fail", "--error",
            (result.errorMessage || `subagent exit ${result.exitCode}`) + (stderrExcerpt ? ` | stderr: ${stderrExcerpt}` : ""),
            ...execMeta], "fail");
        }
      }
    }
    return { stepId: step.id, status: stepNow?.status, result };
  };

  // 隔离成功的步骤与其他无冲突步骤并行；隔离失败的步骤**串行**执行
  // （降级要求：宁可慢，不可两个 subagent 同时写同一文件互相覆盖）。
  const degraded = new Set(isolation.degradedStepIds);
  const parallelSteps = toDispatch.filter((s: any) => !degraded.has(String(s.id)));
  const serialSteps = toDispatch.filter((s: any) => degraded.has(String(s.id)));
  const subagentResults = await Promise.all(parallelSteps.map((s: any) => dispatchStep(s)));
  for (const step of serialSteps) {
    lines.push(`⏳ #${step.id} 串行执行（worktree 隔离不可用，避免与同批写范围重叠步骤互相覆盖）`);
    subagentResults.push(await dispatchStep(step));
  }

  // ── 合并 worktree（按依赖顺序；真冲突报告而非静默覆盖）────────────────────
  if (isolation.worktreeByStep.size > 0) {
    const isolatedIds = [...isolation.worktreeByStep.keys()];
    isolationOutcomes = mergeAllStepWorktrees(cwd, isolatedIds, plan.steps);
    lines.push(...describeMergeOutcomes(isolationOutcomes, cwd));
    // 冲突结论写进 step log：主 Agent 的输出会被截断/遗忘，日志才是事后可追溯的。
    for (const o of isolationOutcomes) {
      if (o.status !== "conflict" && o.status !== "failed") continue;
      const target = plan.steps.find((s: any) => String(s.id) === o.stepId);
      if (!target?.log_path) continue;
      const logPath = target.log_path.startsWith("/") ? target.log_path : join(cwd, target.log_path);
      if (!existsSync(logPath)) continue;
      try {
        appendFileSync(
          logPath,
          [
            "",
            `## Worktree 合并${o.status === "conflict" ? "冲突" : "失败"}（需人工裁决）`,
            `- 时间: ${new Date().toISOString()}`,
            `- 分支: ${o.branch}（已保留，未删除）`,
            `- worktree: ${o.worktreeDir}`,
            `- 冲突文件: ${o.conflictFiles.join(", ") || "无"}`,
            `- 说明: ${o.error ?? ""}`,
            `- 裁决指引: .goo/worktrees/CONFLICTS.md`,
            "",
          ].join("\n"),
          "utf-8",
        );
      } catch {
        /* 日志追加失败不阻塞合并结果上报（结果仍写进工具 details） */
      }
    }
  }

  // 释放本 thread 的资源锁（与上面的 acquirePlanLocks 配对；无锁时安全 no-op）
  const released = releasePlanLocks(cwd, planPath);
  if (!released.ok) {
    lines.push(`⚠ 释放资源锁失败：${released.error}`);
  }

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

  // 阈值告警（push）：DAG 卡住/超时/连续重试必须在无人值守时也能主动提示。
  // 放在本批完成之后：先用最新状态判定，避免拿「刚派发还没心跳」误报。
  const deliveredAlerts = await pushExecAlerts(ctx, cwd, planPath);
  lines.push(...describeDelivered(deliveredAlerts));

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
      alerts: deliveredAlerts.map((a) => ({ code: a.code, level: a.level, stepId: a.stepId ?? null })),
      isolation: {
        enabled: isolation.enabled,
        reason: isolation.reason,
        worktrees: [...isolation.worktreeByStep.values()].map((s) => ({ stepId: s.stepId, branch: s.branch, worktreeDir: s.worktreeDir })),
        degraded: isolation.degradedStepIds,
        merges: isolationOutcomes.map((o) => ({ stepId: o.stepId, status: o.status, conflictFiles: o.conflictFiles, branch: o.branch })),
        conflictSummary: describeConflictSummary(isolationOutcomes),
      },
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

  // ── detached 子进程存活检测 ──────────────────────────────────────────────
  //
  // detached 模式下父进程收不到 close 事件，只能靠 pid 存活判断。
  // 死掉但 step 还是 running 的，直接判 interrupted（不要等心跳超时 15 分钟）——
  // 否则用户会看到"运行中"假象却永远不推进。
  const detachedDead: Step[] = [];
  const agentsDirOf = async (): Promise<string | null> => {
    try {
      const tid = (await getCurrentThreadId(cwd)) ?? null;
      return tid ? join(cwd, ".goo", "threads", tid, "agents") : null;
    } catch {
      return null;
    }
  };
  const agentsDir = await agentsDirOf();
  if (agentsDir && existsSync(agentsDir)) {
    for (const step of plan.steps) {
      if (step.status !== "running") continue;
      const metaPath = join(agentsDir, `step-${step.id}.json`);
      if (!existsSync(metaPath)) continue;          // 非 detached 派发（阻塞路径/历史），跳过
      let meta: any = null;
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      } catch {
        continue;
      }
      if (!meta?.pid) continue;
      if (!isDetachedAlive(Number(meta.pid))) {
        detachedDead.push(step);
      }
    }
  }
  for (const step of detachedDead) {
    step.status = "interrupted";
    step.error = `detached 子进程已退出但 step 未标记完成（log: .goo/threads/<tid>/agents/step-${step.id}.jsonl）`;
    step.agent_id = null;
    lines.push(`💀 #${step.id} detached 子进程已退出 → interrupted（检查 agents/step-${step.id}.jsonl）`);
    updateStep(cwd, planPath, step.id, ["--interrupt", "--timed-out", "--error", step.error], "interrupt");
  }

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
      updateStep(cwd, planPath, step.id, ["--interrupt", "--timed-out", "--error", step.error], "interrupt");
      continue;
    }
    if (((step as any).retry_count ?? 0) < MAX_RETRIES) {
      (step as any).retry_count = ((step as any).retry_count ?? 0) + 1;
      step.status = "pending";
      step.progress = 0;
      step.agent_id = null;
      lines.push(`🔄 #${step.id} 重试 (#${(step as any).retry_count})`);
      updateStep(cwd, planPath, step.id, ["--status", "pending", "--progress", "0", "--retry", "--note", retryNote(step, (step as any).retry_count)], "status");
    } else {
      step.status = "interrupted";
      step.error = `Heartbeat timeout > ${staleSeconds}s`;
      step.agent_id = null;
      lines.push(`💀 #${step.id} 心跳超时（重试耗尽）→ interrupted，待检查`);
      updateStep(cwd, planPath, step.id, ["--interrupt", "--timed-out", "--error", step.error], "interrupt");
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

  // 阈值告警：心跳检查本身就是「卡住检测」，检测到就必须推出去，
  // 而不是只把它塞进返回值等调用方读（无人值守时没人读）。
  const hbAlerts = await pushExecAlerts(ctx, cwd, planPath);
  lines.push(...describeDelivered(hbAlerts));

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      stale: staleSteps.length,
      alerts: hbAlerts.map((a) => ({ code: a.code, level: a.level, stepId: a.stepId ?? null })),
      // C7 修复：retried 只计真正转回 pending 重试的（本批内 retry_count 增加且未失败）；
      // 原逻辑 `retry_count <= MAX_RETRIES` 会把已达上限转 failed 的步骤也计入 retried。
      retried: staleSteps.filter((s) => s.status === "pending" && ((s as any).retry_count ?? 0) > 0).length,
      failed: staleSteps.filter((s) => s.status === "failed").length,
    },
  };
}

// ── 并行写冲突检测 ────────────────────────────────────────────────────────────

/** 一个步骤的写范围展开后的「冲突单元」集合。 */
function writeScopeOf(step: any): Set<string> {
  const out = new Set<string>();
  for (const raw of step.allowed_write_paths || []) {
    const p = String(raw).trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (!p) continue;
    // 目录（以 / 结尾或已知目录形态）→ 内部任意文件都冲突；
    // 用「前缀 + 分隔符」表示，避免 "src" 误配 "srcfoo"
    out.add(p.endsWith("/") ? p : `${p}/`);
  }
  return out;
}

/** 两个写范围是否重叠（互为前缀 / 相同 / 一方是另一方祖先）。 */
function scopesOverlap(a: Set<string>, b: Set<string>): string[] {
  const hits: string[] = [];
  for (const x of a) {
    for (const y of b) {
      const xs = x.replace(/\/$/, "");
      const ys = y.replace(/\/$/, "");
      if (xs === ys) { hits.push(xs); continue; }
      // 祖先关系：a 覆盖 b 或 b 覆盖 a
      if (y.startsWith(`${x}`) || x.startsWith(`${y}/`)) hits.push(xs === ys ? xs : `${xs} ∩ ${ys}`);
    }
  }
  return [...new Set(hits)];
}

export interface WriteConflict {
  a: any;
  b: any;
  overlap: string[];
}

/**
 * 找出**同批派发**步骤之间的写范围重叠。
 *
 * 为什么需要：`allowed_write_paths` 此前只写进 subagent prompt 当说明文字，
 * **零强制**。实测一轮 4 个并行步骤的写范围全部重叠（check-plugin.sh 被
 * 4 个步骤同时修改），系统毫无察觉 —— 两个 subagent 同时写同一文件时，
 * 后写的直接覆盖先写的，且不会报错。
 *
 * 处置策略：**不阻止派发**（很多步骤确实要改同一批文件的不同位置），
 * 而是把冲突明确告知：
 *   - 写进主 Agent 的返回消息（人能看见）
 *   - 写进每个受影响 step 的 log（事后可追溯）
 * 是否降级为串行由人决定 —— 自动串行会显著拖慢本该并行的任务。
 */
export function detectWriteConflicts(steps: any[]): WriteConflict[] {
  const out: WriteConflict[] = [];
  const scopes = steps.map(writeScopeOf);
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      const overlap = scopesOverlap(scopes[i], scopes[j]);
      if (overlap.length > 0) out.push({ a: steps[i], b: steps[j], overlap });
    }
  }
  return out;
}

/** 把冲突渲染成主 Agent 与 step log 都能读懂的几行。 */
export function describeWriteConflicts(
  conflicts: WriteConflict[],
  opts: { isolationEnabled?: boolean } = {},
): string[] {
  if (conflicts.length === 0) return [];
  const verdict = opts.isolationEnabled
    ? "已启用 worktree 隔离（config.execution.worktree_isolation）"
    : "可能互相覆盖（不阻止执行）";
  const lines = [
    `⚠️ ${conflicts.length} 组并行步骤的写入范围重叠 —— ${verdict}`,
  ];
  for (const c of conflicts.slice(0, 6)) {
    lines.push(
      `   #${c.a.id} ∩ #${c.b.id} → ${c.overlap.slice(0, 3).join(", ")}` +
        (c.overlap.length > 3 ? ` 等 ${c.overlap.length} 处` : ""),
    );
  }
  if (conflicts.length > 6) lines.push(`   …另有 ${conflicts.length - 6} 组`);
  lines.push(
    opts.isolationEnabled
      ? "   处置：重叠步骤将各自在独立 git worktree 中工作，完成后按依赖顺序合并；真冲突会报告冲突文件并保留双方改动。"
      : "   建议：确认这些步骤不会改同一批文件；若会，改为串行或拆分写范围（或在 config.execution.worktree_isolation 打开隔离）。",
  );
  return lines;
}

// ── Detached 派发（绕开 pi tool call 2 分钟硬超时）────────────────────────────

/**
 * 把就绪步骤以 **detached 子进程**派发出去，立刻返回。
 *
 * 为什么必须这样：pi 对每个 tool call 有硬编码 `TOOL_TIMEOUT_MS = 12e4`（2 分钟），
 * 到点 abort 会连带 SIGTERM 掉我们 spawn 的子进程 —— 表现为所有步骤 `exit=143`、
 * 停在 progress=15。真实 DAG 步骤通常几分钟到几十分钟，所以「阻塞等待」这条路
 * 在当前 pi 版本下根本走不通。
 *
 * 拆成两段：
 *   1. 本函数：spawn detached（毫秒级）+ 把 pid 落盘 → 立即返回
 *   2. heartbeat_check：读 pid 落盘文件，检测存活；死了但 step 仍 running → interrupted
 *
 * 子进程自己负责把 step 标为 completed（它有 auto_goo_update_step 工具）。
 */
async function dispatchDetached(
  cwd: string,
  plan: Plan,
  planPath: string,
  toDispatch: any[],
  agentIds: Map<string, string>,
  packets: Map<string, any>,
  subModel: { provider?: string; model?: string },
  threadId: string,
  lines: string[],
): Promise<Array<{ stepId: any; pid: number; logPath: string; error?: string }>> {
  const out: Array<{ stepId: any; pid: number; logPath: string; error?: string }> = [];
  const agentsDir = join(cwd, ".goo", "threads", threadId, "agents");
  mkdirSync(agentsDir, { recursive: true });

  for (const step of toDispatch) {
    const agentId = agentIds.get(String(step.id)) ?? `agent-${step.id}-${Date.now()}`;
    const { packet, packetGenerated } = packets.get(String(step.id)) ?? {
      packet: { wiki_paths: [] as string[], wiki_graph_packet_path: "", memory_layer: DEFAULT_MEMORY_LAYER },
      packetGenerated: false,
    };

    // step 契约（与阻塞路径保持一致的关键信息）
    const stepContract = [
      `- step_id: ${step.id}`,
      `- name: ${step.name ?? ""}`,
      `- type: ${step.type ?? "exec"} · role: ${step.subagent ?? "implementer"}/${step.task_agent ?? ""}`,
      `- memory_layer: ${packet.memory_layer}`,
      `- 产物必须写到: ${step.output ?? `(未指定)`}`,
      `- 完成时调用: auto_goo_update_step --step-id ${step.id} --complete --note "<结论>"`,
      `- 失败时调用: auto_goo_update_step --step-id ${step.id} --fail --error "<原因>"`,
    ];

    const task = buildSubagentTaskPrompt({
      role: step.subagent || "researcher",
      task: step.description || `执行 step #${step.id}: ${step.name}`,
      wiki_paths: packet.wiki_paths,
      wiki_graph_packet_path: packet.wiki_graph_packet_path,
      packetGenerated,
      memory_layer: packet.memory_layer,
      stepContract,
      wikiPathSizes: await measureWikiPaths(cwd, packet.wiki_paths),
      checkpoints: step.checkpoints,
      resumeState: step.resume_state,
    });

    const logPath = join(agentsDir, `step-${step.id}.jsonl`);
    try {
      const handle = spawnSubagentDetached({
        provider: subModel.provider,
        model: subModel.model,
        task,
        cwd,
        systemPrompt: [
          getRolePrompt(step.subagent || "researcher"),
          getTaskAgentPrompt(step.task_agent || ""),
        ].filter(Boolean).join("\n"),
        logPath,
      });

      // pid 落盘：heartbeat_check 据此判断存活
      writeFileSync(
        join(agentsDir, `step-${step.id}.json`),
        JSON.stringify({ ...handle, stepId: step.id, agentId }, null, 2),
        "utf-8",
      );

      updateStep(cwd, planPath, step.id, ["--heartbeat", "--progress", "8",
         "--note", `detached pid=${handle.pid} (${subModel.provider}/${subModel.model})`], "heartbeat");
      out.push({ stepId: step.id, pid: handle.pid, logPath });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      lines.push(`❌ #${step.id} 派发失败: ${msg}`);
      updateStep(cwd, planPath, step.id, ["--fail", "--error", `派发失败: ${msg}`], "fail");
      out.push({ stepId: step.id, pid: 0, logPath, error: msg });
    }
  }
  return out;
}

/**
 * 从 subagent 的 stderr 提取**有诊断价值**的一段。
 *
 * 为什么需要：pi 子进程非 0 退出时，真正的错误（provider 认证失败、限流、
 * 模型不存在、参数非法）只在 stderr 里。调用方若只记 "exit 143"，
 * 所有失败都长得一样 —— 实测把一个 provider 并发失败误诊为「tool 超时」，
 * 白做了一轮 detached 改造。
 *
 * 策略：
 *   - 过滤纯 JSON 事件行（--mode json 会把正常事件也写进 stderr 的场景）
 *   - 优先挑含 error / failed / unauthorized / rate / model 的行
 *   - 取最后 3 条有效行，总长 ≤ 300 字符
 */
export function excerptStderr(stderr: string | undefined | null): string {
  if (!stderr) return "";
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith("{"))     // 纯 JSON 事件不算错误文本
    .filter((l) => !/^\s*at\s/.test(l));   // 堆栈帧让位给消息
  if (lines.length === 0) return "";
  const interesting = lines.filter((l) =>
    /error|failed|unauthor|forbidden|rate.?limit|quota|invalid|not found|model/i.test(l),
  );
  const pick = (interesting.length > 0 ? interesting : lines).slice(-3);
  const text = pick.join(" / ");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

// ── runScheduleDetached：非阻塞调度（**当前未接入 full_cycle**）──────────────────
//
// ⚠ 状态：已实现 + 有测试，但**没有生产验证**，full_cycle 仍走阻塞的 runSchedule。
//
// 当初实现它的依据是一个错误诊断：以为 pi 对 tool call 有 2 分钟硬超时。
// 实测推翻了这个判断（同一 tool call 跑了 14.5 分钟、另一轮 2 小时 11 分）。
//
// 保留的理由：异步派发在原理上更合理（tool call 不该阻塞几十分钟），代码与
// 测试（__tests__/detached-dispatch.test.ts）完整，将来若确需可启用。
// 启用前**必须**先验证：
//   1. 孤儿进程清理（父 pi 会话退出后子进程仍在跑）
//   2. agents/step-N.jsonl 的事后解析与 usage 统计
//   3. 实时流式转发失效对用户观感的影响

/**
 * 与 {@link runSchedule} 相同的"找就绪步骤"逻辑，但派发方式是 detached spawn
 * 后立即返回，不等待子进程完成。
 *
 * 只保留调度必需的部分：校验 → 自动重试 → 算 ready → 槽位 → 派发。
 * 需要用户确认的高风险步骤在这里同样会弹确认框（快操作，不受 2 分钟限制）。
 */
async function runScheduleDetached(
  pi: ExtensionAPI,
  cwd: string,
  plan: Plan,
  planPath: string,
  ctx?: any,
): Promise<{ content: any[]; details: any }> {
  const lines: string[] = [];

  const validation = validatePlan(plan);
  if (!validation.valid) {
    const cycleNodes = findCycleNodes(plan);
    const cycleMsg = cycleNodes.length > 0
      ? `\n循环依赖: #${cycleNodes.join(", #")}（请检查 depends_on 是否存在环）`
      : "";
    return {
      content: [{ type: "text", text: `❌ plan 校验失败:\n${validation.issues.join("\n")}${cycleMsg}` }],
      details: { error: "plan_invalid", issues: validation.issues, cycleNodes },
    };
  }

  // 自动重试
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
      updateStep(cwd, planPath, step.id, ["--status", "pending", "--retry", "--note", retryNote(step, retryCount + 1)], "status");
    }
  }

  const completedIds = new Set(plan.steps.filter((s) => s.status === "completed").map((s) => String(s.id)));
  const running = plan.steps.filter((s) => s.status === "running");
  const failed = plan.steps.filter((s) => s.status === "failed");
  const ready = plan.steps.filter(
    (s) => s.status === "pending" && s.depends_on.every((d) => completedIds.has(String(d))),
  );

  const maxConcurrent = plan.execution?.max_concurrent ?? MAX_CONCURRENT_DEFAULT;
  const availableSlots = Math.max(0, maxConcurrent - running.length);
  const toDispatch = ready
    .filter((s) => s.execution_target !== "remote")
    .slice(0, availableSlots);

  const writeConflicts = detectWriteConflicts(toDispatch);
  if (writeConflicts.length > 0) {
    lines.push(...describeWriteConflicts(writeConflicts));
  }

  if (autoRetried > 0) lines.push(`🔄 自动重试 ${autoRetried} 个 failed 步骤`);
  if (failed.length > 0) lines.push(`💀 ${failed.length} 步失败: #${failed.map((s) => s.id).join(", #")}`);

  if (toDispatch.length === 0) {
    if (completedIds.size === plan.steps.length) {
      plan.status = "completed";
      plan.completed_at = new Date().toISOString();
      await savePlan(cwd, plan, planPath);
      lines.push(`✅ DAG 全部完成！${completedIds.size}/${plan.steps.length} 步`);
    } else if (running.length > 0) {
      lines.push(`⏳ ${running.length} 步运行中（detached），用 heartbeat_check 或 dag_status 查看进度`);
    } else if (ready.length > 0) {
      lines.push(`ℹ️ ${ready.length} 步就绪但无空槽（${running.length}/${maxConcurrent}）`);
    } else {
      lines.push(`⏳ 无可派发步骤（completed ${completedIds.size}/${plan.steps.length}，failed ${failed.length}）`);
    }
    if (ctx) updateStatusBar(ctx);
    return { content: [{ type: "text", text: lines.join("\n") }], details: { dispatched: [] } };
  }

  // agentId + start 标记
  const agentIds = new Map<string, string>();
  for (const step of toDispatch) {
    const agentId = `agent-${step.id}-${Date.now()}`;
    agentIds.set(String(step.id), agentId);
    updateStep(cwd, planPath, step.id, ["--start", "--progress", "5", "--agent-id", agentId], "start");
    updateStep(cwd, planPath, step.id, ["--precreate-log", "--note", `Detached dispatch to ${step.subagent} (${agentId})`], "note");
  }

  // wiki packet
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

  // 模型解析
  const execCfg = (await loadProjectConfig(cwd).catch(() => null))?.execution || {};
  const subModel = await resolveOrPromptSubagentModel(
    { provider: execCfg.subagent_provider, model: execCfg.subagent_model },
    ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
    ctx ?? null,
    (provider, model) => writeExecutionModelConfig(cwd, provider, model),
  );
  if (!subModel.provider || !subModel.model) {
    return {
      content: [{ type: "text", text: "blocked: Subagent 模型未配置或用户取消" }],
      details: { blocked: true, reason: "Subagent 模型未配置" },
    };
  }

  // 资源锁
  const lockCheck = checkPlanLocks(cwd, planPath);
  if (!lockCheck.ok) {
    const detail = describeConflicts(lockCheck.conflicts) || lockCheck.error || "未知冲突";
    for (const step of toDispatch) {
      updateStep(cwd, planPath, step.id, ["--block", "--error", `资源冲突：${detail}`], "block");
    }
    return {
      content: [{ type: "text", text: `blocked: 资源冲突，${toDispatch.length} 步未派发。\n${detail}` }],
      details: { blocked: true, conflicts: lockCheck.conflicts ?? [] },
    };
  }
  acquirePlanLocks(cwd, planPath);

  for (const step of toDispatch) {
    activityBus.begin(step.id, `${step.name ?? ""}${step.subagent ? ` · ${step.subagent}` : ""}`.trim());
  }

  // ★ detached 派发：毫秒级返回
  const handles = await dispatchDetached(cwd, plan, planPath, toDispatch, agentIds, packets, subModel, threadId, lines);

  for (const h of handles) {
    if (h.error) continue;
    lines.push(`▶️ #${h.stepId} 已派发 detached pid=${h.pid} → ${h.logPath.replace(`${cwd}/`, "")}`);
  }
  lines.push(`ℹ️ detached 模式：本工具已返回，子进程独立运行。用 auto_goo_execute action=heartbeat_check 或 auto_goo_dag_status 查看进度。`);

  if (ctx) updateStatusBar(ctx);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      dispatched: handles.filter((h) => !h.error).map((h) => ({ stepId: h.stepId, pid: h.pid, logPath: h.logPath })),
      failedDispatch: handles.filter((h) => h.error).map((h) => ({ stepId: h.stepId, error: h.error })),
      detached: true,
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
  //
  // 走**阻塞**的 runSchedule。曾被改成 runScheduleDetached，依据是一个错误诊断
  // （「pi tool call 有 2 分钟硬超时」）。实测同一 tool call 跑了 14 分 48 秒、
  // 后续一轮 2 小时 11 分 —— 阻塞路径完全可用，2 分钟限制并不作用于 extension
  // 的 execute()。真实根因是 provider 配置漂移（config 写死 yj，主模型已换
  // opencode-go，yj 在 4 并发下失败 → exit=143 被误读成 wrapper 问题）。
  //
  // detached 能力保留在 runScheduleDetached 里但**未接入**：它未经验证
  // （会引入孤儿进程、日志事后解析、实时流式丢失），启用前必须先实测。
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

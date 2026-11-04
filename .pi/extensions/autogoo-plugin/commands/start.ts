/**
 * AutoGoo-Plugin goo-start — 执行 DAG 计划
 *
 * 负责：加载 plan → context sync → 调度检查 → 进入执行循环
 * 注册自定义工具让 LLM 在运行时调用。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logWarn } from "../utils/log.js";
import { Type } from "typebox";
import { TEMPLATE_CONTEXT_SYNC_CONFIRM, TEMPLATE_WORKTREE } from "../constants.js";
import { loadPlan, savePlan, getCurrentThreadId, archiveOldPlan, type Plan, type Step } from "../utils/plan.js";
import { UPDATE_STEP_PY, GOO_STATUS_PY, projectPlanPath, loadProjectConfig, writeExecutionModelConfig } from "../utils/paths.js";
import { execPython } from "../utils/exec.js";
import { runSubagent, resolveSubagentModel, resolveOrPromptSubagentModel } from "../utils/subagent.js";
import { getRolePrompt, getTaskAgentPrompt } from "../utils/prompts.js";
import { uiSelect, uiInput, uiConfirm } from "../utils/ui.js";
import { updateStatusBar } from "../utils/status.js";
import { generateWikiPacket, buildSubagentTaskPrompt, heartbeatTick } from "../utils/dispatch.js";
import { existsSync } from "node:fs";
import { GOO_OBSERVE_PY } from "../utils/paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guardRender } from "../utils/tui-kit.js";
import { ObservePanel, type ObserveAction, type ObserveSnapshot, type ObserveStep } from "../utils/observe-panel.js";
import { checkPlanLocks, acquirePlanLocks, releasePlanLocks, describeConflicts } from "../utils/locks.js";
import { describeMessageContent, describeToolResult } from "../utils/tool-summary.js";
import { activityBus } from "../utils/activity.js";
import { getPi, isAgentBusy, claimWakeup, registerBusyTracking } from "../utils/pi-state.js";

// 共享状态（_pi / agentBusy / wakeupPending）已抽到 utils/pi-state.ts，
// 供拆分后的工具模块共用同一份实例。
export { setPi } from "../utils/pi-state.js";

export async function handleGooStart(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  
  // Load plan
  const plan = await loadPlan(cwd);
  if (!plan) {
    ctx.ui.notify("未找到计划。请先使用 /auto-goo:goo-plan 生成计划。", "warning");
    return;
  }

  // Check plan is approved
  if (plan.review?.status !== "approved") {
    ctx.ui.notify("计划尚未确认。请先审阅并确认计划。", "warning");
    return;
  }

  // Check for unfinished steps
  const pendingSteps = plan.steps.filter(s => s.status === "pending" || s.status === "running");
  if (pendingSteps.length === 0) {
    ctx.ui.notify("该计划的所有步骤已完成！", "success");
    return;
  }

  // Context sync check
  const syncChoice = await uiSelect(ctx, TEMPLATE_CONTEXT_SYNC_CONFIRM.header, TEMPLATE_CONTEXT_SYNC_CONFIRM.options);
  if (syncChoice === "sync") {
    // Allow user to add context updates
    const updates = await uiInput(ctx, "新增的上下文（方案、约束、验收标准等，可选）", "");
    if (updates?.trim()) {
      // P7：savePlan 前先归档旧 plan（在 context_digest 变更前对旧版本做快照）
      await archiveOldPlan(cwd, plan);
      plan.context_digest = plan.context_digest || { found: true, decisions: [], constraints: [], acceptance_criteria: [], open_questions: [] };
      plan.context_digest.decisions.push(`[${new Date().toISOString()}] ${updates}`);
      await savePlan(cwd, plan);
    }
  }

  // Update status bar
  await updateStatusBar(ctx);

  ctx.ui.notify(`开始执行！共 ${pendingSteps.length} 个待执行步骤`, "info");

  // Send execution prompt to LLM with the registered tools
  // （子进程模式跳过：Subagent 不应启动新的 DAG 执行）
  if (getPi() && process.env.AUTOGOO_SUBAGENT !== "1") {
    const pendingList = plan.steps
      .filter(s => s.status === "pending")
      .map(s => `  #${s.id} [${s.subagent}] ${s.name} — ${s.description.slice(0, 60)}`)
      .join("\n");

    getPi()!.sendUserMessage(
      `## AutoGoo-Plugin 执行指令\n\n` +
      `计划已确认，开始执行 DAG。共有 ${pendingSteps.length} 个待执行步骤。\n\n` +
      `### 执行方式\n` +
      `1. 使用 \`auto_goo_execute\` 全自动调度，或手动使用 \`auto_goo_dispatch\` 逐个派发\n` +
      `2. 使用 \`auto_goo_update_step\` 更新步骤状态和心跳\n` +
      `3. 使用 \`auto_goo_dag_status\` 查看进度\n\n` +
      `### 待执行步骤\n${pendingList}\n\n` +
      `请开始执行！`,
      { deliverAs: "followUp" }
    );
  }
}

// ── goo-status / goo-observe ────────────────────────────────────────────────
// 已拆到 commands/status.ts（原文件 861 行）。这里 re-export 保持既有 import 路径不变。
export { handleGooStatus, openObservePanel } from "./status.js";

// ── 执行类工具注册 ─────────────────────────────────────────────────────────
// 已拆到 commands/tools-execution.ts。re-export 保持既有 import 路径不变。
export { registerExecutionTools } from "./tools-execution.js";

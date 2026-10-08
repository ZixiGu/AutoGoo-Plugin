/**
 * AutoGoo-Plugin goo-start — 执行 DAG 计划
 *
 * 负责：加载 plan → context sync → 调度检查 → 进入执行循环
 * 注册自定义工具让 LLM 在运行时调用。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TEMPLATE_CONTEXT_SYNC_CONFIRM, TEMPLATE_WORKTREE } from "../constants.js";
import { loadPlan, savePlan, getCurrentThreadId, archiveOldPlan, type Plan, type Step } from "../utils/plan.js";
import { UPDATE_STEP_PY, GOO_STATUS_PY, projectPlanPath, loadProjectConfig, writeExecutionModelConfig } from "../utils/paths.js";
import { execPython } from "../utils/exec.js";
import { runSubagent, resolveSubagentModel, resolveOrPromptSubagentModel } from "../utils/subagent.js";
import { getRolePrompt, getTaskAgentPrompt } from "../utils/prompts.js";
import { uiSelect, uiInput } from "../utils/ui.js";
import { updateStatusBar } from "../utils/status.js";
import { generateWikiPacket, buildSubagentTaskPrompt, heartbeatTick } from "../utils/dispatch.js";
import { existsSync } from "node:fs";

// ── Global pi reference, set by setPi() from index.ts ───────────────────────
let _pi: ExtensionAPI | null = null;

// Agent 忙闲状态（2026-10-08）：
// sendUserMessage({deliverAs:"followUp"}) 的语义是「等当前 turn 结束后再投递」。
// 主 Agent 在一个 turn 内连续调度多个 step 时，每条完成通知都会排队，
// 结果全部堆到 turn 结束才一次性倾泻（实测现象）。
// 而子进程模式（2026-08-10）下主 Agent await runSubagent 后本来就会在同一 turn
// 继续推进，**根本不需要被唤醒** —— 该通知只对「Agent 已空闲但 plan 仍有剩余」
// 的场景有意义（如后台/异步回调完成）。
// 因此用 agent_start/agent_end 跟踪忙闲：忙时不入队，只做即时 UI 反馈。
let agentBusy = false;
let wakeupPending = false;

/** 注册 agent 忙闲跟踪（由 registerExecutionTools 调用一次）。 */
function registerBusyTracking(pi: any): void {
  try {
    pi.on("agent_start", () => {
      agentBusy = true;
      // 新 turn 开始 → 上一条唤醒已生效，允许下一次空闲时再唤醒
      wakeupPending = false;
    });
    pi.on("agent_end", () => {
      agentBusy = false;
    });
    // 会话替换/重启时复位，避免 agent_end 未触发导致忙标志卡在 true（那样会永久抑制唤醒）
    pi.on("session_start", () => {
      agentBusy = false;
      wakeupPending = false;
    });
  } catch (e) {
    console.warn("[AutoGoo-Plugin] agent 忙闲跟踪注册失败:", e);
  }
}

export function setPi(pi: ExtensionAPI): void {
  _pi = pi;
}

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
  if (_pi && process.env.AUTOGOO_SUBAGENT !== "1") {
    const pendingList = plan.steps
      .filter(s => s.status === "pending")
      .map(s => `  #${s.id} [${s.subagent}] ${s.name} — ${s.description.slice(0, 60)}`)
      .join("\n");

    _pi.sendUserMessage(
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

// ── goo-status handler ──────────────────────────────────────────────────────

export async function handleGooStatus(args: string, ctx: ExtensionContext): Promise<void> {
  await showStatus(ctx.cwd, ctx);
}

async function showStatus(cwd: string, ctx: ExtensionContext): Promise<void> {
  if (!existsSync(GOO_STATUS_PY)) {
    ctx.ui.notify("goo-status.py 未找到", "error");
    return;
  }

  try {
    const result = execPython(GOO_STATUS_PY, ["--plan", projectPlanPath(cwd)], cwd);
    ctx.ui.notify((result.stdout || "状态加载中...").slice(0, 500), "info");
    if (result.stderr) ctx.ui.notify(result.stderr.slice(0, 200), "warning");
  } catch (err: any) {
    ctx.ui.notify(`状态查询失败: ${err.message}`, "error");
  }
}

// ── Custom tools registration ───────────────────────────────────────────────

export function registerExecutionTools(pi: any, options: { skipDispatch?: boolean } = {}): void {
  // 子进程模式（AUTOGOO_SUBAGENT=1）跳过派发/调度工具，防止 Subagent 递归调度 DAG
  const skipDispatch = options.skipDispatch || process.env.AUTOGOO_SUBAGENT === "1";
  registerBusyTracking(pi);
  // Tool: auto_goo_update_step
  pi.registerTool({
    name: "auto_goo_update_step",
    label: "Update Step",
    description: "更新 DAG 步骤状态、进度、心跳。Subagent 和主 Agent 都可通过此工具更新步骤状态。",
    promptSnippet: "更新 DAG 步骤状态、进度和心跳",
    promptGuidelines: [
      "使用 auto_goo_update_step 更新步骤状态：--start 开始步骤，--heartbeat 更新进度，--complete 完成，--fail 标记失败，--interrupt 标记 wrapper 中断，--resume 从 interrupted/failed 恢复为 running，--pending 解除阻塞，--confirm 记录用户确认",
      "heartbeat 必须带 --note 描述进展，空 heartbeat 无效",
      "subagent wrapper 被信号杀/超时（exit 143/137）不等于任务失败：远程管线可能继续运行，用 --interrupt 标记后检查远程，确认真在运行再用 --resume 恢复",
    ],
    parameters: Type.Object({
      // C4 修复：历史 plan 用字符串 id（"s1"），新 plan 用数字，统一 Union 支持两者
      stepId: Type.Union([Type.Integer({ description: "步骤 ID" }), Type.String({ description: "步骤 ID" })]),
      action: Type.String({
        description: "操作类型",
        enum: ["start", "heartbeat", "complete", "fail", "interrupt", "resume", "block", "pending", "confirm"],
      }),
      progress: Type.Optional(Type.Integer({ description: "进度 0-100" })),
      note: Type.Optional(Type.String({ description: "进展描述（heartbeat 必填）" })),
      error: Type.Optional(Type.String({ description: "失败原因" })),
      agentId: Type.Optional(Type.String({ description: "Agent ID" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const args = [
        UPDATE_STEP_PY,
        "--plan", projectPlanPath(cwd),
        "--step-id", String(params.stepId),
      ];

      switch (params.action) {
        case "start":
          args.push("--start");
          if (params.agentId) { args.push("--agent-id", params.agentId); }
          if (params.progress !== undefined) { args.push("--progress", String(params.progress)); }
          break;
        case "heartbeat":
          args.push("--heartbeat");
          if (params.progress !== undefined) { args.push("--progress", String(params.progress)); }
          if (params.note) { args.push("--note", params.note); }
          break;
        case "complete":
          args.push("--complete");
          break;
        case "fail":
          args.push("--fail");
          if (params.error) { args.push("--error", params.error); }
          break;
        case "interrupt":
          // wrapper 中断（信号杀/超时）但任务本体未知：远程管线可能继续运行
          args.push("--interrupt");
          if (params.error) { args.push("--error", params.error); }
          break;
        case "resume":
          // 检查确认任务本体仍在运行后，从 interrupted/failed 恢复为 running
          args.push("--resume");
          if (params.note) { args.push("--note", params.note); }
          break;
        case "block":
          args.push("--block");
          if (params.error) { args.push("--error", params.error); }
          break;
        case "pending":
          // 解除 blocked（用户确认或其他原因恢复可派发）
          args.push("--status", "pending");
          break;
        case "confirm":
          // 记录用户确认（requires_user_confirm 步骤），blocked → pending 自动解锁
          args.push("--confirmed");
          if (params.note) { args.push("--note", params.note); }
          break;
      }

      try {
        const result = execPython(args[0], args.slice(1), cwd, { timeout: 30000 });
        await updateStatusBar(ctx);

        // ★ 检查 update-step.py 是否真正成功（修复 2026-08-10）：
        //   之前不检查 exitCode，step id 不匹配（如数字 2 vs 字符串 "s2"）时
        //   update 失败仍发"step X 已完成"唤醒消息 → 用户看到"声称完成但状态没更新"。
        if (result.exitCode !== 0) {
          const errMsg = (result.stderr || result.stdout || "update-step.py 失败").trim().slice(0, 200);
          console.warn(`[AutoGoo-Plugin] update_step ${params.action} 失败: ${errMsg}`);
          return {
            content: [{ type: "text", text: `❌ 步骤更新失败 (exit=${result.exitCode}): ${errMsg}` }],
            details: { stepId: params.stepId, action: params.action, error: errMsg },
            isError: true,
          };
        }

        // ★ Subagent 完成任务后唤醒主 Agent 继续调度（修复 2026-08-06）：
        //   主 Agent 通过 auto_goo_dispatch 派发时返回 terminate:true 让当前 turn 结束、
        //   followUp 队列被消费（Subagent 任务执行）。Subagent 完成本步后，
        //   若 plan 中仍有 pending/running 步骤，必须 sendUserMessage 唤醒主 Agent
        //   继续调度循环；否则 agent 会停在空闲状态，DAG 不再推进。
        //   ★ 子进程模式（2026-08-10）：Subagent 在独立 pi 子进程内执行，
        //   完成由父进程 runSubagent 的 close 事件感知，无需也**不应**在子进程内唤醒
        //   （否则子进程 agent 会尝试自己调度 DAG → 递归）。
        if ((params.action === "complete" || params.action === "fail" || params.action === "block" || params.action === "pending" || params.action === "confirm") && process.env.AUTOGOO_SUBAGENT !== "1") {
          try {
            const plan = await loadPlan(cwd);
            const remainingSteps = (plan?.steps ?? []).filter(
              (s: any) => s.status === "pending" || s.status === "running",
            );
            if (remainingSteps.length > 0) {
              const pendingIds = remainingSteps
                .filter((s: any) => s.status === "pending")
                .map((s: any) => `#${s.id}`)
                .join(", ");
              const verb = params.action === "complete" ? "完成" : params.action;

              if (agentBusy) {
                // 主 Agent 正在同一 turn 内继续调度 → 不入队（否则会堆到 turn 结束一次性发送）。
                // 只在 UI 上即时反馈进度，让执行过程可见。
                const level = params.action === "complete" ? "info" : "warning";
                ctx.ui.notify(
                  `✔ step ${params.stepId} ${verb}；剩余 ${remainingSteps.length} 步${pendingIds ? `（待执行 ${pendingIds}）` : ""}`,
                  level,
                );
              } else if (_pi && !wakeupPending) {
                // Agent 已空闲但 plan 仍有剩余：这才是唤醒真正有意义的场景。
                // wakeupPending 去重，避免同一段空闲期重复入队多条相同的唤醒消息。
                wakeupPending = true;
                _pi.sendUserMessage(
                  `[AutoGoo-Plugin] step ${params.stepId} 已${verb}。` +
                  `还有 ${remainingSteps.length} 步待执行${pendingIds ? `（${pendingIds}）` : ""}。请调用 auto_goo_execute 继续调度 DAG。`,
                  { deliverAs: "followUp" },
                );
              }
            }
          } catch (e: any) {
            console.warn("[AutoGoo-Plugin] update_step 唤醒主 Agent 失败:", e?.message ?? String(e));
          }
        }

        return {
          content: [{ type: "text", text: result.stdout || "步骤已更新" }],
          details: { stepId: params.stepId, action: params.action },
        };
      } catch (err: any) {
        await updateStatusBar(ctx);
        return {
          content: [{ type: "text", text: `更新失败: ${err.message}` }],
          details: { stepId: params.stepId, action: params.action, error: err.message },
          isError: true,
        };
      }
    },
  });

  // Tool: auto_goo_dag_status
  pi.registerTool({
    name: "auto_goo_dag_status",
    label: "DAG Status",
    description: "查看 DAG 计划的状态仪表盘，包括所有步骤的进度、心跳和告警。",
    promptSnippet: "查看 DAG 步骤的状态仪表盘",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      try {
        const result = execPython(GOO_STATUS_PY, ["--plan", projectPlanPath(cwd)], cwd);
        return {
          content: [{ type: "text", text: result.stdout || "无状态数据" }],
          details: { output: result.stdout },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `状态查询失败: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // Tool: auto_goo_dispatch
  if (!skipDispatch) {
  pi.registerTool({
    name: "auto_goo_dispatch",
    label: "Dispatch Subagent",
    description: "派发 Subagent 执行 DAG 步骤。通过向对话发送用户消息触发模型处理该步骤。",
    promptSnippet: "派发 Subagent 执行 DAG 步骤",
    promptGuidelines: [
      "使用 auto_goo_dispatch 将步骤派发给 Subagent 执行。派发前先调用 auto_goo_update_step --start 写首个 heartbeat。",
      "派发完成后 Subagent 的第一动作是调用 auto_goo_update_step --heartbeat --progress 15 --note '<已开工>'",
    ],
    parameters: Type.Object({
      // C4 修复：stepId 支持 number|string（历史 plan 字符串 id 如 "s1"）
      stepId: Type.Union([Type.Integer({ description: "步骤 ID" }), Type.String({ description: "步骤 ID" })]),
      role: Type.String({
        description: "Subagent 角色",
        enum: ["researcher", "collector", "implementer", "optimizer", "evaluator", "reviewer", "auditor", "recorder"],
      }),
      task: Type.String({ description: "步骤任务描述" }),
      taskAgent: Type.Optional(Type.String({
        description: "具体任务 agent",
        enum: ["data-collector", "usage-collector", "session-aggregator", "wiki-gatherer", "log-analyst", "document-analyst", "feature-builder", "test-runner", "code-reviewer", "evidence-auditor", "wiki-curator"],
      })),
      stepType: Type.Optional(Type.String({
        description: "步骤类型（影响默认 wiki_paths / memory_layer）",
        enum: ["research", "exec", "optimize", "eval", "review", "audit", "archive"],
      })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;

      // 1. Pre-create log skeleton via update-step.py
      try {
        const planPath = projectPlanPath(cwd);
        execPython(
          UPDATE_STEP_PY,
          ["--plan", planPath, "--step-id", String(params.stepId), "--precreate-log", "--note", `Dispatched to ${params.role}`],
          cwd,
          { timeout: 15000 },
        );
      } catch {}

      // 2. Build Subagent prompt
      const rolePrompt = getRolePrompt(params.role);
      const taskPrompt = params.taskAgent ? getTaskAgentPrompt(params.taskAgent) : "";

      // 2.1+2.2 Compute dispatch packet + generate wiki graph packet（共享逻辑）
      //     P1：project slug 用 config archive.project_slug（fallback basename），
      //     wiki_paths 的 {slug} 与 wiki-graph-assist.py --project-slug 用同一值，
      //     否则 glob 匹配不到真实 wiki/projects/{slug}/ 目录。
      const activeThreadId = (await getCurrentThreadId(cwd)) ?? "current";
      const { packet, packetGenerated } = await generateWikiPacket(
        cwd,
        { id: params.stepId, type: params.stepType || "exec" },
        params.task || `step ${params.stepId} dispatch`,
        activeThreadId,
      );

      const prompt = buildSubagentTaskPrompt({
        role: params.role,
        task: params.task,
        rolePrompt,
        taskPrompt,
        wiki_paths: packet.wiki_paths,
        wiki_graph_packet_path: packet.wiki_graph_packet_path,
        packetGenerated,
        memory_layer: packet.memory_layer,
      });

      // 3. Spawn 独立 pi 子进程执行 Subagent 任务（pi 子进程模式，2026-08-10 迁移）。
      //    替代旧方案 sendUserMessage(followUp) + terminate：
      //    - 上下文隔离（--no-session）
      //    - 不依赖 followUp 队列（根治调度循环饥饿）
      //    - usage 统计（解析 message_end 事件）
      const planPath = projectPlanPath(cwd);
      const agentId = `agent-${params.stepId}-${Date.now()}`;

      // 保活进度显示（2026-10-08）：子进程可能长时间思考不产生事件，
      // 若只在有消息时才 onUpdate，工具输出会长时间静止，用户会以为卡死。
      // 因此：(1) 派发时立刻回一行；(2) 每 8s 周期性回一行 elapsed + 最近活动；
      //      (3) 同步写入 TUI 状态栏；结束时清理。
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
      const roleLabel = `${params.role}${params.taskAgent ? "/" + params.taskAgent : ""}`;

      // 保活心跳（P2/P16，共享 heartbeatTick）：
      // - 不传 --progress：避免把 Subagent 已更新的 progress 覆盖回 0
      // - 写前 loadPlan 检查 step.status === 'running'，非 running 直接跳过
      // config.execution.subagent_model / subagent_provider：显式指定 Subagent 模型；
      // 未设置时用结构化 UI 询问用户是否配置（resolveOrPromptSubagentModel），
      // 配置写入 .goo/config.json；用户取消或仍解析不到则 blocked，绝不静默用 pi 全局默认。
      const execCfg = (await loadProjectConfig(cwd).catch(() => null))?.execution || {};
      const subModel = await resolveOrPromptSubagentModel(
        { provider: execCfg.subagent_provider, model: execCfg.subagent_model },
        ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
        ctx,
        (provider, model) => writeExecutionModelConfig(cwd, provider, model),
      );
      if (!subModel.provider || !subModel.model) {
        ctx.ui.notify("已取消本次 Subagent 派发（未配置 subagent 模型）", "warning");
        return { content: [{ type: "text", text: "blocked: Subagent 模型未配置或用户取消，未派发本 step；请配置 execution.subagent_provider+subagent_model 后重试" }] };
      }
      emit(`▶ step ${params.stepId} 派发中 · ${roleLabel} · ${subModel.provider}/${subModel.model} · [00:00]`);
      setProgressStatus(`▶ #${params.stepId} ${roleLabel} 00:00`);
      const progressTimer = setInterval(() => {
        emit(`⏳ step ${params.stepId} 运行中 [${fmtElapsed()}] · 事件 ${eventCount} · ${lastActivity}`);
        setProgressStatus(`⏳ #${params.stepId} ${fmtElapsed()} · ${lastActivity.slice(0, 40)}`);
      }, 8000);

      let subagentResult;
      try {
        subagentResult = await runSubagent({
        systemPrompt: [rolePrompt, taskPrompt].filter(Boolean).join("\n"),
        task: prompt,
        cwd,
        signal: _signal,
        provider: subModel.provider,
        model: subModel.model,
        onTick: () => void heartbeatTick(cwd, planPath, params.stepId, agentId),
        // pi 流式观察（2026-08-14）：Subagent 子进程 JSON 流 → 工具 onUpdate → TUI 实时显示
        // 2026-10-08：增加「保活进度条」——子进程长时间思考时也会周期性上报 elapsed，
        // 否则工具输出长时间静止，用户会误以为卡死。
        onMessage: (message: any) => {
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
              eventCount += 1;
              lastActivity = text.replace(/\s+/g, " ").slice(0, 80);
              emit(`  #${params.stepId} [${fmtElapsed()}] ▶ ${text.slice(0, 300)}`);
            }
          } catch {
            /* 流式转发失败不阻塞 */
          }
        },
        timeoutMs: (params as any).timeoutMs ?? 30 * 60 * 1000,
        });
      } finally {
        clearInterval(progressTimer);
        setProgressStatus(undefined);
      }

      // 4. 兕底状态：子进程退出后 step 可能已被 Subagent 调 auto_goo_update_step
      //    标记 complete/fail；若仍 running，根据退出码兕底标记。
      const planAfter = await loadPlan(cwd);
      const stepAfter = planAfter?.steps.find((s: Step) => String(s.id) === String(params.stepId));
      let statusNote = "";
      if (stepAfter?.status === "running") {
        // ⚠ wrapper 被信号杀（143/137）/超时/用户中断 不等于任务失败：
        // 子进程可能已写完产物，必须标 interrupted（实例：step 1 已产出 3 个文件却被标 failed）。
        const res = subagentResult;
        const killedBySignal =
          res.exitCode === 143 || res.exitCode === 137 ||
          res.stopReason === "SIGTERM" || res.stopReason === "SIGKILL";
        const ok =
          res.exitCode === 0 && !res.errorMessage && !res.timedOut && !res.aborted && !killedBySignal;
        if (ok) {
          execPython(
            UPDATE_STEP_PY,
            ["--plan", planPath, "--step-id", String(params.stepId), "--complete", "--note", `Subagent exit 0（兜底标记完成）`],
            cwd,
            { timeout: 10000 },
          );
          statusNote = "（兜底完成）";
        } else if (res.aborted || res.timedOut || killedBySignal) {
          const reason = res.aborted
            ? "派发被中断（用户 Esc / 会话中断）"
            : res.timedOut
              ? "派发超时"
              : `wrapper 被信号杀（exit ${res.exitCode}）`;
          execPython(
            UPDATE_STEP_PY,
            ["--plan", planPath, "--step-id", String(params.stepId), "--interrupt",
             "--note", `${reason}；子进程已终止，产物可能已部分生成，检查后再 resume 或重派`],
            cwd,
            { timeout: 10000 },
          );
          statusNote = `，${reason} → step 标记为 interrupted（非失败）`;
        } else {
          execPython(
            UPDATE_STEP_PY,
            ["--plan", planPath, "--step-id", String(params.stepId), "--fail", "--error", res.errorMessage || `subagent exit ${res.exitCode}`],
            cwd,
            { timeout: 10000 },
          );
          statusNote = "（兜底失败）";
        }
      }

      await updateStatusBar(ctx);

      const usage = subagentResult.usage;
      const usageLine =
        usage.turns > 0
          ? ` · usage: ${usage.turns}t ↑${usage.input} ↓${usage.output} $${usage.cost.toFixed(4)}`
          : "";
      const output = subagentResult.output.trim();
      const outputLine = output
        ? `\n\n输出: ${output.slice(0, 500)}${output.length > 500 ? "…" : ""}`
        : "";

      // 中断/超时不是失败，不要用 ✅ 误导。
      const interrupted = !!(
        subagentResult.aborted || subagentResult.timedOut ||
        subagentResult.exitCode === 143 || subagentResult.exitCode === 137
      );

      return {
        content: [
          {
            type: "text",
            text: `${interrupted ? "⏸" : subagentResult.exitCode === 0 ? "✅" : "❌"} ` +
              (interrupted
                ? `step ${params.stepId} 派发中断${statusNote} (exit=${subagentResult.exitCode}, ${subagentResult.model ?? "default"}, 耗时 ${fmtElapsed()})`
                : `step ${params.stepId} 子进程执行完成${statusNote} (exit=${subagentResult.exitCode}, ${subagentResult.model ?? "default"}, 耗时 ${fmtElapsed()})${usageLine}`) +
              (interrupted
                ? "\n\n下一步：先检查该 step 声明的产物是否已生成；已生成→auto_goo_update_step --complete，未完成→--resume 或重派。中断不是失败，不要直接 --fail。"
                : "") +
              outputLine,
          },
        ],
        details: {
          stepId: params.stepId,
          role: params.role,
          taskAgent: params.taskAgent,
          interrupted,
          subagent: {
            exitCode: subagentResult.exitCode,
            timedOut: subagentResult.timedOut ?? false,
            aborted: subagentResult.aborted ?? false,
            stopReason: subagentResult.stopReason,
            errorMessage: subagentResult.errorMessage,
            usage: subagentResult.usage,
            model: subagentResult.model,
          },
        },
      };
    },
  });

  } // ── end auto_goo_dispatch (skipDispatch) ──

  // Tool: auto_goo_prepare_dispatch
  if (!skipDispatch) {
  pi.registerTool({
    name: "auto_goo_prepare_dispatch",
    label: "Prepare Dispatch",
    description: "为派发 Subagent 做准备：更新 step 状态为 running、写首个 heartbeat、创建 log 骨架。",
    promptSnippet: "为派发 Subagent 做准备：start step + precreate log",
    parameters: Type.Object({
      // C4 修复：stepId 支持 number|string（历史 plan 字符串 id 如 "s1"）
      stepId: Type.Union([Type.Integer({ description: "步骤 ID" }), Type.String({ description: "步骤 ID" })]),
      role: Type.String({ description: "Subagent 角色" }),
      agentId: Type.Optional(Type.String({ description: "Agent ID" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const planPath = projectPlanPath(cwd);
      const stepId = String(params.stepId);
      const agentId = params.agentId || `agent-${params.stepId}-${Date.now()}`;

      const results: string[] = [];

      // Start step
      try {
        const r1 = execPython(
          UPDATE_STEP_PY,
          ["--plan", planPath, "--step-id", stepId, "--start", "--progress", "5", "--agent-id", agentId],
          cwd,
          { timeout: 15000 },
        );
        results.push(`start: ${r1.stdout?.slice(0, 100)}`);
      } catch (err: any) {
        results.push(`start error: ${err.message}`);
      }

      // Precreate log
      try {
        const r2 = execPython(
          UPDATE_STEP_PY,
          ["--plan", planPath, "--step-id", stepId, "--precreate-log", "--note", `Main Agent preparing dispatch to ${params.role} (${agentId})`],
          cwd,
          { timeout: 15000 },
        );
        results.push(`log: ${r2.stdout?.slice(0, 100)}`);
      } catch (err: any) {
        results.push(`log error: ${err.message}`);
      }

      await updateStatusBar(ctx);
      return {
        content: [{ type: "text", text: `Prepared step ${params.stepId}:\n${results.join("\n")}` }],
        details: { stepId: params.stepId, agentId, results },
      };
    },
  });

  } // ── end auto_goo_prepare_dispatch (skipDispatch) ──

  // Tool: auto_goo_pending_steps
  pi.registerTool({
    name: "auto_goo_pending_steps",
    label: "Pending Steps",
    description: "查看当前 plan 中待执行的就绪步骤（所有依赖已完成的 pending 步骤）。",
    promptSnippet: "查看 DAG 中可执行的就绪步骤列表",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const plan = await loadPlan(cwd);
      if (!plan) {
        return { content: [{ type: "text", text: "未找到 plan" }], details: {} };
      }

      const completedIds = new Set(
        plan.steps.filter(s => s.status === "completed").map(s => String(s.id)),
      );

      const pending = plan.steps.filter(s => {
        if (s.status !== "pending") return false;
        return s.depends_on.every(d => completedIds.has(String(d)));
      });

      if (pending.length === 0) {
        return { content: [{ type: "text", text: "没有就绪步骤。所有步骤已完成或依赖未满足。" }], details: {} };
      }

      const lines = pending.map(s =>
        `  #${s.id} [${s.subagent}] ${s.name} — ${s.description.slice(0, 60)}`
      );
      return {
        content: [{ type: "text", text: `就绪步骤 (${pending.length}):\n${lines.join("\n")}` }],
        details: { pending: pending.map(s => ({ id: s.id, name: s.name, subagent: s.subagent })) },
      };
    },
  });
}

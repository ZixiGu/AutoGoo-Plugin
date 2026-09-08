/**
 * AutoGoo-Plugin Pi Extension v0.5.1 — 主入口
 *
 * DAG 驱动的多智能体编排框架，从 Claude Code 插件迁移。
 *
 * 功能：
 * - 14 个命令（/auto-goo:goo-xxx 和 /goo-xxx 两种方式）
 * - 13 个自定义工具（执行、调度、SSH、worktree、状态管理）
 * - ctx.ui 替代 AskUserQuestion 进行交互
 * - Python 脚本原样复用
 * - 自动 session 恢复检测
 * - DAG 自动调度引擎
 * - Git worktree 执行隔离
 * - 远程服务器 SSH 集成
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Commands
import { handleGooInit } from "./commands/init.js";
import { handleGooPlan } from "./commands/plan.js";
import { handleGooBrainstorm } from "./commands/brainstorm.js";
import {
  handleGooStart,
  handleGooStatus,
  registerExecutionTools,
  setPi as setStartPi,
} from "./commands/start.js";
import {
  handleGooObserve,
  handleGooPublish,
  handleGooResearch,
  handleGooUsage,
  handleGooUsageAnalyse,
  handleGooDailyReport,
  handleGooImprove,
  handleGooBenchmark,
  handleGooContinue,
  setPi as setOtherPi,
} from "./commands/other.js";
import {
  handleGooChat,
  handleGooPair,
  handleGooUnpair,
  handleGooChatList,
  handleGooChatRead,
  handleGooAlias,
  setPi as setChatPi,
} from "./commands/chat.js";

// Tools
import { registerExecuteTool } from "./tools/execute.js";
import { registerSshTools } from "./tools/ssh.js";
import { registerMonitorBgTools } from "./tools/monitor-bg.js";
import { registerWorktreeTools } from "./tools/worktree.js";

// Utils
import { REPO_ROOT, isRepoValid } from "./utils/paths.js";
import { AUTOGOO_PLUGIN_SYSTEM_PROMPT } from "./constants.js";

// ── Command routing table ───────────────────────────────────────────────────

interface CommandEntry {
  description: string;
  handler: (args: string, ctx: any) => Promise<void>;
}

const COMMANDS: Record<string, CommandEntry> = {
  "goo-init": {
    description: "初始化 AutoGoo-Plugin 配置（用户级或项目级）",
    handler: handleGooInit,
  },
  "goo-brainstorm": {
    description: "目标不明确时通过头脑风暴生成候选目标",
    handler: handleGooBrainstorm,
  },
  "goo-plan": {
    description: "生成 DAG 执行计划（召回 wiki → 拆解 → 审阅）",
    handler: handleGooPlan,
  },
  "goo-start": {
    description: "执行 DAG 计划（加载 → context sync → 调度）",
    handler: handleGooStart,
  },
  "goo-continue": {
    description: "恢复中断的执行（检测僵尸步骤 → 继续调度）",
    handler: handleGooContinue,
  },
  "goo-status": {
    description: "查看工作流状态仪表盘",
    handler: handleGooStatus,
  },
  "goo-observe": {
    description: "后台观察运行中的步骤和心跳",
    handler: handleGooObserve,
  },
  "goo-publish": {
    description: "发布工作流为静态 HTML 站点",
    handler: handleGooPublish,
  },
  "goo-research": {
    description: "启动研究任务（论文深读、代码搜索等）",
    handler: handleGooResearch,
  },
  "goo-usage": {
    description: "查看 token/usage 统计",
    handler: handleGooUsage,
  },
  "goo-usage-analyse": {
    description: "分析 token 消耗并生成降本方案",
    handler: handleGooUsageAnalyse,
  },
  "goo-daily-report": {
    description: "生成日报/周报并归档到 Goo-wiki",
    handler: handleGooDailyReport,
  },
  "goo-improve": {
    description: "AutoGoo-Plugin 自改进审查",
    handler: handleGooImprove,
  },
  "goo-benchmark": {
    description: "启动性能评测与优化迭代",
    handler: handleGooBenchmark,
  },
  "goo-chat": {
    description: "跨 session 发送消息（先配对：同 thread 自动 / /goo-pair 显式）",
    handler: handleGooChat,
  },
  "goo-chat-read": {
    description: "拉取未读消息并注入（可选 [target] 只拉取指定 session 的）",
    handler: handleGooChatRead,
  },
  "goo-pair": {
    description: "显式配对两个 session（可用别名互发消息）",
    handler: handleGooPair,
  },
  "goo-unpair": {
    description: "解除两个 session 的显式配对",
    handler: handleGooUnpair,
  },
  "goo-chat-list": {
    description: "列出会话注册表、配对和本会话未读消息",
    handler: handleGooChatList,
  },
  "goo-alias": {
    description: "自定义本 session 别名",
    handler: handleGooAlias,
  },
};

// ── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Share pi reference with command handlers ──────────────────────────────
  setStartPi(pi);
  setOtherPi(pi);
  setChatPi(pi);

  // ── Validate AutoGoo-Plugin repo ─────────────────────────────────────────────────
  if (!isRepoValid()) {
    console.warn(
      "[AutoGoo-Plugin] ⚠️ AutoGoo-Plugin repo structure not found at",
      REPO_ROOT,
      "- some features may not work"
    );
  }

  // ── Input interception for /auto-goo: commands ────────────────────────────
  //
  // Catches /auto-goo:goo-xxx patterns before they reach the LLM.
  // Routes to the appropriate TypeScript handler.

  pi.on("input", async (event, ctx) => {
    const text = event.text.trim();
    const match = text.match(/^\/auto-goo:(goo-\S+)(?:\s+(.*))?$/s);
    if (!match) return { action: "continue" };

    const cmdName = match[1];
    const args = (match[2] || "").trim();
    const cmd = COMMANDS[cmdName];

    if (!cmd) {
      ctx.ui.notify(`[AutoGoo-Plugin] 未知命令: ${cmdName}`, "warning");
      return { action: "handled" };
    }

    try {
      await cmd.handler(args, ctx);
    } catch (err: any) {
      ctx.ui.notify(`[AutoGoo-Plugin] ${cmdName} 执行失败: ${err.message}`, "error");
    }
    return { action: "handled" };
  });

  // ── Register short commands (without /auto-goo: prefix) ───────────────────
  //
  // All 14 commands are also available as /goo-xxx for convenience.

  for (const [name, entry] of Object.entries(COMMANDS)) {
    pi.registerCommand(name, {
      description: entry.description,
      handler: async (args, ctx) => {
        await entry.handler(args, ctx);
      },
    });
  }

  // ── Register execution tools ──────────────────────────────────────────────
  //
  // Core DAG tools that the LLM calls during execution.

  registerExecutionTools(pi);
  // 子进程模式（AUTOGOO_SUBAGENT=1）：Subagent 在独立 pi 子进程内执行，
  // 不注册自动调度工具 auto_goo_execute，防止 Subagent 递归调度 DAG。
  const isSubagent = process.env.AUTOGOO_SUBAGENT === "1";
  if (!isSubagent) {
    registerExecuteTool(pi);
  }

  // ── Register SSH remote execution tools ───────────────────────────────────
  // 子进程模式跳过：Subagent 不应执行远程服务器操作。
  if (!isSubagent) {
    registerSshTools(pi);
  }

  // ── Register background monitor tools ─────────────────────────────────────
  // 后台监视（bg/poll/stop）与 ssh 工具同生命周期：仅主进程注册。
  if (!isSubagent) {
    registerMonitorBgTools(pi);
  }

  // ── Register worktree isolation tools ─────────────────────────────────────
  // 子进程模式跳过：worktree 由主进程管理。
  if (!isSubagent) {
    registerWorktreeTools(pi);
  }

  // ── Register utility tools ────────────────────────────────────────────────

  // auto_goo_ask_user — 结构化交互（替代 AskUserQuestion）
  // 子进程模式跳过：Subagent 无法向用户提问（无人应答）。
  if (!isSubagent) {
  pi.registerTool({
    name: "auto_goo_ask_user",
    label: "Ask User",
    description: "向用户提问并获取结构化选择。用选择/确认/输入三种模式替代普通文本提问。",
    promptSnippet: "向用户提问获取选择或输入",
    promptGuidelines: [
      "使用 auto_goo_ask_user 向用户提问，提供结构化选项让用户选择，而不是用普通文本要求用户回复编号。",
    ],
    parameters: {
      type: "object",
      properties: {
        header: { type: "string", description: "问题标题" },
        question: { type: "string", description: "问题内容" },
        type: { type: "string", enum: ["select", "confirm", "input"], description: "交互类型" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" },
              value: { type: "string" },
            },
          },
          description: "选择类型时的选项列表",
        },
        defaultValue: { type: "string", description: "输入类型时的默认值" },
      },
      required: ["header", "question", "type"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      let result: any;
      switch (params.type) {
        case "select": {
          // Convert objects to string labels for Pi's select API
          const options = (params.options || []).map((o: any) =>
            typeof o === "string" ? o : (o.label || String(o))
          );
          const label = await ctx.ui.select(`${params.header}\n${params.question}`, options);
          // Map back to value if input was objects with label/value
          if (label && params.options?.[0]?.value !== undefined) {
            const found = params.options.find((o: any) => o.label === label);
            result = found?.value ?? label;
          } else {
            result = label;
          }
          break;
        }
        case "confirm":
          result = await ctx.ui.confirm(params.header, params.question);
          break;
        case "input":
          result = await ctx.ui.input(params.question, params.defaultValue || "");
          break;
      }
      return {
        content: [{ type: "text", text: `用户回答: ${String(result ?? "(无回答)")}` }],
        details: { userResponse: result },
      };
    },
  });
  } // ── end auto_goo_ask_user (子进程跳过) ──

  // auto_goo_shell — 安全执行 shell 命令
  pi.registerTool({
    name: "auto_goo_shell",
    label: "Shell",
    description: "在项目根目录执行 shell 命令，返回输出。用于执行 Python 脚本、Git 操作等。",
    promptSnippet: "在项目根执行 shell 命令",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令" },
        timeout: { type: "integer", description: "超时秒数（默认 30）" },
        description: { type: "string", description: "命令用途说明（可选，用于日志）" },
      },
      required: ["command"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const approved = await ctx.ui.confirm(
        "AutoGoo Shell",
        `${params.description || "执行项目命令"}\n\n${params.command}`,
      );
      if (!approved) {
        return {
          content: [{ type: "text", text: "用户取消了 shell 命令。" }],
          details: { exitCode: null, cancelled: true },
        };
      }
      const { execShell } = await import("./utils/exec.js");
      const timeoutMs = Math.max(1, Number(params.timeout ?? 30)) * 1000;
      const result = execShell(params.command, ctx.cwd, { timeout: timeoutMs });
      const output = (result.stdout || result.stderr || "(no output)").slice(0, 10000);
      return {
        content: [{ type: "text", text: output }],
        details: { exitCode: result.exitCode, truncated: (result.stdout?.length ?? 0) > 10000 },
      };
    },
  });

  // ── Session hooks ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Detect uncompleted AutoGoo-Plugin plan
    try {
      // ── 跨 session 对话：注册本会话 + 未读通知（内容不自动注入，按需拉取） ──
      // 失败不阻断启动（catch 包裹）
      try {
        const { registerSession, countUnread, peekMailbox } = await import("./utils/chat.js");
        const sessionId = ctx.sessionManager.getSessionId();
        const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
        await registerSession(ctx.cwd, sessionId, sessionFile);
        const unread = await countUnread(ctx.cwd, sessionId);
        if (unread > 0) {
          // 只通知数量 + 来源列表，内容绝不注入 LLM 上下文
          const msgs = await peekMailbox(ctx.cwd, sessionId);
          const sources = [
            ...new Set(msgs.map((m) => `${m.fromAlias || m.from.slice(0, 8)}@${m.fromProject || ""}`)),
          ];
          const listed = sources.slice(0, 3).join(", ");
          const more = sources.length > 3 ? ` 等 ${sources.length} 个会话` : "";
          ctx.ui.notify(
            `[AutoGoo-Plugin] 📨 你有 ${unread} 条未读消息（来自 ${listed}${more}），用 /goo-chat-list 查看、/goo-chat-read 拉取`,
            "info",
          );
        }
      } catch (e) {
        console.error("[AutoGoo-Plugin] session_start chat hook error:", e);
      }

      const { loadPlan } = await import("./utils/plan.js");
      const plan = await loadPlan(ctx.cwd);
      if (plan) {
        const pending = plan.steps?.filter(
          (s: any) => s.status === "pending" || s.status === "running",
        ).length || 0;
        const blocked = plan.steps?.filter((s: any) => s.status === "blocked").length || 0;
        if (pending > 0 || blocked > 0) {
          ctx.ui.notify(
            `[AutoGoo-Plugin] 📋 检测到未完成计划 (${pending} 待执行, ${blocked} 阻塞)。` +
            `使用 /goo-status 查看详情，/goo-continue 恢复执行。`,
            "info",
          );
        }
        // Update status bar
        try {
          const { updateStatusBar } = await import("./utils/status.js");
          await updateStatusBar(ctx);
        } catch (e) {
          console.error("[AutoGoo-Plugin] session_start updateStatusBar error:", e);
        }
      }
    } catch (e) {
      console.error("[AutoGoo-Plugin] session_start outer error:", e);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Clear status bar — it belongs to this session
    try {
      const { clearStatusBar } = await import("./utils/status.js");
      clearStatusBar(ctx);
    } catch {}

    // Worktrees are never removed automatically: they may contain unmerged work.
  });

  // ── Inject AutoGoo-Plugin system prompt ─────────────────────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    return {
      systemPrompt: event.systemPrompt + AUTOGOO_PLUGIN_SYSTEM_PROMPT,
    };
  });

  // ── Startup banner ────────────────────────────────────────────────────────
  // Use stderr to avoid interfering with Pi's TUI rendering
  process.stderr.write(`[AutoGoo-Plugin] ✅ 扩展已加载 (v0.5.1)\n`);
}

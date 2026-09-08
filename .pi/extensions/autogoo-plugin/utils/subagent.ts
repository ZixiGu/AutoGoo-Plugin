/**
 * Pi 子进程 Subagent 执行器 — 迁移自「会话内 followUp 注入」。
 *
 * 动机（2026-08-10 迁移）：
 * - 旧方案用 pi.sendUserMessage(prompt, { deliverAs: "followUp" }) 注入任务，
 *   依赖主 Agent turn 结束消费 followUp 队列；调度循环持续调用工具时
 *   followUp 永不投递（饥饿），实测 auto_goo_execute 自动派发多次失败。
 * - 新方案 spawn 独立 pi 子进程（--mode json -p --no-session）执行 Subagent：
 *   - 上下文隔离（--no-session 新会话）
 *   - 投递可靠（不依赖 followUp 机制）
 *   - 天然并行（多 step 并发 spawn）
 *   - usage 统计（解析 message_end 事件）
 *   - 心跳保活：onTick 回调由调用方每 ~20s 更新 step 心跳，防止 STALE 误杀
 *
 * 参考 pi 官方示例 examples/extensions/subagent/index.ts（子进程 JSON 模式）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SubagentRunOptions {
  /** Role 系统提示（写入临时文件 via --append-system-prompt） */
  systemPrompt?: string;
  /** 任务 prompt（含 step 契约 / wiki packet / 执行要求） */
  task: string;
  /** 子进程工作目录（= 项目根） */
  cwd: string;
  /** 覆盖 provider（默认使用主 agent 的 PI_PROVIDER；主进程无 PI_* 时回退 pi 全局配置） */
  provider?: string;
  /** 覆盖 model（默认使用主 agent 的 PI_MODEL；与 provider 配对，避免跨 provider 歧义） */
  model?: string;
  /** 限制工具集（--tools a,b） */
  tools?: string[];
  /** 超时（默认 30min），超时 kill SIGTERM → 5s 后 SIGKILL */
  timeoutMs?: number;
  /** 心跳保活回调（每 ~20s），由调用方写 step heartbeat */
  onTick?: () => void;
  /** 流式消息回调（message_end / tool_result_end），可选 */
  onMessage?: (message: unknown) => void;
  /** 取消信号 */
  signal?: AbortSignal;
}

export interface SubagentRunResult {
  exitCode: number;
  /** 最终 assistant 文本输出 */
  output: string;
  stderr: string;
  messages: unknown[];
  usage: SubagentUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  timedOut?: boolean;
}

/**
 * 解析 Subagent 子进程模型。优先级：显式配置 > 主 agent 会话模型(ctx.model) > PI_* 环境变量。
 * 全部缺失时返回空 provider/model——调用方必须 fail-fast 阻止派发，
 * 不得静默回退 pi 全局默认（实测会解析成 yj/deepseek-v4-pro，与主会话不一致且烧余额）。
 * 注意：provider 与 model 必须成对解析；只有 model 没有 provider 会报
 * Model ambiguous across providers（模型 id 跨多个已认证 provider）。
 */
export function resolveSubagentModel(
  explicit: { provider?: string; model?: string },
  sessionModel?: { provider?: string; id?: string } | null,
): { provider?: string; model?: string } {
  const provider = explicit.provider || sessionModel?.provider || process.env.PI_PROVIDER;
  const model = explicit.model || sessionModel?.id || process.env.PI_MODEL;
  return { provider: provider || undefined, model: provider && model ? model : undefined };
}

export type SubagentModelResult =
  | { provider: string; model: string; action: "configured" | "resolved" | "declined" }
  | { provider?: undefined; model?: undefined; action: "cancelled" };

/** 本进程是否已问过「不配置 subagent 模型」并跳过（避免每个 step 都弹窗）。 */
let subagentModelPromptDeclined = false;

/**
 * 派发前确保有 Subagent 模型 provider/model 成对。
 * 0) 显式配置已齐 → 直接解析返回（不再询问）。
 * 1) 无显式配置且本进程已「跳过」→ 自动跟随主 agent 模型（ctx.model / PI_* env）。
 * 2) 无显式配置且尚未询问 → 用 ctx.ui 结构化选择询问用户是否配置：
 *    a) 用主 agent 当前模型写入 config（需要 sessionModel 可用）
 *    b) 手动输入 provider/model 写入 config
 *    c) 不配置，自动跟随主 agent 模型（本次进程记住，不再问）
 *    d) 取消本次派发（调用方保持 blocked）
 * 3) UI 不可用（headless/json）→ 自动解析；仍解析不到才由调用方 fail-fast。
 */
export async function resolveOrPromptSubagentModel(
  explicit: { provider?: string; model?: string },
  sessionModel: { provider?: string; id?: string } | null,
  ctx: { ui?: { select?: (t: string, o: string[]) => Promise<string | undefined>; input?: (t: string, p?: string) => Promise<string | undefined>; notify?: (m: string, ty?: string) => void } } | null,
  onWriteConfig: (provider: string, model: string) => Promise<boolean>,
): Promise<SubagentModelResult> {
  const both = explicit.provider && explicit.model;
  if (both) {
    return { provider: explicit.provider!, model: explicit.model!, action: "configured" };
  }
  if (subagentModelPromptDeclined) {
    const r = resolveSubagentModel(explicit, sessionModel);
    return r.provider && r.model
      ? { provider: r.provider, model: r.model, action: "declined" }
      : { action: "cancelled" };
  }
  const ui = ctx?.ui;
  if (!ui?.select || !ui?.notify) {
    // 无 UI（json/headless）：不阻塞，自动跟随主 agent；解析不到才 fail-fast
    const r = resolveSubagentModel(explicit, sessionModel);
    return r.provider && r.model
      ? { provider: r.provider, model: r.model, action: "declined" }
      : { action: "cancelled" };
  }
  const autoResolved = resolveSubagentModel(explicit, sessionModel);
  const canAuto = !!(autoResolved.provider && autoResolved.model);
  const options: string[] = [];
  if (canAuto) {
    options.push(`用主 agent 当前模型（${autoResolved.provider}/${autoResolved.model}）写入 .goo/config.json`);
  }
  options.push("手动输入 provider/model（写入 config）");
  options.push("不配置，自动跟随主 agent 模型（本进程不再问）");
  options.push("取消本次派发");
  const pick = await ui.select("Subagent 模型未配置，如何处理？", options);
  if (!pick) {
    return { action: "cancelled" };
  }
  if (pick.startsWith("用主 agent 当前模型")) {
    const ok = await onWriteConfig(autoResolved.provider!, autoResolved.model!);
    ui.notify(ok ? `已写入 config.execution.subagent_model=${autoResolved.model}` : "写入 config 失败，本次仍跟随主 agent", ok ? "info" : "error");
    return ok
      ? { provider: autoResolved.provider!, model: autoResolved.model!, action: "configured" }
      : { provider: autoResolved.provider!, model: autoResolved.model!, action: "resolved" };
  }
  if (pick.startsWith("手动输入")) {
    const p = (await ui.input("Subagent provider（如 opencode-go；同主 agent 时留空）", sessionModel?.provider ?? ""))?.trim();
    const m = (await ui.input("Subagent model（如 deepseek-v4-flash）", sessionModel?.id ?? ""))?.trim();
    const provider = p || sessionModel?.provider || process.env.PI_PROVIDER;
    const model = m || sessionModel?.id || process.env.PI_MODEL;
    if (provider && model) {
      const ok = await onWriteConfig(provider, model);
      ui.notify(ok ? `已写入 config.execution.subagent_model=${model}` : "写入 config 失败", ok ? "info" : "error");
      return { provider, model, action: ok ? "configured" : "resolved" };
    }
    ui.notify("provider 与 model 未能成对解析，本次取消派发", "error");
    return { action: "cancelled" };
  }
  if (pick.startsWith("不配置")) {
    subagentModelPromptDeclined = true;
    return canAuto
      ? { provider: autoResolved.provider!, model: autoResolved.model!, action: "declined" }
      : { action: "cancelled" };
  }
  return { action: "cancelled" };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** 解析当前 pi 可执行文件（复用官方 subagent 扩展逻辑）。
 *  支持 AUTOGOO_SUBAGENT_CMD 环境变量覆盖（测试/调试用）。 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const override = process.env.AUTOGOO_SUBAGENT_CMD;
  if (override) {
    const parts = override.split(" ").filter(Boolean);
    return { command: parts[0], args: [...parts.slice(1), ...args] };
  }
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSafe(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function existsSafe(p: string): boolean {
  return existsSync(p);
}

/** 从 assistant 消息中提取最终文本输出。 */
export function getFinalOutput(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: Array<{ type: string; text?: string }> };
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}

// ── Core ────────────────────────────────────────────────────────────────────

export function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Spawn 一个独立 pi 子进程执行 Subagent 任务，解析 JSON 流输出。
 * 阻塞直到子进程退出；期间每 ~20s 调用 onTick 供调用方保活心跳。
 */
export async function runSubagent(opts: SubagentRunOptions): Promise<SubagentRunResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  // 模型解析（实测 2026-08-18）：pi 子进程忽略 PI_MODEL/PI_PROVIDER 环境变量，
  // 无 flag 时按 defaultProvider(=yj) 解析为 deepseek-v4-pro，而非主会话模型。
  // 调用方必须先用 resolveSubagentModel 解析出 provider+model；这里防御性拒绝：
  // 两个都拿不到就报错，绝不静默走 pi 全局默认。
  if (!opts.provider && !opts.model) {
    throw new Error(
      "Subagent 模型未解析：config.execution.subagent_* 未设置，且无法取得主 agent 模型(ctx.model)与 PI_* 环境变量。" +
      "请设置 config.execution.subagent_provider/subagent_model 后重试（拒绝静默使用 pi 全局默认 deepseek-v4-pro）。",
    );
  }
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.provider && opts.model) args.push("--model", opts.model);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));

  let tmpDir: string | null = null;
  if (opts.systemPrompt?.trim()) {
    tmpDir = mkdtempSync(join(tmpdir(), "autogoo-subagent-"));
    const spPath = join(tmpDir, "system-prompt.md");
    writeFileSync(spPath, opts.systemPrompt, { mode: 0o600 });
    args.push("--append-system-prompt", spPath);
  }
  args.push(`Task: ${opts.task}`);

  const invocation = getPiInvocation(args);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const usage = emptyUsage();
  const messages: unknown[] = [];

  const result: SubagentRunResult = {
    exitCode: 0,
    output: "",
    stderr: "",
    messages,
    usage,
    timedOut: false,
  };

  const cleanup = () => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      tmpDir = null;
    }
  };

  return await new Promise<SubagentRunResult>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd: opts.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // 标记子进程模式：插件在子进程内跳过主 Agent 唤醒、不注册调度工具，
        // 防止 Subagent 递归调度 DAG。
        env: { ...process.env, AUTOGOO_SUBAGENT: "1" },
      });
    } catch (e) {
      cleanup();
      resolve({ ...result, exitCode: 1, errorMessage: e instanceof Error ? e.message : String(e) });
      return;
    }

    const heartbeatTimer = setInterval(() => {
      try {
        opts.onTick?.();
      } catch {
        /* 心跳失败不阻塞子进程 */
      }
    }, HEARTBEAT_INTERVAL_MS);

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    /** 终止子进程：先 SIGTERM，5s 后仍未退出则 SIGKILL（P11：timer 可清理）。 */
    const killProc = (signal: NodeJS.Signals = "SIGTERM") => {
      try {
        proc.kill(signal);
      } catch {
        /* ignore */
      }
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        try {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5000);
    };

    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        result.timedOut = true;
        killProc("SIGTERM");
      }, timeoutMs);
    }

    // P11：abort listener 在 close/error 时移除，避免泄漏
    const onAbort = () => killProc("SIGTERM");
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const stopTimers = () => {
      clearInterval(heartbeatTimer);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      clearKillTimer();
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      stopTimers();
      result.exitCode = code;
      result.output = getFinalOutput(messages);
      cleanup();
      resolve(result);
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return; // 非 JSON 行（如日志）忽略
      }
      if (event.type === "message_end" && event.message) {
        const msg = event.message as {
          role?: string;
          content?: Array<{ type: string; text?: string }>;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            totalTokens?: number;
            cost?: { total?: number };
          };
          model?: string;
          stopReason?: string;
          errorMessage?: string;
        };
        messages.push(msg);
        if (msg.role === "assistant") {
          usage.turns++;
          if (msg.usage) {
            usage.input += msg.usage.input || 0;
            usage.output += msg.usage.output || 0;
            usage.cacheRead += msg.usage.cacheRead || 0;
            usage.cacheWrite += msg.usage.cacheWrite || 0;
            usage.cost += msg.usage.cost?.total || 0;
            usage.contextTokens = msg.usage.totalTokens || usage.contextTokens;
          }
          if (msg.model) result.model = msg.model;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          if (msg.errorMessage) result.errorMessage = msg.errorMessage;
        }
        try {
          opts.onMessage?.(msg);
        } catch {
          /* ignore */
        }
      } else if (event.type === "tool_result_end" && event.message) {
        messages.push(event.message);
        try {
          opts.onMessage?.(event.message);
        } catch {
          /* ignore */
        }
      }
    };

    let buffer = "";
    proc.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr!.on("data", (data: Buffer) => {
      result.stderr += data.toString();
    });

    proc.on("close", (code, signal) => {
      if (buffer.trim()) processLine(buffer);
      if (signal) {
        // 被信号杀：Node 的 code 为 null，显式映射为 bash 约定退出码
        // （143=SIGTERM / 137=SIGKILL），避免被上层误判为 exit 0 成功。
        finish(signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : (code ?? 1));
      } else {
        finish(code ?? 0);
      }
    });

    proc.on("error", (e) => {
      result.errorMessage = e.message;
      finish(1);
    });
  });
}

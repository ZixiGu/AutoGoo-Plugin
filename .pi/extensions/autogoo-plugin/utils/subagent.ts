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
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

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
  /** 总超时（默认 30min），超时 kill SIGTERM → 5s 后 SIGKILL */
  timeoutMs?: number;
  /** 空闲超时（默认 5min）：连续无任何事件即判定卡住，提前 kill */
  idleTimeoutMs?: number;
  /** 心跳间隔毫秒（默认 20000）。对应 config.execution.heartbeat_seconds */
  heartbeatIntervalMs?: number;
  /**
   * 提前结束判断（在每次心跳时调用）：返回 true 则终止子进程。
   *
   * 用途：subagent 已经把 step 标记为 completed/failed，但进程因清理逻辑
   * 或僵死没有退出 —— 此时父进程不该继续等满 timeoutMs。
   * 机制（何时 kill、如何标记）留在 runSubagent，判断交给调用方。
   */
  shouldStop?: () => boolean;
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
  /** 超时原因：total=总超时兜底，idle=长时间无事件（多半是真卡住） */
  timeoutReason?: "total" | "idle";
  /** 由 shouldStop() 判定提前结束（step 已完成但进程未退出） */
  stoppedEarly?: boolean;
  /** 被调用方的 AbortSignal 中断（用户 Esc / 会话中断），与超时区分 */
  aborted?: boolean;
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

  // ── 能解析出主 agent 模型时，**默认直接跟随，不打扰用户** ────────────────
  //
  // 原设计是「没有显式配置就问一次，把选择写进 config」。实际体验是：
  // 每个新会话第一次派发都弹窗，而绝大多数人想要的就是「跟主模型一样」。
  // 默认行为不该需要用户确认 —— 想用别的模型时写 config 即可，那时
  // explicit 已有值，走上面的 configured 分支，同样不问。
  //
  // 只有「拿不到主模型」（headless 环境无 PI_*、ctx.model 缺失）才需要问，
  // 因为那时确实无从判断该用哪个。
  if (canAuto) {
    return { provider: autoResolved.provider!, model: autoResolved.model!, action: "resolved" };
  }

  const options: string[] = [];
  options.push("手动输入 provider/model（写入 config）");
  options.push("取消本次派发");
  const pick = await ui.select(
    "无法确定主 agent 模型（ctx.model 与 PI_* 均不可用），请指定 Subagent 模型",
    options,
  );
  if (!pick) {
    return { action: "cancelled" };
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
  return { action: "cancelled" };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 20_000;
/**
 * 总超时（默认 30 分钟）：兜底用，防止子进程永久驻留。
 * 语义是「**无进展**上限」而非「总时长上限」：只要子进程还有事件 / CPU 增长 /
 * 活跃后代 / 心跳，计时器就续期。真正防止「卡住还等满 90 分钟」的是 idle 检测
 * （默认 5 分钟无任何信号即杀）。
 */
const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;
/**
 * 空闲超时（默认 5 分钟）：连续这么久**没有任何事件**就判定卡住。
 *
 * 为什么需要它：子进程可能因为网络断、模型挂起、内部死锁而僵住，
 * 但进程还在。只靠 30 分钟总超时的话，整个 DAG 会白等半小时。
 * 阈值不能太短：模型 thinking 阶段可能长时间不输出事件。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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
    aborted: false,
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

    // 心跳间隔可配（config.execution.heartbeat_seconds）；默认 20s
    const heartbeatEvery = opts.heartbeatIntervalMs && opts.heartbeatIntervalMs > 0
      ? opts.heartbeatIntervalMs
      : HEARTBEAT_INTERVAL_MS;
    const heartbeatTimer = setInterval(() => {
      try {
        opts.onTick?.();
      } catch {
        /* 心跳失败不阻塞子进程 */
      }
      // step 已被标记完成/失败但进程没退出 → 提前结束，不必等满 timeoutMs
      try {
        if (opts.shouldStop?.()) {
          result.stoppedEarly = true;
          result.errorMessage = "step 已结束但子进程仍在运行，已提前终止";
          killProc("SIGTERM");
        }
      } catch {
        /* 判断失败不阻塞 */
      }
    }, heartbeatEvery);

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    /** 终止子进程：先 SIGTERM，5s 后仍未退出则 SIGKILL（P11：timer 可清理）。 */
    /**
     * 递归收集某个进程的全部后代 pid（先序）。
     *
     * 为什么需要：`proc.kill()` 只杀直接子进程。subagent 跑的是 pi 子进程，
     * 而 pi 在执行工具时会再 spawn bash / python / node —— 这些孙进程**不会**
     * 随父进程的 SIGTERM 一起死，因为它们通常不在同一进程组，且 shell 不转发信号。
     *
     * 实测：fake-pi 里 `sleep 30`，父进程 5 秒收到 SIGTERM 立刻退出，
     * 但 sleep 变孤儿继续跑到 30 秒，stdout 管道因此不关闭，调用方要白等 25 秒。
     * 真实场景里更糟：孤儿可能继续写文件 / 占用端口，与后续步骤冲突。
     */
    const collectDescendants = (pid: number, acc: number[] = []): number[] => {
      try {
        const kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf-8")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number);
        for (const k of kids) {
          acc.push(k);
          collectDescendants(k, acc);
        }
      } catch {
        /* 非 Linux / 无权限 / 进程已退出 */
      }
      return acc;
    };

    const killProc = (signal: NodeJS.Signals = "SIGTERM") => {
      // 先杀后代再杀自己：否则父进程一死，后代被 init 收养，父子关系丢失，
      // 再想通过 /proc/<pid>/children 找它们就不可能了。
      const descendants = collectDescendants(proc.pid ?? -1);
      for (const d of descendants.reverse()) {
        try {
          process.kill(d, signal);
        } catch {
          /* 已退出 */
        }
      }
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
        // 后代在 SIGTERM 后的宽限期内可能还没退：一并 SIGKILL
        for (const d of descendants) {
          try {
            process.kill(d, "SIGKILL");
          } catch {
            /* 已退出 */
          }
        }
      }, 5000);
    };

    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    // ── 超时：total 兜底 + idle 检测 ────────────────────────────────────
    // 只靠总超时的话，子进程卡住时要白等满 timeoutMs（默认 30 分钟）。
    //
    // ⚠ 但「没有 JSON 事件」**不等于**「没有进度」：实测 subagent 跑一个
    //   `sleep 8`（或编译/训练）期间，--mode json 的输出是**完全静默**的，
    //   事件只在工具结束后才出现。只看事件会误杀长命令。
    //
    // 因此用**多信号**判定，任一活跃就不算 idle：
    //   A. JSON 事件（markActivity）
    //   B. 子进程 CPU 时间增长（/proc/<pid>/stat 的 utime+stime）
    //   C. 子进程树里有活跃的后代（bash / node / python … 在执行工具）
    //   D. step log 文件在增长（用户要求"所有执行必须有 log"——这正是它的用途）
    let lastEventAt = Date.now();
    /**
     * 最后一次「可观测进展」的时间。
     *
     * 与 lastEventAt 的区别：lastEventAt 只由 JSON 事件驱动，而**无进展超时**
     * 还要接受 CPU 增长 / 活跃后代 / 心跳。否则一个跑 40 分钟编译的任务
     * （期间零 JSON 事件但有 CPU）会撞上「无进展」判定。
     */
    let lastProgressAt = Date.now();
    const markActivity = () => {
      lastEventAt = Date.now();
      lastProgressAt = Date.now();
    };
    const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    // ── 总超时：从「硬性总时长」改为「无进展上限」──────────────────────────
    //
    // 实测数据（circuit_gen 项目 exec.jsonl）：
    //   S1 完成 27.4min
    //   S2 start → 30min TIMEOUT(exit 143) → resume → 共 130min 才完成
    //   S3 start → 12.7min fail → resume → 共 234.5min 完成
    //   S5 start → 30min TIMEOUT(exit 143)
    //
    // 旧行为是 setTimeout(30min) **硬砍**，不看进展 —— 真实工程任务必然被杀，
    // 然后 resume 从头再来一遍（浪费的 token 与时间远超任务本身）。
    // 真正的「卡住」由 idle 检测（默认 5min 无任何信号）负责，这里只需要
    // 挡住「一直在动但永远不结束」的病态情况（死循环输出等）。
    //
    // 新语义：**只要还有进展就续期**；连续 timeoutMs 完全无进展才杀。
    if (timeoutMs > 0) {
      timeoutTimer = setInterval(() => {
        if (Date.now() - lastProgressAt < timeoutMs) return;
        result.timedOut = true;
        result.timeoutReason = "total";
        result.errorMessage =
          `子进程连续 ${Math.round(timeoutMs / 60000)} 分钟无任何进展` +
          `（无事件、CPU 无增长、无活跃后代、无心跳），已终止；` +
          `可用 execution.subagent_timeout_seconds 调整该阈值`;
        killProc("SIGTERM");
      }, Math.max(5_000, Math.min(30_000, Math.floor(timeoutMs / 10))));
      (timeoutTimer as any).unref?.();
    }

    /**
     * 读进程 CPU 时间（utime+stime，单位 tick）。不可用时返回 null。
     * 用于区分「模型卡住」与「正在跑计算密集的长命令」。
     */
    const readCpuTicks = (pid: number | undefined): number | null => {
      if (!pid) return null;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        // 格式：pid (comm) state ppid ... utime(14) stime(15) ...
        // comm 可能含空格/括号，从最后一个 ')' 之后开始切分
        const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        // tail[0]=state, tail[1]=ppid, ..., utime=tail[11], stime=tail[12]
        const utime = Number(tail[11]);
        const stime = Number(tail[12]);
        return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : null;
      } catch {
        return null;
      }
    };

    /** 是否有存活的后代进程（说明正在执行工具，而不是模型卡住）。 */
    const hasActiveDescendant = (pid: number | undefined): boolean => {
      if (!pid) return false;
      try {
        const childrenFile = `/proc/${pid}/task/${pid}/children`;
        const raw = readFileSync(childrenFile, "utf-8").trim();
        if (!raw) return false;
        // 后代存在且不是僵尸（Z）就算活跃
        for (const child of raw.split(/\s+/).filter(Boolean)) {
          try {
            const stat = readFileSync(`/proc/${child}/stat`, "utf-8");
            const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
            if (state && state !== "Z") return true;
          } catch {
            /* 子进程已退出 */
          }
        }
      } catch {
        /* 无法读取（非 Linux / 无权限）→ 视为无信息 */
      }
      return false;
    };

    let lastCpuTicks = readCpuTicks(proc.pid);
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    if (idleMs > 0) {
      // 用 1/4 间隔轮询，既能及时判定又不至于太频繁
      const tick = Math.max(1000, Math.floor(idleMs / 4));
      idleTimer = setInterval(() => {
        // 信号 A：JSON 事件
        const silentFor = Date.now() - lastEventAt;
        if (silentFor <= idleMs) return;

        // 信号 B：CPU 时间增长（计算密集的长命令）
        const cpu = readCpuTicks(proc.pid);
        const cpuBusy = cpu !== null && lastCpuTicks !== null && cpu > lastCpuTicks;
        if (cpu !== null) lastCpuTicks = cpu;

        // 信号 C：有活跃后代（bash / node / python 在执行工具）
        const descendantsBusy = hasActiveDescendant(proc.pid);

        if (cpuBusy || descendantsBusy) {
          // 有证据表明它在干活 → 不算 idle，并把锚点前移，避免下次立刻触发
          lastEventAt = Date.now();
          lastProgressAt = Date.now();   // 同时续期「无进展总超时」
          return;
        }

        // 三个信号都沉默 → 判定卡住
        result.timedOut = true;
        result.timeoutReason = "idle";
        result.errorMessage =
          `子进程 ${Math.round(idleMs / 1000)}s 无事件、CPU 无增长、无活跃子进程（疑似卡住），已终止；` +
          `可用 execution.subagent_idle_timeout_seconds 调整该阈值`;
        killProc("SIGTERM");
      }, tick);
      idleTimer.unref?.();
    }

    // P11：abort listener 在 close/error 时移除，避免泄漏
    // 显式区分「用户中断」与「超时」：两者都走 SIGTERM，但语义不同，
    // 上层据此把 step 标记为 interrupted 而不是 failed。
    const onAbort = () => {
      result.aborted = true;
      killProc("SIGTERM");
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const stopTimers = () => {
      clearInterval(heartbeatTimer);
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
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
      // 任何合法事件都算「子进程还活着」，用于 idle 检测（见上方 idleTimer）
      markActivity();
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

// ─────────────────────────────────────────────────────────────────────────────
// Detached 派发：解决 pi tool call 2 分钟硬超时
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 为什么需要 detached 派发
 * ------------------------
 * pi 对**每个 tool call** 有硬编码超时：
 *
 *     const TOOL_TIMEOUT_MS = 12e4;   // 2 分钟
 *     timer = setTimeout(() => toolCtrl.abort(), TOOL_TIMEOUT_MS);
 *
 * 而 `runSubagent` 是**阻塞等待子进程退出**的。真实 DAG 步骤通常几分钟到几十分钟，
 * 于是 2 分钟时 pi abort → 我们转发的 signal 触发 killProc(SIGTERM) →
 * 所有 subagent 一起 exit=143，步骤停在 progress=15。
 *
 * 结论：**在当前 pi 版本下，"派发 + 阻塞等待"这条路走不通**。
 * 正确做法是把派发和等待拆开：
 *   1. tool call 内只做 spawn（detached），立即返回 pid（毫秒级）
 *   2. 子进程 unref 后独立运行，pi 会话退出也不影响
 *   3. 后续用 heartbeat_check / dag_status 轮询 plan.json 与 pid 存活
 *
 * 代价：父子管道断开 → stdout/stderr 必须重定向到文件，实时流式转发失效。
 * 这是必要的取舍：能跑完 > 能实时看。
 */

export interface DetachedHandle {
  /** 子进程 pid（用于存活检测） */
  pid: number;
  /** stdout/stderr 合并重定向到此文件（JSON 流，可事后解析） */
  logPath: string;
  /** 派发时间 */
  startedAt: string;
  /** provider/model（便于事后核对用的是哪个模型） */
  provider?: string;
  model?: string;
}

export interface DetachedOptions {
  provider?: string;
  model?: string;
  task: string;
  cwd: string;
  systemPrompt?: string;
  logPath: string;
  tools?: string[];
}

/**
 * Spawn 一个脱离父进程组的 pi 子进程执行 Subagent 任务，**立即返回**。
 *
 * 与 {@link runSubagent} 的区别：
 *   - `detached: true` + `unref()` → 父进程（pi 会话）退出不连带杀死
 *   - stdio 重定向到 logPath → 不占父进程管道，父子解耦
 *   - 不等待退出 → tool call 毫秒级返回，不会撞 2 分钟超时
 *
 * 子进程自己负责更新 plan（它有 auto_goo_update_step 工具）。
 */
export function spawnSubagentDetached(opts: DetachedOptions): DetachedHandle {
  if (!opts.provider && !opts.model) {
    throw new Error(
      "Subagent 模型未解析：config.execution.subagent_* 未设置，且无法取得主 agent 模型与 PI_* 环境变量。",
    );
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
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

  // stdout + stderr 合并写入同一个文件：JSON 流一行一条，stderr 混入也可接受
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, "a");

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      shell: false,
      detached: true,                    // 独立进程组：父进程被杀不连带
      stdio: ["ignore", fd, fd],
      env: { ...process.env, AUTOGOO_SUBAGENT: "1" },
    });
  } finally {
    try {
      closeSync(fd);                     // 子进程已继承 fd，父侧可关
    } catch {
      /* ignore */
    }
  }

  proc.unref();                          // 父进程不等待它

  if (!proc.pid) {
    throw new Error("spawn 失败：未取得子进程 pid");
  }

  // system-prompt 临时目录：子进程已读入内存，可立即清理
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return {
    pid: proc.pid,
    logPath: opts.logPath,
    startedAt: new Date().toISOString(),
    provider: opts.provider,
    model: opts.model,
  };
}

/**
 * 判断 detached 子进程是否还活着。
 *
 * `process.kill(pid, 0)` 不发信号，只做权限/存在性检查：
 *   - 成功 → 进程存在（可能是僵尸，但已被 init 收养时算存活）
 *   - ESRCH → 不存在
 *   - EPERM → 存在但无权限（视为存活）
 */
export function isDetachedAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

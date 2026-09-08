/**
 * Shared shell execution utility — eliminates duplication of execAsync.
 *
 * exec / execPython / execBash：用 spawnSync 传参数数组，**不走 shell**，
 * 参数中的 $()、反引号、引号、括号等特殊字符不会被执行或破坏命令
 * （修复 2026-08-10：原实现 execSync 拼接字符串 + 仅转义 "，导致
 *   $(cmd)、`cmd` 命令注入、引号配对破坏 → /bin/sh Syntax error）。
 *
 * execShell：保留 shell（本就接收 shell 命令字符串），用 /bin/bash。
 */

import { spawn, spawnSync, execSync, type ExecSyncOptions, type SpawnSyncOptions } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecAsyncResult extends ExecResult {
  /** 是否因超时被终止（默认 300s） */
  timedOut: boolean;
  /** 是否因调用方 AbortSignal 被终止 */
  aborted: boolean;
  /** 输出是否超过 maxBuffer 被截断 */
  truncated: boolean;
  /** 进程因信号终止时的信号名（如 SIGTERM） */
  signal?: string;
}

export interface ExecAsyncOptions {
  /** 超时毫秒（默认 300000） */
  timeout?: number;
  /** stdout 累积上限（默认 10MB），超限即终止并标记 truncated */
  maxBuffer?: number;
  /** 调用方中止信号：abort 时 SIGTERM 终止子进程 */
  signal?: AbortSignal;
  /** 增量 stdout 回调（用于流式转发，如 TUI 实时展示） */
  onStdout?: (chunk: string) => void;
  /** 增量 stderr 回调 */
  onStderr?: (chunk: string) => void;
}

/**
 * Execute a command with an argument array via spawnSync (no shell).
 * All AutoGoo-Plugin command handlers use this instead of duplicating execAsync.
 */
export function exec(
  command: string,
  args: string[],
  cwd: string,
  options?: { timeout?: number; maxBuffer?: number },
): ExecResult {
  const opts: SpawnSyncOptions = {
    cwd,
    encoding: "utf-8" as const,
    maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
    timeout: options?.timeout ?? 60000,
    // 不走 shell：参数数组原样传给子进程，杜绝引号/特殊字符注入
    shell: false,
  };

  try {
    const r = spawnSync(command, args, opts);
    // C5 修复：输出超 maxBuffer 时 spawnSync 置 ENOBUFS，status=null；
    // 超时（ETIMEDOUT）或其它 spawn 错误同理：必须把原因写入 stderr 返回，
    // 否则上层会得到 exitCode=1 且 stdout/stderr 均为空（如 ssh 连接挂起
    // 5 分钟后被 SIGTERM）——表现为"始终无输出且无任何诊断"。
    if (r.error) {
      const reason =
        r.error.code === "ENOBUFS"
          ? `[exec] output exceeded maxBuffer (${opts.maxBuffer} bytes); result truncated.`
          : r.error.code === "ETIMEDOUT"
            ? `[exec] timed out after ${opts.timeout}ms; process killed.`
            : `[exec] ${r.error.message}`;
      return {
        stdout: r.stdout ?? "",
        stderr: (r.stderr || "") + `\n${reason}`,
        exitCode: r.status ?? 1,
      };
    }
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.status ?? 0,
    };
  } catch (err: any) {
    return {
      stdout: "",
      stderr: err.stderr ?? err.message,
      exitCode: err.status ?? 1,
    };
  }
}

/**
 * 异步执行命令（spawn，不阻塞事件循环）。
 *
 * 用于需要长时间运行/可能挂起的命令（如远程 SSH 执行）：
 * - 增量回调 onStdout/onStderr 支持流式转发到 TUI；
 * - AbortSignal 中止时 SIGTERM 子进程，避免 spawnSync 阻塞期间无法取消；
 * - 超时/中止/截断都会把原因写入 stderr，绝不静默返回空输出。
 */
export function execAsync(
  command: string,
  args: string[],
  cwd: string,
  options?: ExecAsyncOptions,
): Promise<ExecAsyncResult> {
  return new Promise((resolve) => {
    const timeoutMs = options?.timeout ?? 300000;
    const maxBuffer = options?.maxBuffer ?? 10 * 1024 * 1024;

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // 参数数组原样传参，不走 shell，杜绝引号/特殊字符注入
      shell: false,
      // 成为进程组 leader：goo-ssh.sh 会 exec 成 sshpass 再 spawn ssh 子进程，
      // 只杀单进程会残留 ssh（其持有 stdout 管道 → close 事件永不触发 →
      // 工具一直 Working）。杀进程组（与 pi 内置 bash 的 killProcessTree 一致）。
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    /** 终止整个进程组：SIGTERM → 3s 后 SIGKILL；同时强制关闭管道确保 close 触发。 */
    const terminate = () => {
      if (settled) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* 进程组不存在 */
      }
      try {
        child.kill("SIGTERM");
      } catch {
        /* 已退出 */
      }
      // 强制关闭管道：即使有残留子进程持着写端，也让 Node 触发 close
      try {
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        /* 流已关闭 */
      }
      if (!settled) {
        const harder = setTimeout(() => {
          if (settled) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* 进程组不存在 */
          }
          try {
            child.kill("SIGKILL");
          } catch {
            /* 已退出 */
          }
          try {
            child.stdout.destroy();
            child.stderr.destroy();
          } catch {
            /* 流已关闭 */
          }
        }, 3000);
        harder.unref();
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();

    if (options?.signal) {
      if (options.signal.aborted) {
        aborted = true;
        terminate();
      } else {
        const onAbort = () => {
          aborted = true;
          terminate();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        child.on("close", () => options.signal?.removeEventListener("abort", onAbort));
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdout += text;
      if (stdout.length > maxBuffer) {
        truncated = true;
        stdout = stdout.slice(0, maxBuffer);
        terminate();
      }
      options?.onStdout?.(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderr += text;
      options?.onStderr?.(text);
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: (stderr || "") + `\n[exec] failed to spawn: ${err.message}`,
        exitCode: 1,
        timedOut: false,
        aborted,
        truncated,
      });
    });

    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const reason = timedOut
        ? `\n[exec] timed out after ${timeoutMs}ms; process killed.`
        : aborted
          ? `\n[exec] aborted by caller signal.`
          : truncated
            ? `\n[exec] output exceeded maxBuffer (${maxBuffer} bytes); result truncated.`
            : "";
      if (reason) stderr += reason;
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
        aborted,
        truncated,
        signal: sig ?? undefined,
      });
    });
  });
}

/**
 * Execute a Python script with arguments.
 */
export function execPython(
  scriptPath: string,
  scriptArgs: string[],
  cwd: string,
  options?: { timeout?: number },
): ExecResult {
  return exec("python3", [scriptPath, ...scriptArgs], cwd, options);
}

/**
 * Execute a bash script with arguments.
 */
export function execBash(
  scriptPath: string,
  scriptArgs: string[],
  cwd: string,
  options?: { timeout?: number },
): ExecResult {
  return exec("bash", [scriptPath, ...scriptArgs], cwd, options);
}

/**
 * Execute an arbitrary shell command string (intentionally uses shell).
 */
export function execShell(
  cmd: string,
  cwd: string,
  options?: { timeout?: number },
): ExecResult {
  const opts: ExecSyncOptions = {
    cwd,
    encoding: "utf-8" as const,
    maxBuffer: 10 * 1024 * 1024,
    timeout: options?.timeout ?? 60000,
    shell: "/bin/bash",
  };

  try {
    const stdout = execSync(cmd, opts) as string;
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      exitCode: err.status ?? 1,
    };
  }
}

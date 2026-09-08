/**
 * AutoGoo-Plugin 后台监视 — 与 auto_goo_ssh_monitor 前台阻塞模式互补。
 *
 * 场景：监视训练进度（tail -f）的同时还想安排/执行别的任务。
 * 前台 monitor 是阻塞式（窗口内模型被工具调用占用），后台模式把 ssh 进程
 * 独立 spawn（detached 进程组），输出实时写 .goo/artifacts/monitor/<id>.log，
 * 工具立即返回 monitor_id，不阻塞对话；随时用 poll 查询累积输出，stop 终止。
 *
 * 生命周期：
 *   bg 启动（写 <id>.log + <id>.json）→ 期间可做任何其他任务
 *   → poll 多次查询（状态 running/done/killed + 日志尾部 + 运行时长）
 *   → 窗口到期远程 timeout 自动终止（done）；或 stop 手动终止（killed）
 *
 * 安全：
 *   - 密码仍只经 goo-ssh.sh 的 sshpass -f 临时文件传递，绝不进命令行
 *   - 进程组终止（detached + kill(-pid)），与 pi 内置 bash killProcessTree 一致
 *   - 输出写文件而非内存：插件重启/会话切换后仍可 poll 到已累积数据
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../utils/paths.js";
import { buildMonitorRemoteCmd, resolveServer } from "./ssh.js";

interface MonitorMeta {
  id: string;
  server: string;
  command: string;
  pid: number;
  started_at: string;
  duration_seconds: number;
  timeout_ms: number;
  workdir?: string;
  status: "running" | "done" | "killed" | "error";
  exit_code: number | null;
  log_path: string;
}

function monitorDir(cwd: string): string {
  return join(cwd, ".goo", "artifacts", "monitor");
}

function metaPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function logPath(dir: string, id: string): string {
  return join(dir, `${id}.log`);
}

function readMeta(dir: string, id: string): MonitorMeta | null {
  try {
    const p = metaPath(dir, id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as MonitorMeta;
  } catch {
    return null;
  }
}

function writeMeta(dir: string, meta: MonitorMeta): void {
  writeFileSync(metaPath(dir, meta.id), JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** 读日志尾部（字节数受限，避免全量读大文件）。 */
function readTail(file: string, maxBytes = 4096): string {
  try {
    const fd = openSync(file, "r");
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    closeSync(fd);
    return readFileSync(file, "utf-8").slice(start);
  } catch {
    return "";
  }
}

function stopProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* 组不存在 */
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 已退出 */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* 组不存在 */
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }, 3000).unref();
}

export function registerMonitorBgTools(pi: ExtensionAPI): void {
  // Tool: auto_goo_ssh_monitor_bg
  pi.registerTool({
    name: "auto_goo_ssh_monitor_bg",
    label: "SSH Background Monitor",
    description: `启动后台监视：spawn 独立 ssh 进程监视远程持续输出（训练进度/日志/GPU），输出实时写入 .goo/artifacts/monitor/<id>.log，立即返回 monitor_id 不阻塞对话。期间可安排其他任务，随时用 auto_goo_ssh_monitor_poll 查询累积输出，auto_goo_ssh_monitor_stop 终止。窗口（duration_seconds，默认 3600）到期自动终止。`,
    promptSnippet: "后台监视远程持续输出（不阻塞，可并行做其他任务）",
    promptGuidelines: [
      "用 auto_goo_ssh_monitor_bg 把长时间监视放到后台：立即返回 monitor_id，对话可继续做其他任务。",
      "之后随时用 auto_goo_ssh_monitor_poll monitor_id=<id> 查询累积输出与状态，不需要时用 auto_goo_ssh_monitor_stop 终止。",
      "窗口（duration_seconds）到期远程自动终止；每次 bg 启动独立进程组，可并行多个监视。",
    ],
    parameters: Type.Object({
      server: Type.String({ description: "服务器名称/别名（来自 config.json servers[].name）" }),
      command: Type.String({ description: "远程命令（可含管道/重定向/引号）" }),
      duration_seconds: Type.Optional(Type.Integer({ description: "观察窗口秒数（默认 3600，范围 10-86400）" })),
      timeout_seconds: Type.Optional(Type.Integer({ description: "整体执行上限秒数（默认 窗口+60）" })),
      workdir: Type.Optional(Type.String({ description: "远程工作目录（可选，默认服务器 defaults.workdir 或 ~）" })),
      host: Type.Optional(Type.String({ description: "服务器主机/IP（与配置不一致或缺省时询问是否更新配置）" })),
      port: Type.Optional(Type.Integer({ description: "SSH 端口（与配置不一致或缺省时询问是否更新配置）" })),
      user: Type.Optional(Type.String({ description: "SSH 用户名（与配置不一致或缺省时询问是否更新配置）" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const sshScript = join(REPO_ROOT, "skills/auto-goo/scripts/goo-ssh.sh");
      if (!existsSync(sshScript)) {
        return { content: [{ type: "text", text: `goo-ssh.sh 未找到: ${sshScript}` }], details: { error: "script_not_found" } };
      }
      const resolved = await resolveServer(cwd, params.server, { host: params.host, port: params.port, user: params.user }, ctx);
      if (resolved.cancelled || !resolved.server) {
        return {
          content: [{ type: "text", text: [resolved.cancelled, ...resolved.lines].filter(Boolean).join("\n") }],
          details: { error: "server_not_resolved" },
        };
      }
      const server = resolved.server;

      const duration = Math.min(86400, Math.max(10, Math.round(params.duration_seconds ?? 3600)));
      const timeoutMs = Math.max(Math.round(params.timeout_seconds ?? 0) * 1000 || 0, duration * 1000 + 60000);
      const monitorWd = params.workdir || server.defaults?.workdir || "~";
      const remoteCmd = buildMonitorRemoteCmd(params.command, duration);

      // 后台监视目录 + 元数据
      const dir = monitorDir(cwd);
      mkdirSync(dir, { recursive: true });
      const id = `m${Date.now()}`;
      const logFile = logPath(dir, id);
      const meta: MonitorMeta = {
        id,
        server: server.name,
        command: params.command,
        pid: 0,
        started_at: new Date().toISOString(),
        duration_seconds: duration,
        timeout_ms: timeoutMs,
        workdir: monitorWd,
        status: "running",
        exit_code: null,
        log_path: logFile,
      };

      // detached + fd 重定向：输出落盘，进程组独立，不随对话返回而终止
      const outFd = openSync(logFile, "a");
      const child = spawn(
        "bash",
        [sshScript, "--config", join(cwd, ".goo/config.json"), "--server", server.name, "--workdir", monitorWd, "--", remoteCmd],
        { cwd, env: process.env, stdio: ["ignore", outFd, outFd], detached: true },
      );
      child.unref();
      meta.pid = child.pid ?? 0;
      writeMeta(dir, meta);

      child.on("error", (err: Error) => {
        meta.status = "error";
        meta.exit_code = 1;
        writeMeta(dir, meta);
      });
      child.on("exit", (code, signal) => {
        meta.exit_code = code ?? (signal ? (signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 1) : 1);
        meta.status = meta.exit_code === 143 || meta.exit_code === 137 ? "killed" : "done";
        writeMeta(dir, meta);
      });

      return {
        content: [
          {
            type: "text",
            text: [
              ...resolved.lines,
              `✅ 后台监视已启动: ${server.name} (${server.host || server.ip})`,
              `  monitor_id: ${id}`,
              `  pid: ${meta.pid}`,
              `  窗口: ${duration}s（到期自动终止） | 工作目录: ${monitorWd}`,
              `  日志: ${logFile}`,
              `随时用 auto_goo_ssh_monitor_poll monitor_id=${id} 查询，或 auto_goo_ssh_monitor_stop monitor_id=${id} 终止。`,
            ].join("\n"),
          },
        ],
        details: {
          monitor_id: id,
          server: server.name,
          pid: meta.pid,
          log_path: logFile,
          duration_seconds: duration,
        },
      };
    },
  });

  // Tool: auto_goo_ssh_monitor_poll
  pi.registerTool({
    name: "auto_goo_ssh_monitor_poll",
    label: "SSH Background Monitor Poll",
    description: `查询后台监视（auto_goo_ssh_monitor_bg 启动）的状态与累积输出。不传 monitor_id 时列出所有后台监视。输出读自 .goo/artifacts/monitor/<id>.log 尾部。`,
    promptSnippet: "查询后台监视状态与累积输出",
    promptGuidelines: [
      "用 auto_goo_ssh_monitor_poll monitor_id=<id> 查询后台监视：返回运行状态（running/done/killed）、退出码、运行时长与日志尾部。",
      "不传 monitor_id 时列出所有后台监视的概览。",
    ],
    parameters: Type.Object({
      monitor_id: Type.Optional(Type.String({ description: "后台监视 ID（缺省列出全部）" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const dir = monitorDir(cwd);
      if (!existsSync(dir)) {
        return { content: [{ type: "text", text: "没有后台监视记录（.goo/artifacts/monitor/ 不存在）。先调用 auto_goo_ssh_monitor_bg 启动。" }], details: { count: 0 } };
      }

      // 列表模式：所有 <id>.json
      const ids = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
      if (!params.monitor_id) {
        if (ids.length === 0) {
          return { content: [{ type: "text", text: "没有后台监视记录。先调用 auto_goo_ssh_monitor_bg 启动。" }], details: { count: 0 } };
        }
        const lines = ["📡 后台监视列表", "─────────────────"];
        for (const id of ids) {
          const m = readMeta(dir, id);
          if (!m) continue;
          const alive = m.status === "running" && isAlive(m.pid);
          const st = alive ? "🟢 running" : m.status === "done" ? "✅ done" : m.status === "killed" ? "⏹ killed" : "❌ error";
          const elapsed = Math.round((Date.now() - new Date(m.started_at).getTime()) / 1000);
          lines.push(`  ${id} | ${m.server} | ${st} | ${elapsed}s | ${m.command.slice(0, 60)}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { count: ids.length } };
      }

      const id = String(params.monitor_id);
      const m = readMeta(dir, id);
      if (!m) {
        return {
          content: [{ type: "text", text: `后台监视 ${id} 未找到。可用: ${ids.join(", ") || "无"}` }],
          details: { error: "monitor_not_found", available: ids },
        };
      }

      // 进程存活修正：元数据 running 但进程已死（如外部 kill）→ 视为 done
      const alive = m.status === "running" && isAlive(m.pid);
      const status = m.status === "running" ? (alive ? "running" : "done") : m.status;
      const elapsed = Math.round((Date.now() - new Date(m.started_at).getTime()) / 1000);
      const tail = readTail(m.log_path, 4096);
      const tailLines = tail ? tail.split("\n").slice(-40).join("\n") : "(无输出)";

      return {
        content: [
          {
            type: "text",
            text: [
              `📡 后台监视 ${id}（${m.server}）`,
              `  状态: ${status === "running" ? "🟢 running" : status === "done" ? "✅ done" : status === "killed" ? "⏹ killed" : "❌ error"} | 运行 ${elapsed}s / 窗口 ${m.duration_seconds}s`,
              status !== "running" ? `  退出码: ${m.exit_code ?? "?"}` : "",
              `  命令: ${m.command}`,
              `  日志: ${m.log_path}`,
              `── 输出尾部 ──`,
              tailLines,
            ].filter((l) => l !== "").join("\n"),
          },
        ],
        details: {
          monitor_id: id,
          server: m.server,
          status,
          exit_code: m.exit_code,
          elapsed_seconds: elapsed,
          duration_seconds: m.duration_seconds,
          output_length: existsSync(m.log_path) ? statSync(m.log_path).size : 0,
        },
      };
    },
  });

  // Tool: auto_goo_ssh_monitor_stop
  pi.registerTool({
    name: "auto_goo_ssh_monitor_stop",
    label: "SSH Background Monitor Stop",
    description: `终止后台监视（auto_goo_ssh_monitor_bg 启动）的进程组，标记 killed。`,
    promptSnippet: "终止后台监视",
    promptGuidelines: ["用 auto_goo_ssh_monitor_stop monitor_id=<id> 终止后台监视进程组（SIGTERM → 3s 后 SIGKILL），标记 killed。"],
    parameters: Type.Object({
      monitor_id: Type.String({ description: "后台监视 ID（来自 auto_goo_ssh_monitor_bg 返回）" }),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const dir = monitorDir(cwd);
      const id = String(params.monitor_id);
      const m = readMeta(dir, id);
      if (!m) {
        return { content: [{ type: "text", text: `后台监视 ${id} 未找到。` }], details: { error: "monitor_not_found" } };
      }
      if (m.status !== "running") {
        return {
          content: [{ type: "text", text: `后台监视 ${id} 已处于 ${m.status} 状态（exit=${m.exit_code ?? "?"}），无需终止。` }],
          details: { monitor_id: id, status: m.status },
        };
      }
      stopProcessGroup(m.pid);
      m.status = "killed";
      m.exit_code = 143;
      writeMeta(dir, m);
      return {
        content: [{ type: "text", text: `⏹ 已发送终止信号给后台监视 ${id}（pid ${m.pid} 进程组）` }],
        details: { monitor_id: id, pid: m.pid, status: "killed" },
      };
    },
  });
}

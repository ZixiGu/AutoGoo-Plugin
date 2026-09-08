/**
 * AutoGoo-Plugin Remote Server SSH — 远程执行集成
 *
 * 封装 SSH 远程执行流程：
 * - 读取配置文件中的服务器信息
 * - 通过 goo-ssh.sh（sshpass -f 临时文件读 secrets.json 密码）执行远程命令
 * - 服务器信息缺失/冲突时主动询问用户：新增配置 or 更新原配置
 *
 * 安全约束：
 * - 密码绝不进入命令行 / 聊天 / 日志 / plan，只存 .goo/secrets.json（chmod 600）
 * - 新增服务器时不通过 ui.input 收集密码；若需密码认证，提示用户手动写入 secrets.json
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execAsync } from "../utils/exec.js";
import {
  REPO_ROOT,
  loadProjectConfig,
  getServers,
  projectConfigPath,
  type AutogooPluginConfig,
  type ServerEntry,
} from "../utils/paths.js";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 小范围 upsert 服务器配置（保持其余配置原样，避免 goo-init.sh 的连带副作用）。 */
async function upsertServerInConfig(cwd: string, server: ServerEntry): Promise<void> {
  const cfgPath = projectConfigPath(cwd);
  let config: any = {};
  try {
    config = JSON.parse(await readFile(cfgPath, "utf-8"));
  } catch {
    config = {};
  }
  const list = Array.isArray(config.servers) ? config.servers : [];
  const idx = list.findIndex((s: any) => s?.name === server.name);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...server };
  } else {
    list.push(server);
  }
  config.servers = list;
  await writeFile(cfgPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** 判断 server 字符串是否像 goo-ssh.sh 的直接连接串（user@host / host:port / 索引），
 *  这类串不应触发“新增配置”流程。 */
function looksLikeDirectSelector(value: string): boolean {
  if (/^\d+$/.test(value)) return true; // 索引
  if (value.includes("@")) return true; // user@host
  if (/^[\w.\-]+:\d+$/.test(value)) return true; // host:port
  return false;
}

interface ResolvedServer {
  server: ServerEntry;
  lines: string[];
  cancelled?: string;
}

/**
 * 解析服务器配置：按 name/host/ip 查找；缺失 → 询问是否新增；
 * 用户额外提供的 host/port/user 与配置冲突/缺失 → 询问是否更新原配置。
 * 返回解析后的 server + 过程说明行；用户拒绝时返回 cancelled。
 */
export async function resolveServer(
  cwd: string,
  selector: string,
  provided: { host?: string; port?: number; user?: string },
  ctx: any,
): Promise<ResolvedServer> {  const lines: string[] = [];
  const config = await loadProjectConfig(cwd);
  const servers = getServers(config);
  const existing = servers.find(
    (s) => s.name === selector || s.host === selector || s.ip === selector,
  );

  // 未找到
  if (!existing) {
    if (looksLikeDirectSelector(selector)) {
      return {
        server: null as any,
        lines,
        cancelled: `"${selector}" 是直接连接串（索引/user@host/host:port），请用配置中的服务器名称。可用服务器: ${servers.map((s) => s.name).join(", ") || "无"}`,
      };
    }
    if (!ctx?.ui) {
      return {
        server: null as any,
        lines,
        cancelled: `服务器 "${selector}" 未在配置中找到，且当前无可交互 UI 无法询问是否新增。可用服务器: ${servers.map((s) => s.name).join(", ") || "无"}`,
      };
    }

    // 收集缺失字段：单次输入 user@host[:port]（已有字段自动合并，port 默认 22）。
    // 旧实现三个独立 input 框（host/port/user）在 TUI 里容易跳过导致"信息不完整"。
    let host = (provided.host || "").trim();
    let port = provided.port ?? 0;
    let user = (provided.user || "").trim();
    if (!host || !user || !port) {
      let combined = "";
      try {
        combined = (
          (await ctx.ui.input(
            `未找到服务器 "${selector}"。可用服务器: ${servers.map((s) => s.name).join(", ") || "无"}\n` +
              `请输入连接串新增配置（格式 user@host[:port]，port 默认 22）：`,
            "",
          )) ?? ""
        ).trim();
      } catch {
        /* ui 交互被中止（如 Esc） */
      }
      const m = combined.match(/^(?:(\S+)@)?([^:\s]+)(?::(\d+))?$/);
      if (!m) {
        return {
          server: null as any,
          lines,
          cancelled:
            `连接串格式不正确（应为 user@host[:port]）："${combined || "(空)"}"。未新增。可用服务器: ${servers.map((s) => s.name).join(", ") || "无"}`,
        };
      }
      user = user || m[1] || "";
      host = host || m[2];
      port = port || Number(m[3] || 22);
    }
    if (!host || !user || !port) {
      return {
        server: null as any,
        lines,
        cancelled: `服务器 "${selector}" 信息不完整（host/port/user 必填），未新增。可用服务器: ${servers.map((s) => s.name).join(", ") || "无"}`,
      };
    }
    let type: "cpu" | "gpu" = "cpu";
    try {
      const t = await ctx.ui.select(`服务器 ${selector} 类型`, ["cpu", "gpu"]);
      if (t === "gpu" || t === "cpu") type = t;
    } catch {
      /* 默认 cpu */
    }

    const addAnswer = await ctx.ui.confirm(
      `新增服务器 ${selector}？`,
      `未在配置中找到 "${selector}"。将新增到 ${projectConfigPath(cwd)}：\n` +
        `  name=${selector}\n  host=${host}\n  port=${port}\n  user=${user}\n  type=${type}\n` +
        `\n是否添加？添加后立即用该配置执行；拒绝则中止。`,
    );
    if (!addAnswer) {
      return {
        server: null as any,
        lines,
        cancelled: `用户拒绝新增服务器 "${selector}"，命令未执行。可用服务器: ${servers.map((s) => s.name).join(", ") || "无"}`,
      };
    }

    const newServer: ServerEntry = {
      name: selector,
      host,
      port,
      user,
      type,
      purpose: selector,
    };
    await upsertServerInConfig(cwd, newServer);
    lines.push(`✅ 已新增服务器 "${selector}"（host=${host}:${port}, user=${user}, type=${type}）`);
    lines.push(`🔑 若该服务器需要密码认证：请将密码加入 ${projectConfigPath(cwd).replace(/config\.json$/, "secrets.json")}（chmod 600，格式与现有条目一致），密码不会在本对话中收集。`);
    return { server: newServer, lines };
  }

  // 已找到 → 检测冲突/缺失
  const conflicts: string[] = [];
  if (provided.host) {
    const cfgHost = existing.host || existing.ip || "";
    if (cfgHost && provided.host !== cfgHost) {
      conflicts.push(`host: 配置=${cfgHost}，提供=${provided.host}`);
    } else if (!cfgHost) {
      conflicts.push(`host: 配置缺失，提供=${provided.host}`);
    }
  }
  if (provided.port) {
    if (existing.port && Number(provided.port) !== Number(existing.port)) {
      conflicts.push(`port: 配置=${existing.port}，提供=${provided.port}`);
    } else if (!existing.port) {
      conflicts.push(`port: 配置缺失，提供=${provided.port}`);
    }
  }
  if (provided.user) {
    if (existing.user && provided.user !== existing.user) {
      conflicts.push(`user: 配置=${existing.user}，提供=${provided.user}`);
    } else if (!existing.user) {
      conflicts.push(`user: 配置缺失，提供=${provided.user}`);
    }
  }

  if (conflicts.length > 0 && ctx?.ui) {
    const updateAnswer = await ctx.ui.confirm(
      `服务器 ${existing.name} 配置冲突/缺失`,
      `检测到提供的信息与 .goo/config.json 不一致：\n${conflicts.join("\n")}\n\n` +
        `是否更新配置？\n选择"是" → 更新后用新值执行；选择"否" → 忽略提供值，用现有配置执行。`,
    );
    if (updateAnswer) {
      if (provided.host) existing.host = provided.host;
      if (provided.port) existing.port = Number(provided.port);
      if (provided.user) existing.user = provided.user;
      await upsertServerInConfig(cwd, existing);
      lines.push(`✅ 已更新服务器 ${existing.name} 配置（${conflicts.map((c) => c.split(":")[0]).join(", ")}）`);
    } else {
      lines.push(`ℹ️ 忽略提供值，使用现有配置执行`);
    }
  } else if (conflicts.length > 0) {
    lines.push(`ℹ️ 检测到配置不一致但无可交互 UI，使用现有配置执行：${conflicts.join("；")}`);
  }

  return { server: existing, lines };
}

export function registerSshTools(pi: ExtensionAPI): void {
  // Tool: auto_goo_ssh_exec
  pi.registerTool({
    name: "auto_goo_ssh_exec",
    label: "SSH Execute",
    description: `在远程服务器上执行命令。需要先在 .goo/config.json 中配置服务器信息，密码存储在 .goo/secrets.json（chmod 600）。`,
    promptSnippet: "在远程服务器上执行命令",
    promptGuidelines: [
      "使用 auto_goo_ssh_exec 在远程服务器上执行命令。需要先通过 goo-init 配置服务器。",
      "服务器不在配置中时会主动询问是否新增；提供 host/port/user 与配置冲突时会询问是否更新配置。",
      "密码不得暴露在聊天、日志或 plan 中，只能存储在 secrets.json。",
    ],
    parameters: Type.Object({
      server: Type.String({ description: "服务器名称/别名（来自 config.json servers[].name）" }),
      command: Type.String({ description: "在远程服务器上执行的命令" }),
      workdir: Type.Optional(Type.String({ description: "远程工作目录（可选，默认使用服务器配置的 workdir）" })),
      timeout: Type.Optional(Type.Integer({ description: "超时秒数（默认 300）" })),
      host: Type.Optional(Type.String({ description: "服务器主机/IP（与配置不一致或缺省时询问是否更新配置）" })),
      port: Type.Optional(Type.Integer({ description: "SSH 端口（与配置不一致或缺省时询问是否更新配置）" })),
      user: Type.Optional(Type.String({ description: "SSH 用户名（与配置不一致或缺省时询问是否更新配置）" })),
    }),
    async execute(_toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const sshScript = join(REPO_ROOT, "skills/auto-goo/scripts/goo-ssh.sh");

      if (!existsSync(sshScript)) {
        return {
          content: [{ type: "text", text: `goo-ssh.sh 未找到: ${sshScript}` }],
          details: { error: "script_not_found" },
        };
      }

      // 解析服务器（缺失→询问新增；冲突/缺省→询问更新）
      const resolved = await resolveServer(
        cwd,
        params.server,
        { host: params.host, port: params.port, user: params.user },
        ctx,
      );
      if (resolved.cancelled || !resolved.server) {
        return {
          content: [{ type: "text", text: [resolved.cancelled, ...resolved.lines].filter(Boolean).join("\n") }],
          details: { error: "server_not_resolved" },
        };
      }
      const server = resolved.server;
      const prefixLines = resolved.lines;

      // Build SSH command — 密码只经 goo-ssh.sh 的 sshpass -f 临时文件传递，
      // 绝不拼进命令行（ps / shell history 可见）。
      const workdir = params.workdir || server.defaults?.workdir || "~";

      const timeoutMs = params.timeout ?? 300000;
      onUpdate?.({
        content: [{
          type: "text",
          text: `🔌 连接 ${server.name} (${server.host || server.ip}:${server.port}) 执行远程命令（超时 ${Math.round(timeoutMs / 1000)}s）...`,
        }],
      });

      // 异步执行（不阻塞事件循环），输出增量流式转发到 TUI，AbortSignal 可中止。
      // 密码仍只经 goo-ssh.sh 的 sshpass -f 临时文件传递，绝不进命令行。
      const result = await execAsync(
        sshScript,
        [
          "--config", join(cwd, ".goo/config.json"),
          "--server", server.name,
          "--workdir", workdir,
          "--", params.command,
        ],
        cwd,
        {
          timeout: timeoutMs,
          signal,
          onStdout: (chunk) => onUpdate?.({ content: [{ type: "text", text: chunk }] }),
          onStderr: (chunk) => onUpdate?.({ content: [{ type: "text", text: chunk }] }),
        },
      );

      // 错误原因必须可见：非零退出/超时/中止都带诊断，绝不静默返回 "(no output)"。
      let body: string;
      if (result.exitCode === 0) {
        body = result.stdout || "(no output)";
      } else if (result.stderr.trim()) {
        body = (result.stdout || "") + (result.stdout ? "\n" : "") + result.stderr;
      } else {
        body = result.stdout || `(exit code ${result.exitCode}, no output)`;
      }
      if (result.timedOut) body += `\n⚠️ 命令超过 ${Math.round(timeoutMs / 1000)}s 未完成，已终止。`;
      if (result.aborted) body += `\n⚠️ 执行已被中止。`;
      const truncated = body.length > 5000 ? body.slice(0, 5000) + `\n\n... (${body.length - 5000} more bytes)` : body;

      return {
        content: [{ type: "text", text: [prefixLines.join("\n"), truncated].filter(Boolean).join("\n") }],
        details: {
          server: server.name,
          host: server.host || server.ip,
          exitCode: result.exitCode,
          outputLength: result.stdout.length,
          timedOut: result.timedOut,
          aborted: result.aborted,
          truncated: result.truncated,
        },
      };
    },
  });

  // Tool: auto_goo_ssh_status
  pi.registerTool({
    name: "auto_goo_ssh_status",
    label: "SSH Server Status",
    description: "检查远程服务器的连通性和基本状态（CPU、内存、磁盘、GPU）。",
    promptSnippet: "检查远程服务器连通性和资源状态",
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: "服务器名称（可选，默认所有服务器）" })),
      host: Type.Optional(Type.String({ description: "服务器主机/IP（缺失时询问是否新增配置）" })),
      port: Type.Optional(Type.Integer({ description: "SSH 端口（缺失时询问是否新增配置）" })),
      user: Type.Optional(Type.String({ description: "SSH 用户名（缺失时询问是否新增配置）" })),
    }),
    async execute(_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const sshScript = join(REPO_ROOT, "skills/auto-goo/scripts/goo-ssh.sh");
      if (!existsSync(sshScript)) {
        return {
          content: [{ type: "text", text: `goo-ssh.sh 未找到: ${sshScript}` }],
          details: { error: "script_not_found" },
        };
      }

      // 指定了 server：先解析（缺失→询问新增），再只查该台
      let serversFiltered: ServerEntry[] = [];
      let resolveLines: string[] = [];
      if (params.server) {
        const resolved = await resolveServer(
          cwd,
          params.server,
          { host: params.host, port: params.port, user: params.user },
          ctx,
        );
        resolveLines = resolved.lines;
        if (resolved.cancelled || !resolved.server) {
          return {
            content: [{ type: "text", text: [resolved.cancelled, ...resolveLines].filter(Boolean).join("\n") }],
            details: { error: "server_not_resolved" },
          };
        }
        serversFiltered = [resolved.server];
      } else {
        const config = await loadProjectConfig(cwd);
        serversFiltered = getServers(config);
        if (!serversFiltered.length) {
          return {
            content: [{ type: "text", text: "没有配置远程服务器。使用 /auto-goo:goo-init 添加服务器，或调用 auto_goo_ssh_exec（提供 host/port/user）让系统询问新增。" }],
            details: {},
          };
        }
      }

      const lines: string[] = ["🖥️ 远程服务器状态", "─────────────────", ...resolveLines];
      // 连通性与信息采集统一走 goo-ssh.sh（sshpass -f 临时文件读 secrets 密码）；
      // 旧实现用裸 ssh -o BatchMode=yes 且不带密码：密码认证的服务器必然
      // Permission denied，永远显示“无法连接”。

      for (const server of serversFiltered) {
        const host = server.host || server.ip || "?";
        lines.push(`\n服务器: ${server.name} (${host}:${server.port})`);
        lines.push(`  类型: ${server.type}`);
        lines.push(`  用途: ${server.purpose}`);

        // Quick connectivity check（用 goo-ssh.sh，密码走 secrets 临时文件；
        // 异步执行 + ConnectTimeout=15，目标不可达时快速失败并有诊断输出）
        const pingResult = await execAsync(
          sshScript,
          ["--config", join(cwd, ".goo/config.json"), "--server", server.name, "--", "echo OK"],
          cwd,
          { timeout: 15000, signal },
        );

        if (pingResult.exitCode !== 0) {
          lines.push(`  状态: ❌ 无法连接`);
          const err = (pingResult.stderr || pingResult.stdout || "").trim();
          if (err) {
            lines.push(`  原因: ${err.slice(0, 120)}`);
          }
          continue;
        }

        lines.push(`  状态: ✅ 在线`);

        // Get system info
        const infoCmd =
          `echo '---CPU---'; nproc; echo '---MEM---'; free -h | grep Mem; ` +
          `echo '---DISK---'; df -h / | tail -1; echo '---UPTIME---'; uptime -p; ` +
          (server.type === "gpu"
            ? `echo '---GPU---'; nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null || echo 'nvidia-smi not found'`
            : "");
        const infoResult = await execAsync(
          sshScript,
          ["--config", join(cwd, ".goo/config.json"), "--server", server.name, "--", infoCmd],
          cwd,
          { timeout: 20000, signal },
        );

        if (infoResult.exitCode === 0) {
          const info = infoResult.stdout;
          const cpuMatch = info.match(/---CPU---\n(.+)/);
          const memMatch = info.match(/---MEM---\n(.+)/);
          const diskMatch = info.match(/---DISK---\n(.+)/);
          const uptimeMatch = info.match(/---UPTIME---\n(.+)/);
          const gpuMatch = info.match(/---GPU---\n(.+?)(?:\n---|$)/s);

          if (cpuMatch) lines.push(`  CPU 核心: ${cpuMatch[1].trim()}`);
          if (memMatch) lines.push(`  内存: ${memMatch[1].trim()}`);
          if (diskMatch) lines.push(`  磁盘: ${diskMatch[1].trim()}`);
          if (uptimeMatch) lines.push(`  运行时间: ${uptimeMatch[1].trim()}`);
          if (gpuMatch) {
            const gpuLines = gpuMatch[1].trim().split("\n");
            for (const gl of gpuLines) {
              if (gl.trim()) lines.push(`  GPU: ${gl.trim()}`);
            }
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { serverCount: serversFiltered.length },
      };
    },
  });

  // Tool: auto_goo_ssh_monitor
  pi.registerTool({
    name: "auto_goo_ssh_monitor",
    label: "SSH Monitor (Follow)",
    description: `在远程服务器上执行命令并持续观察指定时长（跟随模式）：输出实时流式返回，观察窗口结束（duration_seconds，默认 30s，最大 3600s）时自动终止远程命令并返回该时段完整输出。用于监视训练进度、日志尾部、GPU 占用等持续输出场景。`,
    promptSnippet: "监视远程服务器上的持续输出（训练进度/日志/GPU）",
    promptGuidelines: [
      "用 auto_goo_ssh_monitor 监视持续输出的远程命令（如 tail -f 日志、训练指标、watch 等），duration_seconds 控制观察窗口（默认 30，最大 3600）。",
      "窗口结束自动终止远程命令并返回该时段全部输出；timeout 124（窗口到期）归一化为正常结束。",
      "随时可用 Esc 中断；timeout_seconds 可显式设置整体执行上限（默认 窗口+30s）。",
      "单次快照用 auto_goo_ssh_exec；超长任务建议先在远程 tmux/nohup 托管，再周期快照。",
    ],
    parameters: Type.Object({
      server: Type.String({ description: "服务器名称/别名（来自 config.json servers[].name）" }),
      command: Type.String({ description: "远程命令（可含管道/重定向/引号，经 base64 编码后远程执行）" }),
      duration_seconds: Type.Optional(Type.Integer({ description: "观察窗口秒数（默认 30，范围 1-3600）" })),
      timeout_seconds: Type.Optional(Type.Integer({ description: "整体执行上限秒数（含连接/认证，不能小于窗口，默认 窗口+30）" })),
      workdir: Type.Optional(Type.String({ description: "远程工作目录（可选，默认服务器 defaults.workdir 或 ~）" })),
      host: Type.Optional(Type.String({ description: "服务器主机/IP（与配置不一致或缺省时询问是否更新配置）" })),
      port: Type.Optional(Type.Integer({ description: "SSH 端口（与配置不一致或缺省时询问是否更新配置）" })),
      user: Type.Optional(Type.String({ description: "SSH 用户名（与配置不一致或缺省时询问是否更新配置）" })),
    }),
    async execute(_toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const sshScript = join(REPO_ROOT, "skills/auto-goo/scripts/goo-ssh.sh");
      if (!existsSync(sshScript)) {
        return {
          content: [{ type: "text", text: `goo-ssh.sh 未找到: ${sshScript}` }],
          details: { error: "script_not_found" },
        };
      }

      const resolved = await resolveServer(
        cwd,
        params.server,
        { host: params.host, port: params.port, user: params.user },
        ctx,
      );
      if (resolved.cancelled || !resolved.server) {
        return {
          content: [{ type: "text", text: [resolved.cancelled, ...resolved.lines].filter(Boolean).join("\n") }],
          details: { error: "server_not_resolved" },
        };
      }
      const server = resolved.server;
      const prefixLines = resolved.lines;

      // 观察窗口归一化（1-3600s）
      const duration = Math.min(3600, Math.max(1, Math.round(params.duration_seconds ?? 30)));

      // 命令经 base64 编码后由远程 bash 解码执行：任意引号/管道/重定向都安全，
      // 不会在 ssh 参数拼接阶段被破坏。窗口终止两条路径：
      //   1) 远程有 timeout 命令 → timeout ${duration}s（124=窗口到期，归一化为 0）
      //   2) 无 timeout（如精简容器/BSD）→ 后台运行 + sleep 到期 kill（143=SIGTERM，归一化为 0）
      // 保证窗口必然到达、命令必然被终止，不会无限跑下去。
      const b64 = Buffer.from(params.command, "utf-8").toString("base64");
      const remoteCmd = buildMonitorRemoteCmd(params.command, duration);

      const durationMs = duration * 1000;
      const monitorWd = params.workdir || server.defaults?.workdir || "~";

      // 本地工具超时：显式 timeout_seconds（不能小于窗口）或默认 窗口+30s 余量
      const localTimeoutMs =
        params.timeout_seconds
          ? Math.max(Math.round(params.timeout_seconds) * 1000, durationMs)
          : durationMs + 30000;
      onUpdate?.({
        content: [{ type: "text", text: `📡 监视 ${server.name} (${server.host || server.ip}) 输出，窗口 ${duration}s（整体上限 ${Math.round(localTimeoutMs / 1000)}s，期间显示 Working 属正常，输出实时累积，Esc 可中断；超长监视建议 auto_goo_ssh_monitor_bg 后台模式）...` }],
      });

      // 输出实时累积转发（pi 的 updateResult 是替换语义：只传增量会显示最后一段碎片，
      // 传累积尾部才能看到完整输出），截断尾部防渲染压力
      let liveOut = "";
      const pushLive = (text: string) => {
        liveOut = (liveOut + text).slice(-4000);
        onUpdate?.({ content: [{ type: "text", text: liveOut }] });
      };
      const result = await execAsync(
        sshScript,
        [
          "--config", join(cwd, ".goo/config.json"),
          "--server", server.name,
          "--workdir", monitorWd,
          "--", remoteCmd,
        ],
        cwd,
        {
          timeout: localTimeoutMs,
          signal,
          onStdout: (chunk) => pushLive(chunk),
          onStderr: (chunk) => pushLive(chunk),
        },
      );

      const out = result.stdout;
      const err = result.stderr;
      const lineCount = out ? out.split("\n").filter(Boolean).length : 0;
      let body =
        `📡 监视窗口结束（${duration}s）：exit=${result.exitCode}，收集 ${lineCount} 行 / ${out.length} 字符\n` +
        (out || "(无输出)");
      if (err.trim()) body += `\n\n--- stderr ---\n${err}`;
      if (result.timedOut) body += `\n⚠️ 本地执行超时（整体上限 ${Math.round(localTimeoutMs / 1000)}s），已终止。`;
      if (result.aborted) body += `\n⚠️ 监视已被中止。`;
      if (result.truncated) body += `\n⚠️ 输出超过上限被截断。`;
      const truncated =
        body.length > 8000 ? body.slice(0, 8000) + `\n\n... (${body.length - 8000} more bytes)` : body;

      return {
        content: [{ type: "text", text: [prefixLines.join("\n"), truncated].filter(Boolean).join("\n") }],
        details: {
          server: server.name,
          host: server.host || server.ip,
          durationSeconds: duration,
          exitCode: result.exitCode,
          durationReached: !result.aborted && !result.timedOut && !result.truncated,
          outputLines: lineCount,
          outputLength: out.length,
        },
      };
    },
  });
}

/**
 * 构造远程监视命令：命令经 base64 编码后由远程 bash 解码执行（任意引号/管道/重定向安全），
 * 观察窗口（duration 秒）到期必然终止：
 *   1) 远程有 timeout → timeout ${duration}s（124=窗口到期，归一化 0）
 *   2) 无 timeout → 后台运行 + sleep 到期 kill（143=SIGTERM，归一化 0）
 * 前台 auto_goo_ssh_monitor 与后台 auto_goo_ssh_monitor_bg 共用。
 */
export function buildMonitorRemoteCmd(command: string, duration: number): string {
  const b64 = Buffer.from(command, "utf-8").toString("base64");
  return (
    `if command -v timeout >/dev/null 2>&1; then ` +
    `printf '%s' '${b64}' | base64 -d | timeout ${duration}s bash; ec=$?; [ "$ec" -eq 124 ] && ec=0; exit $ec; ` +
    `else ` +
    `printf '%s' '${b64}' | base64 -d > /tmp/agm.$$.sh; ` +
    `bash /tmp/agm.$$.sh & bg=$!; ` +
    `( sleep ${duration}; kill $bg 2>/dev/null ) & killer=$!; ` +
    `wait $bg; ec=$?; ` +
    `kill $killer 2>/dev/null; wait $killer 2>/dev/null; ` +
    `rm -f /tmp/agm.$$.sh; ` +
    `[ "$ec" -eq 143 ] && ec=0; exit $ec; ` +
    `fi`
  );
}

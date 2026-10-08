/**
 * AutoGoo-Plugin goo-init — 初始化配置（用户级或项目级）
 *
 * Replaces commands/goo-init.md + AskUserQuestion interaction.
 * Uses ctx.ui.select/confirm/input instead of AskUserQuestion.
 * Falls back to Python script (goo-init.sh) for the actual file writes.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  TEMPLATE_CONFIG_SCOPE,
  TEMPLATE_WIKI_DIR,
  TEMPLATE_PROJECT_WORKSPACE_CREATE,
  TEMPLATE_PROJECT_WORKSPACE_LAYOUT,
  TEMPLATE_PROJECT_WORKSPACE_CLAUDE_MD,
  TEMPLATE_USER_GOO_MD_POINTER,
  TEMPLATE_SERVER_TYPE,
  TEMPLATE_SERVER_PORT,
  TEMPLATE_SERVER_USER,
  TEMPLATE_SERVER_PASSWORD,
  TEMPLATE_SERVER_MANAGE,
  TEMPLATE_PROJECT_WORKSPACE_ORGANIZE_EXISTING,
  TEMPLATE_PROJECT_WORKSPACE_APPLY_ORGANIZATION,
  DIR_LAYOUTS,
} from "../constants.js";
import {
  REPO_ROOT,
  RESOLVE_ROOT_SH,
  userConfigPath,
  userConfigDir,
  userGooMdPath,
  projectConfigPath,
  projectGooDir,
  projectPlanPath,
} from "../utils/paths.js";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execBash, execShell } from "../utils/exec.js";
import { uiSelect, uiConfirm, uiInput } from "../utils/ui.js";

export async function handleGooInit(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  const pi = ctx as any; // We'll use pi.exec from the closure

  // Parse command-line args for automation
  const parsed = parseArgs(args);
  let scope: "project" | "user" | null = parsed.scope;
  let wikiDir = parsed.wikiDir;
  let projectLayout = parsed.projectLayout;
  let projectDirs = parsed.projectDirs;
  let projectSlug = parsed.projectSlug;
  let servers: ServerInfo[] = [];
  let removeServers: string[] = [];
  let clearServers = false;
  let updateClaudeMd: boolean | null = parsed.updateClaudeMd;
  let userPointer: boolean | null = parsed.userPointer;
  let createWorkspace = parsed.createWorkspace;

  // ── Step 1: Config scope ──────────────────────────────────────────────────
  if (!scope) {
    const choice = await uiSelect(ctx, TEMPLATE_CONFIG_SCOPE.header, TEMPLATE_CONFIG_SCOPE.options);
    if (!choice) {
      ctx.ui.notify("已取消初始化。", "info");
      return;
    }
    scope = choice as "project" | "user";
  }

  // ── Step 2: Wiki directory ────────────────────────────────────────────────
  if (!wikiDir) {
    const choice = await uiSelect(ctx, TEMPLATE_WIKI_DIR.header, TEMPLATE_WIKI_DIR.options);
    if (!choice) {
      ctx.ui.notify("已取消初始化。", "info");
      return;
    }
    if (choice === "__default__") {
      wikiDir = resolve(process.env.HOME || "~", "workspace/Goo-wiki");
    } else if (choice === "__custom__") {
      const input = await uiInput(ctx, "Goo-wiki 路径", "~/workspace/Goo-wiki");
      wikiDir = input ? resolve(input.replace(/^~/, process.env.HOME || "~")) : resolve(process.env.HOME || "~", "workspace/Goo-wiki");
    }
  }

  // ── Step 3: User-level pointer ────────────────────────────────────────────
  // User scope always writes ~/.auto-goo/goo.md; this only decides whether the
  // user-level agent files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) get the marker pointer.
  if (scope === "user" && userPointer === null) {
    const choice = await uiSelect(ctx, TEMPLATE_USER_GOO_MD_POINTER.header, TEMPLATE_USER_GOO_MD_POINTER.options);
    userPointer = choice === "yes";
  }

  // ── Step 4: Project-level specific questions ──────────────────────────────
  if (scope === "project") {
    // 4a: Create workspace directories?
    if (createWorkspace === null) {
      const choice = await uiSelect(ctx, TEMPLATE_PROJECT_WORKSPACE_CREATE.header, TEMPLATE_PROJECT_WORKSPACE_CREATE.options);
      createWorkspace = choice === "yes";
    }

    if (createWorkspace) {
      // 4b: Choose layout
      if (!projectLayout && projectDirs.length === 0) {
        const choice = await uiSelect(ctx, TEMPLATE_PROJECT_WORKSPACE_LAYOUT.header, TEMPLATE_PROJECT_WORKSPACE_LAYOUT.options);
        if (choice && choice !== "__custom__") {
          projectLayout = choice;
          projectDirs = DIR_LAYOUTS[projectLayout] ?? [];
        } else if (choice === "__custom__") {
          const input = await uiInput(ctx, "自定义目录（逗号分隔）", "src,data/raw,docs,references,references/papers,tests");
          if (input) {
            projectDirs = input.split(",").map((s: string) => s.trim()).filter(Boolean);
            projectLayout = "custom";
          }
        }
      }

      // 4c: Create directories
      for (const dir of projectDirs) {
        await mkdir(join(cwd, dir), { recursive: true });
      }
      ctx.ui.notify(`已创建 ${projectDirs.length} 个业务目录。`, "info");

      // 4d: Organize existing files?
      const organize = await uiSelect(ctx, TEMPLATE_PROJECT_WORKSPACE_ORGANIZE_EXISTING.header, TEMPLATE_PROJECT_WORKSPACE_ORGANIZE_EXISTING.options);
      if (organize === "yes") {
        await handleOrganizeExisting(cwd, projectDirs, ctx);
      }

      // 4e: Update goo.md with dir conventions?
      if (updateClaudeMd === null) {
        const choice = await uiSelect(ctx, TEMPLATE_PROJECT_WORKSPACE_CLAUDE_MD.header, TEMPLATE_PROJECT_WORKSPACE_CLAUDE_MD.options);
        updateClaudeMd = choice === "yes";
      }
    }

    // 4f: Remote servers?
    const needServers = await uiConfirm(ctx, "远程服务器", "是否需要配置远程服务器？");
    if (needServers) {
      const configPath = scope === "user" ? userConfigPath() : projectConfigPath(cwd);
      const existing = loadExistingServers(configPath);
      let skipServerEdit = false;
      if (existing.length > 0) {
        const manage = await uiSelect(ctx, TEMPLATE_SERVER_MANAGE.header, TEMPLATE_SERVER_MANAGE.options);
        if (manage === "remove") {
          // Remove: pick servers by name, loop until done
          const toRemove = new Set<string>();
          while (true) {
            const remaining = existing.filter((s) => s.name && !toRemove.has(s.name));
            if (remaining.length === 0) break;
            const opts = remaining.map((s) => ({
              label: `${s.name} (${s.host || s.ip}:${s.port}, ${s.user})`,
              value: s.name!,
            }));
            opts.push({ label: "完成删除", value: "__done__" });
            const pick = await uiSelect(ctx, "选择要删除的服务器", opts, { onTimeout: "cancel" });
            if (!pick || pick === "__done__") break;
            toRemove.add(pick);
          }
          for (const n of toRemove) removeServers.push(n);
          if (removeServers.length > 0) {
            ctx.ui.notify(`将删除 ${removeServers.length} 台服务器。`, "info");
          } else {
            ctx.ui.notify("未选择要删除的服务器。", "info");
          }
        } else if (manage === "replace") {
          // Replace: pick one server, re-collect its params (name stays fixed → script upserts)
          const opts = existing.filter((s) => s.name).map((s) => ({
            label: `${s.name} (${s.host || s.ip}:${s.port}, ${s.user})`,
            value: s.name!,
          }));
          opts.push({ label: "取消", value: "__cancel__" });
          const pick = await uiSelect(ctx, "选择要替换的服务器", opts, { onTimeout: "cancel" });
          if (pick && pick !== "__cancel__") {
            const replaced = await collectOneServer(ctx, pick);
            if (replaced) {
              servers.push(replaced); // same name → goo-init.sh upserts
              ctx.ui.notify(`将替换服务器「${pick}」。`, "info");
            }
          }
        } else if (manage === "clear") {
          clearServers = await uiConfirm(ctx, "清空服务器", "确认删除所有已配置的远程服务器？", { defaultOnTimeout: false });
          if (clearServers) {
            skipServerEdit = true; // clear is terminal: don't re-enter the add-servers flow
          }
        } else if (manage === "skip") {
          skipServerEdit = true;
        }
        // keep_add → fall through and collect new servers below
      }
      if (!skipServerEdit) {
        const added = await collectServers(ctx);
        servers = servers.concat(added);
      }
    }

    // 4g: Write Goo-wiki archive principles to goo.md?
    if (wikiDir && existsSync(wikiDir)) {
      const archiveInClaude = await uiConfirm(ctx, "归档原则", "是否将 Goo-wiki 归档原则写入项目 CLAUDE.md / AGENTS.md？");
      if (archiveInClaude && updateClaudeMd === null) {
        updateClaudeMd = true;
      }
    }

    // 4h: SessionStart hooks recommendation (not auto-writing)
    ctx.ui.notify("💡 推荐在 .claude/settings.json 中配置 SessionStart hooks", "info");
    ctx.ui.notify("   不会自动覆盖该文件，如需配置请手动编辑。", "info");

    // 4i: Project slug (default: directory name)
    if (!projectSlug) {
      projectSlug = cwd.split("/").pop() || "project";
    }
  }

  // ── Step 5: Invoke goo-init.sh ────────────────────────────────────────────
  const autoGooRoot = REPO_ROOT;
  const scriptPath = join(autoGooRoot, "skills/auto-goo/scripts/goo-init.sh");

  if (!existsSync(scriptPath)) {
    ctx.ui.notify(`初始化脚本未找到: ${scriptPath}`, "error");
    return;
  }

  // Build arguments
  const scriptArgs: string[] = [];
  scriptArgs.push(scope === "user" ? "--user" : "--project");
  scriptArgs.push("--wiki-dir", wikiDir!);
  if (projectSlug) scriptArgs.push("--project-slug", projectSlug);
  if (projectLayout && projectLayout !== "custom" && projectLayout !== "none") {
    scriptArgs.push("--project-layout", projectLayout);
  }
  if (projectDirs.length > 0) {
    scriptArgs.push("--project-dirs", projectDirs.join(","));
  }
  if (scope === "user") {
    // User scope always generates ~/.auto-goo/goo.md unless --skip-claude-md is
    // passed explicitly; never send --skip-claude-md just because updateClaudeMd
    // is unset (null), or the user-level goo.md would be silently dropped.
    if (updateClaudeMd === false) {
      scriptArgs.push("--skip-claude-md");
    } else if (updateClaudeMd === true) {
      scriptArgs.push("--update-claude-md");
    }
    if (userPointer === true) {
      scriptArgs.push("--write-user-pointer");
    } else if (userPointer === false) {
      scriptArgs.push("--skip-user-pointer");
    }
  } else if (updateClaudeMd) {
    scriptArgs.push("--update-claude-md");
  } else {
    scriptArgs.push("--skip-claude-md");
  }
  for (const server of servers) {
    const spec = `name=${server.name},host=${server.host},user=${server.user},port=${server.port},type=${server.type},purpose=${server.purpose}`;
    scriptArgs.push("--server", spec);
  }
  for (const name of removeServers) {
    scriptArgs.push("--remove-server", name);
  }
  if (clearServers) {
    scriptArgs.push("--clear-servers");
  }
  scriptArgs.push("--yes");

  ctx.ui.notify("正在执行初始化脚本...", "info");

  const result = execBash(scriptPath, scriptArgs, cwd, { timeout: 120000 });
  if (result.exitCode !== 0) {
    ctx.ui.notify(`❌ 初始化失败 (exit ${result.exitCode})`, "error");
    return;
  }

  const isUser = scope === "user";
  const gooMdExists = isUser ? existsSync(userGooMdPath()) : existsSync(join(cwd, "goo.md"));
  const target = isUser ? "~/.auto-goo/config.json" : ".goo/config.json";
  const wikiInfo = wikiDir ? `（wiki: ${wikiDir}）` : "";
  // Only claim the pointer was written when goo.md itself was generated (not --skip-claude-md).
  const gooMdInfo = gooMdExists
    ? isUser
      ? "，用户级 goo.md 已生成（~/.auto-goo/goo.md）"
      : "，项目级 goo.md 已生成（<项目根>/goo.md）"
    : "";
  const pointerInfo = gooMdExists && isUser && userPointer !== false
    ? "，用户级指针已更新（~/.claude/CLAUDE.md、~/.codex/AGENTS.md）"
    : "";
  ctx.ui.notify(
    `✅ AutoGoo-Plugin 初始化完成！配置已写入 ${target} ${wikiInfo}${gooMdInfo}${pointerInfo}`,
    "info"
  );
}

// ── Server info collection ──────────────────────────────────────────────────

interface ServerInfo {
  name: string;
  host: string;
  user: string;
  port: number;
  type: "cpu" | "gpu";
  purpose: string;
}

/**
 * Collect one remote server's parameters via the interaction UI.
 * When fixedName is given (replace flow), the name is reused so goo-init.sh
 * can upsert the existing entry instead of adding a duplicate.
 */
async function collectOneServer(ctx: ExtensionContext, fixedName?: string): Promise<ServerInfo | null> {
  // Server type
  const typeChoice = await uiSelect(ctx, TEMPLATE_SERVER_TYPE.header, TEMPLATE_SERVER_TYPE.options);
  const type = (typeChoice || "cpu") as "cpu" | "gpu";
  if (!type) return null;

  // Server name (fixed when replacing an existing server)
  let name = "";
  if (fixedName) {
    name = fixedName;
  } else {
    const defaultName = type === "gpu" ? "gpu-a100" : "cpu-box";
    name = (await uiInput(ctx, "服务器名称/别名", defaultName)) || defaultName;
  }

  // SSH host
  const host = (await uiInput(ctx, "SSH host/IP/DNS", "")) || "";
  if (!host) {
    ctx.ui.notify("SSH host/IP 不能为空，已跳过该服务器。", "warn");
    return null;
  }

  // SSH port
  const portChoice = await uiSelect(ctx, TEMPLATE_SERVER_PORT.header, TEMPLATE_SERVER_PORT.options);
  let port = 22;
  if (portChoice === "__custom__") {
    const input = await uiInput(ctx, "自定义 SSH 端口", "");
    if (input) {
      const parsedPort = parseInt(input.trim(), 10);
      if (!Number.isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
        port = parsedPort;
      } else {
        ctx.ui.notify(`端口「${input}」无效（需为 1-65535 的整数），已使用默认 22。`, "warn");
      }
    } else {
      ctx.ui.notify("未输入自定义端口，已使用默认 22。", "warn");
    }
  } else if (portChoice) {
    port = parseInt(portChoice, 10) || 22;
  }

  // Username
  const userChoice = await uiSelect(ctx, TEMPLATE_SERVER_USER.header, TEMPLATE_SERVER_USER.options);
  let user = "ubuntu";
  if (userChoice === "__custom__") {
    const input = await uiInput(ctx, "自定义 SSH 用户名", "");
    if (input && input.trim()) {
      user = input.trim();
    } else {
      ctx.ui.notify("未输入自定义用户名，已使用默认 ubuntu。", "warn");
    }
  } else if (userChoice) {
    user = userChoice;
  }

  // Purpose
  const defaultPurpose = type === "gpu" ? "模型训练与推理" : "数据处理与预处理";
  const purpose = (await uiInput(ctx, "用途说明", defaultPurpose)) || defaultPurpose;

  // Password handling (stored in secrets file, never in config/chat)
  const passwordChoice = await uiSelect(ctx, TEMPLATE_SERVER_PASSWORD.header, TEMPLATE_SERVER_PASSWORD.options);
  if (passwordChoice === "__input__") {
    // pi's input dialogs have no masking, so collecting a password here would put it
    // in plaintext into chat/logs. Explain the boundary and point to manual entry.
    ctx.ui.notify(
      "Pi 终端输入框不支持密码掩码。为避免密码明文进入聊天/日志，未收集密码；初始化完成后请手动编辑 secrets 文件的 password 字段（保持 chmod 600）。",
      "warning",
    );
  }

  return { name, host, user, port, type, purpose };
}

async function collectServers(ctx: ExtensionContext): Promise<ServerInfo[]> {
  const servers: ServerInfo[] = [];

  let addMore = true;
  while (addMore) {
    const server = await collectOneServer(ctx);
    if (server) {
      servers.push(server);
    }
    // Ask if add another
    const more = await uiConfirm(ctx, "添加更多", "是否添加另一台服务器？");
    addMore = !!more;
  }

  return servers;
}

interface ExistingServer {
  name?: string;
  host?: string;
  ip?: string;
  user?: string;
  port?: number;
  type?: string;
}

/** Load configured servers from an existing config file (servers or compute_servers). */
function loadExistingServers(configPath: string): ExistingServer[] {
  try {
    if (!existsSync(configPath)) return [];
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const list = (cfg.servers ?? cfg.compute_servers ?? []) as unknown;
    return Array.isArray(list) ? (list as ExistingServer[]) : [];
  } catch {
    return [];
  }
}

// ── Organize existing files ─────────────────────────────────────────────────

async function handleOrganizeExisting(cwd: string, projectDirs: string[], ctx: ExtensionContext): Promise<void> {
  // Scan existing directories (shallow)
  const { readdir, stat } = await import("node:fs/promises");
  const existing: string[] = [];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const skipDirs = new Set([".goo", ".git", ".claude", ".pi", "node_modules", "__pycache__", ".pytest_cache"]);
    for (const entry of entries) {
      if (entry.isDirectory() && !skipDirs.has(entry.name) && !projectDirs.includes(entry.name) && !entry.name.startsWith(".")) {
        existing.push(entry.name);
      }
    }
  } catch {}

  if (existing.length === 0) {
    ctx.ui.notify("没有找到可整理的文件或目录。", "info");
    return;
  }

  ctx.ui.notify(`发现 ${existing.length} 个可整理的目录。`, "info");

  // 不可逆操作（会实际移动文件）：超时一律取消，绝不自动执行。
  const applyChoice = await uiSelect(ctx, TEMPLATE_PROJECT_WORKSPACE_APPLY_ORGANIZATION.header, TEMPLATE_PROJECT_WORKSPACE_APPLY_ORGANIZATION.options, { onTimeout: "cancel" });
  if (applyChoice !== "yes") {
    ctx.ui.notify("已跳过文件整理。", "info");
  }
}

// ── Arg parser ──────────────────────────────────────────────────────────────

function parseArgs(args: string): {
  scope: "project" | "user" | null;
  wikiDir: string | null;
  projectLayout: string | null;
  projectDirs: string[];
  projectSlug: string | null;
  updateClaudeMd: boolean | null;
  userPointer: boolean | null;
  createWorkspace: boolean | null;
} {
  const tokens = args.split(/\s+/).filter(Boolean);
  let scope: "project" | "user" | null = null;
  let wikiDir: string | null = null;
  let projectLayout: string | null = null;
  let projectDirs: string[] = [];
  let projectSlug: string | null = null;
  let updateClaudeMd: boolean | null = null;
  let userPointer: boolean | null = null;
  let createWorkspace: boolean | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--project") scope = "project";
    else if (t === "--user") scope = "user";
    else if (t === "--wiki-dir" && i + 1 < tokens.length) wikiDir = tokens[++i];
    else if (t === "--project-layout" && i + 1 < tokens.length) projectLayout = tokens[++i];
    else if (t === "--project-dirs" && i + 1 < tokens.length) projectDirs = tokens[++i].split(",").map((s: string) => s.trim()).filter(Boolean);
    else if (t === "--project-slug" && i + 1 < tokens.length) projectSlug = tokens[++i];
    else if (t === "--update-claude-md") updateClaudeMd = true;
    else if (t === "--skip-claude-md") updateClaudeMd = false;
    else if (t === "--write-user-pointer") userPointer = true;
    else if (t === "--skip-user-pointer") userPointer = false;
    else if (t === "--create-workspace") createWorkspace = true;
    else if (t === "--no-create-workspace") createWorkspace = false;
  }

  return { scope, wikiDir, projectLayout, projectDirs, projectSlug, updateClaudeMd, userPointer, createWorkspace };
}



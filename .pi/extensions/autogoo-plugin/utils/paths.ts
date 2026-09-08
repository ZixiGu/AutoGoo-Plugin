/**
 * AutoGoo-Plugin Pi Extension — Path resolution utilities.
 *
 * Locates the AutoGoo-Plugin repo root, Python scripts, templates, and runtime
 * directories from within the extension's own location.
 */

import { existsSync } from "node:fs";
import { readFile, access, writeFile } from "node:fs/promises";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── Extension location ──────────────────────────────────────────────────────

const _dirname = dirname(fileURLToPath(import.meta.url));

/**
 * AutoGoo-Plugin repo root, derived from the extension's location:
 *   <repo>/.pi/extensions/autogoo-plugin/  →  <repo>/
 */
export const REPO_ROOT = resolve(_dirname, "../../../..");

/**
 * Whether the resolved REPO_ROOT looks like the actual AutoGoo-Plugin repo.
 */
export function isRepoValid(): boolean {
  return (
    existsSync(join(REPO_ROOT, "skills/auto-goo/scripts/_paths.py")) &&
    existsSync(join(REPO_ROOT, ".pi/extensions/autogoo-plugin"))
  );
}

/** Python scripts directory. */
export function scriptsDir(): string {
  return join(REPO_ROOT, "skills/auto-goo/scripts");
}

/** Resolve a Python script path, verifying it exists. */
export function scriptPath(name: string): string {
  const p = join(scriptsDir(), name);
  if (!existsSync(p)) {
    throw new Error(`AutoGoo-Plugin script not found: ${p}`);
  }
  return p;
}

/** Update-step.py path. */
export const UPDATE_STEP_PY = scriptPath("update-step.py");

/** Goo-status.py path. */
export const GOO_STATUS_PY = scriptPath("goo-status.py");

/** Resolve-root.sh path. */
export const RESOLVE_ROOT_SH = scriptPath("resolve-root.sh");

/** Thread-state.py path. */
export const THREAD_STATE_PY = scriptPath("thread-state.py");

/** Remote-resources.py path. */
export const REMOTE_RESOURCES_PY = scriptPath("remote-resources.py");

/** Wiki-graph-assist.py path. */
export const WIKI_GRAPH_ASSIST_PY = scriptPath("wiki-graph-assist.py");

/** Goo-publish.py path. */
export const GOO_PUBLISH_PY = scriptPath("goo-publish.py");

/** References directory. */
export function referencesDir(): string {
  return join(REPO_ROOT, "skills/auto-goo/references");
}

/** Templates directory. */
export function templatesDir(): string {
  return join(REPO_ROOT, "skills/auto-goo/templates");
}

/** Publish templates directory. */
export function publishTemplatesDir(): string {
  return join(REPO_ROOT, "skills/auto-goo/templates/publish");
}

// ── Run-time project paths (relative to ctx.cwd) ───────────────────────────

export function projectGooDir(cwd: string): string {
  return join(cwd, ".goo");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".goo/config.json");
}

/**
 * 把 Subagent 模型配置写入项目 config（execution.subagent_provider/subagent_model）。
 * 仅由用户确认后调用（见 resolveOrPromptSubagentModel）。
 */
export async function writeExecutionModelConfig(
  cwd: string,
  provider: string,
  model: string,
): Promise<boolean> {
  const p = projectConfigPath(cwd);
  try {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      config = {};
    }
    const execution = (config.execution as Record<string, unknown>) || (config.execution = {});
    execution.subagent_provider = provider;
    execution.subagent_model = model;
    await writeFile(p, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn(`[AutoGoo-Plugin] 写入 subagent 模型配置失败: ${(e as Error)?.message ?? String(e)}`);
    return false;
  }
}

export function projectPlanPath(cwd: string): string {
  return join(cwd, ".goo/plan.json");
}

export function projectBrainstormPath(cwd: string): string {
  return join(cwd, ".goo/brainstorm.json");
}

export function projectCurrentThreadPath(cwd: string): string {
  return join(cwd, ".goo/current_thread.json");
}

export function projectThreadsDir(cwd: string): string {
  return join(cwd, ".goo/threads");
}

export function projectThreadDir(cwd: string, threadId: string): string {
  return join(cwd, `.goo/threads/${threadId}`);
}

export function projectPlansHistoryDir(cwd: string): string {
  return join(cwd, ".goo/plans/history");
}

export function projectLogsDir(cwd: string): string {
  return join(cwd, ".goo/logs");
}

export function projectObsidianDir(cwd: string): string {
  return join(cwd, ".goo/obsidian");
}

export function projectSecretsPath(cwd: string): string {
  return join(cwd, ".goo/secrets.json");
}

export function userConfigPath(): string {
  return join(process.env.HOME || "~", ".auto-goo/config.json");
}

export function userConfigDir(): string {
  return join(process.env.HOME || "~", ".auto-goo");
}

// ── Config loading ──────────────────────────────────────────────────────────

export interface ServerEntry {
  name?: string;
  host?: string;
  ip?: string;
  port?: number;
  user?: string;
  type?: "cpu" | "gpu";
  purpose?: string;
  defaults?: {
    workdir?: string;
    setup_commands?: string[];
    paths?: { data_dir?: string; artifacts_dir?: string };
  };
  secrets_file?: string;
}

export interface AutogooPluginConfig {
  version?: number;
  wiki_dir?: string;
  wiki?: { search_paths?: string[] };
  archive?: {
    enabled?: boolean;
    fallback_dir?: string;
    plan_history_dir?: string;
    project_slug?: string;
    project_dir?: string;
    fallback_project_dir?: string;
    git_remote_url?: string;
  };
  workspace?: {
    root?: string;
    layout?: string;
    paths?: Record<string, string>;
  };
  project_workspace?: {
    layout?: string;
    dirs?: string[];
  };
  publish?: {
    enabled?: boolean;
    site_dir?: string;
    host?: string;
    port?: number;
    open_browser?: boolean;
  };
  execution?: {
    max_concurrent?: number;
    heartbeat_seconds?: number;
    stale_after_seconds?: number;
    /** Subagent 子进程显式模型（默认使用主 agent 的 PI_MODEL；无 PI_MODEL 时回退 pi 全局）。例如 "deepseek-v4-flash" */
    subagent_model?: string;
    /** Subagent 子进程显式 provider（默认使用主 agent 的 PI_PROVIDER；无时回退 pi 全局）。与 subagent_model 配对 */
    subagent_provider?: string;
  };
  planning?: {
    recall_wiki?: boolean;
    require_wiki_context?: boolean;
  };
  init?: {
    prompt_for_scope?: boolean;
    prompt_for_wiki_dir?: boolean;
  };
  servers?: ServerEntry[];
  /** Legacy field name used by older goo-init versions. */
  compute_servers?: ServerEntry[];
}

/**
 * Resolve the configured server list, accepting both the current `servers`
 * field and the legacy `compute_servers` field used by older configs.
 */
export function getServers(config: AutogooPluginConfig | null | undefined): ServerEntry[] {
  if (!config) return [];
  const list = (config.servers ?? config.compute_servers) as ServerEntry[] | undefined;
  return Array.isArray(list) ? list : [];
}

export async function loadProjectConfig(cwd: string): Promise<AutogooPluginConfig | null> {
  const p = projectConfigPath(cwd);
  try {
    await access(p);
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadUserConfig(): Promise<AutogooPluginConfig | null> {
  const p = userConfigPath();
  try {
    await access(p);
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve wiki directory by priority:
 * 1. env AUTOGOO_PLUGIN_WIKI_DIR
 * 2. project config wiki_dir
 * 3. user config wiki_dir
 * 4. default ~/workspace/Goo-wiki
 */
export async function resolveWikiDir(cwd: string): Promise<string> {
  const envDir = process.env.AUTOGOO_PLUGIN_WIKI_DIR;
  if (envDir) return envDir;

  const projectConfig = await loadProjectConfig(cwd);
  if (projectConfig?.wiki_dir) return projectConfig.wiki_dir;

  const userConfig = await loadUserConfig();
  if (userConfig?.wiki_dir) return userConfig.wiki_dir;

  return join(process.env.HOME || "~", "workspace/Goo-wiki");
}

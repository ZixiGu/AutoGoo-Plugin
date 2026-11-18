/**
 * AutoGoo-Plugin Pi Extension — Path resolution utilities.
 *
 * Locates the AutoGoo-Plugin repo root, Python scripts, templates, and runtime
 * directories from within the extension's own location.
 */

import { existsSync, readFileSync } from "node:fs";
import { logWarn } from "./log.js";
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

/** Goo-observe.py path（环境/路径/shell 快照）。 */
export const GOO_OBSERVE_PY = scriptPath("goo-observe.py");

/** Exec-observe.py path（DAG 执行事件流 exec.jsonl 的唯一写入者）。 */
export const EXEC_OBSERVE_PY = scriptPath("exec_observe.py");

/** Thread-locks.py path. */
export const THREAD_LOCKS_PY = scriptPath("thread-locks.py");

/** Remote-resources.py path. */
export const REMOTE_RESOURCES_PY = scriptPath("remote-resources.py");

/** Wiki-graph-assist.py path. */
export const WIKI_GRAPH_ASSIST_PY = scriptPath("wiki-graph-assist.py");

/** Goo-publish.py path. */
export const GOO_PUBLISH_PY = scriptPath("goo-publish.py");

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
    logWarn(`[AutoGoo-Plugin] 写入 subagent 模型配置失败: ${(e as Error)?.message ?? String(e)}`);
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

export function userConfigPath(): string {
  return join(process.env.HOME || "~", ".auto-goo/config.json");
}

export function userConfigDir(): string {
  return join(process.env.HOME || "~", ".auto-goo");
}

/** User-level conventions source: `$HOME/.auto-goo/goo.md`. */
export function userGooMdPath(): string {
  return join(process.env.HOME || "~", ".auto-goo/goo.md");
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
    /** Subagent 总超时秒数（默认 1800 = 30min）。兜底用，防止子进程永久驻留 */
    subagent_timeout_seconds?: number;
    /** Subagent 空闲超时秒数（默认 300 = 5min）。连续这么久无任何事件即判定卡住并终止 */
    subagent_idle_timeout_seconds?: number;
    /**
     * 写冲突隔离（默认关闭）：并行步骤的 `allowed_write_paths` 重叠时，
     * 每个冲突步骤在独立 git worktree 中执行，完成后按依赖顺序合并。
     * 关闭时行为与 0.30.0 完全一致（仅告警）；开启后创建失败只降级为串行。
     */
    worktree_isolation?: boolean | string;
  };
  planning?: {
    recall_wiki?: boolean;
    require_wiki_context?: boolean;
  };
  /**
   * 执行观测 / 告警（exec.jsonl + 阈值 push）。
   * 默认全开本地 notify；webhook 只有显式配置 webhook_url 才发送。
   */
  observability?: {
    enabled?: boolean;
    /** 看门狗轮询间隔（秒），默认 60 */
    alert_interval_seconds?: number;
    /** 同一告警冷却（秒），默认 900 */
    cooldown_seconds?: number;
    /** 可选 webhook（POST JSON）；不配置则不发送 */
    webhook_url?: string;
    /** 单步疑似超时阈值（分钟），默认 30 */
    step_timeout_minutes?: number;
    /** plan 停滞阈值（分钟），默认 15 */
    plan_stall_minutes?: number;
    /** 心跳过期阈值（秒），默认 900（与 execute.ts / status.ts 对齐） */
    stale_heartbeat_seconds?: number;
    /** 内置自动重试上限，默认 1（与 execute.ts MAX_RETRIES 对齐） */
    max_retries?: number;
  };
  /** 交互对话框超时策略；timeout_seconds <= 0 表示禁用超时。 */
  interaction?: {
    timeout_seconds?: number;
  };
  /** 插件更新检查（只提醒不自动更新）。 */
  update_check?: {
    enabled?: boolean;
    interval_hours?: number;
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

/**
 * 校验配置里的时间字段：单位 + 合理范围。
 *
 * 为什么需要
 * ----------
 * 配置里单位是**混用**的（`_seconds` 与 `_minutes` 并存），填错不会有任何报错，
 * 只会让行为变得诡异：
 *
 *   stale_heartbeat_seconds: 15     ← 想填 15 分钟，实际 15 秒
 *   subagent_timeout_seconds: 30    ← 想填 30 分钟，实际 30 秒（subagent 秒退）
 *   step_timeout_minutes: 0.5       ← 想填 30 秒，碰巧对但语义混乱
 *
 * 这些值不会让程序崩，只会让**用户以为配好了却没生效** —— 与
 * `execution.stale_after_seconds` / `observability.stale_heartbeat_seconds`
 * 分属两处是同一类问题：配置骗人。
 *
 * 策略：**警告而不拒绝**。配置非法时仍按原值运行（用户可能有自己的理由），
 * 但把「你可能想填的是 X」明确说出来，写进 plugin.log 并返回给调用方。
 *
 * @returns 人类可读的问题列表（空表示全部合理）
 */
export function validateTimingConfig(config: AutogooPluginConfig | null | undefined): string[] {
  const issues: string[] = [];
  if (!config) return issues;
  const exec = (config as any).execution ?? {};
  const obs = (config as any).observability ?? {};

  const check = (
    value: unknown,
    path: string,
    opts: { unit: "seconds" | "minutes"; min: number; hint?: string },
  ) => {
    if (value === undefined || value === null) return;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      issues.push(`${path} 不是数字（${JSON.stringify(value)}），已忽略`);
      return;
    }
    if (n <= 0) {
      issues.push(`${path} = ${n} 必须为正数，否则该阈值会失效或立即触发`);
      return;
    }
    if (n < opts.min) {
      const alt =
        opts.unit === "seconds"
          ? `你可能想填 ${n} 分钟？那应写成 ${n * 60}（本字段单位是**秒**）`
          : `你可能想填 ${n} 秒？那应写成 ${(n / 60).toFixed(2)}（本字段单位是**分钟**）`;
      issues.push(`${path} = ${n}${opts.unit === "seconds" ? "s" : "min"} 偏小；${alt}`);
    }
  };

  check(exec.heartbeat_seconds, "execution.heartbeat_seconds", { unit: "seconds", min: 5 });
  check(exec.stale_after_seconds, "execution.stale_after_seconds", { unit: "seconds", min: 60 });
  check(exec.subagent_timeout_seconds, "execution.subagent_timeout_seconds", { unit: "seconds", min: 60 });
  check(exec.subagent_idle_timeout_seconds, "execution.subagent_idle_timeout_seconds", { unit: "seconds", min: 30 });
  check(obs.alert_interval_seconds, "observability.alert_interval_seconds", { unit: "seconds", min: 15 });
  check(obs.cooldown_seconds, "observability.cooldown_seconds", { unit: "seconds", min: 60 });
  check(obs.stale_heartbeat_seconds, "observability.stale_heartbeat_seconds", { unit: "seconds", min: 60 });
  check(obs.step_timeout_minutes, "observability.step_timeout_minutes", { unit: "minutes", min: 1 });
  check(obs.plan_stall_minutes, "observability.plan_stall_minutes", { unit: "minutes", min: 1 });

  return issues;
}

export async function loadProjectConfig(cwd: string): Promise<AutogooPluginConfig | null> {
  const p = projectConfigPath(cwd);
  try {
    await access(p);
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as AutogooPluginConfig;
    // 配置校验：单位/范围填错时警告（不拒绝，用户可能有自己的理由）
    const issues = validateTimingConfig(parsed);
    if (issues.length > 0) {
      for (const msg of issues) logWarn(`[config] ${msg}`);
    }
    return parsed;
  } catch {
    return null;
  }
}

async function loadUserConfig(): Promise<AutogooPluginConfig | null> {
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

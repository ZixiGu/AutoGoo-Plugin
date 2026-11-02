/**
 * Thread resource locks — wire thread-locks.py into the dispatch path.
 *
 * Before 2026-10-08 this script existed but **nothing called it**: the rule
 * "并发执行前必须使用 thread-locks.py 检查资源冲突" lived only in SKILL.md,
 * so two sessions could write the same files / wiki pages / ports / remote
 * server with no protection at all.
 *
 * Granularity: plan-level (check-plan / acquire-plan / release-plan), because
 * that is what the script models. `release-plan` frees every lock owned by the
 * thread, so acquire/release must bracket a region where that thread is the only
 * one running — true for both auto_goo_dispatch (single step) and
 * auto_goo_execute (sequential loop).
 */

import { execPython } from "./exec.js";
import { THREAD_LOCKS_PY } from "./paths.js";

export interface LockResource {
  type: string;
  resource: string;
  step_id?: string;
}

export interface LockConflict {
  requested: LockResource;
  lock: LockResource & { thread_id?: string; plan_path?: string; created_at?: string };
}

export interface LockResult {
  ok: boolean;
  thread_id?: string;
  checked?: LockResource[];
  acquired?: string[];
  released?: string[];
  conflicts?: LockConflict[];
  error?: string;
}

function run(args: string[], cwd: string): LockResult {
  try {
    const result = execPython(THREAD_LOCKS_PY, args, cwd, { timeout: 20000 });
    const text = (result.stdout || "").trim();
    if (!text) {
      return { ok: false, error: (result.stderr || "").trim() || `thread-locks exit ${result.exitCode}` };
    }
    const parsed = JSON.parse(text) as LockResult;
    // 脚本用 exit 2 表示「有冲突」；把 ok 与本进程退出码对齐，避免只看 ok 就放行。
    if (result.exitCode === 2) parsed.ok = false;
    return parsed;
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Read-only conflict check against locks held by *other* threads. */
export function checkPlanLocks(cwd: string, planPath: string): LockResult {
  return run(["check-plan", "--plan", planPath], cwd);
}

/** Acquire all resources declared by the plan. Idempotent for the same thread. */
export function acquirePlanLocks(cwd: string, planPath: string): LockResult {
  return run(["acquire-plan", "--plan", planPath], cwd);
}

/** Release every lock owned by this plan's thread. Safe to call when none held. */
export function releasePlanLocks(cwd: string, planPath: string): LockResult {
  return run(["release-plan", "--plan", planPath], cwd);
}

/** Human-readable one-liner for a conflict list. */
export function describeConflicts(conflicts: LockConflict[] | undefined, limit = 3): string {
  if (!conflicts || conflicts.length === 0) return "";
  const parts = conflicts.slice(0, limit).map((c) => {
    const holder = c.lock?.thread_id ? ` (held by ${c.lock.thread_id})` : "";
    return `${c.requested.type}:${c.requested.resource}${holder}`;
  });
  const more = conflicts.length > limit ? ` 等 ${conflicts.length} 项` : "";
  return parts.join("；") + more;
}

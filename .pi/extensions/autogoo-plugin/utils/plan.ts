/**
 * AutoGoo-Plugin Plan operations — load, save, validate, and manipulate plan.json.
 */

import { readFile, writeFile, access, mkdir, copyFile, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { projectPlanPath, projectCurrentThreadPath, projectThreadsDir, projectThreadDir } from "./paths.js";
import { DEFAULT_WIKI_PATHS_BY_STEP_TYPE, DEFAULT_MEMORY_LAYER_BY_STEP_TYPE } from "../constants.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface Goal {
  id: string;
  name: string;
  description: string;
  priority: number;
  status: string;
  acceptance_criteria: string[];
  outputs: string[];
  depends_on: string[];
}

export interface Step {
  // C4 修复：历史 plan 用字符串 id（"s1"），新 plan 用数字。统一放宽为 number|string，
  // 所有比较/文件名一律 String(step.id)，避免类型标注与真实数据不符。
  id: number | string;
  goal_id?: string;
  goal_ids?: string[];
  tier: number;
  name: string;
  description: string;
  depends_on: Array<number | string>;
  type: string;
  subagent: string;
  task_agent: string;
  available_skills: string[];
  status: "pending" | "running" | "completed" | "failed" | "blocked";
  progress: number;
  output?: string;
  inputs: string[];
  outputs: string[];
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  validation: string;
  risk_level: string;
  requires_user_confirm: boolean;
  confirmed?: boolean;
  confirmed_at?: string;
  blocked_at?: string;
  agent_id?: string | null;
  heartbeat_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  log_path?: string;
  error?: string;
  execution_target?: "local" | "remote";
  remote_server?: string;
  remote_reason?: string;
}

export interface Plan {
  task: string;
  goals: Goal[];
  status: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  steps: Step[];
  runtime?: {
    subagent_isolation?: {
      mode: string;
      checked_at: string;
      reason: string;
    };
  };
  wiki_context?: {
    found: boolean;
    sources: string[];
    reused_knowledge: string[];
  };
  context_digest?: {
    found: boolean;
    decisions: string[];
    constraints: string[];
    acceptance_criteria: string[];
    open_questions: string[];
  };
  context_artifacts?: string[];
  review?: {
    status: string;
  };
  execution?: {
    max_concurrent?: number;
    heartbeat_seconds?: number;
    stale_after_seconds?: number;
  };
  thread?: {
    id: string;
    plan_path: string;
    logs_dir: string;
    artifacts_dir: string;
  };
}

// ── Load / Save ─────────────────────────────────────────────────────────────

export async function loadPlan(cwd: string, planPath?: string): Promise<Plan | null> {
  const p = planPath ?? projectPlanPath(cwd);
  try {
    await access(p);
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 同步读取 plan —— 供 setInterval 之类的同步回调使用（如 subagent 的
 * shouldStop 判断）。纯读文件，不涉及写，同步是安全的。
 */
export function loadPlanSync(cwd: string, planPath?: string): Plan | null {
  const p = planPath ?? projectPlanPath(cwd);
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Plan;
  } catch {
    return null;
  }
}

export async function savePlan(cwd: string, plan: Plan, planPath?: string): Promise<string> {
  const p = planPath ?? projectPlanPath(cwd);
  await mkdir(dirname(p), { recursive: true });
  // Atomic write: write to .tmp then rename（P3）
  // rename 同文件系统内原子替换：崩溃时 plan.json 要么是旧版要么是新版，
  // 不会损坏；也不会残留 .tmp 覆盖失败。
  const tmp = p + ".tmp";
  const data = JSON.stringify(plan, null, 2) + "\n";
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, p);
  return p;
}

export async function archiveOldPlan(cwd: string, oldPlan: Plan): Promise<string> {
  const historyDir = join(cwd, ".goo/plans/history");
  await mkdir(historyDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "T");
  const archivePath = join(historyDir, `plan-${ts}.json`);
  await writeFile(archivePath, JSON.stringify(oldPlan, null, 2) + "\n", "utf-8");
  return archivePath;
}

// ── Thread helpers ──────────────────────────────────────────────────────────

export interface ThreadMeta {
  id: string;
  status: string;
  created_at: string;
  plan_path?: string;
  logs_dir?: string;
  artifacts_dir?: string;
  task?: string;
}

export async function getCurrentThreadId(cwd: string): Promise<string | null> {
  const p = projectCurrentThreadPath(cwd);
  try {
    await access(p);
    const raw = await readFile(p, "utf-8");
    const data = JSON.parse(raw);
    // 兼容两种 schema（修复 2026-08-14）：
    //   Python thread-state.py set_current 写 {"thread_id": ...}
    //   旧 TS 版本写 {"current_thread_id": ...}
    return data.current_thread_id ?? data.thread_id ?? null;
  } catch {
    return null;
  }
}

export async function setCurrentThreadId(cwd: string, threadId: string): Promise<void> {
  const p = projectCurrentThreadPath(cwd);
  await mkdir(dirname(p), { recursive: true });
  // 同时写两个字段，保证 TS/Python 两侧都能读到（修复 2026-08-14）
  await writeFile(p, JSON.stringify({ current_thread_id: threadId, thread_id: threadId }), "utf-8");
}

export async function loadThreadMeta(cwd: string, threadId: string): Promise<ThreadMeta | null> {
  const p = join(projectThreadDir(cwd, threadId), "thread.json");
  try {
    await access(p);
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveThreadMeta(cwd: string, meta: ThreadMeta): Promise<string> {
  const dir = join(projectThreadDir(cwd, meta.id));
  await mkdir(dir, { recursive: true });
  const p = join(dir, "thread.json");
  await writeFile(p, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  return p;
}

export async function updateThreadsIndex(cwd: string): Promise<void> {
  const threadsDir = projectThreadsDir(cwd);
  const indexFile = join(cwd, ".goo/threads/index.json");
  await mkdir(threadsDir, { recursive: true });

  // Scan threads
  let threads: ThreadMeta[] = [];
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(threadsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await loadThreadMeta(cwd, entry.name);
      if (meta) threads.push(meta);
    }
  } catch {
    // threads dir may not exist yet
  }

  // Sort by created_at descending
  threads.sort((a, b) => b.created_at.localeCompare(a.created_at));

  await writeFile(indexFile, JSON.stringify(threads, null, 2) + "\n", "utf-8");
}

export function generateThreadId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "T");
  const rand = Math.random().toString(36).slice(2, 6);
  return `thread-${ts}-${rand}`;
}

export function generateTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "T");
}

// ── Plan validation ─────────────────────────────────────────────────────────

export interface PlanValidationResult {
  valid: boolean;
  issues: string[];
}

export function validatePlan(plan: Plan): PlanValidationResult {
  const issues: string[] = [];

  if (!plan.task?.trim()) issues.push("plan.task is required");
  if (!plan.goals?.length) issues.push("plan.goals must have at least one goal");
  if (!plan.steps?.length) issues.push("plan.steps must have at least one step");

  // Check step IDs are unique
  const ids = new Set<string>();
  for (const step of plan.steps) {
    const key = String(step.id);
    if (ids.has(key)) issues.push(`duplicate step id: ${step.id}`);
    ids.add(key);
  }

  // Check depends_on refer to existing steps
  for (const step of plan.steps) {
    for (const depId of step.depends_on) {
      if (!ids.has(String(depId))) {
        issues.push(`step ${step.id} depends on non-existent step ${depId}`);
      }
    }
  }

  // 环检测（修复 C2）：DFS 遍历依赖图，发现环时标记步骤名（不重复报每个成员）
  const cycleNodes = findCycleNodes(plan);
  for (const node of cycleNodes) {
    issues.push(`circular dependency detected: step ${node}`);
  }

  return { valid: issues.length === 0, issues };
}

/**
 * 检测依赖图中的环（修复 C2）。返回环上的步骤 id（字符串形式）。
 * 用三色标记法（0=未访问, 1=访问中, 2=完成），发现回边即环。
 */
export function findCycleNodes(plan: Plan): string[] {
  const steps = plan.steps ?? [];
  const byId = new Map<string, any>();
  for (const s of steps) byId.set(String(s.id), s);
  const color = new Map<string, number>();
  const inCycle = new Set<string>();

  const visit = (key: string, stack: string[]): boolean => {
    color.set(key, 1);
    stack.push(key);
    const step = byId.get(key);
    const deps = (step?.depends_on ?? []) as Array<number | string>;
    for (const dep of deps) {
      const depKey = String(dep);
      if (!byId.has(depKey)) continue; // 坏依赖已由 validatePlan 报
      const c = color.get(depKey) ?? 0;
      if (c === 1) {
        // 环：从 depKey 到 stack 尾部都是环成员
        const idx = stack.indexOf(depKey);
        if (idx >= 0) for (let i = idx; i < stack.length; i++) inCycle.add(stack[i]);
        inCycle.add(depKey);
        continue;
      }
      if (c === 0) visit(depKey, stack);
    }
    stack.pop();
    color.set(key, 2);
    return inCycle.size > 0;
  };

  for (const s of steps) {
    const key = String(s.id);
    if ((color.get(key) ?? 0) === 0) visit(key, []);
  }
  return Array.from(inCycle);
}

// ── Dispatch packet (on-demand wiki + memory layer) ──────────────────────────

export interface DispatchPacket {
  wiki_paths: string[];
  wiki_graph_packet_path: string;
  memory_layer: string;
}

/**
 * 为 step 计算 dispatch packet — 默认 wiki_paths + memory_layer + packet 路径。
 * 镜像 Claude Code execution-engine.md 的 wiki_paths 注入逻辑(wiki_graph_assist 段)。
 *
 * 返回:
 *   - wiki_paths: 按 step.type 默认选出的 glob 路径(已替换 {slug}/{thread_id} 占位符)
 *   - wiki_graph_packet_path: 紧凑 graph packet 落盘路径(主 Agent 派发前会实际生成)
 *   - memory_layer: 默认记忆层(L0/L1/L2/L3)
 *
 * 注意:**本函数不实际执行** wiki-graph-assist.py,只计算路径;主 Agent 派发前用 execPython 调用。
 */
export function buildDispatchPacket(
  step: { id: number; type?: string; wiki_paths?: string[]; memory_layer?: string },
  projectSlug: string,
  threadId: string,
): DispatchPacket {
  const stepType = step.type || "exec";

  // 1. 优先使用 step 显式声明的 wiki_paths;否则用默认表
  const wiki_paths =
    step.wiki_paths && step.wiki_paths.length > 0
      ? step.wiki_paths
      : (DEFAULT_WIKI_PATHS_BY_STEP_TYPE[stepType] || DEFAULT_WIKI_PATHS_BY_STEP_TYPE.exec)
          .map((p) => p.replace("{slug}", projectSlug).replace("{thread_id}", threadId));

  // 2. 计算 wiki_graph_packet_path(主 Agent 派发前会实际生成)
  const wiki_graph_packet_path = `.goo/threads/${threadId}/artifacts/wiki-packet-step-${step.id}.md`;

  // 3. memory_layer 默认值
  const memory_layer =
    step.memory_layer || DEFAULT_MEMORY_LAYER_BY_STEP_TYPE[stepType] || "L2";

  return { wiki_paths, wiki_graph_packet_path, memory_layer };
}

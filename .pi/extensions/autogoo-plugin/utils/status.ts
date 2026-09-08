/**
 * AutoGoo-Plugin Status Bar — Pi 底部状态栏。
 *
 * 5 维度优化(thread 2026-08-05-status-bar-optimize):信息密度、渲染性能、
 * 视觉(ANSI + ▰/▱)、可维护性(拆小函数 + 测试)、任务名截断(>12 字符)。
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPlan, getCurrentThreadId, loadThreadMeta, type Plan, type Step } from "./plan.js";
import { projectThreadDir } from "./paths.js";
import { DEFAULT_MEMORY_LAYER_BY_STEP_TYPE } from "../constants.js";

const STATUS_KEY = "autogoo-plugin";

export interface PlanSnapshot {
  total: number; completed: number; running: number; pending: number; blocked: number; failed: number; interrupted: number; staleHeartbeats: number;
  threadId?: string; threadTask?: string; elapsed?: string;
  currentStepName?: string; currentStepElapsed?: string;
  wikiPacketGenerated?: boolean; etaSeconds?: number;
  recentCompletedStep?: string; memoryLayer?: string;
}

const ANSI = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const snapshotCache = new Map<string, { plan: Plan | null; ts: number }>();
const CACHE_TTL_MS = 1000;
async function getCachedPlan(cwd: string): Promise<Plan | null> {
  const hit = snapshotCache.get(cwd);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.plan;
  const plan = await loadPlan(cwd);
  snapshotCache.set(cwd, { plan, ts: Date.now() });
  return plan;
}

const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 200;
export function debouncedUpdateStatusBar(ctx: ExtensionContext): void {
  const key = ctx.cwd;
  const prev = debounceTimers.get(key);
  if (prev) clearTimeout(prev);
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    void updateStatusBar(ctx);
  }, DEBOUNCE_MS));
}

/** Format ms → "5m" / "1h23m" / "30s" / "0s". Exported for tests. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 > 0 ? `${sec % 60}s` : ""}`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 > 0 ? `${min % 60}m` : ""}`;
}

/** "2026-08-05T07-44-..." → "08-05 07:44"；无时间只返回 "MM-DD"。 */
export function parseThreadTime(threadId: string | undefined): string {
  if (!threadId) return "";
  const m = threadId.match(/(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})[-:](\d{2}))?/);
  if (m) return m[4] && m[5] ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[2]}-${m[3]}`;
  return threadId.length > 12 ? threadId.slice(-8) : threadId;
}

/** 任务名截断：> max 字符时 "前8 + ... + 后3"。默认 max=12。 */
export function truncateTask(task: string | undefined, max = 12): string {
  if (!task) return "";
  if (task.length <= max) return task;
  return `${task.slice(0, 8)}...${task.slice(-3)}`;
}

/** Unicode 进度条：完成 100% 时绿色。 */
export function buildProgress(snap: PlanSnapshot): string {
  const filled = Math.round((10 * snap.completed) / Math.max(1, snap.total));
  const bar = `[${"▰".repeat(filled)}${"▱".repeat(10 - filled)}]`;
  return snap.total > 0 && snap.completed === snap.total ? ANSI.green(bar) : bar;
}

/** 各状态计数 + 颜色：running=cyan / pending=dim / blocked=yellow / interrupted=magenta / failed=red。 */
export function buildCounts(snap: PlanSnapshot): string {
  const p: string[] = [];
  if (snap.running > 0) p.push(ANSI.cyan(`▶${snap.running}`));
  if (snap.pending > 0) p.push(ANSI.dim(`○${snap.pending}`));
  if (snap.blocked > 0) p.push(ANSI.yellow(`⊘${snap.blocked}`));
  if (snap.interrupted > 0) p.push(ANSI.magenta(`✂${snap.interrupted}`));
  if (snap.failed > 0) p.push(ANSI.red(`✕${snap.failed}`));
  return p.join(" ");
}

/** 心跳健康指示：0 时空串；>0 时黄色 ⚠HB。 */
export function buildHealth(snap: PlanSnapshot): string {
  if (snap.staleHeartbeats === 0) return "";
  return ANSI.yellow(`⚠HB${snap.staleHeartbeats}`);
}

/** 拼接最终状态栏行。 */
export function composeLine(snap: PlanSnapshot): string {
  const parts: string[] = [];
  const time = parseThreadTime(snap.threadId);
  const task = truncateTask(snap.threadTask);
  if (time || task) {
    let head = time || "?";
    if (task) head += ANSI.bold(` ${task}`);
    parts.push(head);
  }
  if (snap.elapsed) parts.push(`⌛${snap.elapsed}`);
  const pct = snap.total > 0 ? Math.round((snap.completed / snap.total) * 100) : 0;
  parts.push(buildProgress(snap));
  parts.push(`${pct}%`);
  if (snap.currentStepName) {
    const e = snap.currentStepElapsed ? `(${snap.currentStepElapsed})` : "";
    const l = snap.memoryLayer ? `[${snap.memoryLayer}]` : "";
    const w = snap.wikiPacketGenerated ? "📄" : "";
    parts.push(ANSI.cyan(`▶ ${truncateTask(snap.currentStepName, 20)} ${e}${l}${w}`));
  }
  if (snap.etaSeconds !== undefined && snap.etaSeconds > 0) parts.push(`ETA ${formatDuration(snap.etaSeconds * 1000)}`);
  parts.push(`${snap.completed}/${snap.total}`);
  const c = buildCounts(snap);
  if (c) parts.push(c);
  const h = buildHealth(snap);
  if (h) parts.push(h);
  if (snap.recentCompletedStep && snap.running > 0) parts.push(ANSI.dim(`✓ ${truncateTask(snap.recentCompletedStep, 15)}`));
  return parts.join(" ");
}

async function getThreadInfo(cwd: string): Promise<{ id: string; task: string } | null> {
  try {
    const plan = await getCachedPlan(cwd);
    if (plan?.thread?.id) return { id: plan.thread.id, task: plan.task?.slice(0, 40) || "" };
    const tid = await getCurrentThreadId(cwd);
    if (tid) {
      const meta = await loadThreadMeta(cwd, tid);
      // 修复（2026-08-14）：thread.json 用 title 字段（thread-state.py 写的），
      // 旧代码只读 meta.task → 拿不到任务名 → 状态栏信息变少。兼容两个字段。
      const task = meta?.task || meta?.title || plan?.task || "";
      return { id: tid, task: task.slice(0, 40) };
    }
    // 最后兜底：即使没有 thread 元数据，也把当前 plan 的 task 展示出来
    if (plan?.task) return { id: "", task: plan.task.slice(0, 40) };
    return null;
  } catch { return null; }
}

function findCurrentStep(steps: Step[]): Step | undefined { return steps.find((s) => s.status === "running"); }
function findRecentCompleted(steps: Step[]): Step | undefined {
  return steps.filter((s) => s.status === "completed" && s.completed_at)
    .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime())[0];
}
function averageCompletedMs(steps: Step[]): number {
  const done = steps.filter((s) => s.status === "completed" && s.started_at && s.completed_at);
  if (done.length === 0) return 0;
  return done.reduce((acc, s) => acc + Math.max(0, new Date(s.completed_at!).getTime() - new Date(s.started_at!).getTime()), 0) / done.length;
}
async function checkWikiPacket(cwd: string, threadId: string | undefined, stepId: number): Promise<boolean> {
  if (!threadId) return false;
  const p = join(projectThreadDir(cwd, threadId), "artifacts", `wiki-packet-step-${stepId}.md`);
  try { await access(p); return true; } catch { return false; }
}

/** Collect a snapshot of current plan state. */
export async function snapshotPlan(cwd: string): Promise<PlanSnapshot | null> {
  const plan = await getCachedPlan(cwd);
  if (!plan?.steps) return null;
  const steps = plan.steps, now = Date.now();
  // 与 execute.ts runHeartbeatCheck 保持一致：默认 15 分钟（900s），
  // plan.execution.stale_after_seconds / 顶层 heartbeat_timeout_min(分钟) 可覆盖；
  // 120s 只用于 goo-continue 跨会话恢复。
  const execCfg = plan.execution ?? {};
  const staleSec =
    execCfg.stale_after_seconds ??
    (((plan as any).heartbeat_timeout_min ?? 0) > 0 ? (plan as any).heartbeat_timeout_min * 60 : undefined) ??
    900;
  let stale = 0;
  for (const s of steps) {
    if (s.status === "running" && s.heartbeat_at) {
      const age = (now - new Date(s.heartbeat_at).getTime()) / 1000;
      if (age > staleSec) stale++;
    }
  }
  let elapsed: string | undefined;
  // 用最早 step 的 started_at(实际工作时间)代替 plan.started_at(可能很早)
  const firstStepStart = steps.map((s) => s.started_at).filter(Boolean).sort()[0];
  const startTime = firstStepStart || plan.started_at;
  if (startTime) elapsed = formatDuration((plan.completed_at ? new Date(plan.completed_at).getTime() : now) - new Date(startTime).getTime());
  const info = await getThreadInfo(cwd);
  const threadId = info?.id ?? plan.thread?.id;
  const cur = findCurrentStep(steps);
  let currentStepName: string | undefined, currentStepElapsed: string | undefined, memoryLayer: string | undefined;
  let wikiPacketGenerated: boolean | undefined;
  if (cur) {
    currentStepName = cur.name;
    if (cur.started_at) currentStepElapsed = formatDuration(now - new Date(cur.started_at).getTime());
    memoryLayer = (cur as any).memory_layer || DEFAULT_MEMORY_LAYER_BY_STEP_TYPE[cur.type] || "L2";
    wikiPacketGenerated = await checkWikiPacket(cwd, threadId, cur.id);
  }
  const pending = steps.filter((s) => s.status === "pending").length;
  const blocked = steps.filter((s) => s.status === "blocked").length;
  const avgMs = averageCompletedMs(steps);
  const etaSeconds = avgMs > 0 && pending + blocked > 0 ? Math.round((avgMs / 1000) * (pending + blocked)) : undefined;
  const recentCompletedStep = findRecentCompleted(steps)?.name;
  return {
    total: steps.length, completed: steps.filter((s) => s.status === "completed").length,
    running: steps.filter((s) => s.status === "running").length, pending, blocked,
    failed: steps.filter((s) => s.status === "failed").length,
    interrupted: steps.filter((s) => s.status === "interrupted").length,
    staleHeartbeats: stale,
    threadId, threadTask: info?.task, elapsed,
    currentStepName, currentStepElapsed, wikiPacketGenerated, etaSeconds, recentCompletedStep, memoryLayer,
  };
}

/** Render status bar line from a plan snapshot. Delegates to composeLine. */
export function formatStatusLine(snap: PlanSnapshot): string { return composeLine(snap); }

/** Update the Pi status bar with current plan state. */
export async function updateStatusBar(ctx: ExtensionContext): Promise<void> {
  const snap = await snapshotPlan(ctx.cwd);
  if (!snap) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
  ctx.ui.setStatus(STATUS_KEY, formatStatusLine(snap));
}

/** Clear the status bar. */
export function clearStatusBar(ctx: ExtensionContext): void { ctx.ui.setStatus(STATUS_KEY, undefined); }

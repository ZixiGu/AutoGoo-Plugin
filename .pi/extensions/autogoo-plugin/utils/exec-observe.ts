/**
 * DAG 执行观测 —— 回答「这次 DAG 到底健不健康」。
 *
 * 为什么需要这个模块
 * ------------------
 * 可观测性此前只覆盖**召回**（`recall.jsonl` + observe 的 recall tab）。DAG 执行
 * 本身零指标：失败/卡住/超时只在 TUI 和 step log 里出现，无人值守时没人知道
 * DAG 停了 —— 实测一轮 7 步 DAG 跑 2h11m，中途有步骤 exit 143、有步骤
 * interrupted，全靠人反复手动查 `auto_goo_dag_status` 才发现。
 *
 * 关键区别不是「没有检测」而是「没人问就不检查」：`runHeartbeatCheck` 只在被
 * 调用时执行，结果只是一段返回文本。所以这里做两件事：
 *   1. **pull → push**：阈值判定变成主动告警（`ctx.ui.notify`），并可由看门狗
 *      定时触发，不需要谁去查；
 *   2. **有指标**：耗时分布 / 超时聚类 / 重试次数都能回答，而不是"感觉有点慢"。
 *
 * 分工（避免两份口径）
 * -------------------
 * - **写**：只有 `skills/auto-goo/scripts/exec_observe.py` 写 `.goo/logs/exec.jsonl`
 *   （所有状态跃迁都经过 `update-step.py`，那里是唯一写入口）。
 * - **读/聚合/告警**：本文件。observe 面板的「执行」tab、`/goo-health` 报告、
 *   看门狗全部复用同一份聚合结果。
 *
 * 约束
 * ----
 * - 记录/投递失败**绝不阻塞执行**（与 `utils/log.ts`、`recall-observe.ts` 同原则）。
 * - webhook 默认关闭，只有 config.observability.webhook_url 显式配置才发。
 * - 不引入外部依赖：告警默认走 `ctx.ui.notify`，webhook 用内置 `fetch`。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { EXEC_OBSERVE_PY, UPDATE_STEP_PY } from "./paths.js";
import { DEFAULT_STALE_HEARTBEAT_SECONDS } from "../constants.js";
import { execPython } from "./exec.js";
import { logInfo, logWarn } from "./log.js";
import type { AutogooPluginConfig } from "./paths.js";

/** 4MB 后轮转为 `.1`（与 recall.jsonl 完全一致，见 exec_observe.py）。 */
export const EXEC_LOG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 事件名。与 `exec_observe.py` 的 `_event_name` 一一对应；
 * `alert` 由本文件在**首次投递**时登记（事后可回答「当时通知过谁」）。
 */
export type ExecEventName =
  | "step_start"
  | "step_complete"
  | "step_fail"
  | "step_timeout"
  | "step_interrupt"
  | "step_retry"
  | "step_resume"
  | "step_block"
  | "step_pending"
  | "alert";

export interface ExecEvent {
  /** ISO 时间戳（…Z） */
  ts: string;
  event: ExecEventName | string;
  step_id?: string;
  step_name?: string;
  subagent?: string | null;
  agent_id?: string | null;
  /** thread id（跨 thread 比较指标时用来过滤） */
  thread?: string | null;
  status?: string;
  progress?: number;
  /** 耗时毫秒（`duration_source` 标明来源） */
  duration_ms?: number | null;
  /** reported=调用方实测 / plan=started_at→completed_at / n/a=起点或缺失 */
  duration_source?: string;
  exit_code?: number | null;
  timed_out?: boolean | null;
  retry_count?: number | null;
  /** checkpoint 条数（台账本体仍在 plan 里，这里只留计数） */
  checkpoints?: number | null;
  /** 失败聚类桶（timeout / auth / rate_limit / signal_killed / …） */
  error_class?: string | null;
  error?: string | null;
  stderr_excerpt?: string | null;
  note?: string | null;
  source?: string;
}

export function execLogPath(gooDir: string): string {
  return join(gooDir, "logs", "exec.jsonl");
}

// ── 误差聚类（与 exec_observe.py 的桶保持一致）──────────────────────────────

const ERROR_BUCKETS: Array<[string, RegExp]> = [
  ["timeout", /timed?[\s_-]?out|timeout|超时|deadline exceeded/i],
  ["heartbeat_stale", /heartbeat|心跳/i],
  ["signal_killed", /sigterm|sigkill|killed|信号杀/i],
  ["auth", /unauthor|forbidden|\b401\b|\b403\b|invalid api key|认证/i],
  ["rate_limit", /rate[\s_-]?limit|\b429\b|quota|限流/i],
  ["model", /model not found|no such model|模型不存在/i],
  ["network", /econnrefused|enotfound|network|dns|connect timeout/i],
  ["resource_conflict", /资源冲突|\block\b|conflict/i],
  ["plan_invalid", /plan 校验|循环依赖|invalid plan/i],
  ["dispatch_no_log", /dispatch_no_log|没有写 log/i],
];

/** 把自由文本错误归到稳定桶（原文每次都不同，直接聚类等于每条一个桶）。 */
export function classifyFailure(
  text?: string | null,
  opts: { exitCode?: number | null; timedOut?: boolean } = {},
): string {
  if (opts.timedOut) return "timeout";
  const lowered = String(text ?? "").toLowerCase();
  for (const [bucket, pattern] of ERROR_BUCKETS) {
    if (pattern.test(lowered)) return bucket;
  }
  const exit = opts.exitCode;
  if (typeof exit === "number" && exit !== 0) return exit >= 128 ? "signal_killed" : "exit_code";
  return lowered ? "unknown" : "none";
}

// ── 聚合 ────────────────────────────────────────────────────────────────────

export interface ExecStepStat {
  stepId: string;
  name: string;
  subagent?: string | null;
  runs: number;
  completions: number;
  failures: number;
  timeouts: number;
  interrupts: number;
  retries: number;
  /** 终止类事件的耗时样本数 */
  samples: number;
  avgMs: number | null;
  maxMs: number | null;
  lastEvent?: string;
  lastTs?: string;
  errorClass?: string | null;
  error?: string | null;
}

export interface ExecFailureCluster {
  errorClass: string;
  count: number;
  sample: string;
  steps: string[];
}

export interface ExecStats {
  /** 能否读到事件文件（false 时所有数值都是零值，页面要显式提示） */
  ok: boolean;
  path: string;
  total: number;
  corruptLines: number;
  byEvent: Record<string, number>;
  fromTs?: string | null;
  toTs?: string | null;
  durations: { samples: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number };
  steps: ExecStepStat[];
  /** 平均耗时最长的 step（「哪一步最耗时间」） */
  slowest: ExecStepStat[];
  /** 超时次数最多的 step（「哪些 step 最容易超时」） */
  timeoutProne: ExecStepStat[];
  failures: ExecFailureCluster[];
  retries: { events: number; steps: number; avgPerStep: number; max: number };
  /** 曾被主动投递的告警次数 */
  alertsDelivered: number;
  lastN: ExecEvent[];
}

function emptyStats(path: string): ExecStats {
  return {
    ok: false,
    path,
    total: 0,
    corruptLines: 0,
    byEvent: {},
    fromTs: null,
    toTs: null,
    durations: { samples: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    steps: [],
    slowest: [],
    timeoutProne: [],
    failures: [],
    retries: { events: 0, steps: 0, avgPerStep: 0, max: 0 },
    alertsDelivered: 0,
    lastN: [],
  };
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[idx];
}

const TERMINAL_EVENTS = new Set(["step_complete", "step_fail", "step_timeout", "step_interrupt"]);

/**
 * 读取 `.goo/logs/exec.jsonl` 并聚合成可回答问题的指标。
 *
 * 文件不存在 / 全部损坏时返回 `ok: false` 的零值，**不抛异常** ——
 * 面板和报告都要能在"指标链路本身坏了"时照常工作（并显式说明坏了）。
 */
export function readExecStats(
  gooDir: string,
  opts: { limit?: number; thread?: string | null } = {},
): ExecStats {
  const path = execLogPath(gooDir);
  const stats = emptyStats(path);
  if (!existsSync(path)) return stats;

  let events: ExecEvent[] = [];
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean).slice(-(opts.limit ?? 2000));
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as ExecEvent);
      } catch {
        stats.corruptLines += 1;
      }
    }
    stats.ok = true;
  } catch {
    return stats;
  }

  if (opts.thread) events = events.filter((e) => !e.thread || e.thread === opts.thread);
  if (events.length === 0) return { ...stats, ok: true };

  const byStep = new Map<string, ExecStepStat>();
  const durations: number[] = [];
  const failureCounts = new Map<string, ExecFailureCluster>();
  let retryEvents = 0;
  let alertsDelivered = 0;

  const stepOf = (ev: ExecEvent): ExecStepStat => {
    const key = String(ev.step_id ?? "?");
    let stat = byStep.get(key);
    if (!stat) {
      stat = {
        stepId: key,
        name: String(ev.step_name ?? ""),
        subagent: ev.subagent ?? null,
        runs: 0, completions: 0, failures: 0, timeouts: 0, interrupts: 0,
        retries: 0, samples: 0, avgMs: null, maxMs: null,
      };
      byStep.set(key, stat);
    }
    if (ev.step_name) stat.name = String(ev.step_name);
    return stat;
  };

  for (const ev of events) {
    const name = String(ev.event ?? "unknown");
    stats.byEvent[name] = (stats.byEvent[name] || 0) + 1;
    if (!stats.fromTs) stats.fromTs = ev.ts;
    stats.toTs = ev.ts;

    if (name === "alert") {
      alertsDelivered += 1;
      continue;
    }
    const stat = stepOf(ev);
    stat.lastEvent = name;
    stat.lastTs = ev.ts;
    switch (name) {
      case "step_start":
        stat.runs += 1;
        break;
      case "step_complete":
        stat.completions += 1;
        break;
      case "step_fail":
        stat.failures += 1;
        break;
      case "step_timeout":
        stat.timeouts += 1;
        stat.failures += 1;
        break;
      case "step_interrupt":
        stat.interrupts += 1;
        break;
      case "step_retry":
        stat.retries += 1;
        retryEvents += 1;
        break;
      default:
        break;
    }
    if (TERMINAL_EVENTS.has(name) && typeof ev.duration_ms === "number" && ev.duration_ms >= 0) {
      durations.push(ev.duration_ms);
      stat.samples += 1;
      stat.maxMs = Math.max(stat.maxMs ?? 0, ev.duration_ms);
      stat.avgMs = stat.avgMs === null
        ? ev.duration_ms
        : Math.round((stat.avgMs * (stat.samples - 1) + ev.duration_ms) / stat.samples);
    }
    if (ev.error || ev.error_class) {
      const bucket = ev.error_class || classifyFailure(ev.error, { exitCode: ev.exit_code, timedOut: !!ev.timed_out });
      if (bucket && bucket !== "none") {
        const cluster = failureCounts.get(bucket) ?? {
          errorClass: bucket,
          count: 0,
          sample: String(ev.error || ev.stderr_excerpt || "").slice(0, 160),
          steps: [],
        };
        cluster.count += 1;
        if (cluster.steps.length < 8 && !cluster.steps.includes(stat.stepId)) cluster.steps.push(stat.stepId);
        failureCounts.set(bucket, cluster);
        stat.errorClass = bucket;
      }
      if (ev.error) stat.error = String(ev.error).slice(0, 200);
    }
  }

  const sorted = [...durations].sort((a, b) => a - b);
  stats.total = events.length;
  stats.steps = [...byStep.values()];
  stats.durations = {
    samples: sorted.length,
    avgMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
  };
  stats.slowest = [...stats.steps]
    .filter((s) => s.avgMs !== null)
    .sort((a, b) => (b.avgMs ?? 0) - (a.avgMs ?? 0))
    .slice(0, 5);
  stats.timeoutProne = [...stats.steps]
    .filter((s) => s.timeouts + s.interrupts > 0)
    .sort((a, b) => (b.timeouts + b.interrupts) - (a.timeouts + a.interrupts))
    .slice(0, 5);
  stats.failures = [...failureCounts.values()].sort((a, b) => b.count - a.count);
  const retriedSteps = stats.steps.filter((s) => s.retries > 0);
  stats.retries = {
    events: retryEvents,
    steps: retriedSteps.length,
    avgPerStep: retriedSteps.length
      ? Number((retryEvents / retriedSteps.length).toFixed(2))
      : 0,
    max: retriedSteps.reduce((m, s) => Math.max(m, s.retries), 0),
  };
  stats.alertsDelivered = alertsDelivered;
  stats.lastN = events.slice(-20).reverse();
  return stats;
}

// ── 阈值告警 ────────────────────────────────────────────────────────────────

export interface AlertThresholds {
  /** running step 超过多久判为疑似超时（分钟） */
  stepTimeoutMinutes: number;
  /** 心跳超过多久判为卡住（秒），与 execute.ts / status.ts 的 900s 对齐 */
  staleHeartbeatSeconds: number;
  /** plan 完全没有进展多久判为停滞（分钟） */
  planStallMinutes: number;
  /** 内置自动重试上限（execute.ts MAX_RETRIES）。超过即"连续重试" */
  maxRetries: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  stepTimeoutMinutes: 30,
  staleHeartbeatSeconds: DEFAULT_STALE_HEARTBEAT_SECONDS,
  planStallMinutes: 15,
  maxRetries: 1,
};

export type ExecAlertCode =
  | "step_timeout"
  | "step_failed"
  | "step_interrupted"
  | "consecutive_retry"
  | "plan_stall"
  | "metrics_missing";

export interface ExecAlert {
  level: "info" | "warning" | "error";
  code: ExecAlertCode;
  /** 去重键：同一 key 在冷却窗口内只通知一次 */
  key: string;
  message: string;
  stepId?: number | string;
  /** 结构化细节，便于 webhook 消费 */
  detail?: Record<string, unknown>;
}

export interface PlanLike {
  status?: string;
  task?: string;
  thread?: { id?: string } | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: any[];
  execution?: { stale_after_seconds?: number; max_concurrent?: number } | null;
}

const ACTIVE_PLAN_STATES = new Set(["running", "pending", "in_progress", "planned"]);
const FINISHED_PLAN_STATES = new Set(["completed", "closed", "abandoned", "archived"]);

export function isPlanActive(plan: PlanLike | null | undefined): boolean {
  if (!plan) return false;
  const status = String(plan.status ?? "").toLowerCase();
  if (FINISHED_PLAN_STATES.has(status)) return false;
  if (ACTIVE_PLAN_STATES.has(status)) return true;
  // 状态缺失/未知时不猜：只要有未完成步骤就当作活跃
  return (plan.steps ?? []).some((s) => !["completed"].includes(String(s?.status ?? "")));
}

function ageSeconds(ts: string | null | undefined, nowMs: number): number | null {
  if (!ts) return null;
  const parsed = Date.parse(String(ts));
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

function ageMinutesText(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}min`;
}

/**
 * plan 的「最近一次有进展」时间（毫秒时间戳）。优先取事件流，退化为 plan 心跳。
 *
 * 为什么要看事件流：plan 的 heartbeat_at 只在 update-step 写，而事件流包含
 * 重试/中断/完成等跃迁 —— 任何一个都比「心跳还在跳」更能证明真的在推进。
 */
export function lastActivityMs(plan: PlanLike | null, stats?: ExecStats): number | null {
  let latest: number | null = null;
  const bump = (ts?: string | null) => {
    if (!ts) return;
    const parsed = Date.parse(String(ts));
    if (!Number.isNaN(parsed) && (latest === null || parsed > latest)) latest = parsed;
  };
  for (const step of plan?.steps ?? []) {
    bump(step?.heartbeat_at ?? null);
    bump(step?.started_at ?? null);
    bump(step?.completed_at ?? null);
  }
  bump(plan?.started_at ?? null);
  if (stats?.toTs) bump(stats.toTs);
  return latest;
}

export interface EvaluateAlertsInput {
  plan: PlanLike | null | undefined;
  /** plan.json 路径：用于定位 agents/ 目录下的 pid 登记 */
  planPath?: string;
  stats?: ExecStats;
  now?: number;
  thresholds?: Partial<AlertThresholds>;
  /** exec.jsonl 是否应当有内容（plan 至少派发过一步） */
  expectMetrics?: boolean;
}

/**
 * 阈值判定（纯函数，now 由调用方注入）。
 *
 * 五类信号对应实测的三种「无声停摆」：
 *   - step 超时 / 心跳停滞：DAG 卡住但 status 还是 running；
 *   - 连续重试 / 失败 / 中断：重试通道自己坏了或任务本体失败了；
 *   - plan 停滞：所有状态都合法但就是不动 —— 无人值守时最危险的一种。
 */
/** 由 plan 路径推 agents 目录（与 reconcileZombieSteps 同一约定）。 */
function agentsDirOf(input: EvaluateAlertsInput): string {
  const p = (input as any)?.planPath;
  return p ? join(dirname(String(p)), "agents") : "";
}

export function evaluatePlanAlerts(input: EvaluateAlertsInput): ExecAlert[] {
  const nowMs = input.now ?? Date.now();
  const th = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const staleSeconds = Math.max(
    30,
    Number(input.plan?.execution?.stale_after_seconds) || th.staleHeartbeatSeconds,
  );
  const plan = input.plan ?? null;
  const alerts: ExecAlert[] = [];
  if (!plan) return alerts;

  const steps = plan.steps ?? [];
  if (steps.length === 0) return alerts;
  const active = isPlanActive(plan);

  for (const step of steps) {
    const id = step?.id;
    const status = String(step?.status ?? "");
    const label = `#${id} ${String(step?.name ?? "").slice(0, 24)}`.trim();

    if (status === "running" && active) {
      const hbAge = ageSeconds(step?.heartbeat_at ?? step?.started_at, nowMs);
      // 有活进程就不报「卡住」：心跳只反映「父进程还在不在」，
      // 父进程退出后子进程可能仍在跑（长任务）。判据应看进程，不是心跳。
      const procState = stepProcessState(agentsDirOf(input), id);
      if (procState === "alive") continue;
      const runAge = ageSeconds(step?.started_at, nowMs);
      const timeoutSeconds = Math.max(60, th.stepTimeoutMinutes * 60);
      if (hbAge !== null && hbAge > staleSeconds) {
        alerts.push({
          level: "error",
          code: "step_timeout",
          key: `step_timeout:${id}`,
          stepId: id,
          message:
            `⏱ ${label} 已 ${ageMinutesText(hbAge)} 没有心跳（阈值 ${ageMinutesText(staleSeconds)}）` +
            `，step 仍是 running —— 很可能卡住，需检查后 interrupt/resume`,
          detail: { heartbeat_age_s: hbAge, stale_after_s: staleSeconds, status },
        });
      } else if (runAge !== null && runAge > timeoutSeconds && hbAge !== null && hbAge > staleSeconds / 2) {
        // 只有「跑得久」**且**「心跳开始稀」才提示。实测一轮 DAG 跑 2h11m，
        // 单步超过 30min 是常态 —— 拿耗时单独当信号只会把告警变成噪音，
        // 而噪音告警等于没有告警。
        alerts.push({
          level: "warning",
          code: "step_timeout",
          key: `step_timeout:${id}`,
          stepId: id,
          message:
            `⏱ ${label} 已运行 ${ageMinutesText(runAge)}（阈值 ${th.stepTimeoutMinutes}min）` +
            `且心跳已 ${ageMinutesText(hbAge)} 未更新，确认是否还在推进`,
          detail: { elapsed_s: runAge, heartbeat_age_s: hbAge, threshold_min: th.stepTimeoutMinutes, status },
        });
      }
    }

    const retryCount = Number(step?.retry_count ?? 0);
    if ((status === "failed" || status === "interrupted") && retryCount >= th.maxRetries) {
      alerts.push({
        level: retryCount > th.maxRetries ? "error" : "warning",
        code: "consecutive_retry",
        key: `consecutive_retry:${id}`,
        stepId: id,
        message:
          `🔄 ${label} 已重试 ${retryCount} 次（上限 ${th.maxRetries}）仍 ${status}` +
          `，重试通道自身可能有问题（同一错误会一直重试）`,
        detail: { retry_count: retryCount, max_retries: th.maxRetries, status },
      });
    }

    if (status === "failed") {
      alerts.push({
        level: "error",
        code: "step_failed",
        key: `step_failed:${id}`,
        stepId: id,
        message: `💀 ${label} 失败：${String(step?.error ?? "（无 error 摘要）").slice(0, 160)}`,
        detail: { error: step?.error ?? null, retry_count: retryCount },
      });
    }

    if (status === "interrupted") {
      alerts.push({
        level: "warning",
        code: "step_interrupted",
        key: `step_interrupted:${id}`,
        stepId: id,
        message:
          `⚠️ ${label} 处于 interrupted（wrapper 中断 ≠ 任务失败）` +
          `：确认任务本体是否仍在跑，再 resume / 重启 / 确认失败`,
        detail: { error: step?.error ?? null },
      });
    }
  }

  if (active) {
    const lastMs = lastActivityMs(plan, input.stats);
    const stallSeconds = Math.max(60, th.planStallMinutes * 60);
    if (lastMs !== null) {
      const idle = Math.round((nowMs - lastMs) / 1000);
      if (idle > stallSeconds) {
        const unfinished = steps.filter((s) => String(s?.status ?? "") !== "completed");
        alerts.push({
          level: "error",
          code: "plan_stall",
          key: `plan_stall:${plan.thread?.id ?? "plan"}`,
          message:
            `🛑 plan 已 ${ageMinutesText(idle)} 无任何进展（阈值 ${th.planStallMinutes}min），` +
            `还剩 ${unfinished.length} 步未完成：${unfinished.slice(0, 4).map((s) => `#${s.id}`).join(", ")}` +
            `\n   无人值守时这等于 DAG 已经停了，但没人知道。`,
          detail: { idle_seconds: idle, threshold_min: th.planStallMinutes, unfinished: unfinished.map((s) => s.id) },
        });
      }
    }

    const dispatched = steps.some((s) => !!s?.started_at || ["running", "completed", "failed", "interrupted"].includes(String(s?.status ?? "")));
    const metricsEmpty = !input.stats || input.stats.total === 0;
    if (input.expectMetrics !== false && dispatched && metricsEmpty) {
      alerts.push({
        level: "info",
        code: "metrics_missing",
        key: "metrics_missing",
        message:
          `📉 plan 已派发步骤，但 .goo/logs/exec.jsonl 里没有事件` +
          `（指标链路未生效）。执行本身不受影响，但耗时/重试统计不可信。`,
        detail: { path: input.stats?.path ?? null },
      });
    }
  }

  // error 优先，其次 warning，最后 info；同类保持发现顺序
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return alerts.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ── 告警投递（notify + 去重 + 可选 webhook）─────────────────────────────────

export interface AlertState {
  /** key → 上次通知时间（ms） */
  lastNotified: Map<string, number>;
  /** key → 本进程已通知次数（防止挂了几天的僵尸 plan 变成永动机） */
  notifiedCount: Map<string, number>;
  /** 冷却窗口（ms）：同一 key 在窗口内不重复打扰 */
  cooldownMs: number;
  /** 同一 key 在**一个会话内**最多通知几次（默认 2） */
  maxPerKey: number;
}

export const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_ALERTS_PER_KEY = 2;

export function createAlertState(
  cooldownMs = DEFAULT_ALERT_COOLDOWN_MS,
  maxPerKey = DEFAULT_MAX_ALERTS_PER_KEY,
): AlertState {
  return { lastNotified: new Map(), notifiedCount: new Map(), cooldownMs, maxPerKey };
}

/**
 * 是否需要通知（纯函数，便于单测冷却语义）。
 *
 * 两道闸：冷却窗口（不每分钟重复）+ 单会话次数上限（僵尸 plan 挂几天时
 * 不会一直响）。少一道，告警就会从「提醒」退化成「被无视的背景音」。
 */
export function shouldNotify(alert: ExecAlert, state: AlertState, now = Date.now()): boolean {
  if ((state.notifiedCount.get(alert.key) ?? 0) >= state.maxPerKey) return false;
  const last = state.lastNotified.get(alert.key);
  if (last === undefined) return true;
  return now - last >= state.cooldownMs;
}

export interface NotifyCapableCtx {
  ui?: { notify?: (message: string, level?: string) => void };
}

export type WebhookFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<unknown>;

export interface DeliverOptions {
  now?: number;
  /** 可选 webhook（默认关闭；只有显式传入才发） */
  webhookUrl?: string | null;
  fetchImpl?: WebhookFetcher | null;
  /** 单次最多通知几条，避免刷屏 */
  maxPerTick?: number;
}

export interface DeliverResult {
  delivered: ExecAlert[];
  suppressed: number;
}

const LEVEL_TAG: Record<ExecAlert["level"], string> = {
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
};

/**
 * 投递告警。永不抛异常。
 *
 * 去重语义：同一 `key` 在 `cooldownMs` 内只通知一次 —— 15 分钟一次的「卡住了」
 * 是提醒，每分钟一次是新的噪音源。
 */
export function deliverAlerts(
  ctx: NotifyCapableCtx | null | undefined,
  alerts: ExecAlert[],
  state: AlertState,
  opts: DeliverOptions = {},
): DeliverResult {
  const now = opts.now ?? Date.now();
  const maxPerTick = opts.maxPerTick ?? 3;
  const delivered: ExecAlert[] = [];
  let suppressed = 0;

  for (const alert of alerts) {
    if (delivered.length >= maxPerTick) {
      suppressed += 1;
      continue;
    }
    if (!shouldNotify(alert, state, now)) {
      suppressed += 1;
      continue;
    }
    state.lastNotified.set(alert.key, now);
    state.notifiedCount.set(alert.key, (state.notifiedCount.get(alert.key) ?? 0) + 1);
    delivered.push(alert);
    try {
      const text = `${LEVEL_TAG[alert.level]} [AutoGoo] ${alert.message}`;
      const level = alert.level === "error" ? "error" : alert.level === "warning" ? "warning" : "info";
      ctx?.ui?.notify?.(text, level);
    } catch (e: any) {
      logWarn("[exec-observe] notify 失败（不影响执行）:", e?.message ?? String(e));
    }
  }

  if (delivered.length > 0 && opts.webhookUrl) {
    void postWebhook(opts.webhookUrl, delivered, opts.fetchImpl ?? null);
  }
  return { delivered, suppressed };
}

/**
 * 可选 webhook。默认不配置即不发送；失败静默（告警通道坏了不能反过来搞坏执行）。
 */
export async function postWebhook(
  url: string,
  alerts: ExecAlert[],
  fetchImpl: WebhookFetcher | null = null,
  timeoutMs = 3000,
): Promise<boolean> {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as WebhookFetcher | undefined);
  if (!doFetch || alerts.length === 0) return false;
  try {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "autogoo-plugin",
          kind: "dag_alert",
          sent_at: new Date().toISOString(),
          alerts: alerts.map((a) => ({
            level: a.level,
            code: a.code,
            step_id: a.stepId ?? null,
            message: a.message,
            detail: a.detail ?? {},
          })),
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    return true;
  } catch (e: any) {
    logWarn("[exec-observe] webhook 投递失败（不影响执行）:", e?.message ?? String(e));
    return false;
  }
}

// ── 健康报告（一条命令回答几个具体问题）────────────────────────────────────

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export interface HealthReportInput {
  plan: PlanLike | null;
  stats: ExecStats;
  alerts?: ExecAlert[];
  planPath?: string;
  now?: number;
  thresholds?: Partial<AlertThresholds>;
}

/**
 * 「本次 DAG 健康报告」文本。
 *
 * 明确回答四个问题（否则就只是又一坨数字）：
 *   1. 现在卡住了吗？（告警 + 停滞时长）
 *   2. 哪些 step 最耗时间？
 *   3. 哪些 step 最容易超时？
 *   4. 平均重试几次 / 失败主要在哪个桶？
 */
export function formatHealthReport(input: HealthReportInput): string {
  const { plan, stats } = input;
  const nowMs = input.now ?? Date.now();
  const th = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const alerts = input.alerts ?? evaluatePlanAlerts({ plan, stats, now: nowMs, thresholds: th });
  const L: string[] = [];
  const planStatus = String(plan?.status ?? "无 plan");
  const steps = plan?.steps ?? [];
  const done = steps.filter((s) => String(s?.status) === "completed").length;

  L.push("═══ DAG 健康报告 ═══");
  L.push(`任务: ${String(plan?.task ?? "(无)").slice(0, 80) || "(无)"}`);
  if (plan?.thread?.id) L.push(`thread: ${plan.thread.id}`);
  L.push(`plan: ${planStatus} · 步骤 ${done}/${steps.length} 完成`);
  const lastMs = lastActivityMs(plan, stats);
  if (lastMs !== null) {
    const idle = Math.max(0, Math.round((nowMs - lastMs) / 1000));
    L.push(`最近进展: ${ageMinutesText(idle)} 前${idle > th.planStallMinutes * 60 ? "  ⚠ 超过停滞阈值" : ""}`);
  }

  L.push("");
  L.push(`── 指标源 ${stats.ok ? "✓" : "✗"} ──`);
  L.push(`文件: ${stats.path}`);
  if (!stats.ok) {
    L.push("状态: 读不到事件文件（指标链路可能未生效；执行本身不受影响）");
  } else {
    L.push(
      `事件: ${stats.total} 条（损坏行 ${stats.corruptLines}）` +
        (stats.fromTs && stats.toTs ? ` · ${stats.fromTs} → ${stats.toTs}` : ""),
    );
    const summary = Object.entries(stats.byEvent)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    if (summary) L.push(`分布: ${summary}`);
  }

  if (stats.durations.samples > 0) {
    L.push("");
    L.push("── 耗时分布（终止类事件）──");
    L.push(
      `样本 ${stats.durations.samples} · avg ${fmtMs(stats.durations.avgMs)} · ` +
        `p50 ${fmtMs(stats.durations.p50Ms)} · p95 ${fmtMs(stats.durations.p95Ms)} · max ${fmtMs(stats.durations.maxMs)}`,
    );
    if (stats.slowest.length > 0) {
      L.push("最耗时 step:");
      for (const s of stats.slowest.slice(0, 3)) {
        L.push(`  #${s.stepId} ${s.name.slice(0, 28)} — avg ${fmtMs(s.avgMs ?? 0)} · max ${fmtMs(s.maxMs ?? 0)}`);
      }
    }
  } else {
    L.push("");
    L.push("── 耗时分布 ──");
    L.push("没有耗时样本（还没有 step 跑到终止事件）");
  }

  L.push("");
  L.push("── 超时 ──");
  const totalTimeouts = stats.steps.reduce((n, s) => n + s.timeouts, 0);
  if (totalTimeouts === 0) {
    L.push("没有超时事件");
  } else {
    L.push(`超时 ${totalTimeouts} 次`);
    L.push("最容易超时的 step:");
    for (const s of stats.timeoutProne.slice(0, 3)) {
      L.push(`  #${s.stepId} ${s.name.slice(0, 28)} — 超时 ${s.timeouts} · 中断 ${s.interrupts}`);
    }
  }

  L.push("");
  L.push("── 失败原因聚类 ──");
  if (stats.failures.length === 0) {
    L.push("没有失败事件");
  } else {
    for (const f of stats.failures.slice(0, 5)) {
      L.push(`  ${f.errorClass.padEnd(16)} ${String(f.count).padStart(3)}× · step ${f.steps.join(",") || "-"}`);
      if (f.sample) L.push(`      ${f.sample.slice(0, 120)}`);
    }
  }

  L.push("");
  L.push("── 重试 ──");
  L.push(
    `重试事件 ${stats.retries.events} 次 · 涉及 ${stats.retries.steps} 个 step · ` +
      `平均每步 ${stats.retries.avgPerStep} 次 · 最多 ${stats.retries.max} 次`,
  );

  L.push("");
  L.push(`── 告警（${alerts.length}）──`);
  if (alerts.length === 0) {
    L.push("无告警");
  } else {
    for (const a of alerts) L.push(`  ${LEVEL_TAG[a.level]} [${a.code}] ${a.message}`);
  }
  if (stats.alertsDelivered > 0) {
    L.push(`（事件流里还有 ${stats.alertsDelivered} 条历史投递记录）`);
  }
  return L.join("\n");
}

// ── 看门狗（pull → push）───────────────────────────────────────────────────

export interface ObservabilityConfig {
  enabled?: boolean;
  /** 看门狗轮询间隔（秒），默认 60 */
  alert_interval_seconds?: number;
  /** 同一告警冷却（秒），默认 900 */
  cooldown_seconds?: number;
  /** 可选 webhook；不配置则不发送 */
  webhook_url?: string;
  step_timeout_minutes?: number;
  plan_stall_minutes?: number;
  stale_heartbeat_seconds?: number;
  max_retries?: number;
}

export function thresholdsFromConfig(cfg?: ObservabilityConfig | null): AlertThresholds {
  const out = { ...DEFAULT_THRESHOLDS };
  if (!cfg) return out;
  const put = (key: keyof AlertThresholds, value: unknown) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  };
  put("stepTimeoutMinutes", cfg.step_timeout_minutes);
  put("planStallMinutes", cfg.plan_stall_minutes);
  put("staleHeartbeatSeconds", cfg.stale_heartbeat_seconds);
  put("maxRetries", cfg.max_retries);
  return out;
}

export interface CheckOptions {
  planPath?: string;
  stats?: ExecStats;
  config?: ObservabilityConfig | null;
  thresholds?: Partial<AlertThresholds>;
  state?: AlertState;
  now?: number;
  fetchImpl?: WebhookFetcher | null;
  /** 只计算不投递（`/goo-health` 用） */
  dryRun?: boolean;
}

export interface CheckResult {
  alerts: ExecAlert[];
  delivered: ExecAlert[];
  state: AlertState;
}

/** 默认投递状态：每个进程一份，跨调度轮次共享冷却窗口。 */
export const defaultAlertState = createAlertState();

function readPlanForAlerts(planPath: string): PlanLike | null {
  try {
    if (!existsSync(planPath)) return null;
    return JSON.parse(readFileSync(planPath, "utf-8")) as PlanLike;
  } catch {
    return null;
  }
}

function gooDirOf(planPath: string): string {
  // plan 在 .goo/plan.json 或 .goo/threads/<tid>/plan.json —— 指标文件都在
  // 项目级 .goo/logs/ 下（跨 thread 可比），所以向上找 .goo 目录。
  const parts = resolve(planPath).split(sep);
  const idx = parts.lastIndexOf(".goo");
  if (idx >= 0) return parts.slice(0, idx + 1).join(sep) || sep;
  return join(resolve(planPath), "..", ".goo");
}

/**
 * 僵尸步骤自愈：把「心跳早已过期且无任何进程」的 running 步骤降级为 interrupted。
 *
 * 为什么需要
 * ----------
 * 告警只能提醒，不能解决问题。实测 `circuit_gen` 项目的 plan 卡在
 * `status=running`、`#A` 心跳停在两天前 —— 于是：
 *   - 看门狗每 60s 检查一次
 *   - 每个 key 在一个会话内最多通知 2 次（maxPerKey）
 *   - **但每开一个新会话就重置计数，又响 2 次**
 *   - plan 永远不会自己结束 → 用户看到「一直显示」
 *
 * 根因不是告警太吵，是**状态没有被收敛**。RUNNING 的语义应该是
 * 「有东西在跑」，而僵尸步骤没有任何东西在跑，它就该是 interrupted。
 *
 * 判定条件（三条同时满足，避免误伤）：
 *   1. step.status == "running"
 *   2. 心跳（或 started_at）距今 > staleHeartbeatSeconds × 6
 *      —— 心跳由父进程每 20s 更新；父进程死了心跳就停。
 *         给 6 倍余量覆盖机器休眠/长时间 GC 等偶发情况。
 *   3. 该 step 没有登记活的 detached 子进程（agents/step-N.json 里的 pid）
 *
 * 只降级到 interrupted（不是 failed）：任务本体可能真的完成了，只是没人收尾。
 * interrupted 允许 `--resume`，也允许人看一眼后直接 `--complete`。
 *
 * @returns 被降级的 step id 列表（调用方据此在同一次告警里说明）
 */
export function reconcileZombieSteps(
  planPath: string,
  plan: PlanLike,
  thresholds: AlertThresholds,
  nowMs = Date.now(),
): Array<string | number> {
  const staleSeconds = Math.max(60, thresholds.staleHeartbeatSeconds);
  const hardLimit = staleSeconds * 6;
  const zombies: Array<string | number> = [];
  const agentsDir = join(dirname(planPath), "agents");

  for (const step of plan.steps ?? []) {
    if (String(step?.status ?? "").toLowerCase() !== "running") continue;
    const age = ageSeconds(step?.heartbeat_at ?? step?.started_at, nowMs);
    if (age === null || age <= hardLimit) continue;

    // 证据 3：能否证明它死了？
    //
    // ⚠ 只有 **detached 派发** 才会写 agents/step-N.json。
    // 阻塞派发（runSchedule → await runSubagent）**不写** —— 那时进程活在
    // 父进程内部，根本没有独立 pid 文件。
    //
    // 所以「没有 pid 文件」≠「进程已死」，而是「**无法判断**」。
    // 早期版本把「无 pid 文件」当成「无进程」直接降级，会把正在跑的长任务
    // （阻塞路径 2 小时、心跳由父进程维护）在 90 分钟时误标 interrupted。
    // 保守做法：证明不了就不动它 —— 假阴性（漏掉真僵尸）远好于假阳性（杀掉真任务）。
    const pidState = stepProcessState(agentsDir, step?.id);
    if (pidState !== "dead") continue;   // "alive" 或 "unknown" 都跳过

    const res = execPython(
      UPDATE_STEP_PY,
      [
        "--plan", planPath,
        "--step-id", String(step?.id),
        "--interrupt",
        "--error",
        `自动中断：心跳已 ${Math.round(age / 60)} 分钟无更新（阈值 ${Math.round(hardLimit / 60)} 分钟），` +
          `且未找到活跃子进程。任务本体可能已结束，检查后 --resume 或 --complete。`,
      ],
      dirname(dirname(dirname(planPath))),
      { timeout: 15000 },
    );
    if (res.exitCode === 0) zombies.push(step?.id);
  }
  return zombies;
}

/**
 * 该 step 对应的子进程状态（三态，**不能合并成 boolean**）。
 *
 *   "alive"   —— agents/step-N.json 里的 pid 还活着
 *   "dead"    —— 有 pid 文件，但进程已不存在（真僵尸）
 *   "unknown" —— 没有 pid 文件 / 读不了：**无法判断**
 *
 * 为什么必须区分 "dead" 和 "unknown"：只有 detached 派发才写 pid 文件；
 * 阻塞派发（runSchedule await runSubagent）没有独立 pid，此时进程可能正
 * 好好地跑在父进程内部。把 "unknown" 当成 "dead" 会在 90 分钟时误杀长任务。
 */
function stepProcessState(
  agentsDir: string,
  stepId: string | number | undefined,
): "alive" | "dead" | "unknown" {
  if (stepId === undefined) return "unknown";
  const metaPath = join(agentsDir, `step-${stepId}.json`);
  if (!existsSync(metaPath)) return "unknown";
  let pid = 0;
  try {
    pid = Number(JSON.parse(readFileSync(metaPath, "utf-8"))?.pid);
  } catch {
    return "unknown";
  }
  if (!Number.isFinite(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);   // 不发信号，只探测存在性
    return "alive";
  } catch (e: any) {
    return e?.code === "EPERM" ? "alive" : "dead";
  }
}

/**
 * 读 plan + 指标，判定阈值，投递告警。调度器每轮和看门狗定时都调用它。
 *
 * 永不抛异常：观测/告警挂掉不能把 DAG 一起挂掉。
 */
export function checkAndDeliverAlerts(ctx: any, planPath: string, opts: CheckOptions = {}): CheckResult {
  const state = opts.state ?? defaultAlertState;
  try {
    const plan = readPlanForAlerts(planPath);
    if (!plan) return { alerts: [], delivered: [], state };
    const stats = opts.stats ?? readExecStats(gooDirOf(planPath));
    const status = String(plan.status ?? "").toLowerCase();
    const thresholds = opts.thresholds ?? thresholdsFromConfig(opts.config);

    // 先自愈再判定：把僵尸 running 步骤降级为 interrupted，
    // 否则「状态永远不收敛 → 每个新会话都重新告警 2 次」。
    // dryRun（/goo-health 只读预览）不改状态。
    if (!opts.dryRun && isPlanActive(plan)) {
      const healed = reconcileZombieSteps(planPath, plan, thresholds, opts.now ?? Date.now());
      if (healed.length > 0) {
        logInfo(`[exec-observe] 自动中断 ${healed.length} 个僵尸步骤: ${healed.map((x) => `#${x}`).join(", ")}`);
      }
    }

    const alerts = evaluatePlanAlerts({
      plan,
      planPath,
      stats,
      now: opts.now,
      thresholds,
    });
    // 已完成的 plan 不再推送任何执行告警：历史失败是「已归档的事实」，
    // 不是「现在要处理的风险」。可见性留给 /goo-health 报告。
    const filtered = FINISHED_PLAN_STATES.has(status) ? [] : alerts;
    if (opts.dryRun) return { alerts: filtered, delivered: [], state };
    const result = deliverAlerts(ctx, filtered, state, {
      now: opts.now,
      webhookUrl: opts.config?.webhook_url ?? null,
      fetchImpl: opts.fetchImpl ?? null,
    });
    if (result.delivered.length > 0) recordAlerts(gooDirOf(planPath), planPath, result.delivered);
    return { alerts: filtered, delivered: result.delivered, state };
  } catch (e: any) {
    logWarn("[exec-observe] 告警判定失败（不影响执行）:", e?.message ?? String(e));
    return { alerts: [], delivered: [], state };
  }
}

/** 把已投递的告警登记进 exec.jsonl（事后可回答「当时通知过谁」）。 */
export function recordAlerts(gooDir: string, planPath: string, alerts: ExecAlert[]): void {
  if (alerts.length === 0) return;
  try {
    const payload = {
      event: "alert",
      alerts: alerts.map((a) => ({ level: a.level, code: a.code, key: a.key })),
      message: alerts.map((a) => a.message).join(" | ").slice(0, 400),
      source: "exec-alerts",
    };
    execPython(
      EXEC_OBSERVE_PY,
      ["append", "--plan", planPath, "--json", JSON.stringify(payload)],
      gooDir,
      { timeout: 8000 },
    );
  } catch (e: any) {
    logWarn("[exec-observe] 告警登记失败（不影响执行）:", e?.message ?? String(e));
  }
}

let watchdogTimer: any = null;

/** 看门狗是否在跑（测试/诊断用）。 */
export function watchdogRunning(): boolean {
  return watchdogTimer !== null;
}

/**
 * 启动执行告警看门狗：定期检查停滞/超时，主动 `ctx.ui.notify`。
 *
 * 这是「pull → push」的落点：`runHeartbeatCheck` 只有在有人调用工具时才检查，
 * 而无人值守恰恰是没人调用的时候。
 *
 * 关闭方式：`AUTOGOO_EXEC_ALERTS=0` 或 config.observability.enabled=false。
 */
export function startExecWatchdog(
  ctx: any,
  planPath: string,
  opts: CheckOptions & { intervalMs?: number } = {},
): void {
  if (process.env.AUTOGOO_EXEC_ALERTS === "0") return;
  if (opts.config?.enabled === false) return;
  if (watchdogTimer) return;
  const intervalMs = Math.max(
    15_000,
    opts.intervalMs ??
      (Number(opts.config?.alert_interval_seconds) || Number(process.env.AUTOGOO_EXEC_ALERT_INTERVAL) || 60) * 1000,
  );
  const state = opts.state ?? createAlertState(
    Math.max(60_000, (Number(opts.config?.cooldown_seconds) || 900) * 1000),
  );
  try {
    watchdogTimer = setInterval(() => {
      try {
        checkAndDeliverAlerts(ctx, planPath, { ...opts, state });
      } catch {
        /* 看门狗单次失败不影响下一次 */
      }
    }, intervalMs);
    (watchdogTimer as any).unref?.();
  } catch (e: any) {
    logWarn("[exec-observe] 看门狗启动失败（不影响执行）:", e?.message ?? String(e));
    watchdogTimer = null;
  }
}

export function stopExecWatchdog(): void {
  if (!watchdogTimer) return;
  try {
    clearInterval(watchdogTimer);
  } catch {
    /* 清理失败无害 */
  }
  watchdogTimer = null;
}

/** 从 config 取 observability 段（缺失时返回 undefined）。 */
/**
 * 从项目配置里取出可观测性设置。
 *
 * ⚠ 坑：`execution.stale_after_seconds` 与 `observability.stale_heartbeat_seconds`
 * 是**同一个语义**（running 步骤多久没心跳算卡住），但历史上分属两个配置段、
 * 由两处代码读取：
 *   - execute.ts 的 heartbeat_check 读 `execution.stale_after_seconds`
 *   - 告警读 `observability.stale_heartbeat_seconds`（默认 900s）
 *
 * 实测后果：某项目配了 `execution.stale_after_seconds: 120`（2 分钟），
 * 执行侧 2 分钟就判 stale，而告警侧还按 15 分钟算 —— 用户看到「已 16min
 * 没有心跳（阈值 15min）」时会困惑「我明明配的 2 分钟」。
 *
 * 这里做单向回退：**observability 显式配置优先，缺省时沿用 execution**。
 * 反向不成立（execution 段更基础，不该被 observability 反向覆盖）。
 */
export function observabilityOf(config: AutogooPluginConfig | null | undefined): ObservabilityConfig | undefined {
  const obs = (config as any)?.observability as ObservabilityConfig | undefined;
  const exec = (config as any)?.execution as { stale_after_seconds?: number } | undefined;
  if (!obs && !exec) return undefined;
  const merged: ObservabilityConfig = { ...(obs ?? {}) };
  if (merged.stale_heartbeat_seconds === undefined && exec?.stale_after_seconds !== undefined) {
    merged.stale_heartbeat_seconds = Number(exec.stale_after_seconds);
  }
  return merged;
}

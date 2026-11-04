/**
 * Subagent 活动总线 —— 记录"正在跑的 subagent 到底在做什么"。
 *
 * 背景：`auto_goo_dispatch` / `auto_goo_execute` 的进度只在工具输出里刷几行，
 * 一旦滚动就看不到了，也没法"切换进去看"。这里把活动持久化到内存，
 * 由 `ctx.ui.custom` 的面板消费（`/goo-subagent` 或 alt+a）。
 *
 * 注：曾额外用 `ctx.ui.setWidget` 在状态栏下面常驻显示，但用户反馈多行
 * widget 太吵、与既有状态栏重复，已移除 —— 只保留按需打开的面板。
 *
 * 只在内存里，不落盘：这是**运行时可观测性**，不是审计日志（审计走 step log）。
 */

export type ActivityKind = "status" | "text" | "tool" | "result";

export interface ActivityEvent {
  at: number;
  kind: ActivityKind;
  text: string;
}

export type StepRunStatus = "running" | "done" | "failed" | "interrupted";

export interface StepActivity {
  stepId: string;
  stepName: string;
  status: StepRunStatus;
  startedAt: number;
  endedAt?: number;
  events: ActivityEvent[];
  /** 当前工具调用（用于状态栏一行的"正在做什么"） */
  currentTool?: string;
}

const MAX_EVENTS = 400;
const MAX_STEPS = 20;

class ActivityBus {
  private readonly steps = new Map<string, StepActivity>();
  private listeners = new Set<() => void>();

  /** 开始跟踪一个 step。 */
  begin(stepId: string | number, stepName?: string): void {
    const key = String(stepId);
    this.steps.set(key, {
      stepId: key,
      stepName: stepName ?? "",
      status: "running",
      startedAt: Date.now(),
      events: [],
    });
    this.trim();
    this.notify();
  }

  /** 追加一条活动。 */
  push(stepId: string | number, kind: ActivityKind, text: string): void {
    const key = String(stepId);
    let entry = this.steps.get(key);
    if (!entry) {
      this.begin(key, "");
      entry = this.steps.get(key)!;
    }
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    entry.events.push({ at: Date.now(), kind, text: clean.slice(0, 500) });
    if (entry.events.length > MAX_EVENTS) {
      entry.events.splice(0, entry.events.length - MAX_EVENTS);
    }
    if (kind === "tool") entry.currentTool = clean.slice(0, 120);
    this.notify();
  }

  /** 结束跟踪。 */
  end(stepId: string | number, status: StepRunStatus = "done"): void {
    const entry = this.steps.get(String(stepId));
    if (!entry) return;
    entry.status = status;
    entry.endedAt = Date.now();
    entry.currentTool = undefined;
    this.notify();
  }

  /** 按"运行中优先、其次最近开始"排序。 */
  list(): StepActivity[] {
    return Array.from(this.steps.values()).sort((a, b) => {
      const aRunning = a.status === "running" ? 0 : 1;
      const bRunning = b.status === "running" ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return b.startedAt - a.startedAt;
    });
  }

  get(stepId: string | number): StepActivity | undefined {
    return this.steps.get(String(stepId));
  }

  runningCount(): number {
    return this.list().filter((s) => s.status === "running").length;
  }

  isEmpty(): boolean {
    return this.steps.size === 0;
  }

  clear(): void {
    this.steps.clear();
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 监听器异常不阻塞 */
      }
    }
  }

  private trim(): void {
    if (this.steps.size <= MAX_STEPS) return;
    const finished = this.list()
      .filter((s) => s.status !== "running")
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    while (this.steps.size > MAX_STEPS && finished.length > 0) {
      const victim = finished.shift()!;
      this.steps.delete(victim.stepId);
    }
  }
}

export const activityBus = new ActivityBus();

const KIND_MARK: Record<ActivityKind, string> = {
  status: "◆",
  text: "💬",
  tool: "⚙",
  result: "↳",
};

export function kindMark(kind: ActivityKind): string {
  return KIND_MARK[kind] ?? "·";
}

const STATUS_MARK: Record<StepRunStatus, string> = {
  running: "►",
  done: "✓",
  failed: "✗",
  interrupted: "⏸",
};

export function runStatusMark(status: StepRunStatus): string {
  return STATUS_MARK[status] ?? "·";
}

/**
 * Subagent 活动总线 —— 记录"正在跑的 subagent 到底在做什么"。
 *
 * 背景：`auto_goo_dispatch` / `auto_goo_execute` 的进度只在工具输出里刷几行，
 * 一旦滚动就看不到了，也没法"切换进去看"。这里把活动持久化到内存：
 *   - 状态栏下面用 `ctx.ui.setWidget` 渲染最近的几行（实时）；
 *   - 完整时间线用 `ctx.ui.custom` 的面板看（`/goo-subagent` 或 alt+a）。
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
  private renderHook: (() => void) | null = null;

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

  /** widget 组件注册重绘钩子；卸载时置空。 */
  setRenderHook(fn: (() => void) | null): void {
    this.renderHook = fn;
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 监听器异常不阻塞 */
      }
    }
    try {
      this.renderHook?.();
    } catch {
      /* 重绘请求失败不阻塞 */
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

export interface WidgetRenderOptions {
  /** 最多显示几行活动（不含标题行） */
  maxLines?: number;
  /** 超过多少列截断 */
  width: number;
}

/**
 * 状态栏下面的紧凑视图：标题 + 每个运行中 step 的最近几行。
 * 无颜色依赖（theme 可选），保持 widget 轻量。
 */
export function renderActivityWidget(
  opts: WidgetRenderOptions,
  colorize?: { accent: (s: string) => string; dim: (s: string) => string },
): string[] {
  const steps = activityBus.list();
  if (steps.length === 0) return [];

  const maxLines = Math.max(1, opts.maxLines ?? 6);
  const width = Math.max(20, opts.width);
  const accent = colorize?.accent ?? ((s: string) => s);
  const dim = colorize?.dim ?? ((s: string) => s);
  const clip = (s: string) => (s.length > width ? `${s.slice(0, Math.max(1, width - 1))}…` : s);

  const lines: string[] = [];
  const running = steps.filter((s) => s.status === "running");
  const shown = running.length > 0 ? running : steps.slice(0, 1);

  const header = running.length > 0 ? `● subagent 运行中（${running.length}）` : "● subagent 最近一次";
  lines.push(clip(accent(header)));

  let budget = maxLines;
  for (const step of shown) {
    if (budget <= 0) break;
    lines.push(clip(dim(`  ${runStatusMark(step.status)} #${step.stepId} ${step.stepName}`.trimEnd())));
    budget -= 1;
    const recent = step.events.slice(-budget);
    for (const event of recent) {
      if (budget <= 0) break;
      lines.push(clip(`    ${kindMark(event.kind)} ${event.text}`));
      budget -= 1;
    }
  }
  return lines;
}

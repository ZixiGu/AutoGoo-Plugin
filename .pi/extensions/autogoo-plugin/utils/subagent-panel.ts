/**
 * Subagent 活动面板（`/goo-subagent` / `alt+a`）。
 *
 * 布局：步骤列表（上）+ 时间线（下），Tab 在两者间切换焦点。
 *
 * 键位（全部可用的完整集合）：
 *   Tab          切换焦点：步骤 ↔ 时间线
 *   ↑↓ / j k     按焦点移动：切 step / 滚动时间线
 *   PgUp PgDn    滚动时间线（不改变焦点）
 *   g / G        时间线跳到首 / 尾（G 恢复"跟随最新"）
 *   c            清空活动记录
 *   r            立即重绘
 *   q / Esc      退出
 *
 * 数据来自内存总线 `activityBus`，面板只读不写。
 */

import type { Component, KeybindingsManager, Theme } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { activityBus, kindMark, runStatusMark, type ActivityKind, type StepActivity } from "./activity.js";
import { clip, color, fit, fmtAge, headerLine, keyHelp, ListState, rule, selected as hl } from "./tui-kit.js";

export type SubagentAction = { action: "quit" } | { action: "clear" };

type Focus = "steps" | "timeline";

const STEP_WINDOW = 6;
const TIMELINE_WINDOW = 10;

function elapsed(from: number, to = Date.now()): string {
  const sec = Math.max(0, Math.round((to - from) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function clock(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function kindToken(kind: ActivityKind): string {
  switch (kind) {
    case "tool":
      return "accent";
    case "result":
      return "dim";
    case "text":
      return "success";
    default:
      return "warning";
  }
}

export class SubagentPanel implements Component {
  private focus: Focus = "steps";
  private readonly stepList = new ListState(STEP_WINDOW, 0);
  private timelineTop = 0;
  private followTail = true;
  private readonly theme: Theme;
  private readonly done: (a: SubagentAction) => void;
  private readonly requestRender: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    theme: Theme,
    done: (a: SubagentAction) => void,
    requestRender: () => void,
    private readonly keybindings?: KeybindingsManager,
  ) {
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
    activityBus.subscribe(() => {
      // 新事件到达时，若处于"跟随"状态就自动贴到底部
      if (this.followTail) this.snapToTail();
      this.requestRender();
    });
    this.timer = setInterval(() => this.requestRender(), 1000);
    if (this.timer && typeof (this.timer as any).unref === "function") {
      (this.timer as any).unref();
    }
  }

  private steps(): StepActivity[] {
    return activityBus.list();
  }

  private currentStep(): StepActivity | undefined {
    const steps = this.steps();
    if (steps.length === 0) return undefined;
    this.stepList.clamp(steps.length);
    return steps[this.stepList.selected];
  }

  private snapToTail(): void {
    const step = this.currentStep();
    const count = step?.events.length ?? 0;
    this.timelineTop = Math.max(0, count - TIMELINE_WINDOW);
  }

  private scrollTimeline(delta: number): void {
    const step = this.currentStep();
    const count = step?.events.length ?? 0;
    const maxTop = Math.max(0, count - TIMELINE_WINDOW);
    this.timelineTop = Math.min(maxTop, Math.max(0, this.timelineTop + delta));
    this.followTail = this.timelineTop >= maxTop;
    this.requestRender();
  }

  render(width: number): string[] {
    const w = Math.max(24, width);
    const out: string[] = [];
    const steps = this.steps();
    const running = steps.filter((s) => s.status === "running").length;
    const oldest = steps.length > 0 ? Math.min(...steps.map((s) => s.startedAt)) : Date.now();

    out.push(rule(w, this.theme));
    out.push(
      headerLine(
        " ◆ AutoGoo Subagent",
        steps.length === 0 ? "无活动" : `${running} 运行中 · ${steps.length} step · ${elapsed(oldest)}`,
        w,
        this.theme,
      ),
    );
    out.push(rule(w, this.theme));

    if (steps.length === 0) {
      out.push(fit(color(this.theme, "dim", "  还没有 subagent 活动。"), w));
      out.push(fit(color(this.theme, "dim", "  用 auto_goo_dispatch / auto_goo_execute 派发后会实时出现在这里。"), w));
      out.push(fit("", w));
      out.push(rule(w, this.theme));
      out.push(keyHelp([{ keys: "q", label: "退出" }], w, this.theme));
      return out;
    }

    // ── 步骤区 ──────────────────────────────────────────────────────────
    const stepsFocused = this.focus === "steps";
    out.push(
      fit(
        ` ${stepsFocused ? color(this.theme, "accent", "▸ 步骤") : color(this.theme, "dim", "  步骤")}` +
          color(this.theme, "dim", `　(${this.stepList.selected + 1}/${steps.length})`),
        w,
      ),
    );
    const [sStart, sEnd] = this.stepList.range(steps.length);
    steps.slice(sStart, sEnd).forEach((step, i) => {
      const index = sStart + i;
      const active = index === this.stepList.selected;
      const mark = color(
        this.theme,
        step.status === "failed" ? "error" : step.status === "running" ? "accent" : "dim",
        runStatusMark(step.status),
      );
      const nameWidth = Math.max(10, w - 46);
      const name = (step.stepName || "(unnamed)").slice(0, nameWidth);
      const took = elapsed(step.startedAt, step.endedAt ?? Date.now());
      const tail = step.currentTool ?? step.events.at(-1)?.text ?? "";
      const text =
        ` ${active ? "›" : " "} ${mark} #${String(step.stepId).slice(0, 4).padEnd(4)} ` +
        `${name.padEnd(nameWidth).slice(0, nameWidth)} ` +
        `${color(this.theme, step.status === "running" ? "accent" : "dim", step.status.padEnd(11))}${took}`;
      out.push(fit(active ? hl(this.theme, text) : text, w));
      if (tail) {
        out.push(fit(color(this.theme, "dim", `     └ ${tail.slice(0, Math.max(8, w - 8))}`), w));
      }
    });
    if (steps.length > STEP_WINDOW) {
      out.push(fit(color(this.theme, "dim", `     … 共 ${steps.length} 个（窗口 ${sStart + 1}-${sEnd}）`), w));
    }

    // ── 时间线 ──────────────────────────────────────────────────────────
    out.push(rule(w, this.theme));
    const step = this.currentStep();
    const events = step?.events ?? [];
    const timelineFocused = this.focus === "timeline";
    const maxTop = Math.max(0, events.length - TIMELINE_WINDOW);
    if (this.followTail) this.timelineTop = maxTop;
    this.timelineTop = Math.min(maxTop, Math.max(0, this.timelineTop));
    const shown = events.slice(this.timelineTop, this.timelineTop + TIMELINE_WINDOW);
    const rangeText = events.length === 0
      ? "无事件"
      : `${this.timelineTop + 1}-${this.timelineTop + shown.length}/${events.length}${this.followTail ? " · 跟随" : ""}`;
    out.push(
      fit(
        ` ${timelineFocused ? color(this.theme, "accent", "▸ 时间线") : color(this.theme, "dim", "  时间线")}` +
          color(this.theme, "dim", `　#${step?.stepId ?? "-"}　${rangeText}`),
        w,
      ),
    );

    if (shown.length === 0) {
      out.push(fit(color(this.theme, "dim", "  （该 step 还没有可显示的事件）"), w));
    } else {
      for (const event of shown) {
        const mark = color(this.theme, kindToken(event.kind), kindMark(event.kind));
        const time = color(this.theme, "dim", clock(event.at));
        out.push(fit(`  ${time} ${mark} ${color(this.theme, kindToken(event.kind), event.text)}`, w));
      }
    }

    out.push(rule(w, this.theme));
    out.push(
      keyHelp(
        [
          { keys: "Tab", label: "切焦点" },
          { keys: "↑↓", label: this.focus === "steps" ? "选 step" : "滚时间线" },
          { keys: "PgUp/PgDn", label: "翻时间线" },
          { keys: "g/G", label: "首/尾" },
          { keys: "c", label: "清空" },
          { keys: "q", label: "退出" },
        ],
        w,
        this.theme,
      ),
    );
    return out;
  }

  invalidate(): void {
    /* 无缓存 */
  }

  handleInput(data: string): void {
    // 退出
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.done({ action: "quit" });
      return;
    }
    // 清空
    if (data === "c") {
      this.done({ action: "clear" });
      return;
    }
    // 立即重绘
    if (data === "r") {
      this.requestRender();
      return;
    }
    // 切焦点
    if (matchesKey(data, "tab")) {
      this.focus = this.focus === "steps" ? "timeline" : "steps";
      this.requestRender();
      return;
    }
    // g / G：时间线首尾（与焦点无关，行为可预测；G 恢复"跟随"）
    if (data === "g") {
      this.timelineTop = 0;
      this.followTail = false;
      this.requestRender();
      return;
    }
    if (data === "G") {
      this.followTail = true;
      this.snapToTail();
      this.requestRender();
      return;
    }
    // home / end：步骤列表首尾
    if (matchesKey(data, "home")) {
      this.stepList.jumpToFirst(this.steps().length);
      this.followTail = true;
      this.snapToTail();
      this.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.stepList.jumpToLast(this.steps().length);
      this.followTail = true;
      this.snapToTail();
      this.requestRender();
      return;
    }
    // 翻页：无论焦点都在时间线上滚动
    if (matchesKey(data, "pageUp")) {
      this.scrollTimeline(-TIMELINE_WINDOW);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollTimeline(TIMELINE_WINDOW);
      return;
    }
    // 上 / 下
    if (matchesKey(data, "up") || data === "k") {
      if (this.focus === "steps") {
        this.stepList.move(-1, this.steps().length);
        this.followTail = true;
        this.snapToTail();
      } else {
        this.scrollTimeline(-1);
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      if (this.focus === "steps") {
        this.stepList.move(1, this.steps().length);
        this.followTail = true;
        this.snapToTail();
      } else {
        this.scrollTimeline(1);
      }
      this.requestRender();
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

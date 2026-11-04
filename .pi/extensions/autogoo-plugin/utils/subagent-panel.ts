/**
 * Subagent 活动面板（`/goo-subagent` / alt+a）。
 *
 * 与状态栏下面的 widget 互补：
 *   - widget：只显示最近几行，始终可见，回答"还在跑吗"；
 *   - 面板：完整时间线 + 步骤切换，回答"到底做了什么"。
 *
 * 数据来自 `activityBus`（纯内存）。面板不做任何写操作，只读。
 */

import type { Component, KeybindingsManager, Theme } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { activityBus, kindMark, runStatusMark, type StepActivity } from "./activity.js";
import { clip, color, fit, fmtAge, headerLine, keyHelp, ListState, rule, selected as hl } from "./tui-kit.js";

export type SubagentAction = { action: "quit" } | { action: "clear" };

export class SubagentPanel implements Component {
  private selected = 0;
  private readonly theme: Theme;
  private readonly done: (a: SubagentAction) => void;
  private readonly requestRender: () => void;
  private readonly list = new ListState(10, 0);
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
    // 总线有变化就重绘；再补一个 1s 兜底（相对时间会变）
    activityBus.subscribe(() => this.requestRender());
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
    this.list.clamp(steps.length);
    return steps[this.list.selected];
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const out: string[] = [];
    const steps = this.steps();
    const running = steps.filter((s) => s.status === "running").length;

    out.push(rule(w, this.theme));
    out.push(
      headerLine(
        " AutoGoo Subagent",
        steps.length === 0 ? "无活动" : `${steps.length} 个 step · ${running} 运行中`,
        w,
        this.theme,
      ),
    );
    out.push(rule(w, this.theme));

    if (steps.length === 0) {
      out.push(fit(color(this.theme, "dim", "  （还没有 subagent 活动）"), w));
      out.push(fit(color(this.theme, "dim", "  用 auto_goo_dispatch / auto_goo_execute 派发后会实时出现在这里。"), w));
      out.push(rule(w, this.theme));
      out.push(keyHelp([{ keys: "q", label: "退出" }], w, this.theme));
      return out;
    }

    // ── 步骤列表（最多 6 行，横向紧凑） ──
    const [start, end] = this.list.range(Math.min(steps.length, 6));
    steps.slice(start, end).forEach((step, i) => {
      const active = start + i === this.list.selected;
      const age = step.status === "running" ? `${fmtAge(new Date(step.startedAt).toISOString())} 前开始` : "";
      const cur = step.currentTool ? ` · ${step.currentTool}` : "";
      const text =
        ` ${active ? "›" : " "} ${color(this.theme, step.status === "failed" ? "error" : step.status === "running" ? "accent" : "dim", runStatusMark(step.status))} ` +
        `#${String(step.stepId).padEnd(3)} ${(step.stepName || "").slice(0, Math.max(10, w - 46))} ${step.status.padEnd(11)} ${age}${cur}`;
      out.push(fit(active ? hl(this.theme, text) : text, w));
    });
    out.push(rule(w, this.theme));

    // ── 选中 step 的时间线 ──
    const sel = this.currentStep();
    if (sel) {
      const budget = 12;
      const events = sel.events;
      const shownEvents = events.slice(-budget);
      if (shownEvents.length === 0) {
        out.push(fit(color(this.theme, "dim", "  （尚无事件）"), w));
      } else {
        for (const event of shownEvents) {
          const mark = kindMark(event.kind);
          const token =
            event.kind === "tool" ? "accent" : event.kind === "result" ? "dim" : event.kind === "text" ? "success" : "warning";
          out.push(fit(`  ${color(this.theme, "dim", mark)} ${color(this.theme, token, event.text)}`, w));
        }
        if (events.length > budget) {
          out.push(fit(color(this.theme, "dim", `   … 共 ${events.length} 条，显示最后 ${budget} 条`), w));
        }
      }
    }

    out.push(rule(w, this.theme));
    out.push(
      keyHelp(
        [
          { keys: "↑↓", label: "切 step" },
          { keys: "c", label: "清空记录" },
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
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
      this.done({ action: "quit" });
      return;
    }
    if (data === "c") {
      this.done({ action: "clear" });
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.list.move(-1, this.steps().length);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.list.move(1, this.steps().length);
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

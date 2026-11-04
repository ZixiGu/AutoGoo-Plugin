/**
 * Shared TUI kit — 复用给多个管理界面的小工具集。
 *
 * 之前 `thread-ui.ts` 把导航、滚动窗口、CJK 截断、按键提示全手写了一遍。
 * 再铺几个界面就会重复 3–4 次，所以先抽出这层。
 *
 * 只做「渲染原语 + 状态容器」，不含业务语义，也不做 IO。
 */

import type { Theme } from "@earendil-works/pi-tui";
import { logError } from "./log.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface KeyHelpItem {
  /** 按键提示，如 "↑↓" / "⏎" / "q" */
  keys: string;
  /** 动作说明 */
  label: string;
}

/** 把一行裁到指定显示宽度（CJK 安全），可选补空格。 */
export function fit(text: string, width: number, pad = true): string {
  const w = Math.max(1, width);
  const cut = truncateToWidth(text, w);
  if (!pad) return cut;
  return cut + " ".repeat(Math.max(0, w - visibleWidth(cut)));
}

/** 安全取色：theme 不可用或 token 非法时回退为原文。 */
export function color(theme: Theme | undefined, token: string, text: string): string {
  try {
    return theme ? theme.fg(token as any, text) : text;
  } catch {
    return text;
  }
}

export function rule(width: number, theme?: Theme): string {
  return color(theme, "accent", "─".repeat(Math.max(1, width)));
}

/** 标题行：左侧标题，右侧补充信息。 */
export function headerLine(title: string, right: string, width: number, theme?: Theme): string {
  const usable = Math.max(1, width);
  const rightFitted = truncateToWidth(right, Math.max(0, Math.floor(usable / 2)));
  const leftBudget = Math.max(1, usable - visibleWidth(rightFitted) - 1);
  const left = truncateToWidth(title, leftBudget);
  const gap = Math.max(0, usable - visibleWidth(left) - visibleWidth(rightFitted));
  return color(theme, "accent", left) + " ".repeat(gap) + color(theme, "dim", rightFitted);
}

/**
 * 底部按键提示。放不下时**从尾部丢项**并补 `…`，绝不截断成半个按键说明
 * （截断会显示成 `c 清空 ·...` 这种看不懂的样子）。
 */
export function keyHelp(items: KeyHelpItem[], width: number, theme?: Theme): string {
  const w = Math.max(1, width);
  const render = (list: KeyHelpItem[]) => {
    const text = list.map((i) => `${i.keys} ${i.label}`).join("  ·  ");
    return ` ${text}`;
  };
  let list = items.slice();
  while (list.length > 0 && visibleWidth(render(list)) > w) {
    list = list.slice(0, -1);
  }
  let text = list.length > 0 ? render(list) : " ";
  if (list.length < items.length) {
    text = `${text}  ·  …`;
    while (visibleWidth(text) > w && text.length > 1) {
      text = text.slice(0, -1);
    }
  }
  return fit(color(theme, "dim", text), w);
}

/** 选中行高亮（统一风格，避免每个界面各写一套）。 */
export function selected(theme: Theme | undefined, text: string): string {
  return color(theme, "accent", text);
}

/** 状态 → 语义色 token。 */
export function statusToken(status: string): string {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "accent";
    case "failed":
      return "error";
    case "blocked":
    case "interrupted":
      return "warning";
    default:
      return "dim";
  }
}

export function statusMark(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "running":
      return "►";
    case "failed":
      return "✗";
    case "blocked":
      return "⏸";
    case "interrupted":
      return "⏸";
    default:
      return "·";
  }
}

/** 数字格式化：1_234_567 → 1,234,567 */
export function fmtInt(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "-";
  return Math.round(n).toLocaleString("en-US");
}

/** 紧凑数字：1.2M / 340K */
export function fmtCompact(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(digits)}%`;
}

/** 横向条形图（按占比着色）。 */
export function bar(value: number, max: number, cells = 24, theme?: Theme): string {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = Math.round(ratio * cells);
  const token = ratio > 0.66 ? "success" : ratio > 0.33 ? "warning" : "accent";
  return color(theme, token, "█".repeat(filled)) + color(theme, "dim", "░".repeat(cells - filled));
}

/** 时间显示：ISO → HH:MM:SS（本地），解析失败原样返回。 */
export function fmtTime(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 相对时间：3s 前 / 2m 前 / 1h 前。 */
export function fmtAge(value: string | null | undefined, nowMs = Date.now()): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const sec = Math.max(0, Math.round((nowMs - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/**
 * 列表选择状态：选中项 + 滚动窗口。多个界面共用，避免各写一套。
 */
export class ListState {
  selected = 0;
  offset = 0;

  constructor(
    private readonly windowSize: number,
    initial = 0,
  ) {
    this.selected = Math.max(0, initial);
    this.clamp(Number.POSITIVE_INFINITY);
  }

  move(delta: number, total: number): void {
    if (total <= 0) return;
    this.selected = (this.selected + delta + total) % total;
    this.clamp(total);
  }

  jumpToFirst(total: number): void {
    this.selected = 0;
    this.clamp(total);
  }

  jumpToLast(total: number): void {
    this.selected = Math.max(0, total - 1);
    this.clamp(total);
  }

  clamp(total: number): void {
    if (Number.isFinite(total) && total > 0) {
      this.selected = Math.min(this.selected, total - 1);
    }
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + this.windowSize) {
      this.offset = this.selected - this.windowSize + 1;
    }
    const maxOffset = Math.max(0, (Number.isFinite(total) ? total : this.selected + 1) - this.windowSize);
    if (this.offset > maxOffset) this.offset = maxOffset;
    if (this.offset < 0) this.offset = 0;
  }

  /** 当前窗口的 [start, end) 区间。 */
  range(total: number): [number, number] {
    const start = Math.min(this.offset, Math.max(0, total - 1));
    const end = Math.min(total, start + this.windowSize);
    return [start, end];
  }
}

/**
 * 渲染兜底：任何面板的 render 抛异常时，降级成一行错误提示，而不是让
 * pi 整个进程 uncaughtException 退出。
 *
 * 背景：observe-panel 曾因引用了 render() 的局部变量而抛 ReferenceError，
 * pi 直接 "exiting due to uncaughtException" —— 一个界面 bug 不该杀死编辑器。
 */
export function guardRender<T extends { render(width: number): string[] }>(
  inner: T,
  theme: Theme | undefined,
  label: string,
): T {
  const original = inner.render.bind(inner);
  (inner as any).render = (width: number) => {
    try {
      return original(width);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      try {
        logError(`[AutoGoo-Plugin] ${label} render error:`, e);
      } catch {
        /* 日志失败不阻塞 */
      }
      const w = Math.max(20, width);
      return [
        color(theme, "error", fit(` ${label} 渲染失败`, w, false)),
        color(theme, "dim", fit(`  ${msg}`, w, false)),
        color(theme, "dim", fit("  已降级显示；按 q 退出后可用 CLI（goo-status.py / goo-observe.py）查看。", w, false)),
      ];
    }
  };
  return inner;
}

/** 多行文本块裁剪：把 tail 列表裁到 budget 行。 */
export function clip(lines: string[], budget: number): string[] {
  if (budget <= 0) return [];
  if (lines.length <= budget) return lines;
  return lines.slice(lines.length - budget);
}

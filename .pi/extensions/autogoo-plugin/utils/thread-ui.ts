/**
 * Thread manager — 键盘驱动的交互式管理界面（pi TUI 自定义组件）。
 *
 * 之前 `/goo-thread` 只是把表格 print 出来，看完就没了。这里用
 * `ctx.ui.custom()` 做一个常驻的列表界面：↑↓ 移动、回车切换、r/a/c 等快捷键。
 *
 * 设计边界（重要）：
 *   组件**只负责导航**，自身不执行任何写操作。它通过 `done(action)` 把
 *   用户意图交回调用方，由 `handleGooThread` 用普通对话框（确认/输入）+
 *   脚本完成动作。这样：
 *     - 危险操作（关闭/删除）仍走既有的确认与归档逻辑；
 *     - 组件可以无副作用地反复重建（动作后刷新列表）。
 */

import type { Component, KeybindingsManager, Theme } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface ThreadRow {
  id: string;
  title: string;
  status: string;
  plan_status: string;
  steps: string;
  has_plan: boolean;
  updated_at: string;
  is_current: boolean;
  flag: "ok" | "done" | "needs-attention" | "inconsistent";
  health_state?: string | null;
  health_reasons?: string[];
  age_hours?: number | null;
}

export type ThreadAction =
  | { action: "quit" }
  | { action: "switch"; threadId: string }
  | { action: "rename"; threadId: string }
  | { action: "archive"; threadId: string }
  | { action: "restore"; threadId: string }
  | { action: "close"; threadId: string }
  | { action: "doctor" }
  | { action: "refresh" };

const MARK: Record<string, string> = {
  ok: "✓",
  done: "·",
  "needs-attention": "⚠",
  inconsistent: "≠",
};

const MAX_LIST_ROWS = 12;

export class ThreadManager implements Component {
  private selected: number;
  private offset = 0;
  private readonly theme: Theme;
  private readonly rows: ThreadRow[];
  private readonly currentId: string | null;
  private readonly done: (action: ThreadAction) => void;
  private readonly requestRender: () => void;
  private readonly keybindings?: KeybindingsManager;

  constructor(
    rows: ThreadRow[],
    currentId: string | null,
    theme: Theme,
    done: (action: ThreadAction) => void,
    requestRender: () => void,
    keybindings?: KeybindingsManager,
  ) {
    this.rows = rows;
    this.currentId = currentId;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
    this.keybindings = keybindings;
    const idx = rows.findIndex((r) => r.id === currentId);
    this.selected = idx >= 0 ? idx : 0;
    this.ensureVisible();
  }

  private ensureVisible(): void {
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + MAX_LIST_ROWS) {
      this.offset = this.selected - MAX_LIST_ROWS + 1;
    }
    const maxOffset = Math.max(0, this.rows.length - MAX_LIST_ROWS);
    if (this.offset > maxOffset) this.offset = maxOffset;
    if (this.offset < 0) this.offset = 0;
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    this.selected = (this.selected + delta + this.rows.length) % this.rows.length;
    this.ensureVisible();
    this.requestRender();
  }

  private current(): ThreadRow | undefined {
    return this.rows[this.selected];
  }

  private fg(token: string, text: string): string {
    try {
      return this.theme.fg(token as any, text);
    } catch {
      return text;
    }
  }

  private line(width: number, text: string, pad = true): string {
    const fitted = truncateToWidth(text, Math.max(1, width));
    if (!pad) return fitted;
    const padWidth = Math.max(0, width - visibleWidth(fitted));
    return fitted + " ".repeat(padWidth);
  }

  render(width: number): string[] {
    const out: string[] = [];
    const w = Math.max(20, width);

    out.push(this.fg("accent", "─".repeat(w)));
    const header = ` AutoGoo Threads · ${this.rows.length} 个 · 当前 ${this.currentId ?? "(无)"}`;
    out.push(this.line(w, this.fg("accent", header)));
    out.push(
      this.line(
        w,
        this.fg("dim", " ↑↓/jk 移动   ⏎ 切换   r 重命名   a 归档   u 恢复   c 关闭   d 对账   q 退出"),
      ),
    );
    out.push(this.fg("accent", "─".repeat(w)));

    if (this.rows.length === 0) {
      out.push(this.line(w, this.fg("dim", " （没有 thread，按 q 退出后用 goo-thread new \"<标题>\" 创建）")));
    } else {
      const idWidth = Math.min(
        42,
        Math.max(18, ...this.rows.map((r) => r.id.length)),
      );
      const visible = this.rows.slice(this.offset, this.offset + MAX_LIST_ROWS);
      visible.forEach((row, i) => {
        const absolute = this.offset + i;
        const active = absolute === this.selected;
        const cursor = active ? "›" : " ";
        const star = row.is_current ? "*" : " ";
        const mark = MARK[row.flag] ?? "?";
        const id = row.id.length > idWidth ? row.id.slice(0, idWidth - 1) + "…" : row.id.padEnd(idWidth);
        const plan = row.has_plan ? `${row.plan_status}/${row.steps}` : "—";
        const title = row.title.replace(/\s+/g, " ").slice(0, 40);
        const text = ` ${cursor}${star} ${id}  ${mark} ${row.status.padEnd(10)} ${plan.padEnd(16)} ${title}`;
        const styled = active ? this.fg("accent", text) : text;
        out.push(this.line(w, styled));
      });
      if (this.rows.length > MAX_LIST_ROWS) {
        out.push(
          this.line(
            w,
            this.fg("dim", `   … 共 ${this.rows.length} 个，当前窗口 ${this.offset + 1}-${this.offset + visible.length}`),
          ),
        );
      }
    }

    out.push(this.fg("accent", "─".repeat(w)));

    const sel = this.current();
    if (sel) {
      out.push(this.line(w, this.fg("accent", ` ${sel.is_current ? "* 当前" : "  选中"}: ${sel.title}`)));
      out.push(
        this.line(
          w,
          this.fg(
            "dim",
            `   id: ${sel.id}　状态: ${sel.status}　计划: ${sel.has_plan ? sel.plan_status : "无"} (${sel.steps})`,
          ),
        ),
      );
      const age = typeof sel.age_hours === "number" ? `　未更新 ${sel.age_hours}h` : "";
      out.push(this.line(w, this.fg("dim", `   最近更新: ${sel.updated_at}${age}`)));
      if (sel.health_reasons && sel.health_reasons.length > 0) {
        out.push(this.line(w, this.fg("warning", `   ⚠ ${sel.health_reasons.join("；")}`)));
      } else {
        out.push(this.line(w, this.fg("success", `   健康: ${sel.health_state ?? "unknown"}`)));
      }
    }

    out.push(this.fg("accent", "─".repeat(w)));
    return out;
  }

  invalidate(): void {
    /* 无缓存，纯函数式渲染 */
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
      this.done({ action: "quit" });
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.move(-1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.move(1);
      return;
    }
    if (matchesKey(data, "home") || data === "g") {
      this.selected = 0;
      this.ensureVisible();
      this.requestRender();
      return;
    }
    if (matchesKey(data, "end") || data === "G") {
      this.selected = Math.max(0, this.rows.length - 1);
      this.ensureVisible();
      this.requestRender();
      return;
    }

    const sel = this.current();
    if (!sel) return;

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      if (!sel.is_current) this.done({ action: "switch", threadId: sel.id });
      return;
    }
    if (data === "r") {
      this.done({ action: "rename", threadId: sel.id });
      return;
    }
    if (data === "a") {
      if (sel.status !== "archived") this.done({ action: "archive", threadId: sel.id });
      return;
    }
    if (data === "u") {
      if (sel.status === "archived") this.done({ action: "restore", threadId: sel.id });
      return;
    }
    if (data === "c") {
      this.done({ action: "close", threadId: sel.id });
      return;
    }
    if (data === "d") {
      this.done({ action: "doctor" });
      return;
    }
    if (data === "R") {
      this.done({ action: "refresh" });
    }
  }
}

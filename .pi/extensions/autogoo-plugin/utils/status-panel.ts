/**
 * goo-status 的 pi TUI 仪表盘。
 *
 * 原来 `/goo-status` 只打印一次文本快照（goo-status.py 没有 --watch、没有
 * --json），而它要表达的恰恰是**实时状态**。这里做成：步骤列表 + 详情面板 +
 * 2s 自动刷新 + 选中步骤的 log 尾部。
 */

import type { Component, KeybindingsManager, Theme } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  clip,
  color,
  fit,
  fmtAge,
  headerLine,
  keyHelp,
  ListState,
  rule,
  selected as hl,
  statusMark,
  statusToken,
} from "./tui-kit.js";

export interface StatusStep {
  id: number | string;
  name: string;
  status: string;
  progress: number;
  heartbeat_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  agent_id?: string | null;
  error?: string | null;
  log_path?: string | null;
  description?: string;
}

export interface StatusData {
  threadId?: string | null;
  task: string;
  planStatus: string;
  steps: StatusStep[];
  updatedAt?: string | null;
}

export type StatusAction = { action: "quit" } | { action: "refresh" };

function progressBar(pct: number, cells = 10, theme?: Theme): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * cells);
  return color(theme, "success", "▰".repeat(filled)) + color(theme, "dim", "▱".repeat(cells - filled));
}

export class StatusPanel implements Component {
  private readonly theme: Theme;
  private readonly done: (a: StatusAction) => void;
  private readonly requestRender: () => void;
  private readonly loadLog: (step: StatusStep) => string[];
  private readonly onRefresh: () => StatusData | null;
  private data: StatusData;
  private readonly list: ListState;
  private logCache: { stepKey: string; lines: string[] } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRefresh = Date.now();

  constructor(
    data: StatusData,
    theme: Theme,
    done: (a: StatusAction) => void,
    requestRender: () => void,
    loadLog: (step: StatusStep) => string[],
    onRefresh: () => StatusData | null,
    private readonly keybindings?: KeybindingsManager,
  ) {
    this.data = data;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
    this.loadLog = loadLog;
    this.onRefresh = onRefresh;

    const runningIdx = data.steps.findIndex((s) => s.status === "running");
    this.list = new ListState(10, runningIdx >= 0 ? runningIdx : 0);

    // 2s 自动刷新（面板存活期间）。dispose 里清理，避免泄漏。
    this.timer = setInterval(() => {
      this.refresh(true);
    }, 2000);
    if (this.timer && typeof (this.timer as any).unref === "function") {
      (this.timer as any).unref();
    }
  }

  private stepKey(): string {
    const s = this.data.steps[this.list.selected];
    return s ? String(s.id) : "";
  }

  private refresh(silent: boolean): void {
    const next = this.onRefresh();
    if (!next) return;
    this.data = next;
    this.list.clamp(next.steps.length);
    this.lastRefresh = Date.now();
    if (!silent) this.logCache = null;
    this.requestRender();
  }

  private logLines(): string[] {
    const step = this.data.steps[this.list.selected];
    if (!step) return [];
    const key = String(step.id);
    if (this.logCache && this.logCache.stepKey === key) return this.logCache.lines;
    let lines: string[] = [];
    try {
      lines = this.loadLog(step);
    } catch {
      lines = [];
    }
    this.logCache = { stepKey: key, lines };
    return lines;
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const out: string[] = [];
    const d = this.data;
    const done = d.steps.filter((s) => s.status === "completed").length;
    const total = d.steps.length;
    const pct = total > 0 ? (done / total) * 100 : 0;

    out.push(rule(w, this.theme));
    out.push(
      headerLine(
        ` AutoGoo Status`,
        `${d.threadId ?? "(no thread)"} · ${done}/${total} · ${d.planStatus}`,
        w,
        this.theme,
      ),
    );
    out.push(fit(` ${d.task.slice(0, w - 4)}`, w));
    out.push(fit(` ${progressBar(pct, 20, this.theme)} ${pct.toFixed(0)}%`, w));
    out.push(rule(w, this.theme));

    if (total === 0) {
      out.push(fit(color(this.theme, "dim", "  （当前 thread 没有 plan 步骤）"), w));
    } else {
      const [start, end] = this.list.range(total);
      d.steps.slice(start, end).forEach((step, i) => {
        const idx = start + i;
        const active = idx === this.list.selected;
        const mark = statusMark(step.status);
        const id = String(step.id).slice(0, 4).padEnd(4);
        const name = (step.name || "").slice(0, Math.max(12, w - 52)).padEnd(Math.max(12, w - 52));
        const hb = step.status === "running" ? `hb ${fmtAge(step.heartbeat_at)}` : "";
        const text =
          ` ${active ? "›" : " "} ${color(this.theme, statusToken(step.status), mark)} ${id} ` +
          `${name} ${String(step.status).padEnd(10)} ${String(step.progress ?? 0).padStart(3)}% ${hb}`;
        out.push(fit(active ? hl(this.theme, text) : text, w));
      });
      if (total > 10) {
        out.push(fit(color(this.theme, "dim", `   … 共 ${total} 步（窗口 ${start + 1}-${end}）`), w));
      }
    }

    out.push(rule(w, this.theme));

    const sel = d.steps[this.list.selected];
    if (sel) {
      out.push(fit(` ${hl(this.theme, `#${sel.id} ${sel.name}`)}`, w));
      const meta = [
        `status=${sel.status}`,
        `progress=${sel.progress ?? 0}%`,
        sel.agent_id ? `agent=${sel.agent_id}` : "",
        sel.heartbeat_at ? `hb=${fmtAge(sel.heartbeat_at)} 前` : "",
      ]
        .filter(Boolean)
        .join("  ");
      out.push(fit(color(this.theme, "dim", ` ${meta}`), w));
      if (sel.error) {
        out.push(fit(color(this.theme, "error", ` ✗ ${String(sel.error).slice(0, w - 4)}`), w));
      }
      const log = this.logLines();
      out.push(fit(color(this.theme, "dim", ` ── log 尾部（${sel.log_path ?? "无"}） ──`), w));
      if (log.length === 0) {
        out.push(fit(color(this.theme, "dim", "  （暂无日志内容）"), w));
      } else {
        for (const line of clip(log, 6)) out.push(fit(`  ${line}`, w));
      }
    }

    out.push(rule(w, this.theme));
    out.push(
      keyHelp(
        [
          { keys: "↑↓", label: "移动" },
          { keys: "r", label: "立即刷新" },
          { keys: "q", label: "退出" },
        ].concat(
          total > 0
            ? [{ keys: `自动刷新 ${Math.max(0, 2 - Math.round((Date.now() - this.lastRefresh) / 1000))}s`, label: "" }]
            : [],
        ),
        w,
        this.theme,
      ),
    );
    return out;
  }

  invalidate(): void {
    /* 无缓存（logCache 由选中变化驱动） */
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
      this.done({ action: "quit" });
      return;
    }
    if (data === "r") {
      this.refresh(false);
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.list.move(-1, this.data.steps.length);
      this.logCache = null;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.list.move(1, this.data.steps.length);
      this.logCache = null;
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

/**
 * goo-usage 的 pi TUI 面板。
 *
 * 之前 `handleGooUsage` 把脚本输出 strip ANSI 后塞进
 * `sendUserMessage(deliverAs: "followUp")` —— 既被排队，又变成"发给模型"的
 * 消息，用户实际上看不到面板。这里改成真正的 TUI：4 个 tab，方向键切换。
 *
 * 数据来自 `goo-usage.py --json`（与脚本自带的终端面板同一份数据源），
 * 渲染逻辑在 pi 侧，避免依赖 python 的 TTY 探测。
 */

import type { Component, KeybindingsManager, Theme } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  bar,
  color,
  fit,
  fmtCompact,
  fmtInt,
  fmtPct,
  headerLine,
  keyHelp,
  ListState,
  rule,
  selected as hl,
  tabsLine,
} from "./tui-kit.js";

export interface UsageData {
  tokens: number;
  cost: number;
  messages: number;
  sessions: number;
  records: number;
  minutes: number;
  breakdown: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  projects: Array<{ name: string; cwd?: string; tokens: number; records?: number; sessions?: number; models?: string; last?: string }>;
  models: Array<{ name: string; tokens: number; records?: number; sessions?: number; cost?: number }>;
  hourly: number[];
  since?: string;
  until?: string;
}

const TABS = ["overview", "projects", "models", "history"] as const;
type Tab = (typeof TABS)[number];

export type UsageAction =
  | { action: "quit" }
  | { action: "refresh" }
  | { action: "tab"; tab: Tab };

export class UsagePanel implements Component {
  private tabIndex = 0;
  private readonly list = new ListState(8, 0);
  private readonly theme: Theme;
  private readonly data: UsageData;
  private readonly done: (a: UsageAction) => void;
  private readonly requestRender: () => void;

  constructor(
    data: UsageData,
    theme: Theme,
    done: (a: UsageAction) => void,
    requestRender: () => void,
    private readonly keybindings?: KeybindingsManager,
  ) {
    this.data = data;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
  }

  private get tab(): Tab {
    return TABS[this.tabIndex];
  }

  private rowCount(): number {
    switch (this.tab) {
      case "projects":
        return this.data.projects.length;
      case "models":
        return this.data.models.length;
      case "history":
        return 24;
      default:
        return 0;
    }
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const out: string[] = [];
    const d = this.data;

    out.push(rule(w, this.theme));
    out.push(
      headerLine(
        " ◆ AutoGoo Usage",
        w < 60 ? `${fmtCompact(d.tokens)} · ${d.sessions} 会话` : `${fmtInt(d.tokens)} tokens · ${d.sessions} sessions`,
        w,
        this.theme,
      ),
    );

    const tabDefs = [
      { index: 0, short: "ov", full: "overview" },
      { index: 1, short: "pr", full: "projects" },
      { index: 2, short: "mo", full: "models" },
      { index: 3, short: "hi", full: "history" },
    ];
    out.push(tabsLine(tabDefs, this.tabIndex, w, this.theme));
    out.push(rule(w, this.theme));

    const budget = 14;
    const body = this.renderBody(w);
    for (const line of body.slice(0, budget)) out.push(line);
    for (let i = body.length; i < budget; i++) out.push(fit("", w));

    out.push(rule(w, this.theme));
    out.push(
      keyHelp(
        [
          { keys: "←→/1-4", label: "切 tab" },
          { keys: "↑↓", label: "移动" },
          { keys: "r", label: "刷新" },
          { keys: "q", label: "退出" },
        ],
        w,
        this.theme,
      ),
    );
    return out;
  }

  private renderBody(w: number): string[] {
    const d = this.data;
    const L: string[] = [];
    const kv = (k: string, v: string) =>
      L.push(fit(`  ${color(this.theme, "dim", k.padEnd(16))}${v}`, w));

    if (this.tab === "overview") {
      kv("Total tokens", color(this.theme, "accent", fmtInt(d.tokens)));
      kv("Messages", fmtInt(d.messages));
      kv("Sessions", fmtInt(d.sessions));
      kv("Cost", `$${(d.cost ?? 0).toFixed(4)}`);
      kv("Active", `${(d.minutes / 60).toFixed(1)}h`);
      L.push(fit("", w));
      L.push(fit(`  ${color(this.theme, "accent", "Token 构成")}`, w));
      const b = d.breakdown || {};
      const parts: Array<[string, number]> = [
        ["input", Number(b.input_tokens ?? 0)],
        ["output", Number(b.output_tokens ?? 0)],
        ["cache create", Number(b.cache_creation_input_tokens ?? 0)],
        ["cache read", Number(b.cache_read_input_tokens ?? 0)],
      ];
      const max = Math.max(1, ...parts.map(([, v]) => v));
      const narrow = w < 60;
      for (const [name, value] of parts) {
        const pct = d.tokens > 0 ? (value / d.tokens) * 100 : 0;
        const label = color(this.theme, "dim", name.padEnd(narrow ? 10 : 14));
        const amount = fmtInt(value).padStart(narrow ? 12 : 14);
        L.push(
          fit(
            narrow
              ? `  ${label}${amount}`
              : `  ${label}${amount}  ${fmtPct(pct).padStart(6)}  ${bar(value, max, 16, this.theme)}`,
            w,
          ),
        );
      }
      return L;
    }

    if (this.tab === "projects") {
      if (d.projects.length === 0) return [fit(color(this.theme, "dim", "  （今日暂无项目数据）"), w)];
      const [start, end] = this.list.range(d.projects.length);
      const max = Math.max(1, ...d.projects.map((p) => p.tokens));
      d.projects.slice(start, end).forEach((p, i) => {
        const idx = start + i;
        const active = idx === this.list.selected;
        const name = (p.name || "?").slice(0, 28).padEnd(28);
        const text = w < 60
          ? ` ${active ? "›" : " "} ${name} ${fmtCompact(p.tokens).padStart(8)}`
          : ` ${active ? "›" : " "} ${name} ${fmtCompact(p.tokens).padStart(8)}  ${bar(p.tokens, max, 12, this.theme)}`;
        L.push(fit(active ? hl(this.theme, text) : text, w));
      });
      return L;
    }

    if (this.tab === "models") {
      if (d.models.length === 0) return [fit(color(this.theme, "dim", "  （今日暂无模型数据）"), w)];
      const [start, end] = this.list.range(d.models.length);
      const max = Math.max(1, ...d.models.map((m) => m.tokens));
      d.models.slice(start, end).forEach((m, i) => {
        const idx = start + i;
        const active = idx === this.list.selected;
        const name = (m.name || "?").slice(0, 24).padEnd(24);
        const text = w < 60
          ? ` ${active ? "›" : " "} ${name} ${fmtCompact(m.tokens).padStart(8)}`
          : ` ${active ? "›" : " "} ${name} ${fmtCompact(m.tokens).padStart(8)}  ${bar(m.tokens, max, 14, this.theme)}  $${(m.cost ?? 0).toFixed(4)}`;
        L.push(fit(active ? hl(this.theme, text) : text, w));
      });
      return L;
    }

    // history：24 小时分布
    const hourly = Array.isArray(d.hourly) ? d.hourly : [];
    const max = Math.max(1, ...hourly);
    for (let h = 0; h < 24; h += 1) {
      const value = Number(hourly[h] ?? 0);
      const label = `${String(h).padStart(2, "0")}:00`;
      L.push(
        fit(
          w < 60
            ? `  ${color(this.theme, "dim", label)} ${fmtCompact(value).padStart(9)}`
            : `  ${color(this.theme, "dim", label)} ${fmtCompact(value).padStart(9)}  ${bar(value, max, 30, this.theme)}`,
          w,
        ),
      );
    }
    return L;
  }

  invalidate(): void {
    /* 无缓存 */
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
      this.done({ action: "quit" });
      return;
    }
    if (data === "r") {
      this.done({ action: "refresh" });
      return;
    }
    if (matchesKey(data, "left") || data === "h") {
      this.tabIndex = (this.tabIndex + TABS.length - 1) % TABS.length;
      this.list.selected = 0;
      this.list.clamp(this.rowCount());
      this.requestRender();
      return;
    }
    if (matchesKey(data, "right") || matchesKey(data, "tab") || data === "l") {
      this.tabIndex = (this.tabIndex + 1) % TABS.length;
      this.list.selected = 0;
      this.list.clamp(this.rowCount());
      this.requestRender();
      return;
    }
    if (data >= "1" && data <= String(TABS.length)) {
      this.tabIndex = Number(data) - 1;
      this.list.selected = 0;
      this.list.clamp(this.rowCount());
      this.requestRender();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.list.move(-1, this.rowCount());
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.list.move(1, this.rowCount());
      this.requestRender();
    }
  }
}

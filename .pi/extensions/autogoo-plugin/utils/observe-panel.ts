/**
 * 统一观察面板（ObservePanel）—— 合并原先的 goo-status 与 goo-observe。
 *
 * 为什么合并：两者是同一件事的两个切面，却分成两套呈现，
 *   - goo-status.py 打印大方框（计数 / slots / Next），TUI 面板只有步骤列表；
 *   - goo-observe.py 打印路径 / claude 版本 / shell 模板 / running 明细。
 * 信息被劈成两半，用户得跑两个命令才拼出全貌（这就是"混乱"的来源）。
 *
 * 现在一个面板四个 tab：
 *   [1] Steps     全部步骤 + 详情 + log 尾部 + 2s 自动刷新（原 StatusPanel）
 *   [2] Overview  状态计数 / 槽位 / Next 提示
 *   [3] Env       路径、claude 版本、Agent View、shell tee 模板
 *   [4] Shell     logs/shell/*.log 列表与尾部
 *
 * `/goo-status` 与 `/goo-observe` 打开同一个面板，只是初始 tab 不同。
 */

import type { Component, KeybindingsManager, Theme } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  bar,
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
  tabsLine,
} from "./tui-kit.js";

export interface ObserveStep {
  id: number | string;
  name: string;
  status: string;
  progress: number;
  heartbeat_at?: string | null;
  agent_id?: string | null;
  error?: string | null;
  log_path?: string | null;
  subagent?: string | null;
  task_agent?: string | null;
}

export interface ObserveShellLog {
  path: string;
  mtime?: number;
  tail: string[];
}

export interface ObserveSnapshot {
  root: string;
  threadId?: string | null;
  planPath: string;
  logsDir: string;
  shellLogDir: string;
  claudeVersion?: string;
  planStatus: string;
  task: string;
  steps: ObserveStep[];
  shellLogs: ObserveShellLog[];
  commands?: Record<string, string>;
  /** 召回观测统计（来自 .goo/logs/recall.jsonl） */
  recall?: import("./recall-observe.js").RecallStats;
}

export type ObserveTab = "steps" | "overview" | "recall" | "env" | "shell";

const TAB_ORDER: ObserveTab[] = ["steps", "overview", "recall", "env", "shell"];

export type ObserveAction = { action: "quit" } | { action: "refresh" };

export { renderRecallTab } from "./recall-tab.js";
import { renderRecallTab } from "./recall-tab.js";

export class ObservePanel implements Component {
  private tabIndex: number;
  private readonly stepList: ListState;
  private readonly shellList: ListState;
  private data: ObserveSnapshot;
  private readonly theme: Theme;
  private readonly done: (a: ObserveAction) => void;
  private readonly requestRender: () => void;
  private readonly loadLog: (step: ObserveStep) => string[];
  private readonly onRefresh: () => ObserveSnapshot | null;
  private logCache: { key: string; lines: string[] } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRefresh = Date.now();

  constructor(
    data: ObserveSnapshot,
    initialTab: ObserveTab,
    theme: Theme,
    done: (a: ObserveAction) => void,
    requestRender: () => void,
    loadLog: (step: ObserveStep) => string[],
    onRefresh: () => ObserveSnapshot | null,
    private readonly keybindings?: KeybindingsManager,
  ) {
    this.data = data;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
    this.loadLog = loadLog;
    this.onRefresh = onRefresh;
    this.tabIndex = Math.max(0, TAB_ORDER.indexOf(initialTab));

    const runningIdx = data.steps.findIndex((s) => s.status === "running");
    this.stepList = new ListState(10, runningIdx >= 0 ? runningIdx : 0);
    this.shellList = new ListState(8, 0);

    this.timer = setInterval(() => this.refresh(true), 2000);
    if (this.timer && typeof (this.timer as any).unref === "function") {
      (this.timer as any).unref();
    }
  }

  private get tab(): ObserveTab {
    return TAB_ORDER[this.tabIndex];
  }

  private refresh(silent: boolean): void {
    const next = this.onRefresh();
    if (!next) return;
    this.data = next;
    this.stepList.clamp(next.steps.length);
    this.shellList.clamp(next.shellLogs.length);
    this.lastRefresh = Date.now();
    if (!silent) this.logCache = null;
    this.requestRender();
  }

  private counts(): Record<string, number> {
    const acc: Record<string, number> = {};
    for (const step of this.data.steps) {
      acc[step.status] = (acc[step.status] || 0) + 1;
    }
    return acc;
  }

  private stepLogLines(): string[] {
    const step = this.data.steps[this.stepList.selected];
    if (!step) return [];
    const key = String(step.id);
    if (this.logCache && this.logCache.key === key) return this.logCache.lines;
    let lines: string[] = [];
    try {
      lines = this.loadLog(step);
    } catch {
      lines = [];
    }
    this.logCache = { key, lines };
    return lines;
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const out: string[] = [];
    const d = this.data;
    const counts = this.counts();
    const total = d.steps.length;
    const doneCount = counts.completed ?? 0;
    const pct = total > 0 ? (doneCount / total) * 100 : 0;

    out.push(rule(w, this.theme));
    out.push(
      headerLine(
        " ◆ AutoGoo Observe",
        w < 60
          ? `${doneCount}/${total} · ${d.planStatus}`
          : `${d.threadId ?? "(no thread)"} · ${doneCount}/${total} · ${d.planStatus}`,
        w,
        this.theme,
      ),
    );
    const tabDefs = TAB_ORDER.map((t, i) => ({
      index: i,
      short: t.slice(0, 2),
      full: t,
    }));
    out.push(tabsLine(tabDefs, this.tabIndex, w, this.theme));
    out.push(rule(w, this.theme));

    const body = this.renderBody(w, counts, pct);
    const budget = 16;
    for (const line of body.slice(0, budget)) out.push(line);
    for (let i = body.length; i < budget; i++) out.push(fit("", w));

    out.push(rule(w, this.theme));
    const secondsLeft = Math.max(0, 2 - Math.round((Date.now() - this.lastRefresh) / 1000));
    out.push(
      keyHelp(
        [
          { keys: "←→/1-5", label: "切 tab" },
          { keys: "↑↓", label: "移动" },
          { keys: "r", label: "刷新" },
          { keys: "q", label: "退出" },
          { keys: `${secondsLeft}s`, label: "自动刷新" },
        ],
        w,
        this.theme,
      ),
    );
    return out;
  }

  private renderBody(w: number, counts: Record<string, number>, pct: number): string[] {
    const d = this.data;
    // 注意：这里的 total / doneCount 必须在函数内计算。
    // 曾经直接引用 render() 的局部变量 —— 因为 overview 的 Next 分支是短路求值，
    // 只有"没有 pending 步骤"时才会执行到，于是测试数据里恰好有 pending 就掩盖了崩溃。
    const total = d.steps.length;
    const doneCount = counts.completed ?? 0;
    const L: string[] = [];
    const kv = (k: string, v: string) =>
      L.push(fit(`  ${color(this.theme, "dim", k.padEnd(16))}${v}`, w));

    if (this.tab === "steps") {
      if (d.steps.length === 0) return [fit(color(this.theme, "dim", "  （当前 thread 没有 plan 步骤）"), w)];
      L.push(fit(` ${bar(pct, 100, 20, this.theme)} ${pct.toFixed(0)}%`, w));
      const [start, end] = this.stepList.range(d.steps.length);
      d.steps.slice(start, end).forEach((step, i) => {
        const active = start + i === this.stepList.selected;
        const narrow = w < 60;
        const nameWidth = narrow ? Math.max(8, w - 14) : Math.max(12, w - 46);
        const name = (step.name || "").slice(0, nameWidth).padEnd(nameWidth);
        const hb = step.status === "running" ? ` hb ${fmtAge(step.heartbeat_at)}` : "";
        const text = narrow
          ? ` ${active ? "›" : " "} ${color(this.theme, statusToken(step.status), statusMark(step.status))} ${name}`
          : ` ${active ? "›" : " "} ${color(this.theme, statusToken(step.status), statusMark(step.status))} ` +
            `${String(step.id).slice(0, 4).padEnd(4)} ${name} ${step.status.padEnd(10)} ${String(step.progress ?? 0).padStart(3)}%${hb}`;
        L.push(fit(active ? hl(this.theme, text) : text, w));
      });
      const sel = d.steps[this.stepList.selected];
      if (sel) {
        L.push(fit(color(this.theme, "dim", "  ── 选中详情 ──"), w));
        const meta = [
          `status=${sel.status}`,
          `progress=${sel.progress ?? 0}%`,
          sel.subagent ? `subagent=${sel.subagent}` : "",
          sel.agent_id ? `agent=${sel.agent_id}` : "",
          sel.heartbeat_at ? `hb=${fmtAge(sel.heartbeat_at)} 前` : "",
        ]
          .filter(Boolean)
          .join("  ");
        L.push(fit(`  ${meta}`, w));
        if (sel.error) L.push(fit(color(this.theme, "error", `  ✗ ${String(sel.error).slice(0, w - 6)}`), w));
        const log = this.stepLogLines();
        if (log.length > 0) {
          L.push(fit(color(this.theme, "dim", `  ── log 尾部（${sel.log_path ?? "无"}） ──`), w));
          for (const line of clip(log, 4)) L.push(fit(`   ${line}`, w));
        }
      }
      return L;
    }

    if (this.tab === "recall") {
      return renderRecallTab(d.recall, w, this.theme);
    }

    if (this.tab === "overview") {
      kv("Plan status", d.planStatus);
      kv("Progress", `${pct.toFixed(0)}%  (${bar(pct, 100, 16, this.theme)})`);
      L.push(fit("", w));
      L.push(fit(`  ${color(this.theme, "accent", "步骤状态")}`, w));
      const order = ["completed", "running", "pending", "blocked", "failed", "interrupted"];
      const max = Math.max(1, ...order.map((k) => counts[k] ?? 0));
      for (const key of order) {
        const value = counts[key] ?? 0;
        L.push(
          fit(
            `  ${color(this.theme, statusToken(key), statusMark(key))} ${key.padEnd(12)} ${String(value).padStart(3)}  ${bar(value, max, 20, this.theme)}`,
            w,
          ),
        );
      }
      const computed = this.computeReady();
      kv("ready / waiting", `${computed.ready} / ${computed.waiting}`);
      kv(
        "Next",
        total === 0
          ? "当前 thread 没有 plan 步骤"
          : doneCount === total
            ? "全部完成"
            : computed.ready > 0
              ? `${computed.ready} 步可派发`
              : "无就绪步骤（依赖未满足）",
      );
      return L;
    }

    if (this.tab === "env") {
      kv("root", d.root);
      kv("thread", d.threadId ?? "-");
      kv("plan", d.planPath || "-");
      kv("logs", d.logsDir || "-");
      kv("shell logs", d.shellLogDir || "-");
      kv("claude", d.claudeVersion || "-");
      L.push(fit("", w));
      L.push(fit(`  ${color(this.theme, "accent", "常用命令")}`, w));
      const cmds = d.commands || {};
      for (const [key, value] of Object.entries(cmds)) {
        if (key === "shell_template") continue;
        L.push(fit(`  ${color(this.theme, "dim", key.padEnd(12))} ${value}`, w));
      }
      if (cmds.shell_template) {
        L.push(fit(color(this.theme, "dim", "  shell 跟踪模板（长任务用）:"), w));
        L.push(fit(`   ${cmds.shell_template.slice(0, w - 4)}`, w));
      }
      return L;
    }

    // shell
    if (d.shellLogs.length === 0) {
      return [
        fit(color(this.theme, "dim", `  （${d.shellLogDir || "logs/shell"} 下暂无 *.log）`), w),
        fit("", w),
        fit(color(this.theme, "dim", "  长任务建议用 tee 跟踪："), w),
        fit(`   ${(d.commands?.shell_template || "").slice(0, w - 4)}`, w),
      ];
    }
    const [sStart, sEnd] = this.shellList.range(d.shellLogs.length);
    d.shellLogs.slice(sStart, sEnd).forEach((log, i) => {
      const active = sStart + i === this.shellList.selected;
      const name = log.path.split("/").pop() || log.path;
      const text = ` ${active ? "›" : " "} ${name}`;
      L.push(fit(active ? hl(this.theme, text) : text, w));
    });
    const sel = d.shellLogs[this.shellList.selected];
    if (sel && sel.tail?.length) {
      L.push(fit(color(this.theme, "dim", "  ── 尾部 ──"), w));
      for (const line of clip(sel.tail, 6)) L.push(fit(`   ${line}`, w));
    }
    return L;
  }

  /** 按 depends_on 计算真正"就绪"（依赖全部完成）与"等待中"的步数。 */
  private computeReady(): { ready: number; waiting: number } {
    const completed = new Set(
      this.data.steps.filter((s) => s.status === "completed").map((s) => String(s.id)),
    );
    let ready = 0;
    let waiting = 0;
    for (const step of this.data.steps) {
      if (step.status !== "pending") continue;
      const deps = ((step as any).depends_on ?? []) as Array<number | string>;
      const satisfied = deps.every((d) => completed.has(String(d)));
      if (satisfied) ready += 1;
      else waiting += 1;
    }
    return { ready, waiting };
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
      this.refresh(false);
      return;
    }
    if (data >= "1" && data <= String(TAB_ORDER.length)) {
      this.tabIndex = Number(data) - 1;
      this.logCache = null;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "left") || data === "h") {
      this.tabIndex = (this.tabIndex + TAB_ORDER.length - 1) % TAB_ORDER.length;
      this.logCache = null;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "right") || matchesKey(data, "tab") || data === "l") {
      this.tabIndex = (this.tabIndex + 1) % TAB_ORDER.length;
      this.logCache = null;
      this.requestRender();
      return;
    }
    if (this.tab === "steps") {
      if (matchesKey(data, "up") || data === "k") {
        this.stepList.move(-1, this.data.steps.length);
        this.logCache = null;
        this.requestRender();
      } else if (matchesKey(data, "down") || data === "j") {
        this.stepList.move(1, this.data.steps.length);
        this.logCache = null;
        this.requestRender();
      }
    } else if (this.tab === "shell") {
      if (matchesKey(data, "up") || data === "k") {
        this.shellList.move(-1, this.data.shellLogs.length);
        this.requestRender();
      } else if (matchesKey(data, "down") || data === "j") {
        this.shellList.move(1, this.data.shellLogs.length);
        this.requestRender();
      }
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

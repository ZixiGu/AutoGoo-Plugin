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
import { fit, headerLine, keyHelp, ListState, rule, tabsLine } from "./tui-kit.js";
import { progressOf, renderObserveBody } from "./observe-tabs.js";
import {
  TAB_ORDER,
  type ObserveSnapshot,
  type ObserveStep,
  type ObserveTab,
} from "./observe-types.js";

// ── re-export：数据契约在 observe-types.ts，渲染纯函数在 observe-tabs.ts ──────
// 两个拆分目的相同：pi-tui 只在运行时注入，任何 import 到本文件的运行时符号
// 都会把面板变成「测试环境加载不了」→ render 永不执行 → 界面 bug 漏到线上。
// 所以类型和纯渲染都搬走，这里只留 TUI 交互（键盘/定时器/IO）。
export type {
  ObserveAction,
  ObserveCounts,
  ObserveShellLog,
  ObserveSnapshot,
  ObserveStep,
  ObserveTab,
} from "./observe-types.js";
export { TAB_ORDER } from "./observe-types.js";
export {
  computeCounts,
  computeReady,
  progressOf,
  renderEnvTab,
  renderObserveBody,
  renderOverviewTab,
  renderShellTab,
  renderStepsTab,
} from "./observe-tabs.js";
export { renderRecallTab } from "./recall-tab.js";

/** 面板 body 的行预算（超出丢弃，不足补空行，保证高度不跳）。 */
const BODY_BUDGET = 16;

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
    const { total, done: doneCount } = progressOf(d.steps);

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

    const body = this.renderBody(w);
    for (const line of body.slice(0, BODY_BUDGET)) out.push(line);
    for (let i = body.length; i < BODY_BUDGET; i++) out.push(fit("", w));

    out.push(rule(w, this.theme));
    const secondsLeft = Math.max(0, 2 - Math.round((Date.now() - this.lastRefresh) / 1000));
    out.push(
      keyHelp(
        [
          { keys: `←→/1-${TAB_ORDER.length}`, label: "切 tab" },
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

  /**
   * body 渲染只做分发 —— 每行怎么算都在 `observe-tabs.ts` 的纯函数里。
   * 保留的唯一副作用是 steps tab 的 log 按需读取（别的 tab 不读盘）。
   *
   * 历史教训：这段逻辑原来就住在这里，而这里 import 了 pi-tui 的 `matchesKey`，
   * 测试环境加载不了 → render 从未被执行 → `ReferenceError: total is not defined`
   * 直接打到线上。抽出来之后同样的错误会在单测里立刻红。
   */
  private renderBody(w: number): string[] {
    const logLines = this.tab === "steps" ? this.stepLogLines() : [];
    return renderObserveBody(this.data, {
      tab: this.tab,
      width: w,
      theme: this.theme,
      stepIndex: this.stepList.selected,
      shellIndex: this.shellList.selected,
      logLines,
    });
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

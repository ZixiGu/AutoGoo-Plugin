/**
 * 观察面板 4 个 tab 的渲染 —— **纯函数，可单测**。
 *
 * 为什么抽出来：`observe-panel.ts` 还要 import pi-tui 的 `matchesKey`
 * （运行时注入），整个文件在 node:test 里根本加载不了。于是 0.26.0 之前
 * 面板的 render 从来没被测试执行过 —— `ReferenceError: total is not defined`
 * 就是这样漏到线上的（一个界面 bug 让 pi 直接 uncaughtException 退出）。
 *
 * 现在：键盘/定时器/IO 留在 `ObservePanel` 类里，**一切会算出字符串的逻辑**
 * 都进了本文件。这样"40/60/80/120 列都不超宽"能被断言，而不是靠肉眼。
 *
 * 约束（写新 tab 时必须遵守）：
 * - 每一条返回行都必须经过 `fit(..., w)`，`fit` 保证可见宽度（CJK=2）≤ w；
 * - 不读盘、不看时间以外的环境（`fmtAge` 的 now 由调用方/默认值决定）；
 * - 不抛异常：拿不到数据时返回一行提示，而不是让面板崩掉。
 */

import { bar, clip, color, fit, fmtAge, ListState, statusMark, statusToken } from "./tui-kit.js";
import { renderRecallTab } from "./recall-tab.js";
import type { Theme } from "@earendil-works/pi-tui";
import type { ObserveCounts, ObserveSnapshot, ObserveStep } from "./observe-types.js";

/** steps tab 一屏最多显示多少步（与 `ObservePanel` 的 ListState 窗口一致）。 */
export const STEPS_WINDOW = 10;
/** shell tab 一屏最多显示多少个日志文件。 */
export const SHELL_WINDOW = 8;

/** 状态计数：`{completed: 2, running: 1, ...}`。 */
export function computeCounts(steps: ObserveStep[]): ObserveCounts {
  const acc: ObserveCounts = {};
  for (const step of steps) {
    acc[step.status] = (acc[step.status] || 0) + 1;
  }
  return acc;
}

/** 完成进度：总步数、已完成数、百分比（0 步时为 0，不产生 NaN）。 */
export function progressOf(steps: ObserveStep[]): { total: number; done: number; pct: number } {
  const total = steps.length;
  const done = steps.filter((s) => s.status === "completed").length;
  return { total, done, pct: total > 0 ? (done / total) * 100 : 0 };
}

/**
 * 按 `depends_on` 计算真正"就绪"（依赖全部完成）与"等待中"的步数。
 *
 * 注意：这里必须只看 `pending` 的步骤 —— 把 running/completed 也算进来
 * 会让 overview 的 "N 步可派发" 与实际调度（只派发 pending）对不上。
 */
export function computeReady(steps: ObserveStep[]): { ready: number; waiting: number } {
  const completed = new Set(
    steps.filter((s) => s.status === "completed").map((s) => String(s.id)),
  );
  let ready = 0;
  let waiting = 0;
  for (const step of steps) {
    if (step.status !== "pending") continue;
    const deps = step.depends_on ?? [];
    const satisfied = deps.every((d) => completed.has(String(d)));
    if (satisfied) ready += 1;
    else waiting += 1;
  }
  return { ready, waiting };
}

/** steps tab：进度条 + 步骤窗口 + 选中详情 + log 尾部。 */
export function renderStepsTab(
  d: ObserveSnapshot,
  w: number,
  theme: Theme | undefined,
  selected: number,
  logLines: string[] = [],
  windowSize: number = STEPS_WINDOW,
): string[] {
  const L: string[] = [];
  if (d.steps.length === 0) {
    return [fit(color(theme, "dim", "  （当前 thread 没有 plan 步骤）"), w)];
  }
  const { pct } = progressOf(d.steps);
  L.push(fit(` ${bar(pct, 100, 20, theme)} ${pct.toFixed(0)}%`, w));

  const list = new ListState(windowSize, selected);
  list.clamp(d.steps.length);
  const [start, end] = list.range(d.steps.length);
  d.steps.slice(start, end).forEach((step, i) => {
    const active = start + i === list.selected;
    const narrow = w < 60;
    const nameWidth = narrow ? Math.max(8, w - 14) : Math.max(12, w - 46);
    const name = (step.name || "").slice(0, nameWidth).padEnd(nameWidth);
    const hb = step.status === "running" ? ` hb ${fmtAge(step.heartbeat_at)}` : "";
    const text = narrow
      ? ` ${active ? "›" : " "} ${color(theme, statusToken(step.status), statusMark(step.status))} ${name}`
      : ` ${active ? "›" : " "} ${color(theme, statusToken(step.status), statusMark(step.status))} ` +
        `${String(step.id).slice(0, 4).padEnd(4)} ${name} ${step.status.padEnd(10)} ${String(step.progress ?? 0).padStart(3)}%${hb}`;
    L.push(fit(active ? color(theme, "accent", text) : text, w));
  });

  const sel = d.steps[list.selected];
  if (sel) {
    L.push(fit(color(theme, "dim", "  ── 选中详情 ──"), w));
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
    if (sel.error) L.push(fit(color(theme, "error", `  ✗ ${String(sel.error).slice(0, w - 6)}`), w));
    if (logLines.length > 0) {
      L.push(fit(color(theme, "dim", `  ── log 尾部（${sel.log_path ?? "无"}） ──`), w));
      for (const line of clip(logLines, 4)) L.push(fit(`   ${line}`, w));
    }
  }
  return L;
}

/** overview tab：plan 状态 / 进度 / 各状态计数 / ready-waiting / Next 提示。 */
export function renderOverviewTab(
  d: ObserveSnapshot,
  w: number,
  theme: Theme | undefined,
): string[] {
  const L: string[] = [];
  const counts = computeCounts(d.steps);
  const { total, done, pct } = progressOf(d.steps);
  const kv = (k: string, v: string) => L.push(fit(`  ${color(theme, "dim", k.padEnd(16))}${v}`, w));

  kv("Plan status", d.planStatus);
  kv("Progress", `${pct.toFixed(0)}%  (${bar(pct, 100, 16, theme)})`);
  L.push(fit("", w));
  L.push(fit(`  ${color(theme, "accent", "步骤状态")}`, w));
  const order = ["completed", "running", "pending", "blocked", "failed", "interrupted"];
  const max = Math.max(1, ...order.map((k) => counts[k] ?? 0));
  for (const key of order) {
    const value = counts[key] ?? 0;
    L.push(
      fit(
        `  ${color(theme, statusToken(key), statusMark(key))} ${key.padEnd(12)} ${String(value).padStart(3)}  ${bar(value, max, 20, theme)}`,
        w,
      ),
    );
  }
  const computed = computeReady(d.steps);
  kv("ready / waiting", `${computed.ready} / ${computed.waiting}`);
  kv(
    "Next",
    total === 0
      ? "当前 thread 没有 plan 步骤"
      : done === total
        ? "全部完成"
        : computed.ready > 0
          ? `${computed.ready} 步可派发`
          : "无就绪步骤（依赖未满足）",
  );
  return L;
}

/** env tab：root / thread / plan / logs / shell logs / claude 版本 + 常用命令。 */
export function renderEnvTab(
  d: ObserveSnapshot,
  w: number,
  theme: Theme | undefined,
): string[] {
  const L: string[] = [];
  const kv = (k: string, v: string) => L.push(fit(`  ${color(theme, "dim", k.padEnd(16))}${v}`, w));

  kv("root", d.root);
  kv("thread", d.threadId ?? "-");
  kv("plan", d.planPath || "-");
  kv("logs", d.logsDir || "-");
  kv("shell logs", d.shellLogDir || "-");
  kv("claude", d.claudeVersion || "-");
  L.push(fit("", w));
  L.push(fit(`  ${color(theme, "accent", "常用命令")}`, w));
  const cmds = d.commands || {};
  for (const [key, value] of Object.entries(cmds)) {
    if (key === "shell_template") continue;
    L.push(fit(`  ${color(theme, "dim", key.padEnd(12))} ${value}`, w));
  }
  if (cmds.shell_template) {
    L.push(fit(color(theme, "dim", "  shell 跟踪模板（长任务用）:"), w));
    L.push(fit(`   ${cmds.shell_template.slice(0, Math.max(0, w - 4))}`, w));
  }
  return L;
}

/** shell tab：logs/shell/*.log 列表 + 选中尾部；目录为空时给 tee 模板提示。 */
export function renderShellTab(
  d: ObserveSnapshot,
  w: number,
  theme: Theme | undefined,
  selected: number,
  windowSize: number = SHELL_WINDOW,
): string[] {
  if (d.shellLogs.length === 0) {
    return [
      fit(color(theme, "dim", `  （${d.shellLogDir || "logs/shell"} 下暂无 *.log）`), w),
      fit("", w),
      fit(color(theme, "dim", "  长任务建议用 tee 跟踪："), w),
      fit(`   ${(d.commands?.shell_template || "").slice(0, Math.max(0, w - 4))}`, w),
    ];
  }
  const L: string[] = [];
  const list = new ListState(windowSize, selected);
  list.clamp(d.shellLogs.length);
  const [start, end] = list.range(d.shellLogs.length);
  d.shellLogs.slice(start, end).forEach((log, i) => {
    const active = start + i === list.selected;
    const name = log.path.split("/").pop() || log.path;
    const text = ` ${active ? "›" : " "} ${name}`;
    L.push(fit(active ? color(theme, "accent", text) : text, w));
  });
  const sel = d.shellLogs[list.selected];
  if (sel && sel.tail?.length) {
    L.push(fit(color(theme, "dim", "  ── 尾部 ──"), w));
    for (const line of clip(sel.tail, 6)) L.push(fit(`   ${line}`, w));
  }
  return L;
}

/**
 * 面板 body 的唯一入口：按 tab 分发。
 *
 * `ObservePanel.renderBody` 只做这一件事 —— 分类逻辑因此可以被测试覆盖，
 * 而不是藏在需要 pi-tui 的类里。
 */
export interface ObserveRenderOptions {
  tab: "steps" | "overview" | "recall" | "env" | "shell";
  width: number;
  theme?: Theme;
  /** steps tab 当前选中项下标 */
  stepIndex?: number;
  /** shell tab 当前选中项下标 */
  shellIndex?: number;
  /** steps tab 的 log 尾部（由调用方按需读取，纯函数不碰 IO） */
  logLines?: string[];
}

export function renderObserveBody(d: ObserveSnapshot, opts: ObserveRenderOptions): string[] {
  const w = Math.max(20, opts.width);
  switch (opts.tab) {
    case "steps":
      return renderStepsTab(d, w, opts.theme, opts.stepIndex ?? 0, opts.logLines ?? []);
    case "overview":
      return renderOverviewTab(d, w, opts.theme);
    case "env":
      return renderEnvTab(d, w, opts.theme);
    case "shell":
      return renderShellTab(d, w, opts.theme, opts.shellIndex ?? 0);
    case "recall":
      // recall 单独成文件（0.26.0 首次可测的范例），这里只做分发
      return renderRecallTab(d.recall, w, opts.theme);
    default:
      return [fit(color(opts.theme, "error", `  未知 tab: ${String(opts.tab)}`), w)];
  }
}

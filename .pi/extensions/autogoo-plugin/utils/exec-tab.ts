/**
 * 执行观测 tab 的渲染（纯函数，可单测）。
 *
 * 独立成文件的原因与 `recall-tab.ts` 相同：`observe-panel.ts` 依赖 pi-tui 的
 * `matchesKey`（运行时注入，测试环境不可用），任何**运行时**符号混进去都会让
 * 整个面板渲染无法被 node:test 执行 —— `ReferenceError: total is not defined`
 * 当初就是这样漏到线上的。
 *
 * 这个 tab 存在的意义：失败/卡住/超时以前只在 TUI 和 step log 里出现，
 * 无人值守时没人知道 DAG 停了。耗时分布、超时排行、失败聚类、重试次数
 * 必须先出现在一个**随时能看到**的地方，而不是要人去 grep 日志。
 */

import { bar, color, fit } from "./tui-kit.js";
import type { Theme } from "@earendil-works/pi-tui";
import type { ExecStats } from "./exec-observe.js";

/** 毫秒 → 人读的短时长（1.2s / 320ms / 2.4min）。 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  if (value < 3_600_000) return `${(value / 60_000).toFixed(1)}min`;
  return `${(value / 3_600_000).toFixed(1)}h`;
}

/**
 * 渲染执行 tab。
 *
 * 顺序按「先答结论、再给证据」：
 *   指标是否在写 → 耗时分布 → 最容易超时的 step → 失败聚类 → 重试
 */
export function renderExecTab(
  s: ExecStats | undefined,
  w: number,
  theme: Theme | undefined,
): string[] {
  const L: string[] = [];
  const kv = (k: string, v: string) => L.push(fit(`  ${color(theme, "dim", k.padEnd(16))}${v}`, w));

  if (!s || (!s.ok && s.total === 0)) {
    return [
      fit(color(theme, "dim", "  （还没有执行事件记录）"), w),
      fit(color(theme, "dim", "  预期路径: .goo/logs/exec.jsonl"), w),
      fit(color(theme, "dim", "  指标链路没生效时执行不受影响，但耗时/重试统计不可信。"), w),
    ];
  }

  const okTag = s.ok ? color(theme, "ok", "✓") : color(theme, "error", "✗");
  kv("事件流", `${okTag} ${s.total} 条${s.corruptLines > 0 ? color(theme, "warn", ` · 损坏 ${s.corruptLines}`) : ""}`);
  const dist = Object.entries(s.byEvent)
    .filter(([k]) => k !== "alert")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/^step_/, "")}=${v}`)
    .join(" ");
  if (dist) L.push(fit(`  ${color(theme, "dim", "分布".padEnd(14))}${dist}`, w));

  // ── 耗时分布 ──
  L.push(fit("", w));
  L.push(fit(`  ${color(theme, "accent", "耗时分布")}`, w));
  if (s.durations.samples === 0) {
    L.push(fit(color(theme, "dim", "  还没有终止事件（completed/failed/timeout）样本"), w));
  } else {
    const p95Ratio = s.durations.maxMs > 0 ? (s.durations.p95Ms / s.durations.maxMs) * 100 : 0;
    kv("样本数", String(s.durations.samples));
    kv("avg / p50", `${fmtDuration(s.durations.avgMs)} / ${fmtDuration(s.durations.p50Ms)}`);
    kv("p95", `${fmtDuration(s.durations.p95Ms)}  ${bar(p95Ratio, 100, 10, theme)}`);
    kv("max", fmtDuration(s.durations.maxMs));
    for (const st of s.slowest.slice(0, 3)) {
      const name = `${st.stepId} ${st.name}`.slice(0, 26);
      L.push(
        fit(
          `   ${color(theme, "dim", "‣")} ${name.padEnd(26)} avg ${fmtDuration(st.avgMs).padStart(7)} max ${fmtDuration(st.maxMs).padStart(7)}`,
          w,
        ),
      );
    }
  }

  // ── 最容易超时 ──
  L.push(fit("", w));
  L.push(fit(`  ${color(theme, "accent", "超时 / 中断")}`, w));
  const totalTimeouts = s.steps.reduce((n, st) => n + st.timeouts, 0);
  const totalInterrupts = s.steps.reduce((n, st) => n + st.interrupts, 0);
  if (totalTimeouts + totalInterrupts === 0) {
    L.push(fit(color(theme, "dim", "  没有超时/中断事件"), w));
  } else {
    kv("超时 / 中断", `${totalTimeouts} / ${totalInterrupts}`);
    for (const st of s.timeoutProne.slice(0, 3)) {
      const name = `${st.stepId} ${st.name}`.slice(0, 24);
      L.push(
        fit(
          `   ${color(theme, "warn", "⏱")} ${name.padEnd(24)} 超时 ${String(st.timeouts).padStart(2)} · 中断 ${String(st.interrupts).padStart(2)}`,
          w,
        ),
      );
    }
  }

  // ── 失败聚类 ──
  L.push(fit("", w));
  L.push(fit(`  ${color(theme, "accent", "失败原因聚类")}`, w));
  if (s.failures.length === 0) {
    L.push(fit(color(theme, "dim", "  没有失败事件"), w));
  } else {
    for (const f of s.failures.slice(0, 4)) {
      const steps = f.steps.length > 0 ? ` · step ${f.steps.join(",")}` : "";
      L.push(
        fit(
          `   ${color(theme, "error", String(f.count).padStart(3) + "×")} ${f.errorClass.padEnd(16)}${steps}`,
          w,
        ),
      );
    }
    const top = s.failures[0];
    if (top?.sample) {
      L.push(fit(color(theme, "dim", `   ${top.sample.slice(0, 74)}`), w));
    }
  }

  // ── 重试 ──
  L.push(fit("", w));
  L.push(fit(`  ${color(theme, "accent", "重试")}`, w));
  kv("重试事件", `${s.retries.events} 次 · 涉及 ${s.retries.steps} 个 step`);
  kv("平均 / 最多", `每步 ${s.retries.avgPerStep} 次 / 最多 ${s.retries.max} 次`);
  if (s.retries.events === 0) {
    L.push(fit(color(theme, "dim", "  没有自动重试记录"), w));
  }
  if (s.alertsDelivered > 0) {
    kv("已投递告警", `${s.alertsDelivered} 次（详见 /goo-health）`);
  }
  return L;
}

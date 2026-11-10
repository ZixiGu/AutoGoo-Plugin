/**
 * 召回观测 tab 的渲染（纯函数，可单测）。
 *
 * 独立成文件的原因：observe-panel.ts 依赖 pi-tui 的 `matchesKey`（运行时注入，
 * 测试环境不可用），导致整个面板无法被 node:test 执行 —— 这正是
 * `ReferenceError: total is not defined` 当初能漏到线上的根因。
 * 把渲染逻辑抽出来后，超宽/空数据/失败告警等边界都能直接测。
 */

import { bar, color, fit } from "./tui-kit.js";
import type { Theme } from "@earendil-works/pi-tui";
import type { RecallStats } from "./recall-observe.js";

/**
 * 渲染召回观测 tab（纯函数，便于单测超宽/空数据等边界）。
 *
 * 为什么单独抽出来：召回坏了是**静默降级** —— 任务照样跑完，只是用不上
 * wiki 经验。所以这个 tab 存在的意义是让「召回失败」立刻可见。
 */
export function renderRecallTab(
  r: ObserveSnapshot["recall"],
  w: number,
  theme: Theme,
): string[] {
  const L: string[] = [];
  const kv = (k: string, v: string) => L.push(fit(`  ${color(theme, "dim", k.padEnd(16))}${v}`, w));

  if (!r || r.total === 0) {
    return [
      fit(color(theme, "dim", "  （还没有召回记录）"), w),
      fit(color(theme, "dim", "  提示：召回是否生效，不跑一次是看不出来的。"), w),
    ];
  }
  kv("召回次数", String(r.total));
  kv("成功 / 失败", `${r.ok} / ${r.failed}${r.failed > 0 ? color(theme, "error", "  ⚠") : ""}`);
  kv("命中率", `${(r.hitRate * 100).toFixed(0)}%  ${bar(r.hitRate * 100, 100, 12, theme)}`);
  kv("平均命中", `${r.avgHits} 条`);
  kv("耗时 avg/p95", `${r.avgMs}ms / ${r.p95Ms}ms`);
  kv("预算截断", r.budgetTruncated > 0
    ? color(theme, "warn", `${r.budgetTruncated} 次（内容被字符预算裁剪）`)
    : "0 次");
  L.push(fit("", w));
  L.push(fit(`  ${color(theme, "accent", "最近召回")}`, w));
  for (const e of r.lastN.slice(0, 8)) {
    const mark = e.ok ? color(theme, "ok", "✓") : color(theme, "error", "✗");
    const src = (e.source || "?").padEnd(10);
    const hits = `${String(e.hits).padStart(3)} 条`.padEnd(6);
    const ms = `${String(e.ms).padStart(5)}ms`;
    const note = e.ok ? "" : color(theme, "error", `  ${String(e.error || "").slice(0, 60)}`);
    L.push(fit(`   ${mark} ${src} ${hits} ${ms}${note}`, w));
  }
  if (r.failed > 0) {
    L.push(fit("", w));
    L.push(fit(color(theme, "warn", `  ⚠ 有 ${r.failed} 次召回失败 —— 召回坏了会静默降级，`), w));
    L.push(fit(color(theme, "warn", "    任务照样跑完，但用不上 wiki 经验。"), w));
  }
  return L;
}

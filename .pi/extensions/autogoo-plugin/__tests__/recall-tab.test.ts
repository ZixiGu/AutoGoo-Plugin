/**
 * 召回 tab 渲染测试。
 *
 * 面板本身依赖 pi-tui（测试环境不可用），所以渲染逻辑抽成纯函数
 * `renderRecallTab`，这里直接测它的边界：空数据 / 有失败 / 超宽。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderRecallTab } from "../utils/recall-tab.js";

// 极简 theme stub：theme.fg(token, text) —— 必须**原样返回 text**，
// 否则内容会被吞掉，测试就变成「断言空字符串里有没有某词」永远失败。
const theme: any = new Proxy({}, { get: () => (_token: string, text: string) => text });

// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderRecallTab", () => {
  it("无记录时给提示而不是空白", () => {
    const lines = renderRecallTab(undefined, 80, theme);
    assert.ok(lines.length >= 1);
    assert.ok(lines.join("").includes("召回记录"));
  });

  it("有失败时显式告警（召回是静默降级，必须可见）", () => {
    const stats: any = {
      total: 3, ok: 2, failed: 1, hitRate: 0.5, avgMs: 10, p95Ms: 20,
      avgHits: 2, budgetTruncated: 0,
      lastN: [
        { ts: "t", source: "plan", query_hash: "a", query_len: 3, hits: 0,
          dropped: 0, score_max: 0, chars: 0, ms: 30, ok: false, error: "exit=2 --compact" },
      ],
    };
    const text = renderRecallTab(stats, 120, theme).join("\n");
    assert.ok(text.includes("静默降级"), "应提示静默降级风险");
    assert.ok(text.includes("1"), "应显示失败次数");
  });

  it("多种宽度下都不超宽", () => {
    const stats: any = {
      total: 12, ok: 11, failed: 1, hitRate: 0.83, avgMs: 260, p95Ms: 900,
      avgHits: 12, budgetTruncated: 2,
      lastN: Array.from({ length: 8 }, (_, i) => ({
        ts: "t", source: "brainstorm", query_hash: "abc", query_len: 20,
        hits: i, dropped: 0, score_max: 50, chars: 100, ms: 100 + i,
        ok: i !== 0, error: i === 0 ? "x".repeat(200) : undefined,
      })),
    };
    for (const w of [40, 60, 80, 120]) {
      const lines = renderRecallTab(stats, w, theme);
      for (const line of lines) {
        assert.ok(
          visible(line).length <= w,
          `width=${w} 出现超宽行（${visible(line).length} 字符）: ${visible(line).slice(0, 40)}`,
        );
      }
    }
  });

  it("命中率与耗时如实反映数据", () => {
    const stats: any = {
      total: 4, ok: 4, failed: 0, hitRate: 0.75, avgMs: 123, p95Ms: 456,
      avgHits: 3.5, budgetTruncated: 0, lastN: [],
    };
    const text = renderRecallTab(stats, 100, theme).join("\n");
    assert.ok(text.includes("75%"), "命中率应显示 75%");
    assert.ok(text.includes("123ms") && text.includes("456ms"), "应显示 avg/p95");
  });
});

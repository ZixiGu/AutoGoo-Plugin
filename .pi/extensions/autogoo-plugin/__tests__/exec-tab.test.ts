/**
 * 「执行」tab 渲染测试。
 *
 * 面板本身依赖 pi-tui（测试环境不可用），所以渲染逻辑抽成纯函数
 * `renderExecTab`，这里测它的边界：无数据 / 有数据 / 超宽 / 指标链路坏掉。
 *
 * 为什么值得单独测：这个 tab 的存在理由是「失败/卡住/超时不能只活在 TUI 和
 * step log 里」。渲染一旦崩掉或超宽，可观测性就退回原样 —— 而这类界面错误
 * 以前从来没被测试执行过（参见 recall-tab.ts 头部注释）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderExecTab, fmtDuration } from "../utils/exec-tab.js";
import type { ExecStats } from "../utils/exec-observe.js";

// 极简 theme stub：theme.fg(token, text) 必须原样返回 text，否则内容被吞掉，
// 断言就变成「空字符串里找某词」永远失败。
const theme: any = new Proxy({}, { get: () => (_token: string, text: string) => text });

// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** 与 tui-kit 的 visibleWidth 等价的最小实现（CJK 算 2 列）。 */
function displayWidth(text: string): number {
  const stripped = visible(text);
  let width = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    width += code > 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) ? 2 : 1;
  }
  return width;
}

function stats(over: Partial<ExecStats> = {}): ExecStats {
  return {
    ok: true,
    path: "/tmp/.goo/logs/exec.jsonl",
    total: 12,
    corruptLines: 0,
    byEvent: { step_start: 4, step_complete: 2, step_timeout: 1, step_fail: 1, step_retry: 3, alert: 1 },
    fromTs: "2026-11-16T10:00:00Z",
    toTs: "2026-11-16T11:30:00Z",
    durations: { samples: 4, avgMs: 120_000, p50Ms: 60_000, p95Ms: 900_000, maxMs: 1_800_000 },
    steps: [
      {
        stepId: "2", name: "执行告警与 DAG 指标", subagent: "implementer",
        runs: 2, completions: 0, failures: 1, timeouts: 1, interrupts: 0, retries: 1,
        samples: 1, avgMs: 1_800_000, maxMs: 1_800_000, errorClass: "timeout", error: "超时",
      },
      {
        stepId: "3", name: "外部对标", subagent: "researcher",
        runs: 1, completions: 1, failures: 0, timeouts: 0, interrupts: 0, retries: 0,
        samples: 1, avgMs: 30_000, maxMs: 30_000,
      },
    ],
    slowest: [],
    timeoutProne: [],
    failures: [
      { errorClass: "timeout", count: 2, sample: "subagent wrapper 中断（exit 143，超时）", steps: ["2"] },
      { errorClass: "auth", count: 1, sample: "401 unauthorized", steps: ["5"] },
    ],
    retries: { events: 3, steps: 2, avgPerStep: 1.5, max: 2 },
    alertsDelivered: 2,
    lastN: [],
    ...over,
  };
}

describe("fmtDuration", () => {
  it("按量级选单位（ms / s / min / h）", () => {
    assert.equal(fmtDuration(320), "320ms");
    assert.equal(fmtDuration(1200), "1.2s");
    assert.equal(fmtDuration(90_000), "1.5min");
    assert.equal(fmtDuration(3_600_000 * 2), "2.0h");
    assert.equal(fmtDuration(null), "-");
  });
});

describe("renderExecTab", () => {
  it("没有事件时给提示 + 预期路径，而不是空白", () => {
    const lines = renderExecTab(undefined, 80, theme);
    assert.ok(lines.length >= 1);
    const text = lines.join("\n");
    assert.match(text, /还没有执行事件|exec\.jsonl/);
  });

  it("指标链路坏掉（ok=false）时明确说执行不受影响但统计不可信", () => {
    const broken: ExecStats = { ...(stats() as any), ok: false, total: 0 };
    const text = renderExecTab(broken, 100, theme).join("\n");
    assert.match(text, /统计不可信|没有执行事件/);
  });

  it("有数据时展示耗时分布 / 超时排行 / 失败聚类 / 重试", () => {
    const s = stats();
    // 补上慢排行（父函数在 readExecStats 里算，这里手工给）
    s.slowest = [s.steps[0]];
    s.timeoutProne = [s.steps[0]];
    const text = renderExecTab(s, 120, theme).join("\n");
    assert.match(text, /耗时分布/);
    assert.match(text, /最容易超时|超时/);
    assert.match(text, /失败原因聚类/);
    assert.match(text, /timeout/);
    assert.match(text, /重试/);
    assert.match(text, /1\.5/); // 平均每步
    assert.match(text, /30\.0min|1800/); // 最长耗时可见
  });

  it("损坏行被显式标出（读一半的 jsonl 不能被当成健康）", () => {
    const text = renderExecTab(stats({ corruptLines: 3 }), 100, theme).join("\n");
    assert.match(text, /损坏 3/);
  });

  it("40/60/80/120 列都不超宽（面板宽度不变式）", () => {
    const s = stats();
    s.slowest = s.steps;
    s.timeoutProne = s.steps;
    for (const w of [40, 60, 80, 120]) {
      for (const line of renderExecTab(s, w, theme)) {
        assert.ok(displayWidth(line) <= w, `宽度 ${w} 超宽: ${visible(line)}`);
      }
    }
  });

  it("主题不可用（undefined theme）也不抛", () => {
    const lines = renderExecTab(stats(), 80, undefined);
    assert.ok(lines.length > 0);
  });
});

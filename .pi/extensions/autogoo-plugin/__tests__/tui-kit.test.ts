/**
 * TUI 渲染原语测试（`utils/tui-kit.ts`）。
 *
 * 这一层是所有面板的公共底座：宽度、截断、按键提示、列表窗口、渲染兜底。
 * 0.26.0 为了可测性把 tui-kit 从 pi-tui 解耦（自实现宽度计算），代价是
 * **宽度语义要自己保证** —— 所以这里用固定期望值把语义钉死：
 *   CJK/全角/emoji = 2 列，ANSI = 0 列，组合字符 = 0 列。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bar,
  clip,
  color,
  fit,
  fmtAge,
  fmtCompact,
  fmtInt,
  fmtPct,
  guardRender,
  headerLine,
  keyHelp,
  ListState,
  rule,
  selected,
  statusMark,
  statusToken,
  stripAnsi,
  tabsLine,
  truncateToWidth,
  visibleWidth,
} from "../utils/tui-kit.js";

const theme: any = new Proxy({}, { get: () => (_token: string, text: string) => text });

// guardRender 失败路径会写 ~/.auto-goo/logs/plugin.log；测试把 HOME 指到临时目录，
// 保证不污染真实日志（log.ts 每次调用都现读 HOME）。
let tmpHome = "";
let prevHome: string | undefined;
before(() => {
  prevHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "tui-kit-home-"));
  process.env.HOME = tmpHome;
});
after(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe("stripAnsi / visibleWidth", () => {
  it("去掉 CSI 与 OSC 序列", () => {
    assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
    assert.equal(stripAnsi("\x1b]0;title\x07text"), "text");
  });

  it("CJK / 全角 / emoji 算 2 列，ASCII 算 1 列", () => {
    assert.equal(visibleWidth("abc"), 3);
    assert.equal(visibleWidth("中文"), 4);
    assert.equal(visibleWidth("Ａ"), 2); // 全角
    assert.equal(visibleWidth("🚀"), 2); // emoji
    assert.equal(visibleWidth("a中b"), 4);
  });

  it("ANSI 与组合字符宽度为 0", () => {
    assert.equal(visibleWidth("\x1b[1mab\x1b[0m"), 2);
    assert.equal(visibleWidth("e\u0301"), 1, "组合音标不额外占列");
  });
});

describe("truncateToWidth", () => {
  it("按显示宽度截断（不切半个 CJK）", () => {
    assert.equal(truncateToWidth("ab中文", 4), "ab中");
    assert.equal(truncateToWidth("ab中文", 5), "ab中");
    assert.equal(truncateToWidth("ab中文", 6), "ab中文");
  });

  it("width<=0 返回空串", () => {
    assert.equal(truncateToWidth("abc", 0), "");
    assert.equal(truncateToWidth("abc", -1), "");
  });

  it("截断后补 ANSI 重置，避免串色", () => {
    const out = truncateToWidth("\x1b[31m红色文字很长\x1b[0m", 4);
    assert.ok(out.startsWith("\x1b[31m"));
    assert.ok(out.endsWith("\x1b[0m"), "截断后必须补 reset");
    assert.ok(visibleWidth(out) <= 4);
  });
});

describe("fit", () => {
  it("补空格到精确宽度（面板每行等宽）", () => {
    assert.equal(fit("ab", 5), "ab   ");
    assert.equal(fit("abcdef", 3), "abc");
    assert.equal(visibleWidth(fit("中文", 10)), 10);
  });

  it("pad=false 时不补空格", () => {
    assert.equal(fit("ab", 5, false), "ab");
  });

  it("宽度 0 也至少给 1 列，避免产生空行宽度 0", () => {
    assert.equal(visibleWidth(fit("ab", 0)), 1);
  });
});

describe("rule / headerLine", () => {
  it("rule 生成指定宽度的横线", () => {
    assert.equal(visibleWidth(rule(10)), 10);
    assert.equal(visibleWidth(rule(0)), 1);
  });

  it("headerLine 左右都放得下时精确占满宽度", () => {
    const line = headerLine("◆ AutoGoo Observe", "tg-1 · 2/5 · running", 60, theme);
    assert.equal(visibleWidth(line), 60);
  });

  it("headerLine 在窄屏优先保留右侧摘要，不超宽", () => {
    const line = headerLine("◆ AutoGoo Observe", "tg-20261112-very-long-thread-id · 2/5 · running", 40, theme);
    assert.ok(visibleWidth(line) <= 40, `超宽: ${visibleWidth(line)}`);
  });
});

describe("keyHelp", () => {
  const items = [
    { keys: "←→/1-5", label: "切 tab" },
    { keys: "↑↓", label: "移动" },
    { keys: "r", label: "刷新" },
    { keys: "q", label: "退出" },
    { keys: "2s", label: "自动刷新" },
  ];

  it("宽屏显示全部提示", () => {
    const line = keyHelp(items, 120, theme);
    assert.ok(line.includes("切 tab") && line.includes("自动刷新"));
    assert.equal(visibleWidth(line), 120);
  });

  it("窄屏从尾部丢项并补 …（绝不截成半个按键说明）", () => {
    const line = keyHelp(items, 30, theme);
    assert.ok(line.includes("…"), "丢项后应有省略号");
    assert.ok(line.includes("切 tab"), "前面的项优先保留");
    assert.ok(!line.includes("自动刷新"), "尾部项应被丢弃");
    assert.ok(visibleWidth(line) <= 30);
  });

  it("宽度不足以放任何一项时退回空格，不抛异常", () => {
    const line = keyHelp(items, 1, theme);
    assert.equal(visibleWidth(line), 1);
  });
});

describe("tabsLine", () => {
  const tabs = ["steps", "overview", "recall", "env", "shell"].map((t, i) => ({
    index: i,
    short: t.slice(0, 2),
    full: t,
  }));

  it("宽屏用完整名", () => {
    const line = tabsLine(tabs, 0, 120, theme);
    assert.ok(line.includes("overview"), "宽屏应显示完整 tab 名");
    assert.ok(visibleWidth(line) <= 120);
  });

  it("窄屏退化为 1:st 2:ov 形式，不出现半截名字", () => {
    const line = tabsLine(tabs, 1, 40, theme);
    assert.ok(line.includes("1:st") || line.includes("2:ov"), `窄屏应压缩: ${line}`);
    assert.ok(!line.includes("overvew"), "不应出现截断残句");
    assert.ok(visibleWidth(line) <= 40);
  });

  it("选中项下标越界时不崩", () => {
    assert.ok(tabsLine(tabs, 99, 80, theme).length > 0);
  });
});

describe("数字 / 状态格式化", () => {
  it("fmtInt 千分位，非法值回退 -", () => {
    assert.equal(fmtInt(1234567), "1,234,567");
    assert.equal(fmtInt(null), "0");
    assert.equal(fmtInt(Number.NaN), "-");
  });

  it("fmtCompact 用 K/M/B 缩写", () => {
    assert.equal(fmtCompact(999), "999");
    assert.equal(fmtCompact(1500), "1.5K");
    assert.equal(fmtCompact(2_500_000), "2.50M");
    assert.equal(fmtCompact(Number.POSITIVE_INFINITY), "-");
  });

  it("fmtPct 带百分号，NaN 回退 -", () => {
    assert.equal(fmtPct(12.34), "12.3%");
    assert.equal(fmtPct(12.34, 0), "12%");
    assert.equal(fmtPct(Number.NaN), "-");
  });

  it("fmtAge 输出 s/m/h/d 且不会为负", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    assert.equal(fmtAge("2026-11-16T11:59:30Z", now), "30s");
    assert.equal(fmtAge("2026-11-16T11:30:00Z", now), "30m");
    assert.equal(fmtAge("2026-11-16T09:00:00Z", now), "3h");
    assert.equal(fmtAge("2026-11-14T12:00:00Z", now), "2d");
    assert.equal(fmtAge("2026-11-16T12:00:30Z", now), "0s", "未来时间不应出现负数");
    assert.equal(fmtAge(null, now), "-");
    assert.equal(fmtAge("not-a-date", now), "-");
  });

  it("bar 填充比例正确且总宽固定", () => {
    assert.equal(visibleWidth(bar(50, 100, 10)), 10);
    assert.equal(visibleWidth(bar(0, 0, 10)), 10, "max=0 时不应除零");
    assert.ok(bar(100, 100, 10).includes("█".repeat(10)));
    assert.ok(bar(0, 100, 10).includes("░".repeat(10)));
  });

  it("statusMark / statusToken 覆盖全部状态", () => {
    assert.equal(statusMark("completed"), "✓");
    assert.equal(statusMark("running"), "►");
    assert.equal(statusMark("failed"), "✗");
    assert.equal(statusMark("blocked"), "⏸");
    assert.equal(statusMark("interrupted"), "⏸");
    assert.equal(statusMark("unknown"), "·");
    assert.equal(statusToken("completed"), "success");
    assert.equal(statusToken("running"), "accent");
    assert.equal(statusToken("failed"), "error");
    assert.equal(statusToken("blocked"), "warning");
    assert.equal(statusToken("interrupted"), "warning");
    assert.equal(statusToken("pending"), "dim");
  });

  it("color / selected 在 theme 缺失或抛错时回退原文", () => {
    assert.equal(color(undefined, "accent", "x"), "x");
    const boom: any = { fg: () => { throw new Error("bad token"); } };
    assert.equal(color(boom, "accent", "x"), "x", "非法 token 不应抛出");
    assert.equal(selected(undefined, "abc"), "abc");
  });
});

describe("ListState", () => {
  it("构造时把初始选中项夹进范围", () => {
    const s = new ListState(5, 99);
    s.clamp(3);
    assert.equal(s.selected, 2);
    const s2 = new ListState(5, -3);
    assert.equal(s2.selected, 0);
  });

  it("move 循环并同步滚动窗口", () => {
    const s = new ListState(3, 0);
    s.move(1, 10);
    assert.equal(s.selected, 1);
    for (let i = 0; i < 5; i++) s.move(1, 10);
    assert.equal(s.selected, 6);
    assert.deepEqual(s.range(10), [4, 7], "窗口应跟到 [4,7)：selected=6 是窗口末项");
    s.move(-1, 10);
    assert.equal(s.selected, 5);
    assert.deepEqual(s.range(10), [4, 7], "往回走一格仍在窗口内，不应抖动");
  });

  it("jumpToFirst / jumpToLast 夹紧窗口", () => {
    const s = new ListState(4, 0);
    s.jumpToLast(20);
    assert.equal(s.selected, 19);
    assert.deepEqual(s.range(20), [16, 20]);
    s.jumpToFirst(20);
    assert.equal(s.selected, 0);
    assert.deepEqual(s.range(20), [0, 4]);
  });

  it("总数为 0 或负数时不移动、不产生负 offset", () => {
    const s = new ListState(4, 2);
    s.move(1, 0);
    assert.equal(s.selected, 2);
    s.clamp(0);
    assert.ok(s.offset >= 0);
    assert.deepEqual(s.range(0), [0, 0]);
  });

  it("clamp 后 offset 不越界（窗口比总数大）", () => {
    const s = new ListState(10, 0);
    s.clamp(3);
    assert.deepEqual(s.range(3), [0, 3]);
  });
});

describe("clip", () => {
  it("保留尾部 budget 行", () => {
    assert.deepEqual(clip(["a", "b", "c", "d"], 2), ["c", "d"]);
    assert.deepEqual(clip(["a", "b"], 5), ["a", "b"]);
    assert.deepEqual(clip(["a"], 0), []);
  });
});

describe("guardRender", () => {
  it("正常渲染原样返回", () => {
    const inner = { render: (_w: number) => ["ok"] };
    const wrapped = guardRender(inner, theme, "X");
    assert.deepEqual(wrapped.render(40), ["ok"]);
  });

  it("render 抛异常时降级为提示行（绝不把 pi 打挂）", () => {
    const inner = {
      render: () => {
        throw new ReferenceError("total is not defined");
      },
    };
    const wrapped = guardRender(inner, theme, "ObservePanel");
    const lines = wrapped.render(80);
    assert.equal(lines.length, 3);
    const text = lines.join("\n");
    assert.ok(text.includes("渲染失败"), "应提示渲染失败");
    assert.ok(text.includes("total is not defined"), "应保留错误原因");
    assert.ok(text.includes("goo-status.py"), "应给 CLI 兜底路径");
    for (const line of lines) assert.ok(visibleWidth(line) <= 80);
  });

  it("极窄宽度也给出可读的非空降级行", () => {
    const inner = { render: () => { throw new Error("boom"); } };
    const lines = guardRender(inner, theme, "P").render(5);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.ok(visibleWidth(line) >= 1);
  });
});

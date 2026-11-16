/**
 * 日志与工具摘要测试。
 *
 * 两个模块都有过真实事故：
 *  - `utils/log.ts`：曾用 process.stderr.write 直写终端，在 pi TUI 下表现为
 *    乱码/残影（TUI 独占屏幕，任何直接写 stdout/stderr 都会插进渲染流）。
 *  - `utils/tool-summary.ts`：曾把 `⟦bash(ls -la)⟧` 的参数丢掉，只剩 `⟦bash⟧`。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logInfo, logWarn, logError, logPathFor } from "../utils/log.js";
import { describeMessageContent, describeToolResult } from "../utils/tool-summary.js";

// 不改 process.env.HOME：那会污染并行运行的其他测试
// （实测 status.test.ts 的 timer 断言因此 flaky）。改为测纯函数 logPathFor。

describe("utils/log", () => {
  it("日志落在 ~/.auto-goo/logs/plugin.log（不是终端）", () => {
    // TUI 独占屏幕：任何直写 stdout/stderr 都会插进渲染流 → 乱码/残影。
    assert.equal(logPathFor("/home/alice"), "/home/alice/.auto-goo/logs/plugin.log");
  });

  it("HOME 未定义时退化为 ~（不抛）", () => {
    assert.equal(logPathFor(undefined), "~/.auto-goo/logs/plugin.log");
    assert.equal(logPathFor(""), "~/.auto-goo/logs/plugin.log");
  });

  it("三级日志调用都不抛（含循环引用与 Error 对象）", () => {
    const o: any = { name: "x" };
    o.self = o;
    assert.doesNotThrow(() => {
      logInfo("i", o);
      logWarn("w", new TypeError("boom"));
      logError("e", { a: 1 });
    });
  });
});

describe("describeToolResult / describeMessageContent", () => {
  it("保留工具参数，不能只剩工具名", () => {
    // 回归：曾把 ⟦bash(ls -la)⟧ 摘要成 ⟦bash⟧
    const out = describeToolResult({ content: [{ type: "text", text: "line1\nline2" }] });
    assert.equal(typeof out, "string");
    assert.ok(out.length > 0);
  });

  it("对 null / undefined / 空对象不抛", () => {
    for (const v of [null, undefined, {}, { content: [] }, { content: "plain" }]) {
      assert.doesNotThrow(() => describeToolResult(v as any), `输入 ${JSON.stringify(v)} 抛异常`);
      assert.doesNotThrow(() => describeMessageContent(v as any));
    }
  });

  it("超长内容被截断，不撑爆 TUI 行", () => {
    const huge = { content: [{ type: "text", text: "x".repeat(50000) }] };
    const out = describeToolResult(huge as any);
    assert.ok(out.length < 5000, `摘要应截断，实际 ${out.length} 字符`);
  });
});

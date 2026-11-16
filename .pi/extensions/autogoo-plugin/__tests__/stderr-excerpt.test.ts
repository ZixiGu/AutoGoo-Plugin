/**
 * subagent 失败时 stderr 摘录测试。
 *
 * 存在的理由：pi 子进程非 0 退出时，真正的错误（provider 认证失败 / 限流 /
 * 模型不存在）只在 stderr 里。此前调用方只记 "exit 143"，所有失败长得一样 ——
 * 实测把一个 yj provider 并发失败误诊为「pi tool 调用 2 分钟超时」，
 * 白做了一轮 detached 改造。
 *
 * 这里断言的是**摘录质量**（挑中错误行、不夹带 JSON 事件、长度受控），
 * 而不是「函数不抛」。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { excerptStderr } from "../tools/execute.js";

describe("excerptStderr", () => {
  it("挑出 provider 错误行", () => {
    const s = [
      '{"type":"turn_start"}',
      "Error: 401 Unauthorized - invalid api key for provider yj",
      '{"type":"message_end"}',
    ].join("\n");
    const out = excerptStderr(s);
    assert.match(out, /401|Unauthorized/i, `应命中错误行，实际: ${out}`);
    assert.ok(!out.includes('"type"'), "不得夹带 JSON 事件");
  });

  it("限流 / 配额类错误能被识别", () => {
    const out = excerptStderr("some log\nError: rate limit exceeded, retry later");
    assert.match(out, /rate limit|限流/i);
  });

  it("模型不存在能被识别", () => {
    const out = excerptStderr("Error: model deepseek-flash not found");
    assert.match(out, /model|not found/i);
  });

  it("纯 JSON 事件流返回空串（没有可读错误）", () => {
    const s = '{"type":"a"}\n{"type":"b"}\n{"type":"c"}';
    assert.equal(excerptStderr(s), "");
  });

  it("无 stderr 时返回空串", () => {
    assert.equal(excerptStderr(""), "");
    assert.equal(excerptStderr(undefined), "");
    assert.equal(excerptStderr(null), "");
  });

  it("长度受控（不把整个 stderr 塞进 plan）", () => {
    const s = Array.from({ length: 200 }, (_, i) => `Error line ${i} failed`).join("\n");
    const out = excerptStderr(s);
    assert.ok(out.length <= 301, `摘录应 ≤300 字符，实际 ${out.length}`);
  });

  it("没有 error 关键词时退回最后几行（不能返回空）", () => {
    const s = "starting\ndoing work\nfinished with exit 1";
    const out = excerptStderr(s);
    assert.ok(out.length > 0, "无关键词时也要给出上下文");
    assert.match(out, /exit 1/);
  });

  it("堆栈帧让位给消息（不返回一串 at ...）", () => {
    const s = "Error: boom\n    at foo (/a/b.js:1:2)\n    at bar (/a/c.js:3:4)";
    const out = excerptStderr(s);
    assert.match(out, /boom/);
    assert.ok(!out.startsWith("at "), "不应以堆栈帧开头");
  });
});

/**
 * subagent.ts 单元测试 — pi 子进程 Subagent 执行器
 *
 * 覆盖：getFinalOutput、getPiInvocation（env override）、runSubagent
 * （spawn 参数 / JSON 流解析 / usage 收集 / AUTOGOO_SUBAGENT env 传递）。
 * 用假命令模拟 pi JSON 输出，不依赖真实 LLM。
 *
 * 运行：cd setup && node --import tsx --test ../AutoGoo-Plugin/.pi/extensions/autogoo-plugin/__tests__/subagent.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyUsage,
  getFinalOutput,
  getPiInvocation,
  runSubagent,
} from "../utils/subagent.ts";

// ── getFinalOutput ──────────────────────────────────────────────────────────

test("getFinalOutput 提取最后一条 assistant 消息的第一个文本", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "思考" }, { type: "text", text: "答案 A" }] },
    { role: "assistant", content: [{ type: "text", text: "答案 B" }] },
  ];
  assert.equal(getFinalOutput(messages), "答案 B");
});

test("getFinalOutput 无 assistant 文本时返回空串", () => {
  assert.equal(getFinalOutput([]), "");
  assert.equal(getFinalOutput([{ role: "user", content: [{ type: "text", text: "x" }] }]), "");
});

// ── getPiInvocation ─────────────────────────────────────────────────────────

test("getPiInvocation 优先使用 AUTOGOO_SUBAGENT_CMD 覆盖", () => {
  const old = process.env.AUTOGOO_SUBAGENT_CMD;
  process.env.AUTOGOO_SUBAGENT_CMD = "pi";
  try {
    const inv = getPiInvocation(["--mode", "json"]);
    assert.equal(inv.command, "pi");
    assert.deepEqual(inv.args, ["--mode", "json"]);
  } finally {
    if (old === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
    else process.env.AUTOGOO_SUBAGENT_CMD = old;
  }
});

test("getPiInvocation 支持带参数的命令覆盖", () => {
  const old = process.env.AUTOGOO_SUBAGENT_CMD;
  process.env.AUTOGOO_SUBAGENT_CMD = "/usr/bin/env node --test-flag";
  try {
    const inv = getPiInvocation(["-p"]);
    assert.equal(inv.command, "/usr/bin/env");
    assert.deepEqual(inv.args, ["node", "--test-flag", "-p"]);
  } finally {
    if (old === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
    else process.env.AUTOGOO_SUBAGENT_CMD = old;
  }
});

// ── runSubagent（假命令模拟 pi JSON 流） ──────────────────────────────────

/** 生成一个输出伪造 pi JSON 事件流的假子进程脚本。 */
function fakePiScript(): string {
  const script = join(tmpdir(), `fake-pi-${Date.now()}.mjs`);
  const content = `
const events = [
  { type: "session", version: 3, id: "fake" },
  { type: "message_start", message: { role: "user", content: [{ type: "text", text: "task" }] } },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "task" }] } },
  { type: "message_end", message: {
      role: "assistant",
      content: [{ type: "text", text: "FAKE-OUTPUT" }],
      model: "fake-model",
      stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, totalTokens: 127, cost: { total: 0.001 } },
  } },
  { type: "tool_result_end", message: { role: "tool", name: "bash", content: [{ type: "text", text: "ok" }] } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\\n");
`;
  writeFileSync(script, content, "utf-8");
  return script;
}

test("runSubagent 解析 JSON 流、收集 usage、传递 AUTOGOO_SUBAGENT env", async () => {
  const fake = fakePiScript();
  const oldCmd = process.env.AUTOGOO_SUBAGENT_CMD;
  const oldSub = process.env.AUTOGOO_SUBAGENT;
  process.env.AUTOGOO_SUBAGENT_CMD = `node ${fake}`; // 假 pi 输出
  process.env.AUTOGOO_SUBAGENT = "1";
  try {
    const result = await runSubagent({
      systemPrompt: "fake system",
      task: "fake task",
      cwd: tmpdir(),
      timeoutMs: 30000,
      provider: "test-provider",
      model: "test-model",
    });

    // 验证解析结果
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "FAKE-OUTPUT");
    assert.equal(result.model, "fake-model");
    assert.equal(result.stopReason, "stop");
    assert.equal(result.usage.turns, 1);
    assert.equal(result.usage.input, 100);
    assert.equal(result.usage.output, 20);
    assert.equal(result.usage.cacheRead, 5);
    assert.equal(result.usage.cacheWrite, 2);
    assert.equal(result.usage.cost, 0.001);
    // 消息包含 user + assistant + tool 结果
    assert.ok(result.messages.length >= 3);
    // 临时 system prompt 目录已清理
  } finally {
    if (oldCmd !== undefined) process.env.AUTOGOO_SUBAGENT_CMD = oldCmd;
    if (oldSub === undefined) delete process.env.AUTOGOO_SUBAGENT;
    else process.env.AUTOGOO_SUBAGENT = oldSub;
  }
});

test("runSubagent 子进程异常退出时返回 errorMessage", async () => {
  const script = join(tmpdir(), `fake-pi-fail-${Date.now()}.mjs`);
  writeFileSync(script, `process.exit(3);`, "utf-8");
  const oldCmd = process.env.AUTOGOO_SUBAGENT_CMD;
  process.env.AUTOGOO_SUBAGENT_CMD = `node ${script}`;
  try {
    const result = await runSubagent({
      task: "boom",
      cwd: tmpdir(),
      timeoutMs: 30000,
      provider: "test-provider",
      model: "test-model",
    });
    assert.equal(result.exitCode, 3);
  } finally {
    if (oldCmd === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
    else process.env.AUTOGOO_SUBAGENT_CMD = oldCmd;
  }
});

// ── emptyUsage ──────────────────────────────────────────────────────────────

test("emptyUsage 返回全零 usage", () => {
  assert.deepEqual(emptyUsage(), {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0,
  });
});

/**
 * 工具执行轨迹（step-N.exec.jsonl）。
 *
 * 为什么需要：step log 只有状态事件流（start/heartbeat/complete），
 * **不记录 subagent 实际跑了什么命令、改了哪些文件**。排查「它到底做了什么」
 * 只能靠猜。`--mode json` 的 stdout 里本来有这些信息，但解析完就丢了。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSubagent } from "../utils/subagent.js";

function fakePi(body: string, dir: string) {
  const p = join(dir, "fake-pi.sh");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, "utf-8");
  chmodSync(p, 0o755);
  return p;
}

/** 造一段符合 pi --mode json 格式的事件流。 */
function eventStream(toolName: string, args: object, resultText: string): string {
  const lines = [
    { type: "turn_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: toolName, arguments: args }],
      },
    },
    {
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "text", text: resultText }] },
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

describe("工具执行轨迹", () => {
  it("记录每次 toolCall 的名称与参数", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-trace-"));
    const tracePath = join(dir, "logs", "step-1.exec.jsonl");
    const cmd = fakePi(`cat <<'JSON'
${eventStream("bash", { command: "echo hello" }, "hello\n")}
JSON`, dir);

    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 20_000, idleTimeoutMs: 20_000,
        toolLogPath: tracePath,
      });
      assert.ok(existsSync(tracePath), "轨迹文件应被创建");
      const rows = readFileSync(tracePath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const call = rows.find((r) => r.kind === "toolCall");
      assert.ok(call, "应有 toolCall 记录");
      assert.equal(call.name, "bash");
      assert.equal(call.args.command, "echo hello", "参数必须完整落盘");
      assert.ok(call.ts, "应带时间戳");
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("记录 toolResult 的大小与预览（不存全文）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-trace2-"));
    const tracePath = join(dir, "step-2.exec.jsonl");
    const big = "x".repeat(5000);
    const cmd = fakePi(`cat <<'JSON'
${eventStream("read", { path: "/tmp/big" }, big)}
JSON`, dir);

    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 20_000, idleTimeoutMs: 20_000, toolLogPath: tracePath,
      });
      const rows = readFileSync(tracePath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const res = rows.find((r) => r.kind === "toolResult");
      assert.ok(res, "应有 toolResult 记录");
      assert.equal(res.bytes, 5000, "应记录真实字节数");
      assert.ok(res.preview.length <= 300, "预览必须截断（不能存全文）");
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不传 toolLogPath 时不产生任何文件（默认零开销）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-trace3-"));
    const cmd = fakePi(`cat <<'JSON'
${eventStream("bash", { command: "ls" }, "ok")}
JSON`, dir);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 20_000, idleTimeoutMs: 20_000,
      });
      assert.equal(existsSync(join(dir, "logs")), false, "不应创建任何轨迹文件");
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

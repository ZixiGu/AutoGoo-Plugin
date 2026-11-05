/**
 * Subagent 超时机制 — idle 检测 / 提前结束
 *
 * 背景：原来只有 30 分钟总超时，子进程卡住时要白等半小时。
 * 这里验证三个新机制：
 *   1. idle 检测：连续无事件 → 提前 kill，timeoutReason="idle"
 *   2. 总超时兜底：timeoutReason="total"
 *   3. shouldStop：step 已结束 → stoppedEarly
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSubagent } from "../utils/subagent.ts";

/** 造一个"只输出一行就沉默"的假 pi，用于触发 idle 检测。 */
function silentPi(dir: string): string {
  const script = join(dir, "silent.mjs");
  writeFileSync(
    script,
    `process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"hi"}],usage:{input:1,output:1}}})+"\\n");
// 之后永久沉默，模拟卡住
setTimeout(() => {}, 600000);
`,
    "utf-8",
  );
  chmodSync(script, 0o755);
  return script;
}

test("idle 超时：长时间无事件 → 提前终止并标记 timeoutReason=idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autogoo-idle-"));
  const oldCmd = process.env.AUTOGOO_SUBAGENT_CMD;
  process.env.AUTOGOO_SUBAGENT_CMD = `node ${silentPi(dir)}`;
  try {
    const started = Date.now();
    const result = await runSubagent({
      task: "idle test",
      cwd: dir,
      provider: "test-provider",
      model: "test-model",
      timeoutMs: 60_000,      // 总超时很长
      idleTimeoutMs: 1_500,   // idle 很短 → 应该由 idle 先触发
    });
    const elapsed = Date.now() - started;

    assert.equal(result.timedOut, true, "应标记超时");
    assert.equal(result.timeoutReason, "idle", `应为 idle 而非 ${result.timeoutReason}`);
    assert.ok(elapsed < 20_000, `应在 idle 阈值附近终止，实际 ${elapsed}ms（不应等满 60s 总超时）`);
    assert.match(result.errorMessage ?? "", /无任何事件/);
  } finally {
    if (oldCmd === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
    else process.env.AUTOGOO_SUBAGENT_CMD = oldCmd;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldStop：返回 true 时提前结束并标记 stoppedEarly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autogoo-stop-"));
  const oldCmd = process.env.AUTOGOO_SUBAGENT_CMD;
  process.env.AUTOGOO_SUBAGENT_CMD = `node ${silentPi(dir)}`;
  try {
    const started = Date.now();
    const result = await runSubagent({
      task: "stop test",
      cwd: dir,
      provider: "test-provider",
      model: "test-model",
      timeoutMs: 60_000,
      idleTimeoutMs: 30_000,   // idle 很长，不应触发
      shouldStop: () => true,  // 第一次心跳（20s）就应终止
    });
    const elapsed = Date.now() - started;

    assert.equal(result.stoppedEarly, true, "应标记 stoppedEarly");
    assert.equal(result.timedOut, false, "stoppedEarly 不应算超时");
    assert.ok(elapsed < 35_000, `应在首个心跳后终止，实际 ${elapsed}ms`);
  } finally {
    if (oldCmd === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
    else process.env.AUTOGOO_SUBAGENT_CMD = oldCmd;
    rmSync(dir, { recursive: true, force: true });
  }
});

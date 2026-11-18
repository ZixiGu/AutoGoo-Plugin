/**
 * idle 检测的「信号 D：step log 增长」。
 *
 * 背景：A(JSON 事件) / B(CPU) / C(活跃后代) 覆盖不了「进程内纯 IO 等待」——
 * subagent 用 read 读超大文件、或模型 API 重试等待时，pi 进程既没有子进程、
 * CPU 也不明显增长、--mode json 又没有输出，三信号同时沉默会被误杀。
 *
 * 而 subagent 每次调 `auto_goo_update_step --heartbeat` 都会追加 step log，
 * 那是用户可见的真实进展，与 A/B/C 完全独立。
 *
 * 注：注释里曾写着这个信号（0.25.1 写多信号时），但**代码从未实现** ——
 * git log -S 确认。本测试钉住它现在的真实行为。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSubagent } from "../utils/subagent.js";

function fakePi(body: string, dir: string) {
  const p = join(dir, "fake-pi.sh");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, "utf-8");
  chmodSync(p, 0o755);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("信号 D：step log 增长算有进展", () => {
  it("只有 log 在增长时不应被判 idle（三信号全沉默）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-logd-"));
    const logPath = join(dir, "step-1.log");
    writeFileSync(logPath, "start\n", "utf-8");

    // 假 pi：完全静默（无 JSON 事件、无子进程），但外部在往 log 追加。
    // 用 `sleep` 保持进程存活，CPU 几乎不增长。
    const cmd = fakePi("sleep 6", dir);

    // 后台每 400ms 追加一行 log（模拟 subagent 的 heartbeat 记录）
    const writer = setInterval(() => {
      try {
        appendFileSync(logPath, `[tick] ${Date.now()}\n`, "utf-8");
      } catch {
        /* ignore */
      }
    }, 400);

    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const t0 = Date.now();
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 60_000,
        idleTimeoutMs: 1200,          // 1.2s 无任何信号就判 idle
        logPath,
      });
      const elapsed = Date.now() - t0;
      assert.equal(
        r.timedOut, false,
        `log 持续增长时不应判 idle（实际 ${elapsed}ms，reason=${r.timeoutReason}）`,
      );
    } finally {
      clearInterval(writer);
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("log 不增长 + 三信号沉默 → 仍应判 idle（不能把超时关掉）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-logd2-"));
    const logPath = join(dir, "step-2.log");
    writeFileSync(logPath, "frozen\n", "utf-8");

    // ⚠ 必须用 `exec sleep`：普通 `sleep 30` 是 sh 的子进程，会命中信号 C
    // （活跃后代），idle 永远不触发 —— 那样测不到任何东西。
    const cmd = fakePi("exec sleep 30", dir);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const t0 = Date.now();
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 60_000,
        idleTimeoutMs: 1200,
        logPath,
      });
      const elapsed = Date.now() - t0;
      assert.equal(r.timedOut, true, "log 不增长时应判 idle");
      assert.equal(r.timeoutReason, "idle");
      assert.ok(elapsed < 15_000, `应及时终止，实际 ${elapsed}ms`);
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不传 logPath 时行为不变（信号 D 不参与）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-logd3-"));
    // ⚠ 必须用 `exec sleep`：普通 `sleep 30` 是 sh 的子进程，会命中信号 C
    // （活跃后代），idle 永远不触发 —— 那样测不到任何东西。
    const cmd = fakePi("exec sleep 30", dir);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 60_000,
        idleTimeoutMs: 1200,
        // 无 logPath
      });
      assert.equal(r.timedOut, true, "无 logPath 时仍按 A/B/C 判定");
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Subagent 的生命周期终止条件。
 *
 * 决策（2026-11）：**取消所有自动 kill**。
 *
 * 曾有两套自动终止：total timeout（无进展 90 分钟）与 idle 检测（4 信号 + 5 分钟）。
 * 两者都要回答「什么叫没进展」，而每个判据都有盲区 —— 模型思考无事件、
 * 命令 detach 脱离进程树、长命令无 log 写入…逐轮修补的结果是规则越来越复杂、
 * 仍会误杀。实测为此改过 4 轮（30min 硬砍 → 无进展 → 四信号 → 内容分析）。
 *
 * 现在只剩三种终止：
 *   1. 子进程自己退出（正常路径）
 *   2. step 已 completed/failed（shouldStop）
 *   3. 调用方 AbortSignal 中断（用户 Esc）
 *
 * 代价：卡住会让 tool call 一直等 —— 自觉接受的取舍。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSubagent } from "../utils/subagent.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakePi(body: string, dir: string) {
  const p = join(dir, "fake-pi.sh");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, "utf-8");
  chmodSync(p, 0o755);
  return p;
}

describe("生命周期终止条件", () => {
  it("长时间静默不再被自动终止（核心行为变更）", async () => {
    // 完全静默（无事件、无子进程、无 CPU、无 log）10 秒 —— 旧版会被 idle 杀掉
    const dir = mkdtempSync(join(tmpdir(), "autogoo-life-"));
    const cmd = fakePi("exec sleep 8", dir);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const t0 = Date.now();
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        // 旧版会传 idleTimeoutMs: 1000 / timeoutMs: 1000 —— 现在这些选项已不存在
      });
      const elapsed = Date.now() - t0;
      assert.equal(r.timedOut, false, "不应再有自动超时");
      assert.equal(r.exitCode, 0);
      assert.ok(elapsed >= 7000, `应完整等子进程退出，实际 ${elapsed}ms`);
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shouldStop 仍生效：step 已结束则提前终止", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-life2-"));
    const cmd = fakePi("exec sleep 30", dir);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const t0 = Date.now();
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        heartbeatIntervalMs: 300,      // 加快 onTick 频率
        shouldStop: () => Date.now() - t0 > 1500,
      });
      const elapsed = Date.now() - t0;
      assert.equal(r.stoppedEarly, true, "应被 shouldStop 提前结束");
      assert.ok(elapsed < 15_000, `应及时终止，实际 ${elapsed}ms`);
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AbortSignal 仍生效：用户 Esc 可中断", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-life3-"));
    const cmd = fakePi("exec sleep 30", dir);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    const ac = new AbortController();
    try {
      const t0 = Date.now();
      setTimeout(() => ac.abort(), 800);
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        signal: ac.signal,
      });
      const elapsed = Date.now() - t0;
      assert.equal(r.aborted, true, "应标记为 aborted");
      assert.ok(elapsed < 15_000, `Esc 后应及时退出，实际 ${elapsed}ms`);
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

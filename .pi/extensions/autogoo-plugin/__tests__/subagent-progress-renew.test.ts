/**
 * 总超时必须「进度感知」，不能硬砍。
 *
 * 实测依据（circuit_gen 项目 .goo/logs/exec.jsonl）：
 *   S1 完成 27.4min
 *   S2 start → 30min TIMEOUT(exit 143) → resume → 共 130min 才完成
 *   S3 start → 12.7min fail → resume → 共 234.5min 完成
 *   S5 start → 30min TIMEOUT(exit 143)
 *
 * 旧实现 `setTimeout(30min)` 硬砍，不看进展 —— 真实工程任务必然被杀，
 * 然后 resume 从头重跑，浪费远超任务本身。
 *
 * 新语义：只有「连续 N 分钟完全无进展」才杀。真正的卡住由 idle 检测负责。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSubagent } from "../utils/subagent.js";

function fakePi(body: string): { dir: string; cmd: string } {
  const dir = mkdtempSync(join(tmpdir(), "autogoo-renew-"));
  const p = join(dir, "fake-pi.sh");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, "utf-8");
  chmodSync(p, 0o755);
  return { dir, cmd: p };
}

describe("总超时：进度感知续期", () => {
  it("持续输出的长任务不会被「总超时」杀掉", async () => {
    // 每 300ms 输出一行 JSON，持续 3 秒。总超时设 1 秒 ——
    // 若是硬砍，1 秒时就杀了；进度感知则应放行（因为一直在输出）。
    const { dir, cmd } = fakePi(`
      i=0
      while [ $i -lt 10 ]; do
        echo '{"type":"message_update"}'
        i=$((i+1))
        sleep 0.3
      done
      echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}'
    `);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const t0 = Date.now();
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 1000,          // 若硬砍 → 1 秒就杀
        idleTimeoutMs: 10_000,    // idle 不参与本用例
      });
      const elapsed = Date.now() - t0;
      assert.equal(r.timedOut, false, `不应判超时（有持续进展）。errorMessage=${r.errorMessage}`);
      assert.ok(elapsed > 2000, `应跑完 ~3 秒，实际 ${elapsed}ms`);
      assert.equal(r.exitCode, 0);
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("真正无进展时仍会被杀（不能把超时彻底关掉）", async () => {
    // 完全静默、无 CPU、无后代：sleep 不产生 JSON 事件。
    // 注意 sleep 本身会被 readCpuTicks 视为"无 CPU 增长"，符合"无进展"。
    const { dir, cmd } = fakePi(`sleep 30`);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const t0 = Date.now();
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 1200,
        idleTimeoutMs: 0,         // 关掉 idle，单独验证总超时仍然生效
      });
      const elapsed = Date.now() - t0;
      assert.equal(r.timedOut, true, "无进展应判超时");
      assert.ok(elapsed < 10_000, `应及时终止，实际 ${elapsed}ms`);
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("超时原因必须标注是「无进展」而非含糊的 total", async () => {
    const { dir, cmd } = fakePi(`sleep 30`);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 1200, idleTimeoutMs: 0,
      });
      assert.match(r.errorMessage || "", /无任何进展/, "错误信息应说明是「无进展」而非笼统超时");
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kill 必须杀进程树，不能留孤儿", () => {
  it("孙进程不会在父进程被杀后继续存活", async () => {
    // 回归：proc.kill() 只杀直接子进程。subagent 跑的是 pi，pi 再 spawn bash ——
    // 那个 bash 不会随 SIGTERM 一起死（shell 不转发信号），变成孤儿继续写文件。
    // 实测表现：父进程 5 秒就退了，但 stdout 管道被孤儿占着，调用方白等 25 秒。
    const { dir, cmd } = fakePi(`sleep 30`);
    const marker = join(dir, "grandchild-alive.txt");
    // 用 sleep 30 模拟孙进程；父进程被 SIGTERM 后它仍在，日志会暴露
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const t0 = Date.now();
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 800, idleTimeoutMs: 0,
      });
      const elapsed = Date.now() - t0;
      assert.equal(r.timedOut, true);
      // 关键断言：必须在「超时阈值 + 宽限期(5s)」内结束，而不是等 sleep 30 自己跑完
      assert.ok(
        elapsed < 15_000,
        `应在杀进程树后立即返回，实际 ${elapsed}ms（>15s 说明孙进程存活并占着管道）`,
      );
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("正常完成的进程不会被误杀", async () => {
    const { dir, cmd } = fakePi(`echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}'`);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 10_000, idleTimeoutMs: 10_000,
      });
      assert.equal(r.exitCode, 0);
      assert.equal(r.timedOut, false);
      assert.match(r.output, /ok/);
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

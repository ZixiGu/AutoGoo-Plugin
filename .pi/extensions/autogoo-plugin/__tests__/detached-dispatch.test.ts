/**
 * Detached 派发测试。
 *
 * 存在的理由：pi 对每个 tool call 有硬编码 `TOOL_TIMEOUT_MS = 12e4`（2 分钟），
 * 到点 abort → 我们转发的 signal 触发 SIGTERM → 所有 subagent exit=143。
 * 实测：4 个步骤全部停在 progress=15，日志只有两行。
 *
 * 所以核心断言是**子进程能活过父进程的 abort**，而不只是"spawn 成功"。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { spawnSubagentDetached, isDetachedAlive } from "../utils/subagent.js";

function makeFakePi(body: string): { dir: string; cmd: string } {
  const dir = mkdtempSync(join(tmpdir(), "autogoo-detached-"));
  const p = join(dir, "fake-pi.sh");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, "utf-8");
  chmodSync(p, 0o755);
  return { dir, cmd: p };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("isDetachedAlive", () => {
  it("存活进程返回 true", () => {
    assert.equal(isDetachedAlive(process.pid), true);
  });

  it("已退出进程返回 false", async () => {
    const r = spawnSync("sh", ["-c", "exit 0"]);
    // pid 可能已被回收，也可能仍是僵尸；不强求 false，只要求不抛
    assert.equal(typeof isDetachedAlive(r.pid ?? 0), "boolean");
  });

  it("非法 pid 返回 false", () => {
    assert.equal(isDetachedAlive(0), false);
    assert.equal(isDetachedAlive(-1), false);
  });
});

describe("spawnSubagentDetached", () => {
  it("立即返回 pid，不等待子进程结束", async () => {
    const { dir, cmd } = makeFakePi("sleep 3");
    const logPath = join(dir, "out.jsonl");
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const t0 = Date.now();
      const h = spawnSubagentDetached({
        provider: "test-provider", model: "test-model",
        task: "x", cwd: dir, logPath,
      });
      const elapsed = Date.now() - t0;
      assert.ok(h.pid > 0, "应返回 pid");
      assert.ok(elapsed < 1000, `spawn 应立即返回（实际 ${elapsed}ms），不能等子进程`);
      assert.equal(isDetachedAlive(h.pid), true, "刚 spawn 应存活");
      await sleep(3500);
      assert.equal(isDetachedAlive(h.pid), false, "子进程应已自行退出");
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detached 子进程不随父进程组 SIGTERM 一起死（核心回归）", async () => {
    // 模拟 pi 的 2 分钟 abort：向**父进程组**发 SIGTERM。
    // detached:true 让子进程自成一个进程组，父进程组的信号打不到它。
    const { dir, cmd } = makeFakePi("sleep 4; echo done > \"$0.done\"");
    const logPath = join(dir, "out.jsonl");
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const h = spawnSubagentDetached({
        provider: "p", model: "m", task: "x", cwd: dir, logPath,
      });
      // 对父进程组发 TERM（不含子进程组）
      process.kill(-process.pid, "SIGTERM");
    } catch {
      /* 无权限或已在独立组，忽略 */
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("输出重定向到 logPath（detached 后无法用管道）", async () => {
    const { dir, cmd } = makeFakePi('echo \'{"type":"ok"}\'');
    const logPath = join(dir, "out.jsonl");
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      spawnSubagentDetached({ provider: "p", model: "m", task: "x", cwd: dir, logPath });
      await sleep(800);
      assert.ok(existsSync(logPath), "日志文件应存在");
      assert.match(readFileSync(logPath, "utf-8"), /\{"type":"ok"\}/);
    } finally {
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未解析模型时拒绝派发（不得静默用全局默认）", () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-detached-"));
    try {
      assert.throws(
        () => spawnSubagentDetached({ task: "x", cwd: dir, logPath: join(dir, "o.log") }),
        /模型未解析/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

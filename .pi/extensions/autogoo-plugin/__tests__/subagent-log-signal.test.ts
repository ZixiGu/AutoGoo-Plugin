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

    // 假 pi：完全静默（无 JSON 事件、无子进程），但外部在往 log 追加**符合真实格式**的行。
    // ⚠ 必须用 `- <ts> update ... progress=N detail=...` 格式 —— 旧版本写的是
    //   `[tick] <ts>`，readLogSignal 解析不到（行首不是 "- "、无 progress=），
    //   于是信号 D 根本没生效，测试只是靠 `sleep 6` 自然结束而"通过"（假通过）。
    //   同时用 `exec sleep` 消除信号 C。
    const cmd = fakePi("exec sleep 12", dir);

    let pct = 10;
    const writer = setInterval(() => {
      try {
        pct += 5;
        appendFileSync(
          logPath,
          `- ${new Date().toISOString()} update status=running progress=${pct} detail=处理第 ${pct} 批\n`,
          "utf-8",
        );
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

  it("重复的模板化 heartbeat 不算进展（关键：父进程每 20s 写一次）", async () => {
    // 实测：父进程 heartbeatTimer 每 20s 调 update-step --heartbeat，
    // 追加的是**完全相同**的一行（只有时间戳不同）：
    //   - 08:29:47 heartbeat status=running progress=80 detail=Subagent running (agent-1-…)
    //   - 08:30:07 heartbeat status=running progress=80 detail=Subagent running (agent-1-…)
    // 若只看「文件变大」，idle 检测会被自己的心跳架空，永远判活。
    const dir = mkdtempSync(join(tmpdir(), "autogoo-logd-tpl-"));
    const logPath = join(dir, "step-tpl.log");
    const ts = (i: number) => new Date(Date.now() + i * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    writeFileSync(
      logPath,
      `- ${ts(0)} heartbeat status=running progress=80 agent=a detail=Subagent running (agent-1-123)\n`,
      "utf-8",
    );

    // 每 400ms 追加一条**内容完全相同**的模板心跳
    let n = 1;
    const writer = setInterval(() => {
      try {
        appendFileSync(
          logPath,
          `- ${ts(n++)} heartbeat status=running progress=80 agent=a detail=Subagent running (agent-1-123)\n`,
          "utf-8",
        );
      } catch { /* ignore */ }
    }, 400);

    const cmd = fakePi("exec sleep 30", dir);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 60_000, idleTimeoutMs: 1500, logPath,
      });
      assert.equal(
        r.timedOut, true,
        "模板化 heartbeat 只增行数、不含新信息，必须仍判 idle（否则 idle 检测形同虚设）",
      );
      assert.equal(r.timeoutReason, "idle");
    } finally {
      clearInterval(writer);
      if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
      else process.env.AUTOGOO_SUBAGENT_CMD = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("progress 增加算实质进展", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autogoo-logd-prog-"));
    const logPath = join(dir, "step-prog.log");
    writeFileSync(logPath, "- t0 heartbeat status=running progress=10 detail=start\n", "utf-8");

    let pct = 10;
    const writer = setInterval(() => {
      try {
        pct += 5;
        appendFileSync(logPath, `- t${pct} update status=running progress=${pct} detail=阶段性完成\n`, "utf-8");
      } catch { /* ignore */ }
    }, 400);

    const cmd = fakePi("exec sleep 6", dir);
    const prev = process.env.AUTOGOO_SUBAGENT_CMD;
    process.env.AUTOGOO_SUBAGENT_CMD = cmd;
    try {
      const r = await runSubagent({
        provider: "p", model: "m", task: "x", cwd: dir,
        timeoutMs: 60_000, idleTimeoutMs: 1500, logPath,
      });
      assert.equal(r.timedOut, false, "progress 持续增加时不应判 idle");
    } finally {
      clearInterval(writer);
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

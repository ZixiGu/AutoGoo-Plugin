/**
 * utils/exec.ts 执行工具 — 单元测试（node:test + node:assert/strict）
 *
 * 回归背景（2026-08 修复）：ssh_exec 频繁"始终无输出"——
 * 根因是 spawnSync 超时（ETIMEDOUT）时错误信息被丢弃，返回
 * exitCode=1 + 空 stdout/stderr，上层只能显示 "(no output)"。
 * 本测试锁定：超时/中止/截断错误必须出现在 stderr，绝不静默空输出。
 *
 * 运行：cd .pi/extensions/autogoo-plugin && node --import tsx --test __tests__/exec-async.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { exec, execAsync } from "../utils/exec.js";

test("exec 正常执行：stdout/stderr 分离，exitCode 透传", () => {
  const r = exec("bash", ["-c", "echo hello; echo err >&2; exit 0"], "/tmp");
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "hello\n");
  assert.equal(r.stderr, "err\n");
});

test("exec 超时：ETIMEDOUT 原因必须写入 stderr（回归：不再静默空输出）", () => {
  const r = exec("bash", ["-c", "echo start; sleep 5; echo end"], "/tmp", { timeout: 300 });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /timed out/);
  assert.equal(r.stdout, "start\n"); // 超时前已有输出应保留
});

test("exec 非零退出：stderr 保留，可诊断", () => {
  const r = exec("bash", ["-c", "echo boom >&2; exit 3"], "/tmp");
  assert.equal(r.exitCode, 3);
  assert.match(r.stderr, /boom/);
});

test("execAsync 正常执行：stdout/stderr/exitCode 正确", async () => {
  const r = await execAsync("bash", ["-c", "echo hello; echo err >&2"], "/tmp");
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "hello\n");
  assert.equal(r.stderr, "err\n");
  assert.equal(r.timedOut, false);
  assert.equal(r.aborted, false);
});

test("execAsync 超时：timedOut=true 且 stderr 带原因", async () => {
  const r = await execAsync("bash", ["-c", "sleep 5"], "/tmp", { timeout: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /timed out/);
});

test("execAsync abort：AbortSignal 中止子进程，stderr 带原因", async () => {
  const ac = new AbortController();
  const p = execAsync("bash", ["-c", "sleep 5"], "/tmp", { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /aborted/);
});

test("execAsync 进程组终止：残留子进程（持管道）时 abort 仍立即返回（回归：Esc 后不再卡 Working）", async () => {
  // 模拟 goo-ssh.sh → sshpass → ssh 链：父进程 spawn 子进程(继承 stdout) 并 wait。
  // 旧实现只 kill 单进程 → 子进程残留持管道 → Node close 永不触发 → 工具一直 Working。
  const ac = new AbortController();
  const p = execAsync("bash", ["-c", "(sleep 60) & echo spawned; wait"], "/tmp", { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  ac.abort();
  const r = await p;
  const elapsed = Date.now() - t0;
  assert.equal(r.aborted, true);
  assert.ok(elapsed < 2000, `abort 后应在 2s 内返回，实际 ${elapsed}ms`);
  assert.match(r.stderr, /aborted/);
});

test("execAsync 流式回调：增量 chunk 转发给调用方", async () => {
  const chunks: string[] = [];
  await execAsync("bash", ["-c", "printf 'a'; printf 'b'"], "/tmp", {
    onStdout: (c) => chunks.push(c),
  });
  assert.equal(chunks.join(""), "ab");
});

test("execAsync 非零退出：stderr 原样保留", async () => {
  const r = await execAsync("bash", ["-c", "echo boom >&2; exit 3"], "/tmp");
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr, "boom\n");
});

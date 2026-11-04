/**
 * 状态栏自动刷新 — 集成测试（2026-08-24）
 *
 * 验证：plan 有活动步骤时 updateStatusBar 会启动周期刷新定时器，
 * 定时器周期重渲染状态栏；plan 全部完成后停止定时器（不泄漏）。
 *
 * 运行: npx tsx utils/status.auto.test.ts
 * 环境: AUTOGOO_STATUS_REFRESH_MS 控制刷新间隔（测试用 150ms）
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ⚠ 必须在 import status.ts **之前**设置：status.ts 在模块顶层计算
//   STATUS_REFRESH_INTERVAL_MS，一旦加载就固化，之后再改环境变量无效。
//   （这正是这两个用例长期失败的原因：环境变量从未被设置，定时器是 15s，
//    而测试只等 450ms。）
process.env.AUTOGOO_STATUS_REFRESH_MS = "150";

const { updateStatusBar, clearStatusBar, startStatusBarAutoRefresh, stopStatusBarAutoRefresh } =
  await import("./status.ts");

const REFRESH_MS = 150;

/** 轮询等待条件成立（替代固定 sleep，避免 CI 负载下次数不够）。 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
}

function makePlan(steps: Array<{ id: number; status: string }>) {
  return {
    id: "test-plan",
    task: "status-bar auto refresh test",
    status: steps.every((s) => s.status === "completed") ? "completed" : "running",
    steps: steps.map((s) => ({
      id: s.id,
      name: `step-${s.id}`,
      description: `step ${s.id}`,
      depends_on: [] as number[],
      type: "exec",
      subagent: "implementer",
      status: s.status,
    })),
  };
}

function makeFakeCtx(cwd: string) {
  const setStatusCalls: Array<{ key: string; text?: string }> = [];
  return {
    ctx: { cwd, ui: { setStatus: (key: string, text?: string) => setStatusCalls.push({ key, text }) } },
    calls: setStatusCalls,
  };
}

function writePlan(cwd: string, plan: any) {
  const dir = join(cwd, ".goo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2), "utf-8");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("auto-refresh: timer starts on active plan, refreshes, stops on completion", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "autogoo-status-"));
  try {
    writePlan(cwd, makePlan([{ id: 1, status: "running" }, { id: 2, status: "pending" }]));
    const { ctx, calls } = makeFakeCtx(cwd);

    // 1. 有活动步骤 → 立即渲染 + 启动定时器
    await updateStatusBar(ctx);
    assert.ok(calls.length >= 1, "status should be set on first update");
    assert.match(calls[0].text ?? "", /0\/2/, "line should show 0/2 (0 completed, 1 running, 1 pending)");

    // 幂等：重复调用不重复启动（无法直接观察 Map，但不应抛错/覆盖计数错误）
    await updateStatusBar(ctx);

    // 2. 等待几个 tick → 状态栏被周期重渲染（count 明显增长）
    const countAfterStart = calls.length;
    await waitFor(() => calls.length > countAfterStart, 5000, "periodic refresh");

    // 3. plan 全部完成 → 下一次 tick 渲染最终状态并停止定时器
    //    注意 snapshotPlan 有 1s 缓存（CACHE_TTL_MS=1000），需等缓存过期才能读到新 plan
    writePlan(cwd, makePlan([{ id: 1, status: "completed" }, { id: 2, status: "completed" }]));
    // snapshotPlan 有 1s 缓存，等它过期并出现 2/2 的渲染
    await waitFor(
      () => (calls[calls.length - 1]?.text ?? "").includes("2/2"),
      5000,
      "final 2/2 render",
    );
    const last = calls[calls.length - 1];
    assert.match(last.text ?? "", /2\/2/, "final line should show 2/2");

    // 4. 停止后不再有刷新（定时器已停止）
    const countAfterStop = calls.length;
    await new Promise((r) => setTimeout(r, REFRESH_MS * 4));
    assert.equal(calls.length, countAfterStop, "no refreshes after timer stopped");
  } finally {
    stopStatusBarAutoRefresh(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("clearStatusBar stops timer and clears status", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "autogoo-status-"));
  try {
    writePlan(cwd, makePlan([{ id: 1, status: "pending" }]));
    const { ctx, calls } = makeFakeCtx(cwd);
    await updateStatusBar(ctx); // 启动定时器
    await sleep(REFRESH_MS * 2);
    clearStatusBar(ctx);
    assert.equal(calls[calls.length - 1].text, undefined, "clear sets status to undefined");
    // 之后不应再有刷新（clearStatusBar 自己的那一次调用已计入）
    const before = calls.length;
    await new Promise((r) => setTimeout(r, REFRESH_MS * 4));
    assert.equal(calls.length, before, "no refreshes after clearStatusBar");
  } finally {
    stopStatusBarAutoRefresh(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startStatusBarAutoRefresh is idempotent per cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "autogoo-status-"));
  try {
    writePlan(cwd, makePlan([{ id: 1, status: "running" }]));
    const { ctx, calls } = makeFakeCtx(cwd);
    startStatusBarAutoRefresh(ctx);
    startStatusBarAutoRefresh(ctx); // 第二次应被忽略
    await sleep(REFRESH_MS * 2);
    const counts = calls.length;
    await sleep(REFRESH_MS * 2);
    assert.ok(counts > 0, "timer should refresh");
  } finally {
    stopStatusBarAutoRefresh(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

/**
 * 僵尸步骤自愈测试。
 *
 * 背景：circuit_gen 项目的 plan 卡在 status=running、#A 心跳停在两天前。
 * 看门狗每 60s 检查、每个 key 每会话最多通知 2 次 —— 但**每开新会话就重置**，
 * 于是用户看到「一直显示」。
 *
 * 根因不是告警太吵，是**状态没有被收敛**：RUNNING 的语义是「有东西在跑」，
 * 而僵尸步骤没有任何东西在跑，它就该是 interrupted。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reconcileZombieSteps } from "../utils/exec-observe.js";

const TH = { stepTimeoutMinutes: 30, staleHeartbeatSeconds: 900, planStallMinutes: 15, maxRetries: 1 };

function setup(steps: any[], agents: Record<string, any> = {}) {
  const root = mkdtempSync(join(tmpdir(), "goo-zombie-"));
  const thread = join(root, ".goo", "threads", "t1");
  mkdirSync(thread, { recursive: true });
  const planPath = join(thread, "plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({ task: "t", status: "running", thread: { id: "t1" }, steps }),
    "utf-8",
  );
  const agentsDir = join(thread, "agents");
  if (Object.keys(agents).length > 0) {
    mkdirSync(agentsDir, { recursive: true });
    for (const [k, v] of Object.entries(agents)) {
      writeFileSync(join(agentsDir, `step-${k}.json`), JSON.stringify(v), "utf-8");
    }
  }
  return { root, planPath };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

describe("reconcileZombieSteps", () => {
  it("心跳超过 6 倍阈值的 running 步骤被降级为 interrupted", () => {
    // ⚠ 必须登记一个「已死」的 pid：否则状态是 unknown（无法判断），不会降级。
    // 这是 2026-11 的语义收紧 —— 详见 alert-proc-aware.test.ts 里
    // 「无 pid 文件 → 不降级」的用例。
    const { planPath } = setup(
      [
        { id: "A", name: "A", status: "running", heartbeat_at: hoursAgo(48) },
        { id: "B", name: "B", status: "pending" },
      ],
      { A: { pid: 999999, logPath: "", startedAt: "" } },
    );
    const healed = reconcileZombieSteps(planPath, JSON.parse(readFileSync(planPath, "utf-8")), TH);
    assert.deepEqual(healed, ["A"], "有已死 pid 才应降级 #A");
  });

  it("刚跑不久的 running 步骤不动（避免误伤）", () => {
    const { planPath } = setup([
      { id: "A", name: "A", status: "running", heartbeat_at: new Date().toISOString() },
    ]);
    const healed = reconcileZombieSteps(planPath, JSON.parse(readFileSync(planPath, "utf-8")), TH);
    assert.deepEqual(healed, [], "心跳新鲜时不得降级");
  });

  it("阈值边界：5 倍不降级、7 倍降级（6 倍是分界）", () => {
    // staleHeartbeatSeconds=900 → 6 倍 = 5400s = 1.5h
    const mk = (h: number) => {
      const { planPath } = setup(
        [{ id: "A", name: "A", status: "running", heartbeat_at: hoursAgo(h) }],
        { A: { pid: 999999, logPath: "", startedAt: "" } },
      );
      const plan = JSON.parse(readFileSync(planPath, "utf-8"));
      return reconcileZombieSteps(planPath, plan, TH).length;
    };
    assert.equal(mk(1.2), 0, "1.2h 未超 1.5h，不应降级");
    assert.equal(mk(2), 1, "2h 超过 1.5h，应降级");
  });

  it("有活着的 detached 子进程时不降级（关键防误伤）", () => {
    const { planPath } = setup(
      [{ id: "A", name: "A", status: "running", heartbeat_at: hoursAgo(48) }],
      { A: { pid: process.pid, logPath: "/tmp/x", startedAt: "" } },   // 用自己当"活进程"
    );
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    const healed = reconcileZombieSteps(planPath, plan, TH);
    assert.deepEqual(healed, [], "检测到活进程时绝不能改状态");
  });

  it("已死进程的 pid 不阻止降级", () => {
    const { planPath } = setup(
      [{ id: "A", name: "A", status: "running", heartbeat_at: hoursAgo(48) }],
      { A: { pid: 999999, logPath: "/tmp/x", startedAt: "" } },        // 不存在的 pid
    );
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    assert.deepEqual(reconcileZombieSteps(planPath, plan, TH), ["A"]);
  });

  it("pending / completed 步骤不受影响", () => {
    const { planPath } = setup([
      { id: "A", name: "A", status: "pending" },
      { id: "B", name: "B", status: "completed", heartbeat_at: hoursAgo(48) },
    ]);
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    assert.deepEqual(reconcileZombieSteps(planPath, plan, TH), []);
  });
});

describe("observabilityOf：两处 stale 阈值必须同源", () => {
  it("observability 缺省时回退到 execution.stale_after_seconds", async () => {
    // 回归：某项目配了 execution.stale_after_seconds=120（2 分钟），
    // 但告警只读 observability.stale_heartbeat_seconds（默认 900s=15 分钟）。
    // 结果用户看到「已 16min 没有心跳（阈值 15min）」，困惑「我明明配的 2 分钟」。
    const { observabilityOf } = await import("../utils/exec-observe.js");
    const cfg: any = { execution: { stale_after_seconds: 120 } };
    const out = observabilityOf(cfg);
    assert.equal(out?.stale_heartbeat_seconds, 120, "应沿用执行侧的 2 分钟");
  });

  it("observability 显式配置优先（不被 execution 覆盖）", async () => {
    const { observabilityOf } = await import("../utils/exec-observe.js");
    const out = observabilityOf({
      execution: { stale_after_seconds: 120 },
      observability: { stale_heartbeat_seconds: 600 },
    } as any);
    assert.equal(out?.stale_heartbeat_seconds, 600, "显式配置优先");
  });

  it("两段都缺时返回 undefined（使用内置默认）", async () => {
    const { observabilityOf } = await import("../utils/exec-observe.js");
    assert.equal(observabilityOf({} as any), undefined);
    assert.equal(observabilityOf(null), undefined);
  });

  it("只有 observability 时原样返回", async () => {
    const { observabilityOf } = await import("../utils/exec-observe.js");
    const out = observabilityOf({ observability: { plan_stall_minutes: 5 } } as any);
    assert.equal(out?.plan_stall_minutes, 5);
    assert.equal(out?.stale_heartbeat_seconds, undefined);
  });
});

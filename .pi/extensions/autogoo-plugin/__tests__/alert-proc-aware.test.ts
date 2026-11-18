/**
 * 告警与僵尸自愈必须看「进程」，不能只看「心跳」。
 *
 * 背景（用户实测）：某任务跑了 50 分钟，告警一直报
 *   「#2 clock_opt + route_opt 已 50min 没有心跳（阈值 15min），很可能卡住」
 * 但任务其实还在跑 —— 心跳只反映「父进程还在不在」，父进程退出后子进程
 * 可能仍在运行（长任务、孤儿进程）。
 *
 * 更危险的是 reconcileZombieSteps：它把「没有 pid 文件」当「进程已死」，
 * 而阻塞派发从来就不写 pid 文件 → 90 分钟后会把正在跑的长任务误标 interrupted。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluatePlanAlerts, reconcileZombieSteps } from "../utils/exec-observe.js";

const TH = { stepTimeoutMinutes: 30, staleHeartbeatSeconds: 900, planStallMinutes: 15, maxRetries: 1 };
// 告警阈值 15min、自愈阈值 6×15min=90min —— 两者要用不同的时间点：
//   告警测试用 50 分钟前的（已超 15min，应报）
//   自愈测试用 2 小时前的（已超 90min，才进入降级判定）
const staleHb = (minutes = 50) => new Date(Date.now() - minutes * 60_000).toISOString();

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "goo-proc-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function setup(pid: number | null, dirName: string, hbMinutes = 50) {
  const thread = join(root, dirName, ".goo", "threads", "t1");
  mkdirSync(join(thread, "agents"), { recursive: true });
  const planPath = join(thread, "plan.json");
  const plan = {
    task: "t", status: "running", thread: { id: "t1" },
    steps: [{ id: "2", name: "clock_opt", status: "running", progress: 40, heartbeat_at: staleHb(hbMinutes) }],
  };
  writeFileSync(planPath, JSON.stringify(plan), "utf-8");
  if (pid !== null) {
    writeFileSync(join(thread, "agents", "step-2.json"), JSON.stringify({ pid, startedAt: new Date().toISOString() }), "utf-8");
  }
  return { plan, planPath };
}

describe("告警：有活进程时不报「卡住」", () => {
  it("pid 存活 → 不产生 step_timeout 告警", () => {
    // 用测试进程自己当作「活着的子进程」
    const { plan, planPath } = setup(process.pid, "alive");
    const alerts = evaluatePlanAlerts({ plan, planPath, now: Date.now(), thresholds: TH } as any);
    assert.equal(
      alerts.some((a) => a.code === "step_timeout"), false,
      `有活进程时不应报卡住，实际: ${alerts.map((a) => a.code).join(",")}`,
    );
  });

  it("pid 已死 → 正常报 step_timeout", () => {
    const { plan, planPath } = setup(999999, "dead");
    const alerts = evaluatePlanAlerts({ plan, planPath, now: Date.now(), thresholds: TH } as any);
    assert.ok(alerts.some((a) => a.code === "step_timeout"), "进程确实死了应报");
  });

  it("无 pid 文件（无法判断）→ 仍报，但不误杀（交给自愈的三态判断）", () => {
    const { plan, planPath } = setup(null, "unknown");
    const alerts = evaluatePlanAlerts({ plan, planPath, now: Date.now(), thresholds: TH } as any);
    assert.ok(alerts.some((a) => a.code === "step_timeout"), "无法判断时保守报警");
  });
});

describe("自愈：无法证明死亡就不降级", () => {
  it("无 pid 文件 → 不降级（阻塞派发的正常长任务不能被误杀）", () => {
    const { plan, planPath } = setup(null, "reconcile-unknown", 120);
    const healed = reconcileZombieSteps(planPath, plan as any, TH, Date.now());
    assert.deepEqual(healed, [], "没有 pid 记录时不能假定进程已死");
  });

  it("pid 已死 → 降级为 interrupted", () => {
    const { plan, planPath } = setup(999999, "reconcile-dead", 120);
    const healed = reconcileZombieSteps(planPath, plan as any, TH, Date.now());
    assert.deepEqual(healed, ["2"], "有 pid 且已死，才可判定僵尸");
  });

  it("pid 存活 → 不降级", () => {
    const { plan, planPath } = setup(process.pid, "reconcile-alive", 120);
    const healed = reconcileZombieSteps(planPath, plan as any, TH, Date.now());
    assert.deepEqual(healed, []);
  });
});

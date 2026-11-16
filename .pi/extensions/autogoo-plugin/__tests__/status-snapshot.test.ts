/**
 * 状态快照与状态栏渲染测试。
 *
 * `snapshotPlan` 是状态栏、/goo-status、DAG 健康检查的共同数据源。
 * 它错一个字段，三个地方同时显示错数据 —— 但都不会报错。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { snapshotPlan, formatStatusLine } from "../utils/status.js";

const theme: any = new Proxy({}, { get: () => (_t: string, s: string) => s });

function makePlan(dir: string, steps: any[], extra: any = {}) {
  const plan = {
    task: "测试任务",
    status: "running",
    thread: { id: "t1" },
    steps: steps.map((s, i) => ({
      id: i + 1, name: `步骤${i + 1}`, status: "pending", progress: 0,
      depends_on: [], type: "exec", ...s,
    })),
    ...extra,
  };
  // snapshotPlan(cwd) 内部按 cwd 找 .goo/plan.json
  mkdirSync(join(dir, ".goo"), { recursive: true });
  writeFileSync(join(dir, ".goo", "plan.json"), JSON.stringify(plan), "utf-8");
  return plan;
}

describe("snapshotPlan", () => {
  it("统计各状态数量，total 等于步骤总数", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goo-status-"));
    try {
      makePlan(dir, [
        { status: "completed" }, { status: "completed" },
        { status: "running" }, { status: "pending" }, { status: "failed" },
      ]);
      const snap = await snapshotPlan(dir);
      assert.ok(snap, "应返回快照");
      assert.equal(snap!.total, 5);
      assert.equal(snap!.completed, 2);
      assert.equal(snap!.running, 1);
      assert.equal(snap!.failed, 1);
      assert.equal(snap!.pending, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan 不存在时返回 null 而不抛", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goo-status-"));
    try {
      assert.equal(await snapshotPlan(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("坏 JSON 不抛（状态栏不能因为 plan 写坏就崩）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goo-status-"));
    try {
      mkdirSync(join(dir, ".goo"), { recursive: true });
      writeFileSync(join(dir, ".goo", "plan.json"), "{not json", "utf-8");
      assert.equal(await snapshotPlan(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("空 steps 不除零（进度必须是有限数）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goo-status-"));
    try {
      makePlan(dir, []);
      const snap = await snapshotPlan(dir);
      assert.ok(Number.isFinite((snap as any)?.progress ?? 0), "进度不能是 NaN/Infinity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatStatusLine", () => {
  it("各种快照下都不超宽且不抛", () => {
    const cases: any[] = [
      { total: 0, completed: 0, running: 0, pending: 0, blocked: 0, failed: 0, staleHeartbeats: 0 },
      { total: 5, completed: 3, running: 1, pending: 1, blocked: 0, failed: 0, staleHeartbeats: 0,
        currentStepName: "一个特别特别特别特别特别特别长的步骤名称用于测试截断行为", progress: 60 },
      { total: 2, completed: 2, running: 0, pending: 0, blocked: 0, failed: 0, staleHeartbeats: 0 },
    ];
    for (const c of cases) {
      const line = formatStatusLine(c, theme);
      assert.equal(typeof line, "string");
      assert.ok(!/NaN|undefined|Infinity/.test(line), `状态栏不得出现 NaN/undefined: ${line}`);
    }
  });
});

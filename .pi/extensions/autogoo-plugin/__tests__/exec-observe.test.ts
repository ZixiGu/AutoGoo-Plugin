/**
 * 执行观测测试。
 *
 * 存在的理由与 `recall-observe.test.ts` 相同：**没有观测，坏了也没人知道**。
 * 实测一轮 7 步 DAG 跑 2h11m，中途有步骤 exit 143、有步骤 interrupted，
 * 全靠人反复手动查状态才发现。这里断言的不是「有日志文件」，而是
 * 「日志能回答『卡住了吗 / 哪些 step 最容易超时 / 平均重试几次』」，
 * 以及「指标/告警链路自己坏掉时不会反过来搞坏执行」。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyFailure,
  createAlertState,
  deliverAlerts,
  evaluatePlanAlerts,
  execLogPath,
  formatHealthReport,
  lastActivityMs,
  postWebhook,
  readExecStats,
  thresholdsFromConfig,
  DEFAULT_THRESHOLDS,
  type ExecAlert,
  type ExecEvent,
} from "../utils/exec-observe.js";

let gooDir: string;

beforeEach(() => {
  gooDir = mkdtempSync(join(tmpdir(), "goo-exec-"));
});

/** 写一份事件日志（每行一条 JSON，与 exec_observe.py 的输出格式一致）。 */
function writeEvents(events: Array<Partial<ExecEvent>>, dir = gooDir): string {
  const path = execLogPath(dir);
  mkdirSync(join(dir, "logs"), { recursive: true });
  const body = events.map((e) => JSON.stringify({ ts: e.ts ?? new Date().toISOString(), ...e })).join("\n");
  writeFileSync(path, `${body}\n`, "utf-8");
  return path;
}

const NOW = Date.parse("2026-11-16T12:00:00Z");

function planWith(steps: any[], over: Record<string, unknown> = {}): any {
  return {
    task: "demo",
    status: "running",
    created_at: "2026-11-16T10:00:00Z",
    started_at: "2026-11-16T10:00:00Z",
    thread: { id: "tg-1" },
    steps,
    ...over,
  };
}

describe("readExecStats", () => {
  it("日志不存在时返回零值而不抛（面板/报告必须能在指标缺失时工作）", () => {
    const s = readExecStats(gooDir);
    assert.equal(s.ok, false);
    assert.equal(s.total, 0);
    assert.deepEqual(s.steps, []);
    assert.deepEqual(s.failures, []);
    assert.equal(s.path, execLogPath(gooDir));
  });

  it("能回答「哪些 step 最容易超时」：超时/中断按次数排序", () => {
    writeEvents([
      { event: "step_start", step_id: "1", step_name: "audit" },
      { event: "step_timeout", step_id: "1", step_name: "audit", duration_ms: 900_000, error_class: "timeout" },
      { event: "step_timeout", step_id: "1", step_name: "audit", duration_ms: 1_800_000, error_class: "timeout" },
      { event: "step_start", step_id: "2", step_name: "impl" },
      { event: "step_interrupt", step_id: "2", step_name: "impl", duration_ms: 60_000, exit_code: 143 },
      { event: "step_start", step_id: "3", step_name: "ok" },
      { event: "step_complete", step_id: "3", step_name: "ok", duration_ms: 30_000 },
    ]);
    const s = readExecStats(gooDir);
    assert.equal(s.ok, true);
    assert.equal(s.total, 7);
    assert.equal(s.timeoutProne[0].stepId, "1");
    assert.equal(s.timeoutProne[0].timeouts, 2);
    assert.equal(s.timeoutProne[1].stepId, "2");
    // 耗时只统计终止事件；start 不参与（否则 avg 会被 0 拉低）
    assert.equal(s.durations.samples, 4);
    assert.equal(s.slowest[0].stepId, "1");
    assert.equal(s.durations.maxMs, 1_800_000);
    assert.ok(s.durations.p95Ms >= 900_000);
  });

  it("能回答「失败原因聚类」：同桶合并 + 保留样例", () => {
    writeEvents([
      { event: "step_fail", step_id: "1", error_class: "auth", error: "401 unauthorized" },
      { event: "step_fail", step_id: "2", error_class: "auth", error: "invalid api key" },
      { event: "step_fail", step_id: "3", error_class: "rate_limit", error: "429 too many requests" },
    ]);
    const s = readExecStats(gooDir);
    assert.equal(s.failures[0].errorClass, "auth");
    assert.equal(s.failures[0].count, 2);
    assert.deepEqual(s.failures[0].steps.sort(), ["1", "2"]);
    assert.match(s.failures[0].sample, /401|invalid/);
  });

  it("能回答「平均重试几次」：平均按被重试过的 step 算（不是按全部 step）", () => {
    writeEvents([
      { event: "step_retry", step_id: "1" },
      { event: "step_retry", step_id: "1" },
      { event: "step_retry", step_id: "2" },
      { event: "step_complete", step_id: "3", duration_ms: 1000 },
    ]);
    const s = readExecStats(gooDir);
    assert.equal(s.retries.events, 3);
    assert.equal(s.retries.steps, 2);
    assert.equal(s.retries.avgPerStep, 1.5);
    assert.equal(s.retries.max, 2);
  });

  it("损坏行不致命，只计数（metric 写一半/手工编辑后仍可读）", () => {
    const path = writeEvents([{ event: "step_complete", step_id: "1", duration_ms: 10 }]);
    writeFileSync(path, `${readFileSync(path, "utf-8")}{not json\n`, "utf-8");
    const s = readExecStats(gooDir);
    assert.equal(s.ok, true);
    assert.equal(s.corruptLines, 1);
    assert.equal(s.total, 1);
  });

  it("thread 过滤只留该 thread（跨运行比较指标的前提）", () => {
    writeEvents([
      { event: "step_complete", step_id: "1", thread: "tg-1", duration_ms: 10 },
      { event: "step_complete", step_id: "1", thread: "tg-2", duration_ms: 99_000 },
    ]);
    const s = readExecStats(gooDir, { thread: "tg-1" });
    assert.equal(s.total, 1);
    assert.equal(s.durations.maxMs, 10);
  });
});

describe("classifyFailure", () => {
  it("超时优先于退出码", () => {
    assert.equal(classifyFailure("anything", { timedOut: true }), "timeout");
  });
  it("信号杀（123/137/143）单独成桶", () => {
    assert.equal(classifyFailure("", { exitCode: 143 }), "signal_killed");
    assert.equal(classifyFailure("", { exitCode: 1 }), "exit_code");
  });
  it("provider 类错误能被识别（这些只出现在 stderr 里）", () => {
    assert.equal(classifyFailure("Error: invalid api key"), "auth");
    assert.equal(classifyFailure("429 rate limit"), "rate_limit");
    assert.equal(classifyFailure("model not found: xyz"), "model");
  });
  it("没有错误文本时返回 none 而不是 unknown（避免虚假栏目）", () => {
    assert.equal(classifyFailure(""), "none");
    assert.equal(classifyFailure(null), "none");
  });
});

describe("evaluatePlanAlerts —— 无人值守时必须能主动提示", () => {
  it("running 但心跳超过阈值 → step_timeout（error 级）", () => {
    const alerts = evaluatePlanAlerts({
      plan: planWith([
        { id: 1, name: "long", status: "running", heartbeat_at: "2026-11-16T11:20:00Z", started_at: "2026-11-16T11:00:00Z" },
      ]),
      now: NOW,
    });
    const timeout = alerts.find((a) => a.code === "step_timeout");
    assert.ok(timeout, "必须报超时");
    assert.equal(timeout.level, "error");
    assert.match(timeout.message, /没有心跳/);
  });

  it("同一 step 心跳正常时不报（避免狼来了）", () => {
    const alerts = evaluatePlanAlerts({
      plan: planWith([
        { id: 1, name: "ok", status: "running", heartbeat_at: "2026-11-16T11:59:30Z", started_at: "2026-11-16T11:00:00Z" },
      ]),
      now: NOW,
    });
    assert.equal(alerts.filter((a) => a.code === "step_timeout").length, 0);
  });

  it("plan 长时间无进展 → plan_stall（最危险的无声停摆）", () => {
    const alerts = evaluatePlanAlerts({
      plan: planWith(
        [
          { id: 1, name: "a", status: "completed", completed_at: "2026-11-16T11:00:00Z" },
          { id: 2, name: "b", status: "pending", depends_on: [1] },
        ],
        { started_at: "2026-11-16T10:00:00Z" },
      ),
      now: NOW,
      thresholds: { planStallMinutes: 15 },
    });
    const stall = alerts.find((a) => a.code === "plan_stall");
    assert.ok(stall, "必须报停滞");
    assert.equal(stall.level, "error");
    assert.match(stall.message, /无任何进展/);
  });

  it("事件流更新的时间也算进展（stall 判定不只看 plan 心跳）", () => {
    writeEvents([{ event: "step_retry", step_id: "2", ts: "2026-11-16T11:58:00Z" }]);
    const stats = readExecStats(gooDir);
    const plan = planWith(
      [
        { id: 1, name: "a", status: "completed", completed_at: "2026-11-16T11:00:00Z" },
        { id: 2, name: "b", status: "pending" },
      ],
      { started_at: "2026-11-16T10:00:00Z" },
    );
    assert.equal(lastActivityMs(plan, stats), Date.parse("2026-11-16T11:58:00Z"));
    const alerts = evaluatePlanAlerts({ plan, stats, now: NOW });
    assert.equal(alerts.filter((a) => a.code === "plan_stall").length, 0);
  });

  it("连续重试 → consecutive_retry（重试通道自己坏了）", () => {
    const alerts = evaluatePlanAlerts({
      plan: planWith([{ id: 3, name: "flaky", status: "failed", retry_count: 2, error: "boom" }]),
      now: NOW,
      thresholds: { maxRetries: 1 },
    });
    const retry = alerts.find((a) => a.code === "consecutive_retry");
    assert.ok(retry);
    assert.match(retry.message, /已重试 2 次/);
  });

  it("failed / interrupted 都会产生告警（失败的可见性）", () => {
    const alerts = evaluatePlanAlerts({
      plan: planWith([
        { id: 1, name: "f", status: "failed", error: "boom" },
        { id: 2, name: "i", status: "interrupted", error: "signal" },
      ]),
      now: NOW,
    });
    assert.ok(alerts.some((a) => a.code === "step_failed"));
    assert.ok(alerts.some((a) => a.code === "step_interrupted"));
  });

  it("plan 已派发步骤但事件流为空 → metrics_missing（指标链路自检）", () => {
    const alerts = evaluatePlanAlerts({
      plan: planWith([{ id: 1, name: "a", status: "running", started_at: "2026-11-16T11:59:00Z", heartbeat_at: "2026-11-16T11:59:00Z" }]),
      stats: readExecStats(gooDir),
      now: NOW,
    });
    assert.ok(alerts.some((a) => a.code === "metrics_missing"));
  });

  it("全部完成的 plan 不再报执行告警（已完成的历史不是当前风险）", () => {
    const alerts = evaluatePlanAlerts({
      plan: planWith(
        [{ id: 1, name: "a", status: "completed", completed_at: "2026-11-16T11:00:00Z" }],
        { status: "completed" },
      ),
      now: NOW,
    });
    assert.deepEqual(alerts, []);
  });

  it("plan 结构异常（steps 非数组/空）不抛异常", () => {
    assert.deepEqual(evaluatePlanAlerts({ plan: null, now: NOW }), []);
    assert.deepEqual(evaluatePlanAlerts({ plan: { steps: [] } as any, now: NOW }), []);
    assert.deepEqual(evaluatePlanAlerts({ plan: { steps: [{}] } as any, now: NOW }).filter((a) => a.code === "plan_stall"), []);
  });
});

describe("告警投递", () => {
  const alert = (key: string, code: ExecAlert["code"] = "plan_stall"): ExecAlert => ({
    level: "error",
    code,
    key,
    message: `msg-${key}`,
  });

  function ctxSpy() {
    const calls: Array<{ message: string; level?: string }> = [];
    return {
      calls,
      ctx: { ui: { notify: (message: string, level?: string) => calls.push({ message, level }) } },
    };
  }

  it("同一 key 在冷却窗口内不重复打扰，窗口过后再通知", () => {
    const state = createAlertState(15 * 60 * 1000);
    const { ctx, calls } = ctxSpy();
    const first = deliverAlerts(ctx, [alert("plan_stall")], state, { now: NOW });
    assert.equal(first.delivered.length, 1);
    assert.equal(calls.length, 1);

    const second = deliverAlerts(ctx, [alert("plan_stall")], state, { now: NOW + 60_000 });
    assert.equal(second.delivered.length, 0);
    assert.equal(second.suppressed, 1);

    const third = deliverAlerts(ctx, [alert("plan_stall")], state, { now: NOW + 16 * 60_000 });
    assert.equal(third.delivered.length, 1);
    assert.equal(calls.length, 2);

    // 单会话次数上限（默认 2）：挂了几天没人的僵尸 plan 不能变成永动机
    const fourth = deliverAlerts(ctx, [alert("plan_stall")], state, { now: NOW + 40 * 60_000 });
    assert.equal(fourth.delivered.length, 0);
    assert.equal(calls.length, 2);
  });

  it("僵尸 plan 不会永远重复告警（maxPerKey 可配置）", () => {
    const state = createAlertState(1, 1); // 冷却 1ms、上限 1 次
    const { ctx, calls } = ctxSpy();
    deliverAlerts(ctx, [alert("plan_stall")], state, { now: NOW });
    deliverAlerts(ctx, [alert("plan_stall")], state, { now: NOW + 1000 });
    assert.equal(calls.length, 1);
  });

  it("单次最多通知 3 条（避免一次刷屏）", () => {
    const state = createAlertState();
    const { ctx, calls } = ctxSpy();
    const alerts = [alert("a", "step_timeout"), alert("b", "step_failed"), alert("c", "step_interrupted"), alert("d", "plan_stall")];
    const result = deliverAlerts(ctx, alerts, state, { now: NOW });
    assert.equal(result.delivered.length, 3);
    assert.equal(result.suppressed, 1);
    assert.equal(calls.length, 3);
  });

  it("notify 抛异常不影响其它告警投递（告警通道坏了不能反过来搞坏执行）", () => {
    const state = createAlertState();
    const ctx = {
      ui: {
        notify: () => {
          throw new Error("tui died");
        },
      },
    };
    const result = deliverAlerts(ctx, [alert("a", "plan_stall"), alert("b", "step_failed")], state, { now: NOW });
    assert.equal(result.delivered.length, 2);
  });

  it("webhook 默认关闭：没有 url 时不发请求", async () => {
    let called = 0;
    const fetchImpl = async () => {
      called += 1;
      return {};
    };
    const state = createAlertState();
    await deliverAlerts(ctxSpy().ctx, [alert("x")], state, { now: NOW, fetchImpl });
    assert.equal(called, 0);

    await deliverAlerts(ctxSpy().ctx, [alert("x2")], createAlertState(), {
      now: NOW,
      fetchImpl,
      webhookUrl: "https://example.invalid/hook",
    });
    assert.equal(called, 1, "显式配置 url 后才发送");
  });

  it("webhook 失败静默（不抛、不影响 notify）", async () => {
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    const ok = await postWebhook("https://example.invalid/hook", [{ ...alert("x"), message: "m" }], fetchImpl, 50);
    assert.equal(ok, false);
  });

  it("webhook 负载包含 level/code/step_id（便于外部告警路由）", async () => {
    let body: any = null;
    const fetchImpl = async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return {};
    };
    const ok = await postWebhook(
      "https://example.invalid/hook",
      [{ level: "error", code: "step_timeout", key: "k", message: "m", stepId: 2 }],
      fetchImpl,
      100,
    );
    assert.equal(ok, true);
    assert.equal(body.kind, "dag_alert");
    assert.equal(body.alerts[0].code, "step_timeout");
    assert.equal(body.alerts[0].step_id, 2);
  });
});

describe("thresholdsFromConfig", () => {
  it("合法值覆盖默认值，非法值忽略（配置写错不能让告警静默失效）", () => {
    const t = thresholdsFromConfig({ plan_stall_minutes: 5, step_timeout_minutes: 0 as any, max_retries: 3 });
    assert.equal(t.planStallMinutes, 5);
    assert.equal(t.stepTimeoutMinutes, DEFAULT_THRESHOLDS.stepTimeoutMinutes);
    assert.equal(t.maxRetries, 3);
    assert.deepEqual(thresholdsFromConfig(null), DEFAULT_THRESHOLDS);
  });
});

describe("formatHealthReport —— 一条命令回答四个问题", () => {
  function stats() {
    writeEvents([
      { event: "step_start", step_id: "1", step_name: "audit", thread: "tg-1" },
      { event: "step_timeout", step_id: "1", step_name: "audit", duration_ms: 1_800_000, error_class: "timeout", thread: "tg-1" },
      { event: "step_retry", step_id: "1", step_name: "audit", thread: "tg-1" },
      { event: "step_start", step_id: "2", step_name: "impl", thread: "tg-1" },
      { event: "step_fail", step_id: "2", step_name: "impl", duration_ms: 5_000, error_class: "auth", error: "401 unauthorized", thread: "tg-1" },
    ]);
    return readExecStats(gooDir);
  }

  it("包含耗时分布 / 最容易超时的 step / 失败聚类 / 重试统计", () => {
    const report = formatHealthReport({
      plan: planWith([{ id: 1, name: "audit", status: "interrupted" }]),
      stats: stats(),
      now: NOW,
    });
    assert.match(report, /DAG 健康报告/);
    assert.match(report, /耗时分布/);
    assert.match(report, /最容易超时的 step/);
    assert.match(report, /#1/);
    assert.match(report, /失败原因聚类/);
    assert.match(report, /auth/);
    assert.match(report, /重试事件 1 次/);
    assert.match(report, /平均每步 1/);
  });

  it("指标缺失时明确说「统计不可信」，而不是假装 0 就是健康", () => {
    const report = formatHealthReport({ plan: planWith([{ id: 1, name: "a", status: "pending" }]), stats: readExecStats(gooDir), now: NOW });
    assert.match(report, /读不到事件文件|没有耗时样本/);
  });
});

describe("handleGooHealth（/goo-health 的 handler）", () => {
  async function runHealth(args: string) {
    const root = mkdtempSync(join(tmpdir(), "goo-health-"));
    mkdirSync(join(root, ".goo", "logs"), { recursive: true });
    writeEvents(
      [
        { event: "step_start", step_id: "1", step_name: "audit", thread: "tg-x" },
        {
          event: "step_timeout", step_id: "1", step_name: "audit", duration_ms: 600_000,
          exit_code: 143, error_class: "timeout", error: "wrapper 中断（超时）", thread: "tg-x",
        },
      ],
      join(root, ".goo"),
    );
    writeFileSync(
      join(root, ".goo", "plan.json"),
      JSON.stringify({
        schema_version: 3,
        task: "health",
        status: "running",
        thread: { id: "tg-x" },
        steps: [{ id: 1, name: "audit", status: "interrupted", retry_count: 1 }],
      }),
      "utf-8",
    );
    const notes: string[] = [];
    const ctx: any = { cwd: root, ui: { notify: (m: string) => notes.push(m) } };
    const { handleGooHealth } = await import("../commands/health.js");
    await handleGooHealth(args, ctx);
    return notes;
  }

  it("人类可读报告包含标题并回答问题", async () => {
    const notes = await runHealth("");
    assert.equal(notes.length, 1);
    assert.match(notes[0], /DAG 健康报告/);
    assert.match(notes[0], /超时/);
    assert.match(notes[0], /重试/);
  });

  it("--json 必须是**合法** JSON（截断字符串会变成半截 JSON）", async () => {
    const notes = await runHealth("--json");
    assert.equal(notes.length, 1);
    const parsed = JSON.parse(notes[0]);
    assert.ok(parsed.stats.total >= 2);
    assert.ok(Array.isArray(parsed.alerts));
    assert.equal(parsed.plan.thread, "tg-x");
    // 紧凑投影：不把全部原始事件塞进通知，但聚合结论必须齐全
    assert.ok(parsed.stats.timeoutProne.length >= 1);
    assert.ok(parsed.stats.retries);
  });
});

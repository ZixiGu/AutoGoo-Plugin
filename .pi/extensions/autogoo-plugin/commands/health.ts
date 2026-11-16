/**
 * `/auto-goo:goo-health` —— 一条命令输出「本次 DAG 健康报告」。
 *
 * 存在的理由：执行指标（`exec.jsonl`）和阈值告警都需要一个**随时能问一句**的
 * 入口，否则又变成「数据采了但没人看」。这个命令只读，不改 plan、不写 thread，
 * 也不触发任何调度 —— 它是观察，不是操作。
 *
 * 回答四个具体问题（不是又打印一堆数字）：
 *   1. 现在卡住了吗？        → 告警 + 停滞时长
 *   2. 哪些 step 最耗时间？  → 耗时分布 + 最慢 top3
 *   3. 哪些 step 最容易超时？→ 超时/中断排行
 *   4. 平均重试几次？        → 重试统计 + 失败聚类
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { projectPlanPath, loadProjectConfig } from "../utils/paths.js";
import {
  evaluatePlanAlerts,
  formatHealthReport,
  observabilityOf,
  readExecStats,
  thresholdsFromConfig,
  type PlanLike,
} from "../utils/exec-observe.js";
import { logWarn } from "../utils/log.js";
import { join } from "node:path";

function readPlan(planPath: string): PlanLike | null {
  try {
    if (!existsSync(planPath)) return null;
    return JSON.parse(readFileSync(planPath, "utf-8")) as PlanLike;
  } catch {
    return null;
  }
}

export async function handleGooHealth(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  const planPath = projectPlanPath(cwd);
  const plan = readPlan(planPath);
  if (!plan) {
    ctx.ui.notify(`未找到可读的 plan：${planPath}`, "warning");
    return;
  }

  const gooDir = join(cwd, ".goo");
  // 指标读取/聚合失败不阻塞报告：readExecStats 内部已降级为 ok:false 的零值。
  const stats = readExecStats(gooDir);
  const config = observabilityOf(await loadProjectConfig(cwd).catch(() => null));
  const thresholds = thresholdsFromConfig(config ?? null);
  const alerts = evaluatePlanAlerts({ plan, stats, thresholds });

  if (args.includes("--json")) {
    // 机器可读输出必须是**合法 JSON**：早期版本直接 slice 字符串，截断后
    // 就成了无法解析的半截 JSON（实测 SyntaxError）。"不臃肿"应该靠投影字段，
    // 而不是靠把字符串剪断。
    const compactStats = {
      ok: stats.ok,
      path: stats.path,
      total: stats.total,
      corruptLines: stats.corruptLines,
      byEvent: stats.byEvent,
      fromTs: stats.fromTs ?? null,
      toTs: stats.toTs ?? null,
      durations: stats.durations,
      slowest: stats.slowest,
      timeoutProne: stats.timeoutProne,
      failures: stats.failures,
      retries: stats.retries,
      alertsDelivered: stats.alertsDelivered,
    };
    const payload = {
      plan: {
        status: plan.status ?? null,
        task: plan.task ?? null,
        thread: plan.thread?.id ?? null,
        steps: plan.steps?.length ?? 0,
      },
      stats: compactStats,
      alerts,
      exec_log: stats.path,
      ok: stats.ok,
    };
    ctx.ui.notify(JSON.stringify(payload, null, 2), "info");
    return;
  }

  const report = formatHealthReport({ plan, stats, alerts, planPath, thresholds });
  const hasError = alerts.some((a) => a.level === "error");
  try {
    ctx.ui.notify(report, hasError ? "error" : alerts.length > 0 ? "warning" : "info");
  } catch (e: any) {
    logWarn("[AutoGoo-Plugin] 健康报告渲染失败:", e?.message ?? String(e));
    ctx.ui.notify(`DAG 健康报告生成失败: ${e?.message ?? String(e)}`, "error");
  }
}

/**
 * goo-status / goo-observe 命令 —— 统一观察面板。
 *
 * 从 commands/start.ts 拆出（原文件 861 行）。纯机械搬运，行为不变：
 * `/goo-status` 落在 steps tab，`/goo-observe` 落在 env tab，共用 ObservePanel。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readRecallStats } from "../utils/recall-observe.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execPython } from "../utils/exec.js";
import { GOO_STATUS_PY, GOO_OBSERVE_PY, projectPlanPath } from "../utils/paths.js";
import { guardRender } from "../utils/tui-kit.js";
import {
  ObservePanel,
  type ObserveAction,
  type ObserveSnapshot,
  type ObserveStep,
} from "../utils/observe-panel.js";

// ── goo-status handler ──────────────────────────────────────────────────────

export async function handleGooStatus(args: string, ctx: ExtensionContext): Promise<void> {
  await openObservePanel(ctx, "steps");
}

/**
 * 统一观察面板。`/goo-status` 默认落在 Steps，`/goo-observe` 默认落在 Env。
 * 合并前两者是两套呈现（status 打印方框与 slots；observe 打印路径与 running
 * 明细），信息被劈成两半 —— 这正是"混乱"的来源。
 */
export async function openObservePanel(
  ctx: ExtensionContext,
  initialTab: "steps" | "overview" | "env" | "shell",
): Promise<void> {
  const cwd = ctx.cwd;

  if (ctx.mode !== "tui" || !ctx.hasUI) {
    await showStatus(cwd, ctx);
    return;
  }

  const snapshot = (): ObserveSnapshot | null => {
    // 步骤全量来自 plan；环境/路径/shell 来自 goo-observe.py --json
    const planPath = projectPlanPath(cwd);
    let plan: any = null;
    try {
      plan = JSON.parse(readFileSync(planPath, "utf-8"));
    } catch {
      return null;
    }
    const steps: ObserveStep[] = (plan?.steps ?? []).map((s: any) => ({
      id: s.id,
      name: String(s.name ?? ""),
      status: String(s.status ?? "pending"),
      progress: Number(s.progress ?? 0),
      heartbeat_at: s.heartbeat_at ?? null,
      agent_id: s.agent_id ?? null,
      error: s.error ?? null,
      log_path: s.log_path ?? null,
      subagent: s.subagent ?? null,
      task_agent: s.task_agent ?? null,
    }));

    let env: any = {};
    try {
      const r = execPython(GOO_OBSERVE_PY, ["--json"], cwd, { timeout: 20000 });
      if (r.exitCode === 0) env = JSON.parse(r.stdout || "{}");
    } catch {
      /* 环境信息失败不影响步骤视图 */
    }

    return {
      root: env.root ?? cwd,
      threadId: plan?.thread?.id ?? env.current_thread?.thread_id ?? null,
      planPath: env.plan_path ?? planPath,
      logsDir: env.logs_dir ?? "",
      shellLogDir: env.shell_log_dir ?? "",
      claudeVersion: env.claude_version ?? "",
      planStatus: String(plan?.status ?? "pending"),
      task: String(plan?.task ?? ""),
      steps,
      shellLogs: Array.isArray(env.shell_logs) ? env.shell_logs : [],
      commands: env.commands ?? {},
      // 召回观测：读 .goo/logs/recall.jsonl 汇总。
      // 召回坏了是**静默降级**（任务照样跑完，只是用不上 wiki 经验），
      // 所以必须有一个地方能直接看到失败次数。
      recall: readRecallStats(join(cwd, ".goo")),
    };
  };

  const first = snapshot();
  if (!first) {
    ctx.ui.notify(`未找到可读的 plan：${projectPlanPath(cwd)}`, "warning");
    return;
  }

  const loadLog = (step: ObserveStep): string[] => {
    if (!step.log_path) return [];
    for (const candidate of [step.log_path, join(cwd, step.log_path)]) {
      try {
        return readFileSync(candidate, "utf-8").split("\n").filter((l) => l.trim()).slice(-40);
      } catch {
        /* 尝试下一个候选路径 */
      }
    }
    return [];
  };

  try {
    await ctx.ui.custom<ObserveAction>((tui, theme, keybindings, done) => {
      return guardRender(
        new ObservePanel(
          first,
          initialTab,
          theme,
          done,
          () => {
            try {
              tui.requestRender();
            } catch {
              /* 渲染失败不阻塞 */
            }
          },
          loadLog,
          snapshot,
          keybindings,
        ),
        theme,
        "ObservePanel",
      );
    });
  } catch (e: any) {
    ctx.ui.notify(`观察面板异常：${e?.message ?? String(e)}`, "error");
  }
}

async function showStatus(cwd: string, ctx: ExtensionContext): Promise<void> {
  if (!existsSync(GOO_STATUS_PY)) {
    ctx.ui.notify("goo-status.py 未找到", "error");
    return;
  }

  try {
    const result = execPython(GOO_STATUS_PY, ["--plan", projectPlanPath(cwd)], cwd);
    ctx.ui.notify((result.stdout || "状态加载中...").slice(0, 500), "info");
    if (result.stderr) ctx.ui.notify(result.stderr.slice(0, 200), "warning");
  } catch (err: any) {
    ctx.ui.notify(`状态查询失败: ${err.message}`, "error");
  }
}

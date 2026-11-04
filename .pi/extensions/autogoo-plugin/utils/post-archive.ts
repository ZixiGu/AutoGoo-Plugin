/**
 * 归档后任务总结报告 —— 补齐 SKILL.md 要求但 pi 版缺失的环节。
 *
 * `SKILL.md:479` 明确要求：
 *   「最终任务归档验收通过后，主 Agent **必须**立刻复用 `id=post_archive_html_report`
 *     模板询问是否生成并启动任务总结报告。」
 * `references/obsidian-archive.md:206` 还把它列为归档验收条件之一。
 *
 * 但 `TEMPLATE_POST_ARCHIVE_HTML_REPORT` 定义了之后**零引用** —— 规范写了，代码没做。
 * 这里补上：归档 step 完成、且 plan 无剩余步骤时触发一次询问。
 *
 * 边界：
 *   - 询问走 utils/ui.ts 封装（§10 禁止裸 ctx.ui 调用）；
 *   - onTimeout=cancel（超时不自动生成，避免无人工确认就产出文件）；
 *   - 报告是**任务级** `reports/final-report.md`，不是项目级 `.goo/site/` 站点；
 *   - 每个 thread 只问一次（在 plan 上打标记），避免重复打扰。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_POST_ARCHIVE_HTML_REPORT } from "../constants.js";
import { uiSelect } from "./ui.js";
import { logWarn } from "./log.js";

export interface PostArchiveOptions {
  cwd: string;
  /** 已完成的归档 step id（用于写报告） */
  archiveStepId: string | number;
  plan: any;
}

function planFingerprint(plan: any): string {
  return `${plan?.thread?.id ?? "?"}@${plan?.updated_at ?? plan?.created_at ?? "?"}`;
}

function alreadyAsked(plan: any): boolean {
  return Boolean(plan?.runtime?.post_archive_report?.asked_at);
}

/** 在 plan 上记录"已询问过"，避免同一 thread 反复打扰。 */
function markPostArchiveAsked(plan: any, decision: "generated" | "skipped"): void {
  if (!plan || typeof plan !== "object") return;
  plan.runtime = plan.runtime && typeof plan.runtime === "object" ? plan.runtime : {};
  plan.runtime.post_archive_report = {
    asked_at: new Date().toISOString(),
    decision,
    fingerprint: planFingerprint(plan),
  };
}

function renderReport(plan: any, archiveStepId: string | number): string {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const done = steps.filter((s: any) => s.status === "completed");
  const failed = steps.filter((s: any) => s.status === "failed");
  const blocked = steps.filter((s: any) => s.status === "blocked");
  const lines: string[] = [];

  lines.push(`# ${plan?.task ?? "任务总结报告"}`);
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- thread：${plan?.thread?.id ?? "-"}`);
  lines.push(`- 归档 step：#${archiveStepId}`);
  lines.push(`- 计划状态：${plan?.status ?? "-"}`);
  lines.push("");

  lines.push("## 执行摘要");
  lines.push("");
  lines.push(`共 ${steps.length} 步：完成 ${done.length}、失败 ${failed.length}、阻塞 ${blocked.length}。`);
  lines.push("");

  lines.push("## 步骤与产物");
  lines.push("");
  lines.push("| # | 步骤 | 状态 | 产物 |");
  lines.push("| --- | --- | --- | --- |");
  for (const step of steps) {
    const out = Array.isArray(step.outputs) && step.outputs.length > 0
      ? step.outputs.join(", ")
      : (step.output ?? "-");
    lines.push(`| ${step.id} | ${String(step.name ?? "").replace(/\|/g, "\\|")} | ${step.status ?? "-"} | ${out} |`);
  }
  lines.push("");

  if (failed.length > 0 || blocked.length > 0) {
    lines.push("## 风险与限制");
    lines.push("");
    for (const step of [...failed, ...blocked]) {
      lines.push(`- #${step.id} ${step.name}：${step.status}${step.error ? ` — ${step.error}` : ""}`);
    }
    lines.push("");
  }

  lines.push("## 归档");
  lines.push("");
  lines.push(`- Goo-wiki 项目入口：${plan?.archive?.task_archive_root ?? "（见 Goo-wiki 项目页）"}`);
  lines.push(`- 计划文件：${plan?.thread?.plan_path ?? ".goo/plan.json"}`);
  lines.push(`- 执行日志：${plan?.thread?.logs_dir ?? ".goo/logs"}`);
  lines.push("");

  lines.push("## 后续建议");
  lines.push("");
  lines.push("- 复核上表中的产物路径与验证结论；");
  lines.push("- 如有失败/阻塞步骤，按 error 字段逐条处理；");
  lines.push("- 把可复用结论补进 Goo-wiki lessons 页。");
  lines.push("");
  return lines.join("\n");
}

/**
 * 归档 step 完成后询问是否生成任务总结报告。
 * 返回 true 表示已生成（或用户选择跳过），false 表示未触发。
 */
export async function maybePromptPostArchiveReport(
  ctx: ExtensionContext,
  opts: PostArchiveOptions,
): Promise<boolean> {
  const { cwd, plan, archiveStepId } = opts;
  if (alreadyAsked(plan)) return false;

  let choice: string | null = null;
  try {
    choice = await uiSelect(
      ctx,
      TEMPLATE_POST_ARCHIVE_HTML_REPORT.header,
      TEMPLATE_POST_ARCHIVE_HTML_REPORT.options,
      // 超时/无 UI 一律不生成 —— 产出文件必须有人确认
      { onTimeout: "cancel" },
    );
  } catch (e) {
    logWarn("[AutoGoo-Plugin] post-archive prompt failed:", e);
    return false;
  }

  if (choice !== "yes") {
    markPostArchiveAsked(plan, "skipped");
    ctx.ui.notify("已跳过任务总结报告。", "info");
    return true;
  }

  try {
    const threadReports = plan?.thread?.id
      ? join(cwd, ".goo", "threads", String(plan.thread.id), "reports")
      : join(cwd, ".goo", "reports");
    if (!existsSync(threadReports)) mkdirSync(threadReports, { recursive: true });
    const target = join(threadReports, "final-report.md");
    writeFileSync(target, renderReport(plan, archiveStepId), "utf-8");
    markPostArchiveAsked(plan, "generated");
    ctx.ui.notify(
      `✅ 任务总结报告已生成：${target}\n` +
        `（任务级报告，不是 .goo/site/ 工作流站点）`,
      "info",
    );
    return true;
  } catch (e: any) {
    logWarn("[AutoGoo-Plugin] write final-report failed:", e);
    ctx.ui.notify(`生成报告失败：${e?.message ?? String(e)}`, "error");
    return false;
  }
}

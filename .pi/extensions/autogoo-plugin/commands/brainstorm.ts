/**
 * AutoGoo-Plugin goo-brainstorm — 候选目标生成
 *
 * 当用户目标不明确时，基于 Goo-wiki 和项目上下文
 * 生成 5-9 个候选目标，合并为 3-7 个最终候选，
 * 写入 .goo/brainstorm.json 等待用户选择。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPi } from "../utils/pi-state.js";
import { recallWiki } from "../utils/wiki-recall.js";
import { execShell } from "../utils/exec.js";
import {
  loadPlan,
  savePlan,
  archiveOldPlan,
  getCurrentThreadId,
  setCurrentThreadId,
  generateThreadId,
  generateTimestamp,
  type Plan,
} from "../utils/plan.js";
import {
  REPO_ROOT,
  projectBrainstormPath,
  projectPlanPath,
  resolveWikiDir,
} from "../utils/paths.js";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir, readFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function handleGooBrainstorm(direction: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;

  if (!direction?.trim()) {
    ctx.ui.notify("请输入头脑风暴的方向、项目或问题。例如：/auto-goo:goo-brainstorm 项目优化方向", "warning");
    return;
  }

  // 1. Wiki recall
  ctx.ui.notify("正在检索 Goo-wiki 项目经验和上下文...", "info");
  const wikiContext = await recallWikiContext(cwd, direction);

  // 2. Present to user — the LLM handles the actual brainstorm generation
  ctx.ui.notify(`头脑风暴方向: ${direction}`, "info");

  // 3. Set up editor with brainstorm prompt
  const wikiSummary = wikiContext.sources.length > 0
    ? `\n\n## 相关 Wiki 上下文\n${wikiContext.sources.map((s: string) => `- ${s}`).join("\n")}\n\n${wikiContext.knowledge.map((k: string) => `- ${k}`).join("\n")}`
    : "";

  // 直接发给 agent（不是塞进输入框）——用户选了方向就该立刻开始头脑风暴，
  // 之前用 setEditorText 需要用户再按一次 Enter 才发送，像"卡住了"。
  const pi = getPi();
  const prompt =
    `## AutoGoo-Plugin Brainstorm: ${direction}\n` +
    `\n请基于以下方向进行头脑风暴，生成候选目标列表：\n\n` +
    `**方向**: ${direction}\n` +
    `${wikiSummary}\n\n` +
    `### 要求\n` +
    `1. 先生成 5-9 个初始候选方向，覆盖快速交付、长期架构、风险/债务、评测验证、文档知识、自动化工具化、用户体验流程改进、低成本试探\n` +
    `2. 合并去重为 3-7 个最终候选\n` +
    `3. 每个候选包含：id、name、why（为什么值得做）、expected_output（交付物）、acceptance_criteria（验收标准）、risk（风险）、prerequisites（前置条件）、first_step（第一步动作）\n` +
    `4. 输出为 JSON 格式，写入 .goo/brainstorm.json\n` +
    `5. 在聊天中向用户展示候选列表，等待用户选择后再进入 goo-plan 阶段`;
  if (pi) {
    pi.sendUserMessage(prompt);
    ctx.ui.notify("已发送头脑风暴请求", "success");
  } else {
    // 拿不到 pi 实例时降级（例如非交互上下文）
    ctx.ui.setEditorText(prompt);
  }
}

// ── Wiki recall helper ──────────────────────────────────────────────────────
// 统一走 utils/wiki-recall.ts。
//
// 历史教训：这里曾经**根本没调用脚本**，而是 readdir(wiki/projects) 把整个
// 目录列表当作 sources 返回（42 个项目 = 42 条"召回结果"），
// 相关性匹配用 content.includes(整个方向字符串)，几乎永不命中。
// 用户看到的一长串 `wiki/projects/xxx/` 就是这个假召回的输出。
async function recallWikiContext(
  cwd: string,
  direction: string,
): Promise<{ sources: string[]; knowledge: string[] }> {
  const result = await recallWiki(cwd, direction);
  return {
    sources: result.hits.map((h) => h.path),
    knowledge: result.hits.map((h) => `${h.title}${h.headings.length ? `（${h.headings[0]}）` : ""}`),
  };
}

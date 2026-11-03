/**
 * AutoGoo-Plugin 派发共享逻辑 — start.ts（auto_goo_dispatch）与
 * execute.ts（runSchedule）两条派发路径共用的：
 *   - project slug 解析（config archive.project_slug，fallback basename(cwd)）
 *   - wiki graph packet 生成（wiki-graph-assist.py，失败 fallback 不阻塞）
 *   - Subagent 任务 prompt 组装（wiki_paths glob + packet 引用 + 执行要求）
 *   - 保活心跳（只 --heartbeat --note，不覆盖 Subagent progress；非 running 跳过）
 *
 * 保证两条派发路径行为一致：wiki 召回、packet 引用、心跳语义相同。
 */

import { basename, join } from "node:path";
import { logWarn } from "./log.js";
import { writeFile, mkdir } from "node:fs/promises";
import { execPython } from "./exec.js";
import { loadPlan, buildDispatchPacket, type DispatchPacket } from "./plan.js";
import { UPDATE_STEP_PY, WIKI_GRAPH_ASSIST_PY, loadProjectConfig, resolveWikiDir } from "./paths.js";

// ── Project slug ────────────────────────────────────────────────────────────

/**
 * 解析项目 slug：优先 config archive.project_slug（如 autogoo-plugin），
 * fallback 到 basename(cwd)（如 AutoGoo）。wiki_paths 的 {slug} 占位符
 * 与 wiki-graph-assist.py --project-slug 必须用同一个值，否则 glob 匹配
 * 不到真实 wiki/projects/{slug}/ 目录（P1）。
 */
export async function resolveProjectSlug(cwd: string): Promise<string> {
  try {
    const config = await loadProjectConfig(cwd);
    const slug = config?.archive?.project_slug?.trim();
    if (slug) return slug;
  } catch {
    /* 配置损坏时 fallback */
  }
  return basename(cwd) || "autogoo-plugin";
}

// ── Wiki graph packet ───────────────────────────────────────────────────────

export interface WikiPacketResult {
  packet: DispatchPacket;
  packetGenerated: boolean;
}

/**
 * 为 step 生成紧凑 wiki graph packet（调用 wiki-graph-assist.py 并落盘）。
 * 失败不阻塞：返回 packetGenerated=false，调用方 fallback 到按 wiki_paths
 * glob 自行 Read。遵守 < 30s 超时 / < 20k 字符预算双重约束。
 */
export async function generateWikiPacket(
  cwd: string,
  step: { id: number | string; type?: string; wiki_paths?: string[]; memory_layer?: string },
  query: string,
  threadId: string,
): Promise<WikiPacketResult> {
  const slug = await resolveProjectSlug(cwd);
  const packet = buildDispatchPacket(step, slug, threadId);
  let packetGenerated = false;
  try {
    const wikiDir = await resolveWikiDir(cwd);
    const searchPathArgs = packet.wiki_paths.flatMap((p: string) => ["--search-path", p]);
    const r = execPython(
      WIKI_GRAPH_ASSIST_PY,
      [
        "--wiki-dir", wikiDir,
        "--project-slug", slug,
        "--query", query,
        "--title", `step-${step.id}-dispatch`,
        ...searchPathArgs,
        "--max-pages", "12",
        "--format", "md",
      ],
      cwd,
      { timeout: 30000 },
    );
    if (r.exitCode === 0 && r.stdout) {
      const fullPath = join(cwd, packet.wiki_graph_packet_path);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, r.stdout);
      packetGenerated = true;
    } else {
      logWarn(`[AutoGoo-Plugin] wiki-graph-assist.py 失败 (exit=${r.exitCode}): ${(r.stderr || "").slice(0, 200)}`);
    }
  } catch (e: any) {
    logWarn(`[AutoGoo-Plugin] wiki-graph-assist.py 异常: ${(e?.message ?? String(e)).slice(0, 200)}`);
  }
  return { packet, packetGenerated };
}

// ── Subagent task prompt 组装 ───────────────────────────────────────────────

export interface SubagentPromptOptions {
  role: string;
  /** 步骤任务描述（dispatch 的 task / runSchedule 的 step.description） */
  task: string;
  wiki_paths: string[];
  wiki_graph_packet_path: string;
  packetGenerated: boolean;
  memory_layer?: string;
  /** 角色提示（start.ts auto_goo_dispatch 注入） */
  rolePrompt?: string;
  /** 任务 agent 提示（start.ts auto_goo_dispatch 注入） */
  taskPrompt?: string;
  /** Step 契约行（execute.ts runSchedule 注入） */
  stepContract?: string[];
}

/** 组装 Subagent 任务 prompt：wiki_paths glob + graph packet 引用 + 执行要求。 */
export function buildSubagentTaskPrompt(o: SubagentPromptOptions): string {
  const sections: string[] = [
    `## AutoGoo-Plugin Subagent: ${o.role}`,
    o.rolePrompt || "",
    o.taskPrompt ? `\n${o.taskPrompt}\n` : "",
    `## 任务`,
    o.task,
  ];
  if (o.stepContract && o.stepContract.length > 0) {
    sections.push(`## Step 契约`, ...o.stepContract);
  }
  sections.push(
    `## 按需读取 wiki(对齐 SKILL.md "按需调用原则")`,
    `- 本 step 的 wiki_paths glob(只读这些,不要"读全部 wiki"):`,
    `  ${o.wiki_paths.join("\n  ")}`,
    o.packetGenerated
      ? `- 紧凑 graph packet 已生成在 ${o.wiki_graph_packet_path};优先 Read 它代替自行 grep/glob 全量扫描`
      : `- ⚠️ graph packet 生成失败(超时或 wiki-graph-assist.py 错误),fallback 到按 wiki_paths glob 自行 Read(遵守字符预算 < 20k)`,
    `- 单次 Read/Grep 受字符预算 (< 20k) + 超时 (< 30s) 双重约束;超出时用 Read + limit/offset 或 Grep -n`,
    `- memory_layer 默认 ${o.memory_layer || "L2"};L0 原始日志、L3 项目画像只按 step 显式需要才读`,
    `- 跨 step 引用用 [[Wikilink]] 按需点开;不要 Read 整篇 wiki 笔记`,
    ``,
    `## 执行要求`,
    `1. 第一件事：调用 auto_goo_update_step --heartbeat --progress 15 --note "已开工"`,
    `2. 每完成一个里程碑调用 auto_goo_update_step --heartbeat 更新进度`,
    `3. 完成后调用 auto_goo_update_step --complete`,
    `4. 失败时调用 auto_goo_update_step --fail --error "<原因>"`,
    `5. 在 step log 中记录关键决策、产物路径和验证结果`,
    `6. 不要扩大范围：只完成当前步骤的任务`,
  );
  return sections.filter(Boolean).join("\n");
}

// ── 保活心跳 ────────────────────────────────────────────────────────────────

/**
 * Subagent 运行期间的保活心跳（P2/P16）。
 * - 只传 --heartbeat --note，**不传 --progress**：避免把 Subagent 已更新的
 *   progress（如 60）覆盖回 0。
 * - 写前 loadPlan 检查 step.status === 'running'：completed/failed/blocked
 *   后直接跳过，防止已完成步骤被继续保活覆盖状态。
 */
export async function heartbeatTick(
  cwd: string,
  planPath: string,
  stepId: number | string, // C4：支持数字/字符串 id（历史 plan 字符串 id 如 "s1"）
  agentId: string,
  note?: string,
): Promise<void> {
  try {
    const plan = await loadPlan(cwd, planPath);
    const step = plan?.steps.find((s) => String(s.id) === String(stepId));
    if (!step || step.status !== "running") return;
    execPython(
      UPDATE_STEP_PY,
      ["--plan", planPath, "--step-id", String(stepId), "--heartbeat", "--note", note || `Subagent running (${agentId})`],
      cwd,
      { timeout: 10000 },
    );
  } catch {
    /* 心跳失败不阻塞 */
  }
}

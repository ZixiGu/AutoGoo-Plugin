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
import { existsSync, statSync } from "node:fs";
import { globSync } from "node:fs";
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

/** 单次 Read/Grep 的字符预算上限（与 SKILL.md「按需调用原则」一致）。 */
export const WIKI_READ_CHAR_BUDGET = 20_000;

/**
 * 探测 wiki_paths 展开后的实际体积。
 *
 * 为什么需要：`< 20k 字符预算` 原本只是 prompt 里的一句嘱咐，**没有任何
 * 运行时强制**。实测 autogoo-plugin 的一个 step，wiki_paths 指向的 12 篇
 * 页面合计 169KB —— 超预算 8.5 倍，而单篇 `autogoo-plugin.md` 就有 34KB。
 * 若 subagent 老老实实逐篇 Read，会一次吃掉 165KB 上下文。
 *
 * 这里只做**测量与标注**，不阻止读取（有些 step 确实需要读大文件，
 * 应该用 offset/limit 分段读，而不是一刀切禁止）。
 */
export interface WikiPathSizes {
  /** 展开后的文件数 */
  files: number;
  /** 合计字节数 */
  totalBytes: number;
  /** 超过预算的单文件（相对路径 -> 字节数），按大小降序 */
  oversized: Array<{ path: string; bytes: number }>;
}

/**
 * 展开 wiki_paths（支持 glob 与普通路径）并统计体积。
 *
 * ⚠ wiki_paths 是**相对 wiki 根目录**的（如 `wiki/projects/x.md`），
 * 不是相对 cwd。第一版按 cwd 拼接导致永远统计到 0 个文件 ——
 * 护栏「看起来装上了但什么都没测」。
 */
export async function measureWikiPaths(cwd: string, wikiPaths: string[]): Promise<WikiPathSizes> {
  const seen = new Set<string>();
  const sizes: Array<{ path: string; bytes: number }> = [];

  let wikiRoot = cwd;
  try {
    wikiRoot = await resolveWikiDir(cwd);
  } catch {
    /* 解析失败时退化为 cwd（至少能测到项目内路径） */
  }

  for (const pattern of wikiPaths) {
    const abs = pattern.startsWith("/")
      ? pattern
      : join(wikiRoot, pattern);
    let matched: string[] = [];
    try {
      if (/[*?[\]]/.test(pattern)) {
        matched = globSync(abs) as unknown as string[];
      } else if (existsSync(abs)) {
        matched = [abs];
      }
    } catch {
      /* glob 语法错误时忽略该项 */
    }
    for (const f of matched) {
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        const st = statSync(f);
        if (st.isFile()) sizes.push({ path: f.replace(`${wikiRoot}/`, ""), bytes: st.size });
      } catch {
        /* 不可读则跳过 */
      }
    }
  }

  const oversized = sizes
    .filter((s) => s.bytes > WIKI_READ_CHAR_BUDGET)
    .sort((a, b) => b.bytes - a.bytes);
  return {
    files: sizes.length,
    totalBytes: sizes.reduce((a, b) => a + b.bytes, 0),
    oversized,
  };
}

/**
 * 把 step 声明的 memory_layer 展开成「召回层集合」。
 *
 * 语义：**声明的层是下限，向抽象方向展开**。
 *
 * 为什么不硬过滤成单一层：`audit` 类 step 声明 L0（原始 trace），
 * 若只返回 L0 页面，subagent 会拿到一堆没有上下文的原始日志，
 * 反而更难完成任务。理解原始记录需要 L1/L2 的事实与场景，
 * 也需要 L3 的项目方向感。
 *
 * 反方向则必须截断：`exec` step 声明 L2，不应该被 L0 原始日志稀释
 * （那是噪音，不是上下文）。这正是这个字段应有的作用。
 *
 *   L0 → [L0, L1, L2, L3]   追溯原始记录，但需要全栈上下文
 *   L1 → [L1, L2, L3]       查具体事实，需要场景与画像
 *   L2 → [L2, L3]           默认：场景知识 + 项目画像
 *   L3 → [L3]               只要项目画像
 */
export function expandLayerRange(declared: string | undefined | null): string[] {
  const norm = (declared || "L2").toUpperCase();
  const order = ["L0", "L1", "L2", "L3"];
  const idx = order.indexOf(norm);
  if (idx < 0) return ["L2", "L3"]; // 非法值退化为默认
  return order.slice(idx);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

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
        // 按 step 声明的 memory_layer 过滤（声明的层是下限，向抽象层展开）。
        // 曾经这里完全没传 --layer —— memory_layer 算出来了却无人消费，
        // audit 与 review 类 step 拿到的 packet 内容一模一样。
        ...expandLayerRange(packet.memory_layer).flatMap((l) => ["--layer", l]),
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
  /** wiki_paths 展开后的体积（由 measureWikiPaths 计算） */
  wikiPathSizes?: WikiPathSizes;
}

/**
 * 把体积实测结果渲染成给 subagent 的**警告行**。
 *
 * 目的不是恐吓，而是让 subagent 有据可依地选择读法：
 * 超预算的文件必须分段读，而不是一次 Read 到底。
 */
function formatSizeWarning(s: WikiPathSizes): string[] {
  const lines: string[] = [];
  const ratio = s.totalBytes / WIKI_READ_CHAR_BUDGET;
  if (s.files === 0) return lines;
  if (ratio > 1) {
    lines.push(
      `- ⚠️ 实测体积：wiki_paths 展开共 ${s.files} 个文件 / ${humanBytes(s.totalBytes)}` +
        `（预算 ${WIKI_READ_CHAR_BUDGET / 1000}k 的 ${ratio.toFixed(1)} 倍）—— 不要全部通读`,
    );
  }
  if (s.oversized.length > 0) {
    lines.push(`- 以下文件单篇即超预算，必须用 offset/limit 分段读或先 Grep 定位:`);
    for (const f of s.oversized.slice(0, 6)) {
      lines.push(`    ${humanBytes(f.bytes)}  ${f.path}`);
    }
    if (s.oversized.length > 6) lines.push(`    …另有 ${s.oversized.length - 6} 个`);
  }
  return lines;
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
    `- 单次 Read/Grep 受字符预算 (< ${WIKI_READ_CHAR_BUDGET / 1000}k 字符) + 超时 (< 30s) 双重约束;超出时用 Read + limit/offset 或 Grep -n`,
    ...(o.wikiPathSizes ? formatSizeWarning(o.wikiPathSizes) : []),
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

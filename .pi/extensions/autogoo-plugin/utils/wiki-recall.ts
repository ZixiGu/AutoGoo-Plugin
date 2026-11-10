/**
 * Goo-wiki 召回 —— 唯一实现。
 *
 * 历史背景（为什么要有这个文件）
 * ------------------------------
 * 在抽出本模块之前，`/goo-plan` 和 `/goo-brainstorm` 各自实现了一套「召回」，
 * 而且**两套都是坏的**：
 *
 *  1. `commands/plan.ts` 调用 wiki-graph-assist.py 时传了 `--compact`，
 *     但脚本从来没有这个参数 → argparse 直接 exit 2 → stdout 为空 →
 *     解析出 0 条 → 静默返回 `found: false`。
 *     也就是说 `/goo-plan` 的 wiki 召回**从未成功过一次**，
 *     而 catch 块把它吞得干干净净，日志里连一行 warn 都没有。
 *
 *  2. `commands/brainstorm.ts` 干脆没调用脚本，而是 `readdir(wiki/projects)`
 *     把整个目录列表当作 `sources` 返回（42 个项目目录 = 42 条"召回结果"）。
 *     它的相关性匹配是 `content.includes(整个方向字符串)`，几乎永不命中。
 *
 * 脚本本身是好的：`--format json` 能按 score 排序返回精准的 suggested_links。
 * 问题纯粹在调用方。所以这里只做一件事：**用一个正确的调用方式，替换掉两份错误实现**。
 *
 * 设计约束
 * --------
 * - 失败必须可观测：不再静默吞错，统一走 logWarn。
 * - 结果必须有预算：召回内容会进入 subagent 上下文，必须有字符上限。
 * - 不做 IO 之外的副作用：本模块只读 wiki，不写任何东西。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { logWarn } from "./log.js";
import { execPython } from "./exec.js";
import { resolveWikiDir } from "./paths.js";
import { resolveProjectSlug } from "./dispatch.js";
import { REPO_ROOT } from "./paths.js";
import { logRecall, hashQuery } from "./recall-observe.js";

/** 单次召回的默认字符预算：超过则按 score 降序截断。 */
export const DEFAULT_RECALL_CHAR_BUDGET = 6000;

/** 低于该 score 的命中视为噪音（脚本 score 为整数，通常 20-60）。 */
export const DEFAULT_MIN_SCORE = 10;

export interface WikiHit {
  /** wiki 根目录下的相对路径，例如 wiki/projects/x/lessons/y.md */
  path: string;
  title: string;
  wikilink: string;
  score: number;
  headings: string[];
  snippet: string;
}

export interface WikiRecallResult {
  /** 是否召回到任何内容 */
  found: boolean;
  /** 命中的页面（已按 score 降序、已受字符预算约束） */
  hits: WikiHit[];
  /** 供 prompt 直接拼装的紧凑文本（hits 的渲染结果） */
  rendered: string;
  /** 因预算被丢弃的命中数（用于观测/告警） */
  dropped: number;
  /** 失败原因（成功时为 null） */
  error: string | null;
  /** 实际耗时（毫秒），供观测使用 */
  elapsedMs: number;
}

export interface RecallOptions {
  /** 字符预算，默认 {@link DEFAULT_RECALL_CHAR_BUDGET} */
  charBudget?: number;
  /** 最低 score，默认 {@link DEFAULT_MIN_SCORE}；传 0 关闭过滤 */
  minScore?: number;
  /** python 子进程超时，默认 15s */
  timeoutMs?: number;
  /** 调用来源（plan/brainstorm/subagent/manual），用于观测归类 */
  source?: string;
  /**
   * 只保留这些记忆层（如 ["L2","L3"]）。undefined 表示不过滤。
   *
   * 分层原则（references/setup.md）：
   *   L0 原始日志 —— 不主动召回（噪音大）
   *   L1 原子事实 —— Subagent 按 step 需要取
   *   L2 场景知识 —— 默认召回
   *   L3 项目画像 —— 主 Agent 启动时最该读的层
   */
  layers?: string[];
  /**
   * 使用 layers 时，是否丢弃没有 memory_layer 字段的页面。
   * 默认 **false** —— 存量约一半笔记缺该字段（420/843），
   * 默认丢弃会让召回凭空变差。
   */
  excludeUnlabeled?: boolean;
}

/** 从 cwd 推断 .goo 目录（观测日志落盘位置）。 */
function resolveGooDir(cwd: string): string {
  return join(cwd, ".goo");
}

/** 统一的观测上报：无论成功失败都记一条。 */
function emitRecall(
  cwd: string,
  source: string,
  query: string,
  result: WikiRecallResult,
  extra: { belowMinScore?: number } = {},
): void {
  logRecall(resolveGooDir(cwd), {
    source,
    query_hash: hashQuery(query),
    query_len: query.length,
    hits: result.hits.length,
    dropped: result.dropped,
    score_max: result.hits.length ? Math.max(...result.hits.map((h) => h.score)) : 0,
    chars: result.rendered.length,
    ms: result.elapsedMs,
    ok: result.error === null,
    error: result.error ?? undefined,
    below_min_score: extra.belowMinScore,
  });
}

function emptyResult(error: string | null, elapsedMs: number): WikiRecallResult {
  return { found: false, hits: [], rendered: "", dropped: 0, error, elapsedMs };
}

/**
 * 从 Goo-wiki 召回与 query 相关的页面。
 *
 * 永远不 throw —— 召回失败不应该阻断 plan/brainstorm 主流程，
 * 但一定会 logWarn，让问题可见。
 */
export async function recallWiki(
  cwd: string,
  query: string,
  opts: RecallOptions = {},
): Promise<WikiRecallResult> {
  const source = opts.source || "manual";
  const result = await recallWikiImpl(cwd, query, opts);
  emitRecall(cwd, source, query, result, { belowMinScore: (result as any).__belowMinScore });
  return result;
}

/** 实际实现（不含观测），由 {@link recallWiki} 包装以便统一上报。 */
async function recallWikiImpl(
  cwd: string,
  query: string,
  opts: RecallOptions = {},
): Promise<WikiRecallResult> {
  const started = Date.now();
  const charBudget = opts.charBudget ?? DEFAULT_RECALL_CHAR_BUDGET;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const script = join(REPO_ROOT, "skills/auto-goo/scripts/wiki-graph-assist.py");
  if (!existsSync(script)) {
    // 场景：插件以只读方式安装、或脚本尚未生成。属于可降级情况。
    const msg = `wiki-graph-assist.py 不存在: ${script}`;
    logWarn(`[wiki-recall] ${msg}`);
    return emptyResult(msg, Date.now() - started);
  }

  let wikiDir: string;
  let projectSlug: string;
  try {
    wikiDir = await resolveWikiDir(cwd);
    projectSlug = await resolveProjectSlug(cwd);
  } catch (e: any) {
    const msg = `解析 wiki 路径失败: ${e?.message ?? String(e)}`;
    logWarn(`[wiki-recall] ${msg}`);
    return emptyResult(msg, Date.now() - started);
  }

  if (!existsSync(wikiDir)) {
    const msg = `wiki 目录不存在: ${wikiDir}`;
    // 未初始化 wiki 是常见状态，用 warn 但不算错误路径
    logWarn(`[wiki-recall] ${msg}`);
    return emptyResult(msg, Date.now() - started);
  }

  // ⚠ 这里只能传脚本**真实支持**的参数。
  // 曾经传过 `--compact`：argparse exit 2，stdout 空，静默失败。
  // 任何新增参数前先跑 `wiki-graph-assist.py --help` 确认。
  const args = [
    "--format", "json",
    "--query", query,
    "--wiki-dir", wikiDir,
    "--project-slug", projectSlug,
  ];
  if (opts.layers?.length) {
    for (const l of opts.layers) args.push("--layer", l.toUpperCase());
    if (opts.excludeUnlabeled) args.push("--exclude-unlabeled");
  }

  let stdout: string;
  let exitCode: number;
  try {
    const result = execPython(script, args, cwd, { timeout: timeoutMs });
    stdout = result.stdout || "";
    exitCode = result.exitCode ?? 0;
    if (exitCode !== 0) {
      const msg = `wiki-graph-assist.py exit=${exitCode}: ${(result.stderr || "").slice(0, 300)}`;
      logWarn(`[wiki-recall] ${msg}`);
      return emptyResult(msg, Date.now() - started);
    }
  } catch (e: any) {
    const msg = `执行 wiki-graph-assist.py 异常: ${e?.message ?? String(e)}`;
    logWarn(`[wiki-recall] ${msg}`);
    return emptyResult(msg, Date.now() - started);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch (e: any) {
    const msg = `召回输出不是合法 JSON: ${e?.message ?? String(e)}（前 200 字符: ${stdout.slice(0, 200)}）`;
    logWarn(`[wiki-recall] ${msg}`);
    return emptyResult(msg, Date.now() - started);
  }

  const raw: any[] = Array.isArray(parsed?.suggested_links) ? parsed.suggested_links : [];
  const beforeCount = raw.length;
  const scored: WikiHit[] = raw
    .filter((x) => x && typeof x.path === "string")
    .map((x) => ({
      path: String(x.path),
      title: String(x.title ?? x.path),
      wikilink: String(x.wikilink ?? `[[${x.path}]]`),
      score: Number(x.score ?? 0),
      headings: Array.isArray(x.headings) ? x.headings.map(String) : [],
      snippet: String(x.snippet ?? ""),
    }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score);

  // 字符预算：按 score 从高到低累加，超出即丢弃
  const kept: WikiHit[] = [];
  let used = 0;
  let dropped = 0;
  for (const hit of scored) {
    const cost = renderHit(hit).length;
    if (used + cost > charBudget && kept.length > 0) {
      dropped += 1;
      continue;
    }
    kept.push(hit);
    used += cost;
  }

  const rendered = kept.map(renderHit).join("\n");
  return {
    found: kept.length > 0,
    hits: kept,
    rendered,
    dropped,
    error: null,
    elapsedMs: Date.now() - started,
    // 供观测使用：低于阈值被过滤掉的噪音条数
    ...({ __belowMinScore: beforeCount - scored.length } as any),
  };
}

function renderHit(hit: WikiHit): string {
  const heads = hit.headings.slice(0, 6).join(" / ");
  return (
    `- ${hit.path} (score ${hit.score})\n` +
    `  标题: ${hit.title}\n` +
    (heads ? `  章节: ${heads}\n` : "")
  );
}

/**
 * 把召回结果渲染成可直接拼进 prompt 的段落。
 * 无命中返回空串（调用方据此决定是否加这一段）。
 */
export function renderRecallSection(result: WikiRecallResult): string {
  if (!result.found || !result.rendered) return "";
  const tail = result.dropped > 0
    ? `\n（另有 ${result.dropped} 条命中因字符预算未列出）`
    : "";
  return `\n\n## 相关 Wiki 上下文\n${result.rendered}${tail}\n`;
}

/**
 * 兼容旧调用方的轻量视图：只关心 sources 与 reused_knowledge。
 * 新代码请直接用 {@link recallWiki}。
 */
export function toLegacyShape(result: WikiRecallResult): {
  found: boolean;
  sources: string[];
  reused_knowledge: string[];
} {
  return {
    found: result.found,
    sources: result.hits.map((h) => h.path),
    reused_knowledge: result.hits.map((h) => `${h.title}${h.headings.length ? `（${h.headings[0]}）` : ""}`),
  };
}

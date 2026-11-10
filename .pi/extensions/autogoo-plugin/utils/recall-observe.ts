/**
 * 召回观测 —— 回答「召回到底有没有用」。
 *
 * 为什么需要这个模块
 * ------------------
 * 在加观测之前，召回是纯黑盒：召回了什么、命中几条、耗时多少、是否被
 * Subagent 真正引用，全都无从得知。这正是两个召回 bug
 * （plan 传 `--compact` 导致从未成功、brainstorm 用目录列表假召回）
 * 能长期存活而无人发现的根本原因 —— **没有观测，坏了也没人知道**。
 *
 * 设计
 * ----
 * - 追加写 `.goo/logs/recall.jsonl`，每行一条独立 JSON（便于 grep/awk/jq）。
 * - query 只存 sha256 前 16 位与长度，不落原文（可能含敏感信息）。
 * - 写入失败绝不阻塞主流程（与 utils/log.ts 同一原则）。
 * - 文件按大小轮转，避免无限增长。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024; // 4MB 后轮转为 .1

export interface RecallEvent {
  /** ISO 时间戳 */
  ts: string;
  /** 调用来源：plan | brainstorm | subagent | manual */
  source: string;
  /** query 的 sha256 前 16 位（不存原文） */
  query_hash: string;
  /** query 字符长度（用于判断 query 是否过长导致匹配失败） */
  query_len: number;
  /** 命中条数（已按预算裁剪后） */
  hits: number;
  /** 因预算被丢弃的条数 */
  dropped: number;
  /** 最高 score（无命中为 0） */
  score_max: number;
  /** 渲染后字符数 */
  chars: number;
  /** 耗时毫秒 */
  ms: number;
  /** 是否成功（false 表示脚本/解析失败） */
  ok: boolean;
  /** 失败原因（截断 200 字） */
  error?: string;
  /** 被排除的噪音条数（score 低于阈值） */
  below_min_score?: number;
}

export function recallLogPath(gooDir: string): string {
  return join(gooDir, "logs", "recall.jsonl");
}

function rotateIfNeeded(path: string): void {
  try {
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    /* 轮转失败不阻塞 */
  }
}

/**
 * 记录一次召回。永不抛出。
 */
export function logRecall(gooDir: string, ev: Omit<RecallEvent, "ts"> & { ts?: string }): void {
  try {
    const path = recallLogPath(gooDir);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    rotateIfNeeded(path);
    const record: RecallEvent = {
      ...ev,
      ts: ev.ts || new Date().toISOString(),
    };
    if (record.error) record.error = record.error.slice(0, 200);
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  } catch {
    /* 观测失败绝不影响召回本身 */
  }
}

/** query 脱敏：仅保留可关联性，不保留内容。 */
export function hashQuery(query: string): string {
  try {
    return createHash("sha256").update(query, "utf-8").digest("hex").slice(0, 16);
  } catch {
    return "0".repeat(16);
  }
}

export interface RecallStats {
  total: number;
  ok: number;
  failed: number;
  /** 命中的召此次数占比（hits>0） */
  hitRate: number;
  avgMs: number;
  p95Ms: number;
  avgHits: number;
  /** 因预算丢过内容的次数 */
  budgetTruncated: number;
  lastN: RecallEvent[];
}

/**
 * 读取召回日志并汇总。用于 /goo-observe 的召回 tab。
 * 日志不存在或损坏时返回全零（不抛异常）。
 */
export function readRecallStats(gooDir: string, limit = 200): RecallStats {
  const empty: RecallStats = {
    total: 0, ok: 0, failed: 0, hitRate: 0,
    avgMs: 0, p95Ms: 0, avgHits: 0, budgetTruncated: 0, lastN: [],
  };
  const path = recallLogPath(gooDir);
  if (!existsSync(path)) return empty;

  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf-8").split("\n").filter(Boolean).slice(-limit);
  } catch {
    return empty;
  }

  const events: RecallEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as RecallEvent);
    } catch {
      /* 跳过损坏行 */
    }
  }
  if (events.length === 0) return empty;

  const okEvents = events.filter((e) => e.ok);
  const ms = events.map((e) => Number(e.ms) || 0).sort((a, b) => a - b);
  const p95 = ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : 0;
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  return {
    total: events.length,
    ok: okEvents.length,
    failed: events.length - okEvents.length,
    hitRate: okEvents.length ? okEvents.filter((e) => e.hits > 0).length / okEvents.length : 0,
    avgMs: Math.round(sum(ms) / (ms.length || 1)),
    p95Ms: p95,
    avgHits: okEvents.length ? Number((sum(okEvents.map((e) => e.hits)) / okEvents.length).toFixed(1)) : 0,
    budgetTruncated: events.filter((e) => (e.dropped || 0) > 0).length,
    lastN: events.slice(-20).reverse(),
  };
}

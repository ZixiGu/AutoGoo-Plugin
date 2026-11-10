/**
 * 召回观测测试。
 *
 * 存在的理由：召回曾长期静默失效而无人发现，就是因为**没有观测**。
 * 这里断言的不只是「有日志」，而是「日志能回答『召回有没有用』」。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logRecall, readRecallStats, hashQuery, recallLogPath } from "../utils/recall-observe.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goo-recall-"));
});

describe("recall-observe", () => {
  it("落盘为 JSONL，每行可独立解析", () => {
    logRecall(dir, {
      source: "plan", query_hash: hashQuery("x"), query_len: 1,
      hits: 2, dropped: 0, score_max: 40, chars: 100, ms: 12, ok: true,
    });
    const path = recallLogPath(dir);
    assert.ok(existsSync(path), "日志文件应存在");
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.source, "plan");
    assert.equal(rec.hits, 2);
  });

  it("query 不落原文，只存 hash 与长度", () => {
    const secret = "包含敏感信息的目标描述";
    logRecall(dir, {
      source: "plan", query_hash: hashQuery(secret), query_len: secret.length,
      hits: 0, dropped: 0, score_max: 0, chars: 0, ms: 5, ok: true,
    });
    const raw = readFileSync(recallLogPath(dir), "utf-8");
    assert.ok(!raw.includes(secret), "禁止落 query 原文");
    assert.ok(raw.includes(hashQuery(secret)));
    assert.equal(hashQuery(secret).length, 16);
  });

  it("统计能给出命中率 / p95 / 预算截断次数", () => {
    const base = { query_hash: "a", query_len: 3, score_max: 30, ok: true };
    logRecall(dir, { ...base, source: "plan", hits: 3, dropped: 0, chars: 200, ms: 10 });
    logRecall(dir, { ...base, source: "plan", hits: 0, dropped: 0, chars: 0, ms: 20 });
    logRecall(dir, { ...base, source: "plan", hits: 1, dropped: 5, chars: 50, ms: 90 });
    const s = readRecallStats(dir);
    assert.equal(s.total, 3);
    assert.equal(s.ok, 3);
    assert.equal(s.hitRate, 2 / 3);
    assert.equal(s.budgetTruncated, 1);
    assert.ok(s.p95Ms >= 20);
    assert.equal(s.avgHits, 1.3);
  });

  it("失败召回也记录，可据此发现『一直失败但没人知道』", () => {
    logRecall(dir, {
      source: "plan", query_hash: "b", query_len: 3,
      hits: 0, dropped: 0, score_max: 0, chars: 0, ms: 30, ok: false,
      error: "wiki-graph-assist.py exit=2: unrecognized arguments: --compact",
    });
    const s = readRecallStats(dir);
    assert.equal(s.failed, 1);
    assert.equal(s.lastN[0].ok, false);
    assert.match(s.lastN[0].error || "", /--compact/);
  });

  it("日志目录不存在时统计返回零值而不抛", () => {
    const s = readRecallStats(join(dir, "nonexistent"));
    assert.equal(s.total, 0);
    assert.deepEqual(s.lastN, []);
  });
});

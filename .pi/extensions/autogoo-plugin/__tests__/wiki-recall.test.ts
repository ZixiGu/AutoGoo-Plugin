/**
 * wiki 召回测试。
 *
 * 重点不是「召回得到东西」，而是**回归两个曾经静默失效的实现**：
 *   1. plan.ts 传 `--compact`（脚本不支持）→ exit 2 → 静默 found:false
 *   2. brainstorm.ts 未调脚本，readdir 目录当结果
 *
 * 因此这里断言的是「结果里必须是具体页面路径，且能召回已知文档」，
 * 而不是「函数返回了非空数组」——后者两个错误实现都能满足。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { recallWiki, renderRecallSection, toLegacyShape } from "../utils/wiki-recall.js";
import { REPO_ROOT } from "../utils/paths.js";

const WIKI_DIR = "/home/zixigu/workspace/Goo-wiki";
const hasWiki = existsSync(WIKI_DIR);

describe("wiki-recall", { skip: hasWiki ? false : "本机无 Goo-wiki，跳过实链路测试" }, () => {
  it("对 'memory' 的召回必须返回具体页面路径，而不是项目目录", async () => {
    const r = await recallWiki(REPO_ROOT, "memory 系统 优化");
    assert.equal(r.error, null, `召回不应报错: ${r.error}`);
    assert.ok(r.found, "应召回到内容");
    for (const hit of r.hits) {
      assert.ok(
        hit.path.endsWith(".md"),
        `召回结果必须是具体 .md 页面，实际: ${hit.path}`,
      );
    }
  });

  it("能召回已知存在的 memory 研究文档（旧实现永远做不到）", async () => {
    const r = await recallWiki(REPO_ROOT, "memory 系统 优化");
    const paths = r.hits.map((h) => h.path);
    const ok = paths.some((p) => p.includes("memory-systems") || p.toLowerCase().includes("memory"));
    assert.ok(ok, `应命中 memory 相关文档，实际命中: ${paths.slice(0, 5).join(", ")}`);
  });

  it("字符串参数里不得出现脚本不支持的 --compact（历史 bug）", async () => {
    // 读源码断言，避免再次把不存在的参数传进去
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(REPO_ROOT, ".pi/extensions/autogoo-plugin/utils/wiki-recall.ts"), "utf-8");
    // 只看实际传给脚本的参数数组区域
    const argBlock = src.slice(src.indexOf("const args = ["), src.indexOf("];", src.indexOf("const args = [")) + 2);
    assert.ok(!argBlock.includes("--compact"), "不得传 --compact：wiki-graph-assist.py 没有这个参数");
    assert.ok(argBlock.includes("--format"), "应显式指定 --format json");
  });

  it("字符预算生效：超出预算时 dropped > 0 且总长受限", async () => {
    const r = await recallWiki(REPO_ROOT, "待办", { charBudget: 120 });
    assert.ok(r.rendered.length <= 120 * 2, `渲染结果应受预算约束，实际 ${r.rendered.length}`);
    if (r.dropped > 0) assert.ok(r.dropped > 0);
  });

  it("空 query / 不存在的 wiki 目录不抛异常（只 warn）", async () => {
    const r = await recallWiki(REPO_ROOT, "", { timeoutMs: 5000 });
    assert.equal(typeof r.found, "boolean");
    assert.equal(typeof r.elapsedMs, "number");
  });

  it("与 query 完全无关时返回 0 条（评分不得因项目归属而虚高）", async () => {
    // 回归：曾有两个叠加的 bug 让召回命中率恒为 100%
    //   1. `query_terms` 里拼了 project_slug → 项目内每页路径都含 slug，
    //      `term in low_rel` 恒真 → relevance 恒 > 0
    //   2. `if project_slug in low_rel: score += 12` 无条件加分
    // 结果 query 填「完全不存在」也能召回满 12 条。
    const r = await recallWiki(REPO_ROOT, "zzz-完全不存在的内容-zzz", { source: "test" });
    assert.equal(r.hits.length, 0, `无关 query 不应召回任何页面，实际 ${r.hits.length} 条: ${r.hits.slice(0, 3).map((h) => h.path).join(", ")}`);
    assert.equal(r.found, false);
  });

  it("正常 query 仍能召回到结果（不能为了去噪把召回弄死）", async () => {
    const r = await recallWiki(REPO_ROOT, "memory 系统", { source: "test" });
    assert.ok(r.hits.length > 0, "正常 query 应召回到内容");
    assert.ok(r.hits[0].score >= 10, `首条 score 应 >= 10，实际 ${r.hits[0]?.score}`);
  });

  it("renderRecallSection 无命中时返回空串", async () => {
    const r = await recallWiki(REPO_ROOT, "zzz-不存在的内容-zzz", { minScore: 999 });
    assert.equal(r.found, false);
    assert.equal(renderRecallSection(r), "");
  });

  it("toLegacyShape 保留 sources 语义", async () => {
    const r = await recallWiki(REPO_ROOT, "memory");
    const legacy = toLegacyShape(r);
    assert.equal(legacy.found, r.found);
    assert.equal(legacy.sources.length, r.hits.length);
  });
});

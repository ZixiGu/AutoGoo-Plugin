/**
 * dispatch 的 wiki 体积护栏测试。
 *
 * 背景：`< 20k 字符预算` 原本只是 prompt 里的一句嘱咐，无任何运行时强制。
 * 实测 autogoo-plugin 的 wiki_paths 展开后是 **227KB（预算的 11.6 倍）**，
 * 单篇 autogoo-plugin.md 就有 33KB。subagent 若逐篇通读，一次吃掉 200KB+ 上下文。
 *
 * 这里断言的不是「有个函数」，而是：
 *   1. wiki_paths 是相对 **wiki 根**解析的（第一版按 cwd 拼，永远统计到 0 个文件）
 *   2. 超预算能被测出来
 *   3. 警告真的出现在 subagent prompt 里
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  measureWikiPaths,
  buildSubagentTaskPrompt,
  WIKI_READ_CHAR_BUDGET,
} from "../utils/dispatch.js";

let wikiRoot: string;
let cwd: string;
const prevEnv = process.env.AUTOGOO_PLUGIN_WIKI_DIR;

before(() => {
  wikiRoot = mkdtempSync(join(tmpdir(), "goo-wiki-"));
  cwd = mkdtempSync(join(tmpdir(), "goo-proj-"));
  process.env.AUTOGOO_PLUGIN_WIKI_DIR = wikiRoot;

  mkdirSync(join(wikiRoot, "wiki/projects/demo/lessons"), { recursive: true });
  // 一个小文件 + 一个远超预算的大文件
  writeFileSync(join(wikiRoot, "wiki/projects/demo.md"), "x".repeat(500));
  writeFileSync(
    join(wikiRoot, "wiki/projects/demo/lessons/big.md"),
    "y".repeat(WIKI_READ_CHAR_BUDGET + 5000),
  );
});

after(() => {
  if (prevEnv === undefined) delete process.env.AUTOGOO_PLUGIN_WIKI_DIR;
  else process.env.AUTOGOO_PLUGIN_WIKI_DIR = prevEnv;
  rmSync(wikiRoot, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("measureWikiPaths", () => {
  it("wiki_paths 相对 wiki 根解析，而不是 cwd", async () => {
    const sizes = await measureWikiPaths(cwd, ["wiki/projects/demo.md"]);
    assert.equal(sizes.files, 1, "应解析到 wiki 根下的文件（若按 cwd 拼会得到 0）");
    assert.equal(sizes.totalBytes, 500);
  });

  it("glob 展开并统计合计体积", async () => {
    const sizes = await measureWikiPaths(cwd, ["wiki/projects/demo/**/*.md", "wiki/projects/demo.md"]);
    assert.equal(sizes.files, 2);
    assert.equal(sizes.totalBytes, 500 + WIKI_READ_CHAR_BUDGET + 5000);
  });

  it("单篇超预算的文件被标记（必须分段读）", async () => {
    const sizes = await measureWikiPaths(cwd, ["wiki/projects/demo/**/*.md"]);
    assert.equal(sizes.oversized.length, 1);
    assert.ok(sizes.oversized[0].bytes > WIKI_READ_CHAR_BUDGET);
    assert.match(sizes.oversized[0].path, /big\.md$/);
  });

  it("不存在的路径不会抛异常，只是统计为 0", async () => {
    const sizes = await measureWikiPaths(cwd, ["wiki/does/not/exist.md"]);
    assert.equal(sizes.files, 0);
    assert.equal(sizes.totalBytes, 0);
  });
});

describe("buildSubagentTaskPrompt 体积警告", () => {
  it("超预算时 prompt 里出现明确的倍数警告", async () => {
    const sizes = await measureWikiPaths(cwd, ["wiki/projects/demo/**/*.md"]);
    const prompt = buildSubagentTaskPrompt({
      role: "implementer",
      task: "x",
      wiki_paths: ["wiki/projects/demo/**/*.md"],
      wiki_graph_packet_path: ".goo/p.json",
      packetGenerated: true,
      wikiPathSizes: sizes,
    });
    assert.ok(prompt.includes("⚠"), "应有警告标记");
    assert.ok(/倍/.test(prompt), "应给出倍数关系");
    assert.ok(prompt.includes("offset/limit"), "应给出分段读的具体做法");
  });

  it("未超预算时不制造噪音", async () => {
    const sizes = await measureWikiPaths(cwd, ["wiki/projects/demo.md"]);
    const prompt = buildSubagentTaskPrompt({
      role: "implementer",
      task: "x",
      wiki_paths: ["wiki/projects/demo.md"],
      wiki_graph_packet_path: ".goo/p.json",
      packetGenerated: true,
      wikiPathSizes: sizes,
    });
    assert.ok(!prompt.includes("不要全部通读"), "小体积不应告警");
  });

  it("预算文案与实际常量一致（防止改常量忘改文案）", () => {
    const prompt = buildSubagentTaskPrompt({
      role: "implementer",
      task: "x",
      wiki_paths: [],
      wiki_graph_packet_path: ".goo/p.json",
      packetGenerated: true,
    });
    assert.ok(
      prompt.includes(`< ${WIKI_READ_CHAR_BUDGET / 1000}k`),
      "prompt 里的预算数字必须由常量推导",
    );
  });
});

/**
 * `/goo-subagent model` 的配置读写测试。
 *
 * 动机：默认已改为「跟随主模型、不弹窗」，但用户仍需要一个**可发现**的方式
 * 指定模型（比如用便宜的 flash 跑 subagent）。入口挂在已有的 /goo-subagent
 * 子命令上，不新增 /goo-xx 命令。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeExecutionModelConfig, loadProjectConfig } from "../utils/paths.js";
import { resolveSubagentModel } from "../utils/subagent.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goo-modelcfg-"));
  mkdirSync(join(dir, ".goo"), { recursive: true });
  writeFileSync(
    join(dir, ".goo/config.json"),
    JSON.stringify({ wiki_dir: "/tmp/x", execution: { max_concurrent: 6 } }, null, 2),
    "utf-8",
  );
});

describe("writeExecutionModelConfig", () => {
  it("成对写入 → config 里出现两个字段", async () => {
    const ok = await writeExecutionModelConfig(dir, "opencode-go", "deepseek-v4.1-flash");
    assert.equal(ok, true);
    const raw = JSON.parse(readFileSync(join(dir, ".goo/config.json"), "utf-8"));
    assert.equal(raw.execution.subagent_provider, "opencode-go");
    assert.equal(raw.execution.subagent_model, "deepseek-v4.1-flash");
  });

  it("传 null → 清除两个字段（恢复跟随主模型）", async () => {
    await writeExecutionModelConfig(dir, "yj", "deepseek-flash");
    const ok = await writeExecutionModelConfig(dir, null, null);
    assert.equal(ok, true);
    const raw = JSON.parse(readFileSync(join(dir, ".goo/config.json"), "utf-8"));
    assert.equal("subagent_provider" in raw.execution, false, "应删除而非置空");
    assert.equal("subagent_model" in raw.execution, false);
  });

  it("清除后解析结果回落到主模型", async () => {
    await writeExecutionModelConfig(dir, "yj", "deepseek-flash");
    await writeExecutionModelConfig(dir, null, null);
    const cfg = await loadProjectConfig(dir);
    const r = resolveSubagentModel(
      { provider: (cfg as any)?.execution?.subagent_provider, model: (cfg as any)?.execution?.subagent_model },
      { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    );
    assert.equal(r.provider, "opencode-go");
    assert.equal(r.model, "deepseek-v4.1-flash");
  });

  it("写入不破坏 config 里的其他字段", async () => {
    await writeExecutionModelConfig(dir, "p", "m");
    const raw = JSON.parse(readFileSync(join(dir, ".goo/config.json"), "utf-8"));
    assert.equal(raw.wiki_dir, "/tmp/x", "wiki_dir 应保留");
    assert.equal(raw.execution.max_concurrent, 6, "execution 其他字段应保留");
  });

  it("config 不存在时也能写入（创建文件）", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "goo-modelcfg-fresh-"));
    try {
      const ok = await writeExecutionModelConfig(fresh, "p2", "m2");
      assert.equal(ok, true);
      const raw = JSON.parse(readFileSync(join(fresh, ".goo/config.json"), "utf-8"));
      assert.equal(raw.execution.subagent_model, "m2");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

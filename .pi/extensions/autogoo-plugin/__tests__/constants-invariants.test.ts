/**
 * 常量不变量测试。
 *
 * 这些常量是**跨模块契约**（step 类型 → 默认层 / 默认 wiki 路径 / 记忆层编号），
 * 单看每个字面量都没问题，错配了才会在运行期表现出来（比如 audit 拿到 L0
 * 却应该拿 L3）。这里把「配对关系」钉死。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MEMORY_LAYER,
  DEFAULT_MEMORY_LAYER_BY_STEP_TYPE,
  DEFAULT_WIKI_PATHS_BY_STEP_TYPE,
} from "../constants.js";

const STEP_TYPES = ["research", "exec", "optimize", "eval", "review", "audit", "archive"] as const;

describe("DEFAULT_MEMORY_LAYER_BY_STEP_TYPE", () => {
  it("每个 step 类型都有默认层（新增类型不得漏配）", () => {
    for (const t of STEP_TYPES) {
      assert.ok(
        DEFAULT_MEMORY_LAYER_BY_STEP_TYPE[t],
        `step 类型 ${t} 缺少默认 memory_layer`,
      );
    }
  });

  it("取值必须是合法的 L0-L3", () => {
    for (const [t, v] of Object.entries(DEFAULT_MEMORY_LAYER_BY_STEP_TYPE)) {
      assert.match(v, /^L[0-3]$/, `${t} 的默认层 ${v} 不是合法值`);
    }
  });

  it("编号方向：audit 需要原始 trace → L3（最冷），不能是 L0", () => {
    // 0.27.0 翻转前的 bug：L0=原始日志。若有人再翻回去，这条会红。
    assert.equal(DEFAULT_MEMORY_LAYER_BY_STEP_TYPE.audit, "L3");
  });

  it("编号方向：exec/research 只需要场景知识 → L1（默认层）", () => {
    for (const t of ["exec", "research", "optimize", "eval", "archive"] as const) {
      assert.equal(
        DEFAULT_MEMORY_LAYER_BY_STEP_TYPE[t],
        "L1",
        `${t} 应是默认层 L1（场景知识）`,
      );
    }
  });

  it("review 需要具体事实 → 比默认层更深一层（L2）", () => {
    assert.equal(DEFAULT_MEMORY_LAYER_BY_STEP_TYPE.review, "L2");
  });

  it("DEFAULT_MEMORY_LAYER 与 exec 的默认层一致（两处定义不得漂移）", () => {
    assert.equal(
      DEFAULT_MEMORY_LAYER,
      DEFAULT_MEMORY_LAYER_BY_STEP_TYPE.exec,
      "集中常量 DEFAULT_MEMORY_LAYER 与 exec 映射不一致会导致召回范围随调用路径变化",
    );
  });
});

describe("DEFAULT_WIKI_PATHS_BY_STEP_TYPE", () => {
  it("每个 step 类型都有 wiki_paths", () => {
    for (const t of STEP_TYPES) {
      assert.ok(
        Array.isArray(DEFAULT_WIKI_PATHS_BY_STEP_TYPE[t]),
        `step 类型 ${t} 缺少默认 wiki_paths`,
      );
    }
  });

  it("占位符只能出现 {slug} / {thread_id}", () => {
    for (const [t, paths] of Object.entries(DEFAULT_WIKI_PATHS_BY_STEP_TYPE)) {
      for (const p of paths) {
        const holes = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
        for (const h of holes) {
          assert.ok(
            h === "slug" || h === "thread_id",
            `${t} 的路径 ${p} 用了未知占位符 {${h}} —— buildDispatchPacket 不会替换它`,
          );
        }
      }
    }
  });

  it("路径都以 wiki/ 开头（相对 wiki 根，不是相对 cwd）", () => {
    // 回归：measureWikiPaths 首版按 cwd 拼，永远统计到 0 个文件。
    for (const [t, paths] of Object.entries(DEFAULT_WIKI_PATHS_BY_STEP_TYPE)) {
      for (const p of paths) {
        assert.ok(p.startsWith("wiki/"), `${t} 的路径 ${p} 不是相对 wiki 根`);
      }
    }
  });
});

/**
 * 并行写冲突检测测试。
 *
 * 存在的理由：`allowed_write_paths` 此前只写进 subagent prompt 当说明文字，
 * **零强制**。实测一轮 4 个并行步骤写范围全部重叠（check-plugin.sh 被 4 个
 * 步骤同时修改），系统毫无察觉 —— 两个 subagent 同时写同一文件时，
 * 后写的直接覆盖先写的，且不报错。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectWriteConflicts, describeWriteConflicts } from "../tools/execute.js";

const step = (id: number, paths: string[]) => ({ id, name: `步骤${id}`, allowed_write_paths: paths });

describe("detectWriteConflicts", () => {
  it("相同路径 → 冲突", () => {
    const c = detectWriteConflicts([
      step(1, ["skills/auto-goo/scripts/check-plugin.sh"]),
      step(2, ["skills/auto-goo/scripts/check-plugin.sh"]),
    ]);
    assert.equal(c.length, 1);
    assert.equal(c[0].a.id, 1);
    assert.equal(c[0].b.id, 2);
    assert.ok(c[0].overlap.length > 0);
  });

  it("父目录 vs 子路径 → 冲突（这是本轮真实场景）", () => {
    // 步骤 1 写整个 .pi/extensions/autogoo-plugin/，步骤 2 写其中的 dispatch.ts
    const c = detectWriteConflicts([
      step(1, [".pi/extensions/autogoo-plugin/"]),
      step(2, [".pi/extensions/autogoo-plugin/utils/dispatch.ts"]),
    ]);
    assert.equal(c.length, 1, "目录包含关系必须判为冲突");
  });

  it("互不相干的路径 → 不冲突", () => {
    const c = detectWriteConflicts([
      step(1, ["skills/auto-goo/scripts/"]),
      step(2, [".pi/extensions/autogoo-plugin/"]),
    ]);
    assert.equal(c.length, 0, "无重叠时不得误报");
  });

  it("前缀相似但不同目录 → 不冲突（src vs srcfoo）", () => {
    const c = detectWriteConflicts([
      step(1, ["src/"]),
      step(2, ["srcfoo/"]),
    ]);
    assert.equal(c.length, 0, "src 不应匹配 srcfoo");
  });

  it("无 allowed_write_paths → 不冲突", () => {
    const c = detectWriteConflicts([step(1, []), step(2, [])]);
    assert.equal(c.length, 0);
  });

  it("祖先覆盖：a/ 与 a/b/、a/c/ 各冲突，但 a/b/ 与 a/c/ 互不重叠", () => {
    // 注意：这里只有 2 组，不是 3 组 —— a/b/ 和 a/c/ 是兄弟目录，不该误报。
    // 写测试时容易想当然按「两两组合」算，那会掩盖真正的判断逻辑。
    const c = detectWriteConflicts([
      step(1, ["a/"]), step(2, ["a/b/"]), step(3, ["a/c/"]),
    ]);
    assert.equal(c.length, 2);
    const pairs = c.map((x) => `${x.a.id}-${x.b.id}`).sort();
    assert.deepEqual(pairs, ["1-2", "1-3"], "只有祖先关系成立的两对");
  });

  it("./ 前缀与结尾斜杠被归一化", () => {
    const c = detectWriteConflicts([
      step(1, ["./docs/"]),
      step(2, ["docs"]),
    ]);
    assert.equal(c.length, 1, "./docs/ 与 docs 应判为同一范围");
  });
});

describe("describeWriteConflicts", () => {
  it("无冲突时返回空数组（不产生噪音）", () => {
    assert.deepEqual(describeWriteConflicts([]), []);
  });

  it("输出含步骤号与重叠路径，并明确「不阻止执行」", () => {
    const lines = describeWriteConflicts([
      { a: { id: 1 }, b: { id: 2 }, overlap: ["check-plugin.sh"] },
    ]);
    const text = lines.join("\n");
    assert.match(text, /#1/);
    assert.match(text, /#2/);
    assert.match(text, /check-plugin\.sh/);
    assert.match(text, /不阻止执行/, "必须说明这是告警而非阻断");
    assert.match(text, /建议/, "应给出处置建议");
  });

  it("冲突过多时截断（不刷屏）", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      a: { id: i }, b: { id: i + 1 }, overlap: ["x"],
    }));
    const lines = describeWriteConflicts(many);
    assert.ok(lines.length < 15, `应截断，实际 ${lines.length} 行`);
    assert.match(lines.join("\n"), /另有/);
  });
});

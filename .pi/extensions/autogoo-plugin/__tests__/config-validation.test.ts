/**
 * 配置校验测试。
 *
 * 背景：配置里 `_seconds` 与 `_minutes` 混用，填错不会有任何报错，
 * 只会让行为变得诡异 —— 用户以为配好了，实际没生效：
 *
 *   stale_heartbeat_seconds: 15     ← 想填 15 分钟，实际 15 秒
 *   subagent_timeout_seconds: 30    ← 想填 30 分钟，实际 30 秒（subagent 秒退）
 *
 * 与 `execution.stale_after_seconds` / `observability.stale_heartbeat_seconds`
 * 分属两处是同一类问题：**配置骗人**。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateTimingConfig } from "../utils/paths.js";

describe("validateTimingConfig", () => {
  it("合理配置零告警", () => {
    assert.deepEqual(
      validateTimingConfig({ execution: { heartbeat_seconds: 30, stale_after_seconds: 120 } } as any),
      [],
    );
  });

  it("把秒字段填成分钟量级 → 提示单位可能搞反", () => {
    const issues = validateTimingConfig({ execution: { stale_after_seconds: 15 } } as any);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /单位是\*\*秒\*\*/);
    assert.match(issues[0], /900/, "应给出正确的换算值");
  });

  it("分钟字段填 0.5 → 提示单位是分钟", () => {
    const issues = validateTimingConfig({ observability: { step_timeout_minutes: 0.5 } } as any);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /单位是\*\*分钟\*\*/);
  });

  it("负数/零 → 拒绝并说明后果", () => {
    assert.match(validateTimingConfig({ observability: { plan_stall_minutes: -1 } } as any)[0], /必须为正数/);
    assert.match(validateTimingConfig({ execution: { heartbeat_seconds: 0 } } as any)[0], /必须为正数/);
  });

  it("非数字 → 提示已忽略", () => {
    assert.match(
      validateTimingConfig({ execution: { heartbeat_seconds: "abc" } } as any)[0],
      /不是数字/,
    );
  });

  it("缺省字段不产生噪音（undefined/null 都跳过）", () => {
    assert.deepEqual(validateTimingConfig({} as any), []);
    assert.deepEqual(validateTimingConfig(null), []);
    assert.deepEqual(validateTimingConfig(undefined), []);
  });

  it("多个字段同时有问题 → 全部列出（不只报第一个）", () => {
    const issues = validateTimingConfig({
      execution: { heartbeat_seconds: 1, stale_after_seconds: 5 },
      observability: { plan_stall_minutes: 0 },
    } as any);
    assert.ok(issues.length >= 3, `应列出全部问题，实际 ${issues.length}`);
  });
});

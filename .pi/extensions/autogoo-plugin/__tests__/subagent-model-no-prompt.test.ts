/**
 * Subagent 模型解析：能跟随主模型时**不得弹窗**。
 *
 * 原设计是「无显式配置就问一次，把选择写进 config」。实际体验很差：
 * 每个新会话第一次派发都弹窗，而绝大多数人想要的就是「跟主模型一样」。
 *
 * 默认行为不该需要用户确认。想用别的模型时写
 * `config.execution.subagent_provider/subagent_model` 即可（走 configured 分支）。
 * 只有**拿不到主模型**时（headless 无 PI_*、ctx.model 缺失）才需要问。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveOrPromptSubagentModel } from "../utils/subagent.js";

function makeCtx() {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      ui: {
        select: async (t: string, o: string[]) => {
          calls.push(`select:${t}`);
          return o[o.length - 1]; // 选最后一项（取消）
        },
        input: async (t: string) => {
          calls.push(`input:${t}`);
          return "";
        },
        notify: (m: string) => calls.push(`notify:${m}`),
      },
    } as any,
  };
}

const writeOk = async () => true;

describe("resolveOrPromptSubagentModel", () => {
  it("显式配置齐全 → 直接返回，不弹窗", async () => {
    const { calls, ctx } = makeCtx();
    const r = await resolveOrPromptSubagentModel(
      { provider: "yj", model: "deepseek-flash" },
      { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      ctx,
      writeOk,
    );
    assert.equal(r.action, "configured");
    assert.equal(r.provider, "yj");
    assert.equal(r.model, "deepseek-flash");
    assert.deepEqual(calls, [], "显式配置时不得有任何 UI 交互");
  });

  it("无显式配置但能拿到主模型 → 跟随主模型且不弹窗（核心回归）", async () => {
    const { calls, ctx } = makeCtx();
    const r = await resolveOrPromptSubagentModel(
      {},
      { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      ctx,
      writeOk,
    );
    assert.equal(r.action, "resolved");
    assert.equal(r.provider, "opencode-go");
    assert.equal(r.model, "deepseek-v4.1-flash");
    assert.deepEqual(calls, [], "能跟随主模型时不得弹窗 —— 这正是用户抱怨的「每次都要问」");
  });

  it("无 ctx.model 时回退到 PI_* 环境变量，仍不弹窗", async () => {
    const prevP = process.env.PI_PROVIDER;
    const prevM = process.env.PI_MODEL;
    process.env.PI_PROVIDER = "env-provider";
    process.env.PI_MODEL = "env-model";
    try {
      const { calls, ctx } = makeCtx();
      const r = await resolveOrPromptSubagentModel({}, null, ctx, writeOk);
      assert.equal(r.provider, "env-provider");
      assert.equal(r.model, "env-model");
      assert.deepEqual(calls, []);
    } finally {
      if (prevP === undefined) delete process.env.PI_PROVIDER;
      else process.env.PI_PROVIDER = prevP;
      if (prevM === undefined) delete process.env.PI_MODEL;
      else process.env.PI_MODEL = prevM;
    }
  });

  it("拿不到主模型 → 才弹窗询问", async () => {
    const prevP = process.env.PI_PROVIDER;
    const prevM = process.env.PI_MODEL;
    delete process.env.PI_PROVIDER;
    delete process.env.PI_MODEL;
    try {
      const { calls, ctx } = makeCtx();
      const r = await resolveOrPromptSubagentModel({}, null, ctx, writeOk);
      assert.ok(calls.some((c) => c.startsWith("select:")), "无从判断时才应该问");
      assert.equal(r.action, "cancelled", "测试里选「取消」");
    } finally {
      if (prevP !== undefined) process.env.PI_PROVIDER = prevP;
      if (prevM !== undefined) process.env.PI_MODEL = prevM;
    }
  });

  it("headless（无 UI）→ 跟随主模型，不阻塞", async () => {
    const prevP = process.env.PI_PROVIDER;
    const prevM = process.env.PI_MODEL;
    process.env.PI_PROVIDER = "hp";
    process.env.PI_MODEL = "hm";
    try {
      const r = await resolveOrPromptSubagentModel({}, null, null, writeOk);
      assert.equal(r.provider, "hp");
      assert.equal(r.model, "hm");
    } finally {
      if (prevP === undefined) delete process.env.PI_PROVIDER;
      else process.env.PI_PROVIDER = prevP;
      if (prevM === undefined) delete process.env.PI_MODEL;
      else process.env.PI_MODEL = prevM;
    }
  });
});

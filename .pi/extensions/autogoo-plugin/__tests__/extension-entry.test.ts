/**
 * 扩展入口（`index.ts`）激活冒烟测试。
 *
 * 这个文件 639 行，之前**零覆盖**，而它在 pi 启动时是第一个被执行的模块：
 * 命令表里任何一个 handler 名字写错、注册签名对不上、或者顶层代码抛异常，
 * 表现都是"插件整体不加载" —— 用户看到的是所有 /goo-* 命令凭空消失。
 *
 * 这里只断言「装载契约」，不碰具体命令逻辑（那些在 commands-smoke.test.ts）：
 *   1. 激活不抛异常，并注册齐命令 / 工具 / 快捷键 / 事件；
 *   2. `/auto-goo:goo-xxx` 输入拦截能路由到 handler（未知命令给出明确提示）；
 *   3. before_agent_start 真的把 AutoGoo 系统提示拼进 systemPrompt；
 *   4. session_start 钩子在"没有 .goo 目录"的项目里不炸。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installPiTuiStub } from "./helpers/pi-tui-hooks.js";

installPiTuiStub();

const { default: activate } = await import("../index.js");

interface Note {
  message: string;
  type?: string;
}

function makeCtx(cwd: string) {
  const notes: Note[] = [];
  const ctx: any = {
    cwd,
    mode: "print",
    hasUI: false,
    ui: {
      notify: (message: string, type?: string) => notes.push({ message, type }),
      setEditorText: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
      custom: async () => undefined,
    },
    sessionManager: { getSessionId: () => "sess-entry-1", getSessionFile: () => null },
    model: { id: "test-model" },
  };
  ctx.notes = notes;
  return ctx;
}

function makePi() {
  const pi: any = {
    commands: new Map<string, any>(),
    tools: [] as any[],
    shortcuts: new Map<string, any>(),
    handlers: new Map<string, any[]>(),
    registerTool: (def: any) => pi.tools.push(def),
    registerCommand: (name: string, def: any) => pi.commands.set(name, def),
    registerShortcut: (key: string, def: any) => pi.shortcuts.set(key, def),
    on: (event: string, fn: any) => {
      const list = pi.handlers.get(event) ?? [];
      list.push(fn);
      pi.handlers.set(event, list);
    },
    sendUserMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
  return pi;
}

let tmpRoot = "";
let prevHome: string | undefined;
let prevSubagent: string | undefined;

before(() => {
  prevHome = process.env.HOME;
  prevSubagent = process.env.AUTOGOO_SUBAGENT;
  delete process.env.AUTOGOO_SUBAGENT;
  tmpRoot = mkdtempSync(join(tmpdir(), "autogoo-entry-"));
  process.env.HOME = tmpRoot;
});

after(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevSubagent !== undefined) process.env.AUTOGOO_SUBAGENT = prevSubagent;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe("index.ts 激活", () => {
  it("激活不抛异常，并注册齐命令 / 工具 / 快捷键 / 事件", () => {
    const pi = makePi();
    assert.doesNotThrow(() => activate(pi));

    const commands = [...pi.commands.keys()];
    assert.ok(commands.length >= 14, `命令数应 ≥14，实际 ${commands.length}: ${commands.join(",")}`);
    for (const expected of [
      "goo-init",
      "goo-plan",
      "goo-start",
      "goo-status",
      "goo-observe",
      "goo-thread",
      "goo-chat",
      "goo-benchmark",
      "goo-continue",
    ]) {
      assert.ok(commands.includes(expected), `缺少命令 ${expected}`);
    }
    for (const [name, def] of pi.commands) {
      assert.equal(typeof def.handler, "function", `${name} 必须有 handler`);
      assert.ok(String(def.description ?? "").length > 0, `${name} 必须有 description`);
    }

    assert.ok(pi.tools.length >= 10, `工具数应 ≥10，实际 ${pi.tools.length}`);
    assert.ok(pi.shortcuts.has("alt+a"), "应注册 alt+a 快捷键");

    for (const event of ["input", "session_start", "session_shutdown", "before_agent_start"]) {
      assert.ok(pi.handlers.has(event), `应订阅 ${event} 事件`);
    }
  });

  it("普通输入直接放行（不吞掉用户消息）", async () => {
    const pi = makePi();
    activate(pi);
    const ctx = makeCtx(tmpRoot);
    const handler = pi.handlers.get("input")![0];
    const result = await handler({ text: "帮我写个测试" }, ctx);
    assert.deepEqual(result, { action: "continue" });
    assert.equal(ctx.notes.length, 0, "普通输入不应产生插件提示");
  });

  it("未知 /auto-goo: 命令给出明确提示而不是静默", async () => {
    const pi = makePi();
    activate(pi);
    const ctx = makeCtx(tmpRoot);
    const handler = pi.handlers.get("input")![0];
    const result = await handler({ text: "/auto-goo:goo-nope 参数" }, ctx);
    assert.deepEqual(result, { action: "handled" });
    assert.ok(ctx.notes.some((n: Note) => n.message.includes("未知命令")), "应提示未知命令");
  });

  it("/auto-goo:goo-benchmark 被路由到 handler（不落给 LLM）", async () => {
    const pi = makePi();
    activate(pi);
    const ctx = makeCtx(tmpRoot);
    const handler = pi.handlers.get("input")![0];
    const result = await handler({ text: "/auto-goo:goo-benchmark" }, ctx);
    assert.deepEqual(result, { action: "handled" });
    assert.ok(
      ctx.notes.some((n: Note) => n.message.includes("benchmark")),
      `应走到 benchmark handler，实际提示：${JSON.stringify(ctx.notes)}`,
    );
  });

  it("短命令 /goo-xxx 的 handler 也可调用", async () => {
    const pi = makePi();
    activate(pi);
    const ctx = makeCtx(tmpRoot);
    await pi.commands.get("goo-benchmark").handler("", ctx);
    assert.ok(ctx.notes.length >= 1, "短命令应产生可见输出");
  });

  it("before_agent_start 追加 AutoGoo 系统提示", async () => {
    const pi = makePi();
    activate(pi);
    const ctx = makeCtx(tmpRoot);
    const handler = pi.handlers.get("before_agent_start")![0];
    const result = await handler({ systemPrompt: "BASE" }, ctx);
    assert.ok(typeof result?.systemPrompt === "string");
    assert.ok(result.systemPrompt.startsWith("BASE"), "原有提示词必须保留");
    assert.ok(result.systemPrompt.length > "BASE".length, "应追加 AutoGoo 提示");
    assert.ok(/AutoGoo/.test(result.systemPrompt));
  });

  it("session_start 在空项目里不炸（无 plan / 无消息）", async () => {
    const pi = makePi();
    activate(pi);
    const cwd = mkdtempSync(join(tmpRoot, "sess-"));
    const ctx = makeCtx(cwd);
    for (const handler of pi.handlers.get("session_start")!) {
      await assert.doesNotReject(async () => handler({}, ctx));
    }
  });
});

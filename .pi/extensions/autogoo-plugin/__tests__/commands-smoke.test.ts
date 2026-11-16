/**
 * 命令 handler 冒烟测试 —— **每个 handler 至少跑一次**。
 *
 * 目标窄而明确：不验证业务细节（那要靠各模块自己的测试），只保证
 * 「入口被调用时不会抛未捕获异常、且给用户一个可见结果」。这类回归最贵：
 * 一个 handler 在解析参数时抛 TypeError，`/goo-xxx` 就直接把 pi 打挂，
 * 而之前 `commands/*` 的 2,400 行**没有任何测试碰过**。
 *
 * 为什么需要 loader 钩子：`commands/*` → `utils/*-panel` → `import { matchesKey }
 * from "@earendil-works/pi-tui"`，而这个包只在 pi 运行时注入，测试环境里
 * 不存在。`registerHooks` 把它解析到 `__tests__/stubs/pi-tui-stub.mjs`
 * （只替身 matchesKey/宽度函数，渲染断言仍打在 tui-kit 上，不会自证）。
 *
 * 隔离：
 * - `cwd` 一律指向临时目录，产物（.goo/）随用随删；
 * - `HOME` 指向临时目录，避免写到真实的 `~/.auto-goo`、`~/.claude`；
 * - `mode: "print"` + `hasUI: false`：所有对话框走 utils/ui.ts 的「非交互兜底」，
 *   不会挂住等人回答（这是 flaky 的主要来源）。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPiTuiStub } from "./helpers/pi-tui-hooks.js";

// ── 先把 pi-tui 解析到测试替身（必须早于任何对 commands/* 的 import） ─────────
installPiTuiStub();

// ── 被测 handler（动态 import：必须发生在 registerHooks 之后） ────────────────
const brainstorm = await import("../commands/brainstorm.js");
const chat = await import("../commands/chat.js");
const init = await import("../commands/init.js");
const other = await import("../commands/other.js");
const plan = await import("../commands/plan.js");
const start = await import("../commands/start.js");
const status = await import("../commands/status.js");
const subagent = await import("../commands/subagent.js");
const thread = await import("../commands/thread.js");
const toolsExec = await import("../commands/tools-execution.js");

const executeTool = await import("../tools/execute.js");
const monitorBg = await import("../tools/monitor-bg.js");
const ssh = await import("../tools/ssh.js");
const worktree = await import("../tools/worktree.js");

// ── ctx / pi 替身 ──────────────────────────────────────────────────────────

interface Note {
  message: string;
  type?: string;
}

function makeCtx(cwd: string, over: Record<string, any> = {}) {
  const notes: Note[] = [];
  const editor: string[] = [];
  const ui = {
    notify: (message: string, type?: string) => notes.push({ message, type }),
    setEditorText: (text: string) => editor.push(text),
    setStatus: () => {},
    setWidget: () => {},
    select: async () => undefined,
    input: async () => undefined,
    confirm: async () => false,
    custom: async () => undefined,
    ...(over.ui ?? {}),
  };
  const ctx: any = {
    cwd,
    mode: "print",
    hasUI: false,
    ui,
    sessionManager: { getSessionId: () => "sess-smoke-1", getSessionFile: () => null },
    model: { id: "test-model" },
    ...over,
  };
  ctx.notes = notes;
  ctx.editor = editor;
  return ctx;
}

function makePi() {
  const tools: any[] = [];
  const events: string[] = [];
  const messages: string[] = [];
  const pi: any = {
    registerTool: (def: any) => tools.push(def),
    on: (name: string) => events.push(name),
    sendUserMessage: (text: string) => messages.push(text),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
  pi.tools = tools;
  pi.events = events;
  pi.messages = messages;
  return pi;
}

const notified = (ctx: any): string => ctx.notes.map((n: Note) => n.message).join("\n");
const notedTypes = (ctx: any): string[] => ctx.notes.map((n: Note) => n.type ?? "");

// ── 环境隔离 ───────────────────────────────────────────────────────────────

let tmpRoot = "";
let prevHome: string | undefined;
let prevSubagentFlag: string | undefined;

function freshDir(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 结果必须与「谁在跑测试」无关：AutoGoo 自己的 Subagent 进程带
 * `AUTOGOO_SUBAGENT=1`，而该变量会改变 `registerExecutionTools` 注册哪些工具。
 * 不显式清掉它，同一份测试在主的 Agent 全绿、在 Subagent 里变红 —— 典型的环境型 flaky。
 */
function withSubagentFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.AUTOGOO_SUBAGENT;
  if (value === undefined) delete process.env.AUTOGOO_SUBAGENT;
  else process.env.AUTOGOO_SUBAGENT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AUTOGOO_SUBAGENT;
    else process.env.AUTOGOO_SUBAGENT = prev;
  }
}

before(() => {
  prevHome = process.env.HOME;
  prevSubagentFlag = process.env.AUTOGOO_SUBAGENT;
  delete process.env.AUTOGOO_SUBAGENT;
  tmpRoot = mkdtempSync(join(tmpdir(), "autogoo-smoke-"));
  process.env.HOME = tmpRoot;
});

after(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevSubagentFlag !== undefined) process.env.AUTOGOO_SUBAGENT = prevSubagentFlag;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

// ── commands/status.ts ─────────────────────────────────────────────────────

describe("handler: goo-status / goo-observe", () => {
  it("goo-status 在非 TUI 下退化为脚本输出，不抛异常", async () => {
    const ctx = makeCtx(freshDir("status-1"));
    await status.handleGooStatus("", ctx);
    assert.ok(ctx.notes.length >= 1, "至少给一条输出（状态或失败原因）");
    assert.ok(
      ["info", "warning", "error"].includes(notedTypes(ctx)[0]),
      `notify 类型应合法，实际 ${notedTypes(ctx)[0]}`,
    );
  });

  it("goo-observe 没有活动 plan 时给明确提示而不是崩", async () => {
    const ctx = makeCtx(freshDir("observe-1"));
    await other.handleGooObserve("", ctx);
    assert.ok(notified(ctx).includes("没有活动的 plan"), "应提示无 plan");
    assert.equal(notedTypes(ctx)[0], "warning");
  });

  it("openObservePanel 在非 TUI 下走文本兜底（不进 TUI 面板）", async () => {
    const ctx = makeCtx(freshDir("observe-2"));
    await status.openObservePanel(ctx, "env");
    assert.ok(ctx.notes.length >= 1);
  });
});

// ── commands/start.ts ──────────────────────────────────────────────────────

describe("handler: goo-start", () => {
  it("没有 plan 时提示先规划", async () => {
    const ctx = makeCtx(freshDir("start-1"));
    await start.handleGooStart("", ctx);
    assert.ok(notified(ctx).includes("未找到计划"));
  });

  it("plan 未确认时拒绝执行（不进入调度）", async () => {
    const cwd = freshDir("start-2");
    mkdirSync(join(cwd, ".goo"), { recursive: true });
    writeFileSync(
      join(cwd, ".goo", "plan.json"),
      JSON.stringify({
        task: "t",
        status: "pending",
        review: { status: "pending" },
        steps: [{ id: 1, name: "a", status: "pending", description: "d", depends_on: [] }],
      }),
      "utf-8",
    );
    const ctx = makeCtx(cwd);
    await start.handleGooStart("", ctx);
    assert.ok(notified(ctx).includes("计划尚未确认"), `实际：${notified(ctx)}`);
  });

  it("全部步骤已完成时说明无需执行", async () => {
    const cwd = freshDir("start-3");
    mkdirSync(join(cwd, ".goo"), { recursive: true });
    writeFileSync(
      join(cwd, ".goo", "plan.json"),
      JSON.stringify({
        task: "t",
        status: "completed",
        review: { status: "approved" },
        steps: [{ id: 1, name: "a", status: "completed", description: "d", depends_on: [] }],
      }),
      "utf-8",
    );
    const ctx = makeCtx(cwd);
    await start.handleGooStart("", ctx);
    assert.ok(notified(ctx).includes("所有步骤已完成"), `实际：${notified(ctx)}`);
  });
});

// ── commands/plan.ts ───────────────────────────────────────────────────────

describe("handler: goo-plan", () => {
  it("空任务描述时给用法提示", async () => {
    const ctx = makeCtx(freshDir("plan-1"));
    await plan.handleGooPlan("   ", ctx);
    assert.ok(notified(ctx).includes("请输入任务描述"));
    assert.equal(notedTypes(ctx)[0], "warning");
  });

  it("有任务描述时走完解析流程并落盘 plan（非 TUI 静默取消确认）", async () => {
    const cwd = freshDir("plan-2");
    const ctx = makeCtx(cwd);
    await plan.handleGooPlan("实现一个用户登录功能", ctx);
    // 不能崩；要么提示了召回/解析进展，要么说明已取消，且全程不抛
    assert.ok(ctx.notes.length >= 1, "应有用户可见输出");
    const planPath = join(cwd, ".goo", "plan.json");
    if (existsSync(planPath)) {
      const raw = JSON.parse(readFileSync(planPath, "utf-8"));
      assert.ok(Array.isArray(raw.steps), "落盘的 plan 必须含 steps 数组");
    }
  });
});

// ── commands/brainstorm.ts ─────────────────────────────────────────────────

describe("handler: goo-brainstorm", () => {
  it("空方向时给用法提示", async () => {
    const ctx = makeCtx(freshDir("bs-1"));
    await brainstorm.handleGooBrainstorm("", ctx);
    assert.ok(notified(ctx).includes("请输入头脑风暴的方向"));
  });
});

// ── commands/chat.ts ───────────────────────────────────────────────────────

describe("handler: goo-chat 系列", () => {
  it("goo-chat 参数不足给用法", async () => {
    const ctx = makeCtx(freshDir("chat-1"));
    await chat.handleGooChat("solo", ctx);
    assert.ok(notified(ctx).includes("用法: /goo-chat"));
  });

  it("goo-chat 给未配对目标时不投递、给出说明", async () => {
    const ctx = makeCtx(freshDir("chat-2"));
    await chat.handleGooChat("nobody hello", ctx);
    assert.ok(ctx.notes.length >= 1);
    assert.ok(!ctx.notes.some((n: Note) => n.type === "error") || notified(ctx).length > 0);
  });

  it("goo-pair 参数不足给用法", async () => {
    const ctx = makeCtx(freshDir("chat-3"));
    await chat.handleGooPair("only-one", ctx);
    assert.ok(notified(ctx).includes("用法"));
  });

  it("goo-unpair 参数不足给用法", async () => {
    const ctx = makeCtx(freshDir("chat-4"));
    await chat.handleGooUnpair("", ctx);
    assert.ok(notified(ctx).includes("用法"));
  });

  it("goo-chat-read 无未读时给提示", async () => {
    const ctx = makeCtx(freshDir("chat-5"));
    await chat.handleGooChatRead("", ctx);
    assert.ok(ctx.notes.length >= 1);
  });

  it("goo-chat-list 列出注册表（空也给出可见输出）", async () => {
    const ctx = makeCtx(freshDir("chat-6"));
    await chat.handleGooChatList("", ctx);
    assert.ok(ctx.notes.length >= 1);
  });

  it("goo-alias 修改本会话别名", async () => {
    const ctx = makeCtx(freshDir("chat-7"));
    await chat.handleGooAlias("me", ctx);
    assert.ok(ctx.notes.length >= 1);
  });
});

// ── commands/init.ts ───────────────────────────────────────────────────────

describe("handler: goo-init", () => {
  it("非 TUI 且无参数时按「推荐项兜底」完成初始化（不是卡住等人）", async () => {
    const cwd = freshDir("init-1");
    const ctx = makeCtx(cwd);
    await init.handleGooInit("", ctx);
    const text = notified(ctx);
    assert.ok(text.length > 0, "应有用户可见输出");
    // utils/ui.ts 的约定：非交互模式下 select 采用 (Recommended)，所以这里会真的初始化；
    // 断言的重点是「不会挂住 + 落盘内容可解析」，而不是某条具体提示文案。
    const cfgPath = join(cwd, ".goo", "config.json");
    assert.ok(existsSync(cfgPath), `应写入项目级配置，实际提示：${text.slice(0, 300)}`);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    assert.ok(typeof cfg.wiki_dir === "string" && cfg.wiki_dir.length > 0, "config 必须含 wiki_dir");
  });

  it("全参数脚本化时能落盘项目级配置", async () => {
    const cwd = freshDir("init-2");
    const wiki = freshDir("init-2-wiki");
    const ctx = makeCtx(cwd);
    await init.handleGooInit(
      `--project --wiki-dir ${wiki} --project-slug smoke --skip-claude-md --skip-user-pointer`,
      ctx,
    );
    assert.ok(ctx.notes.length >= 1);
    // 不强制要求成功（脚本可能因环境缺项退出），但必须有可见结论
    assert.ok(notified(ctx).trim().length > 0);
  });
});

// ── commands/other.ts ──────────────────────────────────────────────────────

describe("handler: goo-publish / research / improve / benchmark / continue", () => {
  it("goo-publish 在临时项目里生成站点（或在报错时给可见原因）", async () => {
    const cwd = freshDir("publish-1");
    const ctx = makeCtx(cwd);
    await other.handleGooPublish("", ctx);
    const text = notified(ctx);
    assert.ok(text.length > 0, "必须给出结果或失败原因");
    assert.ok(!text.includes("undefined"), "错误信息不应出现 undefined");
  });

  it("goo-research 空主题给用法", async () => {
    const ctx = makeCtx(freshDir("research-1"));
    await other.handleGooResearch("  ", ctx);
    assert.ok(notified(ctx).includes("请输入研究主题"));
  });

  it("goo-research 有主题时把提示词交给 agent（无 pi 时退回编辑器）", async () => {
    const ctx = makeCtx(freshDir("research-2"));
    await other.handleGooResearch("arXiv:2401.12345", ctx);
    assert.equal(ctx.editor.length, 1, "无 pi 实例时应写进编辑器");
    assert.ok(ctx.editor[0].includes("arXiv:2401.12345"));
  });

  it("goo-improve 发送自改进审查请求", async () => {
    const ctx = makeCtx(freshDir("improve-1"));
    await other.handleGooImprove("", ctx);
    assert.equal(ctx.editor.length, 1);
    assert.ok(ctx.editor[0].includes("自改进") || ctx.editor[0].includes("改进"));
  });

  it("goo-benchmark 空目标给用法，有目标则发送评测请求", async () => {
    const emptyCtx = makeCtx(freshDir("bench-1"));
    await other.handleGooBenchmark(" ", emptyCtx);
    assert.ok(notified(emptyCtx).includes("请输入 benchmark 目标"));

    const ctx = makeCtx(freshDir("bench-2"));
    await other.handleGooBenchmark("模型推理速度", ctx);
    assert.equal(ctx.editor.length, 1);
    assert.ok(ctx.editor[0].includes("模型推理速度"));
  });

  it("goo-continue 无 plan 时提示先规划", async () => {
    const ctx = makeCtx(freshDir("cont-1"));
    await other.handleGooContinue("", ctx);
    assert.ok(notified(ctx).includes("没有找到可恢复的计划"));
  });

  it("goo-continue 全部完成时说明无需恢复", async () => {
    const cwd = freshDir("cont-2");
    mkdirSync(join(cwd, ".goo"), { recursive: true });
    writeFileSync(
      join(cwd, ".goo", "plan.json"),
      JSON.stringify({
        task: "t",
        status: "completed",
        review: { status: "approved" },
        steps: [{ id: 1, name: "a", status: "completed", description: "d", depends_on: [] }],
      }),
      "utf-8",
    );
    const ctx = makeCtx(cwd);
    await other.handleGooContinue("", ctx);
    assert.ok(notified(ctx).includes("无需恢复"), `实际：${notified(ctx)}`);
  });
});

describe("handler: goo-usage / usage-analyse / daily-report（走真实脚本，慢路径）", () => {
  it("goo-usage 非 TUI 打印一次性统计", async () => {
    const ctx = makeCtx(freshDir("usage-1"));
    await other.handleGooUsage("", ctx);
    assert.ok(ctx.notes.length >= 1, "应有统计输出或失败原因");
  });

  it("goo-usage-analyse 归因并发送分析请求", async () => {
    const ctx = makeCtx(freshDir("usage-2"));
    await other.handleGooUsageAnalyse("", ctx);
    assert.ok(ctx.notes.length >= 1);
  });

  it("goo-daily-report 生成日报或给出失败原因", async () => {
    const ctx = makeCtx(freshDir("daily-1"));
    await other.handleGooDailyReport("", ctx);
    assert.ok(ctx.notes.length >= 1);
  });
});

// ── commands/subagent.ts ───────────────────────────────────────────────────

describe("handler: goo-subagent", () => {
  it("非 TUI 且无活动时给一行摘要", async () => {
    const ctx = makeCtx(freshDir("subagent-1"));
    await subagent.handleGooSubagent("", ctx);
    assert.ok(notified(ctx).includes("没有 subagent 活动") || ctx.notes.length >= 1);
  });
});

// ── commands/thread.ts ─────────────────────────────────────────────────────

describe("handler: goo-thread", () => {
  it("help 打印用法", async () => {
    const ctx = makeCtx(freshDir("thread-1"));
    await thread.handleGooThread("help", ctx);
    assert.ok(ctx.notes.length >= 1);
    assert.equal(notedTypes(ctx)[0], "info");
  });

  it("list 直接走脚本（非 TUI 也能用）", async () => {
    const ctx = makeCtx(freshDir("thread-2"));
    await thread.handleGooThread("list", ctx);
    assert.ok(ctx.notes.length >= 1, "应输出 thread 列表或失败原因");
  });
});

// ── 工具注册（tools/*.ts + commands/tools-execution.ts） ───────────────────

describe("工具注册冒烟", () => {
  it("registerExecutionTools 注册全部执行类工具并挂事件", () => {
    const pi = makePi();
    withSubagentFlag(undefined, () => toolsExec.registerExecutionTools(pi));
    const names = pi.tools.map((t: any) => t.name);
    for (const expected of [
      "auto_goo_update_step",
      "auto_goo_dag_status",
      "auto_goo_dispatch",
      "auto_goo_prepare_dispatch",
      "auto_goo_pending_steps",
    ]) {
      assert.ok(names.includes(expected), `缺少工具 ${expected}，实际 ${names.join(",")}`);
    }
    assert.ok(pi.events.includes("agent_start"), "应注册忙闲跟踪事件");
    for (const tool of pi.tools) {
      assert.equal(typeof tool.execute, "function", `${tool.name} 必须有 execute`);
      assert.ok(tool.parameters, `${tool.name} 必须有 parameters`);
    }
  });

  it("子进程模式（skipDispatch）不注册派发/调度工具，防递归调度", () => {
    const pi = makePi();
    withSubagentFlag(undefined, () => toolsExec.registerExecutionTools(pi, { skipDispatch: true }));
    const names = pi.tools.map((t: any) => t.name);
    assert.deepEqual(names.sort(), [
      "auto_goo_dag_status",
      "auto_goo_pending_steps",
      "auto_goo_update_step",
    ]);
    assert.ok(!names.includes("auto_goo_dispatch"), "Subagent 不应能再派发 DAG");
  });

  it("registerExecuteTool 注册 auto_goo_execute 且 schema 完整", () => {
    const pi = makePi();
    executeTool.registerExecuteTool(pi);
    const names = pi.tools.map((t: any) => t.name);
    assert.deepEqual(names, ["auto_goo_execute"]);
    assert.equal(typeof pi.tools[0].execute, "function");
  });

  it("registerSshTools 注册 3 个 ssh 工具", () => {
    const pi = makePi();
    ssh.registerSshTools(pi);
    const names = pi.tools.map((t: any) => t.name);
    assert.deepEqual(names.sort(), [
      "auto_goo_ssh_exec",
      "auto_goo_ssh_monitor",
      "auto_goo_ssh_status",
    ]);
  });

  it("registerMonitorBgTools 注册 3 个后台监控工具", () => {
    const pi = makePi();
    monitorBg.registerMonitorBgTools(pi);
    const names = pi.tools.map((t: any) => t.name);
    assert.equal(names.length, 3);
    assert.ok(names.every((n: string) => n.startsWith("auto_goo_ssh_monitor")));
  });

  it("registerWorktreeTools 注册 3 个 worktree 工具", () => {
    const pi = makePi();
    worktree.registerWorktreeTools(pi);
    const names = pi.tools.map((t: any) => t.name);
    assert.deepEqual(names.sort(), [
      "auto_goo_worktree_cleanup",
      "auto_goo_worktree_create",
      "auto_goo_worktree_merge",
    ]);
  });

  it("AUTOGOO_SUBAGENT=1 时自动跳过派发工具（无需显式 skipDispatch）", () => {
    const pi = makePi();
    withSubagentFlag("1", () => toolsExec.registerExecutionTools(pi));
    const names = pi.tools.map((t: any) => t.name);
    assert.ok(!names.includes("auto_goo_dispatch"), `Subagent 环境不应注册 dispatch，实际 ${names.join(",")}`);
    assert.ok(names.includes("auto_goo_update_step"), "状态更新工具仍应可用");
  });

  it("buildMonitorRemoteCmd / resolveServer 等导出未被注册逻辑破坏", () => {
    const cmd = ssh.buildMonitorRemoteCmd("sleep 1", 5);
    assert.equal(typeof cmd, "string");
    assert.ok(cmd.length > 0);
    assert.equal(typeof ssh.resolveServer, "function");
  });
});

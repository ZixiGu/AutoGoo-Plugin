/**
 * 观察面板 4 个 tab 的渲染测试（steps / overview / env / shell）。
 *
 * 面板类 `ObservePanel` 依赖 pi-tui 的 `matchesKey`（运行时注入），测试环境
 * 加载不了，所以渲染逻辑被抽到 `utils/observe-tabs.ts` 的纯函数里 —— 这里直接
 * 测纯函数。0.26.0 之前这段逻辑住在面板里，**从来没有被测试执行过**，
 * `ReferenceError: total is not defined` 因此能一路漏到线上把 pi 打挂。
 *
 * 宽度断言用的是本文件里**独立实现**的宽度计算器，而不是复用 `tui-kit` 的
 * `visibleWidth` —— 否则 `visibleWidth` 一旦少算 CJK/多算 ANSI，`fit()` 和断言
 * 会一起错，测试永远绿。为了防这种"自证"，`displayWidth` 自己的期望值被单独
 * 断言了一组（见「宽度计算器自检」）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeCounts,
  computeReady,
  progressOf,
  renderEnvTab,
  renderObserveBody,
  renderOverviewTab,
  renderShellTab,
  renderStepsTab,
} from "../utils/observe-tabs.js";

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 极简 theme stub：`theme.fg(token, text)` 必须原样返回 text。 */
const theme: any = new Proxy({}, { get: () => (_token: string, text: string) => text });

/** 独立宽度实现（不复用 tui-kit，避免 fit 与断言一起错）。 */
function displayWidth(text: string): number {
  const plain = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

const WIDTHS = [40, 60, 80, 120];

function assertNoOverflow(lines: string[], w: number, label: string): void {
  assert.ok(lines.length > 0, `${label}: 不应返回空数组（面板会显示成空白）`);
  lines.forEach((line, i) => {
    const width = displayWidth(line);
    assert.ok(
      width <= w,
      `${label} width=${w} 第 ${i} 行超宽 ${width} 列: ${JSON.stringify(line.slice(0, 60))}`,
    );
  });
}

/** 富数据快照：包含 CJK 长名、running 心跳、failed 长错误、依赖、shell 列表。 */
function richSnapshot(over: Record<string, any> = {}): any {
  return {
    root: "/home/someone/workspace/一个特别长的项目目录名字用来测试超宽",
    threadId: "tg-20261112-100210-整体优化-执行数据可信化-代码卫生-文档一致性-测试覆盖-数据生命周期",
    planPath: "/home/someone/.goo/threads/tg-20261112/plan.json",
    logsDir: "/home/someone/.goo/logs",
    shellLogDir: "/home/someone/.goo/logs/shell",
    claudeVersion: "1.2.3-beta.4+build.5678",
    planStatus: "running",
    task: "整体优化",
    steps: [
      { id: 1, name: "执行数据可信化 + DAG 收益量化", status: "completed", progress: 100 },
      {
        id: 2,
        name: "代码卫生：空 catch / 大文件 / 措辞",
        status: "running",
        progress: 40,
        heartbeat_at: new Date(Date.now() - 30_000).toISOString(),
        agent_id: "agent-abcdef123456",
        subagent: "implementer",
        log_path: ".goo/threads/tg-1/logs/step-2.log",
      },
      { id: 3, name: "文档-实现一致性自动化", status: "pending", progress: 0, depends_on: [1] },
      { id: 4, name: "测试覆盖 22% → 40%+", status: "pending", progress: 0, depends_on: [2, 3] },
      {
        id: 5,
        name: "数据生命周期管理（.goo 体积与增长）",
        status: "failed",
        progress: 10,
        error: "goo-gc.py 报错：".padEnd(240, "x"),
      },
      { id: 6, name: "端到端验证", status: "blocked", progress: 0, depends_on: [4] },
    ],
    shellLogs: [
      { path: "/home/someone/.goo/logs/shell/2026-11-04T15-49-07_some-very-long-command-name.log", tail: ["a", "b"] },
      { path: "/home/someone/.goo/logs/shell/b.log", tail: Array.from({ length: 12 }, (_, i) => `tail-${i}`) },
    ],
    commands: {
      status: "python3 skills/auto-goo/scripts/goo-status.py",
      observe: "python3 skills/auto-goo/scripts/goo-observe.py",
      shell_template: "bash long-task.sh 2>&1 | tee .goo/logs/shell/$(date +%Y-%m-%dT%H-%M-%S)_long-task.log",
    },
    recall: undefined,
    ...over,
  };
}

/** 空数据快照：任何 tab 都不能崩，也不能返回 []（面板高度会塌）。 */
function emptySnapshot(): any {
  return {
    root: "",
    threadId: null,
    planPath: "",
    logsDir: "",
    shellLogDir: "",
    claudeVersion: "",
    planStatus: "pending",
    task: "",
    steps: [],
    shellLogs: [],
    commands: {},
    recall: undefined,
  };
}

// ── 宽度计算器自检（防止「测试和实现一起错」） ──────────────────────────────

describe("displayWidth（测试用独立实现）", () => {
  it("CJK 算 2 列、ASCII 算 1 列、ANSI 算 0 列", () => {
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("中文"), 4);
    assert.equal(displayWidth("\x1b[31mab\x1b[0m"), 2);
    assert.equal(displayWidth("a中b"), 4);
    assert.equal(displayWidth(""), 0);
  });
});

// ── 4 个 tab × 4 种宽度：零超宽 ────────────────────────────────────────────

describe("observe-tabs 宽度不变式", () => {
  const tabs = ["steps", "overview", "exec", "env", "shell", "recall"] as const;

  it("富数据下 6 个 tab × 4 种宽度都不超宽", () => {
    for (const tab of tabs) {
      for (const w of WIDTHS) {
        const lines = renderObserveBody(richSnapshot(), {
          tab,
          width: w,
          theme,
          stepIndex: 1,
          shellIndex: 1,
          logLines: ["2026-11-16 心跳 ok", "执行 python3 update-step.py --complete …"],
        });
        assertNoOverflow(lines, w, `rich/${tab}`);
      }
    }
  });

  it("空数据下 6 个 tab × 4 种宽度都不超宽", () => {
    for (const tab of tabs) {
      for (const w of WIDTHS) {
        const lines = renderObserveBody(emptySnapshot(), { tab, width: w, theme });
        assertNoOverflow(lines, w, `empty/${tab}`);
      }
    }
  });

  it("超长单值（路径 / 错误 / shell 模板）在窄屏不撑破", () => {
    const snap = richSnapshot({
      root: "/" + "很长的路径段/".repeat(30),
      shellLogDir: "/tmp/" + "x".repeat(200),
    });
    snap.steps[0].error = "✗ ".repeat(120);
    for (const w of WIDTHS) {
      for (const tab of tabs) {
        assertNoOverflow(renderObserveBody(snap, { tab, width: w, theme, stepIndex: 0 }), w, `huge/${tab}`);
      }
    }
  });

  it("最小可用宽度 20 列不崩、不超宽", () => {
    for (const tab of tabs) {
      assertNoOverflow(renderObserveBody(richSnapshot(), { tab, width: 20, theme }), 20, `min/${tab}`);
    }
  });
});

// ── steps tab ──────────────────────────────────────────────────────────────

describe("renderStepsTab", () => {
  it("没有步骤时给提示而不是空白", () => {
    const lines = renderStepsTab(emptySnapshot(), 80, theme, 0);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("没有 plan 步骤"));
  });

  it("渲染进度条与百分比（1/6 完成 → 17%）", () => {
    const lines = renderStepsTab(richSnapshot(), 100, theme, 0).join("\n");
    assert.ok(lines.includes("17%"), `应显示 17%，实际：${lines.slice(0, 120)}`);
  });

  it("选中的步骤带 › 标记，未选中的不带", () => {
    const lines = renderStepsTab(richSnapshot(), 100, theme, 1);
    const row = lines.find((l) => l.includes("代码卫生"));
    assert.ok(row, "应渲染选中步骤行");
    assert.ok(row!.includes("›"), "选中行应有 › 标记");
    const other = lines.find((l) => l.includes("文档-实现一致性"));
    assert.ok(other && !other.includes("›"), "未选中行不应有 › 标记");
  });

  it("选中项超出窗口时自动滚动到可见（不再停在第一屏）", () => {
    // 窗口 10 步，选中第 12 步 —— 若无滚动，选中行根本不在输出里
    const snap = richSnapshot();
    snap.steps = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      name: `步骤 ${i + 1}`,
      status: "pending",
      progress: 0,
    }));
    const lines = renderStepsTab(snap, 100, theme, 11).join("\n");
    assert.ok(lines.includes("步骤 12"), `选中项应可见，实际：${lines.slice(0, 200)}`);
    assert.ok(!lines.includes("步骤 1 "), "第一屏内容应已滚出窗口");
  });

  it("详情显示 subagent / agent / 心跳 / 错误", () => {
    const lines = renderStepsTab(richSnapshot(), 120, theme, 1).join("\n");
    assert.ok(lines.includes("subagent=implementer"));
    assert.ok(lines.includes("agent=agent-abcdef123456"));
    assert.ok(lines.includes("hb="), "应显示心跳相对时间");
    assert.ok(lines.includes("status=running"));
  });

  it("失败步骤的错误原文可见（截断但不吞掉）", () => {
    const lines = renderStepsTab(richSnapshot(), 80, theme, 4).join("\n");
    assert.ok(lines.includes("goo-gc.py 报错"), "错误文本必须出现在详情里");
    assert.ok(lines.includes("✗"), "失败标记应可见");
  });

  it("有 log 时显示尾部（最多 4 行），无 log 时不多一行标题", () => {
    const withLog = renderStepsTab(richSnapshot(), 100, theme, 1, [
      "l1", "l2", "l3", "l4", "l5", "l6",
    ]).join("\n");
    assert.ok(withLog.includes("log 尾部"), "应显示 log 标题");
    assert.ok(withLog.includes("l6"), "应显示最后一行");
    assert.ok(!withLog.includes("l2"), "超出 4 行预算的旧行应被裁掉");

    const without = renderStepsTab(richSnapshot(), 100, theme, 1, []).join("\n");
    assert.ok(!without.includes("log 尾部"), "没有 log 时不应出现空标题");
  });

  it("窄屏（<60 列）退化为紧凑行，不丢状态标记", () => {
    const lines = renderStepsTab(richSnapshot(), 40, theme, 1).join("\n");
    assert.ok(lines.includes("►"), "running 状态标记应可见");
    assert.ok(lines.includes("status=running"), "详情段宽带后仍保留可读的 status");
    // 宽带专属的 status/progress 列不应出现在列表行里（窄屏只有标记 + 名称）
    assert.ok(!/  running .*40%/.test(lines), "窄屏不应渲染完整宽带表格");
  });
});

// ── overview tab ───────────────────────────────────────────────────────────

describe("renderOverviewTab", () => {
  it("各状态计数与实际步骤一致", () => {
    const text = renderOverviewTab(richSnapshot(), 120, theme).join("\n");
    assert.ok(text.includes("completed"), "应列出 completed");
    assert.ok(/completed\s+1/.test(text), "completed 计数应为 1");
    assert.ok(/failed\s+1/.test(text), "failed 计数应为 1");
    assert.ok(/blocked\s+1/.test(text), "blocked 计数应为 1");
  });

  it("ready / waiting 按 depends_on 计算（#3 就绪，#4 等待；blocked 不计入 waiting）", () => {
    const text = renderOverviewTab(richSnapshot(), 120, theme).join("\n");
    assert.ok(text.includes("1 / 1"), `应为 ready=1 waiting=1，实际：${text.slice(0, 400)}`);
  });

  it("Next 三种分支：可派发 / 无就绪 / 全部完成", () => {
    const ready = renderOverviewTab(richSnapshot(), 120, theme).join("\n");
    assert.ok(ready.includes("1 步可派发"), "有就绪步骤时应说可派发");

    const noReady = richSnapshot();
    noReady.steps = [
      { id: 1, name: "a", status: "pending", progress: 0, depends_on: [9] },
      { id: 2, name: "b", status: "pending", progress: 0, depends_on: [1] },
    ];
    assert.ok(renderOverviewTab(noReady, 120, theme).join("\n").includes("无就绪步骤（依赖未满足）"));

    const allDone = richSnapshot();
    allDone.steps = allDone.steps.map((s: any) => ({ ...s, status: "completed" }));
    assert.ok(renderOverviewTab(allDone, 120, theme).join("\n").includes("全部完成"));
  });

  it("没有步骤时 Next 给出解释而不是空白", () => {
    const text = renderOverviewTab(emptySnapshot(), 80, theme).join("\n");
    assert.ok(text.includes("没有 plan 步骤"));
    assert.ok(text.includes("pending"), "即使全零也应列出状态行");
  });

  it("进度百分比与 plan 状态如实反映", () => {
    const text = renderOverviewTab(richSnapshot(), 120, theme).join("\n");
    assert.ok(text.includes("running"), "plan status 应显示");
    assert.ok(text.includes("17%"), "进度应显示 17%");
  });
});

// ── env tab ────────────────────────────────────────────────────────────────

describe("renderEnvTab", () => {
  it("显示 root / plan / logs / claude 等路径", () => {
    const text = renderEnvTab(richSnapshot(), 120, theme).join("\n");
    for (const needle of ["root", "thread", "plan", "logs", "shell logs", "claude", "1.2.3-beta.4"]) {
      assert.ok(text.includes(needle), `env 应包含 ${needle}`);
    }
  });

  it("列出常用命令，但 shell_template 单独成段（不进键值列表）", () => {
    const text = renderEnvTab(richSnapshot(), 120, theme).join("\n");
    assert.ok(text.includes("goo-status.py"));
    assert.ok(text.includes("goo-observe.py"));
    assert.ok(text.includes("shell 跟踪模板"), "模板应有单独标题");
    const listed = text.split("\n").filter((l) => l.includes("shell_template"));
    assert.equal(listed.length, 0, "shell_template 不应作为普通命令键出现");
  });

  it("空快照用 - 占位，不显示 undefined", () => {
    const text = renderEnvTab(emptySnapshot(), 100, theme).join("\n");
    assert.ok(!text.includes("undefined"), "缺失字段应显示 -");
    assert.ok(text.includes("-"));
  });
});

// ── shell tab ──────────────────────────────────────────────────────────────

describe("renderShellTab", () => {
  it("目录为空时给 tee 模板提示", () => {
    const snap = emptySnapshot();
    snap.commands = { shell_template: "bash x.sh | tee .goo/logs/shell/x.log" };
    const text = renderShellTab(snap, 100, theme, 0).join("\n");
    assert.ok(text.includes("暂无 *.log"));
    assert.ok(text.includes("tee"), "应提示用 tee 跟踪长任务");
  });

  it("列表只显示文件名（不显示完整路径），选中项带 ›", () => {
    const lines = renderShellTab(richSnapshot(), 120, theme, 1);
    const text = lines.join("\n");
    assert.ok(text.includes("b.log"), "应显示文件名");
    assert.ok(!text.includes("/home/someone/.goo/logs/shell/b.log"), "不应显示完整路径");
    const active = lines.find((l) => l.includes("b.log"));
    assert.ok(active!.includes("›"), "选中项应有 › 标记");
  });

  it("尾部最多 6 行，取最后 6 行", () => {
    const text = renderShellTab(richSnapshot(), 120, theme, 1).join("\n");
    assert.ok(text.includes("tail-11"), "最后一行应可见");
    assert.ok(!text.includes("tail-5"), "超出 6 行预算的旧行应被裁掉");
  });

  it("选中项超出窗口时自动滚动", () => {
    const snap = richSnapshot();
    snap.shellLogs = Array.from({ length: 12 }, (_, i) => ({ path: `/l/log-${i}.log`, tail: [] }));
    const text = renderShellTab(snap, 100, theme, 10).join("\n");
    assert.ok(text.includes("log-10.log"), "选中项应滚入可视窗口");
  });
});

// ── 纯计算 ─────────────────────────────────────────────────────────────────

describe("computeCounts / progressOf / computeReady", () => {
  it("computeCounts 累计每种状态", () => {
    assert.deepEqual(
      computeCounts([
        { id: 1, name: "a", status: "completed", progress: 100 },
        { id: 2, name: "b", status: "completed", progress: 100 },
        { id: 3, name: "c", status: "running", progress: 50 },
      ]),
      { completed: 2, running: 1 },
    );
  });

  it("progressOf 在 0 步时返回 0 而不是 NaN", () => {
    assert.deepEqual(progressOf([]), { total: 0, done: 0, pct: 0 });
    assert.equal(progressOf([{ id: 1, name: "a", status: "completed", progress: 100 }]).pct, 100);
  });

  it("computeReady 只统计 pending，且字符串/数字依赖 id 互通", () => {
    const r = computeReady([
      { id: "s1", name: "a", status: "completed", progress: 100 },
      { id: 2, name: "b", status: "pending", progress: 0, depends_on: ["s1"] },
      { id: 3, name: "c", status: "pending", progress: 0, depends_on: ["s1", 2] },
      { id: 4, name: "d", status: "pending", progress: 0 },
      { id: 5, name: "e", status: "running", progress: 10 },
    ]);
    assert.deepEqual(r, { ready: 2, waiting: 1 });
  });
});

describe("renderObserveBody", () => {
  it("非法 tab 退化为一行错误提示而不是抛异常", () => {
    const lines = renderObserveBody(richSnapshot(), { tab: "nope" as any, width: 60, theme });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("未知 tab"));
  });

  it("recall tab 转交给 renderRecallTab（无统计时给提示）", () => {
    const lines = renderObserveBody(emptySnapshot(), { tab: "recall", width: 60, theme });
    assert.ok(lines.join("\n").includes("还没有召回记录"));
  });

  it("exec tab 转交给 renderExecTab（无指标时给提示而不是空白）", () => {
    const lines = renderObserveBody(emptySnapshot(), { tab: "exec", width: 60, theme });
    assert.ok(lines.length >= 1);
    assert.ok(lines.join("\n").includes("执行事件"));
  });
});

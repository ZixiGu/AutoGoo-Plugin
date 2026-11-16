/**
 * 观察面板的数据契约 —— **纯类型 + 纯常量，零运行时依赖**。
 *
 * 为什么单独成文件：`observe-panel.ts` 顶部 `import { matchesKey } from "@earendil-works/pi-tui"`，
 * 而 pi-tui 只在 pi 运行时注入。任何 `import` 到 observe-panel 的**运行时**符号
 * （哪怕是只想拿个 interface）都会把 pi-tui 一起拉进来，导致 node:test 里
 * `Cannot find package`，面板渲染于是永远无法被测。
 *
 * 拆分后：类型走本文件（`import type` 会被完全擦除），渲染走 `observe-tabs.ts`
 * （只依赖自包含的 `tui-kit.ts`），只有真正需要 TUI 的 `ObservePanel` 类留在
 * observe-panel.ts。
 */

import type { RecallStats } from "./recall-observe.js";
import type { ExecStats } from "./exec-observe.js";

export interface ObserveStep {
  id: number | string;
  name: string;
  status: string;
  progress: number;
  heartbeat_at?: string | null;
  agent_id?: string | null;
  error?: string | null;
  log_path?: string | null;
  subagent?: string | null;
  task_agent?: string | null;
  /** DAG 依赖；overview 的 ready/waiting 判定需要它 */
  depends_on?: Array<number | string> | null;
}

export interface ObserveShellLog {
  path: string;
  mtime?: number;
  tail: string[];
}

export interface ObserveSnapshot {
  root: string;
  threadId?: string | null;
  planPath: string;
  logsDir: string;
  shellLogDir: string;
  claudeVersion?: string;
  planStatus: string;
  task: string;
  steps: ObserveStep[];
  shellLogs: ObserveShellLog[];
  commands?: Record<string, string>;
  /** 召回观测统计（来自 .goo/logs/recall.jsonl） */
  recall?: RecallStats;
  /** 执行观测统计（来自 .goo/logs/exec.jsonl） */
  exec?: ExecStats;
}

export type ObserveTab = "steps" | "overview" | "exec" | "recall" | "env" | "shell";

/**
 * tab 顺序即 `1`-`5` 快捷键顺序，也是 `ObservePanel.tabIndex` 的唯一含义来源。
 * 放这里是为了让 `observe-tabs.ts` 的纯渲染函数（含 tab 栏）与面板共用同一份顺序。
 */
/**
 * `exec` 紧跟 overview：它回答的是同一类问题（"现在卡住了吗"），
 * 只是带了耗时/超时/重试的量化证据。
 */
export const TAB_ORDER: ObserveTab[] = ["steps", "overview", "exec", "recall", "env", "shell"];

/** 状态计数：`{completed: 2, running: 1, ...}`。 */
export type ObserveCounts = Record<string, number>;

export type ObserveAction = { action: "quit" } | { action: "refresh" };

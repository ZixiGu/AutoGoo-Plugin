/**
 * AutoGoo-Plugin Write-Conflict Isolation — 写冲突从「告警」升级为「隔离」
 *
 * 背景（实测）：0.30.0 的 `detectWriteConflicts` **只告警不隔离**。一轮 4 个并行
 * 步骤的写范围全部重叠（check-plugin.sh 被 4 步同时改），靠运气没冲突（各改不同
 * 节）—— 若两个 subagent 改同一函数相邻行，后者直接覆盖前者且不报错。
 * 同时 `auto_goo_worktree_create/_merge/_cleanup` 三个工具早已实现（含
 * `git merge --abort` 处理），但**从未接入派发路径**，能力闲置。
 *
 * 本模块把隔离能力接到派发路径上，边界如下：
 *   1. **开关默认关闭**（`config.execution.worktree_isolation`）。关闭时调用方不得
 *      产生任何 git 子进程 —— 零额外成本、零回归。
 *   2. **只有写范围重叠的步骤**才分配独立 worktree；无冲突时整批走原有路径。
 *   3. **创建失败降级为串行**，不是整批失败；非 git 项目 / 脏工作树同样降级。
 *   4. **合并冲突必须报告**：`git merge --abort` 只回滚主分支的合并状态，
 *      worktree 目录与分支**原样保留**，两侧改动都在，交人裁决。
 *   5. 合并失败可恢复：状态落盘 `.goo/worktrees/step-<id>.json`，分支不删。
 *
 * 为什么不是「自动串行」：自动串行会显著拖慢本就该并行的任务，所以开关默认关闭；
 * 打开开关的人明确要「并行 + 隔离」，而不是「并行 + 静默覆盖」。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./exec.js";

// ── 配置 ────────────────────────────────────────────────────────────────────

/** worktree 根目录（相对项目根，随 .goo/ 一起被 gitignore）。 */
export const WORKTREE_ROOT = ".goo/worktrees";

export interface IsolationDecision {
  enabled: boolean;
  /** 判定理由，会写进派发报告 —— 拒绝「开关打开了但其实没生效」的静默态。 */
  reason: string;
  raw?: unknown;
}

/**
 * 布尔型开关的宽松解析。
 *
 * 为什么宽松：`.goo/config.json` 是人手写的，`true` / `"true"` / `"on"` / `1`
 * 都表达「开」。反过来 `false` / `"false"` / `"off"` / `0` / `null` / 缺失 = 关。
 * **不认识的字符串按「关」处理**并给出理由 —— 配置写错时静默打开 worktree
 * 会给所有任务加开销，比静默忽略更糟。
 */
export function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes" || v === "enable" || v === "enabled";
}

/** 从 `config.execution` 解析隔离开关（默认关闭）。 */
export function resolveWorktreeIsolation(executionCfg: any): IsolationDecision {
  const raw = executionCfg?.worktree_isolation;
  if (raw === undefined || raw === null || raw === "" || raw === false) {
    return { enabled: false, reason: "config.execution.worktree_isolation 未开启（默认关闭）", raw };
  }
  if (isTruthyFlag(raw)) {
    return { enabled: true, reason: "config.execution.worktree_isolation 已开启", raw };
  }
  return { enabled: false, reason: `config.execution.worktree_isolation=${JSON.stringify(raw)} 无法识别为开启，按关闭处理`, raw };
}

// ── 分组：谁需要独立 worktree ────────────────────────────────────────────────

/** `detectWriteConflicts` 的返回项（只依赖结构与 id/overlap，便于单测）。 */
export interface ConflictPair {
  a: { id: any };
  b: { id: any };
  overlap: string[];
}

export interface ConflictCluster {
  /** 冲突簇内所有 step id（字符串化，稳定排序便于断言） */
  stepIds: string[];
  /** 簇内出现过的重叠路径（去重，最多保留 5 条便于报告） */
  overlap: string[];
}

/**
 * 把两两冲突合并成「连通簇」（union-find）。
 *
 * 为什么必须成簇而不是逐对处理：三步 A∩B、B∩C 但 A∦C 时，逐对只会给 A/B、B/C
 * 建 worktree 而漏掉「A 和 C 其实通过 B 关联」的整组隔离语义；成簇后簇内**每一步**
 * 都拿独立 worktree，簇间可安全并行。
 */
export function clusterWriteConflicts(conflicts: ConflictPair[]): ConflictCluster[] {
  const parent = new Map<string, string>();
  const overlaps = new Map<string, Set<string>>();

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    // 路径压缩
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const ensure = (id: string) => {
    if (!parent.has(id)) {
      parent.set(id, id);
      overlaps.set(id, new Set());
    }
  };

  for (const c of conflicts) {
    const a = String(c.a?.id);
    const b = String(c.b?.id);
    if (a === b) continue;
    ensure(a);
    ensure(b);
    for (const o of c.overlap ?? []) {
      overlaps.get(a)?.add(String(o));
      overlaps.get(b)?.add(String(o));
    }
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const list = groups.get(root) ?? [];
    list.push(id);
    groups.set(root, list);
  }

  return [...groups.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => {
      const overlapSet = new Set<string>();
      for (const id of ids) for (const o of overlaps.get(id) ?? []) overlapSet.add(o);
      return {
        stepIds: [...ids].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })),
        overlap: [...overlapSet].sort().slice(0, 5),
      };
    })
    .sort((x, y) => x.stepIds[0].localeCompare(y.stepIds[0], undefined, { numeric: true }));
}

/** 需要独立 worktree 的 step id 集合（去重、稳定排序）。 */
export function stepsNeedingIsolation(conflicts: ConflictPair[]): string[] {
  const out = new Set<string>();
  for (const c of clusterWriteConflicts(conflicts)) for (const id of c.stepIds) out.add(id);
  return [...out].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
}

/**
 * 合并顺序：按依赖拓扑排序（被依赖的步骤先并入主分支）。
 *
 * 为什么不能按数组顺序：`depends_on` 表达的是「后一步的产物基于前一步」，
 * 乱序合并会让后一步的改动先落进主分支，前一步再合并时冲突概率更高、
 * 语义也更乱。同层按 id 数字顺序，保证结果可复现。
 */
export function orderStepsForMerge(
  stepIds: string[],
  steps: Array<{ id: any; depends_on?: any[] }>,
): string[] {
  const set = new Set(stepIds);
  const deps = new Map<string, string[]>();
  for (const s of steps) {
    const id = String(s.id);
    if (!set.has(id)) continue;
    deps.set(id, (s.depends_on ?? []).map(String).filter((d) => set.has(d)));
  }
  for (const id of set) if (!deps.has(id)) deps.set(id, []);

  const out: string[] = [];
  const done = new Set<string>();
  const cmp = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true });
  // Kahn：每轮取所有依赖已完成的节点，按 id 排序保证确定性。
  while (out.length < deps.size) {
    const layer = [...deps.keys()]
      .filter((id) => !done.has(id) && deps.get(id)!.every((d) => done.has(d)))
      .sort(cmp);
    if (layer.length === 0) {
      // 有环（正常 plan 会被 validatePlan 拦住）→ 剩下的按 id 兜底，不丢步骤
      const rest = [...deps.keys()].filter((id) => !done.has(id)).sort(cmp);
      out.push(...rest);
      break;
    }
    for (const id of layer) {
      out.push(id);
      done.add(id);
    }
  }
  return out;
}

// ── Git 基础操作 ────────────────────────────────────────────────────────────

/** 项目是否是可用的 git 仓库（有 .git 且 HEAD 可解析）。 */
export function isGitRepo(cwd: string): boolean {
  const r = exec("git", ["rev-parse", "--verify", "HEAD"], cwd, { timeout: 5000 });
  return r.exitCode === 0;
}

/** 当前分支名（detached HEAD 时返回空串，调用方用 HEAD 作为 base）。 */
export function currentBranch(cwd: string): string {
  const r = exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd, { timeout: 5000 });
  const name = (r.stdout || "").trim();
  return r.exitCode === 0 && name !== "HEAD" ? name : "";
}

/**
 * 是否存在**已跟踪文件**的未提交改动。
 *
 * 为什么这层守卫是必需的：`git worktree add` 只会把 **HEAD 提交**检出到新目录，
 * 主工作树里的未提交改动不会带过去。若在脏树上开隔离，subagent 看到的是旧代码，
 * 而它的产物合并回来又基于旧基线 —— 静默丢改动，比不隔离更危险。
 * 未跟踪文件不影响（它们同样不进 worktree，但新建产物本来就该由本步产生）。
 */
export function hasDirtyTrackedFiles(cwd: string): boolean {
  const r = exec("git", ["status", "--porcelain", "--untracked-files=no"], cwd, { timeout: 10000 });
  if (r.exitCode !== 0) return true; // 判断不了就保守当脏
  return (r.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l.length > 0);
}

// ── 状态落盘（可恢复的关键） ─────────────────────────────────────────────────

export type MergeState = "pending" | "merged" | "no_changes" | "conflict" | "failed" | "cleaned";

export interface StepWorktreeState {
  stepId: string;
  branch: string;
  worktreeDir: string;
  baseRef: string;
  createdAt: string;
  mergeState: MergeState;
  mergedAt?: string;
  conflictFiles?: string[];
  error?: string;
}

export function worktreeDirFor(cwd: string, stepId: string | number): string {
  return join(cwd, WORKTREE_ROOT, `step-${stepId}`);
}

export function worktreeStatePath(cwd: string, stepId: string | number): string {
  return join(cwd, WORKTREE_ROOT, `step-${stepId}.json`);
}

export function readWorktreeState(cwd: string, stepId: string | number): StepWorktreeState | null {
  const p = worktreeStatePath(cwd, stepId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as StepWorktreeState;
  } catch {
    return null; // 状态文件损坏 → 当作没有；worktree 目录存在性另有判断
  }
}

function writeWorktreeState(cwd: string, state: StepWorktreeState): void {
  const p = worktreeStatePath(cwd, state.stepId);
  mkdirSync(join(cwd, WORKTREE_ROOT), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

/** 合并报告：`.goo/worktrees/merge-report.json`（每次合并追加一条）。 */
function appendMergeReport(cwd: string, entry: Record<string, unknown>): void {
  const dir = join(cwd, WORKTREE_ROOT);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "merge-report.json");
  let list: unknown[] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      /* 报告损坏 → 重开一个新数组，不阻塞合并流程 */
    }
  }
  list.push(entry);
  writeFileSync(file, JSON.stringify(list, null, 2), "utf-8");
}

/** 冲突处置指引（人裁决时直接照着做）。 */
function writeConflictGuide(cwd: string, outcomes: MergeOutcome[]): string {
  const dir = join(cwd, WORKTREE_ROOT);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "CONFLICTS.md");
  const lines = [
    "# Worktree 合并冲突（需人工裁决）",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    "两侧改动都保留：主分支已 `git merge --abort` 回到合并前状态，worktree 目录与分支未删除。",
    "下面每一条给出可直接复制执行的命令。",
    "",
  ];
  for (const o of outcomes) {
    if (o.status !== "conflict") continue;
    // 不用嵌套模板字符串（`.` 内再套 `.`）：静态符号检查器会把内层反引号当成
    // 外层模板的结束，导致后续注释/代码被误判（本项目 check-ts-symbols.py 实测命中）。
    const quoted = o.conflictFiles.map((f) => "`" + f + "`").join(", ");
    lines.push(`## step #${o.stepId}`);
    lines.push("");
    lines.push(`- 分支：${o.branch}`);
    lines.push(`- worktree：${o.worktreeDir}`);
    lines.push(`- 冲突文件：${quoted || "(未取到文件列表，见分支 diff)"}`);
    lines.push("");
    lines.push("```bash");
    lines.push(`# 1) 在主工程合并该分支，按提示解决冲突`);
    lines.push(`git merge --no-ff ${o.branch}`);
    lines.push(`# 2) 解决后提交，再清理 worktree`);
    lines.push(`git worktree remove -f ${o.worktreeDir} && git branch -D ${o.branch}`);
    lines.push("```");
    lines.push("");
  }
  writeFileSync(file, lines.join("\n"), "utf-8");
  return file;
}

// ── 创建 ────────────────────────────────────────────────────────────────────

export interface CreateWorktreeResult {
  ok: boolean;
  state?: StepWorktreeState;
  error?: string;
}

/**
 * 把主工程的 `.goo/` 链接进 worktree。
 *
 * **为什么必须做**：`.goo/` 被 gitignore，`git worktree add` 不会带过去。而 Subagent
 * 的 `auto_goo_update_step` 用 `projectPlanPath(cwd)` 定位 plan —— 不链接的话它会去
 * `<worktree>/.goo/plan.json` 找，找不到就无法 `--complete`，整个隔离路径会退化成
 * 「subagent 跑完但状态写不回去」。链接后：代码改动留在 worktree，plan / 日志 /
 * artifacts 仍写主工程 `.goo/`（与不隔离时的共享语义一致）。
 *
 * 返回 false 时调用方必须丢弃这个 worktree（fail closed），不能带着坏环境跑。
 */
export function linkSharedGooDir(cwd: string, worktreeDir: string): boolean {
  const target = join(cwd, ".goo");
  const linkPath = join(worktreeDir, ".goo");
  if (!existsSync(target)) return true; // 主工程没有 .goo（尚未初始化）→ 无需链接
  if (existsSync(linkPath)) return true; // 已被跟踪或已链接
  try {
    symlinkSync(target, linkPath, "dir");
    return true;
  } catch {
    return false;
  }
}

/**
 * 为一个 step 创建独立 worktree。
 *
 * 失败一律返回 `ok:false` + `error`，由调用方**降级为串行**，绝不抛异常打断整批派发。
 */
export function createStepWorktree(
  cwd: string,
  stepId: string | number,
  opts: { baseRef?: string } = {},
): CreateWorktreeResult {
  if (!isGitRepo(cwd)) {
    return { ok: false, error: "项目不是 Git 仓库或 HEAD 不可解析（非 git 项目降级）" };
  }
  if (hasDirtyTrackedFiles(cwd)) {
    return { ok: false, error: "主工作树存在未提交的已跟踪文件改动，worktree 只检出 HEAD，会丢改动（降级）" };
  }

  const baseRef = opts.baseRef || "HEAD";
  const branch = `autogoo-plugin/step-${stepId}-${Date.now()}`;
  const worktreeDir = worktreeDirFor(cwd, stepId);
  mkdirSync(join(cwd, WORKTREE_ROOT), { recursive: true });

  // 同 step 的残留 worktree：先摘掉，避免 `git worktree add` 因目录已存在失败。
  if (existsSync(worktreeDir)) {
    exec("git", ["worktree", "remove", "-f", worktreeDir], cwd, { timeout: 15000 });
  }
  const stale = readWorktreeState(cwd, stepId);
  if (stale?.branch) {
    exec("git", ["branch", "-D", stale.branch], cwd, { timeout: 10000 });
  }

  const add = exec("git", ["worktree", "add", "-b", branch, worktreeDir, baseRef], cwd, { timeout: 30000 });
  if (add.exitCode !== 0) {
    // 半成品清理：目录可能已建但 checkout 失败
    exec("git", ["worktree", "remove", "-f", worktreeDir], cwd, { timeout: 15000 });
    exec("git", ["branch", "-D", branch], cwd, { timeout: 10000 });
    const msg = `${(add.stderr || add.stdout || "").trim().split("\n").slice(-2).join(" ")}`.slice(0, 300);
    return { ok: false, error: `git worktree add 失败: ${msg || `exit ${add.exitCode}`}` };
  }

  // `.goo/` 必须共享，否则 Subagent 无法回写 plan（详见 linkSharedGooDir 注释）。
  // 链接失败 = 隔离环境不可用 → 丢弃 worktree 并降级，绝不带着坏环境跑。
  if (!linkSharedGooDir(cwd, worktreeDir)) {
    exec("git", ["worktree", "remove", "-f", worktreeDir], cwd, { timeout: 15000 });
    exec("git", ["branch", "-D", branch], cwd, { timeout: 10000 });
    return { ok: false, error: `无法把 .goo/ 链接进 worktree（${worktreeDir}/.goo），Subagent 将无法回写 plan（降级）` };
  }

  const state: StepWorktreeState = {
    stepId: String(stepId),
    branch,
    worktreeDir,
    baseRef,
    createdAt: new Date().toISOString(),
    mergeState: "pending",
  };
  writeWorktreeState(cwd, state);
  return { ok: true, state };
}

// ── 合并 ────────────────────────────────────────────────────────────────────

export interface MergeOutcome {
  stepId: string;
  status: MergeState;
  branch: string;
  worktreeDir: string;
  /** 真冲突时 `git diff --diff-filter=U` 列出的文件 */
  conflictFiles: string[];
  error?: string;
  /** 是否已清理 worktree（只有成功/无改动才清理；冲突必须保留） */
  cleaned: boolean;
  /** `git status --porcelain` 是否有改动 */
  hasChanges: boolean;
}

function unmergedFiles(cwd: string): string[] {
  const r = exec("git", ["diff", "--name-only", "--diff-filter=U"], cwd, { timeout: 10000 });
  return (r.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 解析 worktree 的改动列表（已过滤共享的 `.goo` 链接）。 */
function worktreeChanges(worktreeDir: string): string[] {
  const r = exec("git", ["status", "--porcelain"], worktreeDir, { timeout: 10000 });
  return (r.stdout || "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0)
    .filter((l) => {
      const p = l.slice(3).split(" -> ").pop()?.trim() ?? "";
      return p !== ".goo" && !p.startsWith(".goo/");
    });
}

/** 解析 worktree 对应的分支（状态文件优先，缺失时回落到 git worktree list）。 */
function branchOf(cwd: string, stepId: string | number, worktreeDir: string): string {
  const state = readWorktreeState(cwd, stepId);
  if (state?.branch) return state.branch;
  const r = exec("git", ["worktree", "list", "--porcelain"], cwd, { timeout: 10000 });
  const lines = (r.stdout || "").split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`worktree ${worktreeDir}`));
  if (idx >= 0) {
    const b = lines.slice(idx + 1).find((l) => l.startsWith("branch "));
    if (b) return b.replace(/^branch\s+/, "").replace(/^refs\/heads\//, "").trim();
  }
  return "";
}

/**
 * 把一个 step 的 worktree 改动合并回主工程。
 *
 * 三种结局：
 *   - `merged` / `no_changes`：已并入主分支，worktree 与分支清理掉；
 *   - `conflict`：**真冲突**。主分支 `git merge --abort` 回到合并前状态，
 *     worktree 目录 + 分支**保留**（两侧改动都在），冲突文件列表写进报告，
 *     状态文件标 `conflict`，等人工裁决；
 *   - `failed`：连提交/合并都没跑通（如分支不存在），同样保留现场。
 */
export function mergeStepWorktree(
  cwd: string,
  stepId: string | number,
  opts: { keepWorktree?: boolean } = {},
): MergeOutcome {
  const sid = String(stepId);
  const worktreeDir = (readWorktreeState(cwd, sid)?.worktreeDir) || worktreeDirFor(cwd, sid);
  const branch = branchOf(cwd, sid, worktreeDir);
  const base: MergeOutcome = { stepId: sid, status: "failed", branch, worktreeDir, conflictFiles: [], cleaned: false, hasChanges: false };

  if (!branch) {
    base.error = "找不到该 step 的 worktree 分支（可能未创建或已清理）";
    return base;
  }
  if (!existsSync(worktreeDir)) {
    base.error = `worktree 目录不存在: ${worktreeDir}`;
    return base;
  }

  // `git status --porcelain` 而不是 `git diff --stat HEAD`：后者漏掉未跟踪的新产物，
  // 曾导致「没有检测到改动」→ 跳过合并 → worktree 清理时新文件静默丢失。
  // 但要**过滤掉 `.goo`**：它是指向主工程的符号链接（plan/日志共享），既不能被
  // 当成步骤改动提交（否则合并会摘到「would lose untracked files」），也不该触发合并。
  const hasChanges = worktreeChanges(worktreeDir).length > 0;
  base.hasChanges = hasChanges;

  if (!hasChanges) {
    base.status = "no_changes";
    const cleaned = opts.keepWorktree ? false : cleanupStepWorktree(cwd, sid);
    base.cleaned = cleaned;
    appendMergeReport(cwd, { stepId: sid, status: "no_changes", branch, at: new Date().toISOString() });
    return base;
  }

  // 提交 worktree 改动。显式给身份，避免 CI / 临时环境缺 user.name 时 commit 失败。
  const commit = exec(
    "git",
    ["-c", "user.name=AutoGoo-Plugin", "-c", "user.email=autogoo@localhost", "add", "-A", "--", ".", ":(exclude).goo"],
    worktreeDir,
    { timeout: 30000 },
  );
  const doCommit = exec(
    "git",
    ["-c", "user.name=AutoGoo-Plugin", "-c", "user.email=autogoo@localhost", "commit", "-m", `Step #${sid} work (isolated worktree)`],
    worktreeDir,
    { timeout: 30000 },
  );
  if (commit.exitCode !== 0 || doCommit.exitCode !== 0) {
    base.status = "failed";
    base.error = `worktree 提交失败: ${(commit.stderr || doCommit.stderr || "").trim().slice(0, 300)}`;
    writeWorktreeState(cwd, { ...(readWorktreeState(cwd, sid) || { stepId: sid, branch, worktreeDir, baseRef: "HEAD", createdAt: new Date().toISOString() }), mergeState: "failed", error: base.error });
    appendMergeReport(cwd, { stepId: sid, status: "failed", branch, error: base.error, at: new Date().toISOString() });
    return base;
  }

  const merge = exec(
    "git",
    ["-c", "user.name=AutoGoo-Plugin", "-c", "user.email=autogoo@localhost", "merge", "--no-ff", branch, "-m", `Merge step #${sid} from isolated worktree`],
    cwd,
    { timeout: 30000 },
  );

  if (merge.exitCode !== 0) {
    const files = unmergedFiles(cwd);
    // 关键：abort 的是**主分支的合并状态**（否则后续 merge 全被卡住），
    // 被 abort 掉的不是改动本身 —— worktree 目录与分支都还在，两侧都能查看。
    exec("git", ["merge", "--abort"], cwd, { timeout: 15000 });
    base.status = files.length > 0 ? "conflict" : "failed";
    base.conflictFiles = files;
    base.error = files.length > 0
      ? `合并冲突（${files.length} 个文件）`
      : `合并失败: ${(merge.stderr || merge.stdout || "").trim().slice(0, 300)}`;
    const prev = readWorktreeState(cwd, sid);
    writeWorktreeState(cwd, {
      ...(prev || { stepId: sid, branch, worktreeDir, baseRef: "HEAD", createdAt: new Date().toISOString() }),
      mergeState: base.status,
      conflictFiles: files,
      error: base.error,
    });
    appendMergeReport(cwd, {
      stepId: sid, status: base.status, branch, worktreeDir, conflictFiles: files, error: base.error,
      note: "主分支已 merge --abort；worktree 与分支保留，两侧改动都在", at: new Date().toISOString(),
    });
    return base;
  }

  base.status = "merged";
  const prev = readWorktreeState(cwd, sid);
  writeWorktreeState(cwd, {
    ...(prev || { stepId: sid, branch, worktreeDir, baseRef: "HEAD", createdAt: new Date().toISOString() }),
    mergeState: "merged",
    mergedAt: new Date().toISOString(),
  });
  appendMergeReport(cwd, { stepId: sid, status: "merged", branch, at: new Date().toISOString() });
  if (!opts.keepWorktree) base.cleaned = cleanupStepWorktree(cwd, sid);
  return base;
}

/** 合并一批 worktree（按依赖拓扑序），返回逐 step 结果。 */
export function mergeAllStepWorktrees(
  cwd: string,
  stepIds: string[],
  steps: Array<{ id: any; depends_on?: any[] }>,
  opts: { keepWorktree?: boolean } = {},
): MergeOutcome[] {
  const ordered = orderStepsForMerge(stepIds, steps);
  const out: MergeOutcome[] = [];
  for (const sid of ordered) out.push(mergeStepWorktree(cwd, sid, opts));
  const conflicts = out.filter((o) => o.status === "conflict");
  if (conflicts.length > 0) writeConflictGuide(cwd, conflicts);
  return out;
}

// ── 清理 ────────────────────────────────────────────────────────────────────

/** 清理单个 step 的 worktree 目录与分支。返回是否真的清理了东西。 */
export function cleanupStepWorktree(cwd: string, stepId: string | number): boolean {
  const sid = String(stepId);
  const state = readWorktreeState(cwd, sid);
  const worktreeDir = state?.worktreeDir || worktreeDirFor(cwd, sid);
  let touched = false;
  if (existsSync(worktreeDir)) {
    const r = exec("git", ["worktree", "remove", "-f", worktreeDir], cwd, { timeout: 15000 });
    touched = touched || r.exitCode === 0;
  }
  if (state?.branch) {
    const r = exec("git", ["branch", "-D", state.branch], cwd, { timeout: 10000 });
    touched = touched || r.exitCode === 0;
  }
  try {
    if (existsSync(worktreeStatePath(cwd, sid))) unlinkSync(worktreeStatePath(cwd, sid));
  } catch {
    /* 状态文件删不掉不影响正确性（下次创建会覆盖） */
  }
  return touched;
}

/** 清理全部 AutoGoo worktree（分支 + 目录 + 状态文件）。 */
export function cleanupAllWorktrees(cwd: string): { worktrees: number; branches: number } {
  const list = exec("git", ["worktree", "list", "--porcelain"], cwd, { timeout: 10000 });
  let worktrees = 0;
  for (const line of (list.stdout || "").split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.replace(/^worktree\s+/, "").trim();
    if (!dir.includes(`${WORKTREE_ROOT}/step-`)) continue;
    if (exec("git", ["worktree", "remove", "-f", dir], cwd, { timeout: 15000 }).exitCode === 0) worktrees += 1;
  }
  const branches = exec("git", ["branch", "--list", "autogoo-plugin/step-*"], cwd, { timeout: 10000 });
  let branchCount = 0;
  for (const br of (branches.stdout || "").split("\n").map((l) => l.replace(/^[*+]\s*/, "").trim()).filter(Boolean)) {
    if (exec("git", ["branch", "-D", br], cwd, { timeout: 10000 }).exitCode === 0) branchCount += 1;
  }
  return { worktrees, branches: branchCount };
}

// ── 派发期编排（execute.ts 消费的单一入口）────────────────────────────────────

export interface IsolationSetup {
  /** 是否真的启用了隔离（开关 + 前置条件都满足） */
  enabled: boolean;
  reason: string;
  /** 成功创建 worktree 的 step → 工作目录 */
  worktreeByStep: Map<string, StepWorktreeState>;
  /** 需要降级为串行执行的 step id（worktree 创建失败 / 非 git / 脏树） */
  degradedStepIds: string[];
  /** 给主 Agent 看的报告行 */
  lines: string[];
}

/**
 * 为一批待派发步骤准备隔离。
 *
 * 调用约定（也是「零额外成本」的实现方式）：
 *   - 开关关闭 → 直接返回 `enabled:false`，**不跑任何 git 命令**；
 *   - 开关打开但本批没有写冲突 → 同样不建 worktree（`enabled:false`）；
 *   - 有冲突 → 只给冲突簇内步骤建 worktree；单个创建失败只把**该步**降级为串行。
 */
export function setupWorktreeIsolation(
  cwd: string,
  toDispatch: Array<{ id: any }>,
  conflicts: ConflictPair[],
  executionCfg: any,
): IsolationSetup {
  const decision = resolveWorktreeIsolation(executionCfg);
  const setup: IsolationSetup = {
    enabled: false,
    reason: decision.reason,
    worktreeByStep: new Map(),
    degradedStepIds: [],
    lines: [],
  };
  if (!decision.enabled) return setup;
  if (conflicts.length === 0) {
    setup.reason = "隔离开关已开启，但本批无写范围重叠 → 不创建 worktree（零额外成本）";
    return setup;
  }

  const needed = stepsNeedingIsolation(conflicts).filter((id) =>
    toDispatch.some((s) => String(s.id) === id),
  );
  if (needed.length === 0) {
    setup.reason = "隔离开关已开启，但重叠步骤不在本批派发中";
    return setup;
  }

  setup.lines.push(`🔒 Worktree 隔离：${needed.length} 个写范围重叠步骤分配独立工作目录`);
  for (const id of needed) {
    const res = createStepWorktree(cwd, id);
    if (res.ok && res.state) {
      setup.worktreeByStep.set(id, res.state);
      setup.lines.push(`   #${id} → ${res.state.worktreeDir.replace(`${cwd}/`, "")} (${res.state.branch})`);
    } else {
      setup.degradedStepIds.push(id);
      setup.lines.push(`   ⚠️ #${id} 隔离失败，降级为串行执行：${res.error ?? "未知原因"}`);
    }
  }

  setup.enabled = setup.worktreeByStep.size > 0;
  if (!setup.enabled) {
    setup.reason = "全部隔离创建失败 → 整批降级为串行（不影响完成，只是慢）";
  } else if (setup.degradedStepIds.length > 0) {
    setup.reason = `${setup.worktreeByStep.size} 步已隔离，${setup.degradedStepIds.length} 步降级串行`;
  } else {
    setup.reason = `${setup.worktreeByStep.size} 步已隔离`;
  }
  return setup;
}

/** 把合并结果渲染成主 Agent 可读的报告行（冲突必须可见，绝不静默）。 */
export function describeMergeOutcomes(outcomes: MergeOutcome[], cwd: string): string[] {
  if (outcomes.length === 0) return [];
  const lines: string[] = [];
  const merged = outcomes.filter((o) => o.status === "merged");
  const noChange = outcomes.filter((o) => o.status === "no_changes");
  const conflicts = outcomes.filter((o) => o.status === "conflict");
  const failed = outcomes.filter((o) => o.status === "failed");

  if (merged.length > 0) lines.push(`🔀 已按依赖顺序合并 ${merged.length} 个 worktree: #${merged.map((o) => o.stepId).join(", #")}`);
  if (noChange.length > 0) lines.push(`➖ ${noChange.length} 个 worktree 无改动（已清理）: #${noChange.map((o) => o.stepId).join(", #")}`);

  if (conflicts.length > 0) {
    lines.push(`⛔ ${conflicts.length} 个 worktree 合并**真冲突** —— 未静默覆盖，两侧改动都在，需人工裁决:`);
    for (const o of conflicts) {
      lines.push(`   #${o.stepId} 分支 ${o.branch}`);
      lines.push(`     冲突文件: ${o.conflictFiles.length > 0 ? o.conflictFiles.join(", ") : "(未取到列表)"}`);
      lines.push(`     worktree 保留在 ${o.worktreeDir.replace(`${cwd}/`, "")}（主分支已 merge --abort，合并前状态）`);
    }
    lines.push(`   裁决指引: ${join(cwd, WORKTREE_ROOT, "CONFLICTS.md").replace(`${cwd}/`, "")}`);
  }
  if (failed.length > 0) {
    lines.push(`⚠️ ${failed.length} 个 worktree 合并失败（现场保留）:`);
    for (const o of failed) lines.push(`   #${o.stepId} ${o.error ?? ""}${o.branch ? `（分支 ${o.branch}）` : ""}`);
  }
  return lines;
}

/** 冲突结论的一行摘要（写进 step log / details，便于事后检索）。 */
export function describeConflictSummary(outcomes: MergeOutcome[]): string {
  const conflicts = outcomes.filter((o) => o.status === "conflict");
  if (conflicts.length === 0) return "";
  return conflicts
    .map((o) => `#${o.stepId}: ${o.conflictFiles.join(", ") || "冲突文件未知"}（分支 ${o.branch} 保留）`)
    .join("; ");
}

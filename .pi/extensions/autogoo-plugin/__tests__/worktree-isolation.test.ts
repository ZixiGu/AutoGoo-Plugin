/**
 * 写冲突隔离（worktree isolation）测试。
 *
 * 存在的理由：0.30.0 的 `detectWriteConflicts` 只告警不隔离，而
 * `auto_goo_worktree_create/_merge/_cleanup` 三个工具早已实现却**从未接入派发路径**。
 * 本轮把它接上，验收标准是四条，这里逐条落到用例：
 *   ① 两个写范围重叠的步骤并行时各自在独立 worktree 工作；
 *   ② 合并遇真冲突时明确报告冲突文件而非静默覆盖（两侧改动都保留）；
 *   ③ 开关关闭时行为与现在完全一致（不跑任何 git 命令，零回归）；
 *   ④ worktree 创建失败降级为串行（非 git 项目 / 脏工作树）。
 *
 * 运行：node --import tsx --test .pi/extensions/autogoo-plugin/__tests__/worktree-isolation.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clusterWriteConflicts,
  createStepWorktree,
  describeMergeOutcomes,
  mergeAllStepWorktrees,
  orderStepsForMerge,
  readWorktreeState,
  resolveWorktreeIsolation,
  setupWorktreeIsolation,
  stepsNeedingIsolation,
  worktreeDirFor,
} from "../utils/worktree-isolation.js";
import { detectWriteConflicts, describeWriteConflicts } from "../tools/execute.js";

// ── 环境准备 ────────────────────────────────────────────────────────────────

const HAS_GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const tmps: string[] = [];
function tmpRepo(withGit = true): string {
  const dir = mkdtempSync(join(tmpdir(), "autogoo-wt-"));
  tmps.push(dir);
  if (withGit) {
    // git 2.25（CI/旧环境）不支持 `git init -b`，用默认分支名即可（隔离不依赖分支名）
    git(dir, "init", "-q");
    writeFileSync(join(dir, "code.txt"), "line1\nline2\nline3\n");
    writeFileSync(join(dir, ".gitignore"), ".goo/\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    // 真实项目的 .goo/ 一定存在（plan / logs / artifacts），隔离会把它链接进 worktree
    mkdirSync(join(dir, ".goo", "logs"), { recursive: true });
    writeFileSync(join(dir, ".goo", "plan.json"), JSON.stringify({ task: "t", steps: [] }));
  }
  return dir;
}

before(() => {
  // 测试结束统一清理（避免 tmpdir 堆积几百个 git 仓库）
  process.on("exit", () => {
    for (const d of tmps) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响测试结论 */
      }
    }
  });
});

const step = (id: number, writePaths: string[], dependsOn: any[] = []) => ({
  id,
  name: `步骤${id}`,
  depends_on: dependsOn,
  allowed_write_paths: writePaths,
});

// ── ① 开关解析：默认关闭 ────────────────────────────────────────────────────

describe("resolveWorktreeIsolation", () => {
  it("缺省 / false / 空 → 关闭（默认关闭，零开销）", () => {
    for (const cfg of [{}, undefined, null, { worktree_isolation: false }, { worktree_isolation: null }]) {
      const d = resolveWorktreeIsolation(cfg as any);
      assert.equal(d.enabled, false);
      assert.match(d.reason, /默认关闭|未开启/);
    }
  });

  it("true / \"true\" / \"on\" / 1 都算开启（config.json 是人手写的）", () => {
    for (const v of [true, "true", "ON", "1", 1, "yes"]) {
      assert.equal(resolveWorktreeIsolation({ worktree_isolation: v }).enabled, true, `value=${JSON.stringify(v)}`);
    }
  });

  it("无法识别的字符串按关闭处理，并给出理由（不静默打开）", () => {
    const d = resolveWorktreeIsolation({ worktree_isolation: "worktre" });
    assert.equal(d.enabled, false);
    assert.match(d.reason, /无法识别/);
  });
});

// ── 分组 / 合并顺序 ────────────────────────────────────────────────────────

describe("clusterWriteConflicts", () => {
  it("链式重叠 A-B、B-C 必须聚成一个簇（不能逐对处理）", () => {
    const a = step(1, ["src/a.ts"]);
    const b = step(2, ["src/b.ts"]);
    const c = step(3, ["src/c.ts"]);
    // 人工构造链：1-2 重叠 a.ts、2-3 重叠 b.ts、1-3 不重叠
    const clusters = clusterWriteConflicts([
      { a: { id: 1 }, b: { id: 2 }, overlap: ["src/a.ts"] },
      { a: { id: 2 }, b: { id: 3 }, overlap: ["src/b.ts"] },
    ]);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].stepIds, ["1", "2", "3"]);
    assert.deepEqual(stepsNeedingIsolation([
      { a, b, overlap: ["src/a.ts"] },
    ]), ["1", "2"]);
  });

  it("互不相关的两对 → 两个簇", () => {
    const clusters = clusterWriteConflicts([
      { a: { id: 1 }, b: { id: 2 }, overlap: ["x/"] },
      { a: { id: 3 }, b: { id: 4 }, overlap: ["y/"] },
    ]);
    assert.deepEqual(clusters.map((c) => c.stepIds), [["1", "2"], ["3", "4"]]);
  });

  it("真实 detectWriteConflicts 的目录包含关系也会成簇", () => {
    const steps = [step(1, [".pi/extensions/autogoo-plugin/"]), step(2, [".pi/extensions/autogoo-plugin/utils/dispatch.ts"])];
    assert.deepEqual(stepsNeedingIsolation(detectWriteConflicts(steps)), ["1", "2"]);
  });
});

describe("orderStepsForMerge", () => {
  it("被依赖的步骤先合并", () => {
    const steps = [step(3, [], [1]), step(1, []), step(2, [], [1])];
    assert.deepEqual(orderStepsForMerge(["3", "1", "2"], steps), ["1", "2", "3"]);
  });

  it("同层按数字序（结果可复现）", () => {
    const steps = [step(10, []), step(2, []), step(1, [])];
    assert.deepEqual(orderStepsForMerge(["10", "2", "1"], steps), ["1", "2", "10"]);
  });

  it("有环时兜底不丢步骤", () => {
    const steps = [step(1, [], [2]), step(2, [], [1])];
    assert.deepEqual(orderStepsForMerge(["1", "2"], steps).sort(), ["1", "2"]);
  });
});

// ── ③ 开关关闭 → 零回归 ────────────────────────────────────────────────────

describe("setupWorktreeIsolation：开关与降级", () => {
  it("开关关闭时不创建 worktree（不跑 git，零成本）", () => {
    const repo = tmpRepo();
    const steps = [step(1, ["code.txt"]), step(2, ["code.txt"])];
    const setup = setupWorktreeIsolation(repo, steps, detectWriteConflicts(steps), {});
    assert.equal(setup.enabled, false);
    assert.equal(setup.worktreeByStep.size, 0);
    assert.deepEqual(setup.degradedStepIds, []);
    assert.equal(existsSync(join(repo, ".goo", "worktrees")), false, "关闭时不得留下任何隔离痕迹");
  });

  it("开关开启但本批无写冲突 → 不创建 worktree（零额外成本）", () => {
    const repo = tmpRepo();
    const steps = [step(1, ["src/a.ts"]), step(2, ["docs/b.md"])];
    const setup = setupWorktreeIsolation(repo, steps, detectWriteConflicts(steps), { worktree_isolation: true });
    assert.equal(setup.enabled, false);
    assert.equal(setup.worktreeByStep.size, 0);
    assert.match(setup.reason, /无写范围重叠/);
  });

  it("只隔离冲突簇，无冲突步骤仍走主工作目录（不加成本）", () => {
    const repo = tmpRepo();
    const steps = [step(1, ["code.txt"]), step(2, ["code.txt"]), step(3, ["docs/"])];
    const setup = setupWorktreeIsolation(repo, steps, detectWriteConflicts(steps), { worktree_isolation: true });
    assert.deepEqual([...setup.worktreeByStep.keys()].sort(), ["1", "2"]);
    assert.equal(setup.worktreeByStep.has("3"), false, "无冲突步骤不应建 worktree");
  });

  it("非 git 项目 → 降级（enabled=false，所有冲突步骤降级串行）", () => {
    const plain = tmpRepo(false);
    const steps = [step(1, ["code.txt"]), step(2, ["code.txt"])];
    const setup = setupWorktreeIsolation(plain, steps, detectWriteConflicts(steps), { worktree_isolation: true });
    assert.equal(setup.enabled, false);
    assert.deepEqual(setup.degradedStepIds, ["1", "2"]);
    assert.match(setup.lines.join("\n"), /降级为串行执行/);
  });

  it("脏工作树 → 拒绝隔离（避免 worktree 只检出 HEAD 造成丢改动）", () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "code.txt"), "dirty\n");
    const res = createStepWorktree(repo, 1);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /未提交/);
    assert.equal(existsSync(worktreeDirFor(repo, 1)), false);
  });
});

describe("describeWriteConflicts：告警文案随开关变化", () => {
  const conflicts = detectWriteConflicts([step(1, ["code.txt"]), step(2, ["code.txt"])]);

  it("开关关闭 → 保持旧文案（回归：已有测试依赖「不阻止执行」）", () => {
    const text = describeWriteConflicts(conflicts).join("\n");
    assert.match(text, /不阻止执行/);
    assert.doesNotMatch(text, /worktree 隔离（config/);
  });

  it("开关开启 → 明确说已隔离，不再建议人工改串行", () => {
    const text = describeWriteConflicts(conflicts, { isolationEnabled: true }).join("\n");
    assert.match(text, /已启用 worktree 隔离/);
    assert.match(text, /独立 git worktree/);
    assert.doesNotMatch(text, /改为串行或拆分写范围/);
  });
});

// ── ①② 真实 git 集成 ──────────────────────────────────────────────────────

describe("worktree 隔离与合并（真实 git）", () => {
  it("① 两个写范围重叠的步骤各自独立 worktree，互不影响", { skip: !HAS_GIT && "git 不可用" }, () => {
    const repo = tmpRepo();
    const steps = [step(1, ["code.txt"]), step(2, ["code.txt"])];
    const setup = setupWorktreeIsolation(repo, steps, detectWriteConflicts(steps), { worktree_isolation: true });
    assert.equal(setup.enabled, true);
    assert.equal(setup.worktreeByStep.size, 2, "重叠的两个步骤都必须有独立 worktree");
    assert.deepEqual(setup.degradedStepIds, []);

    const wt1 = setup.worktreeByStep.get("1")!.worktreeDir;
    const wt2 = setup.worktreeByStep.get("2")!.worktreeDir;
    assert.notEqual(wt1, wt2);

    // 各自在隔离目录里改同一文件的不同行 —— 这正是「靠运气不冲突」的原始场景
    writeFileSync(join(wt1, "code.txt"), "STEP1\nline2\nline3\n");
    writeFileSync(join(wt2, "code.txt"), "line1\nline2\nSTEP2\n");

    // `.goo/` 必须共享：否则 Subagent 的 auto_goo_update_step 找不到 plan
    assert.equal(existsSync(join(wt1, ".goo", "plan.json")), true, ".goo/ 应链接进 worktree");
    // 主工程在合并前完全没被污染
    assert.equal(readFileSync(join(repo, "code.txt"), "utf-8"), "line1\nline2\nline3\n");

    const outcomes = mergeAllStepWorktrees(repo, ["1", "2"], steps);
    assert.deepEqual(outcomes.map((o) => o.status), ["merged", "merged"]);
    const merged = readFileSync(join(repo, "code.txt"), "utf-8");
    assert.match(merged, /STEP1/, "步骤 1 的改动不能丢");
    assert.match(merged, /STEP2/, "步骤 2 的改动不能丢 —— 后者静默覆盖前者即为失败");
  });

  it("② 真冲突：报告冲突文件、保留两侧改动、主分支回到合并前状态", { skip: !HAS_GIT && "git 不可用" }, () => {
    const repo = tmpRepo();
    const steps = [step(1, ["code.txt"]), step(2, ["code.txt"])];
    const setup = setupWorktreeIsolation(repo, steps, detectWriteConflicts(steps), { worktree_isolation: true });
    assert.equal(setup.worktreeByStep.size, 2);

    const wt1 = setup.worktreeByStep.get("1")!.worktreeDir;
    const wt2 = setup.worktreeByStep.get("2")!.worktreeDir;
    // 同一行改成不同内容 → 必然真冲突
    writeFileSync(join(wt1, "code.txt"), "AAA\nline2\nline3\n");
    writeFileSync(join(wt2, "code.txt"), "BBB\nline2\nline3\n");

    const outcomes = mergeAllStepWorktrees(repo, ["1", "2"], steps);
    const first = outcomes.find((o) => o.stepId === "1")!;
    const second = outcomes.find((o) => o.stepId === "2")!;
    assert.equal(first.status, "merged");
    assert.equal(second.status, "conflict", "同一行不同改动必须判冲突，不能静默覆盖");
    assert.deepEqual(second.conflictFiles, ["code.txt"], "必须明确报告冲突文件");

    // 主分支没有冲突标记、没有中间状态
    const mainContent = readFileSync(join(repo, "code.txt"), "utf-8");
    assert.equal(mainContent, "AAA\nline2\nline3\n", "主分支应停在第一个已合并状态，不残留冲突标记");
    assert.doesNotMatch(mainContent, /<<<<<<<|>>>>>>>/);

    // 两侧改动都还在：worktree 与分支保留，状态落盘可恢复
    assert.equal(existsSync(wt2), true, "冲突时 worktree 必须保留");
    assert.ok(git(repo, "branch", "--list", second.branch).includes(second.branch), "冲突时分支必须保留");
    assert.equal(readFileSync(join(wt2, "code.txt"), "utf-8"), "BBB\nline2\nline3\n", "失败方的改动不能被丢弃");
    const state = readWorktreeState(repo, 2)!;
    assert.equal(state.mergeState, "conflict");
    assert.deepEqual(state.conflictFiles, ["code.txt"]);

    // 冲突必须出现在主 Agent 可见的输出里 + 生成人工裁决指引
    const report = describeMergeOutcomes(outcomes, repo).join("\n");
    assert.match(report, /真冲突/);
    assert.match(report, /code\.txt/);
    assert.match(report, /CONFLICTS\.md/);
    assert.equal(existsSync(join(repo, ".goo", "worktrees", "CONFLICTS.md")), true);

    // 人工裁决路径可用：保留的分支里改动完整可取（`git merge` 会再次报冲突，
    // 这正是「交人裁决」的含义 —— 这里不断言自动合并成功，只断言改动没丢）
    assert.equal(
      git(repo, "show", `${second.branch}:code.txt`),
      "BBB\nline2\nline3\n",
      "保留分支必须能取回失败方改动",
    );
  });

  it("合并后清理 worktree 与分支（成功路径不留垃圾）", { skip: !HAS_GIT && "git 不可用" }, () => {
    const repo = tmpRepo();
    const steps = [step(1, ["code.txt"])];
    const res = createStepWorktree(repo, 1);
    assert.equal(res.ok, true);
    writeFileSync(join(res.state!.worktreeDir, "code.txt"), "only\n");
    const outcomes = mergeAllStepWorktrees(repo, ["1"], steps);
    assert.equal(outcomes[0].status, "merged");
    assert.equal(outcomes[0].cleaned, true);
    assert.equal(existsSync(res.state!.worktreeDir), false);
    assert.equal(git(repo, "branch", "--list", "autogoo-plugin/step-*").trim(), "");
  });
});

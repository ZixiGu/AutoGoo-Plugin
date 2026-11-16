/**
 * AutoGoo-Plugin Subagent Worktree Isolation — Git worktree 工具入口
 *
 * 三个工具（create / merge / cleanup）只是**薄封装**：真正的 git 语义与状态落盘
 * 都在 `utils/worktree-isolation.ts`。这样做的原因很具体 —— 0.30.0 时这三个工具
 * 自带一套 git 命令实现，而派发路径完全没调用它们，能力闲置一整轮；把逻辑抽到
 * utils 后，`tools/execute.ts` 的派发路径与这三个工具**共用同一份实现**，
 * 「有工具但派发路径不用」这类失效模式不会再出现。
 *
 * 生命周期：
 * 1. 派发前创建 worktree（`config.execution.worktree_isolation` 打开时自动做）
 * 2. Subagent 在 worktree 中执行
 * 3. 步骤完成后按依赖顺序合并回主工程
 * 4. 冲突时保留两侧现场（主分支 abort + worktree/分支保留），交人裁决
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  cleanupAllWorktrees,
  cleanupStepWorktree,
  createStepWorktree,
  describeMergeOutcomes,
  mergeStepWorktree,
  readWorktreeState,
} from "../utils/worktree-isolation.js";

export function registerWorktreeTools(pi: ExtensionAPI): void {
  // Tool: auto_goo_worktree_create
  pi.registerTool({
    name: "auto_goo_worktree_create",
    label: "Create Worktree",
    description: `为 DAG 步骤创建一个 Git worktree 分支，实现文件级执行隔离。需要项目已初始化 Git 且 HEAD 可解析；创建失败只降级，不会中断执行。`,
    promptSnippet: "为 Subagent 创建 Git worktree 分支执行隔离",
    promptGuidelines: [
      "使用 auto_goo_worktree_create 在 Subagent 派发前创建隔离的 worktree。",
      "worktree 从当前 HEAD 创建新分支；主工作树有未提交改动时会拒绝（避免丢改动）。",
    ],
    parameters: Type.Object({
      stepId: Type.Integer({ description: "步骤 ID" }),
      baseBranch: Type.Optional(Type.String({ description: "基础引用（默认 HEAD）" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const stepId = params.stepId;
      const res = createStepWorktree(cwd, stepId, { baseRef: params.baseBranch });

      const lines: string[] = [`🌳 创建 Worktree 隔离`, `─────────────────`, `步骤: #${stepId}`];
      if (!res.ok || !res.state) {
        lines.push(`  ❌ 创建失败: ${res.error ?? "未知原因"}`);
        lines.push(`  处置：该步骤降级为主工作目录执行（不影响完成）。`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { error: "worktree_create_failed", reason: res.error },
        };
      }
      lines.push(`  分支: ${res.state.branch}`);
      lines.push(`  目录: ${res.state.worktreeDir}`);
      lines.push(`  基础引用: ${res.state.baseRef}`);
      lines.push(`  ✅ Worktree 已创建`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...res.state, worktreeCreated: true },
      };
    },
  });

  // Tool: auto_goo_worktree_merge
  pi.registerTool({
    name: "auto_goo_worktree_merge",
    label: "Merge Worktree",
    description: `将 Subagent worktree 的改动合并回主分支。真冲突时报告冲突文件并保留两侧改动（主分支 abort、worktree/分支保留），不静默覆盖。`,
    promptSnippet: "将 Subagent worktree 的改动合并回主分支",
    promptGuidelines: [
      "步骤完成后使用 auto_goo_worktree_merge 将 worktree 的改动合并回主分支。",
      "合并成功会清理 worktree；出现真冲突时保留现场并在输出中列出冲突文件。",
    ],
    parameters: Type.Object({
      stepId: Type.Integer({ description: "步骤 ID" }),
      keepWorktree: Type.Optional(Type.Boolean({ description: "是否保留 worktree（默认 false）" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const stepId = params.stepId;
      const outcome = mergeStepWorktree(cwd, stepId, { keepWorktree: params.keepWorktree === true });
      const lines: string[] = [`🔄 合并 Worktree`, `─────────────────`, `步骤: #${stepId}`];
      lines.push(...describeMergeOutcomes([outcome], cwd));
      if (outcome.status === "merged" || outcome.status === "no_changes") {
        lines.push(outcome.cleaned ? `  🧹 已清理 worktree 目录和分支` : `  📁 worktree 保留: ${outcome.worktreeDir}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          ...outcome,
          merged: outcome.status === "merged",
          error: outcome.status === "conflict" ? "merge_conflict" : outcome.error,
        },
      };
    },
  });

  // Tool: auto_goo_worktree_cleanup
  pi.registerTool({
    name: "auto_goo_worktree_cleanup",
    label: "Cleanup Worktrees",
    description: `清理所有 AutoGoo-Plugin 创建的 worktree 分支和目录。在计划完成或中断后执行清理。`,
    promptSnippet: "清理所有 AutoGoo-Plugin worktree 分支和目录",
    parameters: Type.Object({
      stepId: Type.Optional(Type.Integer({ description: "只清理指定步骤（默认全部）" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd;
      const lines: string[] = [`🧹 Worktree 清理`];

      if (params?.stepId !== undefined) {
        const state = readWorktreeState(cwd, params.stepId);
        const touched = cleanupStepWorktree(cwd, params.stepId);
        lines.push(touched ? `  已清理 #${params.stepId}` : `  没有找到 #${params.stepId} 的 worktree`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { worktreesRemoved: touched ? 1 : 0, branch: state?.branch ?? null },
        };
      }

      const res = cleanupAllWorktrees(cwd);
      lines.push(res.worktrees === 0 && res.branches === 0
        ? `  没有找到 AutoGoo-Plugin worktree`
        : `  已移除 worktree ${res.worktrees} 个 / 分支 ${res.branches} 个`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { worktreesRemoved: res.worktrees, branchesRemoved: res.branches },
      };
    },
  });
}

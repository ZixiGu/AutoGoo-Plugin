/**
 * goo-thread — 统一管理 AutoGoo-Plugin thread。
 *
 * 无参数且处于 TUI 模式时，打开**键盘驱动的交互式管理界面**（`ctx.ui.custom`），
 * 而不是把表格打印出来。带参数时仍然走脚本，便于脚本化/自动化。
 *
 * 职责划分：
 *   - `ThreadManager`（utils/thread-ui.ts）只做导航与渲染，无副作用；
 *   - 本文件的 `openThreadManager` 负责执行动作：确认、调脚本、再刷新界面。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../utils/paths.js";
import { execPython } from "../utils/exec.js";
import { uiConfirm, uiInput } from "../utils/ui.js";
import { ThreadManager, type ThreadAction, type ThreadRow } from "../utils/thread-ui.js";

const GOO_THREAD_PY = join(REPO_ROOT, "skills/auto-goo/scripts/goo-thread.py");

const USAGE =
  "用法：\n" +
  "  /goo-thread                 交互式管理界面（TUI）\n" +
  "  /goo-thread list [--json] [--active] [--status a,b]\n" +
  "  /goo-thread show <id> [--json]\n" +
  "  /goo-thread switch <id>\n" +
  "  /goo-thread new <标题> [--steps N]\n" +
  "  /goo-thread rename <id> <新标题>\n" +
  "  /goo-thread archive <id> / restore <id>\n" +
  "  /goo-thread close <id>\n" +
  "  /goo-thread doctor [--fix]\n" +
  "  /goo-thread health";

function runScript(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const r = execPython(GOO_THREAD_PY, ["--root", cwd, ...args], cwd, { timeout: 60000 });
  return { code: r.exitCode, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

interface ThreadListPayload {
  current_thread_id: string | null;
  count: number;
  threads: ThreadRow[];
}

function loadThreads(cwd: string): ThreadListPayload | null {
  const r = runScript(cwd, ["list", "--json"]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out) as ThreadListPayload;
  } catch {
    return null;
  }
}

/** 打开交互式管理界面，直到用户按 q / Esc。 */
async function openThreadManager(ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;

  for (;;) {
    const payload = loadThreads(cwd);
    if (!payload) {
      ctx.ui.notify("读取 thread 列表失败（goo-thread.py list --json）", "error");
      return;
    }

    const action = await ctx.ui.custom<ThreadAction>((tui, theme, keybindings, done) => {
      return new ThreadManager(
        payload.threads,
        payload.current_thread_id,
        theme,
        done,
        () => {
          try {
            tui.requestRender();
          } catch {
            /* 渲染请求失败不阻塞 */
          }
        },
        keybindings,
      );
    });

    if (!action || action.action === "quit") return;

    switch (action.action) {
      case "switch": {
        const r = runScript(cwd, ["switch", action.threadId]);
        if (r.code === 0) {
          ctx.ui.notify(`已切换到 thread：${action.threadId}\n/goo-status 与 /goo-continue 现在作用于它`, "info");
        } else {
          ctx.ui.notify(`切换失败：${r.err || r.out || `exit ${r.code}`}`, "error");
        }
        break;
      }

      case "rename": {
        const next = await uiInput(ctx, `重命名 thread ${action.threadId}`, "");
        if (next && next.trim()) {
          const r = runScript(cwd, ["rename", action.threadId, next.trim()]);
          ctx.ui.notify(r.code === 0 ? `已重命名为：${next.trim()}` : `重命名失败：${r.err}`, r.code === 0 ? "info" : "error");
        }
        break;
      }

      case "archive": {
        const ok = await uiConfirm(
          ctx,
          "归档 thread",
          `将 ${action.threadId} 标记为 archived（可随时 restore 恢复，不删除任何文件）。是否继续？`,
        );
        if (ok) {
          const r = runScript(cwd, ["archive", action.threadId]);
          ctx.ui.notify(r.code === 0 ? `已归档：${action.threadId}` : `归档失败：${r.err}`, r.code === 0 ? "info" : "error");
        }
        break;
      }

      case "restore": {
        const r = runScript(cwd, ["restore", action.threadId]);
        ctx.ui.notify(r.code === 0 ? `已恢复：${action.threadId}` : `恢复失败：${r.err}`, r.code === 0 ? "info" : "error");
        break;
      }

      case "close": {
        const ok = await uiConfirm(
          ctx,
          "关闭 thread",
          `将 ${action.threadId} 归档并标记为 abandoned。\n` +
            `会先在 .goo/plans/history/ 留副本，不删除文件、不改写步骤状态。\n是否继续？`,
          { defaultOnTimeout: false },
        );
        if (!ok) break;
        const r = runScript(cwd, ["close", action.threadId]);
        ctx.ui.notify(r.code === 0 ? `已关闭：${action.threadId}` : `关闭失败：${r.err}`, r.code === 0 ? "info" : "error");
        break;
      }

      case "doctor": {
        const r = runScript(cwd, ["doctor"]);
        ctx.ui.notify((r.out || r.err || "对账完成").slice(0, 800), r.code === 0 ? "info" : "warning");
        break;
      }

      case "refresh":
        break;
    }
    // 任何动作后重新载入列表（循环回到顶部重新渲染）
  }
}

export async function handleGooThread(args: string, ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  if (!existsSync(GOO_THREAD_PY)) {
    ctx.ui.notify("goo-thread.py 未找到", "error");
    return;
  }

  const trimmed = (args || "").trim();
  if (/^(help|-h|--help)$/.test(trimmed)) {
    ctx.ui.notify(USAGE, "info");
    return;
  }

  // 无参数 + TUI 模式 → 交互式管理界面
  if (!trimmed && ctx.mode === "tui" && ctx.hasUI) {
    try {
      await openThreadManager(ctx);
    } catch (e: any) {
      ctx.ui.notify(`thread 管理界面异常：${e?.message ?? String(e)}`, "error");
    }
    return;
  }

  // 其余情况：直接走脚本（可脚本化、非 TUI 模式也能用）
  const scriptArgs = trimmed ? trimmed.split(/\s+/).filter(Boolean) : ["list"];
  const r = runScript(cwd, scriptArgs);

  if (r.code !== 0) {
    ctx.ui.notify(
      `goo-thread ${scriptArgs[0] || ""} 失败 (exit=${r.code})${r.err ? `\n${r.err.slice(0, 400)}` : ""}`,
      "error",
    );
    if (r.out) ctx.ui.notify(r.out.slice(0, 800), "info");
    return;
  }
  if (r.out) ctx.ui.notify(r.out.slice(0, 1200), "info");
  if (r.err) ctx.ui.notify(r.err.slice(0, 400), "warning");
}

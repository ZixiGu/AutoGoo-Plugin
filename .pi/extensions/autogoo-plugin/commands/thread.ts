/**
 * goo-thread — 统一管理 AutoGoo-Plugin thread。
 *
 * 之前 thread 管理分散在四个脚本（thread-state.py / init-plan.sh /
 * goo-plan-health.py / thread-doctor.py）以及 /goo-plan 的隐式提问里。
 * 这里收口成一个命令，并保证 `switch` 同时同步兼容入口 .goo/plan.json
 * （只切 current_thread.json 是最常见的操作陷阱：/goo-status 与
 * /goo-continue 读的是兼容入口）。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../utils/paths.js";
import { execPython } from "../utils/exec.js";

const GOO_THREAD_PY = join(REPO_ROOT, "skills/auto-goo/scripts/goo-thread.py");

const USAGE =
  "用法：\n" +
  "  /goo-thread                 列出所有 thread（*=当前，⚠=需处理）\n" +
  "  /goo-thread show <id>       查看单个 thread 详情\n" +
  "  /goo-thread switch <id>     切换当前 thread（同步兼容入口）\n" +
  "  /goo-thread new <标题>      新建 thread（--steps N 可同时建计划骨架）\n" +
  "  /goo-thread close <id>      归档并关闭\n" +
  "  /goo-thread doctor [--fix]  对账修复\n" +
  "  /goo-thread health          健康检查";

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

  // 原样透传（按空白切分，引号内的标题由用户自己保证简单可分词）
  const scriptArgs = trimmed ? trimmed.split(/\s+/).filter(Boolean) : ["list"];

  try {
    const result = execPython(GOO_THREAD_PY, ["--root", cwd, ...scriptArgs], cwd, { timeout: 60000 });
    const out = (result.stdout || "").trim();
    const err = (result.stderr || "").trim();

    if (result.exitCode !== 0) {
      ctx.ui.notify(`goo-thread ${scriptArgs[0] || ""} 失败 (exit=${result.exitCode})${err ? `\n${err.slice(0, 300)}` : ""}`, "error");
      if (out) ctx.ui.notify(out.slice(0, 800), "info");
      return;
    }

    if (out) {
      // switch/close/doctor 属于动作型命令，用 followUp 让模型看到完整结果
      const isAction = ["switch", "close", "new", "doctor"].includes(scriptArgs[0]);
      if (isAction) {
        ctx.ui.notify(out.slice(0, 800), "info");
      } else {
        ctx.ui.notify(out.slice(0, 800), "info");
      }
    }
    if (err) ctx.ui.notify(err.slice(0, 300), "warning");
  } catch (e: any) {
    ctx.ui.notify(`goo-thread 执行失败: ${e?.message ?? String(e)}`, "error");
  }
}

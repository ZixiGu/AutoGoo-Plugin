/**
 * /goo-subagent — 查看 subagent 实时活动。
 *
 * 状态栏下面的 widget 只显示最近几行（回答"还在跑吗"）；这个面板是完整
 * 时间线 + 步骤切换（回答"到底做了什么"）。
 *
 * 数据来自内存中的 activityBus，无需读盘、无需调脚本。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityBus } from "../utils/activity.js";
import { guardRender } from "../utils/tui-kit.js";
import { SubagentPanel, type SubagentAction } from "../utils/subagent-panel.js";

export async function handleGooSubagent(args: string, ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    // 非 TUI：退化为一行文本摘要
    const steps = activityBus.list();
    if (steps.length === 0) {
      ctx.ui.notify("当前没有 subagent 活动。", "info");
      return;
    }
    const lines = steps.slice(0, 5).map((s) => {
      const last = s.events.at(-1)?.text ?? "";
      return `#${s.stepId} ${s.stepName} [${s.status}] ${last.slice(0, 80)}`;
    });
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  try {
    const action = await ctx.ui.custom<SubagentAction>((tui, theme, keybindings, done) => {
      return guardRender(
        new SubagentPanel(
          theme,
          done,
          () => {
            try {
              tui.requestRender();
            } catch {
              /* 渲染失败不阻塞 */
            }
          },
          keybindings,
        ),
        theme,
        "SubagentPanel",
      );
    });

    if (action?.action === "clear") {
      activityBus.clear();
      ctx.ui.notify("已清空 subagent 活动记录。", "info");
    }
  } catch (e: any) {
    ctx.ui.notify(`subagent 面板异常：${e?.message ?? String(e)}`, "error");
  }
}

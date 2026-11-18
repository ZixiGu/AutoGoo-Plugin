/**
 * /goo-subagent — 查看 subagent 实时活动。
 *
 * 状态栏下面的 widget 只显示最近几行（回答"还在跑吗"）；这个面板是完整
 * 时间线 + 步骤切换（回答"到底做了什么"）。
 *
 * 数据来自内存中的 activityBus，无需读盘、无需调脚本。
 *
 * 子命令：
 *   /goo-subagent        活动面板（默认）
 *   /goo-subagent model  查看/修改 subagent 使用的模型
 *
 * 为什么配置入口放在这里：不新增命令，且「模型」本身就是 subagent 的属性。
 * 默认跟随主模型（不打扰），想省钱跑 flash 模型时才需要改。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityBus } from "../utils/activity.js";
import { guardRender } from "../utils/tui-kit.js";
import { SubagentPanel, type SubagentAction } from "../utils/subagent-panel.js";
import {
  loadProjectConfig,
  writeExecutionModelConfig,
} from "../utils/paths.js";
import { resolveSubagentModel } from "../utils/subagent.js";
import { uiInput, uiSelect } from "../utils/ui.js";

export async function handleGooSubagent(args: string, ctx: ExtensionContext): Promise<void> {
  // 子命令：model —— 查看/修改 subagent 模型配置
  if (/^(model|模型)$/i.test(String(args ?? "").trim())) {
    return handleSubagentModelConfig(ctx);
  }

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


/**
 * `/goo-subagent model` —— 查看/修改 subagent 模型配置。
 *
 * 三态：
 *   1. config 显式配了 → 显示「固定使用 X/Y」，提供改回「跟随主模型」
 *   2. 没配，能解析主模型 → 显示「跟随主模型（X/Y）」，提供指定固定模型
 *   3. 都解析不到 → 提示需手动指定
 *
 * 写配置走 writeExecutionModelConfig（传 null 表示清除，恢复跟随）。
 */
async function handleSubagentModelConfig(ctx: ExtensionContext): Promise<void> {
  const cwd = ctx.cwd;
  const cfg = await loadProjectConfig(cwd).catch(() => null);
  const exec = (cfg as any)?.execution ?? {};
  const explicit = { provider: exec.subagent_provider, model: exec.subagent_model };
  const session = (ctx as any)?.model ? { provider: (ctx as any).model.provider, id: (ctx as any).model.id } : null;
  const resolved = resolveSubagentModel(explicit, session);
  const pinned = !!(explicit.provider && explicit.model);

  const current = pinned
    ? `固定使用 ${explicit.provider}/${explicit.model}`
    : resolved.provider && resolved.model
      ? `跟随主模型（${resolved.provider}/${resolved.model}）`
      : "未确定（无法从 ctx.model 或 PI_* 解析）";
  ctx.ui.notify(`当前 Subagent 模型：${current}`, "info");

  const FOLLOW = "跟随主模型（默认，零打扰）";
  const PIN = "指定固定的 provider/model";
  const options = pinned ? [FOLLOW, PIN, "取消"] : [PIN, FOLLOW, "取消"];
  // 走 ui.ts helper：带超时兜底，非交互上下文不会卡死。
  // 直接调 ctx.ui.select 会绕过这个保护（check-plugin 会报红）。
  const pick = await uiSelect(ctx, "Subagent 模型配置", options, { onTimeout: "cancel" });
  if (!pick || pick === "取消") return;

  if (pick === FOLLOW) {
    const ok = await writeExecutionModelConfig(cwd, null, null);
    ctx.ui.notify(
      ok ? "已清除固定配置，之后跟随主模型（不再询问）。" : "清除配置失败，见 plugin.log。",
      ok ? "info" : "error",
    );
    return;
  }

  // 指定固定模型：provider 与 model 必须成对（模型 id 常跨多个 provider）
  const p = (await uiInput(
    ctx,
    "Subagent provider（如 opencode-go）",
    explicit.provider || session?.provider || process.env.PI_PROVIDER || "",
    { onTimeout: "cancel" },
  ))?.trim();
  if (!p) {
    ctx.ui.notify("已取消（provider 为空）。", "info");
    return;
  }
  const m = (await uiInput(
    ctx,
    "Subagent model（如 deepseek-v4.1-flash）",
    explicit.model || session?.id || process.env.PI_MODEL || "",
    { onTimeout: "cancel" },
  ))?.trim();
  if (!m) {
    ctx.ui.notify("已取消（model 为空）。两者必须成对提供。", "info");
    return;
  }
  const ok = await writeExecutionModelConfig(cwd, p, m);
  ctx.ui.notify(
    ok ? `已固定为 ${p}/${m}，后续派发都使用它。` : "写入配置失败，见 plugin.log。",
    ok ? "info" : "error",
  );
}

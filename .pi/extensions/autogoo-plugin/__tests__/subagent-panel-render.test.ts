/**
 * Subagent 活动面板渲染测试。
 *
 * 面板依赖 pi-tui 的 matchesKey/visibleWidth（运行时注入），所以用 helpers
 * 里的 stub 装载，断言只打在**可见宽度与内容**上，不依赖真实 pi-tui 实现。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { installPiTuiStub } from "./helpers/pi-tui-hooks.js";

const theme: any = new Proxy({}, { get: () => (_t: string, s: string) => s });
// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("SubagentPanel", () => {
  it("空活动列表时给提示而不是崩溃或空白", async () => {
    installPiTuiStub();
    const { SubagentPanel } = await import("../utils/subagent-panel.js");
    const panel = new (SubagentPanel as any)([], theme, () => {}, () => {});
    const lines: string[] = panel.render(80);
    assert.ok(Array.isArray(lines));
    assert.ok(lines.length >= 1, "空列表也要有可见行");
    assert.ok(lines.join("").length > 0, "不能全空白");
    panel.dispose?.();
  });

  it("多种宽度下都不超宽", async () => {
    installPiTuiStub();
    const { SubagentPanel } = await import("../utils/subagent-panel.js");
    const acts = [
      { stepId: 1, name: "步骤一 · implementer", status: "running", startedAt: Date.now(), lines: [] },
      { stepId: 2, name: "步骤二", status: "completed", startedAt: Date.now(), lines: [] },
    ];
    for (const w of [40, 60, 80, 120]) {
      const panel = new (SubagentPanel as any)(acts, theme, () => {}, () => {});
      const lines: string[] = panel.render(w);
      for (const line of lines) {
        assert.ok(
          visible(line).length <= w,
          `width=${w} 超宽 ${visible(line).length}: ${visible(line).slice(0, 50)}`,
        );
      }
      panel.dispose?.();
    }
  });

  it("超长步骤名被截断而不是撑破行", async () => {
    installPiTuiStub();
    const { SubagentPanel } = await import("../utils/subagent-panel.js");
    const acts = [
      { stepId: 1, name: "超长".repeat(200), status: "running", startedAt: Date.now(), lines: [] },
    ];
    const w = 60;
    const panel = new (SubagentPanel as any)(acts, theme, () => {}, () => {});
    for (const line of panel.render(w)) {
      assert.ok(visible(line).length <= w, "超长名称必须被截断");
    }
    panel.dispose?.();
  });
});

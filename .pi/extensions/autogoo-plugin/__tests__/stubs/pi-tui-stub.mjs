/**
 * `@earendil-works/pi-tui` 的最小替身（**只给测试用**）。
 *
 * pi-tui 只在 pi 运行时注入，仓库里没有这个包，所以任何 `import { matchesKey }`
 * 都会让整个模块在 node:test 里加载失败 —— 这是 0.26.0 抽 tui-kit 的原因，
 * 但仍有 4 个面板模块直接依赖它（observe-panel / usage-panel / subagent-panel /
 * thread-ui），它们的上层命令因此一行都测不了。
 *
 * 对**命令 handler 冒烟测试**来说，面板的渲染细节不重要（渲染逻辑另有纯函数测试），
 * 重要的是"handler 会不会崩"。所以这里提供形状正确的替身：
 *   - matchesKey：只认最常见的键名/序列，够面板走完 switch 分支；
 *   - visibleWidth / truncateToWidth：直接复用自包含的 tui-kit 实现，
 *     避免替身与真实实现语义漂移；
 *   - Theme 相关：类型擦除后不需要运行时实现。
 *
 * 注意：替身**不参与**面板渲染断言。渲染断言一律打在 tui-kit / observe-tabs 上。
 */
import { truncateToWidth as kitTruncate, visibleWidth as kitWidth } from "../../utils/tui-kit.js";

const SEQUENCES = {
  escape: ["\x1b"],
  enter: ["\r", "\n"],
  tab: ["\t"],
  backspace: ["\x7f", "\b"],
  up: ["\x1b[A", "\x1bOA"],
  down: ["\x1b[B", "\x1bOB"],
  right: ["\x1b[C", "\x1bOC"],
  left: ["\x1b[D", "\x1bOD"],
  home: ["\x1b[H", "\x1b[1~"],
  end: ["\x1b[F", "\x1b[4~"],
  pageup: ["\x1b[5~"],
  pagedown: ["\x1b[6~"],
  delete: ["\x1b[3~"],
  space: [" "],
  "ctrl+c": ["\x03"],
  "ctrl+d": ["\x04"],
};

export function matchesKey(data, key) {
  const seqs = SEQUENCES[key];
  if (!seqs) return false;
  return seqs.includes(data);
}

export const visibleWidth = kitWidth;
export const truncateToWidth = kitTruncate;

export const KeybindingsManager = class {};
export const TUI = class {};

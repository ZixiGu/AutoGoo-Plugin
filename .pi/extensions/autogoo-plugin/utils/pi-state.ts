/**
 * 扩展级共享状态 —— 从 commands/start.ts 抽出，供拆分后的多个模块共用。
 *
 * 背景：`registerExecutionTools`（5 个工具，约 600 行）依赖三个模块级状态：
 *   - `_pi`          pi API 引用（setPi 注入）
 *   - `agentBusy`    当前是否在一个 turn 内（决定是否用 followUp 唤醒）
 *   - `wakeupPending` 同一段空闲期只唤醒一次
 *
 * 拆文件时若各留一份副本，状态就会分裂（工具模块改一份、命令模块读另一份），
 * 所以收敛到这里，用一个模块实例承载。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logWarn } from "./log.js";

let _pi: ExtensionAPI | null = null;

// Agent 忙闲状态（2026-10-08）：
// sendUserMessage({deliverAs:"followUp"}) 的语义是「等当前 turn 结束后再投递」。
// 主 Agent 在一个 turn 内连续调度多个 step 时，每条完成通知都会排队，
// 结果全部堆到 turn 结束才一次性倾泻（实测现象）。
// 而子进程模式（2026-08-10）下主 Agent await runSubagent 后本来就会在同一 turn
// 继续推进，**根本不需要被唤醒** —— 该通知只对「Agent 已空闲但 plan 仍有剩余」
// 的场景有意义（如后台/异步回调完成）。
// 因此用 agent_start/agent_end 跟踪忙闲：忙时不入队，只做即时 UI 反馈。
let agentBusy = false;
let wakeupPending = false;

export function setPi(pi: ExtensionAPI): void {
  _pi = pi;
}

export function getPi(): ExtensionAPI | null {
  return _pi;
}

export function isAgentBusy(): boolean {
  return agentBusy;
}

/** 标记「已入队一次唤醒」，避免同一段空闲期重复入队。返回是否本次真正占用。 */
export function claimWakeup(): boolean {
  if (wakeupPending) return false;
  wakeupPending = true;
  return true;
}

/** 注册 agent 忙闲跟踪（由 registerExecutionTools 调用一次）。 */
export function registerBusyTracking(pi: any): void {
  try {
    pi.on("agent_start", () => {
      agentBusy = true;
      // 新 turn 开始 → 上一条唤醒已生效，允许下一次空闲时再唤醒
      wakeupPending = false;
    });
    pi.on("agent_end", () => {
      agentBusy = false;
    });
    // 会话替换/重启时复位，避免 agent_end 未触发导致忙标志卡在 true（那样会永久抑制唤醒）
    pi.on("session_start", () => {
      agentBusy = false;
      wakeupPending = false;
    });
  } catch (e) {
    logWarn("[AutoGoo-Plugin] agent 忙闲跟踪注册失败:", e);
  }
}

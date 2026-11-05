/**
 * idle 检测的**安全性**：长命令执行期间不得误杀。
 *
 * 背景：`--mode json` 下，subagent 跑 `sleep N` / 编译 / 训练期间**完全没有输出**，
 * 事件只在工具结束后才出现。只看 JSON 事件的 idle 检测会误杀长命令。
 *
 * 这里验证多信号判定：
 *   A. JSON 事件
 *   B. 子进程 CPU 时间增长
 *   C. 有活跃后代进程（bash/node/python 在执行工具）
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSubagent } from "../utils/subagent.ts";

/** 假 pi：先输出一行，然后 spawn 一个长命令子进程并等它，全程不再输出 JSON。 */
function longCommandPi(dir: string, seconds: number): string {
  const script = join(dir, "longcmd.mjs");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"toolCall",name:"bash",arguments:{command:"sleep ${seconds}"}}],usage:{input:1,output:1}}})+"\\n");
// 模拟执行长命令：子进程存活期间父进程静默等待（与 pi 的真实行为一致）
const child = spawn("sleep", ["${seconds}"], { stdio: "ignore" });
child.on("close", () => {
  process.stdout.write(JSON.stringify({type:"tool_result_end",message:{role:"tool",content:[{type:"text",text:"done"}]}})+"\\n");
  process.exit(0);
});
`,
    "utf-8",
  );
  chmodSync(script, 0o755);
  return script;
}

test("长命令执行期间不误杀：idle 阈值 < 命令时长，但子进程活跃", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autogoo-longcmd-"));
  const oldCmd = process.env.AUTOGOO_SUBAGENT_CMD;
  // 命令跑 6s，idle 阈值 2s —— 若只看 JSON 事件，2s 后就会误杀
  process.env.AUTOGOO_SUBAGENT_CMD = `node ${longCommandPi(dir, 6)}`;
  try {
    const started = Date.now();
    const result = await runSubagent({
      task: "long command test",
      cwd: dir,
      provider: "test-provider",
      model: "test-model",
      timeoutMs: 60_000,
      idleTimeoutMs: 2_000,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.timedOut, false, `长命令不应被判超时（elapsed=${elapsed}ms）`);
    assert.equal(result.exitCode, 0, "应正常结束");
    assert.ok(elapsed >= 5_000, `应等命令跑完（≥5s），实际 ${elapsed}ms`);
  } finally {
    if (oldCmd === undefined) delete process.env.AUTOGOO_SUBAGENT_CMD;
    else process.env.AUTOGOO_SUBAGENT_CMD = oldCmd;
    rmSync(dir, { recursive: true, force: true });
  }
});

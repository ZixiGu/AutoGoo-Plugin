# Subagent 执行机制：pi 子进程模式

> 2026-08-10 迁移。替代旧的「会话内 followUp 注入」。
> **两个版本均已迁移**：AutoGoo-Plugin 插件版（实际运行）与
> AutoGoo 内建版（setup/packages/coding-agent/src/extensions/autogoo/，pi fork 内建）。

## 为什么迁移

旧机制：`pi.sendUserMessage(prompt, { deliverAs: "followUp" })` 把任务注入主会话，
依赖主 Agent turn 结束后消费 followUp 队列。

问题（实测复现）：
- **饥饿**：调度循环（持续调用 auto_goo_execute 等工具）会让 turn 永不结束，
  followUp 队列不被消费 → Subagent 任务永不执行（2026-08-07 修复用
  `terminate:true`，但自动派发路径仍不稳定，2026-08-10 再次复现 #3 饥饿）。
- **无上下文隔离**：Subagent 与主 Agent 共享会话上下文，长任务导致上下文膨胀。
- **无 usage 统计**：无法追踪每个 step 的 token/成本。
- **不可并行可靠投递**。

## 新机制

每个 step spawn 一个独立 pi 子进程（复用 pi 官方 subagent 示例的模式）：

```
auto_goo_dispatch / auto_goo_execute
  └─ runSubagent()            utils/subagent.ts
       └─ spawn(pi, [
            "--mode", "json",      # JSON 流式输出
            "-p",
            "--no-session",        # 上下文隔离（新会话）
            "--append-system-prompt", rolePrompt,   # 角色系统提示
            "Task: <step 契约 + wiki + 执行要求>",
          ], { env: { AUTOGOO_SUBAGENT: "1" } })
       ├─ 解析 stdout JSON（message_end → usage/turns/output）
       ├─ 每 20s onTick 保活心跳（防止 STALE 误杀）
       ├─ 超时 kill（默认 30min）
       └─ close → 兜底检查 step 状态（仍 running 则按 exitCode 标记）
```

## 子进程工具隔离（AUTOGOO_SUBAGENT=1）

子进程内 Subagent 只保留工作与汇报工具，**不注册调度/交互/远程工具**：

| 工具 | 子进程内 | 说明 |
|---|---|---|
| read / bash / edit / write | ✅ | 正常工作 |
| auto_goo_update_step | ✅ | 汇报进度/完成（写入共享 plan.json） |
| auto_goo_dag_status / auto_goo_pending_steps | ✅ | 查看状态 |
| auto_goo_execute / auto_goo_dispatch / auto_goo_prepare_dispatch | ❌ | 防止 Subagent 递归调度 DAG |
| auto_goo_ssh_* / auto_goo_worktree_* / auto_goo_ask_user | ❌ | 远程/隔离/交互由主进程负责 |

同时：子进程内 `auto_goo_update_step` 的「完成唤醒主 Agent」逻辑被跳过
（完成由父进程 `runSubagent` 的 close 事件感知）。

## 心跳保活

子进程可能运行数分钟到数十分钟，而心跳 STALE 阈值 120s。`runSubagent`
每 ~20s 调 `onTick`，由调用方（dispatch/execute）写 `--heartbeat` 保活，
防止长时间任务被误判为僵尸。

## 并行

`auto_goo_execute` 的 runSchedule 对就绪步骤并发 `Promise.all` spawn
（槽位 ≤ 6），同一批 step 并行执行；批内全部结束后返回，主 Agent 继续下一轮。

## 验证

- 单元测试：`.pi/extensions/autogoo-plugin/__tests__/subagent.test.ts`
  （7 用例：getFinalOutput / getPiInvocation / runSubagent JSON 解析与 usage /
  异常退出 / env 传递），用假 pi 脚本模拟 JSON 流，不依赖真实 LLM。
- 冒烟：真实 pi 子进程 "PONG" 任务 → exit 0、usage 收集正确。
- 端到端：临时 plan 单 step，子进程内 Subagent 写文件 + 调 update_step
  heartbeat/complete → plan.json 状态 completed、产物生成、usage 3 turns。

## 调试

- `AUTOGOO_SUBAGENT_CMD` 环境变量可覆盖子进程命令（测试/调试）。
- 子进程 stderr 会出现在 runSubagent 返回的 `stderr` 字段。

## 实现位置

| 版本 | 执行器 | 改造点 | 测试 |
|---|---|---|---|
| 插件版 | `.pi/extensions/autogoo-plugin/utils/subagent.ts` | `commands/start.ts`（dispatch）、`tools/execute.ts`（并发调度）、`index.ts`（子进程隔离） | `__tests__/subagent.test.ts`（7 用例） |
| 内建版 | `setup/packages/coding-agent/src/extensions/autogoo/subagent.ts` | `index.ts`（createPiSessionDispatcher → 子进程 + 兕底，删乐观标记；registerAutoGooTools 子进程隔离） | `test/autogoo-subagent.test.ts`（7 用例） |

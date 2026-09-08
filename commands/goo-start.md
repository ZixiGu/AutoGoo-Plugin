---
name: auto-goo:goo-start
description: 启动 AutoGoo-Plugin 完整工作流 — 召回 wiki 经验、生成 DAG、执行、验证并归档
---

# /auto-goo:goo-start — 启动 AutoGoo-Plugin 工作流

输入 `/auto-goo:goo-start <任务描述>` 启动完整工作流。若只想生成计划、不执行，请使用 `/auto-goo:goo-plan`。

## 工作流阶段

1. **Wiki 经验召回** — 读取已有项目知识和历史经验
2. **对话方案固化** — 把当前对话中已经确认的方案、约束、取舍和验收标准写入 `.goo/plan.json.context_digest`；大段内容写入 Goo-wiki 项目路径 `wiki/projects/<project-slug>/context/*.md`，Goo-wiki 不可用时降级到 `.goo/obsidian/<project-slug>/context/*.md`
3. **任务解析** — 将任务拆解为 DAG 步骤；写入新的 `.goo/plan.json` 前，先检查当前 thread/plan 是否已完成。只有旧 plan 已完成，或用户明确选择新建/继续并确认替换时，才把已有 plan 归档到 `.goo/plans/history/`
4. **执行前上下文同步** — 如果当前 `.goo/plan.json` 已存在，默认检查 plan 生成后新增的对话方案、约束、验收标准和用户偏好；有增量时先把旧 plan 复制到 `.goo/plans/history/`，再写入 `context_digest.post_plan_updates` 或 `context_artifacts`，然后再执行
5. **审阅与归档闸门** — 一旦 plan 准备开始执行，先检查 `.goo/brainstorm.json` 和 `.goo/plan.json` 的 `review.status`。如果仍是 `pending_user_review`，先展示摘要并优先用 `AskUserQuestion` / 结构化选择 UI 让用户确认、修改或停止，不自动归档或执行。确认后，如果 brainstorm 存在且 `archive` 缺失、`archive.status` 不是 `completed`，或归档路径不可验证，必须先派发 `recorder` 归档最终版 brainstorm；归档完成并回写 `.goo/brainstorm.json.archive` 后，才能进入业务 step 调度
6. **执行前自检** — 确认每个待执行 step 不依赖主会话隐含上下文，只依赖 plan、Markdown/context artifact、wiki 摘要和上游产物；检查每个 step 的 `subagent` 和 `task_agent` 是否合法，并检查 `available_skills` 是否只包含本步骤需要且实际可用的 skill；不合法时先补 plan 或创建角色，不直接降级主 Agent 执行
7. **远程资源预检与确认** — 如果 `.goo/config.json` 或 `~/.auto-goo/config.json` 有 `servers[]`，且当前待执行 step 尚未全部明确为本地/远程，或用户没有在本次 thread 的 `runtime.remote_resource_decision` 中确认过选择，派发 `collector` Subagent 运行 `skills/auto-goo/scripts/remote-resources.py --probe` 展示 CPU/内存/磁盘/GPU 摘要并回传 packet（主模型不亲自跑探测脚本，只消费 packet）。随后优先用 `AskUserQuestion` 复用 `id=remote_resource_usage` 模板询问本次是否使用服务器。用户选择本地时写入 `runtime.remote_resource_decision={"use_remote":false,...}` 并保持本地执行；用户选择服务器时，把适合远程的待执行 step 更新为 `execution_target="remote"`、`remote_server`、`remote_reason`、`requires_user_confirm=true`，并记录选择依据。不得因为检测到服务器或 GPU 就自动切到远程。
8. **远程执行自检** — 对 `execution_target="remote"` 的 step，先从 `.goo/config.json` 或 `~/.auto-goo/config.json` 读取 `servers[]`，确认 `remote_server` 能唯一匹配配置项、secrets 文件存在且不展开密码；派发前用结构化确认向用户说明远程命令类别、目标服务器、远程路径、产物位置和风险。未获确认时标记 `blocked` / `needs_user_approval`，不得自动改成本地执行。
9. **Subagent worktree 配置初始化** — 启动业务 step 调度前先读当前 thread plan 顶层 `runtime.subagent_isolation`；如果已有 `mode` 且 `project_root` 与当前 AutoGoo-Plugin 项目根一致，直接复用该缓存，不再询问。缓存缺失、`project_root` 不匹配或用户明确切换执行目录时，用 `AskUserQuestion` 复用 `id=git_init_project` 模板询问是否启用 worktree 隔离。用户选择“不启用”时写入 `{"mode":"none","project_root":"<path>","checked_at":"<iso>","decision":"worktree_disabled"}` 并继续，后续 Agent tool 省略 `isolation` 参数；如果省略 `isolation` 的实际派发仍报 `Failed to resolve base branch "HEAD"` / `git rev-parse failed`，说明当前 Claude Code Agent 包装层仍要求 Git HEAD，必须写入 `runtime.subagent_isolation.compatibility.agent_requires_git_head=true`，把当前 step 标记 `blocked` / `needs_user_approval`，并重新询问是否启用 worktree，不得重置 heartbeat 后反复重派，也不得创建 probe agent。用户选择“启用 worktree”时写入 `mode="worktree"` 并只检查当前项目根本身；不要设置 `GIT_DISCOVERY_ACROSS_FILESYSTEM`，不要向父目录、跨文件系统或备用路径寻找 Git root。若当前项目不是 Git repo，运行 `git init -b main`，不支持 `-b` 时初始化后立即 `git branch -M main`；若已有 Git 但没有 `HEAD`，复用当前仓库。随后执行初始提交：先检查 `git status --short` 和明显敏感文件风险，发现密钥、令牌、密码、secrets 文件或异常大批生成物时先标记 blocked 并前台确认；否则 `git add -A` 后提交 `chore: initialize repository for AutoGoo-Plugin worktree isolation`。只有 `HEAD` 可解析后才允许给 Agent tool 传 `isolation: "worktree"`；启用后仍无法得到 `HEAD` 时标记 workflow blocked，不降级普通派发，也不循环 probe。
10. **Thread 资源锁检查** — 派发任何会写文件、wiki、server 或 port 的 step 前，调用 `thread-locks.py check-plan --plan <thread-plan>` 检查冲突，确认可执行后调用 `thread-locks.py acquire-plan --plan <thread-plan>` 获取锁；流程完成、失败或停止时调用 `thread-locks.py release-plan --plan <thread-plan>` 释放锁。只读同一资源不冲突；写同一文件/目录、同一 wiki 页面、同一端口或同一远程长任务资源冲突时，把 step 标记为 `blocked` 并让主 Agent 前台询问用户处理方式。
11. **执行** — 按轮次并行/串行分发 Subagent；除生成 plan 本身外，主 Agent 不得直接代做 `research` / `exec` / `optimize` / `eval` / `review` / `audit` / `archive` 步骤。远程 step 通过 `skills/auto-goo/scripts/goo-ssh.sh --config <config> --server <remote_server> -- <remote command>` 执行；命令只能引用 plan 中已声明的远程路径和产物，不把密码写入 prompt、日志或命令行。派发每个 Subagent 前，主 Agent 必须先调用 `update-step.py --start --progress 5 --agent-id <agent>` 写入首个 `heartbeat_at`，再启动 Agent；这样即使 Agent 启动慢，前台 status 也能立即看到心跳。**每个 Subagent prompt 必须包含 `references/execution-engine.md` 中对应的 Heartbeat 强制分段**，否则 Subagent 不更新 `heartbeat_at`，会被误判为僵尸进程。Agent 返回 `Done` 时，`0 tool uses` 只能作为可疑信号；文本型 step 可以无工具完成，但必须有结构化最终答复、step log、heartbeat 里程碑或声明产物之一。若 step 声明了 `output`/`outputs`，必须验证产物存在且满足 `validation` 后才能 completed；缺失时记录实际 isolation 参数、plan 隔离模式和缺失路径，标记 blocked/failed，不得解锁下游。**每次 step 状态变更后，必须立即调用 `goo-status.py --update-status` 更新 plan 顶层 `status`、`started_at`、`completed_at`**，确保 plan 顶层状态与实际 step 状态一致。每次派发批次后、每轮 30s 心跳巡检后，以及任一 Agent 完成后，主 Agent 必须运行 `goo-status.py` 并把 RUNNING/告警摘要展示给用户；不得只在后台静默更新 plan。
12. **优化**（如需要）— 指标搜索 → Baseline → 优化 → 评测对比
13. **归档** — 执行记录和新增经验写入 Goo-wiki
14. **归档后任务总结报告** — 最终归档验收通过后，必须用 `AskUserQuestion` 复用 `id=post_archive_html_report` 模板询问是否生成并启动本次任务总结报告。用户选择生成时，在当前 thread 的 `reports/` 目录生成 `final-report.html`（或无法生成 HTML 时生成 `final-report.md`），内容聚焦任务结果、指标/模型对比、验证结论、关键产物、风险限制和归档链接；启动本地 server 时 URL 必须指向该报告页，例如 `http://127.0.0.1:<port>/final-report.html`。不得把 `/auto-goo:goo-publish` 的项目级 `.goo/site/index.html` 工作流状态页当作任务总结报告。

## 参数

任务描述支持自然语言，不限格式。AutoGoo-Plugin 会自动解析目标、拆解步骤、标注依赖。

如果当前目录已经存在 `.goo/plan.json`，且用户没有提供新的任务描述，优先从当前 plan 执行。执行前默认做一次 context sync：若当前对话在 plan 生成后新增了方案、取舍、约束、验收标准、用户偏好或 open question，先把旧 plan 复制到 `.goo/plans/history/`，再把短内容写入 `context_digest.post_plan_updates`，长内容写入 Goo-wiki/Markdown 并追加到 `context_artifacts` 后执行。只有新增内容与原 plan 冲突、扩大范围、改变验收标准或涉及危险操作时才询问用户确认；该询问必须优先使用结构化选项：`同步并继续执行`、`先修改 plan`、`停止并保留当前 plan`。

如果 `.goo/current_thread.json` 存在，`goo-start` 默认执行 current thread 的 active plan；如果用户提供新的任务描述且 current thread/plan 未完成，必须先用 `AskUserQuestion` 复用 `id=thread_action` 模板询问“新建 thread / 继续当前 thread / 取消”。用户选择新建 thread 时，生成新的 `.goo/threads/<thread_id>/plan.json` 并把 thread id 写入 plan；用户选择继续当前 thread 时，才允许合并或更新当前 thread 的 plan。执行过程中每次调用 `update-step.py` 或 `goo-status.py --update-status` 后，都必须同步 `.goo/threads/<thread_id>/thread.json.status` 和 `.goo/threads/index.json`。

执行前必须扫描 `.goo/change-requests/*.json`，优先使用 `change-requests.py list --thread-id <thread_id>` 查看当前 thread 的活跃请求，并用 `change-requests.py claim --thread-id <thread_id> --actor main-agent` 把要处理的请求标记为 `in_progress`。对当前 thread 的请求，把请求同步进 plan 或新增修改 step；对其他 thread 的请求，先用结构化选择让用户决定切换、复制或跳过。模型修改完成后必须增加审计 step；审计通过用 `change-requests.py status --request <id-or-path> --status completed --plan-step-id <step>` 更新状态，审计失败则写 `needs_revision` 并记录原因。

审阅或冲突确认必须优先使用 `AskUserQuestion` / 结构化选择 UI，并复用 `skills/auto-goo/references/interaction-templates.md` 中 `id=start_plan_review` 的 JSON 模板。新增约束或修改要求通过 Other 输入，输入后必须写入 `context_digest` 或更新 plan。如果结构化选择 UI / AskUserQuestion 不可用、调用失败或按钮没有渲染，使用以下纯文本 fallback：

```text
执行前需要确认当前 plan。请选择处理方式：
1. 确认并继续执行
2. 修改 plan / 同步新增约束
3. 停止并保留当前现场

这是 fallback；请回复 1/2/3，或直接写修改要求。
```

## 示例

```
/auto-goo:goo-start 用 Python 实现一个 CSV 解析器，支持大文件
/auto-goo:goo-start 优化项目中 JSON 序列化的性能
/auto-goo:goo-start 分析销售数据并按地区汇总
/auto-goo:goo-start 写一个斐波那契数列的单元测试
/auto-goo:goo-start 把这个 Markdown 文件转成 PDF 报告
```

## 备注

- 如果用户明确使用 `/auto-goo:goo-start`，即使任务只有单步，也生成一个带 `subagent` 的 step 并派发执行；只有未进入 AutoGoo-Plugin 工作流的普通单步问答/小改动才可直接处理
- 执行阶段不能依赖聊天记录里的隐含方案；默认先同步 plan 后对话增量，发现信息缺失时先补 plan 或写 Goo-wiki 项目路径 `context/*.md`
- 如果 `.goo/brainstorm.json` 或 `.goo/plan.json` 的 `review.status` 仍是 `pending_user_review`，执行开始前必须先停下来让用户审阅和确认；不得把未确认草案自动归档或直接执行
- 如果 `.goo/brainstorm.json` 存在且已经被用户确认，执行开始前必须确认 brainstorm 已归档；未归档时先归档最终确认版 brainstorm，再启动业务 step
- 执行阶段必须使用 plan step 中声明的 `subagent` 和 `task_agent`；若任一字段缺失或不合法，先补 plan 或创建角色/任务画像，不由主 Agent 直接代执行
- 执行阶段把 plan step 中的 `available_skills` 作为 Subagent prompt 的 skill allowlist；没有额外 skill 时传空数组，不把全部 skill 默认塞给 Subagent
- 执行阶段必须记录当前 `thread.id`；thread plan 使用 `.goo/threads/<thread_id>/plan.json`，日志写 `.goo/threads/<thread_id>/logs/`，并在执行完成、失败或阻塞后更新 thread 状态
- 执行阶段必须尊重 `.goo/locks/` 中的资源锁；派发前 acquire，结束/失败/停止时 release，冲突时不要并行写同一资源
- 检测到已配置远程服务器时，执行前必须先派发 `collector` 运行 `remote-resources.py --probe` 展示资源摘要并回传 packet，并用 `id=remote_resource_usage` 询问用户本次是否使用服务器；用户未确认远程前不得把本地 step 自动改成 remote
- 执行阶段尊重 plan step 的 `execution_target`；远程 step 必须使用配置中的 `remote_server` 和 `goo-ssh.sh`，并在用户授权后执行，不从聊天记录猜默认服务器
- 执行阶段必须尊重缓存的 Subagent worktree 配置：启动或恢复时写入 `runtime.subagent_isolation.mode`，后续派发只读取该字段；值为 `worktree` 才给 Agent tool 传 `isolation: "worktree"`，值为 `none` 则省略 `isolation`。若 `mode=none` 仍触发 `Failed to resolve base branch "HEAD"`，立即记录 `compatibility.agent_requires_git_head=true` 并阻塞等待用户选择启用 worktree；不得把非 Git 项目提升到父级 Git root 下派发，也不得重复 probe。
- 优化迭代默认最多 3 轮
- 日志保存在当前 thread 的 `.goo/threads/<thread_id>/logs/`；旧 `.goo/logs/` 仅作为兼容读取路径
- Plan 顶层 `status` 由 `goo-status.py --update-status` 自动计算更新：`blocked` 优先于普通 running/failed，所有步骤完成后才是 `completed`。主 Agent 在每次 step 状态变更后必须调用
- 每次任务最终归档完成后，都要优先用 `AskUserQuestion` 复用 `id=post_archive_html_report` 模板询问是否生成任务总结报告；用户选择生成时报告 URL 指向当前 thread 的 `reports/final-report.html`，不是项目级 `.goo/site/index.html`

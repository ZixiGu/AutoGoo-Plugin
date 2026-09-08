---
name: goo-workflow
description: "Use when the user says '/auto-goo:goo-init', '/auto-goo:goo-brainstorm', '/auto-goo:goo-plan', '/auto-goo:goo-start', '/auto-goo:goo-research', '/auto-goo:goo-daily-report', '/auto-goo:goo-usage', '/auto-goo:goo-usage-analyse', '/auto-goo:goo-observe', '/auto-goo:goo-publish', '找目标', '开始任务', 'run:', '日报', '周报', 'usage', 'token统计', 'token降本', '后台观察', '发布HTML', '自改进', or gives a goal-clear multi-step task that can be decomposed into sub-tasks. Runs Goo workflow: config init, wiki-based brainstorm, wiki recall, DAG planning, subagent execution, research material archiving, status/observe, HTML publishing, optimization, Goo-wiki archiving, usage monitor, usage cost analysis, daily reports, and plugin self-improvement. Compatible with Claude Code and Codex."
version: 0.5.1
tools: [Read, Write, Edit, Bash, WebSearch, Agent, AskUserQuestion, spawn_agent, wait_agent, request_user_input]
---

# AutoGoo-Plugin 自动化工作流

## 平台检测（会话开始执行一次，后续按结果分支）

检查当前可用工具，确定平台并锁定后续行为：

| 检测条件 | 平台 | 用户交互 | Subagent 派发 | Worktree |
|---------|------|---------|--------------|----------|
| 存在 `AskUserQuestion` 工具 | **Claude Code** | `AskUserQuestion` | `Agent` 工具（可传 `isolation`） | 支持 `mode="worktree"` |
| 存在 `spawn_agent` + `wait_agent` 工具 | **Codex** | `request_user_input`（仅 Plan mode 可用；Default mode 用纯文本 fallback） | `spawn_agent` + `wait_agent`（无 `isolation` 参数） | 自动 `mode="none"` |

**Codex 关键差异**：
- `request_user_input` 仅在 Plan mode 可用。Default mode 下用纯文本选项列表 fallback，明确标注 "(fallback)"。
- `spawn_agent` 无 `isolation` 参数，worktree 隔离不可用，自动走 `mode="none"`。
- `spawn_agent` 使用 `task_name`、`message` 和 `fork_turns`；`task_name` 使用稳定的小写任务名，role/task agent 内容合并进 `message`。不要传旧字段 `agent_type` 或 `fork_context`。
- `fork_turns="none"` 不继承上下文；需要有限上下文时用正整数字符串，需要完整上下文时用 `fork_turns="all"`。默认传最少必要上下文。
- Codex 并发槽位由当前运行环境决定，根 Agent 也占一个槽位。派发前用 `list_agents`/当前工具状态核对可用容量，不得按固定 6 槽强行派发。
- Codex 暂不支持 plugin 级 hooks，可通过项目 `AGENTS.md` 实现类似效果。

**命令触发差异**：Claude Code 通过 `/auto-goo:*` slash commands；Codex 通过 skill 名称或 `description` 匹配触发。

**项目约定单源化**：`goo-init` 的完整输出写入 `goo.md`（项目根目录），并在 `CLAUDE.md`（Claude Code）和 `AGENTS.md`（Codex）中各插入简短指针，指向 `goo.md`。两份指针内容相同，后续更新只需修改 `goo.md`。



收到可分解的多步任务后，按以下六个阶段执行。单步任务或纯问答不需启动此流程，直接执行即可。

**Subagent worktree 配置**：AutoGoo-Plugin 完全支持非 Git 项目；worktree 隔离是执行级统一配置，不是每个 Agent 或每个 step 临时决定。执行启动或恢复时先读取当前 thread plan 顶层 `runtime.subagent_isolation`：如果已有 `mode` 且 `project_root` 与当前项目根一致，直接复用，不再次询问。缓存缺失、`project_root` 不匹配或用户明确切换执行目录时，必须用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）复用 `id=git_init_project` 模板询问是否启用 worktree 隔离。

  **Codex 注意**：`spawn_agent` 无 `isolation` 参数，自动走 `mode="none"`，跳过 worktree 询问。用户选择不启用时写入 `mode="none"`，后续 Agent tool 省略 `isolation` 字段；如果省略 `isolation` 的实际派发仍报 `Failed to resolve base branch "HEAD"` / `git rev-parse failed`，说明当前 Claude Code Agent 包装层仍要求 Git HEAD，必须立刻写入 `compatibility.agent_requires_git_head=true`、把当前 step 标记 blocked/needs_user_approval，并重新询问是否启用 worktree，不得再重置 heartbeat 或用 probe agent 反复测试。用户选择启用时写入 `mode="worktree"`，并检查当前项目根本身是否是 Git repo 且 `HEAD` 可解析；不要向父目录、跨文件系统或备用路径寻找 Git root。若不是 Git repo，运行 `git init -b main`（不支持 `-b` 时初始化后立即 `git branch -M main`）；若已有 Git 但没有 `HEAD`，复用当前仓库。随后执行初始提交：先检查 `git status --short` 和明显敏感文件风险，发现密钥、令牌、密码、secrets 文件或异常大批生成物时先阻塞并前台确认；否则 `git add -A` 后提交 `chore: initialize repository for AutoGoo-Plugin worktree isolation`。只有确认 `HEAD` 可解析后才派发 `isolation: "worktree"`。启用后如果仍无法得到 `HEAD`，把 workflow 标记为 blocked，记录原因，不降级为普通派发，也不围绕 `Failed to resolve base branch "HEAD"` 循环 probe。

**完成验收闸门**：Agent 返回 `Done` 不是完成证据，`0 tool uses` 也不是失败证据。文本型 review/design step 可以不调用工具，但必须留下可验收结果：结构化最终答复、step log、heartbeat 里程碑或声明的 `output` 产物至少其一。若 step 声明了 `output` 或 `outputs` 必需产物，主 Agent 必须验证产物存在且满足 step 的 `validation`；缺失时不得标记 completed，也不得解锁下游。只有同时缺少结构化最终答复、step log、heartbeat 里程碑和声明产物时，主 Agent 才能判定为 dispatch 空跑或运行时前置失败，把 step 标记为 `blocked`/`failed` 并记录原因。记录原因时必须写明本次实际派发是否传了 `isolation`、plan 中的 `runtime.subagent_isolation.mode`、声明产物路径和缺失情况，不能只猜测是 worktree 问题。

**Subagent 留痕铁律**（高频故障的硬性补丁）：派发任务留痕缺失是 AutoGoo-Plugin 最常见的 runtime 故障。每次派发 Subagent 必须执行两段强制动作：(1) 主 Agent **派发前**调用 `skills/auto-goo/scripts/update-step.py --precreate-log --note "<派发上下文>"` 预生成 dispatch 骨架；派发完成后 Subagent **第一动作**调用 `update-step.py --heartbeat --progress 15 --note "<已开工>"` 接管骨架。(2) `update-step.py` 对 `--heartbeat` 强制要求 `--note`，缺 `--note` 直接 exit=2；`--heartbeat --note ""` 等于没记录。Subagent prompt 模板执行型的"0 号动作"段是这套机制的人类阅读版，必须出现在每个 Subagent prompt 里。详细分发清单、post-check 命令清单、按 step type 分流的产物检查表 → `references/execution-engine.md`「主 Agent Post-Check 流程」与「并行分发检查清单」。**分析型 Subagent（research/eval/audit/review）没有代码改动是合法的**，判断完成度靠"日志结论段 + 报告文件存在"双证据，不能只看 `git diff`。

**上下文预算**：`SKILL.md` 只保留触发条件、阶段入口和关键铁律。长规则、schema、prompt 变体和检查表放入 `references/`；重复机械操作优先脚本化，并让脚本输出紧凑 packet，避免主会话读取大段 Markdown。完整设计约束见 `references/skill-design.md`。

## 按需调用原则(On-Demand Recall)

**原则**：Subagent 和主 Agent 不得全量读取 wiki/references；按当前 step 的 `description`、`allowed_read_paths` 和 `inputs` 按需取用，受**条目数 + 字符预算 + 超时**三重约束。

规则：
1. Subagent prompt 必须显式列出本 step 实际需要的 wiki 路径子集(`wiki_paths` glob)，不允许传"读全部 wiki"。
2. `skills/auto-goo/scripts/wiki-graph-assist.py` 是 collector（wiki-gatherer）的打包/采集工具：wiki 召回时由 collector 运行它生成紧凑 graph packet 并回传，主模型只消费 packet（主模型可仅用于「验证/状态查看」，不作为第一手分析）。
3. 单次 Read/Grep 调用受字符预算(默认 < 20k 字符)和超时(默认 < 30s)双重约束；超出时优先用 glob+head 而非 Read 全文。
4. 跨 step 的 wiki 引用通过 `[[Wikilink]]` 表达，Subagent 按需点开；不需要的 wiki 页面不进入上下文。
5. 长期运行 step 必须用渐进披露：先读入口页 → 读相关 lessons → 读 task 页 → 必要时读 raw；不跳级全量。

## 记忆分层原则(Memory Layering)

**原则**：Subagent prompt、归档笔记和 wiki 页面应显式区分 L0/L1/L2/L3 四层记忆；检索时先 L2/L3 引导，具体事实回退 L1。

层级定义：
- **L0 — 原始记录**：`.goo/logs/` 下的 step log、原始命令输出、未脱敏的 transcript。**不进入 Subagent 默认上下文**。
- **L1 — 原子事实**：从 step 产物中提炼的关键决策、指标、命令、错误码；放在 step 报告的 "关键决策" 段。
- **L2 — 场景知识**：任务页、lessons、references，跨任务可复用的判断和方法。**Subagent 默认读取的层级**。
- **L3 — 项目画像**：项目入口 `<project-slug>.md`、`wiki/projects/<slug>/lessons/` 高频经验、CLAUDE.md 的项目约定。**主 Agent 启动时读取（作为方向感），Subagent 按 loadout 决定是否读**。

规则：
1. 归档笔记的 YAML frontmatter 必须含 `memory_layer: L0|L1|L2|L3` 字段，便于检索时按层级过滤。
2. 检索策略：主 Agent 启动先读 L3 项目入口作为方向感；L2 相关任务页/lessons 的召回由 collector（wiki-gatherer）采集并回传 evidence packet，主模型不亲自 grep/glob 全量 wiki；具体事实必要时回退 L1 step 决策；**Subagent 默认只看 L2，除非 plan 显式要求 L1**。
3. L0 原始日志只用于 trace/audit，经 recorder 提炼为 L1/L2 后才进入 wiki。
4. 项目入口 `<project-slug>.md` 显式标注自身为 L3，作为 wiki 的最高抽象层。
5. Recorder 在归档时必须判断并填写 `memory_layer`，不得留空。

命令模式：
- `/auto-goo:goo-init --user`：初始化用户级 `~/.auto-goo/config.json`，作为所有项目的默认配置。
- `/auto-goo:goo-init --project`：初始化当前项目 `.goo/config.json`，覆盖用户级默认配置。
- `/auto-goo:goo-brainstorm <方向/项目>`：目标不明确时，基于 Goo-wiki 和当前上下文生成候选 goals，写入 `.goo/brainstorm.json` 后等待用户选择。
- `/auto-goo:goo-plan <任务>`：只执行 Phase 0-1；如当前任务线未完成，先用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）询问新建 thread 还是继续当前 thread；写入当前 thread 的 plan 后停止，等待用户确认。
- `/auto-goo:goo-start <任务>`：执行完整流程，必要时可先生成 plan 再继续执行。
- `/auto-goo:goo-research paper <论文/DOI/arXiv/URL/PDF>`：研究资料归档入口；`paper` 子命令用于论文深读、代码/数据集搜索、下载检查和 Goo-wiki 归档。
- `/auto-goo:goo-daily-report [日期|范围]`：扫描 Claude Code / Codex 会话，生成 Goo-wiki 日报或周报素材。
- `/auto-goo:goo-usage [参数]`：扫描 Claude Code usage 日志，参考 Claude-Code-Usage-Monitor 的终端界面风格渲染今天总 token、项目分布、模型分布和可选 cost 面板。
- `/auto-goo:goo-usage-analyse [项目|范围]`：结合 usage 热点和 Goo-wiki 项目知识，归因 token 开销并生成可落地节省方案。
- `/auto-goo:goo-observe`：观察 Agent View 入口、当前 thread running step、heartbeat、step log 尾部和 shell 长任务日志模板。
- `/auto-goo:goo-publish`：无需 config，把 `.goo/` 工作流状态发布成静态多页 HTML，包含活动热力图、头脑风暴、计划、任务流程图、DAG、运行状态和产物索引。

**内容输出归档铁律**：除纯状态查看、纯初始化配置或用户明确要求不归档外，任何产生可复用内容的命令最终都必须归档到 Goo-wiki。包括 `/auto-goo:goo-brainstorm` 的候选 goals、`/auto-goo:goo-research paper` 的论文资料包和深度笔记、`/auto-goo:goo-usage-analyse` 的降本报告、`/auto-goo:goo-daily-report` 的日报/周报、`/auto-goo:goo-improve` 的改进建议、benchmark/plan/start/continue 的计划与执行经验。一般内容在 Goo-wiki 不可用时写入 `.goo/obsidian/<project-slug>/` fallback；不得只写 `.goo/*.json` 或只在聊天中展示。**论文分析和代码分析是强制 Goo-wiki 类型**：论文解读/深读以及代码库结构、调用链、数据流、架构、实现模式分析必须生成独立 Markdown 正文并实际写入 Goo-wiki，同时更新项目入口和 Goo-wiki `log.md`；fallback 只能防丢失并标记 `pending_wiki_sync`/`failed`，不能算归档完成。`goo-brainstorm` 和 `goo-plan` 必须先让用户审阅，用户确认前只写本地 `.goo/brainstorm.json` / `.goo/plan.json` 草案，不急着归档最终知识页。每次任务最终归档完成后，主 Agent 必须用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）复用 `id=post_archive_html_report` 模板询问是否生成任务总结报告页；用户选择生成时，网址必须指向本次任务的最终总结报告（例如模型指标对比、验证结论、关键产物、归档链接和后续建议），不能指向 `/auto-goo:goo-publish` 生成的项目级 `.goo/site/` 工作流状态站点。

**Thread 任务线**：AutoGoo-Plugin thread 是一条 brainstorm/plan/execution 任务线，保存在 `.goo/threads/<thread_id>/`，包含 `thread.json`、`brainstorm.json`、`plan.json`、`logs/`、`artifacts/` 和 `reports/`。`.goo/current_thread.json` 记录默认 thread；`.goo/plan.json` 是兼容入口，指向或复制当前 thread 的 active plan。用户启动新 plan 时，如果当前 thread/plan 未完成，必须优先用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）复用 `references/interaction-templates.md` 的 `id=thread_action` 模板询问：新建 thread、继续当前 thread、取消。用户未明确选择前，不得覆盖当前 thread 的 plan。每个 plan 顶层必须写入 `thread.id`、`thread.plan_path`、`thread.logs_dir` 和 `thread.artifacts_dir`；每次执行状态变化后必须同步 `.goo/threads/<thread_id>/thread.json.status` 和 `.goo/threads/index.json`。

**Thread 一致性与锁**：从 brainstorm 生成 plan 时，必须校验 `brainstorm.thread.id == plan.thread.id`，并保持 `archive.task_archive_root` 一致。并发执行前必须使用 `skills/auto-goo/scripts/thread-locks.py` 检查资源冲突；写同一文件、同一 wiki 页面、同一端口或同一远程长任务资源时不得并行，冲突 step 标记 `blocked` 并前台询问用户。只读同一资源不冲突。

**Web 修改请求**：`goo-publish --serve` 的 Web 表单只写 `.goo/change-requests/*.json`，不得直接改 plan、业务文件或 Goo-wiki。主 Agent 用 `skills/auto-goo/scripts/change-requests.py list/claim/status` 管理请求状态；claim 后必须把用户修改点同步进 thread plan 或 context artifact，再派发模型修改和审计。修改完成后必须把对应请求状态更新为 `completed`；审计失败时改为 `needs_revision` 并记录原因。

**同一任务归档根**：同一条任务链路的 brainstorm、plan 和 execution 知识归档默认放在同一个 `task_archive_root` 下，用子目录区分阶段：`brainstorm/` 保存候选目标、推荐顺序和选择依据；`plan/` 保存正式 DAG、上下文摘要和计划取舍；`execution/` 保存步骤证据、验证结果和最终经验。`task_archive_root` 优先位于 `wiki/projects/<project-slug>/tasks/<YYYY-MM-DDTHH-MM-SS-task-slug>/`；Goo-wiki 不可用时使用 `.goo/obsidian/<project-slug>/tasks/<task-slug>/`。同一 thread 内 `.goo/threads/<thread_id>/brainstorm.json.archive.task_archive_root` 与 `.goo/threads/<thread_id>/plan.json.archive.task_archive_root` 必须保持一致，除非用户明确要求分开归档。注意：这不同于本地 JSON 历史快照；旧 `.goo/plan.json` 仍保存到 `.goo/plans/history/`，旧 `.goo/brainstorm.json` 保存到 `.goo/brainstorms/history/`。

**HTML 发布层**：`/auto-goo:goo-publish` 是工作流展示层，无需运行 `goo-init` 或创建 `.goo/config.json`，默认从 `.goo/threads/`、`.goo/current_thread.json`、兼容 `.goo/brainstorm.json`、`.goo/plan.json`、历史快照、当前 thread logs/artifacts/reports、`.goo/change-requests/`、`.goo/obsidian/` 和当前项目 Claude Code usage 日志生成 `.goo/site/` 多页站点。`skills/auto-goo/templates/publish/workflow-shell.html` 是唯一运行时页面外壳，`skills/auto-goo/templates/publish/workflow-theme.css` 是唯一正式视觉主题；脚本填充标题、活动导航链接、正文、路径和交互脚本，并把主题复制到站点目录，禁止依赖发布后手工注入 CSS 或 `/tmp` 概念稿。正式主题采用紧凑工作台布局、浅色/暗色模式和页面语义色：计划/流程为蓝色、完成状态为绿色、代理执行为青色、头脑风暴为琥珀色、活动与归档为紫色、失败与风险为红色。默认生成总览、Threads、计划、活动、头脑风暴、运行状态、代理执行、产物归档和修改请求页面，关键页面标签优先使用中文；桌面端固定左侧导航，移动端恢复自然滚动。Token 格子悬浮时显示消耗明细，点击或聚焦后由下方文本型工作流活动说明所选时间段实际完成的工作；活动记录列表显示对应用户任务摘要，点击记录后展开完整用户任务原文和使用详情，但不发布 assistant 回复或完整对话正文。它会启动 `127.0.0.1:9877` server、尝试弹出浏览器，同时打印本机 IP 访问地址；端口占用时自动尝试后续端口。server 默认只读取已生成的 HTML，打开页面时不重新扫描 `.goo/`；需要每次刷新实时重建时再加 `--live`。发布 HTML 不替代 Goo-wiki 归档，不直接修改业务文件、plan 或 brainstorm；Web 表单只允许新增 `.goo/change-requests/*.json`，后续由主 Agent 纳入 thread plan 并审计。

**用户交互契约**：任何需要用户选择、确认、重试、跳过、合并、改写或授权的步骤，必须优先调用结构化选择 UI（Claude Code 用 `AskUserQuestion`，Codex 用 `request_user_input`），让平台渲染可用方向键移动、Enter 确认的选择控件；不得在工具可用时用普通文本要求用户手打 `1/2`、ID 或命令参数。每个问题至少给 2 个显式选项，推荐项放第一项并标注 Recommended；多候选问题必须把候选 ID/编号放进选项说明。只有结构化选择 UI 不可用、调用失败或按钮没有渲染时，才允许降级为纯文本编号列表，并明确这是 fallback。**Codex 注意**：`request_user_input` 仅在 Plan mode 可用，Default mode 用纯文本 fallback。用户未明确选择前，不得用推荐项静默继续。

**远程服务器机制**：`goo-init` 收集到远程服务器非敏感参数后，最终脚本调用必须追加 `--server 'name=<别名>,host=<ssh-host-or-ip>,user=<user>,port=<port>,type=<cpu|gpu>,purpose=<用途>,workdir=<远程工作目录>,setup=<命令1;命令2>,data_dir=<远程数据目录>,artifacts_dir=<远程产物目录>'`，可重复传多台，后四项可省略；`name` 是给模型、plan 和 `remote_server` 使用的稳定名称，`host` 是 SSH 连接地址，`ip` 仅作为兼容字段可选。密码不得进入聊天、命令行、plan、日志或 prompt，只能由用户填入 chmod 600 的 secrets 文件。`servers[].defaults` 可保存非敏感默认环境约定：`workdir`、`setup_commands[]`、`paths.data_dir`、`paths.artifacts_dir`；不得保存 token、API key、私钥、密码或带凭据的 export 命令。后续 `goo-plan` / `goo-start` / `goo-continue` 如果发现项目或用户配置里有 `servers[]`，必须先派发 collector 运行 `skills/auto-goo/scripts/remote-resources.py --probe` 获取 CPU/内存/磁盘/GPU 摘要并回传 packet（主模型不亲自跑探测脚本，只消费 packet），展示给用户后用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）复用 `id=remote_resource_usage` 模板确认本次是否使用服务器；探测失败只说明不可用原因，不自动转远程。用户确认使用远程后，才写入或执行 `execution_target="remote"`、`remote_server` 和 `remote_reason`；远程 step 的 `allowed_read_paths`、`allowed_write_paths`、`inputs`、`outputs` 和 `validation` 必须优先引用该服务器的 `defaults.workdir`、`defaults.setup_commands` 和 `defaults.paths`，缺失时再让用户确认。用户选择本地或未明确确认时保持 `execution_target="local"`。`remote_server` 优先写 `servers[].name`，不要让模型记 IP。远程 step 必须 `requires_user_confirm=true`，并通过 `skills/auto-goo/scripts/goo-ssh.sh --config <config> --server <remote_server> -- <remote command>` 执行，不默认使用第一台服务器。`auto_goo_ssh_exec` / `auto_goo_ssh_status` 遇到用户提供的服务器在配置中缺失时，会主动询问是否新增配置（收集 host/port/user/type 后写入 `.goo/config.json`）；提供的 `host`/`port`/`user` 与配置不一致或缺失时，会询问是否更新原配置。密码仍只存 secrets.json，新增流程不在对话中收集密码。纯密钥认证的服务器可不建 secrets 文件（无密码时走 BatchMode 密钥认证）。`auto_goo_ssh_monitor`（前台跟随）阻塞窗口内流式输出；需要同时做其他任务时用 `auto_goo_ssh_monitor_bg` 后台启动（立即返回 monitor_id，输出写 `.goo/artifacts/monitor/<id>.log`），`auto_goo_ssh_monitor_poll` 随时查询累积输出与状态，`auto_goo_ssh_monitor_stop` 终止。

**结构化交互固定结构**：需要 Enter-select 交互时必须按 `skills/auto-goo/references/interaction-templates.md` 中的 JSON 模板组织并实际调用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex），不得只把结构写成自然语言题目或自由改写选项。**Codex 注意**：`request_user_input` 参数格式与 `AskUserQuestion` 略有不同（见 `interaction-templates.md` 的 Codex 映射表），但模板 ID 和选项语义保持一致。字段固定为 `header`、`id`、`question`、`options[].label`、`options[].description`；推荐项放第一项，label 必须包含 `(Recommended)`。系统自动提供的 Other 只用于自定义输入，不算显式选项。凡能固定的问题必须复用模板；涉及路径、IP、端口、用户名、goal ID、分支目录、用户修改要求等输入时，模板必须提供默认选项并说明 Other 输入如何落盘、校验或继续追问。

## Phase -1: 项目初始化

首次使用 AutoGoo-Plugin 时，建议先运行 `/auto-goo:goo-init --user` 写入用户级默认配置；进入具体项目后，可运行 `/auto-goo:goo-init --project` 写入项目级覆盖配置。

初始化要求：
1. 使用主 Agent 交互模式：收到命令后直接开始交互提问，不预先检查环境。主 Agent 必须用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）问清作用域、wiki 路径、是否创建业务项目目录、创建后是否写入目录约定、是否更新项目 `CLAUDE.md`、是否配置远程服务器等，再调用脚本落盘；不得在结构化选择 UI 可用时用普通文本要求用户手打 `1/2` 或 `--project/--user`。不得派发 Subagent 代替初始化，也不得用临时代码写配置。如果结构化选择 UI / AskUserQuestion 不可用、调用失败或按钮没有渲染，才允许降级为明确标注 fallback 的纯文本列表选项，继续收集用户选择。
2. 最终落盘前必须先通过 `skills/auto-goo/scripts/resolve-root.sh` 的统一规则解析 AutoGoo-Plugin 根目录：Claude Code 读取 installed plugin/local directory marketplace；Codex 读取 `~/.codex/config.toml` 中启用的 plugin id 和 `~/.agents/plugins/marketplace.json` 的本地 source。当前工作目录可能是用户项目，不要假设相对路径存在；不得扫描当前目录或上级目录猜插件根目录；不得在根目录变量为空时拼出 `/skills/auto-goo/scripts/goo-init.sh`。两种平台的安装记录都不可用或目标脚本不存在时，必须 fail-fast 提示用户重新安装/启用插件。
3. 根据参数或主 Agent 提问选择作用域：`--user` 写 `~/.auto-goo/config.json`，`--project` 写 `.goo/config.json`。如果用户只输入 `/auto-goo:goo-init`，必须先用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）询问作用域，不得默认选择 project；用户选择后必须把 `--user` 或 `--project` 传给脚本。作用域问题必须包含这两个结构化选项：「项目级 --project (Recommended) - 写入当前项目 .goo/config.json」「用户级 --user - 写入 ~/.auto-goo/config.json」。
4. 必须用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）询问 Goo-wiki 路径，提供默认值 `~/workspace/Goo-wiki`；如果用户不输入路径，就按默认值处理。每个问题至少 2 个选项（推荐默认值 + 备选），如「~/workspace/Goo-wiki (Recommended)」「自定义路径（选择后在下方 Other 输入）」。如果交互控件不可用，使用明确标注 fallback 的纯文本列表选项继续收集路径；用户接受默认值或输入自定义路径后，都必须把 `--wiki-dir <路径>` 传给脚本，不得在未展示默认路径的情况下静默使用默认值。
5. 项目级初始化时，必须询问是否需要创建业务项目目录结构，且必须实际调用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）复用 `references/interaction-templates.md` 的 `id=project_workspace_create` 模板；默认不创建，用户未选择前不得静默创建目录。用户选择创建后，继续调用 `id=project_workspace_layout` 模板询问目录模板或自定义目录：选择 `standard`/`ml`/`data` 时传 `--project-layout standard|ml|data`；Other 输入为 `docs` 时传 `--project-layout docs`；其他 Other 输入按逗号分隔目录复述确认后传 `--project-dirs src,data/raw,docs,references/papers` 这类列表。内置模板必须包含 `references/` 和 `references/papers/`，用于存放参考资料、规范、paper PDF、arXiv/DOI 元数据和阅读材料；这些是业务项目上下文，不属于 `.goo/` 运行态。AutoGoo-Plugin 自身运行态目录固定在项目 `.goo/`，脚本写入固定 `workspace.paths`，并把业务目录写入 `project_workspace.{layout,dirs}`。如果创建了业务目录，主 Agent 必须只读扫描项目根目录已有内容，排除 `.goo/`、`.git/`、`.claude/`、已创建业务目录、secrets、锁文件和隐藏配置；发现可归类内容时，包括论文、PDF、bib、参考资料和外部规范，必须调用 `id=project_workspace_organize_existing` 模板询问是否生成整理方案，默认不整理。用户选择生成方案后，只能展示源路径、目标路径、归类理由、冲突风险和跳过项；必须再调用 `id=project_workspace_apply_organization` 模板二次确认后才允许移动，且不得覆盖、删除或移动敏感/不确定/目标冲突项。创建业务目录后还必须继续调用 `id=project_workspace_claude_md` 模板询问是否把目录约定写入项目 `CLAUDE.md`。
6. 询问用户是否有远程服务器需要配置。检测到目标 config 已有服务器时，先询问管理方式（保持已有并新增 / 删除已有 / 替换已有 / 清空全部 / 跳过），再逐字段收集新增或替换信息。用户确认后，使用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）逐字段收集服务器信息。**每个问题必须至少 2 个显式选项**（系统的自动 Other 不算），用户可直接选用预设值或通过 Other 输入自定义值：服务器类型（GPU/CPU）、服务器名称/别名、SSH host/IP/DNS、SSH 端口、用户名、用途说明、密码（可跳过，稍后手动填入 secrets 文件）。端口和用户名必须提供自定义选项（其他端口/其他用户名通过 Other 或输入框输入）。密码存储在独立 secrets 文件中（项目级 `.goo/secrets.json`，用户级 `~/.auto-goo/secrets.json`），文件权限 `chmod 600`；项目级 secrets 文件自动加入 `.gitignore`。config 中记录 `servers[].{name, host, ip?, port, user, type, purpose, secrets_file}`，不存储密码。支持配置多个服务器。删除用 `--remove-server <名称>`（可重复），全部清空用 `--clear-servers`；同名 `--server` 为替换（upsert）。
7. 配置远程服务器后，通过 `goo-ssh.sh` 连接。用法：`bash "$auto_goo_root/skills/auto-goo/scripts/goo-ssh.sh" [--config .goo/config.json] [--server INDEX|HOST]`。脚本从 `secrets.json` 读取密码，不暴露在命令行；如果没有配置密码，则退回普通 `ssh`，支持 SSH key 或手动认证。有密码自动登录时才需要 `sshpass`（首次使用前 `sudo apt install sshpass`）。
7. 确保目标目录存在：用户级 `~/.auto-goo/`，项目级 `.goo/`。
8. 如果目标配置已存在，脚本内部自行检测并询问是否覆盖。用户保留 config 但传了 `--update-claude-md` 或交互确认更新 `CLAUDE.md` 时，仍必须继续更新项目 `CLAUDE.md`。
9. 按优先级解析 wiki 路径：`AUTOGOO_PLUGIN_WIKI_DIR` → `.goo/config.json.wiki_dir` → `~/.auto-goo/config.json.wiki_dir` → `~/workspace/Goo-wiki`。
10. 确保 Goo-wiki 路径存在：如果用户确认或输入的 `<wiki_dir>` 不存在，脚本必须自动创建该目录，并补齐 `CLAUDE.md`、`log.md`、`wiki/projects/`、`wiki/concepts/`、`wiki/questions/`、`journal/daily/`、`journal/weekly/` 基础结构；不得因为路径不存在而改用 `.goo/obsidian/` fallback。
11. 如果是 `--project`，确定 `project_slug`：默认用项目根目录名，可用 `--project-slug <slug>` 覆盖；创建或复用 `<wiki_dir>/wiki/projects/<project_slug>/` 作为项目归档根路径。
12. 如果项目是 Git repo，读取 `origin` remote（没有 origin 时读取第一个 remote），写入 `.goo/config.json.archive.git_remote_url`，并同步到 `<wiki_dir>/wiki/projects/<project_slug>/<project_slug>.md` 的项目元信息块。
13. 写入目标 config，默认结构参考 `skills/auto-goo/templates/config.example.json`；项目级配置必须记录 `archive.project_slug`、`archive.project_dir`、`archive.fallback_project_dir`、固定 `.goo` 的 `workspace.paths`，以及可选 `project_workspace`；有远程服务器时写入 `servers`。
14. 如果是 `--project` 且创建了业务目录，必须用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）复用 `id=project_workspace_claude_md` 模板询问用户是否在项目 `CLAUDE.md` 中加入或更新 AutoGoo-Plugin marker 包裹的目录约定；如果 Goo-wiki 可用，也可继续询问是否写入归档原则和要求；只改该段，不覆盖用户已有项目指引。`--project` 且配置了远程服务器时，初始化后必须更新该 marker 段中的服务器概要、何时使用和安全约束，除非用户显式传 `--skip-claude-md`；远程 `workdir`、`setup_commands`、数据目录和产物目录细节仍只从 `.goo/config.json` 读取。非交互场景没有服务器时默认不写，需传 `--update-claude-md` 明确写入。
15. 展示推荐 SessionStart hooks，但不要自动覆盖 `.claude/settings.json`，除非用户明确要求。
16. 配置完成后，脚本不得尝试连接服务器（不做 ssh、ping、端口探测等任何网络连接）；仅写入配置文件。

## Phase 0: Wiki 经验召回

**先查已有经验，再规划新任务。** AutoGoo-Plugin 的默认目标不是从零开始，而是复用 Goo-wiki 中沉淀的项目知识、历史决策和失败经验。

召回步骤：
1. 按配置优先级解析 wiki 路径；不存在则记录 fallback，继续使用 `.goo/obsidian/` 本地归档。
2. 主模型派发 collector（wiki-gatherer）采集 wiki evidence packet：collector 根据用户任务提取项目名、领域词、文件名、命令、数据路径、指标名等关键词，在 Goo-wiki 中优先查找 `wiki/projects/` 相关项目页和任务页、`wiki/concepts/` 相关概念/指标/流程规范、`journal/weekly/` 近期周报中的项目状态/风险/下一步、`log.md` 最近活动记录，并按 delegation-policy §4 Evidence-Packet 协议回传结构化 packet（findings + evidence_path + confidence）。
3. 主模型基于 collector packet 提炼 `wiki_context`：已有约束、可复用命令、已验证路径、历史坑点、指标口径、命名规范、相关 wikilink。主模型只消费 packet 并按需点开单个证据路径，不亲自 Read/Grep 全量 wiki。
4. 规划时必须显式利用这些上下文；如果没有找到相关知识，也要记录 `wiki_context.found=false`，避免假装有历史依据。

不要把 wiki 当成最后才写的报告；它是任务启动时的项目记忆，也是任务结束后的经验沉淀层。

## Brainstorm 指令

`/auto-goo:goo-brainstorm <方向/项目/问题>` 是 AutoGoo-Plugin 内部指令，用于目标不明确时先找 goal，再进入 plan。

行为：
1. 解析 AutoGoo-Plugin 配置和 Goo-wiki 路径。
2. 派发 collector（wiki-gatherer）采集 wiki/信号 evidence packet：检索 `wiki/projects/`、`journal/weekly/`、`wiki/concepts/` 和 `log.md`，按 delegation-policy §4 Evidence-Packet 协议回传结构化 packet。
3. 主模型基于 collector packet 提取未完成事项、反复问题、风险、近期计划、指标缺口、文档缺口、测试缺口、发布阻塞和可复用经验（只消费 packet，不自己 Read/Grep 全量 wiki）。
4. 主模型基于 packet 提炼共同前置条件 `global_prerequisites`，例如数据路径、账号权限、远程资源、评价指标、用户取舍和安全确认。
5. 多轴发散候选方向（主模型高认知综合）：至少覆盖快速交付、长期架构、风险/债务、验证/评测、文档/知识沉淀、自动化/工具化、用户体验/流程改进、低成本试探中的 5 类；先生成 5-9 个初始候选，再合并为 3-7 个最终候选，每个包含 `id`、`name`、`why`、`expected_output`、`acceptance_criteria`、`evidence`、`risk`、`prerequisites`、`readiness_checklist`、`first_step`、`priority_hint`。
6. 用户审阅前先做自我检查：去重合并、补证据缺口说明、校准风险/成本/依赖、确认每个 goal 有产物和验收方式，并在 `.goo/brainstorm.json.self_check` 记录覆盖角度、删改原因、证据缺口、风险校准和推荐排序依据。
7. 写入 `.goo/brainstorm.json`，状态为 `pending_decision`。如果旧 `.goo/brainstorm.json` 已存在，先原样复制到 `.goo/brainstorms/history/brainstorm-<timestamp>.json`。
8. 向用户展示推荐顺序、共同前置条件、自检摘要和每个候选 goal 的 ready checklist，等待用户选择、合并、改写或要求继续 brainstorm；用户确认前只保留本地 `.goo/brainstorm.json` 草案，不写 Goo-wiki/fallback 最终归档。
9. 用户确认最终候选目标后，再将候选 goals、共同前置条件、推荐顺序、用户选择/合并依据、自检摘要和关键证据归档到同一任务归档根的 `brainstorm/` 子目录；Goo-wiki 不可用时写入 `.goo/obsidian/<project-slug>/tasks/<task-slug>/brainstorm/` fallback，并在 `.goo/brainstorm.json.archive` 记录 `task_archive_root` 和 `brainstorm_dir`。

边界：
- 不写 `.goo/plan.json`。
- 不生成执行 DAG。
- 除 collector 召回采集外，不派发执行型 Subagent。
- 不修改业务文件；用户确认前只允许写 `.goo/brainstorm.json`，不要写 Goo-wiki/fallback 归档笔记。
- 不运行实现、评测、训练、安装、远程或删除命令。
- 用户明确一个或多个 goals 后，再调用 `/auto-goo:goo-plan <明确目标>`。

## Phase 1: 任务解析

**必须先解析为 DAG，不得跳过规划直接动手编码。**

**并行优先**：DAG 规划默认最大化可安全并行的执行层。只有真实数据依赖、验收/用户确认门槛、共享写入冲突、资源冲突或高风险顺序要求，才允许写 `depends_on`。不要因为用户描述顺序、文档段落顺序、同属一个 goal 或“看起来更稳”把可并行步骤串成线性链。

### 规划前现有 plan 检查

每次进入 `/auto-goo:goo-plan`、`/auto-goo:goo-start` 中的自动规划阶段，或任何会写入新 plan 的流程前，必须先检查 `.goo/current_thread.json` 指向的 thread plan 和兼容 `.goo/plan.json`：

1. 如果当前 thread plan 和 `.goo/plan.json` 都不存在，正常生成新 plan。
2. 如果存在旧 plan，读取 `steps[]` 和顶层 `status`，判断是否全部完成。只有所有 step 的 `status` 都是 `completed`，且顶层 `status` 为 `completed` 或可由 steps 推断为完成时，才允许直接归档旧 plan 并生成新 plan。
3. 如果存在未完成 step，或顶层 `status` 是 `pending` / `running` / `blocked` / `paused` / `failed`，必须暂停规划，向用户展示未完成 step 数量和关键摘要，并询问用户选择：
   - 新建 thread：创建 `.goo/threads/<thread_id>/`，新任务写入独立 plan/logs/artifacts，不覆盖当前执行现场。
   - 继续当前 thread：把新需求合并进当前 thread 的 plan，保留已完成步骤、日志、产物和执行证据。
   - 取消：不写入新计划。
4. 上述询问必须优先使用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）呈现，并复用 `id=thread_action` 模板；纯文本编号只作为交互控件不可用时的 fallback。用户未明确选择前，不得覆盖、归档或重写当前 thread 的 plan。

解析步骤：
1. 识别输入形态 — 普通一句话、Markdown 任务包、已有 plan、issue/PR 描述、日志片段等要区别处理。
2. 如果输入是 Markdown 文件或片段，先解析标题层级、checkbox、编号列表、表格、代码块、路径、命令、约束和验收标准；不得简单视为"文本处理/整理 Markdown"任务。
3. 确认目标已明确 — 目标可以来自用户直接描述，也可以来自用户明确选择的 `.goo/brainstorm.json` candidate goal；如果用户还不知道要做什么、要求 brainstorm、探索方向或基于 wiki 找下一步，停止 plan 流程并切换到 `/auto-goo:goo-brainstorm`。
4. 识别交付目标 — 抽取一个或多个 `goals[]`，每个 goal 都要有交付物、验收标准和优先级；不能把多个目标压成一句含糊的总目标。
5. 如果用户选择了 brainstorm candidate goal，读取 `.goo/brainstorm.json`，把选中的 `candidate_goals[]` 转成正式 `goals[]`，并把 `prerequisites` / `readiness_checklist` 转成前置检查 step、`validation` 或 `requires_user_confirm`。
   - 如果 `.goo/brainstorm.json.archive.task_archive_root` 存在，plan 归档必须复用该目录，把正式 DAG 和计划摘要写到 `plan/` 子目录，并在 `.goo/plan.json.archive.task_archive_root` 记录同一个路径。
   - 如果 brainstorm 尚无 `task_archive_root`，先创建同一任务归档根并补写 `.goo/brainstorm.json.archive.task_archive_root` / `brainstorm_dir`，再写 plan 归档。
6. 判断 goal 关系 — 独立 goal 优先拆成多个 plan；共享前置步骤则保留一个 DAG 并分支；强依赖 goal 按依赖链串联；冲突或优先级不清时先问用户。
7. 合并 wiki_context — 把既有项目经验转成约束、默认命令、风险提醒和可复用产物路径。
8. 固化对话方案 — 把当前对话里已经形成的方案、备选路线、取舍原因、用户偏好、验收标准和仍未解决的问题写入 `context_digest`；大段材料优先写入 Goo-wiki 项目路径 `wiki/projects/<project-slug>/context/<timestamp>-planning-context.md` 并在 `context_artifacts` 引用，Goo-wiki 不可用时降级到 `.goo/obsidian/<project-slug>/context/`。
9. 逆向拆解 — 从每个 goal 倒推，追问到"不可再分"的原子步骤。如果任务本身就是单步的（如"把这个文件转成 PDF"），直接执行，不走此流程。
10. 标注依赖关系 — 识别前置条件，推导拓扑顺序。原始数据准备 → 处理 → 输出，每一步依赖前一步的输出；每个非归档 step 必须绑定 `goal_id` 或 `goal_ids`。
11. 并行优先审计 — 遍历所有非归档 step，移除仅由叙事顺序、文档顺序或保守习惯造成的依赖；只读同一输入、写不同产物、验收互不依赖的步骤应放入同一 `tier`，并保持空/相同 `depends_on`。每条依赖都要能说明具体上游产物、验收结果、确认门槛或冲突资源。
12. 识别优化标记 — 含"性能、速度、延迟、吞吐、效率、内存、GPU、耗时"关键词 → 标记 `type: "optimize"`
13. 追加默认归档步骤 — DAG 最后必须有 `归档到 Goo-wiki`，依赖所有非归档叶子步骤；除非用户明确禁止归档或配置 `archive.enabled=false`
14. 归档历史 plan — 仅当旧 plan 已完成，或用户明确选择“新建 plan”时，才把 `.goo/plan.json` 复制到 `.goo/plans/history/plan-<timestamp>.json`；不得静默覆盖未完成 plan。
15. 输出 `.goo/plan.json`，并在审阅摘要中展示并行组、必要串行链及主要风险。

### 步骤粒度原则

- 每步应产出可验证的中间结果（文件、指标、报告）
- 步骤过多（>10）说明拆分过细，考虑合并
- 步骤过少（<2）说明拆分不够，需要继续追问"还需要什么"
- 步骤粒度服务于并行调度：能独立读输入、独立写产物、独立验收的工作不要合并成一个大步骤，也不要串成逐步依赖

### Plan 拆分决策

**DAG 过深、步骤过多或中间需要判断时，就拆成多个小 plan。** 小 plan 2-4 步，目标是当前轮可直接完成并验收；大 plan 6-20 步，提供全局 DAG 视图但依赖心跳+产物检测兜底。

触发拆分的信号：步骤 > 8、DAG 层数 > 3、中间有人工判断点、后半段依赖前半段产物质量。

完整拆分规则 → `references/task-parsing.md`

### plan.json 概要

```json
{
  "task": "<任务描述>",
  "goals": [
    {
      "id": "g1",
      "name": "<目标名>",
      "description": "<该目标要交付什么>",
      "priority": 1,
      "status": "pending",
      "acceptance_criteria": ["<该目标的验收标准>"],
      "outputs": ["<该目标的最终产物>"],
      "depends_on": []
    }
  ],
  "status": "pending",
  "created_at": "YYYY-MM-DDTHH-MM-SS",
  "started_at": null,
  "completed_at": null,
  "runtime": {
    "subagent_isolation": {
      "mode": "worktree",
      "checked_at": "YYYY-MM-DDTHH-MM-SS",
      "reason": "project_git_head_available"
    }
  },
  "wiki_context": {
    "found": true,
    "sources": ["wiki/projects/<slug>/<note>.md"],
    "reused_knowledge": ["<约束/命令/路径/指标/历史经验>"]
  },
  "context_digest": {
    "found": true,
    "decisions": ["<本轮对话已确认的方案/取舍>"],
    "constraints": ["<用户明确约束>"],
    "acceptance_criteria": ["<验收标准>"],
    "open_questions": []
  },
  "context_artifacts": ["<可选：<wiki_dir>/wiki/projects/<project-slug>/context/xxx.md 或任务说明 md>"],
  "steps": [
    {
      "id": 1,
      "goal_id": "g1",
      "tier": 1,
      "name": "<步骤名>",
      "description": "<做什么，含输入、边界、输出和验收点>",
      "depends_on": [],
      "type": "exec",
      "subagent": "implementer",
      "task_agent": "feature-builder",
      "available_skills": [],
      "status": "pending",
      "progress": 0,
      "output": "<主产物路径>",
      "inputs": ["<输入文件/上游产物/上下文 artifact>"],
      "outputs": ["<主产物路径>"],
      "allowed_read_paths": ["<允许读取的路径>"],
      "allowed_write_paths": ["<允许写入的路径>"],
      "validation": "<验收方式：命令、文件存在性、人工检查点或指标阈值>",
      "risk_level": "low",
      "requires_user_confirm": false,
      "agent_id": null,
      "heartbeat_at": null,
      "started_at": null,
      "completed_at": null
    },
    {
      "id": 2,
      "goal_ids": ["g1"],
      "tier": 2,
      "name": "归档到 Goo-wiki",
      "description": "将任务目标、计划、关键证据、产物路径、验证结果、决策和可复用经验归档到 Goo-wiki；必须补齐摘要、详细事实记录、证据索引和 Wikilink/backlink；若上游包含论文分析或代码分析，独立 Markdown 分析正文必须实际写入 Goo-wiki，fallback 不能视为完成",
      "depends_on": [1],
      "type": "archive",
      "subagent": "recorder",
      "task_agent": "wiki-curator",
      "available_skills": [],
      "status": "pending",
      "progress": 0,
      "output": "Goo-wiki/wiki/projects/<project-slug>/ 或 .goo/obsidian/<project-slug>/",
      "inputs": [".goo/threads/<thread_id>/plan.json", ".goo/threads/<thread_id>/logs/", "<上游产物路径>"],
      "outputs": ["Goo-wiki/wiki/projects/<project-slug>/ 或 .goo/obsidian/<project-slug>/"],
      "allowed_read_paths": [".goo/threads/<thread_id>/plan.json", ".goo/threads/<thread_id>/logs/", ".goo/threads/<thread_id>/artifacts/", ".goo/plan.json", ".goo/artifacts/"],
      "allowed_write_paths": ["Goo-wiki/wiki/projects/<project-slug>/ 或 .goo/obsidian/<project-slug>/"],
      "validation": "归档页、execution/record.md 和 execution/evidence-index.md 存在；任务页、项目入口与 log.md 链接完整；论文分析或代码分析的独立正文必须位于 Goo-wiki，只有 fallback 时状态为 pending_wiki_sync/failed",
      "risk_level": "low",
      "requires_user_confirm": false,
      "agent_id": null,
      "heartbeat_at": null,
      "started_at": null,
      "completed_at": null
    }
  ]
}
```

完整 schema、时间戳格式、依赖声明规则 → `references/task-parsing.md`

Markdown 任务输入的完整解析规则也在 `references/task-parsing.md`：Markdown 可以是需求文档、TODO 清单、执行计划或 issue 模板，只有用户明确要求总结/润色/改写时才按文本处理。

### Plan/Wiki/MD-only 执行契约

生成 plan 后，执行阶段必须能在不读取主会话历史的情况下继续。也就是说，`.goo/plan.json`、`context_artifacts` 指向的 Goo-wiki/Markdown、Goo-wiki 召回摘要和上游产物路径必须足够让 Subagent 完成对应 step。

- step 的 `description` 必须写清楚做什么、边界、输入、输出和验收点，不能依赖"刚才讨论的方案"。
- 多 goal plan 中，非归档 step 必须包含 `goal_id` 或 `goal_ids`；归档 step 用 `goal_ids` 覆盖所有被归档目标。
- step 应包含 `inputs`、`outputs`、`allowed_read_paths`、`allowed_write_paths`、`validation`、`risk_level` 和 `requires_user_confirm`，让执行阶段不用猜读写范围、验收方式和是否需要用户确认。
- `goo-start` / `goo-continue` 执行前默认执行 context sync：检查 plan 生成后当前对话是否新增方案、取舍、约束、验收标准、用户偏好或 open question。短内容写入 `context_digest.post_plan_updates`；长内容写入 Goo-wiki 项目路径 `context/` 并追加到 `context_artifacts`，Goo-wiki 不可用时写 `.goo/obsidian/<project-slug>/context/`。同步前必须先把旧 plan 复制到 `.goo/plans/history/`；只有新增内容与原 plan 冲突、扩大范围、改变验收标准或涉及危险操作时才问用户确认。确认问题必须优先用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）复用 `references/interaction-templates.md` 的 `id=context_sync_confirm` 模板。
- `goo-start` / `goo-continue` 一旦准备把 plan 从待执行状态推进到执行状态，必须先检查 `.goo/brainstorm.json` 和 `.goo/plan.json` 的 `review.status`。如果仍是 `pending_user_review`，先停下来让用户审阅和确认；确认后如 brainstorm 还没有归档，再派发 `recorder` 归档最终版 brainstorm。该归档完成前，不启动业务 step 调度。
- Subagent prompt 只允许使用当前 step、`context_digest`、相关 `wiki_context`、`context_artifacts` 路径和上游产物摘要；不传完整聊天记录。

## Phase 2: 执行（槽位调度）

**当前 thread plan 是执行状态源**。派发、完成、失败均实时回写 `.goo/threads/<thread_id>/plan.json` 或兼容 `.goo/plan.json`。历史 plan 只归档在 `.goo/plans/history/`，不得作为恢复来源，除非用户明确指定。执行时不得依赖主会话隐含上下文；所有执行必需信息必须在当前 plan、引用的 Markdown/context artifact、wiki 摘要或上游产物中。每次 `update-step.py` 或 `goo-status.py --update-status` 后，必须同步 thread metadata。

**Brainstorm/Plan 审阅闸门**：执行调度开始前必须确认 `.goo/brainstorm.json` 和 `.goo/plan.json` 不是待审草案。若 `review.status="pending_user_review"`，先让用户审阅、修改或确认，并优先用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）复用 `references/interaction-templates.md` 的 `id=plan_review_start` 模板；不能自动归档或执行。用户确认后，如果 `.goo/brainstorm.json` 存在且未能证明已归档，再归档最终版 brainstorm，然后开始执行 plan steps。归档内容至少包括候选 goals、推荐顺序、用户最终选择、未选原因或合并依据、前置条件、ready checklist、关键 wiki 证据，以及该 brainstorm 如何转成当前 `.goo/plan.json`；归档完成后回写 `archive.status="completed"`、`archive.task_archive_root`、`archive.brainstorm_dir`、fallback 状态和 `log.md` 更新状态。若当前 plan 已有 `archive.task_archive_root`，brainstorm 必须补写到同一个 root 的 `brainstorm/` 子目录；若没有，则创建 root 并同步写回 plan 与 brainstorm。

**槽位调度模型**：固定 6 个并发槽位 + 动态就绪队列 + 连续下发。agent 完成即释放槽位，其下游立即入队，不用等同层其他 agent。

**主 Agent 总控**：主 Agent 负责整体目标、DAG 拆解、上下文裁剪、调度、验收、冲突处理和最终归档判断；Subagent 只执行被分配的 step，不得自行扩大范围或改写整体计划。

**强制 Subagent 执行**：除 `goo-plan` 只生成计划外，`goo-start` / `goo-continue` 的 `research`、`exec`、`optimize`、`eval`、`review`、`audit`、`archive` 步骤必须派发给对应 Subagent。主 Agent 不得直接替 Subagent 读写步骤产物、运行步骤命令或完成步骤验收。

**Subagent 缺失处理**：如果步骤的 `subagent` 字段缺失或不属于合法角色，先补 plan 或创建新的 Subagent 角色，不由主 Agent 降级代执行。

**Subagent 上下文隔离**：每个 Subagent 默认只拿当前 step、必要项目约束、相关 wiki_context 摘要、上游产物路径、允许读写边界和回写要求。Subagent 之间通过当前 thread 的 `plan.json`、`logs/`、`artifacts/` 和产物路径交接，不共享完整会话历史或彼此的推理草稿。

**Subagent 显式分工**：每个 step 必须包含 `subagent` 和 `task_agent` 字段。`subagent` 只允许稳定 Role Agent：`researcher`、`collector`、`implementer`、`optimizer`、`evaluator`、`reviewer`、`auditor`、`recorder`；`task_agent` 必须从对应 role 的 `agents/tasks/` 目录下选择，例如 `document-analyst`、`data-collector`、`usage-collector`、`feature-builder`、`test-runner`、`code-reviewer`、`evidence-auditor`、`wiki-curator`。调度时先按 `subagent` 选择 role prompt，再按 `task_agent` 叠加细分任务 prompt。**角色分工原则**：`collector` 负责确定性数据采集与机械整理（usage/会话/wiki graph/远程探测/日志频率 → packet）；`researcher` 收窄为认知性研究（学术论文/代码库架构/领域多来源调研）；两者都不做主 Agent 亲自读原文，解读交给主模型综合，归档正文交给 recorder。若缺失或不合法，先补 plan 或创建新角色/任务画像，不由主 Agent 代执行。

**权限分层**：AutoGoo-Plugin 不让后台 Subagent 做平凡权限交互。普通读写和低风险命令必须在 plan 的 `allowed_read_paths`、`allowed_write_paths`、`validation`、`requires_user_confirm=false` 与项目命令 allowlist 中提前声明，Subagent 在边界内直接执行。可预见的安装依赖、网络下载、远程执行、长跑任务、端口监听、批量数据改写、跨机器同步或高成本操作，规划阶段必须标记 `requires_user_confirm=true`，由主 Agent 在派发前一次性说明作用域、命令类别、产物位置和风险并取得确认。执行中遇到 `PermissionDenied`、sandbox blocked、approval required、路径越界或命令不在允许范围时，Subagent 不得自行弹窗、不得静默跳过、不得要求主 Agent 直接代做；必须写日志并回写当前 step 为 `blocked`/`needs_user_approval`，说明所需命令、原因、读写路径、风险和建议处理。主 Agent 聚合这些阻塞项后在前台向用户申请许可；用户批准后只在批准范围内重派 Subagent 或执行许可命令，用户拒绝后再标记 failed 或调整 plan。

```
MAX_CONCURRENT = min(plan.json 配置值或 6, 当前平台实际可用的 Subagent 槽位)

主循环:
  1. 扫描 status=pending 且 depends_on 全 completed → 按优先级排序 → 入队
  2. 填充空槽位 (间隔 3-5s 错峰)：派发每个 Subagent 前先调用 `update-step.py --start --progress 5 --agent-id <agent>` 写首个 heartbeat，再调用 `goo-status.py --update-status`
  3. 派发批次后运行 `goo-status.py`，把 RUNNING 行的 progress、hb age、log 摘要展示给用户
  4. 等待任一 agent 完成 → 回写 plan.json → 调用 `goo-status.py --update-status` → 运行 `goo-status.py` 展示完成/告警摘要 → 立即回到步骤 1
  5. 心跳巡检每 30s → 运行 `goo-status.py` 展示 RUNNING/告警摘要 → 超时无心跳标记 failed → 调用 `goo-status.py --update-status` → 释放槽位
  6. 所有 step 完成或失败 → 调用 `goo-status.py --update-status` 做最终状态同步
```

### 心跳与进度（强制）

**主 Agent 派发 Subagent 时，prompt 必须包含 `references/execution-engine.md` 中对应类型的 Heartbeat 分段。** 不包含心跳指令会导致 Subagent 不更新 `heartbeat_at`，被误判为僵尸进程。

**主 Agent 负责写首个 heartbeat，Subagent 负责后续里程碑 heartbeat**（非时间驱动，是进度驱动）：

| 里程碑 | progress | 命令 |
|--------|----------|------|
| 派发前启动 | 5 | 主 Agent 调用 `--start --progress 5 --agent-id <agent>` |
| 读输入完成 | 15 | Subagent 调用 `--heartbeat --progress 15` |
| 核心过半 | 50 | `--heartbeat --progress 50` |
| 产物接近完成 | 85 | `--heartbeat --progress 85` |
| 完成 | 100 | `--complete` |
| 失败 | - | `--fail --error "<reason>"` |

先用插件内置 `skills/auto-goo/scripts/resolve-root.sh` 按当前平台安装记录解析 AutoGoo-Plugin 根目录；不要自动搜索当前目录或上级目录。不要在 skill 文档中内联 heredoc / file redirection 的 Python 片段；解析成功后再调用 `update-step.py`。

`/auto-goo:goo-status` 必须调用 `skills/auto-goo/scripts/goo-status.py` 渲染进度条和心跳告警。

执行中 heartbeat 必须前台可见：主 Agent 每次派发批次后、每轮 30s 巡检后、任一 Agent 完成后都要运行 `goo-status.py`，并把 RUNNING/告警摘要展示给用户；不要只把 heartbeat 写进 plan 而不展示。

### 失败处理

| 场景 | 处理 |
|------|------|
| 单个 Agent 失败 | 记录错误日志，回写 status="failed"，重试 1 次 |
| 权限/沙箱/approval 阻塞 | 调用 `update-step.py --block --error "needs_user_approval: <命令/原因/读写路径/风险>"`，主 Agent 前台询问用户许可；不得按普通失败重试或主 Agent 直接代做 |
| 重试仍失败 | 标记 ❌ failed，继续不依赖它的步骤 |
| 关键路径失败 | 通知用户，并优先用结构化选项询问（`AskUserQuestion`/`request_user_input`）：重试、跳过并继续、停止并保留现场 |
| Agent 超时（>5 分钟无心跳） | 视为失败，按失败流程处理 |
| 会话中断（心跳停滞 >= 2min） | `/auto-goo:goo-continue` 恢复时检测僵尸，按产物文件判断真实状态 |

### 日志铁律

每一步执行必须归档。失败也要写日志记录原因。日志时间戳统一使用 `YYYY-MM-DDTHH-MM-SS`。

### 常见偷懒理由

| Shortcut | Required behavior |
|----------|-------------------|
| "任务不大，先不写 plan" | 多步或有依赖就写/更新 `.goo/plan.json`，单步任务才跳过 AutoGoo-Plugin |
| "归档最后凭记忆补" | 决策形成时写入 `context_digest` 或 `context_artifacts` |
| "直接读完整 wiki 更省事" | 先用 `scripts/wiki-graph-assist.py` 生成紧凑 graph packet |
| "Subagent 会自己补上下文" | 派发前把输入、边界、验收和上游产物写入 plan 或 artifact |

更多 skill 设计、渐进披露和验证门槛 → `references/skill-design.md`

### 命令安全

1. Bash 命令中**禁止出现换行符后接 `#` 的模式**（如多行字符串中的注释），否则会触发 Claude Code 的安全路径验证警告。应改为单行命令或临时文件传参。
2. 激活虚拟环境时**使用 `.` 而非 `source`**，避免触发"参数评估为 shell 代码"的安全扫描。
3. **任何删除文件或目录的操作都必须先问用户并取得明确确认**，包括项目内临时文件、`.goo/` 产物、缓存、日志和远程目录。禁止为了省事执行 `rm -rf`、`find ... -delete`、`git clean` 或等价清理命令。
4. **覆盖已有文件前必须判断来源和风险**：编辑代码/文档可按任务范围进行；但批量覆盖、移动覆盖、重生成配置、替换用户手写内容、覆盖 `.goo/config.json`、`CLAUDE.md`、`.claude/settings*.json` 前必须先说明影响并确认。
5. 禁止运行破坏性 Git 命令，除非用户明确要求具体操作：`git reset --hard`、`git checkout -- <path>`、`git clean`、强推、删除分支、改写历史等都属于高风险命令。发布到默认分支前必须单独确认。
6. **敏感信息只读不显**：不得 `cat`、整段复制或日志化 `secrets.json`、token、password、API key、SSH private key。需要验证时只检查文件是否存在、权限是否合理、JSON 是否可解析、必要字段是否存在，输出必须打码或只给摘要。
7. 使用远程服务器前必须确认任务确实需要远程/GPU/长时间运行，并在 plan step 中写清目标 host、用途、允许命令范围、读写路径和产物同步方式。禁止把 secrets 展开到命令行、日志或 Subagent prompt。
8. Subagent 执行命令前必须遵守当前 step 的允许读写边界；如果 step 缺少 `allowed_read_paths`、`allowed_write_paths` 或危险操作说明，先补 `.goo/plan.json` 或 context artifact，再派发执行。
9. 网络下载、安装依赖、启动长跑任务、后台服务、端口监听、批量数据改写、跨机器同步、`scp`/`rsync` 上传下载，都要在命令前说明作用域和输出位置；涉及外部写入、远程执行或不可逆成本时先确认。
10. Subagent 遇到权限不足、沙箱拒绝、approval required、命令 allowlist 不足或路径边界不匹配时，只能上报 `needs_user_approval`，不得直接请求平凡交互、不得循环重试、不得让主 Agent 在未获许可时降级代执行。

```bash
# ❌ 禁止：换行符后接 # 的安全警告
python3 << 'EOF'
data = {"key": "value"}  # 注释
print(data)
EOF

# ✅ 正确：单行或写入临时文件
python3 -c "data = {'key': 'value'}; print(data)"

# ❌ 禁止：source 触发 shell 代码安全扫描
source venv/bin/activate && python script.py

# ✅ 正确：使用 . 替代 source
. venv/bin/activate && python script.py
```

Subagent prompt 模板（exec / optimize / eval 三种变体）、上下文传递规则 → `references/execution-engine.md`

## Phase 3: 优化迭代

当步骤标记为 `type: "optimize"` 时启动。

**快速跳过条件**（满足任一则跳过）：
- 基线指标已达标（用户认可当前性能）
- 客观无提升空间（IO 瓶颈已达硬件上限）
- 用户明确说"不需要优化"

### 完整循环

1. WebSearch 搜索该领域标准评价指标
2. 实现基线版本并评测（至少 3 次取平均）
3. 瓶颈分析 — cProfile / py-spy / tracemalloc / 大 O 推算，至少一种
4. 优化 → 同指标评测对比
5. 终止判断：提升 < 20% 或连续两轮 < 5% 停止

### 评测约束

- 计时与内存测量分开进行（tracemalloc 拖慢计时）
- 测量前 warmup 至少 3-5 次
- 优先使用 pyperf 减少系统噪声

指标模板、终止条件表、领域推荐指标 → `references/optimization-loop.md`

## Phase 4: Obsidian 归档

每步完成后启动 Recorder Subagent，将执行记录转为 Goo-wiki 格式的 Obsidian 笔记。

- 归档路径：优先使用项目 config 中的 `archive.project_dir`，即 `Goo-wiki/wiki/projects/<project-slug>/`；fallback 使用 `archive.fallback_project_dir`
- 内容输出类命令即使不进入完整执行 DAG，也必须归档到 Goo-wiki 或 fallback。适用范围包括 brainstorm 候选 goals、usage/token 降本分析、日报/周报、改进建议、benchmark 指标、plan 摘要和执行经验；不得只写 `.goo/*.json` 或只在聊天中展示。
- 论文分析和代码分析必须有独立 Markdown 分析正文并实际写入 Goo-wiki，同时更新项目入口与 Goo-wiki `log.md`。fallback 只能临时防丢失，状态保持 `pending_wiki_sync`/`failed`，不得据此完成 archive step。
- 内容输出对应的 `.goo/*.json` 产物应包含 `archive` 字段，记录归档路径、fallback 状态和 `log.md` 是否更新。
- 如果 Goo-wiki vault 不存在且 `.goo/obsidian/` 也不必要（临时项目），跳过归档，仅保留当前 thread 的 `logs/` 日志
- 如果项目是 Git repo，归档到项目页或任务总览时必须记录 git remote 地址；优先使用 `.goo/config.json.archive.git_remote_url`
- 归档必须维护 Markdown 关联图谱：写入前检索相关项目页、概念页、问题页、周报、历史任务页和 `context_artifacts`；写入任务页时添加高价值 `[[Wikilink]]`；写入后更新项目入口 `<project-slug>.md`（维护 `## 最近任务`、`## 可复用经验`、`## 代码结构` 等小节的双向链接）和 `log.md`，避免新页面孤立
- 归档 step 的完成条件必须包含链接验收：任务页链接项目入口、复用的 `wiki_context` / `context_artifacts` 和关键概念/问题/指标/历史任务页；项目 `<project-slug>.md` 的 `## 最近任务` 包含本次任务页链接，`## 可复用经验` 和 `## 代码结构` 按需更新；`log.md` 反向链接任务页；新增 lessons/metrics 页面链接回任务页或项目入口。缺少这些连接时不得把 archive step 标记为 completed。
- 为节省 token，Recorder 优先在解析 AutoGoo-Plugin 根目录后调用 `skills/auto-goo/scripts/wiki-graph-assist.py` 生成紧凑 graph packet，并在任务页写好后用该脚本的 `--update-index --append-log` 维护项目入口和活动日志；只有候选链接不足时才读取完整 Markdown
- YAML frontmatter 规范、wikilink 格式、log.md 追加格式 → `references/obsidian-archive.md`

**归档后任务总结报告**：最终任务归档验收通过后，主 Agent 必须立刻用 `AskUserQuestion`（Claude Code）/ `request_user_input`（Codex）复用 `references/interaction-templates.md` 的 `id=post_archive_html_report` 模板询问是否生成并启动任务总结报告。用户选择“生成并启动”时，生成的是当前任务的最终报告页，而不是项目级 publish 网站。报告至少包含：任务目标、执行摘要、关键变更或产物、验证命令和结果、指标/模型对比表（如适用）、风险和限制、Goo-wiki/fallback 归档链接、后续建议。

```bash
report_dir=".goo/threads/<thread_id>/reports"
mkdir -p "$report_dir"
# 先把本次任务总结写成 "$report_dir/final-report.html" 或 "$report_dir/final-report.md"。
# 如果生成 HTML，server URL 必须指向 /final-report.html；如果只有 Markdown，最终答复报告文件路径。
python3 -m http.server 9877 --bind 127.0.0.1 --directory "$report_dir"
```

最终答复必须包含报告路径（优先 `.goo/threads/<thread_id>/reports/final-report.html`）和实际可访问 URL（例如 `http://127.0.0.1:<port>/final-report.html`，远程环境再补本机 IP 或端口转发提示）。不得把 `.goo/site/index.html` 或 `goo-publish.py` 的总览页当成本次任务总结报告。用户选择“跳过”时，不启动 server，只报告归档路径。

Goo-wiki vault 检测：默认检查 `~/workspace/Goo-wiki/CLAUDE.md`。路径可配置，见 `references/setup.md`。

## Daily Report: 日报/周报

当用户要求"日报"、"写日报"、"生成日报"、"总结今天"、"今天干了什么"、"周报"、"周总结"、"daily report" 或显式调用 `/auto-goo:goo-daily-report` 时，执行日报流程，不需要生成 `.goo/plan.json`。

执行入口：
1. 解析日期：无参数默认今天；"昨天"、"今天"、"本周"转换为具体日期范围。
2. 按 AutoGoo-Plugin 配置优先级解析 Goo-wiki 路径。
3. 派发 collector（session-aggregator）采集会话摘要：collector 解析 AutoGoo-Plugin 根目录后运行 `skills/auto-goo/scripts/daily-report-sessions.py --date YYYY-MM-DD` 提取 Claude Code 与 Codex 会话摘要，必要时读取关键会话尾部补充最终状态，回传 evidence packet（不逐条抄录聊天）。
4. 主模型基于 collector packet 综合日报/周报要点，再派发 recorder 撰写正文。
5. recorder 写入或续写 `<wiki_dir>/journal/daily/YYYY-MM-DD.md`，并更新 `<wiki_dir>/log.md`。

完整模板、续写规则和敏感信息规则见 `commands/goo-daily-report.md`。

## Usage Monitor: Token/Usage 统计

当用户要求"usage"、"token 统计"、"Claude 用量"、"消耗监控"或显式调用 `/auto-goo:goo-usage` 时，**只做一件事：运行脚本，原样输出结果**。

**铁律**：不得自己读 JSONL、不得自己算 token、不得自己生成表格或文字摘要。脚本是唯一输出源。

**数据来源**：脚本默认同时统计 Claude Code + Codex + Pi 三个来源的全部 token 消耗；用户指定只看某个来源时传 `--claude` / `--codex` / `--pi`（可组合）。

执行：
1. 解析用户意图 → 映射为脚本参数（`--tab`、`--once`、`--view` 等），见 `commands/goo-usage.md`。
2. 解析 AutoGoo-Plugin 根目录后运行 `skills/auto-goo/scripts/goo-usage.py <参数>`。
3. 原样展示脚本输出。脚本输出已是完整渲染结果，不要追加任何解释、总结或补充。

不要提示用户手动进入插件目录或直跑内部脚本；用户侧推荐使用 `/auto-goo:goo-usage`，脚本路径通过统一 resolver 从 Claude Code 或 Codex 的已启用本地插件记录解析。

## Phase 5: 自改进 (Self-Improvement)

在每次任务归档后触发。插件自身也需要根据使用情况迭代优化。

### 自动触发（每次任务后）

Phase 4 归档完成后，在任务日志末尾追加 `## 流程问题` 反思记录：

```yaml
## 流程问题
- 问题: "<具体摩擦点>"
  根因: "<分析>"
  改进: "<建议修改的文件>"
  优先级: high | medium | low
```

### 汇总触发（每 5 个任务或 `/auto-goo:goo-improve`）

执行以下改进流程：

1. **采集** — 读取近 5 个任务的 `## 流程问题` 记录
2. **聚类** — 统计高频项（出现 >= 2 次标记为高频）
3. **定位** — 对照修改范围决策表确定目标文件
4. **方案** — 生成具体到文件+行的修改建议
5. **确认** — 展示给用户，并优先用结构化选项询问（`AskUserQuestion`/`request_user_input`）：`应用修改`、`只保存建议`、`放弃本次改进`；经用户明确确认后执行
6. **记录** — 写入 `.goo/improvements.log`

### 修改范围决策

| 信号 | 修改目标 |
|------|---------|
| 命令频繁弹窗 | `.claude/settings.local.json` allowlist |
| 步骤失败/用户纠正 | 对应 reference 文件 |
| 重复解释 | 补充 reference 内容 |
| 解析遗漏 | `references/task-parsing.md` |
| 技能触发不准 | SKILL.md frontmatter description |

完整自改进规范 → `references/self-improvement.md`

## Python 项目规范

当任务涉及 Python 实现时：
- Python 3.10+，完整类型注解，ruff lint（line-length=100）
- 优先使用标准库，外部依赖在 plan.json 声明 `[dep: <包名>]`
- 不 scope creep — 不做任务描述未要求的功能

完整规范 → `references/python-standards.md`
## 附加资源

### Reference Files
- **`references/setup.md`** — 环境设置、Goo-wiki 路径配置、推荐 SessionStart hooks
- **`references/skill-design.md`** — AutoGoo-Plugin skill 结构、上下文预算、脚本优先和验证门槛
- **`references/task-parsing.md`** — plan.json schema、解析流程、依赖与并行判断规则
- **`references/execution-engine.md`** — 执行流程、Subagent prompt 模板、错误处理、日志格式、上下文传递
- **`references/optimization-loop.md`** — 完整循环、指标模板、评测规范、终止条件
- **`references/obsidian-archive.md`** — Goo-wiki 归档规范、Recorder prompt、笔记类型与命名
- **`references/self-improvement.md`** — 插件自改进机制、触发条件、流程与决策规则
- **`references/python-standards.md`** — 代码风格、项目结构、核心接口约定
- **`references/heartbeat.md`** — subagent 心跳检测、zombie/stuck 判定规则和 heartbeat 更新协议

### Examples
- **`examples/csv-analysis-workflow.md`** — 完整工作流示例（CSV 销售数据分析）
- **`examples/optimization-workflow.md`** — 优化迭代示例（JSON 序列化性能优化）
- **`examples/multi-step-orchestration.md`** — 多步骤并行编排示例（ETL 数据管道）

### Scripts
- **`skills/auto-goo/scripts/init-plan.sh`** — 初始化 plan.json 模板；调用前先解析 AutoGoo-Plugin 根目录
- **`skills/auto-goo/scripts/brainstorm-validate.py`** — 校验 `.goo/brainstorm.json` 的候选目标、发散角度、自检结果、推荐 ID 和 review/archive 状态；生成 brainstorm 草案后用 `--mode draft` 检查
- **`skills/auto-goo/scripts/wiki-graph-assist.py`** — 生成紧凑 Goo-wiki 关联图谱上下文，并可维护项目 index/log 链接；调用前先解析 AutoGoo-Plugin 根目录
- **`skills/auto-goo/scripts/check-plugin.sh`** — 插件结构完整性自检脚本（安装后运行确认所有组件就绪）；调用前先解析 AutoGoo-Plugin 根目录
- **`skills/auto-goo/scripts/goo-observe.py`** — 观察当前 thread 的后台 step、heartbeat、step log 和 shell log 跟踪模板；`goo-publish` 的 `observe.html` 复用同一数据模型
- **`skills/auto-goo/scripts/goo-ssh.sh`** — 连接已配置的远程服务器；有密码时从 `secrets.json` 读取并用 `sshpass`，无密码时走普通 `ssh`。调用前先解析 AutoGoo-Plugin 根目录

### Agents
- **`../../agents/roles/researcher.md`** — 调研 Role Agent（学术论文/代码库/领域认知研究、查资料、读文档、整理约束和方案选项）
- **`../../agents/roles/collector.md`** — 数据采集 Role Agent（运行确定性采集脚本、机械聚合、产出紧凑 evidence packet）
- **`../../agents/roles/implementer.md`** — 执行 Role Agent（实现功能或修复）
- **`../../agents/roles/optimizer.md`** — 优化 Role Agent（性能测量、瓶颈分析、局部优化）
- **`../../agents/roles/evaluator.md`** — 评测 Role Agent（运行测试、benchmark、数据质量检查）
- **`../../agents/roles/reviewer.md`** — 审查 Role Agent（审查代码、方案、风险和缺失测试）
- **`../../agents/roles/auditor.md`** — 审计 Role Agent（安全、合规、证据链、可追溯性和交付风险）
- **`../../agents/roles/recorder.md`** — 记录归档 Role Agent（整理日志、产物、评测结果和经验）
- **`../../agents/tasks/audit/security-checker.md`** — auditor 旗下安全检测 Task Agent（扫描注入、XSS、敏感信息泄露、依赖漏洞）
- **`../../agents/tasks/recording/obsidian-recorder.md`** — recorder 旗下 Obsidian 归档 Task Agent（格式化 Goo-wiki 笔记）

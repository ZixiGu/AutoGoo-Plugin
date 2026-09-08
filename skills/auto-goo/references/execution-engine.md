# 执行引擎 (Execution Engine)

## 核心原则

AutoGoo-Plugin 的"并行"在单个 thread 内是 **task-level 并行**（多个独立 Subagent 同时执行）。多个 thread 可以并存，但同时执行前必须通过 resource locks 排除共享写资源冲突。每个步骤由独立的 Subagent 执行，通过当前 thread 的 `logs/` 交换结果。

- 并行步骤必须无共享资源（文件、变量、状态）
- 结果通过日志文件传递，不通过内存
- 每个 Subagent 看到的是上游步骤的输出快照
- **当前 thread plan 是状态源**：派发、完成、失败均回写 `.goo/threads/<thread_id>/plan.json`；`.goo/plan.json` 只是兼容入口，历史 plan 仅归档在 `.goo/plans/history/`
- **Plan/Wiki/MD-only 执行**：执行阶段必须只依赖当前 plan、`context_artifacts` 指向的 Goo-wiki/Markdown、Goo-wiki 摘要和上游产物路径；不得把主会话聊天记录当作隐含任务说明

## 主 Agent 职责

主 Agent 是 AutoGoo-Plugin 的总控，不把整体判断外包给任一 Subagent。

主 Agent 必须负责：

1. 派发 researcher 召回 Goo-wiki 和项目指引，消费其 evidence packet，形成可执行约束。
2. 拆解 DAG、识别依赖、划定每个 Subagent 的读写边界。
3. 为每个 Subagent 构造最小必要上下文，而不是传递完整会话历史。
4. 在派发前检查当前 step 是否能仅凭 plan/Markdown/wiki 摘要执行；如果不能，先更新 plan 或写入 Goo-wiki 项目路径 `context/`，Goo-wiki 不可用时写 `.goo/obsidian/<project-slug>/context/`。
5. 调度、限流、资源锁 acquire/release、心跳巡检、失败重试和僵尸步骤恢复。
6. 审核 Subagent 产物，判断是否满足用户目标和项目约束。
7. 合并跨步骤结果，处理冲突，必要时要求局部返工。
8. 维护当前 thread 的 `plan.json`、`logs/`、`artifacts/`、thread metadata 和 Goo-wiki 归档的一致性。
9. 聚合 Subagent 上报的权限阻塞，在前台向用户申请许可，并把批准/拒绝结果回写 plan。
10. 对远程执行 step 解析 `remote_server`、校验配置和 secrets 文件存在性，并在用户授权后通过 `goo-ssh.sh` 派发远程命令。

Subagent 只对被分配的步骤负责，不能改写整体计划、扩大任务范围、越权修改其他步骤文件，或自行决定跳过主 Agent 定义的验收条件。

`goo-start` / `goo-continue` 执行阶段必须派发 Subagent：`research`、`exec`、`optimize`、`eval`、`review`、`audit`、`archive` 等步骤由对应 Subagent 执行。主 Agent 负责编排、上下文裁剪、派发、状态修复、产物审核和必要返工，不直接代做步骤产物。

**Subagent 缺失处理**：当 plan step 的 `subagent` 字段缺失或不属于合法角色（`researcher`/`collector`/`implementer`/`optimizer`/`evaluator`/`reviewer`/`auditor`/`recorder`）时，暂停派发并先修正 `.goo/plan.json` 或创建新的合法 Subagent 角色；不得由主 Agent 降级代执行该步骤。

### 脚本职责归属（谁该跑哪个脚本）

`skills/auto-goo/scripts/` 下的脚本按职责归属到角色，避免主模型亲自跑数据采集脚本做第一手分析：

| 脚本 | 归属 | 说明 |
|---|---|---|
| `goo-usage.py` / `wiki-graph-assist.py` / `remote-resources.py` / `daily-report-sessions.py` | **collector 采集工具** | 主模型不亲自运行采集做分析；由 collector 运行并把结果回传 evidence packet |
| `goo-status.py` / `goo-observe.py` / `thread-state.py` | **主模型状态查看豁免** | 仅渲染状态/观察，不做归因、根因、聚类等分析决策 |
| `brainstorm-validate.py` / `check-plugin.sh` / `packet-validate.py` | **evaluator 校验工具** | 由 evaluator 运行做结构/一致性校验 |
| `goo-publish.py` | 只读发布（展示层） | 不修改 plan/brainstorm/业务文件 |
| `goo-ssh.sh` | 远程敏感操作 | 需用户显式确认，主模型不擅自执行 |

Evidence-Packet 协议：分析型 Subagent（researcher / evaluator / auditor）回传的 packet 至少应含 `purpose`、`findings[]`（每项 `claim`/`evidence_path`/`confidence`）、`change_list[]`（每项 `target`/`action`/`why`/`detail`），紧凑供主模型直接综合，避免回传全文。

## 权限分层

AutoGoo-Plugin 的权限交互由主 Agent 统一处理，后台 Subagent 不做平凡 approval 弹窗。

| 层级 | 判定 | 行为 |
|------|------|------|
| 普通权限 | plan 已声明 `allowed_read_paths` / `allowed_write_paths`，命令在项目 allowlist 内，`requires_user_confirm=false` | Subagent 在边界内直接执行，不询问用户 |
| 可预见高成本权限 | 安装依赖、网络下载、远程执行、长跑任务、后台服务、端口监听、批量数据改写、跨机器同步、外部写入或不可逆成本 | 规划阶段标记 `requires_user_confirm=true`；主 Agent 派发前一次性说明命令类别、作用域、产物位置和风险，用户确认后再执行 |
| 意外权限阻塞 | `PermissionDenied`、sandbox blocked、approval required、命令不在 allowlist、读写路径越界、需要额外目录或远程权限 | Subagent 写日志并回写 `blocked`/`needs_user_approval`，包含命令、原因、读写路径、风险和建议；主 Agent 聚合后前台询问 |
| 危险操作 | 删除、覆盖配置、破坏性 Git、强推、改写历史、展开 secrets、远程删除或远程批量覆盖 | 必须前台单独确认；用户拒绝时标记 failed 或调整 plan，禁止自动重试 |

`needs_user_approval` 不是普通失败。主 Agent 不得把它按失败重试，也不得在未获许可时直接代做步骤产物。用户批准后，只能在批准的命令类别、路径和风险范围内重派 Subagent 或由主 Agent 执行许可命令；用户拒绝后，回写 failed、deferred 或更新 plan 走替代路线。

每个 plan step 必须显式声明 `subagent` 和 `task_agent` 字段。`type` 描述步骤性质，`subagent` 描述稳定 Role Agent，`task_agent` 描述该 role 下的细分 Task Agent。例如：

```json
{ "type": "exec", "subagent": "implementer", "task_agent": "feature-builder", "available_skills": [] }
{ "type": "eval", "subagent": "evaluator", "task_agent": "test-runner", "available_skills": [] }
{ "type": "audit", "subagent": "auditor", "task_agent": "evidence-auditor", "available_skills": [] }
{ "type": "archive", "subagent": "recorder", "task_agent": "wiki-curator", "available_skills": [] }
```

`task_agent` 用于选择 `agents/tasks/` 下的细分 agent 文件和 prompt 重点；它不是 skill 名称，也不写入 `available_skills`。Claude Code 使用插件注册的 `autogoo-plugin:<subagent>` 角色并把 task agent 内容合入 prompt；Codex 使用 `spawn_agent({task_name, message, fork_turns})`，把 role 与 task agent 内容合入 `message`。

`available_skills` 是 step 级 skill allowlist，用来告诉主 Agent 在派发 Subagent 时哪些 skill 可以作为本步骤上下文。它不替代 `subagent` 角色，不自动授予额外工具权限，也不允许 Subagent 越过 `allowed_read_paths` / `allowed_write_paths`。

## 远程服务器执行

远程服务器是显式执行目标，不是隐含偏好。规划阶段只有在任务需要远程算力、远程依赖、长跑环境或用户明确要求时，才把 step 标成：

```json
{
  "execution_target": "remote",
  "remote_server": "ubuntu@10.0.0.8:22",
  "remote_reason": "需要 GPU 训练环境",
  "requires_user_confirm": true,
  "risk_level": "medium"
}
```

默认本地执行时写 `execution_target="local"` 或省略该字段。远程 step 必须同时写清远程命令类别、远程工作目录、产物路径、回传/验收方式和风险；不得把密码、token 或 secrets 文件内容写入 plan、Subagent prompt、日志或聊天。

派发远程 step 前，主 Agent 必须：

- 读取项目 `.goo/config.json`；缺失时再读取用户级 `~/.auto-goo/config.json`。
- 确认 `remote_server` 能唯一匹配 `servers[]` 的 `name`、index、`host`、`host:port`、`user@host` 或 `user@host:port`；计划里优先使用 `name`。
- 确认配置项包含 `secrets_file`，且 secrets 文件存在；只检查存在性和权限，不打印密码内容。
- 用结构化确认向用户说明目标服务器、命令类别、远程路径、产物位置和风险；未获确认时回写 `blocked` / `needs_user_approval`。

用户确认后，远程命令通过现有 helper 执行：

```bash
bash "$auto_goo_root/skills/auto-goo/scripts/goo-ssh.sh" --config .goo/config.json --server "<remote_server>" -- <remote command>
```

如果使用用户级配置，则把 `--config ~/.auto-goo/config.json` 传给 helper。`goo-ssh.sh` 负责从 `secrets_file` 读取密码并调用 `sshpass`；Subagent 不得自行拼接 `sshpass -p`，不得把密码展开到命令行。

## Subagent 上下文隔离

Subagent 默认隔离上下文。主 Agent 派发时只传：

- 当前 step 的 `id`、`name`、`description`、`type`、`subagent`、`task_agent`、`output`
- 当前 step 的 `available_skills`；若为空数组，不额外加载 skill
- 必要的项目约束和安全规则摘要
- **执行目录与 worktree 配置**：执行启动或恢复时先读取 plan 顶层 `runtime.subagent_isolation`；若已有 `mode` 且 `project_root` 与当前 AutoGoo-Plugin 项目根一致，直接复用，不做 Git 检查、不再次询问。缓存缺失、根目录不匹配或用户明确切换执行目录时，用 `AskUserQuestion` 复用 `id=git_init_project` 模板询问是否启用 worktree 隔离。用户选择不启用时写 `{"mode":"none","project_root":"<path>","checked_at":"<iso>","decision":"worktree_disabled"}`，后续派发省略 `isolation`。若省略 `isolation` 的实际派发仍报 `Failed to resolve base branch "HEAD"` / `git rev-parse failed`，说明当前 Claude Code Agent 包装层仍要求 Git HEAD：立即写入 `runtime.subagent_isolation.compatibility.agent_requires_git_head=true`，把当前 step 标记 `blocked`/`needs_user_approval`，重新询问是否启用 worktree；不得重置 heartbeat 后反复重派，也不得创建 probe agent。用户选择启用时写 `mode="worktree"`，并只检查当前项目根本身是否是 Git repo 且 `HEAD` 可解析；不要设置 `GIT_DISCOVERY_ACROSS_FILESYSTEM`，不要向父目录、跨文件系统或备用路径寻找 Git root。若不是 Git repo，运行 `git init -b main`，不支持 `-b` 的 Git 版本在初始化后立即 `git branch -M main`；若已有 Git 但没有 `HEAD`，复用当前仓库。随后执行初始提交：先检查 `git status --short` 和明显敏感文件风险，发现密钥、令牌、密码、secrets 文件或异常大批生成物时先标记 blocked 并前台确认；否则 `git add -A` 后提交 `chore: initialize repository for AutoGoo-Plugin worktree isolation`。建议结构：`{"mode":"worktree","project_root":"<path>","checked_at":"<iso>","decision":"worktree_enabled","reason":"git_head_available"}` 或 `{"mode":"none","project_root":"<path>","checked_at":"<iso>","decision":"worktree_disabled","compatibility":{"agent_requires_git_head":true}}`。后续派发 Subagent 只读取该缓存，不得每次派发前重复运行 git 检查。只有 `mode="worktree"` 且 `HEAD` 可解析时才允许给 Agent tool 传 `isolation: "worktree"`；`mode="none"` 时必须省略 `isolation` 参数。如果启用后仍无法得到 `HEAD`，最多记录一次失败并把 workflow 标记为 blocked；不得降级普通派发、不得循环 probe，也不得改从父级 Git root 派发。
- `wiki_context` 中与该 step 直接相关的 3-7 条要点
- `context_digest` 中与该 step 直接相关的决策、约束和验收点
- `context_artifacts` 中必要 Markdown 的路径、标题和行号范围
- 上游依赖的产物路径和精简摘要
- 允许读取/写入的路径边界
- plan/log/heartbeat 回写要求
- **完成验收闸门**：Agent 返回 `Done` 只能说明工具调用结束，不等于 step 完成。`0 tool uses` 不能单独作为失败依据；文本型 review/design step 可以无工具完成。主 Agent 必须检查结构化最终答复、step log、heartbeat 里程碑和声明的 `output`/`outputs` 产物。若 step 声明了必需产物，必须验证产物存在且满足 step 的 `validation`；缺失时不得标记 completed 或释放下游依赖。只有完成证据全缺失时，才判定为 dispatch 空跑或运行时前置失败。回写错误原因时必须包含：实际派发是否传了 `isolation`、plan 中的 `runtime.subagent_isolation.mode`、声明产物路径和缺失情况；不得只用“可能误用了 worktree”代替证据。

默认不传：

- 完整主会话历史
- "刚才讨论过"但没有写入 plan/Markdown/wiki 的隐含方案
- 其他 Subagent 的推理草稿
- 与本 step 无关的 wiki 大段内容
- 未完成并行步骤的中间状态

Subagent 之间只通过当前 thread 的 `plan.json`、`logs/`、`artifacts/`、Goo-wiki 项目笔记、`.goo/obsidian/` fallback、明确产物路径和最终归档摘要交接。需要共享大段上下文时，主 Agent 应先把它整理成 Goo-wiki 项目笔记或摘要，再显式传给下游步骤。若 Subagent 需要的信息只存在于主会话聊天记录中，必须暂停派发，由主 Agent 更新 plan 或创建 context artifact 后再继续。

## 前台输出边界

后台 Subagent 的代码阅读、根因猜测、下一步自我提示和未验证判断必须写入当前 thread 的 `logs/` 或最终 step 报告，不直接刷到用户前台。前台只保留：

- step 启动、完成、失败、阻塞或需要用户确认的简短状态；
- 已验证的最终结论、变更文件、产物路径和验证结果；
- 需要主 Agent 向用户申请的权限、风险和建议操作。

例如 `"The issue is that ... Let me check ..."` 这类中间诊断应写入日志，等确认根因后再由主 Agent 汇总。Subagent 不应把内部检查过程写成面向用户的连续旁白。

## Subagent Skill 派发

规划阶段可以在每个 step 写入 `available_skills`：

```json
{
  "id": 3,
  "type": "exec",
  "subagent": "implementer",
  "task_agent": "feature-builder",
  "available_skills": ["openai-docs"]
}
```

派发规则：

- `available_skills` 只列本步骤确实有用的 skill 名称；不要把所有 skill 全量塞给每个 Subagent，也不要放 role agent、task agent、文件路径或项目 reference。
- 主 Agent 派发时把该列表写入 Subagent prompt，并说明“只在需要时加载这些 skill 的入口说明”。
- 如果 skill 不存在、不可读或与 step 无关，主 Agent 应更新 plan 去掉它，或在 prompt 中标明不可用；不得让 Subagent 凭空假设 skill 内容。
- 如果 step 需要的是项目内 reference，而不是 Codex/Claude skill，应把路径放进 `context_artifacts`、`inputs` 或 step `description`，不要混进 `available_skills`。
- `available_skills` 不能扩大读写范围；真正的文件边界仍以 `allowed_read_paths` / `allowed_write_paths` 为准。

## Subagent 职能分工

规划时优先把步骤标成清晰职能，避免一个 Subagent 同时承担调研、实现、评测和归档。

| `subagent` | 职能 | 主要责任 | 不应负责 |
|------|------|----------|----------|
| `researcher` | Researcher | 查资料、读文档、整理约束和方案选项 | 直接改业务代码 |
| `implementer` | Implementer | 在指定文件/模块内实现功能或修复 | 自行改变任务范围或验收标准 |
| `optimizer` | Optimizer | 做性能测量、瓶颈分析和局部优化 | 没有基线就盲目优化 |
| `evaluator` | Evaluator | 运行测试、benchmark、数据质量检查 | 修代码，除非主 Agent 明确授权 |
| `reviewer` | Reviewer | 审查代码、方案、风险和缺失测试 | 直接合并或覆盖实现 |
| `auditor` | Auditor | 审计安全、合规、证据链、可追溯性和交付风险 | 直接修改业务实现或替代评测 |
| `recorder` | Recorder | 整理日志和 Goo-wiki 归档 | 修改执行产物或改变事实 |

主 Agent 可以把同一大任务拆成多个不同职能步骤，例如 `Research -> Implementer -> Evaluator -> Reviewer -> Recorder`。只有当任务足够小且风险低时，才合并职能。

## 执行流程（槽位调度模型）

旧模型是"整层一起发 → 整层一起等 → 下一层"，存在三个问题：
- 同一层内快的 agent 完成了，下游步骤还得等慢的
- 无并发上限，10 个 agent 同时下发可能触发 API 限流
- 调度不区分优先级，关键路径步骤和边缘步骤同等对待

新模型：**固定并发槽位 + 动态就绪队列 + 连续下发**。

```
MAX_CONCURRENT = min(6 或 plan.json 配置值, 当前平台实际可用的 Subagent 槽位)

Claude Code 可按 Agent 工具容量调度；Codex 的根 Agent 也占一个槽位，必须通过 `list_agents`/工具返回状态核对剩余容量。平台容量小于 plan 配置时以平台容量为准，不得因固定并发值反复触发派发失败。

初始化:
  running = []       # 当前在跑的 agent 槽位
  ready_queue = []   # 就绪但等待槽位的步骤
  若 plan.runtime.subagent_isolation.mode 存在且 project_root 等于当前 AutoGoo-Plugin 项目根:
    直接复用缓存，不运行 git 检查，不询问 worktree 配置
  否则若缓存缺失、project_root 不匹配或执行目录变更:
    用 AskUserQuestion(id=git_init_project) 询问是否启用 worktree
    用户选择不启用: 写入 {mode:"none", project_root, checked_at, decision:"worktree_disabled"}
    用户选择启用:
      只检查当前 AutoGoo-Plugin 项目根本身是否有可用 git HEAD
      不设置 GIT_DISCOVERY_ACROSS_FILESYSTEM，不向父目录或备用路径寻找 git root
      若不是 git repo: git init -b main；不支持 -b 时 git branch -M main
      若无 HEAD: 检查 git status --short 和敏感文件风险；安全后 git add -A && git commit -m "chore: initialize repository for AutoGoo-Plugin worktree isolation"
      HEAD 可解析后写入 {mode:"worktree", project_root, checked_at, decision:"worktree_enabled", reason:"git_head_available"}；否则 blocked

主循环:
  while 有 pending 步骤 或 running 非空:
    1. 扫描就绪步骤
       - 选 status=pending 且 depends_on 全部 completed 的步骤
       - 按优先级排序 → 加入 ready_queue

    2. 填充空槽位
       while len(running) < MAX_CONCURRENT 且 ready_queue 非空:
         step = ready_queue.pop(0)
         若 step.requires_user_confirm=true 且尚未确认 → 调度器直接弹确认框询问用户
           （pi 扩展用 ctx.ui.confirm，主 Agent 不再靠猜测去问）：
           确认 → 写 confirmed=true / confirmed_at，正常派发；
           拒绝 → 标记 blocked（error="user declined confirmation"，后续不再自动重复询问）；
           历史遗留 blocked（旧版只打文本从未真问，error="requires user confirm"）会被重新询问并解锁。
         解除 blocked：update-step.py --confirmed（记录确认并把 blocked→pending）或 --status pending
         更新 status="running", progress=0, agent_id, started_at → plan.json
         启动 Agent (run_in_background, 间隔 3-5s 错峰；mode=worktree 且 HEAD 可解析时传 isolation="worktree"，mode=none 不传 isolation)
         若 mode=none 仍返回 Failed to resolve base branch "HEAD"/git rev-parse failed:
           写入 runtime.subagent_isolation.compatibility.agent_requires_git_head=true
           将当前 step 标记 blocked/needs_user_approval，前台询问是否启用 worktree
           不重置 heartbeat，不再重派，不创建 probe agent
         running.append(step)

    3. 等待任一 Agent 完成
       任一 running agent 完成（或超时/失败）
         → 从 running 移除
         → 收集结果 → 写入 .goo/logs/
         → 更新 status="completed"(progress=100)/"failed"/"blocked" → plan.json
         → 若 blocked/needs_user_approval，聚合权限需求并由主 Agent 前台询问
         → 立即回到步骤 1（该 agent 解锁的下游步骤可以马上入队）

    4. 心跳与进度巡检
       每 30s 检查 running 中 agent 的 heartbeat_at + progress
       heartbeat_at 超时 >= 15min（默认；可通过 plan.json `execution.stale_after_seconds`
       以秒为单位自定义，如 600=10min） → 标记 failed, 释放槽位
       progress 停滞不变超过 3 轮心跳 → 标记为 stuck，发出警告

所有步骤 completed 或无可执行步骤 → 结束
```

### 关键改进

| 旧模型 | 新模型 |
|--------|--------|
| 整层一起发 | 最多 6 个并发槽位 |
| 整层完成后才解锁下游 | agent 完成即解锁其下游，不等同层 |
| 无优先级 | 按扇出 + 预估耗时排序 |
| 同时下发竞争 API | 3-5s 间隔错峰下发 |
| 无并发上限 | MAX_CONCURRENT 软限制（尽量多） |
| 心跳只有时间戳 | 心跳带 progress (0-100)，/auto-goo:goo-status 展示进度条 |

### 优先级排序规则

ready_queue 中步骤按以下优先级排序（依次递减）：

1. **扇出度**（降序）— 该步骤解锁了多少个下游步骤。下游多的先跑，尽早暴露并行度
2. **预估耗时**（降序）— 慢的先跑，快的同时填充（流水线效应）
3. **同层剩余数**（升序）— 同一 original tier 中剩余未完成步骤少的优先

### 错峰下发

同一批次填充空槽位时，每个 agent 派发间隔 5-10 秒：

```
for step in batch:
   启动 Agent(step)
   if 不是本批次最后一个:
     等待 5-10 秒  # 避免 API 限流
```

### plan.json 实时回写

每步状态变更必须立即更新 plan.json，同时必须更新 plan 顶层状态：

| 时机 | step 更新字段 | plan 顶层更新 |
|------|-------------|-------------|
| 派发 Agent 前 | `status="running"`, `agent_id`, `started_at=now`, `heartbeat_at=now` | `goo-status.py --update-status` |
| Agent 心跳（里程碑） | `heartbeat_at=now`, `progress=<N>`（见 Heartbeat 表） | — |
| Agent 完成 | `status="completed"`, `completed_at=now`, `progress=100` | `goo-status.py --update-status` |
| Agent 失败 | `status="failed"`, `completed_at=now` | `goo-status.py --update-status` |
| 权限阻塞 | `status="blocked"`, `blocked_at=now`, `error="needs_user_approval: ..."` | 主 Agent 前台申请许可后再 `goo-status.py --update-status` |

**Plan 顶层状态更新是强制的**，不是可选的"建议"。主 Agent 在每次 step 状态变更后必须立即调用：

```bash
auto_goo_root="$(
  python3 - <<'PY' 2>/dev/null || true
import json
from pathlib import Path

home = Path.home()
matches = []

def usable(path):
    return path.exists() and not (path / ".orphaned_at").exists()

registry = home / ".claude/plugins/installed_plugins.json"
if registry.exists():
    data = json.loads(registry.read_text(encoding="utf-8"))
    for key, entries in data.get("plugins", {}).items():
        if key.split("@", 1)[0] != "autogoo-plugin":
            continue
        for entry in entries:
            path = Path(entry.get("installPath", "")).expanduser()
            if usable(path):
                matches.append((entry.get("lastUpdated", ""), str(path)))

if not matches:
    settings = home / ".claude/settings.json"
    if settings.exists():
        data = json.loads(settings.read_text(encoding="utf-8"))
        enabled = data.get("enabledPlugins", {})
        marketplaces = data.get("extraKnownMarketplaces", {})
        for key, is_enabled in enabled.items():
            if not is_enabled or "@" not in key:
                continue
            plugin, marketplace = key.split("@", 1)
            if plugin != "autogoo-plugin":
                continue
            source = marketplaces.get(marketplace, {}).get("source", {})
            if source.get("source") != "directory":
                continue
            path_text = source.get("path")
            if not path_text:
                continue
            path = Path(path_text).expanduser()
            if usable(path):
                matches.append(("settings:" + marketplace, str(path)))

if matches:
    print(sorted(matches)[-1][1])
PY
)"
if [ -z "$auto_goo_root" ] || [ ! -f "$auto_goo_root/skills/auto-goo/scripts/goo-status.py" ]; then
  echo "AutoGoo-Plugin root not configured; install autogoo-plugin or enable a local directory marketplace in ~/.claude/settings.json" >&2
  exit 127
fi
	python3 "$auto_goo_root/skills/auto-goo/scripts/goo-status.py" --update-status
```

这会更新 plan 顶层的 `status`（`pending` → `running`；任一阻塞优先显示 `blocked`；无阻塞时按完成/失败推导 `completed`/`failed`）、`started_at`（首次进入 running 时）和 `completed_at`（全部完成或失败时）。不调用此命令会导致 plan 顶层状态与实际 step 状态不同步。`/auto-goo:goo-status` 也会读取此字段渲染仪表盘。

状态回写必须使用插件脚本，避免多个 Agent 用临时 JSON 代码互相覆盖：

```bash
auto_goo_root="$(
  python3 - <<'PY' 2>/dev/null || true
import json
from pathlib import Path

home = Path.home()
matches = []

def usable(path):
    return path.exists() and not (path / ".orphaned_at").exists()

registry = home / ".claude/plugins/installed_plugins.json"
if registry.exists():
    data = json.loads(registry.read_text(encoding="utf-8"))
    for key, entries in data.get("plugins", {}).items():
        if key.split("@", 1)[0] != "autogoo-plugin":
            continue
        for entry in entries:
            path = Path(entry.get("installPath", "")).expanduser()
            if usable(path):
                matches.append((entry.get("lastUpdated", ""), str(path)))

if not matches:
    settings = home / ".claude/settings.json"
    if settings.exists():
        data = json.loads(settings.read_text(encoding="utf-8"))
        enabled = data.get("enabledPlugins", {})
        marketplaces = data.get("extraKnownMarketplaces", {})
        for key, is_enabled in enabled.items():
            if not is_enabled or "@" not in key:
                continue
            plugin, marketplace = key.split("@", 1)
            if plugin != "autogoo-plugin":
                continue
            source = marketplaces.get(marketplace, {}).get("source", {})
            if source.get("source") != "directory":
                continue
            path_text = source.get("path")
            if not path_text:
                continue
            path = Path(path_text).expanduser()
            if usable(path):
                matches.append(("settings:" + marketplace, str(path)))

if matches:
    print(sorted(matches)[-1][1])
PY
)"
if [ -z "$auto_goo_root" ] || [ ! -f "$auto_goo_root/skills/auto-goo/scripts/update-step.py" ]; then
  echo "AutoGoo-Plugin root not configured; install autogoo-plugin or enable a local directory marketplace in ~/.claude/settings.json" >&2
  exit 127
fi
	python3 "$auto_goo_root/skills/auto-goo/scripts/update-step.py" --plan .goo/threads/<thread_id>/plan.json --step-id <id> --start --progress 5 --agent-id <agent>
	python3 "$auto_goo_root/skills/auto-goo/scripts/update-step.py" --plan .goo/threads/<thread_id>/plan.json --step-id <id> --heartbeat --progress <0-100>
	python3 "$auto_goo_root/skills/auto-goo/scripts/update-step.py" --plan .goo/threads/<thread_id>/plan.json --step-id <id> --complete
	python3 "$auto_goo_root/skills/auto-goo/scripts/update-step.py" --plan .goo/threads/<thread_id>/plan.json --step-id <id> --fail --error "<reason>"
```

### MAX_CONCURRENT 配置

在 plan.json 顶层可覆盖：

```json
{
  "task": "...",
  "max_concurrent": 2,
  "steps": [...]
}
```

默认 6。调低（2-3）避免限流；调高（8-10）最大化并行度。不做硬限制。

## Subagent Prompt 模板

### 执行型 (type: "exec")

```
你是一个 AutoGoo-Plugin 执行 Subagent。

你只负责当前 step。不要假设自己拥有完整项目上下文；只使用主 Agent 给出的约束、上游产物路径和允许读写范围。不要读取或修改未授权文件。

## 任务
{step.name}: {step.description}

## 上游上下文
{upstream_outputs}  ← 前驱步骤的输出摘要

## 上下文边界
- 允许读取: {allowed_read_paths}
- 允许写入: {allowed_write_paths}
- 是否需要用户确认: {requires_user_confirm}
- 相关 wiki_context: {relevant_wiki_context}
- 不要使用其他 Subagent 的未归档草稿作为依据

## 按需读取 wiki(对齐 SKILL.md "按需调用原则")
- 本 step 的 `wiki_paths` glob(只读这些,不要"读全部 wiki"):
  {wiki_paths}
  - 默认 L2 层:`wiki/projects/<project-slug>/{tasks,lessons,references}/**`;L3 项目入口按需。
  - 主 Agent 已在派发前用 `wiki-graph-assist.py` 生成紧凑 graph packet,路径见 `{wiki_graph_packet_path}`;优先用它代替自行 grep/glob 全量扫描。
- 单次 Read/Grep 受**字符预算 (< 20k) + 超时 (< 30s)** 双重约束;超出时优先 `Read` + `limit/offset` 或 `Grep -n`,不跳级 Read 全文。
- `memory_layer` 默认 L2(场景知识);L0 原始日志、L3 项目画像只按 step 显式需要才读。
- 跨 step 引用用 `[[Wikilink]]` 按需点开;不要 Read 整篇 wiki 笔记。

## 权限处理
- 普通读写和低风险命令只能在上述边界内执行。
- 如果遇到 `PermissionDenied`、sandbox blocked、approval required、命令不在 allowlist、读写路径越界或需要额外权限，不要自行弹窗、不要循环重试、不要让主 Agent 未经许可直接代做。
- 立即更新日志，调用 `update-step.py --block --error "needs_user_approval: <命令/原因/读写路径/风险>"`，并在日志中写清建议由主 Agent 前台询问用户。
- 等用户批准后，主 Agent 会重派本 step 或执行批准范围内的命令。

## Heartbeat（强制）

**主 Agent 依赖此字段判断你是否存活。不更新 heartbeat 会被误判为僵尸进程并重派。**

通过 `skills/auto-goo/scripts/resolve-root.sh` 的统一规则解析 AutoGoo-Plugin 根目录；不要搜索当前目录或上级目录。Claude Code 使用 installed plugin/local directory marketplace，Codex 使用 `~/.codex/config.toml` 与 `~/.agents/plugins/marketplace.json` 的已启用本地 source。若当前平台安装记录不可用或目标脚本无效，必须 fail-fast 提示用户重新安装/启用插件。

命令模板（替换 `<id>` 和 `<0-100>`）：
```bash
python3 "$auto_goo_root/skills/auto-goo/scripts/update-step.py" --plan .goo/threads/<thread_id>/plan.json --step-id <id> --heartbeat --progress <0-100>
```

在以下里程碑必须调用上述命令更新 `heartbeat_at` + `progress`：

| 里程碑 | `--progress` | 时机 |
|--------|-------------|------|
| 派发前启动 | `5` | 主 Agent 在启动本 Subagent 前写入；Subagent 发现缺失时才补救 |
| 理解上下文 | `15` | 读完输入、wiki、上游产物后 |
| 核心过半 | `50` | 主要逻辑/实现过半时 |
| 产物接近完成 | `85` | 写完输出、自查前 |
| 完成/失败 | `100` + `--complete` 或 `--fail` | 最终状态 |

**主 Agent 已在派发前用 `--start --progress 5` 写入启动心跳。Subagent 不要重复调用 `--start`；只有发现当前 step 仍不是 running 或没有 `heartbeat_at` 时，才用 `--start --progress 5` 补救。中间里程碑用 `--heartbeat --progress <N>`，完成用 `--complete`。**

## 交付要求（0 号动作：先落痕、后动手）

> **留痕是产物的一部分。** 主 Agent 在派发前已经用 `update-step.py --precreate-log` 写好 dispatch 骨架。如果你不接管它就动手干活，主 Agent post-check 会判 `dispatch_no_log` 并强制重派。

**0. 第一动作（写代码之前）**：检查本 step 的 `log_path` 是否存在且非空。
   - 不存在 / 仍是骨架 → 第一件事必须是接管骨架：

     ```bash
     python3 "$auto_goo_root/skills/auto-goo/scripts/update-step.py" \
       --plan .goo/threads/<thread_id>/plan.json --step-id <id> \
       --heartbeat --progress 15 --note "<已开工，读懂了输入与边界>"
     ```
   - 同时把读懂的内容（输入路径、边界、上下文 artifact、上游产物）逐条追加进日志。
   - 若发现 `status != running` 或 `heartbeat_at` 缺失，说明主 Agent 没写首心跳，先用 `--start --progress 5 --note "<补救首心跳：主 Agent 未派发>"` 补救并把主 Agent 的派发漏洞写进日志，避免双重失联。

1. 在 {cwd} 目录下工作
2. 读取当前 step 状态；若主 Agent 已写入 `status=running` 和 `heartbeat_at`，直接开始输入读取；若缺失，按 0 号动作的补救规则处理
3. `update-step.py` 会自动创建并追加当前 thread 的 `logs/{timestamp}_step-{id}_{name}.md`，并把 `log_path` 写回当前 step
4. **每到一个里程碑**调用 `update-step.py --heartbeat --progress <N> --note "<短进展>"`（见上方 Heartbeat 表）。**`--note` 必填**：`update-step.py` 在 `--heartbeat` 模式下缺 `--note` 会以 exit=2 报错；空白 note 等于没记录，比漏心跳更糟
5. 执行实现后用 `--note` 补充：关键决策、输出产物路径、耗时
6. **完成后**调用 `update-step.py --complete`，并在日志末尾贴上：实际产物路径、验证命令与结果、关键决策
7. 失败时调用 `update-step.py --fail --error "<reason>"`，并在日志中记录失败原因、阻塞点和恢复建议
8. 日志必须包含：做了什么、关键决策（含被拒绝的备选）、实际写入的产物路径、验证命令与结果

### 按 step type 区分产物形态

| step type | 产物形态 | post-check 该看什么 |
|----------|---------|---------------------|
| `exec` | 代码 / 配置文件（落入代码库） | `git diff --stat HEAD` + outputs 路径 + log |
| `research` | markdown 报告 / wiki 笔记 / 数据 | outputs / report 路径内容 + log 含结论段 + log |
| `eval` / `audit` / `review` | 审计/评测报告 / 数据报告 | outputs / reports 路径 + log 含结论与风险项 |
| `archive` | Goo-wiki / fallback 笔记 | wiki 路径存在 + wikilink 校验 + log |
| `optimize` | 代码 + 评测报告 | 上述两类合并 |

> **分析型 Subagent 没有代码改动是合法的。** 如果产物的所有形态都被主 Agent 标成 "non-code analytical outputs"（研究/评测/审计/审查），不要硬 git diff。这种情况必须靠**日志 + 报告文件** 双证据完成留痕。

## 产物
- 代码文件写入 src/ 或对应目录
- 评测数据写入 .goo/
```

### 优化型 (type: "optimize")

在 exec 模板（含上方 Heartbeat 和交付要求）基础上追加以下优化要求和额外心跳里程碑：

```
## 优化要求
- 先测量基线性能，再优化
- 每次优化后必须用相同指标评测
- 记录优化前后对比
- 如果连续两次无提升，停止并报告

## 优化额外心跳
在 exec 里程碑基础上增加：

| 里程碑 | `--progress` | 时机 |
|--------|-------------|------|
| 基线测量完成 | `25` | 基线跑完，记录指标 |
| 每轮优化后 | `45→65→85` | 逐轮递增，最后一轮到 85 |
```

### 评测型 (type: "eval")

```
你是一个 AutoGoo-Plugin 评测 Subagent。

你只负责评测当前 step 的指定产物。不要修改被评测实现，除非主 Agent 明确授权。

## 评测任务
{step.description}

## 待评测产物
{upstream_outputs}  ← 上游步骤产出的文件路径/数据

## 要求
1. 先搜索该领域标准评价指标 (WebSearch / context7)
2. 定义明确的评测 protocol（硬件、数据集、运行次数）
3. 执行评测
4. 写入 .goo/logs/ 和 .goo/eval-metrics.md
5. **完成后回写 plan.json**：status="completed"

## Heartbeat（强制）
与 exec 模板相同的心跳机制。先解析 AutoGoo-Plugin 根目录，在以下里程碑调用 `update-step.py`：

| 里程碑 | `--progress` | 时机 |
|--------|-------------|------|
| 启动 | `5` (`--start`) | 第一步 |
| 指标研究完成 | `20` | 评价指标和 protocol 确定后 |
| 评测执行中 | `60` | 评测跑完一轮 |
| 写入报告 | `90` | 日志和 eval-metrics 写入后 |
| 完成 | `--complete` | 最终 |
```

## 通用 Dispatch 流程

```
主循环每次迭代:
  1. 扫描 plan.json
     → 找出所有 status=pending 且 depends_on 全部 completed 的步骤
     → 按优先级排序（扇出度 > 预估耗时 > 同层剩余数）
     → 加入 ready_queue

  2. 填充槽位
     while running slots < MAX_CONCURRENT AND ready_queue 非空:
       step = ready_queue.pop(0)
       → 检查 step.subagent 是否合法
         → 合法: 按 step.subagent 读取 agents/roles/<role>.md，再按 step.task_agent 读取 agents/tasks/<department>/<task>.md，合成 Subagent Prompt 后启动 Agent (run_in_background；mode=worktree 且 HEAD 可解析时传 isolation="worktree"，mode=none 不传 isolation；mode=none 若仍触发 HEAD 解析失败则记录 compatibility.agent_requires_git_head 并阻塞，不再 probe)
         → subagent 或 task_agent 不合法/缺失: 暂停派发，先修正 plan 或创建新角色/任务画像
       → 主 Agent 先调用 `thread-locks.py check-plan --plan <thread-plan>`，无冲突后调用 `thread-locks.py acquire-plan --plan <thread-plan>` 获取写资源锁，再调用 `update-step.py --start --progress 5 --agent-id <agent>` 写入 status、started_at、首个 heartbeat_at 和 step log
       → 调用 `goo-status.py --update-status` 后运行 `goo-status.py`，向用户展示 RUNNING 心跳摘要
       → 等待 3-5s（错峰）
       → running.append(step)

  3. 等待完成事件
     → 任一 agent 完成 → 从 running 移除
     → 检查结构化最终答复、step log、heartbeat 里程碑和声明 output/outputs；声明产物缺失时必须 blocked/failed，不得 completed；0 tool uses 只是可疑信号，只有完成证据全缺失才判定为空跑
     → 回写 plan.json: status="completed"/"failed"/"blocked"；流程完成、失败或停止时调用 `thread-locks.py release-plan --plan <thread-plan>` 释放资源锁
     → 写入 .goo/logs/
     → 运行 `goo-status.py`，向用户展示最新完成/告警/下一步摘要
     → 立即回到步骤 1（刚完成步骤的下游可能已就绪）

  4. 心跳巡检（每 30s）
     → 检查 running 中每个 agent 的 heartbeat_at
     → 运行 `goo-status.py`，把 RUNNING 行中的 progress、hb age、log 摘要展示给用户；不得只在后台静默检查
     → 超时 >= execution.stale_after_seconds（默认 900s=15min，秒数）→ 标记 failed，释放槽位
```

## 心跳机制

### 为什么需要心跳

后台 Agent 随主会话死亡（`/exit` 或超时时所有 run_in_background agent 被 kill）。没有心跳就无法区分"agent 死了"和"agent 还在跑"。

### 心跳规则

- 主 Agent 派发前先写第一次 heartbeat_at + progress=5；这一步必须用 `update-step.py --start --progress 5 --agent-id <agent>` 完成
- Subagent 启动后不要重复 `--start`；从读输入完成开始按里程碑继续更新 `heartbeat_at` + **`progress` (0-100)**
- 进度估算：agent 在任务开头拆 3-5 个里程碑，每过一个里程碑更新进度
- 心跳通过统一 resolver 得到的 `auto_goo_root` 调用 `skills/auto-goo/scripts/update-step.py` 更新 plan.json，不要手写临时 JSON 修改代码
- 心跳必须前台可见：主 Agent 每次派发批次后、每轮 30s 巡检后、任一 Agent 完成后都运行 `goo-status.py`，至少展示 RUNNING 和 WARNINGS 摘要

### 进度判断

| progress 状态 | 判断 |
|---------------|------|
| 0 | 刚启动，尚未开始实质工作 |
| 5 | 主 Agent 已派发，Agent 可能刚启动 |
| 15-25 | 读输入、理解上下文阶段 |
| 30-70 | 核心实现阶段 |
| 75-95 | 收尾、自查、写日志 |
| 100 | 完成（与 status=completed 同步） |
| 停滞 >= 3 轮心跳 | 可能卡住，发出警告 |

### 心跳判断（跨会话恢复时使用）

| heartbeat_at 状态 | 判断 |
|-------------------|------|
| 距今 < 2 分钟 | Agent 可能仍在运行（如果会话还在） |
| 距今 >= 2 分钟 | Agent 已死亡（僵尸进程），可重新派发 |
| 为空（从未启动） | 步骤从未被执行 |

这 2 分钟判断只用于 `/auto-goo:goo-continue` 的跨会话恢复。正常执行中的失败超时使用 `heartbeat_timeout_min`，默认 15 分钟；不要把运行中超过 2 分钟未更新心跳直接标记为 failed。

## 错误处理

| 情况 | 处理方式 |
|------|---------|
| Agent 执行失败 | 记录错误日志，重试 1 次 |
| 权限/沙箱/approval 阻塞 | 调用 `update-step.py --block --error "needs_user_approval: <命令/原因/读写路径/风险>"`，主 Agent 聚合后前台询问用户；不按普通失败重试 |
| 重试仍失败 | 标记 status="failed"，继续执行不依赖它的步骤 |
| 关键路径失败 | 通知用户，并优先用结构化选项询问：`重试该步骤`、`跳过并继续可执行的非依赖步骤`、`停止并保留当前现场`；纯文本编号只作为交互控件不可用时的 fallback |
| Agent 超时（>15 分钟无心跳，可配置） | 视为失败，按失败流程处理 |
| 会话中断（心跳停滞 >= 2min） | 恢复时检测到僵尸，重置为 pending 重新派发 |
| 部分成功 | 合并已成功的结果，标注失败步骤 |
| Subagent 或 task_agent 缺失 | 暂停派发，先补 plan 或创建新 Role Agent/Task Agent |

## 结果合并

所有并行 Agent 完成后：
1. 收集每个 Agent 写入当前 thread `logs/` 的记录
2. 汇总到当前 thread `logs/_summary.md`
3. 当前 thread `plan.json` 已是最新状态，无需额外合并
4. 通知用户完成状态

## 上下文传递规则

| 上游产出类型 | 传递方式 | 示例 |
|-------------|---------|------|
| 代码文件 | 传递文件路径 | `/src/parser/baseline.py` |
| 数据文件 | 传递路径 + schema | `/data/benchmark_results.json` |
| 分析结论 | 直接写在 prompt 中 | "基线吞吐为 125k rows/s" |
| 模型权重 | 传递路径 + 指标 | `/models/checkpoint.pt, acc=0.92` |

### 最小上下文规则

- 传路径优先于传全文。
- 传摘要优先于传完整日志。
- 只传直接依赖步骤的产物；跨层共享必须由主 Agent 明确说明原因。
- 对大型文档、数据或代码，传文件路径、行号范围、schema 和验收点。
- 对 wiki 召回内容，传可复用约束和结论，不传整篇 wiki。
- 如果 Subagent 发现上下文不足，必须在日志里说明缺口，并向主 Agent 请求补充，不能自行扩大扫描范围。

## 并行分发检查清单

分发每个 Agent 前确认：

- [ ] MAX_CONCURRENT 未满（running < 3 或配置值）？
- [ ] 上一步派发距今 >= 5s（错峰间隔）？
- [ ] 步骤间真的没有数据依赖（与所有 running agent 无冲突）？
- [ ] 步骤间不会写同一个文件（与所有 running agent 无冲突）？
- [ ] 该 step 是否声明了合法 `subagent` 角色？不合法时先补 plan 或创建新角色，不由主 Agent 代执行
- [ ] 该 Agent 的 prompt 包含：任务描述 + 上游产物路径 + 允许读写范围 + 回写 plan.json 指令？
- [ ] **该 Agent 的 prompt 包含 Heartbeat 强制分段？**（缺少此项 Subagent 不更新 heartbeat_at，会被误判为僵尸）
- [ ] **主 Agent 派发前已调用 `update-step.py --precreate-log` 创建 dispatch 骨架？** 缺这一步就等于"派出去不留痕"，主 Agent 必须在派发 Subagent 前完成这一步并把 `log_path` 回填进 plan.json
- [ ] **该 Agent 的 prompt 包含「0 号动作：先落痕、后动手」？**（参见执行型 prompt 模板，要求 Subagent 在写任何代码前先 heartbeat 接管 dispatch 骨架）
- [ ] 该 Agent 即使看不到主会话聊天记录，也能仅凭 plan/Markdown/wiki 摘要完成当前 step？
- [ ] 该 Agent 只拿到与当前 step 相关的 wiki_context 和日志摘要？
- [ ] 该 Agent 知道往哪里写日志（当前 thread `logs/`）？
- [ ] 日志写入逻辑独立于执行结果（即使失败也能写日志）？
- [ ] 下游扇出度已计算（用于优先级排序）？

## 主 Agent Post-Check 流程（与「完成验收闸门」配合）

> 凡 Subagent 返回 `Done`，主 Agent 必须按本流程执行端到端留痕校验，缺一不可。**「subagent 执行完成 = step 完成」是不成立的；只有「post-check 全部通过」才允许 `--complete`。**

### 派发前 pre-dispatch（必须）

```bash
# 1. 在派发 Subagent 之前，先创建 dispatch 骨架，让 logs/ 里有"派发事实"
python3 "$auto_goo_root/skills/auto-goo/scripts/update-step.py" \
  --plan "$plan_path" --step-id "$step_id" \
  --precreate-log --note "<派发上下文：上游产物路径 / 上一步关键决策 / 关键约束>"
```

**这一步是 post-check 的左半边**：Subagent 是否失联都至少有一份派发证据。

### 收尾 post-check（必须）

主 Agent 在收到 Subagent `Done` 之后、调用 `--complete` 之前，必须依次运行（按 step type 分流），**全部通过**才能标记 completed；**任一项缺失**就把 step 回写 `blocked: dispatch_no_log` 或 `failed`，走重派或结束：

#### 通用：必有信号
- **A1. 日志存活**：`ls -lh "{thread.logs_dir}/"` 显示本 step 的 `step-{id}_*.md` 存在且大于骨架大小（>= 1KB 或至少有 Subagent 追加的 1 个新段）
- **A2. 心跳存活**：`logs/{id}*.md` 里至少有 3 行 milestone heartbeat（15 / 50 / 85 / complete），或运行 `python3 update-step.py --plan <plan> --step-id <id>` 拿 `heartbeat_at` 时间戳

#### 按 step type 流：分项检查

| step type | 必查路径 | 命令 |
|----------|---------|------|
| `exec` / `optimize` (实现型) | 落盘产物 | `git -C <project> diff --stat HEAD` <br>`ls -lh <step.outputs>` 至少一个非空 <br>`grep -nE "产物路径\|落盘到\|写入" logs/...md` 至少有一条 Subagent 自报的产物路径 |
| `research` / `eval` / `audit` / `review` (分析型) | 报告 / 笔记 | `ls -lh <step.outputs>` <br>`grep -nE "## 结论\|## 推荐\|## 风险\|## 指标" logs/...md` 至少 1 个结论段 <br>如果产物是 markdown：报告首段非 placeholder，含 ≤ 200 字结构化结论 |
| `archive` (归档型) | Goo-wiki / fallback | 主 Agent 跑 `wiki-graph-assist.py --validate --task-page <path>` 验证 wikilink；检查 `execution/record.md`、`execution/evidence-index.md` 存在，且索引逐项覆盖 plan、全部 step logs、artifacts/reports/context_artifacts 或说明 `仅索引`/`不可用`/`已脱敏`；只存在模型摘要不得通过 <br>`ls -lh <wiki_dir>/wiki/projects/<slug>/` 或 `ls -lh .goo/obsidian/<slug>/tasks/<tid>/` |
| `optimize` (优化型) | 评测 + 对比 | 上述 exec + eval 两组合并 |

**关键：分析型 Subagent 没有代码改动是合法的。** 不要因为 `git diff` 为空就标 failed；这种 step 必须靠 **日志结构化结论 + 报告文件** 双证据完成留痕。判断"是否完成"看 step type 列出的必查路径，而不是看 git diff 是否变更。

### 失败判定

| 现场 | 主 Agent 操作 |
|------|--------------|
| 日志骨架存在但 Subagent 未接管（无新段落、无心跳升级） | 标 `blocked: dispatch_no_log`；按 SKILL.md 「完成验收闸门」走重派 |
| 报告/产物路径不存在但日志说"已完成" | 标 `failed: output_missing`；让 Subagent 重跑并用 `Bash ls -lh` 自验 |
| 心跳停滞但日志在涨 | 标 `running + 延长 heartbeat_timeout`，不重派 |
| 产物全部存在，日志结构完整 | 标 `completed`；更新 thread/plan 状态 |

## Subagent 分类速查

| 类型 | 用途 | 典型工具 | 返回格式 |
|------|------|---------|---------|
| **Researcher** | 调研、搜索 | WebSearch, context7, Read | `.md` 报告 |
| **Implementer** | 写代码、实现 | Write, Edit, Bash | 文件路径 |
| **Optimizer** | 性能分析优化 | Bash(profiling), Edit | 对比报告 |
| **Evaluator** | 评测、benchmark | Bash, WebSearch | 数值指标 |
| **Reviewer** | 审查代码方案 | Read, Grep | Review 报告 |
| **Auditor** | 安全、合规、证据链、可追溯性审计 | Read, Grep, Bash | 审计报告 |
| **Security Checker** | auditor 旗下安全检测 task agent | Read, Grep, Bash | 安全风险清单 |
| **Recorder** | Obsidian 归档 | Write | 格式化 `.md` |

## 日志格式

**铁律：每一步执行必须归档。外部原因无法完成验证时仍须写日志记录失败原因。**

**时间戳格式**：文件名和内容统一使用 `YYYY-MM-DDTHH-MM-SS`。

### 单步日志

```markdown
# Step T.S: 步骤名
| 字段 | 值 |
|------|-----|
| **时间** | YYYY-MM-DDTHH-MM-SS |
| **状态** | ✅ Completed / ❌ Failed |
| **耗时** | XmXs |

## 输入
<输入数据/上下文>

## 输出 (产物路径)
<产物路径列表>

## 关键决策
<why + 原因>

## 问题记录
<遇到的问题及处理>
```

### 汇总日志

步骤表（名称 + 状态 + 耗时）+ 总体耗时 + 结论。

### eval-metrics.md

先检查是否已有该领域指标，有则引用，无则追加。

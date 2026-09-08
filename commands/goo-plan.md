---
name: auto-goo:goo-plan
description: 只生成 AutoGoo-Plugin 执行计划 — 召回 Goo-wiki 经验并输出 .goo/plan.json，不派发执行
---

# /auto-goo:goo-plan — 只规划，不执行

输入 `/auto-goo:goo-plan <任务描述>` 生成可审阅的 AutoGoo-Plugin 计划。

## 行为

1. **Thread 归属检查** — 如果 `.goo/current_thread.json` 或 `.goo/plan.json` 指向的当前 thread/plan 未完成，先提醒用户当前 thread id、状态和未完成步骤摘要，并优先用 `AskUserQuestion` / 结构化选择 UI 复用 `id=thread_action` 模板询问是“新建 thread”还是“继续当前 thread”。用户未明确选择前，不得覆盖当前 thread 的 plan。
2. **Wiki 经验召回（collector/wiki-gatherer）** — 派发 `collector`（wiki-gatherer）Subagent 用 `wiki-graph-assist.py` 生成 wiki evidence packet，检索 Goo-wiki 中相关项目页、概念页、周报和 `log.md`；主模型消费 packet，不亲自 Read/Grep 全量 wiki。
3. **输入形态识别** — 主模型判断输入是普通任务、Markdown 任务包、已有 plan、issue/PR 描述还是日志片段；本判断属高认知综合留主模型，但若输入为原始日志片段，其原始日志解析应下放 `collector`（log-analyst）产出 evidence packet，主模型只消费解析结果。
4. **目标明确性检查** — 判断输入是否已有明确 goal，或是否引用了 `.goo/brainstorm.json` 中的候选 goal；否则停止 plan 流程并改用 `/auto-goo:goo-brainstorm`
5. **Goal 识别** — 目标明确时抽取一个或多个 `goals[]`，每个 goal 写清交付物、验收标准、优先级和依赖关系
6. **任务解析** — 将任务拆解为 DAG 步骤；每个非归档步骤绑定 `goal_id` 或 `goal_ids`
7. **并行优先审计** — 对所有非归档 step 做依赖审计：没有真实数据依赖、控制依赖、共享写入冲突或高风险确认门槛的步骤，不得为了叙事顺序串行化；必须写成相同 `tier` 和空/相同 `depends_on`，让执行阶段可并行派发
8. **对话方案固化** — 抽取当前对话中已经形成的方案、取舍、约束、验收标准和用户明确偏好，写入 `context_digest`；内容过长时写入 Goo-wiki 项目路径 `wiki/projects/<project-slug>/context/<timestamp>-planning-context.md` 并在 plan 中引用
9. **远程资源预检与确认** — 读取项目 `.goo/config.json` 和用户级 `~/.auto-goo/config.json` 中的 `servers[]`。如果存在已配置服务器，派发 `collector` Subagent 运行 `skills/auto-goo/scripts/remote-resources.py --probe` 生成 CPU/内存/磁盘/GPU 可用资源摘要并返回 remote-resources packet（主模型不亲自跑该探测脚本）；探测失败只记录不可用原因，不阻塞本地 plan。主模型消费 packet 后展示摘要，并必须优先用 `AskUserQuestion` 复用 `id=remote_resource_usage` 模板询问用户本次是否使用服务器。用户选择本地或未明确确认时，所有 step 默认 `execution_target="local"`；用户确认使用远程后，才把匹配的 step 写入 `execution_target="remote"`、`remote_server`、`remote_reason` 和 `requires_user_confirm=true`。如果结构化选择不可用，使用明确标注 fallback 的文本选项继续收集选择。
10. **远程执行目标标注** — 只有当用户在远程资源预检中确认使用服务器，或用户在任务中已明确要求远程执行时，才在对应 step 写入 `execution_target="remote"` 和 `remote_server`。即使任务看起来需要 GPU、远程依赖或长跑环境，也必须先展示资源摘要并获得确认；否则默认 `execution_target="local"`。
11. **上下文注入** — 把可复用经验写入 `wiki_context`，把对话方案写入 `context_digest` 或 `context_artifacts`
12. **归档任务补齐** — 默认在 DAG 最后追加 Wiki 归档步骤，依赖所有最终交付步骤，并按 goal 汇总归档
13. **Thread 落盘** — 用户选择新建 thread 时，创建 `.goo/threads/<thread_id>/thread.json`、`plan.json`、`logs/`、`artifacts/`，更新 `.goo/threads/index.json` 和 `.goo/current_thread.json`；用户选择继续当前 thread 时，更新该 thread 的 plan。
14. **历史计划归档** — 如果要替换当前 thread 的已有 plan，先复制到 `.goo/plans/history/plan-<timestamp>.json`；不得静默覆盖未完成 plan。
15. **计划落盘** — 输出或更新当前 thread 的 `plan.json`，并把 `thread.id` 写入 plan；兼容路径 `.goo/plan.json` 可指向或复制当前 thread 的 active plan，标记为待用户审阅。
16. **等待确认** — 先发送一条普通可读消息展示 thread id、计划摘要、目标/交付物、DAG 步骤概览、并行组、必要串行链、远程资源选择、主要风险和需要确认的点；确认用户已经能在聊天正文看到计划概述后，必须实际调用 `AskUserQuestion` / 结构化选择 UI 让用户确认、修改、拆分/合并步骤或回到 brainstorm。不得只显示结构化审阅控件，也不得在未尝试调用 `AskUserQuestion` 时直接输出纯文本 fallback。用户确认前不要归档 plan 摘要。
17. **确认后归档（recorder）** — 用户确认计划后，或用户明确启动 `/auto-goo:goo-start` / `/auto-goo:goo-continue` 前，派发 `recorder` Subagent 撰写计划摘要、关键约束和可复用规划经验的归档正文；主模型只决定归档内容和目标路径，不亲自撰写归档正文；不派发执行 Subagent，不修改业务文件，不运行实现命令，除非用户进入执行命令。

## 现有 plan 冲突处理

每次进入 `/auto-goo:goo-plan` 时，必须先检查当前项目的 `.goo/current_thread.json`、`.goo/threads/index.json` 和兼容 `.goo/plan.json`：

- 如果文件不存在，正常生成新 plan。
- 如果所有 `steps[]` 的 `status` 都是 `completed`，且顶层 `status` 为 `completed` 或缺失但可由 steps 推断为完成，允许归档旧 plan 后生成新 plan。
- 如果任一 step 的 `status` 不是 `completed`，或顶层 `status` 是 `pending` / `running` / `blocked` / `paused` / `failed`，必须暂停并提醒用户当前 `thread_id`、未完成项数量、当前运行/阻塞/失败/待执行 step 摘要，然后询问：
  - 新建 thread：创建 `.goo/threads/<thread_id>/` 并把新 plan 写入该 thread，不覆盖当前执行现场。
  - 继续当前 thread：把新需求合并到当前 thread 的 plan，保留已完成步骤、日志和执行证据。
  - 取消：保留当前 thread 和 plan 不变。
- 用户未明确选择前，不得覆盖、归档或重写当前 thread 的 plan。

提问必须优先使用 `AskUserQuestion` / 结构化选择 UI，并复用 `skills/auto-goo/references/interaction-templates.md` 中 `id=thread_action` 的 JSON 模板。选项为：

- 新建 thread
- 继续当前 thread
- 取消

如果结构化选择 UI / AskUserQuestion 不可用、调用失败或按钮没有渲染，使用以下纯文本 fallback：

```text
当前 thread 或 .goo/plan.json 还未完成。请选择处理方式：
1. 新建 thread - 为新任务创建独立 thread_id、plan、logs 和 artifacts
2. 继续当前 thread - 把新需求合并到当前计划
3. 取消 - 保留当前 thread 和 plan 不变

这是 fallback；请回复 1/2/3，或直接回复“新建 thread”“继续当前 thread”或“取消”。
```

## Markdown 任务输入

如果用户传入 Markdown 文件或片段，先按结构化任务读取：

- 标题层级表示任务主题、阶段或依赖分层。
- checkbox、编号列表和 TODO 表示候选步骤。
- 代码块、路径、命令和错误日志表示执行约束或验证依据。
- "目标/约束/验收/风险/产物/下一步"等小节必须转成 plan 约束。

不要把 Markdown 默认理解为"整理文本"。只有用户明确说要总结、润色、改写或重新排版 Markdown 时，才生成文本处理计划。

## 并行优先规划

`goo-plan` 生成的是可执行 DAG，不是线性 TODO。规划时默认寻找并行层：

- 只有存在真实前置关系时才写 `depends_on`：下游必须读取上游产物、必须等待上游验收/用户确认、会写同一文件或共享状态、或存在资源/风险冲突。
- 仅因为用户描述顺序、文档段落顺序、角色不同、同属一个 goal、或为了“看起来更稳”而串行化，都不算合法依赖。
- 多个步骤如果只读同一输入、写不同产物、验收互不依赖，应使用相同 `tier`，并保持 `depends_on` 为空或相同，让执行阶段并行派发。
- 共享准备 step 可以作为 `tier=1`；其后各分支只依赖该共享 step，并在同一后续 tier 并行展开。
- 统一验证、审查和归档 step 依赖所有对应叶子步骤；不要让某个独立分支错误依赖另一个独立分支。
- 如果某一步看似依赖上一步，必须在 `description` 或 `inputs` 中说明依赖的具体产物或决策；说不清具体依赖时，改成并行。

计划摘要必须展示并行组，例如 `Tier 1: step 1,2,3 可并行`，并单独列出真正串行链及原因。

## 是否需要 Brainstorm

`goo-plan` 不主动 brainstorm，只做目标明确性判断。

### 直接生成 plan

输入满足以下条件时，直接生成 `.goo/plan.json`：

- 有明确交付物，例如代码修复、报告、README、数据集、训练产物、评测结果。
- 有范围边界，例如文件、模块、项目、数据路径或问题域。
- 有验收标准，或能从任务自然推导出验收方式。
- 能拆出至少一个可执行 step。

### 基于 brainstorm 结果生成 plan

如果当前项目存在 `.goo/brainstorm.json`，且用户明确选择了候选 goal，例如"用 cg1 做 plan"、"把 cg1 和 cg3 合并规划"、"按 brainstorm 推荐的第一个目标执行"，则：

1. 读取 `.goo/brainstorm.json`。
2. 将选中的 `candidate_goals[]` 转成正式 `goals[]`。
3. 把候选 goal 的 `expected_output` 写入 goal `outputs`。
4. 把候选 goal 的 `acceptance_criteria` 写入正式 goal。
5. 把 `prerequisites` 和 `readiness_checklist` 转成 plan 的前置检查 step 或对应 step 的 `validation` / `requires_user_confirm`。
6. 再生成执行 DAG。

### 先停止并要求 brainstorm

以下情况不要写 `.goo/plan.json`：

- 用户明确说不知道目标、想 brainstorm、想探索方向、想基于 wiki 找下一步。
- 输入只有项目名、方向、现状或问题域，没有交付物。
- 候选方向互相竞争，且没有选择或优先级。
- 需要先从 Goo-wiki 归纳下一步目标。

此时提示用户使用：

```text
/auto-goo:goo-brainstorm <方向/项目/问题>
```

## 对话方案固化

如果用户在当前对话里已经讨论过方案、备选路线、关键约束或验收口径，`goo-plan` 必须把这些信息沉淀到持久载体，避免后续执行依赖主会话上下文。

- 简短信息写入 `.goo/plan.json.context_digest`，至少包含 `decisions`、`constraints`、`acceptance_criteria`、`open_questions`。
- 长方案、会议纪要或 prompt 草案优先写入 Goo-wiki 项目路径 `wiki/projects/<project-slug>/context/<timestamp>-planning-context.md`，并在 `.goo/plan.json.context_artifacts` 中引用；Goo-wiki 不可用时才降级写入 `.goo/obsidian/<project-slug>/context/`。
- 每个 step 的 `description` 必须自包含，不使用"按上面方案"、"参考前文"、"照刚才说的"这类隐含引用。
- 如果需要沉淀为长期项目经验，同时在归档步骤中要求写入 Goo-wiki；执行前不能只靠聊天记录理解任务。

## Brainstorm 与 Plan 归档同根

这里的“同根”指 Goo-wiki/fallback 知识归档，不改变本地 JSON 历史快照路径。旧 plan 快照仍归档到 `.goo/plans/history/`；旧 brainstorm 快照归档到 `.goo/brainstorms/history/`。

如果 `.goo/brainstorm.json` 已存在并被本次 `goo-plan` 采用，plan 的 Goo-wiki/fallback 归档路径必须复用 brainstorm 的 `archive.task_archive_root`。但 brainstorm 和 plan 都要先给用户审阅；用户确认前只更新本地 `.goo/brainstorm.json` / `.goo/plan.json`，不要急着写 Goo-wiki/fallback 归档笔记：

- brainstorm 内容放在 `<task_archive_root>/brainstorm/`。
- plan 摘要、正式 DAG、`context_digest`、`wiki_context` 和计划取舍放在 `<task_archive_root>/plan/`。
- `.goo/plan.json.archive.task_archive_root` 必须等于 `.goo/brainstorm.json.archive.task_archive_root`。
- `.goo/plan.json.archive.plan_dir` 记录 `plan/` 子目录路径；`.goo/brainstorm.json.archive.brainstorm_dir` 记录 `brainstorm/` 子目录路径。
- 如果旧 brainstorm 没有 `task_archive_root`，先为当前任务创建同一任务归档根，再回写 `.goo/brainstorm.json.archive.task_archive_root` 和 `brainstorm_dir`，然后写 plan 归档。

没有 brainstorm 来源的 plan 也应创建自己的 `task_archive_root`，后续执行归档写入同一根下的 `execution/` 子目录。

## 适用场景

- 任务风险较高，需要先审计划
- 任务跨多个会话，想先确认 DAG 边界
- 需要确认 AutoGoo-Plugin 是否正确复用了 Goo-wiki 项目经验
- 输入是 README、设计文档、TODO 清单或 issue 模板，需要先抽取真实执行任务
- 只想获得执行路线，不希望立即改代码或跑命令

## 示例

```text
/auto-goo:goo-plan 优化 KiCad VLM QA 生成流程，并复用已有 v3/v4 经验
/auto-goo:goo-plan 规划一个 CSV 分析报告工作流
```

## 输出要求

- `.goo/plan.json` 必须包含 `wiki_context`
- 目标不明确时，不写 `.goo/plan.json`；改用 `/auto-goo:goo-brainstorm` 生成 `.goo/brainstorm.json`
- 如果用户选择了 `.goo/brainstorm.json` 中的 candidate goal，必须把候选目标、前置条件和 ready checklist 转成正式 `goals[]` 与前置检查 step
- `.goo/plan.json` 必须包含 `goals[]`；单目标任务也写一个默认 goal，多目标任务按交付目标分别写验收标准和产物
- `.goo/plan.json` 或 `.goo/threads/<thread_id>/plan.json` 必须包含 `thread.id`、`thread.plan_path`、`thread.logs_dir` 和 `thread.artifacts_dir`；前台摘要必须展示 thread id，便于后续 status/continue 定位
- `.goo/plan.json` 必须包含 `context_digest`；没有额外对话方案时也写 `{"found": false, "decisions": [], "constraints": [], "acceptance_criteria": [], "open_questions": []}`
- `.goo/plan.json` 必须包含 `review`，初次生成后写 `{"status": "pending_user_review", "summary": "<给用户看的简短计划摘要>"}`；用户确认后改为 `confirmed`，用户要求修改时保持 `pending_user_review` 并记录修改要求
- 如果存在大段方案材料，必须包含 `context_artifacts`，用文件路径引用 Goo-wiki 项目路径下的 `context/*.md` 或相关任务 Markdown；Goo-wiki 不可用时引用 `.goo/obsidian/<project-slug>/context/*.md`
- 写入新的 `.goo/plan.json` 前，必须把已有 `.goo/plan.json` 原样归档到 `.goo/plans/history/`
- 每个步骤必须包含 `output`，便于后续 `/auto-goo:goo-continue` 恢复
- 每个非归档步骤必须包含 `goal_id` 或 `goal_ids`；共享准备、统一验证或统一归档步骤使用 `goal_ids`
- 每个步骤必须包含 `tier`；同一 `tier` 内互不依赖的步骤应尽量并行，不能把可并行步骤写成逐个依赖的线性链
- 每条 `depends_on` 都必须代表真实数据、验收、确认、共享写入或风险依赖；如果只是叙事顺序或文档顺序，必须移除依赖并放入同一并行层
- 每个步骤应包含 `inputs`、`outputs`、`allowed_read_paths`、`allowed_write_paths` 和 `validation`，让执行阶段不依赖聊天记录猜测读写范围和验收方式
- 每个步骤应包含 `execution_target`，默认 `"local"`；需要远程执行时写 `"remote"`，并同时写 `remote_server`（优先匹配 `servers[].name`，也可匹配 `host` / `host:port` / `user@host:port` / index）和 `remote_reason`
- 远程执行 step 必须设置 `requires_user_confirm=true`，`risk_level` 至少为 `"medium"`，并在 `description` 或 `validation` 中写清远程命令类别、远程路径、预期产物和回传/验收方式；不得把 secrets 写入 plan
- 每个步骤必须包含 `subagent`，明确稳定 Role Agent：`researcher` / `collector` / `implementer` / `optimizer` / `evaluator` / `reviewer` / `auditor` / `recorder`
- 每个步骤必须包含 `task_agent`，明确细分 Task Agent，例如 `codebase-scout`、`feature-builder`、`test-runner`、`code-reviewer`、`evidence-auditor`、`wiki-curator`；不确定时先选对应 role 下最通用的 task agent，不要留空
- 每个步骤应包含 `available_skills` 数组，列出本步骤允许或建议 Subagent 使用的 skill；没有额外 skill 时写 `[]`。该字段只放 Codex/Claude skill 名称，不放 agent 名称、文件路径或项目 reference
- `steps` 最后必须包含 Wiki 归档任务，默认名称为 `归档到 Goo-wiki`，依赖所有非归档叶子步骤
- 初次 plan-only 只写入 archive step，不执行归档；计划摘要归档要等用户确认计划后再做
- 如果没有找到相关 wiki 经验，写入 `wiki_context.found=false`
- 最终必须先向用户发送简洁计划摘要、目标/交付物、DAG 步骤概览、并行组、必要串行链及主要风险；随后再展示计划审阅提问

## 下一步

计划确认后，用户可以运行：

```text
/auto-goo:goo-start <同一任务>
```

或让 AutoGoo-Plugin 从当前 `.goo/plan.json` 继续执行。

## 计划审阅提问格式

生成或更新 `.goo/plan.json` 后，必须分两步收尾：

1. **先展示计划概述**：用普通聊天正文展示可读摘要，至少包含 thread id、`review.summary`、goals/交付物、按 step id/name/tier 摘要的 DAG、并行组、必要串行链及原因、主要风险、需要用户确认的点。不要把这些信息只写进 `.goo/plan.json` 或隐藏在工具调用结果里。
2. **再发起审阅提问**：计划概述发出后，必须实际调用 `AskUserQuestion` / 结构化选择 UI，并复用 `skills/auto-goo/references/interaction-templates.md` 中 `id=plan_review` 的 JSON 模板。不要把模板选项改写成普通编号列表。

不得在没有先展示计划概述的情况下直接调用 `AskUserQuestion`；也不得在没有尝试调用 `AskUserQuestion` 的情况下直接使用纯文本 fallback。修改要求、拆分/合并说明通过 Other 输入，输入后必须同步进 plan 或再次展示审阅。选项为：

- 确认计划
- 修改计划
- 拆分/合并步骤
- 回到 brainstorm

只有在实际调用 `AskUserQuestion` 后确认结构化选择 UI 不可用、调用失败或按钮没有渲染，才使用以下纯文本 fallback；fallback 前必须说明“结构化选择 UI 未渲染，改用文本 fallback”：

```text
请审阅计划：
1. 确认计划
2. 修改计划
3. 拆分/合并步骤
4. 回到 brainstorm

这是 fallback；请回复 1/2/3/4，或直接写修改要求。
```

用户未明确确认前，`review.status` 必须保持 `pending_user_review`，不得归档计划摘要或启动执行。

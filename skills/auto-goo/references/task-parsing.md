# 任务解析 (Task Parsing)

## 解析流程

0. **Wiki 经验召回** — 派发 researcher 检索 Goo-wiki 中相关项目页、概念页、问题页、周报、历史任务页和 `log.md` 并回传 evidence packet；主模型消费 packet 提取可复用经验与可链接页面
1. **识别输入形态** — 普通一句话、Markdown 任务包、已有 plan、issue/PR 描述、日志片段等要区别处理
2. **解析结构化任务** — 如果输入是 Markdown，先提取标题层级、任务清单、代码块、表格、约束、验收标准、文件路径和命令，再判断真实任务
3. **确认目标已明确** — 判断输入是否已有明确 goal，或是否引用了 `.goo/brainstorm.json` 中的候选 goal；如果用户还不知道要做什么、要求 brainstorm、探索方向或基于 wiki 找下一步，停止 plan 流程并切换到 `/auto-goo:goo-brainstorm`
4. **识别交付目标** — 抽取一个或多个 `goals[]`，每个 goal 都要有交付物、验收标准和优先级
5. **判断 goal 关系** — 独立 goal 优先拆成多个 plan；共享前置步骤则保留一个 DAG 并分支；强依赖 goal 按依赖链串联；冲突或优先级不清时先问用户
6. **上下文约束合并** — 基于 researcher evidence packet，将 wiki 里的历史决策、已验证命令、路径、指标口径、失败经验写入规划依据
7. **对话方案固化** — 将当前对话中已确认的方案、取舍、用户偏好、约束、验收标准和未决问题写入 `context_digest`；长文本优先写入 Goo-wiki 项目路径 `wiki/projects/<project-slug>/context/` 并在 `context_artifacts` 引用，Goo-wiki 不可用时降级到 `.goo/obsidian/<project-slug>/context/`
8. **远程资源预检** — 如果配置中存在 `servers[]`，先用 `remote-resources.py --probe` 生成 CPU/内存/磁盘/GPU 摘要并展示，再用 `AskUserQuestion` 复用 `id=remote_resource_usage` 询问本次是否使用服务器。用户确认前，不因为任务包含 GPU、长跑或远程关键词就写 remote step；用户选择本地时在 `runtime.remote_resource_decision` 记录 `use_remote=false`
9. **逆向拆解** — 从每个 goal 倒推："要交付这个，需要先有什么？" 持续追问直到拆成原子步骤
10. **标注依赖关系** — 步骤 A 必须在 B 之前完成 → B `depends_on` A；每个非归档 step 必须绑定 `goal_id` 或 `goal_ids`
11. **并行优先审计** — 移除仅由叙事顺序、文档顺序或保守习惯造成的伪依赖；能独立读输入、独立写产物、独立验收的步骤放入同一 `tier`
12. **识别优化标记** — 包含"性能/速度/延迟/吞吐/效率/内存/GPU/耗时" → `type: "optimize"`
13. **范围约束** — 每个步骤目标严格取自任务描述，不添加未要求的功能
14. **归档历史 plan** — 只有旧 plan 已完成，或用户明确选择新建/继续并确认替换当前 plan 时，才把旧 plan 复制到 `.goo/plans/history/plan-<timestamp>.json`；复制 history 不是覆盖未完成现场的许可
15. **识别强制 Wiki 分析产物** — 论文解读/深读以及代码库结构、调用链、数据流、架构、实现模式分析必须有独立 Markdown 输出，并由最终 archive step 写入 Goo-wiki；fallback 不能满足最终验收
16. **输出 plan.json**，并在审阅摘要中展示并行组、必要串行链、远程资源选择和主要风险

## 多 Goal 任务

当用户任务包含多个明确交付目标时，不要把它压成一条含糊的线性 plan。先抽取 `goals[]`，再决定是拆成多个 plan，还是保留一个带分支的 DAG。如果目标还不明确，先走 `/auto-goo:goo-brainstorm`。

### Goal 识别

以下信号通常代表多个 goal：

- 用户用"同时"、"以及"、"另外"、"顺便"连接多个交付物。
- Markdown 中出现多个顶层 TODO、多个验收小节或多个互不依赖的模块。
- 目标产物不同，例如"修复脚本"、"生成报告"、"更新 README"。
- 目标受众不同，例如"给训练流程用的 JSON"和"给用户看的说明文档"。

每个 goal 至少包含：

- `id`：稳定 ID，如 `g1`、`g2`。
- `name`：一句话目标名。
- `description`：该 goal 具体交付什么。
- `priority`：默认按用户原文顺序从 1 递增；用户明确优先级时按用户要求。
- `acceptance_criteria`：该 goal 的验收标准。
- `outputs`：该 goal 的最终产物。
- `depends_on`：依赖的其他 goal ID；没有依赖则为空数组。

### Goal 关系决策

| 关系 | 处理 |
|------|------|
| 完全独立 | 默认拆成多个小 plan；如果用户要求一次性规划，可保留一个 plan 但每个分支必须标 `goal_id` |
| 共享前置步骤 | 保留一个 plan：共享步骤使用 `goal_ids` 绑定多个 goal，下游按 goal 分支 |
| 强依赖 | 保留一个 plan 或顺序小 plan；后一个 goal 的首步依赖前一个 goal 的交付/验收步骤 |
| 目标冲突 | 先问用户取舍或优先级，不要自行合并 |
| 范围过大 | 生成总览 plan，并把当前可执行 goal 或前 1-2 层切成小 plan |

### Step 绑定规则

- 单目标 step 使用 `goal_id: "g1"`。
- 共享准备、统一验证或统一归档 step 使用 `goal_ids: ["g1", "g2"]`。
- 非归档 step 不应缺少 goal 绑定；如果缺少，执行前先补 plan。
- `description` 中要写清该 step 服务哪个 goal，以及它的输出如何支撑该 goal 的验收。
- 最后的 `归档到 Goo-wiki` step 应按 goal 汇总完成状态、产物路径、验证结果、延期/拆分原因和可复用经验。

## Brainstorm 到 Plan

`goo-plan` 只处理目标已明确的输入，但目标可以来自用户直接描述，也可以来自 `.goo/brainstorm.json` 中已被用户选中的候选 goal。

### 目标明确性判断

直接进入 plan 的最低条件：

- 有明确交付物：代码、文档、报告、数据、模型、配置、评测结果或归档内容。
- 论文分析和代码分析的交付物必须显式包含独立 Markdown 分析文档及 Goo-wiki 页面路径，不能只写“返回分析结论”。
- 有范围边界：文件、模块、项目、数据路径、wiki 页面、命令或问题域。
- 有验收方式：用户给出验收标准，或可以自然推导出测试、检查、文件存在性、指标阈值、人工确认点。
- 能拆出至少一个可执行 step。

不满足这些条件时，不要把模糊方向硬转成 plan；应先运行 `/auto-goo:goo-brainstorm`。

### 使用 `.goo/brainstorm.json`

当用户说"用 cg1 做 plan"、"把 cg1 和 cg3 合并规划"、"按 brainstorm 推荐目标执行"时：

1. 读取当前项目 `.goo/brainstorm.json`。
2. 校验用户选择的 candidate goal ID 存在。
3. 将每个选中 candidate goal 转成正式 `goals[]`：
   - `name` ← candidate `name`
   - `description` ← candidate `why` + `expected_output`
   - `acceptance_criteria` ← candidate `acceptance_criteria`
   - `outputs` ← candidate `expected_output`
4. 将 candidate `prerequisites` 和 `readiness_checklist` 进入执行 plan：
   - 对必须先确认的条件，生成前置检查 step。
   - 对高风险或需要用户判断的条件，设置 `requires_user_confirm=true`。
   - 对可自动检查的条件，写入 step `validation`。
5. 将 candidate `evidence` 合并到 `wiki_context.sources` 或 `context_artifacts`。
6. 基于正式 `goals[]` 继续生成 DAG。

### 不自动猜测

如果 `.goo/brainstorm.json` 存在，但用户没有明确选择 candidate goal，`goo-plan` 不能默认选推荐项直接执行。可以展示 `recommended_goal_ids`，但必须等待用户确认。

确认问题必须优先使用 `AskUserQuestion` / 结构化选择 UI，并复用 `skills/auto-goo/references/interaction-templates.md` 中 `id=existing_brainstorm_goal` 的 JSON 模板；不得在交互控件可用时要求用户手打编号或 goal ID。动态 `<goal_id>` 必须替换为真实推荐 ID；其他 goal 或合并指令通过 Other 输入，并校验能匹配候选 goals。仅当交互控件不可用时，才使用纯文本 fallback：

```text
检测到已有 brainstorm 候选目标。请选择用于 plan 的目标：
1. 使用推荐目标 <goal_id>
2. 选择其他目标（回复 goal ID，例如 g2）
3. 合并多个目标（回复例如：合并 g1,g3）
4. 回到 brainstorm

请回复 1/2/3/4，或直接回复 goal ID / 合并指令。
```

## Markdown 任务输入

当用户把 `.md` 文件、Markdown 片段、会议纪要、需求文档、TODO 清单、issue 模板或设计文档作为任务输入时，必须把它视为**结构化任务载体**，而不是默认归类为"文本整理"。

解析顺序：

1. **识别文档意图** — 判断 Markdown 是任务说明、需求规格、执行计划、问题列表、设计方案、验收清单，还是确实要求改写/总结的文本材料。
2. **抽取执行信号** — 从标题、checkbox、编号列表、表格、代码块、路径、命令、错误日志、"目标/约束/验收/风险/产物/下一步"等段落抽取任务元素。
3. **保留原始约束** — 把文档中的 must/should、禁止项、路径、指标、版本、范围边界写入 plan 的步骤描述或 `wiki_context.reused_knowledge`。
4. **生成真实 DAG** — 如果 Markdown 描述的是实现、修复、评测、发布或迁移任务，应按其目标生成工程执行 DAG；只有用户明确要求"总结/润色/整理这篇 Markdown"时，才把它作为文本处理任务。
5. **处理多任务文档** — 如果 Markdown 包含多个相互独立的任务，优先拆成并行步骤；如果有显式顺序、依赖或验收门槛，按文档顺序和依赖关系建 DAG。
6. **输出来源追踪** — 对从 Markdown 抽取出来的步骤，在 `description` 中保留来源小节名或清单项摘要，方便后续验收。

反例：

```text
用户输入: "按这个 README.md 里的 TODO 做"
错误理解: 生成一个'整理 README 文本'任务
正确理解: 读取 README.md，抽取 TODO/约束/命令/验收标准，形成代码或文档执行计划
```

## 对话方案输入

当用户在正式执行前已经通过多轮对话讨论出方案时，这些内容也是任务输入的一部分。`goo-plan` 和 `goo-start` 不能假设后续执行 Agent 会记得聊天记录，必须把可执行信息写入 plan 或 Markdown。

必须抽取：

- 已确认方案：最终采用哪条路线，为什么。
- 已拒绝方案：不采用哪些路线，主要原因是什么。
- 用户偏好：例如"优先落地实际结果"、"不要依赖上下文"、"只基于 plan/md 执行"。
- 硬约束：文件路径、命令、安全规则、数据口径、不能改的范围。
- 验收标准：哪些检查、测试或产物出现后算完成。
- 后续归档：哪些新经验应在任务结束后写入 Goo-wiki。

写入规则：

- 简短内容直接进入 `.goo/plan.json.context_digest`。
- 超过 10 行、包含代码块、prompt、表格或多方案比较时，优先写入 Goo-wiki 项目路径 `wiki/projects/<project-slug>/context/<timestamp>-planning-context.md`，并在 `context_artifacts` 引用；Goo-wiki 不可用时写入 `.goo/obsidian/<project-slug>/context/`。
- 如果 `.goo/plan.json` 已经生成，之后对话又产生新方案、约束、验收标准或用户偏好，`goo-start` / `goo-continue` 默认在执行前做 context sync：先把旧 plan 复制到 `.goo/plans/history/`，短内容追加到 `context_digest.post_plan_updates`，长内容写入 `context_artifacts` 指向的 Markdown。只有新增内容与原 plan 冲突、扩大范围、改变验收标准或涉及危险操作时才询问用户确认；确认问题必须优先使用结构化选项：`同步并继续执行`、`先修改 plan`、`停止并保留当前 plan`。
- 如果这段方案具有长期复用价值，在最后的 `归档到 Goo-wiki` step 中明确要求把它沉淀为项目页或经验页。
- step 描述必须可独立执行；如果删掉聊天记录后 step 仍然不清楚，说明 plan 不合格。

## 解析 Prompt 模板

按以下模板在脑中执行（不需要输出给用户看）：

```
## 任务分析

最终交付物：<一句话描述>
Goals：
- g1: <目标名> — <交付物/验收标准>
- g2: <可选，第二目标>

输入形态：
- 类型：<一句话/Markdown任务包/已有plan/issue/日志/其他>
- 若为 Markdown：<文档意图、关键小节、任务清单、约束、验收标准>

Wiki 经验召回（消费 researcher evidence packet）：
- 找到的相关页面：<来自 researcher packet 的 wikilink/path 列表>
- 可复用经验：<命令/路径/指标/风险/命名约定，来自 packet findings>
- 对本次计划的影响：<新增约束或调整>

对话方案固化：
- 已确认方案：<当前对话里已经确定的执行路线>
- 已拒绝方案：<可选，拒绝原因>
- 用户偏好/硬约束：<必须遵守的口径>
- 验收标准：<完成后如何判断可交付>
- 是否需要 context_artifact：<需要则写入 <wiki_dir>/wiki/projects/<project-slug>/context/*.md>

倒推步骤链：
1. <步骤名> — <做什么>
   - goal: <g1 或 [g1,g2]>
   - 依赖：<前置步骤>
   - 可并行：<true/false>
   - 类型：<exec/optimize>
   - 可用 skill：<skill 名称列表；没有则 []>
   ...

DAG 结构总结：
- 串行链：<哪些必须逐个做>
- 并行组：<按 tier 列出哪些可以同时做；没有并行组时说明为什么所有步骤都是真依赖链>
- 优化任务：<是否含性能优化>
```

## plan.json Schema

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
      "acceptance_criteria": [
        "<该目标的验收标准>"
      ],
      "outputs": [
        "<该目标的最终产物>"
      ],
      "depends_on": []
    }
  ],
  "status": "pending",
  "created_at": "YYYY-MM-DDTHH-MM-SS",
  "started_at": null,
  "completed_at": null,
  "max_concurrent": 6,
  "runtime": {
    "subagent_isolation": {
      "mode": "worktree",
      "checked_at": "YYYY-MM-DDTHH-MM-SS",
      "reason": "project_git_head_available"
    },
    "remote_resource_decision": {
      "use_remote": false,
      "checked_at": "YYYY-MM-DDTHH-MM-SS",
      "summary": [],
      "reason": "user_chose_local"
    }
  },
  "wiki_context": {
    "found": true,
    "sources": [
      "wiki/projects/<project-slug>/<note>.md",
      "journal/weekly/<week>.md"
    ],
    "reused_knowledge": [
      "<已验证命令/数据路径/指标口径/历史坑点/命名规范>"
    ]
  },
  "context_digest": {
    "found": true,
    "decisions": [
      "<本轮对话已经确认的方案、取舍和用户偏好>"
    ],
    "constraints": [
      "<必须遵守的约束、路径、范围边界>"
    ],
    "acceptance_criteria": [
      "<验收标准和检查方式>"
    ],
    "open_questions": [],
    "post_plan_updates": [
      {
        "at": "YYYY-MM-DDTHH-MM-SS",
        "source": "chat_after_plan",
        "summary": "<plan 生成后新增对话上下文摘要>",
        "decisions": [],
        "constraints": [],
        "acceptance_criteria": [],
        "open_questions": [],
        "artifact": "<可选：长内容写入的 Markdown 路径>"
      }
    ]
  },
  "context_artifacts": [
    "<wiki_dir>/wiki/projects/<project-slug>/context/YYYY-MM-DDTHH-MM-SS-planning-context.md"
  ],
  "steps": [
    {
      "id": 1,
      "goal_id": "g1",
      "tier": 1,
      "name": "<步骤名>",
      "description": "<做什么>",
      "depends_on": [],
      "type": "exec",
      "subagent": "implementer",
      "task_agent": "feature-builder",
      "available_skills": [
        "<本步骤允许或建议 Subagent 使用的 skill 名称；没有则留空数组>"
      ],
      "status": "pending",
      "progress": 0,
      "output": "<产物路径>",
      "inputs": ["<输入文件/上游产物/上下文 artifact>"],
      "outputs": ["<产物路径>"],
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
      "description": "将任务目标、计划、关键证据、产物路径、验证结果、决策和可复用经验归档到 Goo-wiki；除阅读摘要外，必须生成 execution/record.md 详细事实记录和 execution/evidence-index.md 来源覆盖表，小型安全文本证据原样保存，避免模型摘要成为唯一档案；必须补齐任务页、项目入口 <project-slug>.md、log.md、详细记录、证据索引、复用知识页和新增经验页之间的 Wikilink/backlink 关系；Goo-wiki 不可用时写入 .goo/obsidian/ fallback",
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
      "validation": "归档页或 fallback 笔记存在；execution/record.md 与 execution/evidence-index.md 存在，证据索引覆盖 plan、每个 step log、artifacts/reports/context_artifacts 或逐项说明仅索引/不可用/已脱敏；任务页链接项目入口、详细记录、证据索引、复用的 wiki_context/context_artifacts 和关键概念/问题/指标/历史任务页；项目 <project-slug>.md 与 log.md 反向链接任务页；新增 concept/lessons/metrics 页也链接回任务页或项目入口",
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

## 默认 Wiki 归档步骤

所有 plan 默认在 `steps` 末尾追加一个 Wiki 归档任务，除非用户明确禁止归档或配置 `archive.enabled=false`。

- 默认名称：`归档到 Goo-wiki`
- 默认类型：`type: "archive"`
- 依赖关系：依赖所有非归档叶子步骤，确保实现、验证、报告等最终交付完成后再归档
- 输出：Goo-wiki 可用时写入 `Goo-wiki/wiki/projects/<project-slug>/`，不可用时写入 `.goo/obsidian/<project-slug>/`
- 内容：任务目标、plan 摘要、步骤证据、产物路径、验证结果、关键决策、问题处理和可复用经验；摘要之外必须生成 `execution/record.md` 详细事实记录和 `execution/evidence-index.md` 来源覆盖表，小型安全文本证据原样复制到 `execution/evidence/`
- 链接：更新任务页、项目入口 `<project-slug>.md` 和 `log.md` 之间的链接，并把任务页链接到复用的 `wiki_context`、`context_artifacts`、关键概念、问题、指标或历史任务页；新增 concept/lessons/metrics 页面必须链接回任务页或项目入口
- 验收：archive step 不能只检查“文件存在”，也不能只生成模型摘要。必须检查 `execution/record.md`、`execution/evidence-index.md` 和来源覆盖状态，并检查连接关系存在：任务页 → 详细记录/证据索引/项目入口/复用知识/上下文/关键概念，项目入口与 `log.md` → 任务页，新增经验页 → 任务页或项目入口。缺少时保持 `status=running` 或 `failed`，补齐后才可 `completed`
- 强制 Wiki 类型：依赖链中包含论文分析或代码分析时，archive step 还必须验证独立分析正文已写入 Goo-wiki、项目入口和 Goo-wiki `log.md` 已链接；fallback 只记 `pending_wiki_sync`/`failed`
- plan-only 模式只把该步骤写入 `.goo/plan.json`，不实际执行归档；计划摘要和 brainstorm 候选目标要等用户审阅确认后再归档最终版

## 并行优先规划规则

`goo-plan` 生成的是可执行 DAG，不是按叙事顺序排列的线性 TODO。规划时必须先找可并行层，再标注必要串行链。

### 合法依赖

只有以下情况才写 `depends_on`：

- 下游步骤必须读取上游步骤产物、指标、报告或决策。
- 下游步骤必须等待上游验收、人工确认或风险批准。
- 两个步骤会写同一文件、同一目录中的同一类产物、同一远程状态或同一配置，需要避免冲突。
- 资源互斥，例如同一 GPU、同一端口、同一长跑训练槽位或同一发布目标。
- 安全、合规或回滚要求明确规定必须先后执行。

### 非法依赖

以下情况不得单独作为 `depends_on` 理由：

- 用户在自然语言里先说了 A 再说 B。
- Markdown 或 issue 中 A 出现在 B 前面。
- A 和 B 属于同一个 goal，但产物互不依赖。
- A 和 B 使用不同 Role Agent 或 Task Agent。
- 为了“稳妥”“方便检查”“符合习惯”而人为串行。

### Tier 分配

- `tier` 表示执行轮次，同一 `tier` 内的 step 应当可并行派发。
- `depends_on=[]` 且互不冲突的非归档 step 默认都是 `tier=1`。
- 共享准备 step 可以是 `tier=1`；依赖它的多个分支应进入同一个后续 `tier`，不要让分支之间相互依赖。
- 统一验证、审查、发布和归档 step 依赖对应叶子步骤，并使用更高 `tier`。
- 如果某条依赖无法写清具体上游产物、验收结果、确认门槛或冲突资源，就应删除该依赖，并把两个步骤放在同一可并行层。

计划审阅摘要必须列出：

- `并行组`：按 tier 展示可同时执行的 step ID。
- `必要串行链`：只列真实依赖链，并说明依赖原因。
- `并发上限`：使用 `max_concurrent`，默认 6；如果因为资源限制低于 6，说明限制来源。

## Plan-only 模式

`/auto-goo:goo-plan <任务>` 的 wiki 经验召回由 researcher 完成（派发 researcher 采集并回传 evidence packet），任务解析与 DAG 拆解留主模型综合；除 wiki 召回外不派发执行型 Subagent。

输出要求：
- 写入新的 `.goo/plan.json` 或 thread plan 前，先执行现有 plan 冲突检查；只有旧 plan 已完成，或用户明确选择新建 thread/继续当前 thread 并确认替换时，才把旧 plan 原样复制到 `.goo/plans/history/`
- 写入 `.goo/plan.json`
- 写入 `review.status="pending_user_review"`，并先用普通聊天正文展示简洁计划摘要、目标/交付物、DAG 步骤概览、并行组、必要串行链、关键风险和需要用户确认的点
- 计划审阅必须分两步完成：先展示用户可直接阅读的计划概述，再实际调用 `AskUserQuestion` / 结构化选择 UI，选项为 `确认计划`、`修改计划`、`拆分/合并步骤`、`回到 brainstorm`；不得在没有计划概述的情况下直接弹出结构化审阅控件，也不得在未尝试调用 `AskUserQuestion` 时直接输出纯文本编号列表；纯文本编号只作为实际调用失败或按钮未渲染后的 fallback
- 填充 `wiki_context`
- 填充 `goals[]`；单目标任务也写一个默认 goal，多目标任务必须为每个交付目标写清验收标准和产物
- 每个步骤包含 `output`，便于后续恢复和验收
- 每个非归档步骤必须包含 `goal_id` 或 `goal_ids`；共享步骤用 `goal_ids`
- 每个步骤必须包含 `tier`；同一 `tier` 中的步骤应能并行执行，不能把可并行步骤写成逐个依赖的线性链
- 每条 `depends_on` 都必须是合法依赖；仅由叙事顺序或文档顺序造成的依赖必须移除
- 每个步骤应包含 `inputs`、`outputs`、`allowed_read_paths`、`allowed_write_paths`、`validation`、`risk_level` 和 `requires_user_confirm`，让 Subagent 能明确知道输入、输出、读写范围、验收方式和是否需要用户确认
- 每个步骤必须包含合法 `subagent`，明确稳定 Role Agent：`researcher` / `collector` / `implementer` / `optimizer` / `evaluator` / `reviewer` / `auditor` / `recorder`。缺失或不合法时执行阶段先补 plan 或创建新角色，不由主 Agent 代执行
- 每个步骤必须包含合法 `task_agent`，从该 Role Agent 旗下选择细分 Task Agent，例如 `document-analyst`、`feature-builder`、`benchmark-runner`、`code-reviewer`、`evidence-auditor`、`obsidian-recorder`。`task_agent` 用于选择更精确的 agent 文件和提示词，不替代 `subagent` 的调度角色
- 每个步骤应包含 `available_skills` 数组，列出本 step 允许或建议 Subagent 使用的 skill 名称；没有额外 skill 时写 `[]`。该字段只用于上下文裁剪和派发提示，不替代 `subagent` / `task_agent`，不授予额外文件/命令权限，也不要放 agent 名称或项目 reference 路径
- 最后一步包含默认 Wiki 归档任务，依赖所有非归档叶子步骤
- 不修改业务文件，不运行实现命令，不启动优化循环；允许写入 `.goo/plan.json` 和必要的 `context_artifacts`
- 用户确认前不要执行 Wiki 归档任务，也不要把 plan 草案或 brainstorm 草案写成 Goo-wiki/fallback 知识归档

用户确认后，可用 `/auto-goo:goo-start <任务>` 执行完整流程，或从已有 `.goo/plan.json` 继续；此时才归档最终版 brainstorm/plan 摘要。

## 历史 plan 归档

当前 thread plan 是任务状态源，`.goo/plan.json` 是兼容入口。每当 `goo-plan`、`goo-start` 或脚本准备写入新的 thread plan / `.goo/plan.json` 时，必须先判断旧 plan 是否已完成。只有旧 plan 已完成，或用户明确选择新建 thread/继续当前 thread 并确认替换时，才复制归档：

```text
.goo/plans/history/plan-YYYY-MM-DDTHH-MM-SS.json
```

归档规则：

- 只复制，不删除旧归档
- 保留旧 plan 原始内容，便于追溯历史规划
- 如同一秒内多次生成，追加数字后缀避免覆盖
- 归档不是覆盖许可；未完成 plan 仍必须经过 `thread_action` 或等价用户确认
- `/auto-goo:goo-continue` 默认只读取当前 `.goo/plan.json`，不自动恢复历史 plan

### 字段说明

**Plan 级别字段：**

| 字段 | 说明 |
|------|------|
| `task` | 用户任务原文或等价摘要 |
| `status` | Plan 整体状态：`pending`（未开始）→ `running`（执行中）→ `blocked`（等待用户许可或外部条件）→ `completed`（全部完成）/ `failed`（关键失败）/ `paused`（用户暂停） |
| `created_at` | plan 创建时间 |
| `started_at` | plan 开始执行时间，首个步骤派发时设置 |
| `completed_at` | plan 完成时间，所有步骤完成或标记失败时设置 |
| `max_concurrent` | 最大并发槽位数，默认 6 |
| `runtime.subagent_isolation` | 执行启动或恢复时按当前 AutoGoo-Plugin 项目根一次性确定的 Subagent worktree 配置缓存。`mode="worktree"` 表示用户已启用 worktree 隔离，当前项目根本身有可解析 `HEAD`，后续 Agent tool 可传 `isolation: "worktree"`；`mode="none"` 表示用户未启用 worktree，后续派发省略 `isolation`。必须记录 `project_root`，同 thread 恢复时若 `project_root` 与当前项目根一致则直接复用缓存，不再做 Git 检查或再次询问。缓存缺失、`project_root` 不匹配或执行目录明确变更时，用 `AskUserQuestion` 的 `id=git_init_project` 模板询问是否启用 worktree。若 `mode="none"` 省略 `isolation` 后实际派发仍报 `Failed to resolve base branch "HEAD"` / `git rev-parse failed`，写入 `compatibility.agent_requires_git_head=true`，把当前 step 标记 `blocked`/`needs_user_approval`，重新询问是否启用 worktree；不得反复重派或创建 probe agent。用户启用后，只检查当前项目根，不向父目录、跨文件系统或备用路径寻找 Git root；若不是 Git repo，运行 `git init -b main`，不支持 `-b` 时初始化后 `git branch -M main`；若无 `HEAD`，先检查 `git status --short` 和敏感文件风险，安全后 `git add -A` 并提交 `chore: initialize repository for AutoGoo-Plugin worktree isolation`。只有 `HEAD` 可解析后才能写入 `mode="worktree"` 并派发 worktree；启用后仍无 `HEAD` 时标记 blocked，不降级普通派发 |
| `runtime.remote_resource_decision` | 本 thread 对已配置远程服务器的执行位置选择缓存。检测到 `servers[]` 时，先用 `remote-resources.py --probe` 展示 CPU/内存/磁盘/GPU 摘要，再用 `id=remote_resource_usage` 询问用户。用户选择本地时写 `{"use_remote":false,"checked_at":"<iso>","summary":[...],"reason":"user_chose_local"}`；用户选择服务器时写 `{"use_remote":true,"server":"<servers[].name 或 selector>","checked_at":"<iso>","summary":[...],"reason":"user_confirmed_remote"}`，并只把匹配的 step 标为 remote。该字段缺失或用户要求重新选择时，`goo-start` / `goo-continue` 必须重新预检和询问 |
| `goals` | 交付目标列表。单目标任务也写一个默认 goal；多目标任务按 goal 拆验收标准、最终产物和依赖关系 |
| `goals[].id` | goal 稳定 ID，如 `g1` |
| `goals[].status` | goal 状态：`pending` / `running` / `completed` / `failed` / `deferred` |
| `goals[].depends_on` | goal 之间的依赖关系；仅在一个 goal 必须等待另一个 goal 验收后才填写 |
| `wiki_context` | Goo-wiki 经验召回结果。没有找到相关知识时也要写 `{"found": false, "sources": [], "reused_knowledge": []}` |
| `context_digest` | 当前对话中已确认方案的持久摘要。没有额外对话信息时也要写 `{"found": false, "decisions": [], "constraints": [], "acceptance_criteria": [], "open_questions": [], "post_plan_updates": []}` |
| `context_digest.post_plan_updates` | plan 生成后、执行前通过对话产生的增量方案/约束/验收标准。`goo-start` / `goo-continue` 默认同步到这里；长内容用 `artifact` 指向 `context_artifacts` 中的 Markdown |
| `context_artifacts` | 可选。大段方案、会议纪要、prompt 草案或任务 Markdown 的路径列表，优先位于 Goo-wiki 项目路径 `wiki/projects/<project-slug>/context/`；Goo-wiki 不可用时位于 `.goo/obsidian/<project-slug>/context/` |
| `review` | 用户审阅状态。初次 `goo-plan` 生成后写 `{"status": "pending_user_review", "summary": "..."}`；用户确认后改为 `confirmed`；用户要求修改时保持 `pending_user_review` 并记录修改要求 |
| `id` | 全局唯一数字 ID |
| `goal_id` / `goal_ids` | 本步骤服务的目标。单目标 step 用 `goal_id`；共享步骤、统一验证、统一归档用 `goal_ids` |
| `tier` | 执行轮次，同一轮内无依赖、无共享写入冲突且验收互不依赖的步骤必须尽量并行 |
| `name` | 简短动词短语 |
| `description` | 做什么，含完整上下文。必须能脱离聊天记录执行，不使用"按上面方案/参考前文"等隐含引用。需要外部包时末尾标注 `[dep: <包名>]` |
| `depends_on` | 前置步骤 ID 列表，空数组表示无依赖 |
| `type` | `research` / `exec` / `optimize` / `eval` / `review` / `audit` / `archive` |
| `subagent` | 执行该步骤的稳定 Role Agent：`researcher` / `collector` / `implementer` / `optimizer` / `evaluator` / `reviewer` / `auditor` / `recorder`。缺失或不合法时先补 plan 或创建新角色，不由主 Agent 降级代执行 |
| `task_agent` | 执行该步骤的细分 Task Agent，必须来自对应 Role Agent 旗下，例如 `codebase-scout`、`feature-builder`、`test-runner`、`code-reviewer`、`evidence-auditor`、`wiki-curator`。用于选择 agent 文件和 prompt 细节 |
| `output` | 预期产物文件路径，用于恢复时检测是否已完成 |
| `inputs` | 本步骤明确依赖的输入文件、上游产物、wiki/context artifact 或外部资料 |
| `outputs` | 本步骤会产生或更新的产物列表；通常包含 `output`，复杂步骤可列多个 |
| `allowed_read_paths` | Subagent 允许读取的路径边界；缺失时执行前先补 plan |
| `allowed_write_paths` | Subagent 允许写入的路径边界；缺失时执行前先补 plan |
| `validation` | 本步骤完成后的验收方式，可以是命令、文件存在性、人工检查点或指标阈值 |
| `execution_target` | 执行位置，默认 `local`；需要远程服务器时写 `remote` |
| `remote_server` | 远程服务器选择器，仅 `execution_target=remote` 时使用；优先匹配 config `servers[].name`，也可匹配 index、`host`、`host:port`、`user@host` 或 `user@host:port`。计划里优先写名称，避免模型记 IP |
| `remote_reason` | 为什么必须远程执行，例如需要 GPU、远程依赖、长跑环境或用户明确要求 |
| `remote_defaults` | 可选，仅 `execution_target=remote` 时从匹配的 `servers[].defaults` 摘要复制非敏感默认值，例如 `workdir`、`setup_commands[]`、`paths.data_dir`、`paths.artifacts_dir`。远程 step 的 `inputs`、`outputs`、`allowed_read_paths`、`allowed_write_paths` 和 `validation` 应优先引用这些默认路径；不得包含 token、密码、API key、私钥或带凭据的命令 |
| `risk_level` | 风险等级，建议 `low` / `medium` / `high`；涉及覆盖、远程、批量改写、发布等通常不应为 low |
| `requires_user_confirm` | 是否需要用户确认后才能执行；高风险或不可逆步骤必须为 `true` |
| `status` | `pending` → `running` → `blocked` / `completed` / `failed`。主会话派发、检测到权限阻塞或完成时更新 |
| `progress` | 0-100 整数，agent 每次心跳时更新。pending 为 0，completed 为 100 |
| `agent_id` | 执行该步骤的 Agent ID，派发时填写，完成后保留用于审计 |
| `heartbeat_at` | 最后一次心跳时间戳。agent 在每个里程碑更新（启动→读输入→核心过半→产物接近完成→完成，见 execution-engine.md Heartbeat 表），主会话通过此字段判断 agent 是否存活 |
| `started_at` | 步骤开始时间戳 |
| `completed_at` | 步骤完成时间戳 |
| `estimated_time` | 可选，如 "5min" |

### 时间戳格式

统一使用 `YYYY-MM-DDTHH-MM-SS`（例：`2026-05-06T14-30-00`），避免文件名中冒号冲突。

## 依赖与并行判断规则

| 情况 | 策略 |
|------|------|
| `depends_on` 为空且互不引用 | 并行分发 |
| `depends_on` 相同 | 前驱完成后并行 |
| `depends_on` 有传递链 | 按拓扑序串行 |
| 一个步骤的输出是另一个的输入 | 串行（即使忘记标注也要推断） |
| 只读同一输入、写不同产物、验收互不依赖 | 同 tier 并行 |
| 只是文档顺序或自然语言顺序 | 不得串行，除非能说明合法依赖 |

### 执行顺序提取算法

```
1. 找出所有 status=pending 且 depends_on 全部 completed 的步骤 → 当前候选集
2. 按 tier 和共享资源约束分组；同 tier 且无冲突的步骤 → 并行分发
3. 当前候选集内如果存在可并行步骤，不要等待同组其他步骤完成才启动后续空槽
4. 每完成一个步骤，更新 plan.json 中对应步骤的 status，并重新扫描候选集
5. 重复直到所有步骤 completed 或无可执行的 pending 步骤
```

### 步骤状态生命周期

```
pending ──→ running ──→ completed
  │            │
  │            └──→ failed（重试 1 次后仍失败）
  │
  └── 跳过（depends_on 中有 failed 且非关键路径）

心跳保活：running 状态的步骤在 5 个里程碑点更新 heartbeat_at（启动→15→50→85→完成/失败）。
跨会话恢复时如果 heartbeat_at 超过 2 分钟未更新 → 视为僵尸进程，可按产物状态修复或重新派发。正常执行中的失败超时使用 `heartbeat_timeout_min`（默认 15 分钟），不要把 2 分钟恢复阈值当成运行时失败阈值。
```

### 恢复时完成度判断优先级

1. `status = "completed"` → 跳过
2. `status = "running"` 且 `heartbeat_at` 在 2 分钟内 → 等待或跳过（agent 仍在跑）
3. `status = "running"` 且 `heartbeat_at` 超过 2 分钟 → 优先执行 step 的 `validation`，缺少可执行 validation 时再检查 output 文件是否存在
   - validation 通过，或缺少可执行 validation 但产物文件存在且内容完整 → 标记为 completed
   - 产物文件不存在/不完整 → 重置为 pending，重新派发
4. `status = "pending"` 且 depends_on 全部 completed → 正常执行

## Plan 拆分决策

核心原则：**结构复杂、依赖过深或中间需要判断就拆**。大 plan 提供全局 DAG 视图，但执行层面小 plan 更可靠。

### 大 plan vs 小 plan

| | 大 plan | 小 plan |
|---|---------|---------|
| 步数 | 6-20 步 | 2-4 步 |
| 恢复 | 需要 `/auto-goo:goo-continue`、心跳和产物检测兜底 | 当前轮完成并验收，通常无需恢复 |
| 产物传递 | 通过 plan.json + 产物文件路径 | 通过产物文件路径（或内存） |
| 适用场景 | 目标清晰、依赖关系已完全推演、可以一次性画出完整 DAG | 探索性任务、下一步依赖上一步结果才能决定方向 |

### 何时拆

以下任一条件满足，就应该拆成多个小 plan：

1. **步骤数 > 8** — plan 已经超过适合一次调度的规模
2. **DAG 层数 > 3** — 后半段步骤距离当前可执行层太远，恢复和验收成本上升
3. **中间产物是人工判断点** — 比如"先跑个基线看看效果再决定怎么优化"，不要预判结果往下串
4. **后半段步骤依赖前半段产物质量** — 如果 Tier 1 产物可能不合格，Tier 2-3 就是浪费

### 拆分方法

从大 plan 的 DAG 中切出当前可执行的前 1-2 层：

```
大 plan（14 步，7 层）:
  Tier 1: A, B, C ──→  小 plan 1: A, B, C（一次会话跑完）
  Tier 2: D, E, F, G ──→ 小 plan 2: D, E, F, G（拿到 1 的产物后启动）
  Tier 3: H, I ──→  小 plan 3: ...
  ...
```

每个小 plan 结束后：
- 产物文件落地
- plan.json 标记 completed
- 用户验收产物质量
- 启动下一个小 plan

### 何时不拆（用大 plan）

- 任务规模 <= 5 步，且 DAG 层数 <= 3
- 依赖链虽然较长，但每步都有明确产物、自动验收方式和低风险读写边界
- 用户明确要求"一次性全自动执行，不要中断问我"

### 大 plan 的安全网

如果必须用大 plan（跨会话），依赖三重恢复机制：
- `status` 字段追踪每步完成状态
- `heartbeat_at` 区分僵尸/存活 agent
- `validation` 优先的恢复检测；缺少可执行 validation 时再用 `output` 产物存在性兜底检测

# AutoGoo-Plugin 项目级智能体规范

## 项目目标

AutoGoo-Plugin 是面向 Claude Code / Codex 工作流的自动化智能体编排框架。它的目标不是替用户多写一层流程文档，而是把复杂任务稳定拆成可执行、可恢复、可验证、可归档的工作单元，并让主 Agent、Subagent、Goo-wiki 和 `.goo/plan.json` 形成闭环。

AutoGoo-Plugin 的核心交付包括：
- 将用户任务解析为带依赖关系的 DAG，而不是临场凭记忆推进。
- 通过主 Agent 总控和 Subagent 分工，实现可并行的步骤并行执行、有关联的步骤按依赖交接。
- 用 `.goo/plan.json` 作为当前任务唯一状态源，记录进度、心跳、失败、产物和恢复信息。
- 在任务开始前召回 Goo-wiki 中的项目经验，在任务完成后归档新的决策、证据、产物路径和复用经验。
- 对优化类任务建立指标、基线、对比和停止条件，避免无指标的“感觉优化”。
- 将重复流程脚本化，将长规范放入 `skills/auto-goo/references/`，控制主会话上下文消耗。

## 总体原则

- **先召回，再计划**：启动多步任务前先查 Goo-wiki / 项目上下文，复用已有路径、命令、约束、失败经验和指标口径。
- **先计划，再执行**：多步任务必须先生成或更新 `.goo/plan.json`；单步任务可以直接做，但不能假装已经完成 AutoGoo-Plugin 流程。
- **主 Agent 总控，Subagent 执行**：主 Agent 负责目标、拆解、调度、验收和冲突处理；Subagent 只执行被分配的 step，不扩大范围。
- **能并行就并行**：无依赖的步骤应进入就绪队列并行调度；有依赖的步骤必须通过产物和状态交接。
- **状态写回 plan**：步骤开始、进度、心跳、完成、失败、重试和恢复判断都必须回写当前 `.goo/plan.json`。
- **执行必留痕**：关键命令、输入、输出、产物路径、验证结果、失败原因和用户决策都要能在 `.goo/logs/`、plan 或 Goo-wiki 中追溯。
- **HTML 可发布**：完整工作流应能通过 `/auto-goo:goo-publish` 生成 `.goo/site/` 多页面站点，分开展示 activity、brainstorm、plan、任务流程图、DAG、运行状态和产物索引。
- **优化必有指标**：性能、效率、质量、准确率、成本等优化任务必须先定义指标和基线，再做改动和对比。
- **归档不是收尾作文**：Goo-wiki 是启动时的记忆层，也是完成后的知识层；归档要记录可复用结论，而不是复制聊天流水。
- **内容输出必须归档**：除纯状态查看、纯初始化配置或用户明确要求不归档外，任何产生可复用内容的命令最终都必须写入 Goo-wiki 或 `.goo/obsidian/` fallback；不得只写 `.goo/*.json` 或只在聊天中展示。`goo-brainstorm` 和 `goo-plan` 先写本地草案并等待用户审阅，确认后或执行前再归档最终候选目标、plan 摘要和关键取舍。
- **脚本优先，文档同步**：可重复操作优先沉淀到脚本；命令、README、SKILL、reference、示例和校验脚本必须保持一致。

## 工作边界

AutoGoo-Plugin 应覆盖：
- 复杂编码、数据处理、调研、评测、优化、迁移、报告和多阶段交付任务。
- 需要跨会话恢复、并行执行、远程服务器、Goo-wiki 归档或明确验收标准的任务。
- Markdown 任务包、issue/PR 描述、计划文档、日志片段等结构化输入的解析和执行。

AutoGoo-Plugin 不应强行覆盖：
- 单条命令、简单问答、很小的文本改写、一次性文件查看等无须 DAG 的任务。
- 用户明确要求只讨论方案、只写文档草稿、只做人工解释而不执行的场景。
- 没有用户授权的高风险动作，如删除、覆盖配置、远程写入、默认分支发布等。

## 核心工作流

完整流程定义在 `skills/auto-goo/SKILL.md`。该文件是技能触发、阶段入口、命令模式和关键铁律的主入口；长规则放在 `skills/auto-goo/references/`。

标准阶段：
1. **初始化**：通过 `/auto-goo:goo-init` 写入用户级或项目级配置，明确 wiki 路径、项目归档根、远程服务器和是否更新项目 `CLAUDE.md`。
2. **Wiki 召回**：解析配置优先级，检索 Goo-wiki 项目页、概念页、周报和日志，形成 `wiki_context`。
3. **任务解析**：识别输入形态、交付物、约束、验收标准和依赖关系，写入 `.goo/plan.json`。
4. **执行调度**：按 DAG、槽位、心跳和依赖状态派发 Subagent，实时更新 plan。
5. **优化迭代**：对 `type: "optimize"` 的步骤执行指标搜索、基线、瓶颈分析、优化对比和停止判断。
6. **归档沉淀**：将目标、计划、关键证据、产物、验证结果、决策和复用经验写入 Goo-wiki 或 `.goo/obsidian/` fallback。
7. **HTML 发布**：需要项目主页或可浏览记录时，用 `goo-publish.py` 从 `.goo/` 只读生成 `.goo/site/` 多页面站点；它是展示层，不替代 Goo-wiki 归档。
8. **自改进**：任务后记录流程问题；高频问题经用户确认后更新对应规范、脚本或 allowlist。

内容输出类命令即使不进入完整执行 DAG，也必须完成归档沉淀。`goo-usage-analyse`、`goo-daily-report`、`goo-improve`、`goo-benchmark` 等只要产出可复用判断、报告、指标、规则或经验，就要写入 Goo-wiki 项目路径并更新项目入口或 `log.md`；Goo-wiki 不可用时写入 `.goo/obsidian/<project-slug>/` fallback，并在对应 `.goo/*.json` 产物记录 `archive` 字段。`goo-brainstorm` 和 `goo-plan` 例外：先写本地草案并让用户审阅，用户可能会修改候选目标或 DAG；确认后或进入执行前，再归档最终版候选目标、计划摘要和关键取舍。

论文分析和代码分析是强制 Goo-wiki 归档类型：只要任务产出论文解读、论文深读笔记、代码库结构分析、调用链/数据流分析、架构分析或代码调研报告，就必须把分析文档写入 Goo-wiki 项目归档根并更新项目入口和 `log.md`；不得只保存在 `.goo/`、Subagent 日志、聊天回复或本地 fallback。Goo-wiki 暂时不可写时可先写 `.goo/obsidian/` 防止信息丢失，但任务归档状态保持 `pending_wiki_sync` 或 `failed`，同步到 Goo-wiki 前不得宣称归档完成。

## 状态与产物规范

- 当前任务唯一状态源是 `.goo/plan.json`。不得用历史 plan、聊天记忆或临时笔记替代当前 plan。
- 覆盖 `.goo/plan.json` 前必须把旧 plan 归档到 `.goo/plans/history/plan-<timestamp>.json`。
- 每个 step 至少要写清 `id`、`name`、`description`、`depends_on`、`type`、`subagent`、`available_skills`、`status`，执行中维护 `progress`、`heartbeat_at`、`started_at`、`completed_at`、`agent_id`。
- step 描述必须包含输入、边界、输出和验收点，确保执行者不依赖主会话隐含上下文。
- 长对话方案、取舍原因、用户偏好和验收标准必须固化到 `context_digest` 或 `context_artifacts`。
- 产物默认放在 `.goo/artifacts/`、任务指定输出路径或 plan 明确记录的位置；日志默认放在 `.goo/logs/`。
- `/auto-goo:goo-status` 应读取 plan 渲染状态，不凭感觉汇报进度。
- `/auto-goo:goo-publish` 应读取 `.goo/` 渲染静态 HTML，不修改 plan、brainstorm、logs 或 Goo-wiki 正文。

## Subagent 规范

- 合法角色包括 `researcher`、`implementer`、`optimizer`、`evaluator`、`reviewer`、`auditor`、`recorder`。
- 派发给 Subagent 的上下文只包含当前 step、`available_skills`、必要项目约束、相关 wiki 摘要、上游产物路径、允许读写边界和回写要求。
- Subagent 不接收完整聊天记录，不自行修改全局目标，不替主 Agent 做范围扩张决策。
- Subagent 完成后必须返回产物路径、验证结果、失败原因或待决问题；主 Agent 负责集成和最终验收。
- 如果 step 缺少必要上下文、允许路径或合法角色，先补 plan 或 context artifact，再派发。

## 安全约束

- 删除任何文件或目录前必须先征得用户明确同意，包括临时文件、缓存、`.goo/` 产物、远程目录和看似可再生成的内容。
- 不运行 `git reset --hard`、`git checkout -- <path>`、`git clean`、强推、删除分支、改写历史等破坏性 Git 命令，除非用户明确要求该具体操作。
- 不回退、不覆盖与当前任务无关的脏改动；相关文件出现预期外变化时，先重新判断上下文。
- 覆盖配置、批量重生成、移动覆盖、替换用户手写内容、修改 `.claude/settings*.json`、`.goo/config.json` 或项目 `CLAUDE.md` 前，必须说明影响并取得确认或明确参数。
- 敏感信息只读不显。不得输出、复制、记录 token、password、API key、SSH private key、`secrets.json` 明文内容。
- 远程服务器、网络下载、依赖安装、后台服务、端口监听、批量数据改写、跨机器同步等操作必须写清作用域、路径和产物；涉及外部写入或不可逆成本时先确认。
- 发布到默认分支前必须单独确认发布范围；推送前检查本地领先提交，避免把无关提交一起发布。

## 文档与代码同步要求

AutoGoo-Plugin 的行为不能只改一处。涉及命令、计划 schema、配置、归档、状态、usage、远程服务器或 Subagent 契约时，按影响同步检查：
- `README.md`
- `commands/*.md`
- `skills/auto-goo/SKILL.md`
- `skills/auto-goo/references/*.md`
- `skills/auto-goo/templates/*.json`
- `skills/auto-goo/templates/publish/*.html`
- `skills/auto-goo/examples/*.md`
- `skills/auto-goo/scripts/*`
- `skills/auto-goo/scripts/check-plugin.sh`
- `.claude-plugin/marketplace.json` 或插件注册信息

### 版本号约定（每次提交必做）

**每次提交都必须 bump 版本号。** `package.json` 的 `version` 是**单一事实源**，其余 7 个位置必须与它一致：

- `.pi/extensions/autogoo-plugin/package.json`
- `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`
- `.codex-plugin/plugin.json`
- `skills/auto-goo/SKILL.md`（frontmatter `version:`）
- `README.md`（badge + 「当前版本」两处）
- `.pi/extensions/autogoo-plugin/index.ts`（文件头注释 + 启动 banner）

不要手改，用脚本一次改全并在提交前校验：

```bash
python3 skills/auto-goo/scripts/bump-version.py --patch   # 修 bug
python3 skills/auto-goo/scripts/bump-version.py --minor   # 新增功能
python3 skills/auto-goo/scripts/bump-version.py --major   # 破坏性变更
python3 skills/auto-goo/scripts/bump-version.py --check   # 只校验一致性
```

约束：
- `tests/test_platform_integrity.py` 必须从 `package.json` 推导期望版本，**不得硬编码具体版本号**（否则每次 bump 都要改测试）。
- `check-plugin.sh` 第 14 节会校验全位置一致性与脚本覆盖完整度，提交前必须全绿。
- 历史叙述/示例里出现的旧版本号不属于版本字段，不要为了“统一”去改它们；如果会随版本漂移，就把数字泛化掉。

改动后优先运行结构校验脚本。脚本路径必须先通过 Claude Code 的 installed plugin `installPath` 解析；如果该路径不存在，再检查 `settings.json` 中是否启用了本地 directory marketplace，并使用该 marketplace 路径。不要在 `CLAUDE.md` 中写展开后的路径解析代码或本机绝对路径。

## 参考入口

- `skills/auto-goo/SKILL.md`：完整工作流、命令模式和关键执行铁律。
- `skills/auto-goo/references/setup.md`：配置、Goo-wiki 路径和 SessionStart hook 建议。
- `skills/auto-goo/references/task-parsing.md`：Markdown 输入解析、DAG、plan schema 和拆分规则。
- `skills/auto-goo/references/execution-engine.md`：调度、Subagent prompt、日志、错误处理和心跳。
- `skills/auto-goo/references/optimization-loop.md`：指标、基线、评测和优化停止条件。
- `skills/auto-goo/references/obsidian-archive.md`：Goo-wiki 归档、wikilink、项目 index/log 维护。
- `skills/auto-goo/references/self-improvement.md`：流程问题采集、自改进触发和修改决策。
- `skills/auto-goo/references/python-standards.md`：Python 实现规范。

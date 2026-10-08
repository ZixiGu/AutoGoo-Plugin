<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN -->
## AutoGoo-Plugin / Goo-wiki 归档原则

- 本项目启用 Goo-wiki 作为项目记忆层；规划前先检索 `{{WIKI_DIR}}` 中相关项目页、概念页、周报和 `log.md`，复用已有约束、命令、路径、指标口径和历史经验。
- 使用 `/auto-goo:goo-plan` 生成计划时，必须在当前 thread plan 最后保留 `归档到 Goo-wiki` 步骤，并依赖所有非归档叶子步骤；计划必须包含 `thread`、`wiki_context` 和 `context_digest`，让后续执行不依赖主会话聊天记录。
- 如果当前对话已经形成方案、取舍、约束或验收标准，短内容写入当前 thread plan 的 `context_digest`；长方案、会议纪要或 prompt 草案优先写入 `Goo-wiki/{{PROJECT_ARCHIVE_DIR}}/context/`，并在当前 thread plan 的 `context_artifacts` 中引用。
- 如果当前 thread plan 已生成后又通过对话产生新方案、约束、验收标准或用户偏好，`/auto-goo:goo-start` 和 `/auto-goo:goo-continue` 默认先做 context sync：把旧 plan 复制到 `.goo/plans/history/`，短内容写入 `context_digest.post_plan_updates`，长内容写入 `context_artifacts` 指向的 Markdown；只有与原 plan 冲突、扩大范围、改变验收标准或涉及危险操作时才询问用户确认。
- 使用 `/auto-goo:goo-start` 或 `/auto-goo:goo-continue` 执行时，只能基于当前 thread plan、`context_artifacts` 指向的 Goo-wiki/Markdown、相关 `wiki_context`、当前 thread logs 和上游产物路径恢复任务；不得依赖“刚才讨论过”的隐含上下文。
- 使用 `/auto-goo:goo-start` 或 `/auto-goo:goo-continue` 执行时，所有 `research` / `exec` / `optimize` / `eval` / `review` / `audit` / `archive` step 必须派发给当前 thread plan 中声明的 `subagent`；主 Agent 只负责编排、状态修复、上下文补全和产物审核，不直接代写步骤产物或代跑步骤命令。
- 如果待执行 step 缺少 `subagent`、`depends_on`、`output`、读写边界或必要上下文，先更新当前 thread plan / `context_artifacts` 后再派发，不用主会话聊天记录临时补齐。
- 使用 `/auto-goo:goo-start` 或 `/auto-goo:goo-continue` 执行后，必须归档任务目标、计划摘要、步骤证据、产物路径、验证结果、关键决策、问题处理和可复用经验。
- 任何产生可复用内容的命令最终都必须归档到 Goo-wiki 或 `.goo/obsidian/` fallback；不得只写 `.goo/*.json` 或只在聊天中展示。brainstorm 候选目标和 plan 摘要必须先给用户审阅，确认后或进入执行前再归档最终版；usage/token 降本分析、日报/周报、改进建议、benchmark 指标和执行经验按命令规则归档。
- 用户要求日报、周报、总结今天或调用 `/auto-goo:goo-daily-report` 时，必须把 Claude Code / Codex 会话沉淀到 Goo-wiki `journal/daily/`，并更新 `log.md`；同日日报已存在时只追加新增内容，不整体覆盖已有人工整理。
- Goo-wiki 可用时优先写入 `{{WIKI_DIR}}/{{PROJECT_ARCHIVE_DIR}}/` 并追加 `Goo-wiki/log.md`；不可用时写入 `{{FALLBACK_PROJECT_DIR}}` 作为本地 fallback。
- 模型摘要只作阅读入口；最终任务归档还必须生成 `execution/record.md` 详细事实记录和 `execution/evidence-index.md` 来源覆盖表。先枚举当前 thread plan、全部 step logs、artifacts、reports 和 context artifacts；小型安全文本证据原样保留，大型/二进制产物记录路径、大小和可取得时的校验值；每项来源必须标记已收录、仅索引、不可用或已脱敏，不得静默遗漏失败、重试和未验证项。
- 论文解读/深读以及代码库结构、调用链、数据流、架构、实现模式分析必须生成独立 Markdown 分析文档并实际写入 Goo-wiki，同时更新项目入口和 Goo-wiki `log.md`。`.goo/`、step log、聊天回复或 `.goo/obsidian/` fallback 都不能作为最终归档；Goo-wiki 不可写时 fallback 只作临时防丢失，状态保持 `pending_wiki_sync` 或 `failed`。
- 归档完成前必须补齐并验收 Markdown 连接图谱：任务页链接项目入口、复用的 `wiki_context` / `context_artifacts` 和关键概念/问题/指标/历史任务页；项目 `<project-slug>.md` 与 `log.md` 反向链接任务页；新增 concept/lessons/metrics 页面链接回任务页或项目入口。缺少这些链接时不得把 archive step 标记为 completed。
- 不把归档当作事后报告；归档内容要能支撑下一次任务的召回、规划和复用。

## 用户级默认约定

- 本文件是 AutoGoo-Plugin 的**用户级默认约定**，对所有项目生效。
- 约定正文优先级：项目根 `goo.md`（若存在）> 用户级 `~/.auto-goo/goo.md`；项目级约定覆盖用户级约定。
- 用户级配置位于 `{{CONFIG_DISPLAY}}`；重新生成本文件请运行 `{{INIT_HINT}}`。
- 用户级指针写入 `~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md` 的 `AUTOGOO-PLUGIN-POINTER` marker 段。
- 项目级初始化请运行 `/auto-goo:goo-init --project`。
<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-END -->

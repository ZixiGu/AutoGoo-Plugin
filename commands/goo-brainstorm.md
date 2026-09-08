---
name: auto-goo:goo-brainstorm
description: 基于 Goo-wiki 和当前项目上下文 brainstorm 候选 goals，不生成执行 DAG
---

# /auto-goo:goo-brainstorm — 先找目标，再计划

当用户还不知道明确目标，只想基于 Goo-wiki、项目历史或当前方向找下一步时，使用：

```text
/auto-goo:goo-brainstorm <方向/项目/问题>
```

## 行为

1. **Wiki 经验召回（collector/wiki-gatherer）** — 派发 `collector`（wiki-gatherer）Subagent 按 AutoGoo-Plugin 配置优先级解析 Goo-wiki，用 `wiki-graph-assist.py` 生成紧凑 wiki graph packet，检索项目页、概念页、周报和 `log.md`。主模型不亲自 Read/Grep 全量 wiki。
2. **信号提取（主模型）** — 主模型基于 collector 返回的 wiki packet 提取未完成事项、反复问题、风险、近期计划、指标缺口、文档缺口、测试缺口、发布阻塞和可复用经验。
3. **前置条件识别** — 主模型基于 collector 返回的 wiki evidence packet 提炼所有候选目标共同需要的资源、权限、数据、环境、指标、人工决策和安全确认。
4. **多轴发散** — 至少从 5 个不同角度探索候选方向：快速交付、长期架构、风险/债务、验证/评测、文档/知识沉淀、自动化/工具化、用户体验/流程改进、低成本试探。不要只围绕同一个方案改措辞；允许保留 1-2 个高风险高收益选项，但必须标清风险和前置条件。
5. **候选目标生成** — 生成 5-9 个初始候选 goals，再合并为 3-7 个最终候选。每个 goal 都要有依据、产物、验收标准、风险、第一步、前置要求和 ready checklist。
6. **自我检查与修订** — 用户审阅前先自检候选集：去掉重复或只换说法的 goal；补齐没有 wiki/上下文依据的证据说明；确认每个 goal 有明确产物和验收方式；校准风险、成本、依赖和不确定性；检查候选集是否覆盖 quick win、基础设施/债务、探索验证和长期价值。自检后必须记录删改原因和最终保留理由。
7. **推荐排序** — 基于自检后的候选集给出 `recommended_goal_ids` 和排序理由，不用未经自检的初始候选直接推荐。
8. **Thread 归属检查** — 如果当前 thread/plan 未完成，先用 `AskUserQuestion` 复用 `id=thread_action` 模板询问新建 thread、继续当前 thread 或取消；用户未明确选择前不得覆盖当前 brainstorm。
9. **本地落盘** — 写入当前 thread 的 `.goo/threads/<thread_id>/brainstorm.json`，同时兼容写入 `.goo/brainstorm.json`；标记为待用户审阅。
10. **等待用户审阅** — 展示候选 goals、推荐顺序、共同前置条件、自检摘要和关键风险，让用户选择、合并、改写或要求继续 brainstorm。必须优先用 `AskUserQuestion` / 结构化选择 UI 展示候选 goal 的 ID/编号和动作选项；不得在交互控件可用时只用普通文本要求用户手打回复。
11. **确认后归档（recorder）** — 用户确认候选目标后，派发 `recorder` Subagent 撰写最终版本、选择依据、共同前置条件、自检摘要和关键 wiki 证据的归档正文，写入 Goo-wiki 项目路径并更新项目入口或 `log.md`；Goo-wiki 不可用时写入 `.goo/obsidian/<project-slug>/` fallback。主模型只决定归档内容和目标路径，不亲自撰写归档正文。不要在用户还可能修改候选目标时急着归档。

如果当前 thread 的 `brainstorm.json` 已存在，写入新的 brainstorm 前，先把旧文件原样复制到 `.goo/brainstorms/history/brainstorm-<timestamp>.json`。该目录是本地 JSON 历史快照，和 Goo-wiki/fallback 知识归档不同；知识归档仍写入同一任务归档根的 `brainstorm/` 子目录。

## 输出要求

`.goo/brainstorm.json` 必须包含：

- `task`：用户给出的方向、项目或问题。
- `thread`：包含 `id`、`brainstorm_path`、`plan_path`、`logs_dir`；后续从 brainstorm 生成 plan 时必须校验同一 thread。
- `status: "pending_decision"`。
- `wiki_context.sources` 和 `wiki_context.signals`。
- `global_prerequisites[]`：开始任何候选 goal 前共同需要确认的条件，例如数据路径、账号权限、远程资源、评价指标、用户取舍、安全确认。
- `divergence_axes[]`：本次实际覆盖的发散角度，每项包含 `axis`、`signals`、`candidate_goal_ids`。
- `candidate_goals[]`，每项包含：
  - `id`
  - `name`
  - `why`
  - `expected_output`
  - `acceptance_criteria`
  - `evidence`
  - `risk`
  - `prerequisites`
  - `readiness_checklist`
  - `first_step`
  - `priority_hint`
- `self_check`：用户审阅前的自检结果，至少包含：
  - `coverage`：候选集覆盖了哪些发散角度，以及缺口说明。
  - `deduped_or_merged[]`：被删除、合并或改写的初始候选及原因。
  - `evidence_gaps[]`：证据不足但仍保留的候选，以及为什么值得保留。
  - `risk_calibration[]`：高风险、高成本或依赖外部资源的候选及处理建议。
  - `recommendation_rationale`：为什么当前排序合理，尤其是推荐目标相对其他目标的取舍。
- `recommended_goal_ids`
- `decision_needed: true`
- `review`：写 `{"status": "pending_user_review", "summary": "<给用户看的简短摘要>"}`；用户确认后改为 `confirmed`，用户要求修改时保持 `pending_user_review` 并记录修改要求。
- `next_action`：用户明确一个或多个 goals 后，调用 `/auto-goo:goo-plan <明确目标>`
- `archive`：归档目标、任务页路径或 fallback 路径、是否更新 `log.md`，以及 `status`。初次 brainstorm 生成后默认写 `{"status": "pending_user_review", ...}`，不要写成 `completed`。用户确认最终候选目标后再归档；如果暂时无法归档，写明 `status: "pending"` 或 `status: "failed"` 和原因，后续 `/auto-goo:goo-start` / `/auto-goo:goo-continue` 在执行 plan 前必须先补归档。
  - 默认归档到同一任务归档根的 `brainstorm/` 子目录，例如 `wiki/projects/<project-slug>/tasks/<YYYY-MM-DDTHH-MM-SS-task-slug>/brainstorm/`。
  - `archive.task_archive_root` 记录任务归档根；后续由该 brainstorm 生成的 `.goo/plan.json.archive.task_archive_root` 必须复用同一目录，并把正式计划写入 `plan/` 子目录。
  - fallback 时使用 `.goo/obsidian/<project-slug>/tasks/<task-slug>/brainstorm/`，并同样保留 `task_archive_root`。
  - 本地历史快照另存到 `.goo/brainstorms/history/`，不要和 Goo-wiki/fallback 归档路径混用。

## 审阅提问格式

展示候选目标后，必须优先用 `AskUserQuestion` / 结构化选择 UI 收尾，并复用 `skills/auto-goo/references/interaction-templates.md` 中 `id=brainstorm_review` 的 JSON 模板。动态 `<goal_id>` 必须替换为本次推荐候选的真实 ID；其他 goal、合并列表和修改要求通过 Other 输入，输入后必须校验或复述确认。选项至少包含：

- 选择推荐目标 `<goal_id>`
- 选择其他目标
- 合并多个目标
- 修改候选目标
- 继续 brainstorm

仅当交互控件不可用时，才使用纯文本 fallback：

```text
请选择下一步：
1. 选择推荐目标 <goal_id>
2. 选择其他目标（回复 goal ID，例如 g2）
3. 合并多个目标（回复例如：合并 g1,g3）
4. 修改候选目标（回复：修改: <你的要求>）
5. 继续 brainstorm

这是 fallback；也可以直接回复 goal ID、编号或上面的动作文本。
```

如果候选 goal 已经有稳定 `id`，优先展示和接受 `id`；没有时使用本次消息中的编号，并在写回 `.goo/brainstorm.json.review` 时记录用户选择来源。

### checklist 规则

- `prerequisites` 写“开工前必须具备什么”，例如数据、权限、配置、算力、依赖、指标定义、用户决策。
- `readiness_checklist` 写可逐项勾选的问题，使用短句，并尽量能通过文件、命令、wiki 页面或用户确认验证。
- 如果某个前置条件缺失但不阻塞 brainstorm，把它写入对应候选 goal 的 `risk` 和 `readiness_checklist`，不要假装已经满足。

## 边界

- 不写 `.goo/plan.json`。
- 不跨 thread 读取候选 goal；从 brainstorm 生成 plan 时，`plan.thread.id` 必须等于 `brainstorm.thread.id`，`archive.task_archive_root` 也必须一致。
- 不生成执行 DAG。
- 不派发 Subagent 执行。
- 不修改业务文件；用户确认前只允许写 `.goo/brainstorm.json`，不要写 Goo-wiki/fallback 归档笔记。
- 不运行实现、评测、训练、安装、远程或删除命令。

用户选定一个或多个 goals 后，再进入：

```text
/auto-goo:goo-plan <明确后的 goal 或 goal 列表>
```

# plan.json schema 版本化、迁移与 checkpoint

`.goo/plan.json`（以及 `.goo/threads/<id>/plan.json`）是 AutoGoo-Plugin 的唯一状态源。
本文件记录它的 **schema 版本演进**、**迁移/回滚机制**，以及让 `--resume` / 自动重试
幂等的 **step 级 checkpoint 台账**。

实现入口：`skills/auto-goo/scripts/plan_schema.py`（版本/迁移/演练）与
`skills/auto-goo/scripts/checkpoint.py`（副作用台账）。两者都只用标准库。

---

## 1. 为什么需要 schema_version

0.27.0（commit `c7524eb`，2026-11-11 02:51:08Z）把 `memory_layer` 的编号方向**整体反转**：

| 版本 | L0 | L1 | L2 | L3 |
| --- | --- | --- | --- | --- |
| **≤ 0.26.x（旧语义）** | 原始日志 | 原子事实 | 场景知识 | 项目总览 |
| **≥ 0.27.0（新语义）** | 项目总览 | 场景知识 | 原子事实 | 原始日志 |

plan.json 原来没有任何版本字段。结果是：0.27.0 之前写的 plan 里 `"memory_layer": "L0"`
（意思是「原始日志」）会被 0.27.0 之后的所有读取方当成「项目总览」——
**语义完全相反，且没有任何机制能发现**。这是本项目反复记录的静默失效模式
（参见 `references/setup.md`「记忆分层判定标准」与 SKILL.md 的层级说明）。

同一个问题还有两个变体，一并纳入 durable execution：

- `--resume` 只把 status 改回 `running`，Subagent 从头重跑，已经产生的**外部副作用**
  （改过的文件、发过的请求、跑过的迁移）会被重复施加。
- `MAX_RETRIES=1` 的自动重试（`failed → pending`）同样没有幂等保护。

---

## 2. 版本表

`schema_version` 是 plan 的**顶层整数**。判定与迁移的唯一事实源是
`plan_schema.CURRENT_SCHEMA_VERSION` 和 `SCHEMA_VERSIONS`。

| version | name | memory_layer 编号 | 说明 |
| --- | --- | --- | --- |
| `1` | `legacy-unsigned` | **旧**（L0=原始日志） | 无 `schema_version` 字段；0.27.0 之前写入 |
| `2` | `memory-layer-modern` | **新**（L0=项目总览） | 0.27.0~0.30.x 写入，仍**没有** `schema_version` 字段 |
| `3` | `durable-checkpoints` | 新 | 当前版本：顶层 `schema_version` + step 级 `checkpoints` / `resume_state` / `idempotency` |

> v1 和 v2 在文件上无法区分（都没有版本字段）。读取时必须**按证据推断**并把结论
> 写进迁移记录，禁止直接假定新语义。

---

## 3. 加载规则：不静默

`plan_schema.load_plan(path, mode=...)` 是所有写入路径的统一入口
（`update-step.py` 已改用它加载 plan）。

| 情况 | 行为 |
| --- | --- |
| `schema_version == CURRENT` | 正常运行 |
| `schema_version > CURRENT` | **拒绝**（`PlanTooNew`）：提示升级插件，并警告不要手改版本号降级 |
| 旧/无版本 | 迁移链补齐；`mode="read"` 只在内存里迁移、绝不写盘；`mode="write"` 先**备份**再写盘并打印迁移结论 |
| 旧/无版本 + `AUTOGOO_PLAN_AUTOMIGRATE=0` | **拒绝**（`PlanNeedsMigration`），输出完整命令清单（status → drill → migrate --dry-run → migrate → revert） |

写盘前备份固定落在 `.goo/plans/history/`（尊重 `workspace.paths.plans_history_dir`），
文件名形如 `plan-<stamp>-pre-schema-v<old>.json`。**历史 plan 只增不删。**

迁移记录写进 plan 顶层的 `schema_migrations`（数组），每条包含
`from` / `to` / `at` / `by` / `change` / `reason` / `assumed_semantics` / `confidence` /
`evidence` / `flipped_count` / `text_mentions_needing_review` / `reversible` / `origin`。
复核时看这里，而不是猜。

---

## 4. 无版本 plan 的语义判定顺序

`plan_schema.infer_semantics()`，置信度从高到低：

1. **declared** —— plan 自带 `memory_layer_semantics: legacy|modern`
2. **assumed** —— 调用方显式 `--assume-semantics legacy|modern`（会记进 evidence）
3. **content** —— 文案特征计数：
   - 旧语义特征：`L0(原始`、`L0=原始`、`L0 原始`、`L3(项目`、`L3=项目`、`L3 项目总览`、`L3 项目`
   - 新语义特征：`L0(项目`、`L0=项目`、`L0 项目总览`、`L0 项目入口`、`L3(原始`、`L3=原始`、`L3 原始`
   - 判据是「L0 与原始日志 / L3 与项目总览是否捆在一起」：旧编号下二者绑定，
     新编号下正好相反。因此这个词表本身不会因词表改名而失效。
4. **timestamp** —— `created_at`（其次 `thread.created_at` / `started_at` / `updated_at`）
   与 `0.27.0` 翻转时点 `2026-11-11T02:51:08Z` 比较
5. **mtime** —— 文件 mtime 与同一时点比较
6. **default** —— 全无证据时**保守判为 legacy**（旧语义），并在迁移记录标
   `review_recommended: true`，提示人工复核

判定结果一定随迁移记录落盘，不存在「悄悄按新语义解释」的路径。

---

## 5. 迁移链

```
v1 (legacy)  --翻转层号-->  v2 (modern)  --加 durable 骨架-->  v3 (current)
```

### v1 → v2：memory_layer 编号反转

- 只翻转**结构化字段**（`memory_layer`、`memory_layers`、`wiki_layers`、
  `memory_layer_default`），映射 `L0↔L3`、`L1↔L2`（自逆）。
- **不机械改自由文本**。描述里的层号可能绑定上下文（如「L2/L3 引导」），
  替换会改坏语义；这些命中改记进 `text_mentions_needing_review`，由人或模型复核。
- 写入 `memory_layer_semantics: "modern"`，让后续读取不再依赖推断。

### v2 → v3：durable execution 骨架（纯增量）

- 顶层写 `schema_version: 3`
- 每个 step 补 `checkpoints: []` 与 `checkpoint_seq: 0`
- 不改任何既有字段的语义，所以对老 plan 是安全空操作

---

## 6. 回滚（可逆性）

`revert --to <version>` 施加与迁移**完全相反**的编辑：

| 回滚 | 做什么 |
| --- | --- |
| v3 → v2 | 删除 step 上的 `checkpoints` / `checkpoint_seq` / `resume_state` / `idempotency` |
| v2 → v1 | 层号翻转回来 + 删除 `memory_layer_semantics` |
| 回到原版本 | 若原本就没有 `schema_version`（`origin.explicit == false`），连 `schema_version` 和 `schema_migrations` 一起删除，复现原始内容 |

**保护措施**：v3 里已有非空 `checkpoints` / `resume_state` / `idempotency` 时，
回滚会 `PlanRevertBlocked` 并要求先归档或显式 `--drop-durable-data`，
避免「回滚顺手抹掉执行证据」。

**演练（drill）**就是把迁移链跑一遍并断言可逆性：

```bash
# 对真实历史 plan 演练（只读，不改原文件）
python3 skills/auto-goo/scripts/plan_schema.py drill --root .
# 报告写到 .goo/plans/migrations/drill-<stamp>.{json,md}
```

报告断言：`migrate → revert` 后与原文件**逐字段相等**（`roundtrip_ok`），
并列出每份 plan 的判定版本、层号语义、证据、翻转字段数、待复核文案数。
至少覆盖 3 个历史 thread，否则 drill 退出码非 0。

---

## 7. step 级 checkpoint：resume 与重试的幂等

### 7.1 记录

```bash
# 写完一个文件后立刻登记（记录 sha256）
python3 skills/auto-goo/scripts/update-step.py --step-id 1 \
  --checkpoint-file skills/auto-goo/scripts/plan_schema.py --checkpoint-note "新增 schema 模块"

# 跑完一条有副作用的命令后登记（只留指纹，不可回读验证）
python3 skills/auto-goo/scripts/update-step.py --step-id 1 \
  --checkpoint-command "python3 -m pytest tests/test_plan_schema.py -q"
```

pi 工具等价调用：

```json
{ "stepId": 1, "action": "checkpoint",
  "checkpointFiles": ["skills/auto-goo/scripts/plan_schema.py"],
  "checkpointCommands": ["python3 -m pytest -q"] }
```

条目结构（`step.checkpoints[]`）：

```json
{
  "id": "ck-1",
  "kind": "file_write",            // 或 "command"
  "target": "skills/auto-goo/scripts/plan_schema.py",
  "sha256": "…",                   // file_write 才有
  "fingerprint": "…",              // command 才有（规范化命令 + cwd 的 sha256）
  "size": 12345,
  "at": "2026-11-16T08:12:00Z",
  "note": "新增 schema 模块"
}
```

`step.checkpoint_seq` 单调递增，id 删除后不复用。

### 7.2 比对（resume 时）

`checkpoint.verify()` 逐条对磁盘现状比对：

| status | 含义 | resume 决策 |
| --- | --- | --- |
| `intact` | 文件存在且 sha256 一致 | **跳过，不要重做** |
| `drift` | 文件被改过（hash 变化） | 不能假定完成，必须重做或先查明是谁改的 |
| `missing` | 文件不存在 | 副作用没落地或被回滚，必须重做 |
| `unverifiable` | 命令类，或登记时文件不存在 | 不能回读结果，**不要盲目重复执行**有副作用的命令 |

结果写进 `step.resume_state`：

```json
{
  "checked_at": "…",
  "mode": "checkpoint",          // 或 "restart"
  "counts": { "intact": 2, "drift": 0, "missing": 0, "unverifiable": 1 },
  "skip": [{ "id": "ck-1", "kind": "file_write", "target": "…" }],
  "redo": [],
  "unverifiable": [ … ],
  "guidance": "2 个副作用已完成（hash 一致）→ 跳过，不要重做；1 个命令类副作用无法回读 → 不要盲目重复执行。"
}
```

### 7.3 消费点（不读等于没有）

- `update-step.py --resume`：默认 `mode="checkpoint"`；`--restart` 才显式从头重跑，
  且 guidance 会写明「副作用可能重复」。
- `update-step.py --status pending`（`execute.ts` 自动重试走的路径）：比对后写
  `resume_state` + `idempotency`，重试 note 也带上 checkpoint 条数。
- `utils/dispatch.ts` 的 Subagent prompt：把 `step.checkpoints` / `step.resume_state`
  渲染成「已完成副作用（checkpoint 台账，勿重复）」段，Subagent 才知道跳过什么。
- `update-step.py --list-checkpoints`：人工查看比对结果。

---

## 8. 常用命令

```bash
# 看判定与迁移路径（不写盘）
python3 skills/auto-goo/scripts/plan_schema.py status --plan .goo/plan.json
# 预览迁移（不写盘）
python3 skills/auto-goo/scripts/plan_schema.py migrate --plan .goo/plan.json --dry-run
# 迁移（默认先备份到 plans/history/）
python3 skills/auto-goo/scripts/plan_schema.py migrate --plan .goo/plan.json
# 回滚（丢 durable 数据需显式授权）
python3 skills/auto-goo/scripts/plan_schema.py revert --plan .goo/plan.json --to 1
# 历史 plan 迁移演练
python3 skills/auto-goo/scripts/plan_schema.py drill --root .
# 查看某 step 的副作用台账
python3 skills/auto-goo/scripts/update-step.py --step-id 1 --list-checkpoints
```

退出码：`0` 成功；`3` schema 错误（需要迁移 / 版本过新 / 回滚被拦）。

---

## 9. 演练记录

真实历史 plan 的演练报告落在 `.goo/plans/migrations/`（`drill-*.json` / `drill-*.md`）。
每次改迁移逻辑都应该重跑 `drill`，并要求：

- 覆盖 ≥ 3 个历史 thread
- `all_roundtrip_ok == true`
- 旧语义 plan 被判为 `v1 (legacy)`，且给出证据（content / timestamp / mtime）

最近一次演练（2026-11-16，8 份历史 plan，全部往返一致）：
`2026-08-04-memory-system-design` 与 `2026-08-05-pi-memory-sync` 由
**文案特征**判为旧语义（`L0(原始 log)` / `L3(项目…` 命中），
`2026-10-08-goo-md-detection-backup` 由 `created_at` 判为旧语义。

---

## 10. 与其它文档的关系

- `references/task-parsing.md`：plan 字段表（`schema_version`、`checkpoints` 等字段说明）
- `references/execution-engine.md`：`interrupted` / `--resume` 状态机与心跳
- `references/setup.md`：`memory_layer` 的归档判定标准（新编号方向）
- `references/obsidian-archive.md`：归档产物与 wikilink 规范

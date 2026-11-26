---
type: memory
title: 记忆系统（memory_layer 分层口径）
memory_layer: L0
status: stable
tags: [memory, memory-layer, schema, frontmatter, audit, wiki-maintenance]
aliases: [记忆分层, memory layering, memory_layer, L0 L1 L2 L3]
related: ["[[memory/audit|覆盖率审计]]", "[[memory/rules|记忆分层规则]]"]
---

# 记忆系统（memory_layer 分层口径）

> **这一页是 Goo-wiki 记忆分层的唯一口径出处。** 其他任何地方（领域页、脚本 docstring、agent 提示词）
> 与本文冲突时，以本文为准，并去修那边 —— 这套口径历史上漂移过（编号方向整体翻转一次，
> 多个消费方各写一套路径表第二次）。

## 〇、为什么放在仓库根 `memory/`（而不是 `wiki/` 里）

`memory/` 与 `raw/`、`journal/`、`wiki/` 同级，理由：

1. **它不是内容层，是 schema 层**。`wiki/` 装的是「被维护的知识」，会被领域页、`index.md`、地图页
   当作知识来导航；记忆口径是「怎么维护」的规则，与 `AGENTS.md`、`scripts/` 同级，不该混进知识目录。
2. **避免自指**。放 `wiki/` 下时，本页和 `rules.md` 自己也要填 `memory_layer`，等于让规则给自己打分；
   现在 `memory/` 整体被 `policy.json` 的 `exclude_paths` 排除在统计之外。
3. **改口径时先看到它**。根级目录一眼可见，新 agent 建目录/写笔记时不会漏掉这层约束。

## 一、四层定义

编号方向：**数字越大越原始、越冷**（对齐 CPU 缓存与 TencentDB Agent Memory）。

| 层 | 名称 | 典型内容 | 容量 | 访问频度 | 读者要它做什么 |
|---|---|---|---|---|---|
| **L0** | 项目总览 | 项目入口 `<slug>.md`、`operations.md`、跨项目元教训、本页 | KB | 最热，启动必读 | 判断「这个项目是什么、边界在哪、有哪些铁律」 |
| **L1** | 场景知识 | `lessons/`、`references/`、`concepts/`、任务页、领域页 | MB | **默认层** | 复用做法，避免重踩坑 |
| **L2** | 原子事实 | 提炼后的决策、指标、错误码、`findings/`、`reports/`、`code-graph/`、[[memory/audit|审计页]] | GB | 按需查证 | 核对某个结论/数字是否成立 |
| **L3** | 原始记录 | step log、命令输出、`execution/record.md`、`journal/`、`raw/` | 大而冷 | 只做追溯 | 还原当时到底跑了什么 |

**唯一判据**：

> 三个月后另一个任务会来看它吗？来看它的哪一部分？

回答「会，来看方向」→ L0；「会，来看做法」→ L1；「会，来核对数字」→ L2；「只有出问题才来」→ L3。

## 二、规则放哪（三个文件，各管一段）

| 文件 | 管什么 | 谁在读 |
|---|---|---|
| **本页 `index.md`** | 四层定义、口径历史、已知不一致 —— **为什么这么分** | 人和 agent 理解背景 |
| **[[memory/rules|rules.md]]** | 写笔记时的可执行规则：必填字段、定层判据、路径→层映射、例外、回填流程 | 写归档笔记时查 |
| **`policy.json`** | 机器可读规则：层表、路径提示、例外、必填字段、排除路径 | `scripts/audit-memory-layer.py`、`scripts/backfill-memory-layer.py`、AutoGoo-Plugin 的 `check-wiki-frontmatter.py` 直读 |

结论：**层定义在本页，可执行规则在 rules.md，机器口径在 policy.json**。任何一处改动都要同时看另外两处。

## 三、检查与回填

```bash
python3 scripts/audit-memory-layer.py            # 重建 [[memory/audit|覆盖率审计]]
python3 scripts/audit-memory-layer.py --print    # 只看不写
python3 scripts/backfill-memory-layer.py         # 预览要改什么（默认不写）
python3 scripts/backfill-memory-layer.py --apply # 机械回填（幂等，只碰 frontmatter）
```

回填**只做无歧义部分**（缺失即补、项目入口→L0、`journal/`/`raw/`/`logs/`→L3、`reports/`/`code-graph/`→L2、
`lessons/`/`references/`/`concepts/`→L1）；`tasks/`、`syntheses/`、`execution/*-record.md` 等语义边界留人工。

AutoGoo-Plugin 侧的同一个检查器与本文同口径（直读 `policy.json`）：

```bash
python3 <plugin>/skills/auto-goo/scripts/check-wiki-frontmatter.py --audit <vault>
python3 <plugin>/skills/auto-goo/scripts/check-wiki-frontmatter.py --suggest <file>
```

## 四、已知不一致（本 vault 自己维护）

| 位置 | 现在写的 | 应为 | 状态 |
|---|---|---|---|
| `raw/` 下的原始材料 | 多数没有 frontmatter | 若需纳入统计则补 `memory_layer: L3`，否则把 `raw/` 加进 `exclude_paths` | ⏳ 二选一待定 |
| 其余差异以 [[memory/audit|审计页]] 的「与路径提示不符」为准 | — | 人工判断 | ⏳ |

## 五、口径历史（为什么会漂）

| 时点 | 变更 | 后果 |
|---|---|---|
| ≤0.27.0（plan schema v1 `legacy-unsigned`） | **旧口径**：L0=原始日志 → L3=项目总览 | 与 CPU 缓存命名相反 |
| 0.27.0（`c7524eb`） | 全量翻转：L0↔L3、L1↔L2（自逆），wiki 笔记 + 全部代码 | 同一字节 `memory_layer: L0` 前后含义相反 |
| 0.27.0~0.30.x（v2 `memory-layer-modern`） | 翻转后写入但**仍无** `schema_version` 字段 | v1/v2 在文件上不可区分，只能按证据推断 |
| ≥0.31.0（v3 `durable-checkpoints`） | 顶层 `schema_version` + step 级 `checkpoints` | 读取不再依赖推断 |
| ≥0.35.0 | 检查器不再自带路径表，改读本目录 `policy.json` | 「文档一套、脚本一套、提示词一套」的漂移被收敛到一处 |

## 六、相关

- [[memory/rules|记忆分层规则]] — 写笔记时的可执行规则
- `memory/policy.json` — 机器可读口径（脚本直读；改检查逻辑只改这份）
- [[memory/audit|memory_layer 覆盖率审计]]（生成物，数字以它为准）
- `AGENTS.md` · `CLAUDE.md` — 仓库 schema（含指向本目录的指针）

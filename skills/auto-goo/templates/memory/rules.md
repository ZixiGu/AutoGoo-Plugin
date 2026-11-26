---
type: memory
title: 记忆分层规则（写笔记时怎么定层）
memory_layer: L0
status: stable
tags: [memory, memory-layer, rules, frontmatter, policy, audit]
aliases: [memory rules, 分层规则, memory_layer 规则]
related: ["[[memory/index|记忆系统]]", "[[memory/audit|覆盖率审计]]"]
---

# 记忆分层规则

> 本文是**写笔记时的可执行规则**。层定义与「为什么这么分层」见 [[memory/index|记忆系统]]；
> 机器可读版本是 `memory/policy.json`（`scripts/audit-memory-layer.py`、`scripts/backfill-memory-layer.py`
> 与 AutoGoo-Plugin 的 `check-wiki-frontmatter.py` 都直读它，**改规则改那份 JSON，别改脚本**）。
> 下面规则与 `policy.json` 冲突时，以 JSON 为准并回改本文。

## 1. 必填字段

归档笔记 frontmatter 必须含：

```yaml
---
title: 页面标题
memory_layer: L0|L1|L2|L3
---
```

- 缺 `memory_layer` 或值不在四层内 → 视为不合规，`memory/audit.md` 会列出来。
- 基础设施文件（根目录与 `wiki/` 一层的 `index.md`、`log.md`、`home.md`、`AGENTS.md`、`CLAUDE.md`、
  `llm-wiki*.md`、`obsidian-cli.md`）**不要求**该字段。
- `memory/` 与 `.goo/`（运行时状态）整体排除在统计之外。

## 2. 定层判据（唯一问题）

> **三个月后另一个任务会来看它吗？来看它的哪一部分？**

| 读者意图 | 层 |
|---|---|
| 会，先看「这是什么、边界、铁律」 | **L0** |
| 会，看「怎么做 / 怎么避坑」 | **L1** |
| 会，核对「这个数字 / 结论对不对」 | **L2** |
| 只有出问题才来还原现场 | **L3** |

## 3. 路径 → 层（默认值，按 `policy.json` 的 `path_hints` 顺序，先命中先用）

| 命中路径 | 层 |
|---|---|
| `wiki/projects/<slug>.md`、`wiki/projects/<slug>/<slug>.md`、`*/operations.md`、`memory/*`（`audit.md` 除外） | **L0** |
| `*/lessons/`、`*/references/`、`*/concepts/`、`*/tasks/`、`*/domains/` | **L1** |
| `*/execution/`（`record.md`、`evidence-index.md` 除外）、`*/findings/`、`*/evidence/`、`*/reports/`、`*/code-graph/`、`memory/audit.md` | **L2** |
| `*/execution/record.md`、`*/execution/evidence-index.md`、`journal/`、`raw/`、`wiki/logs/` | **L3** |
| 其余 | **L1**（兜底） |

## 4. 例外

1. 项目入口语义固定为 **L0**，与文件名写法无关（两种路径写法都认）。
2. `tasks/` 页若已提炼为纯结论 / 决策、不再需要复现做法，**可人工提升到 L2**，但必须在页内写明理由；
   `audit.md` 会把它列进「与路径提示不符」，属**预期**差异，不是错误。
3. `notes/`、`inbox/` 属未整理材料，不入统计、不要求 `memory_layer`。
4. `memory/rules.md`、`memory/index.md` 是规则本身，固定 **L0**。
5. `raw/` 是不可变原始来源：**不补 frontmatter**（`backfill-memory-layer.py` 会跳过）。
   若要把它纳入统计，需先决定「补标注」还是「加进 `exclude_paths`」。

## 5. 写入与回填流程

```bash
# 1) 查当前缺口与残留旧值
python3 scripts/audit-memory-layer.py --print

# 2) 机械回填（默认只预览；--apply 才写；只碰 frontmatter，幂等）
python3 scripts/backfill-memory-layer.py
python3 scripts/backfill-memory-layer.py --apply

# 3) 重建审计页并复核
python3 scripts/audit-memory-layer.py
```

回填顺序：**先机械后人工** —— `journal/`+`wiki/logs/`（全 L3）→ 缺失的项目入口（全 L0）→
旧值翻转（`L3`→`L0`、`L2`→`L1`、`L1`→`L2`、`L0`→`L3`）→ `tasks/` 与 `syntheses/` 人工判断。

## 6. 口径漂移防护

- 0.27.0 曾把编号方向整体翻转（旧：L0=原始记录、L3=项目总览）。看到 `L0` 出现在 `journal/`、`raw/`、
  `execution/` 里，或 `L3` 出现在项目入口上，**基本可以判定是旧值残留**。
- 检查器只允许**一处**路径表实现（`policy.json`）。任何脚本自带一份 `path_hints` 都算回归。

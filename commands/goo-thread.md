---
name: auto-goo:goo-thread
description: 统一管理 AutoGoo-Plugin thread — 列出 / 详情 / 切换 / 新建 / 关闭 / 对账
---

# /auto-goo:goo-thread — thread 统一管理

thread 是一整条任务线（`.goo/threads/<id>/`：`thread.json` + `plan.json` + `logs/` + `artifacts/`）。
一个项目可以有多条 thread，其中只有一条是「当前」（`.goo/current_thread.json`）。

本命令是 thread 操作的唯一入口，底层复用 `goo-thread.py`。

## 用法

```text
/goo-thread                 列出所有 thread（* = 当前，⚠ = 需处理）
/goo-thread show <id>       查看单个 thread 详情
/goo-thread switch <id>     切换当前 thread
/goo-thread new <标题>      新建 thread（加 --steps N 同时生成计划骨架）
/goo-thread close <id>      归档并关闭
/goo-thread doctor [--fix]  对账并修复记录不一致
/goo-thread health          按 thread 的健康检查
```

## 执行方式

先解析 AutoGoo-Plugin root，再运行脚本：

```bash
python3 "$auto_goo_root/skills/auto-goo/scripts/goo-thread.py" --root "$PWD" <子命令> ...
```

无参数时等价于 `list`。

## 列表标记

| 标记 | 含义 |
| --- | --- |
| `*` | 当前 thread |
| `✓` | 正常进行中 |
| `·` | 已结束（completed / archived） |
| `⚠` | 需要处理（心跳停滞、失败步骤、长期未更新） |
| `≠` | plan 与 thread 状态不一致 |

## `switch` 的关键行为

`switch` 会**同时**更新两处：

1. `.goo/current_thread.json` —— 当前 thread 指针
2. `.goo/plan.json` —— 兼容入口（`/goo-status`、`/goo-continue`、`/goo-observe` 读的是这个）

> 只切 `current_thread.json` 是经典陷阱：你会以为切到了 A，但 `/goo-continue` 仍在推 B 的计划。

若目标 thread 没有自己的 `plan.json`（例如已归档），命令会切换指针但**保留兼容入口原样**，并给出提示。

## 安全边界

- `list` / `show` / `health` 只读，不修改任何文件。
- `switch` 只改指针与兼容入口（可逆，重新 switch 回去即可）。
- `close` 会先在 `.goo/plans/history/` 留归档副本，再把 plan 与 thread 标为 `abandoned`；**不篡改步骤状态、不删除文件**。
- `doctor --fix` 只做幂等安全修复（修改前按文件备份到 `.goo/plans/history/thread-fix-<stamp>/`）。

## 与其他命令的关系

| 命令 | 关系 |
| --- | --- |
| `/goo-plan` | 当前 thread 未完成时仍会问「新建 / 继续 / 取消」；选「新建」等价于本命令的 `new` |
| `/goo-continue` | 作用于**当前 thread**（读兼容入口），切换 thread 后自然跟着变 |
| `/goo-status` | 展示当前 thread 的 DAG 状态 |
| `/goo-publish` | 生成包含 Threads 页面的静态站点 |

## 输出要求

- 执行后向用户汇报实际结果（列表 / 切换到了哪条 / 关闭了哪条）。
- `switch` 后必须提示：`/goo-status` 与 `/goo-continue` 现在作用于哪条 thread。
- `close` 后必须提示归档副本位置。
- 出错时原样转述脚本的 stderr，不要静默吞掉。

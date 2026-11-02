---
name: auto-goo:goo-thread
description: 统一管理 AutoGoo-Plugin thread — 列出 / 详情 / 切换 / 新建 / 关闭 / 对账
---

# /auto-goo:goo-thread — thread 统一管理

thread 是一整条任务线（`.goo/threads/<id>/`：`thread.json` + `plan.json` + `logs/` + `artifacts/`）。
一个项目可以有多条 thread，其中只有一条是「当前」（`.goo/current_thread.json`）。

本命令是 thread 操作的唯一入口，底层复用 `goo-thread.py`。

## 用法

**无参数**时（pi TUI 模式）打开**键盘驱动的交互式管理界面**，而不是打印表格：

```
─────────────────────────────────────────────────────────────
 AutoGoo Threads · 11 个 · 当前 2026-10-08-goo-md-detection-backup
 ↑↓/jk 移动   ⏎ 切换   r 重命名   a 归档   u 恢复   c 关闭   d 对账   q 退出
─────────────────────────────────────────────────────────────
 ›* 2026-10-08-goo-md-detection-backup · completed  completed/5/5  goo.md 检测…
   2026-10-05-pi-interaction-timeout  · completed  completed/4/4  pi 交互…
   demo-thread                        · archived   —              thread sync smoke
─────────────────────────────────────────────────────────────
 * 当前: goo.md 检测与备份恢复
   id: 2026-10-08-…　状态: completed　计划: completed (5/5)
   健康: completed
─────────────────────────────────────────────────────────────
```

| 按键 | 动作 |
| --- | --- |
| `↑` `↓` / `j` `k` | 移动选择 |
| `g` / `G` | 跳到首 / 尾 |
| `⏎` | 切换到选中 thread（**同时同步兼容入口**） |
| `r` | 重命名 |
| `a` | 归档（archived，可 `u` 恢复） |
| `u` | 从归档恢复 |
| `c` | 关闭（归档 + abandoned，**需确认**） |
| `d` | 对账（thread-doctor） |
| `q` / `Esc` | 退出 |

带参数时仍走脚本，便于自动化：

```text
/goo-thread list [--json] [--active] [--status running,archived]
/goo-thread show <id> [--json]
/goo-thread switch <id>
/goo-thread new <标题> [--steps N]
/goo-thread rename <id> <新标题>
/goo-thread archive <id> / restore <id>
/goo-thread close <id>
/goo-thread doctor [--fix]
/goo-thread health
```

非 TUI 模式（`json` / `print`）自动降级为脚本输出。

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

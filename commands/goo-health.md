---
name: auto-goo:goo-health
description: 输出「本次 DAG 健康报告」— 耗时分布 / 最容易超时的 step / 失败原因聚类 / 重试次数 / 阈值告警
---

# /auto-goo:goo-health — DAG 健康报告

> **状态查看豁免**：本命令只读（plan + `.goo/logs/exec.jsonl`），不改步骤状态、不触发调度、不写 thread。它把已有的执行指标汇总成一份「现在到底健不健康」的报告，不做归因或优化决策。

## 为什么需要它

执行指标曾经是零：失败/卡住/超时只在 TUI 和 step log 里出现，无人值守时没人知道 DAG 停了（实测一轮 7 步 DAG 跑 2h11m，中途有步骤 `exit 143`、有步骤 `interrupted`，全靠人反复手动查状态才发现）。

现在每次步骤状态跃迁都会落一条事件到 `.goo/logs/exec.jsonl`，本命令负责**把事件回答成人话**：

| 问题 | 报告里的位置 |
| --- | --- |
| 现在卡住了吗？ | 「告警」段 + 「最近进展」时长 |
| 哪些 step 最耗时间？ | 「耗时分布」avg / p50 / p95 / max + 最慢 top3 |
| 哪些 step 最容易超时？ | 「超时」段按超时/中断次数排序 |
| 平均重试几次？ | 「重试」段（重试事件 / 涉及 step / 平均每步 / 最多） |
| 失败主要是什么原因？ | 「失败原因聚类」（`timeout` / `auth` / `rate_limit` / `signal_killed` / `exit_code` …） |

## 用法

```bash
/auto-goo:goo-health          # 人类可读报告（pi TUI 下走 ctx.ui.notify）
/auto-goo:goo-health --json   # 机器可读（plan / stats / alerts）
```

等价的底层读取（Claude Code / Codex / 脚本）：

```bash
# 事件流原文（最近 20 条）
python3 "$auto_goo_root/skills/auto-goo/scripts/exec_observe.py" tail --plan .goo/plan.json -n 20

# 事件流路径（确认指标链路写到了哪）
python3 "$auto_goo_root/skills/auto-goo/scripts/exec_observe.py" path --plan .goo/plan.json
```

## 阈值与告警

阈值来自 `.goo/config.json` 的 `observability` 段，全部可选：

```json
{
  "observability": {
    "enabled": true,
    "alert_interval_seconds": 60,
    "cooldown_seconds": 900,
    "step_timeout_minutes": 30,
    "plan_stall_minutes": 15,
    "stale_heartbeat_seconds": 900,
    "max_retries": 1,
    "webhook_url": ""
  }
}
```

- 告警默认走 `ctx.ui.notify`（不引入外部依赖）；`webhook_url` 为空即**不发送**。
- 同一告警在 `cooldown_seconds` 内只通知一次 —— 每分钟重复的「卡住了」不是提醒，是新的噪音源。
- 看门狗在会话启动时按 `alert_interval_seconds` 轮询；`AUTOGOO_EXEC_ALERTS=0` 可关闭。
- 指标写入失败**绝不阻塞执行**：`exec.jsonl` 写不进去时状态更新照常成功，报告会明确标出「指标源 ✗ / 统计不可信」。

## 事件类型

| event | 触发 |
| --- | --- |
| `step_start` | `--start`（派发） |
| `step_complete` | `--complete` |
| `step_fail` | `--fail` |
| `step_timeout` | `--interrupt --timed-out`，或 error 明确是超时 |
| `step_interrupt` | `--interrupt`（wrapper 被杀，任务本体状态未知） |
| `step_retry` | 自动重试转回 pending |
| `step_resume` | 人工确认任务仍在跑后 `--resume` |
| `step_block` | `--block` |
| `alert` | 阈值告警被投递时登记（事后可回答「当时通知过谁」） |

心跳**不**入事件流（每 20s 一条会把真事件淹掉）；存活信号看 plan 的 `heartbeat_at`。

## 注意

- 报告是观察，不是操作：确需 `interrupt` / `resume` / `--restart` 时走 `/auto-goo:goo-status` 或 `auto_goo_update_step`。
- 指标文件按 4MB 轮转为 `exec.jsonl.1`（与 `recall.jsonl` 同约定），历史跨轮转不在报告范围内。

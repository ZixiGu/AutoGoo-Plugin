#!/usr/bin/env python3
"""DAG 执行事件流 `.goo/logs/exec.jsonl` —— 执行可观测性的唯一写入口。

问题
----
可观测性此前只覆盖**召回**（`recall.jsonl` + observe 的 recall tab）。DAG 执行
本身零指标：一轮 7 步 DAG 跑了 2h11m，中途有步骤 exit 143、有步骤 interrupted，
只有盯着 TUI 或翻 step log 的人知道；无人值守时唯一的信号是「它不动了」，而
「不动」和「在思考」在终端里长得一模一样。

做法
----
和其它观测一样，用**追加写 JSONL**（每行一条独立 JSON，便于 grep/jq/awk），
文件按大小轮转，写入失败不影响执行：

    .goo/logs/exec.jsonl        ← 当前
    .goo/logs/exec.jsonl.1      ← 轮转后的上一份（4MB 阈值，与 recall.jsonl 同约定）

**写入者是唯一的**：所有 step 状态跃迁都会经过 `update-step.py`（调度器、
Subagent、主 Agent 手工调用、detached 路径全部如此），因此事件由它统一登记，
不在 TS 侧重复记录。这样「谁改了 step 状态」与「exec.jsonl 里有什么」永远对得上。

事件类型（`event` 字段）：

| event | 何时写 |
| --- | --- |
| `step_start` | `--start`（派发，status→running） |
| `step_complete` | `--complete` |
| `step_fail` | `--fail` |
| `step_timeout` | `--interrupt --timed-out`，或 error 文本明确是超时 |
| `step_interrupt` | `--interrupt`（wrapper 被信号杀，任务本体状态未知） |
| `step_retry` | 自动重试转回 pending（`--retry` 或 note 以 Auto-retry 开头） |
| `step_resume` | `--resume`（人工确认任务仍在跑后恢复） |
| `step_block` | `--block` |
| `step_pending` | 其它回到 pending 的操作（如确认后解锁） |
| `alert` | 阈值告警（由调度器/看门狗投递时登记，便于事后回答「当时通知过谁」） |

字段与 recall.jsonl 对齐：`ts` 为 ISO-8601 UTC（…Z），单行 JSON，键全部
snake_case，长文本一律截断（error 400 / stderr_excerpt 300 / note 200）。

设计约束
--------
1. **写入失败绝不阻塞执行**：所有函数吞掉异常并返回 False/None。
2. **不改 plan**：本模块只读 plan 派生上下文（thread、name、时间戳），
   台账字段（checkpoints / resume_state）不重复记录 —— 重试次数直接取
   `retry_count`，副作用直接看 checkpoint 条数。
3. **耗时优先用调用方上报值**，否则从 `started_at` / `completed_at` 派生，
   并写 `duration_source` 标明来源（`reported` / `plan` / `now`）。
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from _paths import (
    find_config_dir,
    now,
    parse_iso,
    project_root_from_plan,
    workspace_paths,
)

EXEC_LOG_NAME = "exec.jsonl"
MAX_BYTES = 4 * 1024 * 1024  # 与 recall-observe.ts 的 4MB 轮转阈值一致

# 事件名 -> 语义分类（供 TS 侧聚合时无需硬编码字符串）
COMPLETION_EVENTS = {"step_complete"}
FAILURE_EVENTS = {"step_fail", "step_timeout"}
ATTENTION_EVENTS = {"step_fail", "step_timeout", "step_interrupt"}

# 错误聚类桶。顺序有意义：命中越靠前越可信。
_ERROR_PATTERNS: list[tuple[str, tuple[str, ...]]] = [
    ("timeout", ("timed out", "timeout", "超时", "超过", "deadline exceeded")),
    ("heartbeat_stale", ("heartbeat", "心跳")),
    ("signal_killed", ("sigterm", "sigkill", "killed", "信号杀")),
    ("auth", ("unauthor", "forbidden", "401", "403", "invalid api key", "认证")),
    ("rate_limit", ("rate limit", "rate_limit", "429", "quota", "限流")),
    ("model", ("model not found", "no such model", "model does not exist", "模型不存在")),
    ("network", ("econnrefused", "enotfound", "network", "dns", "connect timeout")),
    ("resource_conflict", ("资源冲突", "lock", "conflict")),
    ("plan_invalid", ("plan 校验", "循环依赖", "invalid plan")),
    ("dispatch_no_log", ("dispatch_no_log", "没有写 log")),
]

_TRUNCATE = {"error": 400, "stderr_excerpt": 300, "note": 200, "guidance": 200}


# ── 路径 ────────────────────────────────────────────────────────────────────


def exec_log_path(plan_path: Path) -> Path:
    """`.goo/logs/exec.jsonl`（项目级，与 recall.jsonl 同目录）。

    刻意**不用** thread 级 `logs/`：指标是要跨 thread、跨一轮 DAG 比较的
    （「哪些 step 最容易超时」只有在多次运行之间才有意义）。thread 维度
    通过事件里的 `thread` 字段保留。
    """
    config_dir = find_config_dir(plan_path)
    project_root = project_root_from_plan(plan_path)
    paths = workspace_paths(config_dir)
    logs_dir = Path(paths["logs_dir"])
    if not logs_dir.is_absolute():
        logs_dir = project_root / logs_dir
    return logs_dir / EXEC_LOG_NAME


def _rotate_if_needed(path: Path) -> None:
    try:
        if path.exists() and path.stat().st_size > MAX_BYTES:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass


# ── 事件写入 ────────────────────────────────────────────────────────────────


def _clip(value: Any, key: str) -> Any:
    if not isinstance(value, str):
        return value
    limit = _TRUNCATE.get(key)
    if limit and len(value) > limit:
        return value[:limit] + "…"
    return value


def append_event(plan_path: Path, event: dict[str, Any]) -> bool:
    """追加一条事件。永不抛异常（观测失败不影响执行）。"""
    try:
        record = {k: v for k, v in event.items() if v is not None}
        record.setdefault("ts", now())
        record.setdefault("source", "update-step")
        for key in list(record):
            record[key] = _clip(record[key], key)
        path = exec_log_path(plan_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        _rotate_if_needed(path)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return True
    except Exception:  # noqa: BLE001 - 观测失败绝不影响主流程
        return False


def classify_error(
    text: str | None,
    *,
    exit_code: int | None = None,
    timed_out: bool = False,
) -> str | None:
    """把自由文本错误归到一个稳定桶，便于「失败原因聚类」。

    归桶而不是留原文：原文每次都不同（带 pid、路径、时间），直接聚类等于
    每条一个桶。原文仍然保留在 `error` 字段里供人看。
    """
    if timed_out:
        return "timeout"
    lowered = (text or "").lower()
    for bucket, needles in _ERROR_PATTERNS:
        if any(needle in lowered for needle in needles):
            return bucket
    if exit_code is not None and exit_code != 0:
        if exit_code >= 128:
            return "signal_killed"
        return "exit_code"
    if not lowered:
        return None
    return "unknown"


def _iso_millis(step: dict[str, Any], field: str) -> datetime | None:
    return parse_iso(step.get(field))


def _duration_ms(step: dict[str, Any], explicit: int | None, stamp: str) -> tuple[int | None, str]:
    """耗时 + 来源。reported（调用方实测）> plan（started_at→completed_at）> now。"""
    if explicit is not None and explicit >= 0:
        return int(explicit), "reported"
    started = _iso_millis(step, "started_at")
    if started is None:
        return None, "missing"
    ended = _iso_millis(step, "completed_at")
    if ended is None:
        ended = parse_iso(stamp) or started
    try:
        delta = int((ended - started).total_seconds() * 1000)
    except Exception:  # noqa: BLE001
        return None, "missing"
    return max(0, delta), "plan"


def thread_id_from_plan(plan_path: Path) -> str | None:
    """从 `.goo/threads/<tid>/plan.json` 反推 thread id（兼容 `.goo/plan.json`）。"""
    parts = plan_path.resolve().parts
    if "threads" in parts:
        idx = parts.index("threads")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return None


def _event_name(action: str, *, retry: bool, timed_out: bool, error: str | None) -> str | None:
    """把 update-step 的动作映射成 exec 事件名（None = 不记录）。

    心跳（heartbeat）刻意不入事件流：正常运行时每 20s 一条，会把真正有信息量
    的事件淹掉。存活信号看 plan 的 `heartbeat_at` 就够。
    """
    if action == "start":
        return "step_start"
    if action == "complete":
        return "step_complete"
    if action == "fail":
        return "step_fail"
    if action == "interrupt":
        if timed_out or classify_error(error) == "timeout":
            return "step_timeout"
        return "step_interrupt"
    if action == "resume":
        return "step_resume"
    if action == "block":
        return "step_block"
    if action in {"status:pending", "status:running"}:
        # pending 有两条语义完全不同的路径：自动重试（同一步再跑一遍）与
        # 解除阻塞（从没跑过）。混成一个事件会让「平均重试几次」虚高。
        return "step_retry" if retry else "step_pending"
    return None


def record_transition(
    plan_path: Path,
    step: dict[str, Any],
    action: str,
    *,
    thread: str | None = None,
    exit_code: int | None = None,
    duration_ms: int | None = None,
    timed_out: bool = False,
    stderr_excerpt: str | None = None,
    note: str | None = None,
    error: str | None = None,
    retry: bool = False,
    stamp: str | None = None,
    source: str = "update-step",
) -> bool:
    """登记一次状态跃迁。返回是否写入成功；失败不抛异常。

    *step* 应当是**已经更新过**的 step dict（状态/进度/时间戳都已落定），
    这样事件里的 status/progress 与 plan 完全一致，不会出现「事件说 completed、
    plan 说 running」这种二次漂移。
    """
    try:
        stamp = stamp or now()
        event_name = _event_name(
            action,
            retry=retry,
            timed_out=timed_out,
            error=error,
        )
        if event_name is None:
            return False
        if event_name == "step_start":
            # 起点没有「耗时」这个概念：置空比报 0 更诚实（0 会被聚合成
            # 一个假的「飞快完成」样本）。
            elapsed, source_of_duration = None, "n/a"
        else:
            elapsed, source_of_duration = _duration_ms(step, duration_ms, stamp)
        error_text = error or step.get("error")
        # 错误聚类要看 stderr：provider 认证 / 限流 / 模型不存在只出现在那里，
        # 只看 error 摘要会把它们全归到 "exit_code"（一个什么都说明不了的桶）。
        error_class = classify_error(error_text, exit_code=exit_code, timed_out=timed_out)
        if error_class in (None, "unknown", "exit_code"):
            alt = classify_error(stderr_excerpt)
            if alt not in (None, "unknown", "exit_code"):
                error_class = alt
        event: dict[str, Any] = {
            "event": event_name,
            "step_id": str(step.get("id")) if step.get("id") is not None else None,
            "step_name": step.get("name"),
            "subagent": step.get("subagent"),
            "agent_id": step.get("agent_id"),
            "thread": thread or thread_id_from_plan(plan_path),
            "status": step.get("status"),
            "progress": step.get("progress"),
            "duration_ms": elapsed,
            "duration_source": source_of_duration,
            "exit_code": exit_code,
            "timed_out": True if timed_out else None,
            "retry_count": step.get("retry_count"),
            "checkpoints": len(step.get("checkpoints") or []) or None,
            "error_class": error_class,
            "error": error_text,
            "stderr_excerpt": stderr_excerpt,
            "note": note,
            "source": source,
            "ts": stamp,
        }
        if event_name == "step_complete":
            event["error_class"] = None
            event["error"] = None
        return append_event(plan_path, event)
    except Exception:  # noqa: BLE001 - 观测失败绝不影响状态更新
        return False


# ── 读取（供 CLI / 排障；聚合在 TS 侧做，避免两份口径）────────────────────


def read_events(plan_path: Path, limit: int = 200) -> list[dict[str, Any]]:
    """读最近 *limit* 条事件；文件缺失/损坏时返回空列表。"""
    path = exec_log_path(plan_path)
    if not path.exists():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()[-limit:]
    except OSError:
        return []
    out: list[dict[str, Any]] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            out.append(parsed)
    return out


# ── CLI ─────────────────────────────────────────────────────────────────────


def _cli(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="AutoGoo DAG 执行事件流（exec.jsonl）")
    parser.add_argument("--plan", default=".goo/plan.json", help="plan.json 路径")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_path = sub.add_parser("path", help="打印 exec.jsonl 绝对路径")
    p_path.add_argument("--plan", default=".goo/plan.json")

    p_append = sub.add_parser("append", help="手工追加一条事件（TS 投递告警时复用）")
    p_append.add_argument("--plan", default=".goo/plan.json")
    p_append.add_argument("--json", required=True, help="事件 JSON（必须含 event 字段）")

    p_tail = sub.add_parser("tail", help="打印最近 N 条事件")
    p_tail.add_argument("--plan", default=".goo/plan.json")
    p_tail.add_argument("-n", type=int, default=20)
    p_tail.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    plan_path = Path(args.plan).expanduser()

    if args.cmd == "path":
        print(exec_log_path(plan_path))
        return 0

    if args.cmd == "append":
        try:
            payload = json.loads(args.json)
        except json.JSONDecodeError as exc:
            sys.stderr.write(f"error: --json 不是合法 JSON: {exc}\n")
            return 2
        if "event" not in payload:
            sys.stderr.write("error: 事件必须包含 event 字段\n")
            return 2
        payload.setdefault("source", "cli")
        return 0 if append_event(plan_path, payload) else 1

    if args.cmd == "tail":
        events = read_events(plan_path, args.n)
        if args.json:
            print(json.dumps(events, ensure_ascii=False, indent=2))
            return 0
        if not events:
            print(f"（{exec_log_path(plan_path)} 还没有事件）")
            return 0
        for ev in events:
            dur = ev.get("duration_ms")
            dur_s = f"{dur / 1000:.1f}s" if isinstance(dur, (int, float)) else "-"
            print(
                f"{ev.get('ts', '?')} {str(ev.get('event', '?')):<14} "
                f"#{str(ev.get('step_id', '-')):<4} {dur_s:>8} "
                f"{str(ev.get('error_class') or ''):<16} {str(ev.get('error') or '')[:80]}"
            )
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))

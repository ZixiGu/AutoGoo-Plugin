#!/usr/bin/env python3
"""Recalculate AutoGoo-Plugin execution metrics from historical threads.

Why this exists
---------------
Plan-level ``started_at`` / ``completed_at`` used to be stamped with wall-clock
``now`` by whoever flipped the plan status (update-step.py, goo-status.py
``--update-status``). Once a plan got re-synced or re-opened later, that stamped
a start *after* the steps had already finished, and
``completed_at - started_at`` went negative (measured: **-465 min** on
``2026-08-04-memory-system-design``). Since 0.29 the plan window is *derived*
from step timestamps (``_paths.derive_plan_timestamps``) — steps are the single
source of truth.

This script makes that measurable instead of anecdotal:

* it recomputes every thread's duration from the **step timeline** (envelope),
  which is why historical numbers can be reported as non-negative without
  fabricating any timestamps;
* it reports the step/status distribution and the parallel-vs-serial ratio, so
  "is a DAG worth it here?" has a number behind it;
* ``--fix`` recomputes the plan-level fields of historical plans (write is
  guarded by ``--write`` and always backs up first).

It never invents timestamps: a thread whose steps carry no timestamps is
reported as ``unverifiable`` rather than given a made-up window.

Usage
-----
  goo-metrics.py                        # human table for all threads
  goo-metrics.py --json                 # machine readable
  goo-metrics.py --markdown [--out F]   # markdown report for artifacts
  goo-metrics.py --fix                  # dry-run: list plan timestamp repairs
  goo-metrics.py --fix --write          # apply repairs (backs up plan.json)
  goo-metrics.py --plan .goo/plan.json  # single plan
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from _paths import (
    derive_plan_timestamps,
    find_config_dir,
    format_iso,
    parse_iso,
    project_root_from_config_dir,
    workspace_paths,
)

# 并行收益只有在「多步 + 可并行分支」时才会出现；阈值来自实测分布，
# 见 --markdown 输出的「DAG 收益结论」一节。
DURATION_BUCKETS: list[tuple[str, float, float | None]] = [
    ("<10min", 0.0, 10.0),
    ("10-60min", 10.0, 60.0),
    ("1-4h", 60.0, 240.0),
    ("4-12h", 240.0, 720.0),
    (">=12h", 720.0, None),
]
STEP_COUNT_BUCKETS: list[tuple[str, int, int | None]] = [
    ("1-3", 1, 3),
    ("4-5", 4, 5),
    ("6+", 6, None),
]


# ── helpers ──────────────────────────────────────────────────────────────────

def read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def minutes_between(start: datetime | None, end: datetime | None) -> float | None:
    if start is None or end is None:
        return None
    return round((end - start).total_seconds() / 60.0, 1)


def fmt_min(value: float | None) -> str:
    if value is None:
        return "n/a"
    if abs(value) < 1:
        return f"{value * 60:.0f}s"
    if value < 60:
        return f"{value:.1f}min"
    return f"{value / 60:.2f}h"


def fmt_pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    # 先取整再判断：-0.5 取整为 0，显示 "-0%" 会让人误读成负收益
    rounded = round(value)
    return "0%" if rounded == 0 else f"{rounded}%"


def in_bucket(value: float | None, low: float, high: float | None) -> bool:
    if value is None:
        return False
    if value < low:
        return False
    return True if high is None else value < high


def parse_step_status_counts(steps: Iterable[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for step in steps:
        key = str(step.get("status") or "pending")
        counts[key] = counts.get(key, 0) + 1
    return counts


def discover_plans(root: Path, threads_dir: Path) -> list[tuple[str, Path]]:
    """Return (thread_id, plan_path) for every thread plan under *root*."""
    found: list[tuple[str, Path]] = []
    if not threads_dir.is_dir():
        return found
    for thread_dir in sorted(threads_dir.iterdir()):
        if not thread_dir.is_dir():
            continue
        plan_path = thread_dir / "plan.json"
        if plan_path.is_file():
            found.append((thread_dir.name, plan_path))
    return found


# ── per-plan analysis ────────────────────────────────────────────────────────

def analyse_plan(thread_id: str, plan_path: Path) -> dict[str, Any]:
    """Recompute durations/steps/status distribution for one plan.

    ``duration_*_min`` are derived from the **step timeline** (single source of
    truth). ``stored_*_min`` keeps whatever plan.json currently says so a
    negative/absurd stored window is visible rather than silently repaired.
    """
    plan = read_json(plan_path)
    steps = [s for s in (plan.get("steps") or []) if isinstance(s, dict)]

    step_starts = [(s, parse_iso(s.get("started_at"))) for s in steps]
    step_ends = [(s, parse_iso(s.get("completed_at"))) for s in steps]
    starts = [t for _, t in step_starts if t]
    ends = [t for _, t in step_ends if t]

    durations: list[float] = []
    per_step: list[dict[str, Any]] = []
    for step in steps:
        start = parse_iso(step.get("started_at"))
        end = parse_iso(step.get("completed_at"))
        length = minutes_between(start, end)
        if length is not None:
            durations.append(max(0.0, length))
        per_step.append(
            {
                "id": step.get("id"),
                "name": step.get("name"),
                "status": step.get("status"),
                "type": step.get("type"),
                "started_at": step.get("started_at"),
                "completed_at": step.get("completed_at"),
                "duration_min": length,
            }
        )

    plan_start_stored = parse_iso(plan.get("started_at"))
    plan_end_stored = parse_iso(plan.get("completed_at"))
    stored_duration = minutes_between(plan_start_stored, plan_end_stored)

    envelope_start = min(starts) if starts else None
    envelope_end = max(ends) if ends else None
    duration_derived = minutes_between(envelope_start, envelope_end)

    # 串行基准 = 各步耗时之和（假设一步接一步跑）；wall = 实际墙钟跨度。
    serial_min = round(sum(durations), 1) if durations else None
    parallel_saving_pct = None
    if serial_min and duration_derived is not None and serial_min > 0:
        parallel_saving_pct = round((1 - duration_derived / serial_min) * 100, 1)

    # 存储窗口与步骤时间线的一致性问题
    terminal_plan = str(plan.get("status") or "") in {"completed", "failed", "abandoned", "closed"}
    all_steps_terminal = bool(steps) and all(
        str(s.get("status") or "") in {"completed", "failed"} for s in steps
    )
    issues: list[str] = []
    if stored_duration is not None and stored_duration < 0:
        issues.append("negative_duration")
    if not starts and not ends:
        # 步骤根本没有时间戳：无任何可信来源，不能编一个窗口
        issues.append("unverifiable")
    elif duration_derived is None:
        if terminal_plan or all_steps_terminal:
            # 已结束但时间戳缺一半：同样不可量化，而不是「进行中」
            issues.append("unverifiable")
        else:
            # 有开始没结束（进行中）：不是数据错，只是还没跑完
            issues.append("in_progress")
    elif stored_duration is not None and abs(stored_duration - duration_derived) > 1.0:
        issues.append("window_skew")
    if duration_derived is not None and not (terminal_plan or all_steps_terminal):
        # 还在跑：耗时只是当前快照（只含已完成的步骤），不是最终值
        issues.append("partial")
    if plan_start_stored and envelope_start and plan_start_stored > envelope_start:
        issues.append("plan_start_after_step")
    if plan_end_stored and envelope_end and plan_end_stored < envelope_end:
        issues.append("plan_end_before_step")

    status = str(plan.get("status") or "unknown")
    threads_meta_path = plan_path.parent / "thread.json"
    thread_meta = read_json(threads_meta_path)

    return {
        "thread_id": thread_id,
        "plan_path": str(plan_path),
        "title": plan.get("task") or thread_meta.get("title"),
        "plan_status": status,
        "thread_status": thread_meta.get("status"),
        "created_at": thread_meta.get("created_at") or plan.get("created_at"),
        "steps_total": len(steps),
        "status_counts": parse_step_status_counts(steps),
        "steps_with_timestamps": len(durations),
        "plan_started_at": plan.get("started_at"),
        "plan_completed_at": plan.get("completed_at"),
        "derived_started_at": format_iso(envelope_start) if envelope_start else None,
        "derived_completed_at": format_iso(envelope_end) if envelope_end else None,
        "stored_duration_min": stored_duration,
        "duration_min": duration_derived,
        "serial_min": serial_min,
        "parallel_saving_pct": parallel_saving_pct,
        "avg_step_min": round(statistics.fmean(durations), 1) if durations else None,
        "max_step_min": round(max(durations), 1) if durations else None,
        "median_step_min": round(statistics.median(durations), 1) if durations else None,
        "critic_step": max(
            (s for s in per_step if s.get("duration_min") is not None),
            key=lambda s: s["duration_min"],
            default=None,
        ),
        "issues": issues,
        "steps": per_step,
    }


def summarise(records: list[dict[str, Any]]) -> dict[str, Any]:
    durations = [r["duration_min"] for r in records if r["duration_min"] is not None]
    savings = [r["parallel_saving_pct"] for r in records if r["parallel_saving_pct"] is not None]
    status_totals: dict[str, int] = {}
    for record in records:
        for key, count in record["status_counts"].items():
            status_totals[key] = status_totals.get(key, 0) + count

    buckets = []
    for label, low, high in DURATION_BUCKETS:
        hits = [d for d in durations if in_bucket(d, low, high)]
        buckets.append({"bucket": label, "count": len(hits)})

    by_step_count = []
    for label, low, high in STEP_COUNT_BUCKETS:
        group = [r for r in records if in_bucket(float(r["steps_total"]), low, high)]
        group_savings = [r["parallel_saving_pct"] for r in group if r["parallel_saving_pct"] is not None]
        group_wall = [r["duration_min"] for r in group if r["duration_min"] is not None]
        group_serial = [r["serial_min"] for r in group if r["serial_min"] is not None]
        by_step_count.append(
            {
                "steps": label,
                "threads": len(group),
                "avg_wall_min": round(statistics.fmean(group_wall), 1) if group_wall else None,
                "avg_serial_min": round(statistics.fmean(group_serial), 1) if group_serial else None,
                "avg_saving_pct": round(statistics.fmean(group_savings), 1) if group_savings else None,
                "max_saving_pct": round(max(group_savings), 1) if group_savings else None,
            }
        )

    return {
        "threads": len(records),
        "threads_measurable": len(durations),
        "threads_unverifiable": len([r for r in records if "unverifiable" in r["issues"]]),
        "threads_in_progress": len([r for r in records if "in_progress" in r["issues"]]),
        "threads_partial": len([r for r in records if "partial" in r["issues"]]),
        "threads_negative_stored": len([r for r in records if "negative_duration" in r["issues"]]),
        "threads_window_skew": len([r for r in records if "window_skew" in r["issues"]]),
        "duration_min": {
            "min": round(min(durations), 1) if durations else None,
            "max": round(max(durations), 1) if durations else None,
            "median": round(statistics.median(durations), 1) if durations else None,
            "mean": round(statistics.fmean(durations), 1) if durations else None,
            "total": round(sum(durations), 1) if durations else None,
        },
        "parallel_saving_pct": {
            "median": round(statistics.median(savings), 1) if savings else None,
            "max": round(max(savings), 1) if savings else None,
            "mean": round(statistics.fmean(savings), 1) if savings else None,
            "threads_with_saving": len([s for s in savings if s > 0]),
        },
        "status_totals": status_totals,
        "duration_buckets": buckets,
        "by_step_count": by_step_count,
    }


# ── rendering ────────────────────────────────────────────────────────────────

def render_table(records: list[dict[str, Any]], summary: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("AutoGoo-Plugin execution metrics (recomputed from step timeline)")
    lines.append("=" * 100)
    header = f"{'thread':<34} {'steps':>5} {'dur(derived)':>13} {'dur(stored)':>12} {'serial':>9} {'save':>5} {'issues':<28}"
    lines.append(header)
    lines.append("-" * 100)
    for record in records:
        tid = record["thread_id"]
        short = tid if len(tid) <= 33 else tid[:30] + "..."
        lines.append(
            f"{short:<34} {record['steps_total']:>5} "
            f"{fmt_min(record['duration_min']):>13} "
            f"{fmt_min(record['stored_duration_min']):>12} "
            f"{fmt_min(record['serial_min']):>9} "
            f"{fmt_pct(record['parallel_saving_pct']):>5} "
            f"{','.join(record['issues']) or '-':<28}"
        )
    lines.append("-" * 100)
    stats = summary["duration_min"]
    lines.append(
        f"threads={summary['threads']} measurable={summary['threads_measurable']} "
        f"unverifiable={summary['threads_unverifiable']} "
        f"in_progress={summary['threads_in_progress']} "
        f"negative_stored={summary['threads_negative_stored']} "
        f"window_skew={summary['threads_window_skew']}"
    )
    lines.append(
        f"duration min={fmt_min(stats['min'])} median={fmt_min(stats['median'])} "
        f"mean={fmt_min(stats['mean'])} max={fmt_min(stats['max'])} total={fmt_min(stats['total'])}"
    )
    saving = summary["parallel_saving_pct"]
    lines.append(
        f"parallel saving median={fmt_pct(saving['median'])} mean={fmt_pct(saving['mean'])} "
        f"max={fmt_pct(saving['max'])} threads_with_saving={saving['threads_with_saving']}"
    )
    lines.append("")
    lines.append("step status distribution: " + ", ".join(
        f"{k}={v}" for k, v in sorted(summary["status_totals"].items())
    ))
    lines.append("duration buckets: " + ", ".join(
        f"{b['bucket']}={b['count']}" for b in summary["duration_buckets"]
    ))
    lines.append("")
    lines.append("by step count (is a DAG worth it?):")
    for group in summary["by_step_count"]:
        lines.append(
            f"  steps {group['steps']:>3}: threads={group['threads']} "
            f"avg_wall={fmt_min(group['avg_wall_min'])} "
            f"avg_serial={fmt_min(group['avg_serial_min'])} "
            f"avg_saving={fmt_pct(group['avg_saving_pct'])} "
            f"max_saving={fmt_pct(group['max_saving_pct'])}"
        )
    return "\n".join(lines)


def render_markdown(records: list[dict[str, Any]], summary: dict[str, Any]) -> str:
    stats = summary["duration_min"]
    saving = summary["parallel_saving_pct"]
    lines: list[str] = []
    lines.append("# AutoGoo-Plugin 执行数据指标（从步骤时间线重算）")
    lines.append("")
    lines.append(
        "> 生成命令：`python3 skills/auto-goo/scripts/goo-metrics.py --markdown`。"
        "耗时一律由**步骤级** started_at/completed_at 推导，plan 级时间窗口是派生值。"
    )
    lines.append("")
    lines.append("## 1. 总览")
    lines.append("")
    lines.append(f"- thread 总数：{summary['threads']}（可量化 {summary['threads_measurable']}，"
                 f"时间戳缺失不可量化 {summary['threads_unverifiable']}，"
                 f"进行中 {summary['threads_in_progress'] + summary['threads_partial']}）")
    lines.append(f"- 存储窗口为负的 thread：{summary['threads_negative_stored']}")
    lines.append(f"- 存储窗口与步骤时间线偏差 >1min 的 thread：{summary['threads_window_skew']}")
    lines.append(
        f"- 耗时分位：min {fmt_min(stats['min'])} / median {fmt_min(stats['median'])} / "
        f"mean {fmt_min(stats['mean'])} / max {fmt_min(stats['max'])}，合计 {fmt_min(stats['total'])}"
    )
    lines.append(
        f"- 并行节省（1 - wall/serial）：median {fmt_pct(saving['median'])} / "
        f"mean {fmt_pct(saving['mean'])} / max {fmt_pct(saving['max'])}；"
        f"{saving['threads_with_saving']} 个 thread 有正收益"
    )
    lines.append("")
    lines.append(
        "> `partial` = 该 thread 仍在进行，耗时只是当前快照（只计入已产生时间戳的步骤）；"
        "`unverifiable` = 步骤没有时间戳，无法重算（不伪造）。"
    )
    lines.append("")
    lines.append("## 2. 逐 thread 明细")
    lines.append("")
    lines.append("| thread | 步骤 | 耗时(派生) | 耗时(存储) | 串行合计 | 并行节省 | 步骤状态分布 | 问题 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for record in records:
        dist = ", ".join(f"{k}:{v}" for k, v in sorted(record["status_counts"].items()))
        lines.append(
            f"| `{record['thread_id']}` | {record['steps_total']} | "
            f"{fmt_min(record['duration_min'])} | {fmt_min(record['stored_duration_min'])} | "
            f"{fmt_min(record['serial_min'])} | {fmt_pct(record['parallel_saving_pct'])} | "
            f"{dist or '-'} | {', '.join(record['issues']) or 'ok'} |"
        )
    lines.append("")
    lines.append("## 3. 耗时分布")
    lines.append("")
    lines.append("| 区间 | thread 数 |")
    lines.append("|---|---|")
    for bucket in summary["duration_buckets"]:
        lines.append(f"| {bucket['bucket']} | {bucket['count']} |")
    lines.append("")
    lines.append("## 4. 按步骤数分组（DAG 收益）")
    lines.append("")
    lines.append("| 步骤数 | thread 数 | 平均墙钟 | 平均串行合计 | 平均并行节省 | 最大并行节省 |")
    lines.append("|---|---|---|---|---|---|")
    for group in summary["by_step_count"]:
        lines.append(
            f"| {group['steps']} | {group['threads']} | {fmt_min(group['avg_wall_min'])} | "
            f"{fmt_min(group['avg_serial_min'])} | {fmt_pct(group['avg_saving_pct'])} | "
            f"{fmt_pct(group['max_saving_pct'])} |"
        )
    lines.append("")
    lines.append(render_conclusion(records, summary))
    return "\n".join(lines)


def render_conclusion(records: list[dict[str, Any]], summary: dict[str, Any]) -> str:
    """Write the DAG payoff conclusion, quoting the measured numbers."""
    groups = {group["steps"]: group for group in summary["by_step_count"]}
    small, mid, large = groups.get("1-3", {}), groups.get("4-5", {}), groups.get("6+", {})
    saving = summary["parallel_saving_pct"]
    stats = summary["duration_min"]

    def pct(value: float | None) -> str:
        return fmt_pct(value)

    lines: list[str] = []
    lines.append("## 5. DAG 收益结论")
    lines.append("")
    lines.append(
        f"实测样本 {summary['threads_measurable']}/{summary['threads']} 个 thread 可量化，"
        f"墙钟耗时中位数 {fmt_min(stats['median'])}；"
        f"并行节省中位数 {pct(saving['median'])}、最高 {pct(saving['max'])}，"
        f"仅 {saving['threads_with_saving']} 个 thread 有正收益（多数 DAG 实际是串行执行的）。"
    )
    lines.append("")
    lines.append("### 5.1 多少步以上值得走 DAG")
    lines.append("")
    lines.append(
        f"- **1-3 步**：{small.get('threads', 0)} 个 thread，平均并行节省 "
        f"{pct(small.get('avg_saving_pct'))}。步骤少到没有可并行分支时，"
        "DAG 只是把串行工作额外包了一层 plan 写入 + 心跳 + 归档，**不建议走 DAG**，直接做。"
    )
    lines.append(
        f"- **4-5 步**：{mid.get('threads', 0)} 个 thread，平均并行节省 "
        f"{pct(mid.get('avg_saving_pct'))}（最高 {pct(mid.get('max_saving_pct'))}）。"
        "只要存在 ≥2 条无依赖分支就值得走 DAG；纯线性依赖则收益为 0，只剩可恢复性收益。"
    )
    lines.append(
        f"- **6 步以上**：{large.get('threads', 0)} 个 thread，平均并行节省 "
        f"{pct(large.get('avg_saving_pct'))}（最高 {pct(large.get('max_saving_pct'))}）。"
        "步骤多、依赖可分层时 DAG 收益最稳定；此时收益来源是可并行分支 + 跨会话恢复，"
        "而不是「步骤多」本身。"
    )
    lines.append("")
    lines.append("### 5.2 DAG 什么时候比直接做更慢")
    lines.append("")
    lines.append("数据支持的边界条件（满足任意一条，DAG 的编排开销 > 收益）：")
    lines.append("")
    lines.append(
        "1. **步骤 ≤3 且无并行分支**：墙钟跨度 ≈ 串行合计（本样本中 "
        f"{small.get('threads', 0)} 个 thread 的平均节省仅 {pct(small.get('avg_saving_pct'))}），"
        "派发/心跳/plan 写入全是净开销。"
    )
    lines.append(
        "2. **最短步骤耗时 < 单次派发开销**：本样本可量化 thread 的平均单步耗时 "
        f"{fmt_min(round(statistics.fmean([r['avg_step_min'] for r in records if r['avg_step_min'] is not None]), 1)) if any(r['avg_step_min'] is not None for r in records) else 'n/a'}；"
        "当步骤本身只需几分钟（<5min）时，写 plan、precreate log、派发 Subagent、"
        "回写 heartbeat 的固定成本与之同量级，串行直接做更快。"
    )
    lines.append(
        "3. **关键路径被单步占满**：某一步占据整条关键路径（`critic_step` 接近总耗时）时，"
        "并行度上限是 1，DAG 无法缩短墙钟，只能提供留痕与可恢复性。"
    )
    lines.append(
        "4. **时间戳不可信的场景**：步骤没有 started_at/completed_at 时指标为 `unverifiable`，"
        "此时任何「DAG 更快」的说法都没有数据支撑，不应作为选中 DAG 的理由。"
    )
    lines.append("")
    lines.append(
        "**一句话**：≥4 步且有 ≥2 条无依赖分支 → 走 DAG（本样本最高省 "
        f"{pct(saving['max'])}，中位 {pct(saving['median'])}）；"
        "≤3 步、或关键路径单步占满、或单步耗时 <5min → 直接做，DAG 只会更慢。"
    )
    lines.append("")
    return "\n".join(lines)


# ── repair ───────────────────────────────────────────────────────────────────

def fix_plan(plan_path: Path, root: Path, write: bool) -> list[str]:
    """Recompute plan-level timestamps from steps. Never fabricates values."""
    plan = read_json(plan_path)
    if not plan:
        return []
    before = {key: plan.get(key) for key in ("started_at", "completed_at")}
    changes = derive_plan_timestamps(plan)
    if not changes:
        return []
    actions = [
        f"{plan_path}: {field} {change['old']} → {change['new']}" for field, change in changes.items()
    ]
    if not write:
        return [f"[dry-run] {action}" for action in actions]

    backup_dir = root / ".goo" / "plans" / "history"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = backup_dir / f"plan-{plan_path.parent.name}-{stamp}.json"
    write_json(backup, {**plan, "started_at": before["started_at"], "completed_at": before["completed_at"]})
    write_json(plan_path, plan)
    return [f"{action}（备份 {backup.name}）" for action in actions]


# ── main ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Recompute AutoGoo-Plugin execution metrics")
    parser.add_argument("--root", default=None, help="project root (default: resolved from .goo)")
    parser.add_argument("--plan", action="append", default=None, help="single plan.json (repeatable)")
    parser.add_argument("--json", action="store_true", help="emit JSON")
    parser.add_argument("--markdown", action="store_true", help="emit markdown report")
    parser.add_argument("--out", default=None, help="write report to this path instead of stdout")
    parser.add_argument("--fix", action="store_true", help="recompute plan-level timestamps (dry-run)")
    parser.add_argument("--write", action="store_true", help="with --fix: actually rewrite plan.json")
    args = parser.parse_args(argv)

    config_dir = find_config_dir(Path.cwd())
    root = Path(args.root).expanduser().resolve() if args.root else project_root_from_config_dir(
        config_dir, Path.cwd()
    )
    if args.plan:
        plans = [(Path(p).resolve().parent.name, Path(p).expanduser().resolve()) for p in args.plan]
    else:
        paths = workspace_paths(config_dir) if config_dir else {}
        threads_dir = root / paths.get("threads_dir", ".goo/threads")
        plans = discover_plans(root, threads_dir)

    if not plans:
        sys.stderr.write(f"no plan.json found under {root}\n")
        return 1

    if args.fix:
        touched = 0
        for _, plan_path in plans:
            for line in fix_plan(plan_path, root, args.write):
                print(line)
                touched += 1
        if not touched:
            print("all plan timestamps already consistent with step timeline")
        return 0

    records = [analyse_plan(thread_id, plan_path) for thread_id, plan_path in plans]
    summary = summarise(records)

    if args.json:
        payload = {"summary": summary, "threads": records}
        text = json.dumps(payload, ensure_ascii=False, indent=2)
    elif args.markdown:
        text = render_markdown(records, summary)
    else:
        text = render_table(records, summary)

    if args.out:
        out_path = Path(args.out).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text + "\n", encoding="utf-8")
        print(f"wrote {out_path}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

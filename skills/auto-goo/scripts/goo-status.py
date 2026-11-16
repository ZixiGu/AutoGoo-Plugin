#!/usr/bin/env python3
"""Render a clear AutoGoo-Plugin status dashboard from .goo/plan.json."""

from __future__ import annotations

from _paths import (
    compute_plan_status,
    derive_plan_timestamps,
    dump_json,
    find_config_dir,
    load_json,
    logs_dir_from_plan,
    project_root_from_config_dir,
    resolve_plan_path,
    workspace_paths,
)
import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WIDTH = 88
STALE_SECONDS = 120
LOG_REQUIRED_STATUSES = {"running", "blocked", "failed"}

def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = value.replace("Z", "+00:00")
    try:
        # Handle legacy hyphenated format: 2026-05-07T11-10-00
        if len(raw) == 19 and raw[10] == "T" and raw[13] == "-" and raw[16] == "-":
            raw = raw[:10] + "T" + raw[11:13] + ":" + raw[14:16] + ":" + raw[17:]
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def shorten(value: Any, limit: int = 34) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def bar(percent: int, width: int = 20) -> str:
    percent = max(0, min(100, percent))
    filled = round(width * percent / 100)
    return "█" * filled + "░" * (width - filled)


def output_preview(output: str | None) -> str:
    if not output:
        return "..."
    first = output.split(";")[0].strip()
    path = Path(first)
    if path.exists() and path.is_file():
        try:
            lines = sum(1 for _ in path.open("r", encoding="utf-8", errors="ignore"))
            return f"{lines}行"
        except OSError:
            return "存在"
    return "..."


def step_id(step: dict[str, Any]) -> str:
    value = step.get("id")
    return f"#{value}" if value is not None else "#?"


def id_key(value: Any) -> str:
    return str(value)


def dep_names(step: dict[str, Any], steps_by_id: dict[str, dict[str, Any]]) -> str:
    missing = []
    for dep in step.get("depends_on", []):
        dep_step = steps_by_id.get(id_key(dep))
        if not dep_step or dep_step.get("status") != "completed":
            missing.append(dep_step.get("name", str(dep)) if dep_step else str(dep))
    if not missing:
        return "就绪"
    if len(missing) > 2:
        return "等待 " + " ".join(missing[:2]) + f" +{len(missing) - 2}"
    return "等待 " + " ".join(missing)


def deps_completed(step: dict[str, Any], steps_by_id: dict[str, dict[str, Any]]) -> bool:
    for dep in step.get("depends_on", []):
        dep_step = steps_by_id.get(id_key(dep))
        if not dep_step or dep_step.get("status") != "completed":
            return False
    return True


def status_of(step: dict[str, Any]) -> str:
    return str(step.get("status", "pending") or "pending")


def collect_step_logs(logs_dir: Path) -> dict[str, list[Path]]:
    if not logs_dir.exists() or not logs_dir.is_dir():
        return {}
    by_step: dict[str, list[Path]] = {}
    for path in logs_dir.glob("*.md"):
        match = re.search(r"_step-([^_]+)_", path.name)
        if not match:
            continue
        by_step.setdefault(match.group(1), []).append(path)
    return by_step


def sync_thread_status(plan_path: Path) -> None:
    script = Path(__file__).with_name("thread-state.py")
    if not script.exists():
        return
    import subprocess

    subprocess.run(
        ["python3", str(script), "sync", "--plan", str(plan_path)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def log_preview(step: dict[str, Any], logs_by_step: dict[str, list[Path]]) -> str:
    paths = logs_by_step.get(id_key(step.get("id")), [])
    if not paths:
        return "log ..."
    latest = max(paths, key=lambda item: item.stat().st_mtime)
    return "log " + shorten(latest.name, 22)


def age_text(dt: datetime | None, now: datetime) -> str:
    if not dt:
        return "无心跳"
    seconds = max(0, int((now - dt).total_seconds()))
    if seconds < 60:
        return f"{seconds}s前"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}min前"
    return f"{minutes // 60}h{minutes % 60:02d}m前"


def print_rule(char: str = "─") -> None:
    print(char * WIDTH)


def print_step_line(prefix: str, step: dict[str, Any], detail: str) -> None:
    name = shorten(step.get("name"), 30)
    print(f"{prefix} {step_id(step):>4}  {name:<30}  {detail}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Render AutoGoo-Plugin status")
    parser.add_argument("--plan", default=".goo/plan.json", help="plan.json path")
    parser.add_argument("--update-status", action="store_true", help="auto-update plan status")
    parser.add_argument("--threads", action="store_true", help="list AutoGoo-Plugin threads")
    args = parser.parse_args()

    if args.threads:
        script = Path(__file__).with_name("thread-state.py")
        import subprocess

        raise SystemExit(subprocess.run(["python3", str(script), "list"]).returncode)

    plan_path = resolve_plan_path(args.plan)
    if not plan_path.exists():
        raise SystemExit(f"plan not found: {plan_path}")

    data = load_json(plan_path)
    if not isinstance(data, dict):
        raise SystemExit(f"invalid plan: {plan_path}")
    steps = data.get("steps", [])
    steps_by_id = {id_key(step.get("id")): step for step in steps if step.get("id") is not None}
    logs_dir = logs_dir_from_plan(plan_path)
    logs_by_step = collect_step_logs(logs_dir)
    now = datetime.now(timezone.utc)

    # Auto-update plan status if requested
    # 时间戳单一事实源 = 步骤级 started_at/completed_at；plan 时间窗口一律派生，
    # 不能再写 wall-clock now（否则重同步会把 started_at 推晚于步骤起始，算出负耗时）。
    repaired: dict[str, dict[str, Any]] = {}
    if args.update_status:
        new_status = compute_plan_status(data)
        data["status"] = new_status
        if new_status not in ("completed", "failed"):
            # 非终态时清掉遗留的 completed_at：否则 plan 窗口早于最后一步完成，
            # 耗时会算出偏小甚至为负的值。
            data["completed_at"] = None
        repaired = derive_plan_timestamps(data)
        if new_status == "running" and not data.get("started_at"):
            data["started_at"] = now.isoformat().replace("+00:00", "Z")
        if new_status in ("completed", "failed") and not data.get("completed_at"):
            data["completed_at"] = now.isoformat().replace("+00:00", "Z")
        dump_json(plan_path, data)
        sync_thread_status(plan_path)

    total = len(steps)
    completed = sum(1 for s in steps if s.get("status") == "completed")
    failed = sum(1 for s in steps if s.get("status") == "failed")
    approval_blocked = [s for s in steps if status_of(s) == "blocked"]
    running = [s for s in steps if status_of(s) == "running"]
    pending = [s for s in steps if status_of(s) == "pending"]
    ready = [s for s in pending if deps_completed(s, steps_by_id)]
    waiting = [s for s in pending if not deps_completed(s, steps_by_id)]
    known_statuses = {"pending", "running", "completed", "failed", "blocked"}
    other = [s for s in steps if status_of(s) not in known_statuses]
    avg = round(sum(int(s.get("progress", 100 if s.get("status") == "completed" else 0) or 0) for s in steps) / total) if total else 0
    task = data.get("task", "AutoGoo-Plugin")
    stored_plan_status = data.get("status")
    plan_status = compute_plan_status(data)
    max_concurrent = data.get("max_concurrent", data.get("execution", {}).get("max_concurrent", 6))

    status_icon = {"pending": "⏳", "running": "▶", "completed": "✅", "failed": "❌", "blocked": "⛔", "paused": "⏸"}.get(plan_status, "?")
    print("╔" + "═" * (WIDTH - 2) + "╗")
    print(f"║ {status_icon} AutoGoo-Plugin [{plan_status}]  {shorten(task, WIDTH - 38):<{WIDTH - 38}} {completed}/{total:>2} {avg:>3}% ║")
    print("╚" + "═" * (WIDTH - 2) + "╝")
    other_text = f" · other {len(other)}" if other else ""
    print(f"  {bar(avg, 30)}  completed {completed} · running {len(running)} · ready {len(ready)} · waiting {len(waiting)} · blocked {len(approval_blocked)} · failed {failed}{other_text} · slots {len(running)}/{max_concurrent}")

    warnings = []
    notices = []
    if stored_plan_status and stored_plan_status != plan_status:
        notices.append(f"plan 顶层 status={stored_plan_status} 与步骤状态推导={plan_status} 不一致；可用 --update-status 修正")
    for field, change in (repaired or {}).items():
        notices.append(
            f"plan.{field} 与步骤时间线不一致，已按步骤派生重算: {change.get('old')} → {change.get('new')}"
        )
    missing_completed_logs = 0
    if not logs_dir.exists():
        active_traceable = [s for s in steps if status_of(s) in LOG_REQUIRED_STATUSES]
        completed_traceable = [s for s in steps if status_of(s) == "completed"]
        if active_traceable:
            warnings.append(f"{logs_dir} 不存在；当前 plan 的执行留痕可能缺失")
        elif completed_traceable:
            notices.append(f"{logs_dir} 不存在；已完成步骤可能没有留存 step log")
    for step in steps:
        if status_of(step) == "failed":
            warnings.append(f"{step_id(step)} {step.get('name')} failed: {step.get('error', '见日志')}")
        if status_of(step) == "blocked":
            warnings.append(f"{step_id(step)} {step.get('name')} needs approval: {step.get('error', '见日志')}")
        if status_of(step) in LOG_REQUIRED_STATUSES and not logs_by_step.get(id_key(step.get("id"))):
            warnings.append(f"{step_id(step)} {step.get('name')} {status_of(step)} 但没有对应 step log")
        if status_of(step) == "completed" and not logs_by_step.get(id_key(step.get("id"))):
            missing_completed_logs += 1
        if status_of(step) == "running":
            hb = parse_time(step.get("heartbeat_at"))
            if not hb:
                warnings.append(f"{step_id(step)} {step.get('name')} running 但没有 heartbeat_at")
            elif (now - hb).total_seconds() >= STALE_SECONDS:
                warnings.append(f"{step_id(step)} {step.get('name')} 无心跳 {age_text(hb, now)}，可能已停止")
    if missing_completed_logs:
        notices.append(f"{missing_completed_logs} 个 completed step 没有对应 step log")

    print_rule()
    if warnings:
        print("Next: 先处理告警，再继续调度。")
    elif running:
        print("Next: 等待执行中步骤完成；完成后下游步骤会解锁。")
    elif ready:
        names = " / ".join(f"{step_id(s)} {shorten(s.get('name'), 18)}" for s in ready[:3])
        more = f" +{len(ready) - 3}" if len(ready) > 3 else ""
        print(f"Next: 可立即执行 {names}{more}")
    elif approval_blocked:
        print("Next: 存在权限阻塞，请由主 Agent 前台向用户申请许可。")
    elif waiting:
        print("Next: 暂无就绪步骤，等待前置依赖完成。")
    elif other:
        print("Next: 存在非标准状态步骤，请先检查或规范化 status。")
    else:
        print("Next: 所有步骤已完成。" if completed == total else "Next: 无可调度步骤，请检查 plan。")

    if running:
        print_rule()
        print(f"RUNNING ({len(running)})")
        for step in running:
            progress = int(step.get("progress", 0) or 0)
            hb = parse_time(step.get("heartbeat_at"))
            detail = f"{bar(progress, 16)} {progress:>3}% · output {output_preview(step.get('output'))} · hb {age_text(hb, now)} · {log_preview(step, logs_by_step)}"
            print_step_line("▶", step, detail)

    if ready:
        print_rule()
        print(f"READY ({len(ready)})")
        for step in ready[:8]:
            detail = f"{step.get('subagent', step.get('type', 'exec'))} · output {shorten(step.get('output'), 36)}"
            print_step_line("▷", step, detail)
        if len(ready) > 8:
            print(f"    ... {len(ready) - 8} more ready")

    if approval_blocked:
        print_rule()
        print(f"NEEDS APPROVAL ({len(approval_blocked)})")
        for step in approval_blocked[:8]:
            detail = shorten(step.get("error", "等待用户授权"), 76)
            print_step_line("⛔", step, detail)
        if len(approval_blocked) > 8:
            print(f"    ... {len(approval_blocked) - 8} more blocked")

    if waiting:
        print_rule()
        # C1 修复：依赖失败步骤的 waiting 步骤无法通过重试解锁，显式标注死锁
        failed_ids = {id_key(s.get("id")) for s in steps if status_of(s) == "failed" and s.get("id") is not None}
        dep_failed = [s for s in waiting if any(id_key(d) in failed_ids for d in s.get("depends_on", []))]
        if dep_failed:
            print(f"⚠️ {len(dep_failed)} 步因依赖失败而无法执行（死锁，需人工处理）：")
            for step in dep_failed[:8]:
                print_step_line("💀", step, "依赖失败 " + dep_names(step, steps_by_id))
            print_rule()
        print(f"WAITING ({len(waiting)})")
        for step in waiting[:8]:
            print_step_line("⏳", step, dep_names(step, steps_by_id))
        if len(waiting) > 8:
            print(f"    ... {len(waiting) - 8} more waiting")

    done = [s for s in steps if status_of(s) == "completed"]
    if done:
        print_rule()
        print(f"DONE ({len(done)})")
        recent = done[-6:]
        print("  " + " · ".join(f"{step_id(s)} {shorten(s.get('name'), 18)}" for s in recent))
        if len(done) > len(recent):
            print(f"  ... earlier {len(done) - len(recent)} completed")

    if other:
        print_rule()
        print(f"OTHER STATUS ({len(other)})")
        for step in other[:8]:
            detail = f"status={status_of(step)} · {dep_names(step, steps_by_id)}"
            print_step_line("?", step, detail)
        if len(other) > 8:
            print(f"    ... {len(other) - 8} more with non-standard status")

    if warnings:
        print_rule()
        print(f"WARNINGS ({len(warnings)})")
        for item in warnings:
            print(f"  ! {item}")

    if notices:
        print_rule()
        print(f"NOTICES ({len(notices)})")
        for item in notices:
            print(f"  - {item}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

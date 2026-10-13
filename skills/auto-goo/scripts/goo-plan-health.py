#!/usr/bin/env python3
"""AutoGoo-Plugin plan health — detect interrupted / out-of-sync DAG threads.

A DAG can stop mid-flight (session closed, subagent killed, user switched tasks)
and nobody notices: steps keep `running` with a dead heartbeat, a thread stays
`running` long after its plan finished, or the whole thread just sits untouched
for days.

**Threads matter.** A project holds many threads under `.goo/threads/<id>/`, and
exactly one is *current* (`.goo/current_thread.json`). Only the current thread may
be prompted with "continue or close"; older threads are a different decision
("clean up the stale ones?"). This script reports per-thread so the caller can
ask the right question.

States per thread:
  completed      plan finished and thread status agrees
  inconsistent   thread.json status and plan status disagree
                 (e.g. thread=running while its plan is already completed)
  needs-attention unfinished AND (stale running heartbeat | failed/interrupted/
                 blocked steps | untouched for longer than --stale-hours)
  healthy        unfinished but recently active
  no-plan        archived / no plan file (not reported unless --all)

Usage:
  goo-plan-health.py [--json] [--root DIR] [--all]
                     [--stale-hours N] [--stale-heartbeat-seconds N]
                     [--snooze] [--snooze-hours N] [--clear-snooze]
                     [--close --thread ID] [--close-reason TEXT]
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_STALE_HEARTBEAT_SECONDS = 900  # 与 status.ts / execute.ts 保持一致
DEFAULT_STALE_HOURS = 24
DEFAULT_SNOOZE_HOURS = 24
FINISHED_PLAN_STATES = {"completed", "closed", "abandoned"}
FINISHED_THREAD_STATES = {"completed", "archived", "closed", "abandoned"}
OPEN_STEP_STATES = {"pending", "running", "blocked", "interrupted", "failed"}
ATTENTION_STEP_STATES = {"interrupted", "failed", "blocked"}


def now() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso(moment: datetime | None) -> str | None:
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z") if moment else None


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def snooze_file(root: Path) -> Path:
    return root / ".goo" / "state" / "plan-health-notice.json"


def stale_threshold_seconds(plan: dict, override: float | None) -> float:
    if override is not None:
        return override
    execution = plan.get("execution") if isinstance(plan.get("execution"), dict) else {}
    value = execution.get("stale_after_seconds")
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    minutes = plan.get("heartbeat_timeout_min")
    if isinstance(minutes, (int, float)) and minutes > 0:
        return float(minutes) * 60
    return float(DEFAULT_STALE_HEARTBEAT_SECONDS)


def thread_fingerprint(thread_id: str, thread_status: str, plan: dict | None) -> str:
    steps = (plan or {}).get("steps") if isinstance((plan or {}).get("steps"), list) else []
    shape = "|".join(
        f"{s.get('id')}:{s.get('status')}:{s.get('progress')}" for s in steps if isinstance(s, dict)
    )
    raw = f"{thread_id}|{thread_status}|{(plan or {}).get('status')}|{(plan or {}).get('updated_at')}|{shape}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def resolve_thread_plan(root: Path, thread_dir: Path, meta: dict) -> Path | None:
    own = thread_dir / "plan.json"
    if own.is_file():
        return own
    candidate = meta.get("plan_path")
    if isinstance(candidate, str) and candidate:
        path = root / candidate
        if path.is_file():
            return path
    return None


def analyse_thread(root: Path, thread_dir: Path, is_current: bool,
                   stale_hours: float, heartbeat_override: float | None) -> dict:
    meta = read_json(thread_dir / "thread.json")
    thread_id = str(meta.get("id") or thread_dir.name)
    thread_status = str(meta.get("status") or "unknown")
    plan_path = resolve_thread_plan(root, thread_dir, meta)

    info: dict = {
        "id": thread_id,
        "title": meta.get("title"),
        "is_current": is_current,
        "thread_status": thread_status,
        "thread_dir": str(thread_dir.relative_to(root)) if str(thread_dir).startswith(str(root)) else str(thread_dir),
        "plan_path": str(plan_path.relative_to(root)) if plan_path else None,
    }

    if plan_path is None:
        info.update({"state": "no-plan", "needs_attention": False, "reasons": []})
        return info

    plan = read_json(plan_path)
    steps = [s for s in (plan.get("steps") or []) if isinstance(s, dict)]
    counts: dict[str, int] = {}
    for step in steps:
        key = str(step.get("status") or "pending")
        counts[key] = counts.get(key, 0) + 1

    plan_status = str(plan.get("status") or "pending")
    plan_finished = plan_status in FINISHED_PLAN_STATES or not any(
        str(s.get("status")) in OPEN_STEP_STATES for s in steps
    )
    thread_finished = thread_status in FINISHED_THREAD_STATES

    threshold = stale_threshold_seconds(plan, heartbeat_override)
    moment = now()

    stale_running: list[object] = []
    for step in steps:
        if step.get("status") != "running":
            continue
        beat = parse_time(step.get("heartbeat_at")) or parse_time(step.get("started_at"))
        if beat is None or (moment - beat).total_seconds() > threshold:
            stale_running.append(step.get("id"))

    attention_steps = [s.get("id") for s in steps if str(s.get("status")) in ATTENTION_STEP_STATES]

    last_touch = parse_time(plan.get("updated_at")) or parse_time(meta.get("updated_at")) or parse_time(meta.get("created_at"))
    if last_touch is None:
        for step in steps:
            for key in ("completed_at", "heartbeat_at", "started_at"):
                candidate = parse_time(step.get(key))
                if candidate and (last_touch is None or candidate > last_touch):
                    last_touch = candidate
    age_hours = round((moment - last_touch).total_seconds() / 3600, 2) if last_touch else None

    reasons: list[str] = []
    if plan_finished and not thread_finished:
        reasons.append(f"plan 已完成但 thread 状态仍为 {thread_status}")
    if not plan_finished and thread_finished:
        reasons.append(f"thread 已 {thread_status} 但 plan 仍有未完成步骤")
    if not plan_finished:
        if stale_running:
            reasons.append(f"心跳停滞的 running 步骤 {stale_running}")
        if attention_steps:
            reasons.append(f"需处理步骤 {attention_steps}")
        if age_hours is not None and age_hours >= stale_hours:
            reasons.append(f"已 {age_hours}h 未更新")

    if reasons:
        state = "inconsistent" if (plan_finished != thread_finished) else "needs-attention"
    elif not plan_finished:
        state = "healthy"
    else:
        state = "completed"

    info.update({
        "state": state,
        "needs_attention": state in {"inconsistent", "needs-attention"},
        "reasons": reasons,
        "plan_status": plan_status,
        "counts": counts,
        "stale_running_steps": stale_running,
        "attention_steps": attention_steps,
        "stale_heartbeat_seconds": threshold,
        "last_updated_at": iso(last_touch),
        "age_hours": age_hours,
        "task": plan.get("task"),
        "fingerprint": thread_fingerprint(thread_id, thread_status, plan),
    })
    return info


def evaluate(root: Path, stale_hours: float = DEFAULT_STALE_HOURS,
             heartbeat_override: float | None = None, include_all: bool = False) -> dict:
    threads_dir = root / ".goo" / "threads"
    current = read_json(root / ".goo" / "current_thread.json").get("thread_id")

    entries: list[dict] = []
    if threads_dir.is_dir():
        for thread_dir in sorted(p for p in threads_dir.iterdir() if p.is_dir()):
            entry = analyse_thread(root, thread_dir, thread_dir.name == current, stale_hours, heartbeat_override)
            if entry["state"] == "no-plan" and not include_all:
                continue
            entries.append(entry)

    snooze = read_json(snooze_file(root)).get("threads")
    snooze = snooze if isinstance(snooze, dict) else {}
    moment = now()
    for entry in entries:
        record = snooze.get(entry["id"])
        until = parse_time(record.get("snoozed_until")) if isinstance(record, dict) else None
        entry["snoozed"] = bool(
            until and isinstance(record, dict) and record.get("fingerprint") == entry.get("fingerprint") and until > moment
        )
        entry["snoozed_until"] = iso(until) if entry["snoozed"] else None

    active = next((e for e in entries if e["is_current"]), None)
    needing = [e for e in entries if e["needs_attention"] and not e["snoozed"]]
    other_needing = [e for e in needing if not e["is_current"]]

    return {
        "active_thread_id": current,
        "active": active,
        "threads": entries,
        "needs_attention": [e["id"] for e in needing],
        "active_needs_attention": bool(active and active["needs_attention"] and not active.get("snoozed")),
        "other_needing_attention": [e["id"] for e in other_needing],
        "stale_hours": stale_hours,
        "checked_at": now_iso(),
    }


def snooze(root: Path, thread_ids: list[str], hours: float) -> dict:
    current = read_json(snooze_file(root))
    threads = current.get("threads") if isinstance(current.get("threads"), dict) else {}
    until = iso(now() + timedelta(hours=max(0.0, hours)))
    report = evaluate(root)
    by_id = {e["id"]: e for e in report["threads"]}
    for thread_id in thread_ids:
        entry = by_id.get(thread_id)
        if entry:
            threads[thread_id] = {"fingerprint": entry.get("fingerprint"), "snoozed_until": until, "snoozed_at": now_iso()}
    write_json(snooze_file(root), {"threads": threads})
    return {"snoozed": thread_ids, "snoozed_until": until}


def clear_snooze(root: Path) -> bool:
    path = snooze_file(root)
    try:
        if path.exists():
            path.unlink()
            return True
    except OSError:
        pass
    return False


def close_thread(root: Path, thread_id: str, reason: str) -> dict:
    """Close one thread honestly: archive its plan, mark both records closed.

    Never deletes anything, never fabricates step completions — an abandoned
    thread must stay auditable.
    """
    threads_dir = root / ".goo" / "threads"
    thread_dir = threads_dir / thread_id
    if not thread_dir.is_dir():
        return {"closed": False, "reason": f"thread not found: {thread_id}"}

    meta_path = thread_dir / "thread.json"
    meta = read_json(meta_path)
    plan_path = resolve_thread_plan(root, thread_dir, meta)

    archived = None
    if plan_path is not None:
        plan = read_json(plan_path)
        if plan:
            history = root / ".goo" / "plans" / "history"
            history.mkdir(parents=True, exist_ok=True)
            archived = history / f"plan-{now().strftime('%Y%m%d-%H%M%S')}-{thread_id}.json"
            write_json(archived, plan)
            plan["status"] = "abandoned"
            plan["closed_at"] = now_iso()
            plan["close_reason"] = reason
            write_json(plan_path, plan)

    if meta:
        meta["status"] = "abandoned"
        meta["updated_at"] = now_iso()
        meta["closed_at"] = now_iso()
        meta["close_reason"] = reason
        write_json(meta_path, meta)

    index_path = threads_dir / "index.json"
    index = read_json(index_path)
    if isinstance(index.get("threads"), list):
        for item in index["threads"]:
            if isinstance(item, dict) and item.get("id") == thread_id:
                item["status"] = "abandoned"
                item["updated_at"] = now_iso()
        write_json(index_path, index)

    return {
        "closed": True,
        "thread_id": thread_id,
        "archived": str(archived) if archived else None,
        "plan_path": str(plan_path) if plan_path else None,
    }


def render(report: dict) -> str:
    active = report.get("active")
    lines: list[str] = []
    if active is None:
        lines.append("AutoGoo: 当前项目没有 thread/plan")
    else:
        counts = active.get("counts") or {}
        summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "无步骤"
        if active["state"] == "healthy":
            lines.append(f"AutoGoo: thread {active['id']} 进行中（{summary}）")
        elif active["needs_attention"]:
            lines.append(
                f"AutoGoo: ⚠ 当前 thread 可能已中断（{summary}；{'；'.join(active['reasons'])}）"
            )
            lines.append("AutoGoo:   继续 → /auto-goo:goo-continue　结束 → goo-plan-health.py --close --thread " + active["id"])
        elif active.get("snoozed"):
            lines.append(f"AutoGoo: thread {active['id']} 待确认（已 snooze 至 {active.get('snoozed_until')}）")
        else:
            lines.append(f"AutoGoo: thread {active['id']} 已结束（{active.get('plan_status')}）")

    others = [e for e in report.get("threads", []) if not e.get("is_current") and e.get("needs_attention")]
    if others:
        lines.append(f"AutoGoo:  另有 {len(others)} 个历史 thread 状态异常/未完成：")
        for entry in others[:5]:
            lines.append(f"AutoGoo:    - {entry['id']}（{'；'.join(entry['reasons'])}）")
        if len(others) > 5:
            lines.append(f"AutoGoo:    … 其余 {len(others) - 5} 个")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Classify AutoGoo-Plugin DAG threads")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--all", action="store_true", help="include threads without a plan")
    parser.add_argument("--stale-hours", type=float, default=DEFAULT_STALE_HOURS)
    parser.add_argument("--stale-heartbeat-seconds", type=float, default=None)
    parser.add_argument("--snooze", action="store_true", help="snooze every thread currently needing attention")
    parser.add_argument("--snooze-hours", type=float, default=DEFAULT_SNOOZE_HOURS)
    parser.add_argument("--clear-snooze", action="store_true")
    parser.add_argument("--close", action="store_true", help="close one thread (requires --thread)")
    parser.add_argument("--thread", default=None, help="thread id for --close")
    parser.add_argument("--close-reason", default="closed from plan-health prompt")
    args = parser.parse_args()

    root = args.root.expanduser()

    try:
        report = evaluate(
            root,
            stale_hours=args.stale_hours,
            heartbeat_override=args.stale_heartbeat_seconds,
            include_all=args.all,
        )
    except Exception as exc:  # never break a session start
        report = {"active": None, "threads": [], "error": f"{type(exc).__name__}: {exc}"}

    if args.close:
        if not args.thread:
            raise SystemExit("--close requires --thread <id>")
        report["close_result"] = close_thread(root, args.thread, args.close_reason)
        report = evaluate(root, stale_hours=args.stale_hours, heartbeat_override=args.stale_heartbeat_seconds,
                          include_all=args.all)
        report["close_result"] = {"thread_id": args.thread, "closed": True}
    elif args.clear_snooze:
        report["snooze_cleared"] = clear_snooze(root)
    elif args.snooze:
        targets = list(report.get("needs_attention") or [])
        report["snooze_result"] = snooze(root, targets, args.snooze_hours) if targets else {"snoozed": []}

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    elif not args.quiet:
        text = render(report)
        if text:
            print(text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

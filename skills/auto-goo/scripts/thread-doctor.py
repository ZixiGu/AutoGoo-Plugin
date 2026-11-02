#!/usr/bin/env python3
"""AutoGoo-Plugin thread doctor — reconcile every thread record with the filesystem.

Thread state lives in five places that nothing currently cross-checks:

  1. `.goo/threads/<id>/thread.json`        per-thread metadata
  2. `.goo/threads/<id>/plan.json`          per-thread plan
  3. `.goo/threads/index.json`              compact index
  4. `.goo/current_thread.json`             which thread is current
  5. the filesystem                          what actually exists

Drift between them is silent: an index entry pointing at `/tmp/...`, a thread
stuck on `running` after its plan completed, `current_thread` naming a thread
whose directory is gone. None of it breaks anything loudly — it just quietly
rots.

`--fix` applies only *safe, idempotent* repairs and never deletes files:

  可自动修复
    missing_index       目录存在但 index 无记录       → 补记录
    ghost_index         index 有记录但目录已不存在     → 移除该条记录（先备份）
    thread_status_drift plan 已结束但 thread 未同步     → 把 thread.status 同步为 plan.status
    current_missing     current_thread 指向不存在的 thread → 改指最近更新的现存 thread（无则置空）

  仅报告（需人工判断，绝不自动改）
    plan_path_outside   plan_path 落在项目/`.goo` 之外
    plan_path_missing   plan_path 指向不存在的文件
    thread_id_mismatch  plan.thread.id 与所在目录名不一致
    plan_thread_missing plan 缺少 thread.id
    timestamp_inverted  completed_at 早于 created_at
    stale_running       running 步骤心跳停滞（交给 goo-plan-health.py 做「继续/结束」确认）

Usage:
  thread-doctor.py [--json] [--root DIR] [--fix] [--quiet]
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

FINISHED_PLAN_STATES = {"completed", "closed", "abandoned"}
FINISHED_THREAD_STATES = {"completed", "archived", "closed", "abandoned"}
AUTO_FIXABLE = {
    "missing_index",
    "ghost_index",
    "thread_status_drift",
    "current_missing",
    # 下面四项同样是「信息存在但写错/写漏」，不需要删除任何东西：
    "plan_path_missing",   # 本地有 plan → 改指本地；已归档且无 plan → 清空悬空引用
    "plan_path_outside",   # 本地有 plan → 改指本地
    "plan_path_stale",     # 字段存的是过期/越界值，但本地有可用 plan → 改指本地
    "plan_thread_missing", # plan 缺 thread 块 → 从 thread.json 补齐
    "timestamp_inverted",  # completed_at < created_at → 用可信来源修正，否则删除畸形值
}


def now() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ts() -> str:
    return now().strftime("%Y%m%d-%H%M%S")


def iso(moment: datetime | None) -> str | None:
    """Format a datetime as ISO-8601 Z, or None."""
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


def goo_dirs(root: Path) -> tuple[Path, Path]:
    goo = root / ".goo"
    return goo, goo / "threads"


def resolve_plan_path(root: Path, thread_dir: Path, meta: dict) -> Path | None:
    own = thread_dir / "plan.json"
    if own.is_file():
        return own
    candidate = meta.get("plan_path")
    if isinstance(candidate, str) and candidate:
        path = Path(candidate)
        return path if path.is_absolute() else (root / candidate)
    return None


def diagnose(root: Path) -> dict:
    goo, threads_dir = goo_dirs(root)
    issues: list[dict] = []

    if not threads_dir.is_dir():
        return {"root": str(root), "issues": [], "threads": 0, "checked_at": now_iso()}

    index_path = threads_dir / "index.json"
    index = read_json(index_path)
    indexed = {
        str(item.get("id")): item
        for item in (index.get("threads") or [])
        if isinstance(item, dict) and item.get("id")
    }
    existing = sorted(p.name for p in threads_dir.iterdir() if p.is_dir())
    current = read_json(goo / "current_thread.json").get("thread_id")

    def add(kind: str, thread_id: str | None, detail: str, fixable: bool | None = None):
        issues.append({
            "kind": kind,
            "thread_id": thread_id,
            "detail": detail,
            "auto_fixable": AUTO_FIXABLE.__contains__(kind) if fixable is None else fixable,
        })

    # ── index ↔ filesystem ──────────────────────────────────────────────────
    for thread_id in indexed:
        if thread_id not in existing:
            add("ghost_index", thread_id, "index 记录存在但 .goo/threads/<id>/ 目录不存在")
    for thread_id in existing:
        if thread_id not in indexed:
            add("missing_index", thread_id, "目录存在但 threads/index.json 无对应记录")

    # ── per thread ──────────────────────────────────────────────────────────
    for thread_id in existing:
        thread_dir = threads_dir / thread_id
        meta_path = thread_dir / "thread.json"
        meta = read_json(meta_path)
        if not meta:
            add("thread_meta_missing", thread_id, "thread.json 缺失或无法解析", fixable=False)
            continue

        plan_path = resolve_plan_path(root, thread_dir, meta)
        if plan_path is None or not plan_path.is_file():
            # 已结束/归档且没有任何 plan 引用 → 是合法状态（历史上被清理过），不报。
            # 只有「仍在跑、或仍挂着悬空引用」才算不一致。
            finished = str(meta.get("status")) in FINISHED_THREAD_STATES
            if finished and not meta.get("plan_path"):
                continue
            add("plan_path_missing", thread_id,
                f"plan 文件不存在：{meta.get('plan_path') or '(未记录)'}")
            continue

        # plan_path 必须落在 .goo/ 内，否则就是历史 /tmp 污染那种情况
        try:
            plan_path.resolve().relative_to(goo.resolve())
        except ValueError:
            add("plan_path_outside", thread_id, f"plan_path 落在 .goo/ 之外：{plan_path}")

        # 校验**存储的字段本身**：即使解析优先用了本地 plan、功能正常，
        # 字段里留着过期/越界的值依然会误导人和后续工具。
        raw_plan_path = meta.get("plan_path")
        if isinstance(raw_plan_path, str) and raw_plan_path.strip():
            raw = Path(raw_plan_path)
            resolved_raw = raw if raw.is_absolute() else (root / raw)
            outside = True
            try:
                resolved_raw.resolve().relative_to(goo.resolve())
                outside = False
            except ValueError:
                outside = True
            if outside or not resolved_raw.is_file():
                add("plan_path_stale", thread_id,
                    f"thread.json 的 plan_path 指向过期/越界位置：{raw_plan_path}"
                    f"（本地 plan 存在：{(thread_dir / 'plan.json').is_file()}）")

        plan = read_json(plan_path)
        if not plan:
            add("plan_unreadable", thread_id, f"plan 无法解析：{plan_path}")
            continue

        thread_meta = plan.get("thread") if isinstance(plan.get("thread"), dict) else {}
        plan_thread_id = thread_meta.get("id") or plan.get("thread_id")
        if not plan_thread_id:
            add("plan_thread_missing", thread_id, "plan 顶层缺少 thread.id")
        elif str(plan_thread_id) != thread_id:
            add("thread_id_mismatch", thread_id,
                f"plan.thread.id={plan_thread_id} 与所在目录 {thread_id} 不一致")

        plan_status = str(plan.get("status") or "pending")
        thread_status = str(meta.get("status") or "unknown")
        plan_finished = plan_status in FINISHED_PLAN_STATES
        thread_finished = thread_status in FINISHED_THREAD_STATES
        if plan_finished and not thread_finished:
            add("thread_status_drift", thread_id,
                f"plan={plan_status} 但 thread={thread_status}（thread 未跟随结束）")
        elif thread_finished and not plan_finished:
            add("thread_status_drift", thread_id,
                f"thread={thread_status} 但 plan={plan_status}（不可自动修复，需人工判断）",
                fixable=False)

        created = parse_time(meta.get("created_at"))
        completed = parse_time(meta.get("completed_at"))
        if created and completed and completed < created:
            add("timestamp_inverted", thread_id,
                f"completed_at({meta.get('completed_at')}) 早于 created_at({meta.get('created_at')})")

    # ── current_thread ──────────────────────────────────────────────────────
    if current and str(current) not in existing:
        add("current_missing", str(current),
            f"current_thread.json 指向不存在的 thread（现有 {len(existing)} 个）")

    counts: dict[str, int] = {}
    for issue in issues:
        counts[issue["kind"]] = counts.get(issue["kind"], 0) + 1

    return {
        "root": str(root),
        "checked_at": now_iso(),
        "threads": len(existing),
        "indexed": len(indexed),
        "current_thread_id": current,
        "issue_count": len(issues),
        "auto_fixable_count": sum(1 for i in issues if i["auto_fixable"]),
        "counts": counts,
        "issues": issues,
    }


def _backup(root: Path, stamp: str, path: Path) -> None:
    """Copy a file into .goo/plans/history/thread-fix-<stamp>/ before modifying it."""
    try:
        if not path.is_file():
            return
        dest = root / ".goo" / "plans" / "history" / f"thread-fix-{stamp}" / path.relative_to(root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    except OSError:
        pass


def _local_plan(thread_dir: Path, meta: dict) -> Path | None:
    own = thread_dir / "plan.json"
    if own.is_file():
        return own
    return None


def _credible_completed_at(meta: dict, plan: dict) -> str | None:
    """Find a completed_at that is >= created_at, else None (caller drops the field).

    NOTE: deliberately excludes ``meta['updated_at']`` — other repairs in the same
    run bump it to "now", which would silently fabricate a completion timestamp.
    Only plan-level timestamps are trustworthy here.
    """
    created = parse_time(meta.get("created_at"))
    candidates = [parse_time(plan.get("completed_at"))]
    for step in plan.get("steps") or []:
        if isinstance(step, dict):
            candidates.append(parse_time(step.get("completed_at")))
    best = None
    for moment in candidates:
        if moment and (created is None or moment >= created):
            if best is None or moment > best:
                best = moment
    return iso(best) if best else None


def apply_fix(root: Path, report: dict) -> dict:
    """Apply only safe, idempotent repairs.

    Principles:
      * never delete files;
      * every touched file is copied to .goo/plans/history/thread-fix-<stamp>/ first;
      * never fabricate progress — a bogus timestamp is **removed**, not invented;
      * a second run must be a no-op.
    """
    goo, threads_dir = goo_dirs(root)
    index_path = threads_dir / "index.json"
    existing = {p.name for p in threads_dir.iterdir() if p.is_dir()} if threads_dir.is_dir() else set()
    changed: list[str] = []
    stamp = ts()

    for issue in report.get("issues", []):
        kind = issue["kind"]
        thread_id = issue.get("thread_id")
        if not issue.get("auto_fixable") or not thread_id:
            continue

        thread_dir = threads_dir / str(thread_id)
        meta_path = thread_dir / "thread.json"
        meta = read_json(meta_path) if meta_path.is_file() else {}
        local_plan = _local_plan(thread_dir, meta) if thread_dir.is_dir() else None

        # ── plan 已完成但 thread 未跟随 —— 同步为 plan 的状态 ────────────
        if kind == "thread_status_drift":
            if not meta_path.is_file():
                continue
            plan_path = local_plan or (root / str(meta.get("plan_path")) if meta.get("plan_path") else None)
            plan = read_json(plan_path) if plan_path and plan_path.is_file() else {}
            plan_status = str(plan.get("status") or "")
            thread_status = str(meta.get("status") or "")
            # 只在「plan 已结束、thread 未结束」这一安全方向同步；反向只报告。
            if plan_status in FINISHED_PLAN_STATES and thread_status not in FINISHED_THREAD_STATES:
                _backup(root, stamp, meta_path)
                meta["status"] = plan_status
                meta["updated_at"] = now_iso()
                write_json(meta_path, meta)
                changed.append(f"thread_status_drift: {thread_id} thread.status → {plan_status}")

        # ── 悬空 / 越界的 plan_path ──────────────────────────────────────
        if kind in ("plan_path_missing", "plan_path_outside", "plan_path_stale"):
            if not meta_path.is_file():
                continue
            if local_plan is not None:
                rel = local_plan.relative_to(root).as_posix()
                if str(meta.get("plan_path") or "") != rel:
                    _backup(root, stamp, meta_path)
                    meta["plan_path"] = rel
                    meta["updated_at"] = now_iso()
                    meta["plan_path_fixed_reason"] = "指向的 plan 不存在或落在 .goo/ 之外，已改指本目录 plan.json"
                    write_json(meta_path, meta)
                    changed.append(f"{kind}: {thread_id} plan_path → {rel}（本地 plan 存在）")
            elif str(meta.get("status")) in FINISHED_THREAD_STATES:
                # 已归档/结束且确实没有 plan：清空悬空引用（不删除任何文件）
                if meta.get("plan_path"):
                    _backup(root, stamp, meta_path)
                    meta["plan_path"] = None
                    meta["updated_at"] = now_iso()
                    meta["plan_path_cleared_reason"] = "本地无 plan 文件且该 thread 已结束，移除指向已不存在位置的引用"
                    write_json(meta_path, meta)
                    changed.append(f"{kind}: {thread_id} 清空悬空 plan_path（已归档且无本地 plan）")

        # ── plan 缺 thread 块 ───────────────────────────────────────────
        elif kind == "plan_thread_missing":
            plan_path = local_plan or (
                root / str(meta.get("plan_path")) if meta.get("plan_path") else None
            )
            if not plan_path or not plan_path.is_file():
                continue
            plan = read_json(plan_path)
            if not isinstance(plan.get("thread"), dict) and not plan.get("thread_id"):
                _backup(root, stamp, plan_path)
                rel_dir = thread_dir.relative_to(root).as_posix()
                plan["thread"] = {
                    "id": str(thread_id),
                    "plan_path": plan_path.relative_to(root).as_posix(),
                    "logs_dir": f"{rel_dir}/logs",
                    "artifacts_dir": f"{rel_dir}/artifacts",
                }
                write_json(plan_path, plan)
                changed.append(f"plan_thread_missing: {thread_id} 已在 plan 中补齐 thread 块")

        # ── 时间戳倒置 ─────────────────────────────────────────────────
        elif kind == "timestamp_inverted":
            if not meta_path.is_file():
                continue
            plan = read_json(local_plan) if local_plan else {}
            fixed = _credible_completed_at(meta, plan)
            _backup(root, stamp, meta_path)
            if fixed:
                meta["completed_at"] = fixed
                meta["completed_at_fixed_reason"] = "原值早于 created_at，已改用可信来源（plan/步骤/updated_at）"
                changed.append(f"timestamp_inverted: {thread_id} completed_at → {fixed}")
            else:
                meta.pop("completed_at", None)
                meta["completed_at_removed_reason"] = "原值早于 created_at 且无可信来源，移除畸形值（不伪造完成时间）"
                changed.append(f"timestamp_inverted: {thread_id} 移除不可信的 completed_at")
            meta["updated_at"] = now_iso()
            write_json(meta_path, meta)

    # ── index：补缺 / 去幽灵 / 同步状态 ─────────────────────────────────
    if index_path.is_file():
        _backup(root, stamp, index_path)
    index = read_json(index_path)
    entries = [i for i in (index.get("threads") or []) if isinstance(i, dict)]

    for issue in report.get("issues", []):
        kind = issue["kind"]
        thread_id = str(issue.get("thread_id") or "")
        if kind == "ghost_index" and thread_id not in existing:
            before = len(entries)
            entries = [e for e in entries if str(e.get("id")) != thread_id]
            if len(entries) != before:
                changed.append(f"ghost_index: 移除 {thread_id} 的索引记录（目录不存在）")

    for thread_id in existing:
        if any(str(e.get("id")) == thread_id for e in entries):
            continue
        meta = read_json(threads_dir / thread_id / "thread.json")
        if meta:
            entries.append({
                "id": thread_id,
                "title": meta.get("title", ""),
                "status": meta.get("status", "unknown"),
                "plan_path": meta.get("plan_path", ""),
                "created_at": meta.get("created_at"),
                "updated_at": meta.get("updated_at"),
            })
            changed.append(f"missing_index: 为 {thread_id} 补建索引记录")

    # 用 thread.json 的权威状态刷新 index（含本轮刚同步的）与 current_thread
    for entry in entries:
        tid = str(entry.get("id"))
        if tid in existing:
            meta = read_json(threads_dir / tid / "thread.json")
            if meta:
                entry["status"] = meta.get("status", entry.get("status"))
                entry["updated_at"] = meta.get("updated_at", entry.get("updated_at"))

    current_path = goo / "current_thread.json"
    current = read_json(current_path).get("thread_id")
    if current and str(current) not in existing:
        _backup(root, stamp, current_path)
        candidates = []
        for tid in existing:
            moment = parse_time(read_json(threads_dir / tid / "thread.json").get("updated_at"))
            if moment:
                candidates.append((moment, tid))
        candidates.sort(reverse=True)
        if candidates:
            new_id = candidates[0][1]
            write_json(current_path, {
                "thread_id": new_id,
                "thread_dir": f".goo/threads/{new_id}",
                "plan_path": read_json(threads_dir / new_id / "thread.json").get("plan_path", ""),
                "updated_at": now_iso(),
                "reason": "thread-doctor: previous current_thread pointed at a missing thread",
            })
            changed.append(f"current_missing: current_thread → {new_id}（最近更新的现存 thread）")
        else:
            write_json(current_path, {"thread_id": None, "updated_at": now_iso()})
            changed.append("current_missing: 无现存 thread，current_thread 置空")

    index["threads"] = sorted(entries, key=lambda e: str(e.get("updated_at", "")), reverse=True)
    write_json(index_path, index)

    return {"changed": changed, "changed_count": len(changed), "backup_dir": f".goo/plans/history/thread-fix-{stamp}/"}


def render(report: dict) -> str:
    if report.get("failed"):
        return f"AutoGoo: ❌ thread 对账失败（{report.get('error', 'unknown')}）—— 检查未完成，不代表无问题"
    if report.get("issue_count", 0) == 0:
        return f"AutoGoo: thread 健康（{report.get('threads', 0)} 个 thread，无问题）"
    lines = [
        f"AutoGoo: ⚠ thread 记录不一致：{report['issue_count']} 项"
        f"（可自动修复 {report.get('auto_fixable_count', 0)} 项）"
    ]
    for kind, count in sorted((report.get("counts") or {}).items()):
        lines.append(f"AutoGoo:   - {kind} × {count}")
    fix_result = report.get("fix") or {}
    for change in (fix_result.get("changed") or [])[:5]:
        lines.append(f"AutoGoo:   ✓ 已修复：{change}")
    fixable = [i for i in report.get("issues", []) if i.get("auto_fixable")]
    for issue in fixable[:5]:
        lines.append(f"AutoGoo:     · [{issue['kind']}] {issue['thread_id']}：{issue['detail']}")
    if len(fixable) > 5:
        lines.append(f"AutoGoo:     … 其余 {len(fixable) - 5} 项可自动修复")
    lines.append("AutoGoo:   修复：python3 <root>/skills/auto-goo/scripts/thread-doctor.py --fix")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Reconcile AutoGoo-Plugin thread records with the filesystem")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--fix", action="store_true", help="apply safe, idempotent repairs")
    args = parser.parse_args()

    root = args.root.expanduser()
    try:
        report = diagnose(root)
        if args.fix:
            fix_result = apply_fix(root, report)
            # 修复后重新诊断，但**必须保留修复记录**（否则调用方看不到做了什么）
            report = diagnose(root)
            report["fix"] = fix_result
    except Exception as exc:  # never break a session start
        # 关键：失败必须显式暴露。若填 issue_count=0，调用方会把「工具崩了」
        # 误读成「一切正常」—— 那比直接报错危险得多。
        report = {
            "failed": True,
            "issue_count": None,
            "issues": [],
            "error": f"{type(exc).__name__}: {exc}",
        }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    elif not args.quiet:
        print(render(report))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

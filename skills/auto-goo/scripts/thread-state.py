#!/usr/bin/env python3
"""Create and update AutoGoo-Plugin thread metadata."""

from __future__ import annotations

from _paths import (
    compute_plan_status,
    dump_json,
    find_config_dir,
    load_json,
    now,
    project_root_from_config_dir,
    stamp,
    workspace_path,
    workspace_paths,
)
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def slugify(value: str, limit: int = 42) -> str:
    text = value.strip().lower()
    text = re.sub(r"[^\w.\-]+", "-", text, flags=re.UNICODE)
    text = re.sub(r"-{2,}", "-", text).strip("-_.")
    return (text or "thread")[:limit].strip("-_.") or "thread"


def display_path(config_dir: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(project_root_from_config_dir(config_dir, Path.cwd())).as_posix()
    except ValueError:
        return path.as_posix()


def config_dir_from_plan(plan_path: Path) -> Path:
    return find_config_dir(plan_path)


def resolve_plan_path(config_dir: Path, value: str) -> Path:
    plan_path = Path(value)
    if plan_path.exists() or value != ".goo/plan.json":
        return plan_path
    return workspace_path(config_dir, "compat_plan_file")


def thread_dir(goo_dir: Path, thread_id: str) -> Path:
    if not thread_id or "/" in thread_id or "\\" in thread_id or ".." in thread_id:
        raise ValueError(f"invalid thread_id: {thread_id!r}")
    return workspace_path(goo_dir, "threads_dir") / thread_id


def current_thread_id(goo_dir: Path) -> str | None:
    data = load_json(workspace_path(goo_dir, "current_thread_file"), {})
    value = data.get("thread_id")
    return str(value) if value else None


def unique_thread_id(goo_dir: Path, title: str) -> str:
    base = f"tg-{stamp()}-{slugify(title)}"
    candidate = base
    index = 1
    while thread_dir(goo_dir, candidate).exists():
        index += 1
        candidate = f"{base}-{index}"
    return candidate


def ensure_index(goo_dir: Path) -> dict[str, Any]:
    path = workspace_path(goo_dir, "threads_dir") / "index.json"
    return load_json(path, {"threads": []})


def write_index(goo_dir: Path, index: dict[str, Any]) -> None:
    dump_json(workspace_path(goo_dir, "threads_dir") / "index.json", index)


def upsert_index(index: dict[str, Any], meta: dict[str, Any]) -> None:
    threads = [item for item in index.get("threads", []) if isinstance(item, dict)]
    compact = {
        "id": meta["id"],
        "title": meta.get("title", ""),
        "status": meta.get("status", "planning"),
        "plan_path": meta.get("plan_path", ""),
        "created_at": meta.get("created_at"),
        "updated_at": meta.get("updated_at"),
    }
    for pos, item in enumerate(threads):
        if item.get("id") == meta["id"]:
            threads[pos] = {**item, **compact}
            break
    else:
        threads.append(compact)
    index["threads"] = sorted(threads, key=lambda item: str(item.get("updated_at", "")), reverse=True)


def create_thread(goo_dir: Path, title: str, runtime: str = "claude-code", thread_id: str | None = None) -> dict[str, Any]:
    thread_id = thread_id or unique_thread_id(goo_dir, title)
    tdir = thread_dir(goo_dir, thread_id)
    tdir.mkdir(parents=True, exist_ok=True)
    for child in ("logs", "artifacts", "reports"):
        (tdir / child).mkdir(parents=True, exist_ok=True)
    created = now()
    meta = {
        "id": thread_id,
        "title": title,
        "status": "planning",
        "runtime": runtime,
        "created_at": created,
        "updated_at": created,
        "active_plan": "plan.json",
        "plan_path": display_path(goo_dir, tdir / "plan.json"),
        "brainstorm_path": display_path(goo_dir, tdir / "brainstorm.json"),
        "logs_dir": display_path(goo_dir, tdir / "logs"),
        "artifacts_dir": display_path(goo_dir, tdir / "artifacts"),
        "reports_dir": display_path(goo_dir, tdir / "reports"),
        "archive": {},
    }
    dump_json(tdir / "thread.json", meta)
    index = ensure_index(goo_dir)
    upsert_index(index, meta)
    write_index(goo_dir, index)
    set_current(goo_dir, thread_id)
    return meta


def set_current(goo_dir: Path, thread_id: str, *, sync_compat: bool = True) -> None:
    """Point current_thread.json at *thread_id*.

    When *sync_compat* is true (the `set-current` CLI path), also copy the
    thread's own plan into the compat entry `.goo/plan.json`, because
    /goo-status, /goo-continue and /goo-observe read the compat entry — switching
    only current_thread.json leaves them driving the *previous* thread.

    `sync_from_plan()` passes sync_compat=False: it manages the compat entry
    itself, and letting set_current copy the (possibly stale) thread plan over a
    freshly written compat entry would silently revert DAG progress.
    """
    tdir = thread_dir(goo_dir, thread_id)
    meta_path = tdir / "thread.json"
    if not meta_path.exists():
        raise SystemExit(f"thread not found: {thread_id}")
    meta = load_json(meta_path, {})
    dump_json(
        workspace_path(goo_dir, "current_thread_file"),
        {
            "thread_id": thread_id,
            "thread_dir": display_path(goo_dir, tdir),
            "plan_path": meta.get("plan_path") or display_path(goo_dir, tdir / "plan.json"),
            "updated_at": now(),
        },
    )
    if not sync_compat:
        return
    # 兼容入口 .goo/plan.json 必须跟着切，否则读兼容入口的命令会继续推旧计划。
    compat = workspace_path(goo_dir, "compat_plan_file")
    own_plan = tdir / "plan.json"
    if own_plan.is_file():
        try:
            plan = load_json(own_plan, {})
        except (OSError, ValueError):
            plan = {}
        if plan:
            dump_json(compat, plan)
            return
    # 没有自己的 plan（例如已归档）：不动兼容入口，但要说清楚。
    print(
        f"warning: thread {thread_id} 没有自己的 plan.json，已切换 current_thread，"
        f"但兼容入口 {display_path(goo_dir, compat)} 保持原样",
        file=sys.stderr,
    )


def sync_compat_plan(goo_dir: Path, plan_path: Path, plan: dict[str, Any]) -> None:
    compat_path = workspace_path(goo_dir, "compat_plan_file")
    try:
        if plan_path.resolve() == compat_path.resolve():
            return
    except FileNotFoundError:
        pass
    threads_dir = workspace_path(goo_dir, "threads_dir").resolve()
    try:
        plan_path.resolve().relative_to(threads_dir)
    except ValueError:
        return
    dump_json(compat_path, plan)


def resolve_thread(goo_dir: Path, thread_id: str | None, plan_path: Path | None = None) -> str | None:
    if thread_id:
        return thread_id
    if plan_path and plan_path.exists():
        try:
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            plan = {}
        meta = plan.get("thread")
        if isinstance(meta, dict) and meta.get("id"):
            return str(meta["id"])
        if plan.get("thread_id"):
            return str(plan["thread_id"])
    return current_thread_id(goo_dir)


def is_compat_plan(goo_dir: Path, plan_path: Path) -> bool:
    try:
        return plan_path.resolve() == workspace_path(goo_dir, "compat_plan_file").resolve()
    except FileNotFoundError:
        return False


def sync_from_plan(
    plan_path: Path,
    thread_id: str | None = None,
    *,
    make_current: bool = False,
    goo_dir_override: Path | None = None,
) -> dict[str, Any]:
    plan = load_json(plan_path, {})
    goo_dir = goo_dir_override or config_dir_from_plan(plan_path)
    resolved = resolve_thread(goo_dir, thread_id, plan_path)
    if not resolved:
        return {}
    tdir = thread_dir(goo_dir, resolved)
    meta = load_json(tdir / "thread.json", {})
    if not meta:
        meta = create_thread(goo_dir, plan.get("task", resolved), thread_id=resolved)
    status = compute_plan_status(plan)
    updated = now()
    meta.update(
        {
            "id": resolved,
            "title": meta.get("title") or plan.get("task", resolved),
            "status": status,
            "updated_at": updated,
            "active_plan": plan_path.name,
            "plan_path": relative_to_goo_parent(goo_dir, plan_path),
            "started_at": plan.get("started_at") or meta.get("started_at"),
            "completed_at": plan.get("completed_at") or meta.get("completed_at"),
        }
    )
    archive = plan.get("archive")
    if isinstance(archive, dict):
        meta["archive"] = {**meta.get("archive", {}), **archive}
    dump_json(tdir / "thread.json", meta)
    index = ensure_index(goo_dir)
    upsert_index(index, meta)
    current = current_thread_id(goo_dir)
    should_update_current = make_current or is_compat_plan(goo_dir, plan_path) or not current or current == resolved
    if should_update_current:
        index["current_thread_id"] = resolved
    write_index(goo_dir, index)
    if should_update_current:
        # sync_compat=False：本函数自己负责写完兼容入口，见 set_current 的注释
        set_current(goo_dir, resolved, sync_compat=False)
        sync_compat_plan(goo_dir, plan_path, plan)
        # 当入参是 compat plan 时,把最新 plan 状态同步回 thread plan(真正的源),
        # 避免 thread plan 的 steps 停留在早期状态。
        # 修复(2026-08-14): 原来 `if thread_plan.exists()` 在 thread plan 从未创建时
        # 不写回 → DAG 状态工具与 plan.json 同步问题(线程内无 plan 快照)。
        if is_compat_plan(goo_dir, plan_path):
            thread_plan = tdir / meta.get("active_plan", "plan.json")
            if (not thread_plan.exists() or thread_plan.resolve() != plan_path.resolve()) and plan.get("steps"):
                dump_json(thread_plan, plan)
    return meta


def relative_to_goo_parent(goo_dir: Path, path: Path) -> str:
    return display_path(goo_dir, path)


def list_threads(goo_dir: Path) -> int:
    index = ensure_index(goo_dir)
    current = current_thread_id(goo_dir)
    threads = [item for item in index.get("threads", []) if isinstance(item, dict)]
    if not threads:
        print("No AutoGoo-Plugin threads found.")
        return 0
    print("AutoGoo-Plugin threads")
    for item in threads:
        mark = "*" if item.get("id") == current else " "
        print(
            f"{mark} {item.get('id')} [{item.get('status', 'unknown')}] "
            f"{item.get('title', '')} · {item.get('updated_at', '')}"
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage AutoGoo-Plugin thread metadata")
    parser.add_argument("--goo-dir", default=".goo", help="AutoGoo-Plugin state directory")
    sub = parser.add_subparsers(dest="cmd", required=True)

    create = sub.add_parser("create", help="create a thread")
    create.add_argument("--title", required=True)
    create.add_argument("--id", dest="thread_id")
    create.add_argument("--runtime", default="claude-code")

    current = sub.add_parser("set-current", help="set current thread")
    current.add_argument("--id", dest="thread_id", required=True)

    sync = sub.add_parser("sync", help="sync thread metadata from plan")
    sync.add_argument("--plan", default=".goo/plan.json")
    sync.add_argument("--id", dest="thread_id")
    sync.add_argument("--set-current", action="store_true", help="also make this plan's thread current")

    sub.add_parser("list", help="list threads")

    args = parser.parse_args()
    goo_dir = find_config_dir(Path(args.goo_dir))
    goo_dir.mkdir(parents=True, exist_ok=True)

    if args.cmd == "create":
        meta = create_thread(goo_dir, args.title, args.runtime, args.thread_id)
        print(meta["id"])
        return 0
    if args.cmd == "set-current":
        set_current(goo_dir, args.thread_id)
        print(f"current thread: {args.thread_id}")
        return 0
    if args.cmd == "sync":
        meta = sync_from_plan(
            resolve_plan_path(goo_dir, args.plan),
            args.thread_id,
            make_current=args.set_current,
            goo_dir_override=goo_dir,
        )
        if meta:
            print(f"synced thread {meta.get('id')}: status={meta.get('status')}")
        return 0
    if args.cmd == "list":
        return list_threads(goo_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

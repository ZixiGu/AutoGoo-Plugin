#!/usr/bin/env python3
"""goo-thread — unified management for AutoGoo-Plugin threads.

Thread state used to be spread across four scripts (thread-state.py,
init-plan.sh, goo-plan-health.py, thread-doctor.py) with two implicit
interactions inside /goo-plan. This is the single entry point.

Subcommands:
  list                    all threads: current marker, status, health, step progress
  show <id>               one thread in detail (plan summary, paths, health reasons)
  switch <id>             make it current **and sync the compat entry** (.goo/plan.json)
  new "<title>"           create a thread (optionally with an initial plan)
  close <id>              archive and close (delegates to goo-plan-health.py --close)
  doctor [--fix]          reconcile records (delegates to thread-doctor.py)
  health                  per-thread health report (delegates to goo-plan-health.py)

Design notes:
  * pure delegation — no duplicated business logic;
  * `switch` is the only operation that rewrites the compat entry, and it does so
    atomically with current_thread.json (switching only one of them was the #1
    operational trap: /goo-status and /goo-continue read the compat entry);
  * read-only by default; mutating subcommands are explicit and reversible.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
FINISHED_THREAD_STATES = {"completed", "archived", "closed", "abandoned"}
FINISHED_PLAN_STATES = {"completed", "closed", "abandoned"}
OPEN_STEP_STATES = {"pending", "running", "blocked", "interrupted", "failed"}


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def goo_dir(root: Path) -> Path:
    return root / ".goo"


def run_script(name: str, args: list[str], root: Path) -> tuple[int, str, str]:
    """Delegate to a sibling script. Returns (exit_code, stdout, stderr).

    Interpreter is chosen by extension: `.sh` → bash, everything else → python3.
    (Using sys.executable for init-plan.sh produced a SyntaxError — it is bash.)
    """
    script = SCRIPTS / name
    if not script.is_file():
        return 127, "", f"{name} not found"
    launcher = ["bash", str(script)] if script.suffix == ".sh" else [sys.executable, str(script)]
    try:
        proc = subprocess.run(
            [*launcher, *args],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(root),
        )
        return proc.returncode, proc.stdout, proc.stderr
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, "", f"{type(exc).__name__}: {exc}"


def thread_rows(root: Path) -> list[dict]:
    """Collect a compact row per thread (id, title, status, plan status, progress)."""
    threads_dir = goo_dir(root) / "threads"
    if not threads_dir.is_dir():
        return []
    current = read_json(goo_dir(root) / "current_thread.json").get("thread_id")
    rows: list[dict] = []
    for path in sorted(p for p in threads_dir.iterdir() if p.is_dir()):
        meta = read_json(path / "thread.json")
        plan_path = path / "plan.json"
        if not plan_path.is_file():
            raw = meta.get("plan_path")
            if isinstance(raw, str) and raw:
                candidate = Path(raw)
                candidate = candidate if candidate.is_absolute() else (root / raw)
                if candidate.is_file():
                    plan_path = candidate
        plan = read_json(plan_path) if plan_path.is_file() else {}
        steps = [s for s in (plan.get("steps") or []) if isinstance(s, dict)]
        done = sum(1 for s in steps if str(s.get("status")) == "completed")
        rows.append({
            "id": path.name,
            "title": meta.get("title") or "",
            "status": str(meta.get("status") or "unknown"),
            "plan_status": str(plan.get("status") or "-"),
            "steps": f"{done}/{len(steps)}" if steps else "-",
            "has_plan": plan_path.is_file(),
            "updated_at": str(meta.get("updated_at") or ""),
            "is_current": path.name == current,
        })
    return rows


def health_by_id(root: Path) -> dict[str, dict]:
    code, out, _ = run_script("goo-plan-health.py", ["--root", str(root), "--json", "--all"], root)
    if code != 0:
        return {}
    try:
        report = json.loads(out)
    except ValueError:
        return {}
    return {str(t.get("id")): t for t in report.get("threads", []) if isinstance(t, dict)}


def needs_attention(row: dict, health: dict) -> str:
    entry = health.get(row["id"]) or {}
    if entry.get("needs_attention"):
        return "needs-attention"
    if row["status"] not in FINISHED_THREAD_STATES and row["plan_status"] in FINISHED_PLAN_STATES:
        return "inconsistent"
    if row["status"] in FINISHED_THREAD_STATES:
        return "done"
    return "ok"


MARK = {
    "needs-attention": "⚠",
    "inconsistent": "≠",
    "done": "·",
    "ok": "✓",
}


def cmd_list(root: Path, as_json: bool = False, status_filter: str | None = None,
             only_active: bool = False) -> int:
    rows = thread_rows(root)
    health = health_by_id(root)
    for row in rows:
        row["flag"] = needs_attention(row, health)
        entry = health.get(row["id"]) or {}
        row["health_state"] = entry.get("state")
        row["health_reasons"] = entry.get("reasons") or []
        row["age_hours"] = entry.get("age_hours")

    if status_filter:
        wanted = {s.strip() for s in status_filter.split(",") if s.strip()}
        rows = [r for r in rows if r["status"] in wanted]
    if only_active:
        rows = [r for r in rows if r["status"] not in FINISHED_THREAD_STATES]

    if as_json:
        print(json.dumps({
            "root": str(root),
            "current_thread_id": read_json(goo_dir(root) / "current_thread.json").get("thread_id"),
            "count": len(rows),
            "threads": rows,
        }, ensure_ascii=False, indent=2))
        return 0

    if not rows:
        print("AutoGoo: 还没有任何 thread（用 goo-thread.py new \"<标题>\" 创建）")
        return 0
    # 当前 thread 置顶
    rows.sort(key=lambda r: (not r["is_current"], r["updated_at"]), reverse=False)
    rows.sort(key=lambda r: r["is_current"], reverse=True)

    print(f"AutoGoo-Plugin threads（{len(rows)} 个，* = 当前）\n")
    width = max(len(r["id"]) for r in rows)
    for row in rows:
        flag = needs_attention(row, health)
        star = "*" if row["is_current"] else " "
        plan = f"plan={row['plan_status']}/{row['steps']}" if row["has_plan"] else "plan=—"
        print(f" {star} {row['id']:<{width}}  {MARK[flag]} {row['status']:<10} {plan:<22} {row['title'][:48]}")
    print("\n标记：✓ 正常 · · 已结束 · ⚠ 需处理 · ≠ plan/thread 状态不一致")
    print("详情：goo-thread.py show <id>　切换：goo-thread.py switch <id>")
    return 0


def cmd_show(root: Path, thread_id: str, as_json: bool = False) -> int:
    threads_dir = goo_dir(root) / "threads"
    target = threads_dir / thread_id
    if not target.is_dir():
        print(f"error: thread 不存在: {thread_id}", file=sys.stderr)
        return 1
    meta = read_json(target / "thread.json")
    plan_path = target / "plan.json"
    plan = read_json(plan_path) if plan_path.is_file() else {}
    steps = [s for s in (plan.get("steps") or []) if isinstance(s, dict)]
    current = read_json(goo_dir(root) / "current_thread.json").get("thread_id")
    health = health_by_id(root).get(thread_id) or {}

    if as_json:
        row = next((r for r in thread_rows(root) if r["id"] == thread_id), {})
        print(json.dumps({
            "id": thread_id,
            "is_current": current == thread_id,
            "meta": meta,
            "plan": {"status": plan.get("status"), "steps": steps},
            "row": row,
            "health": health,
            "paths": {
                "dir": str(target),
                "plan": str(plan_path),
                "logs": str(target / "logs"),
                "artifacts": str(target / "artifacts"),
                "reports": str(target / "reports"),
            },
            "counts": {
                "logs": len(list((target / "logs").glob("*"))) if (target / "logs").is_dir() else 0,
                "artifacts": len(list((target / "artifacts").rglob("*"))) if (target / "artifacts").is_dir() else 0,
                "reports": len(list((target / "reports").glob("*"))) if (target / "reports").is_dir() else 0,
            },
        }, ensure_ascii=False, indent=2))
        return 0

    print(f"thread:  {thread_id}{'  * 当前' if current == thread_id else ''}")
    print(f"title:   {meta.get('title') or '(无标题)'}")
    print(f"status:  {meta.get('status')}　plan: {plan.get('status') or '—'}")
    print(f"created: {meta.get('created_at')}　updated: {meta.get('updated_at')}")
    if health.get("reasons"):
        print(f"health:  ⚠ {health.get('state')} — {'；'.join(health['reasons'])}")
    else:
        print(f"health:  {health.get('state', 'unknown')}")

    if steps:
        print(f"\nplan 步骤（{sum(1 for s in steps if s.get('status') == 'completed')}/{len(steps)} 完成）：")
        for step in steps:
            print(f"  #{step.get('id'):<4} {str(step.get('status')):<12} {str(step.get('name') or '')[:60]}")
    else:
        print("\nplan:    （无 plan）")

    print("\n路径：")
    for label, rel in (
        ("plan", plan_path if plan_path.is_file() else None),
        ("logs", target / "logs"),
        ("artifacts", target / "artifacts"),
        ("reports", target / "reports"),
    ):
        if rel is None:
            print(f"  {label:<10} —")
        else:
            print(f"  {label:<10} {rel} {'(存在)' if rel.exists() else '(不存在)'}")
    raw_plan_path = meta.get("plan_path")
    if raw_plan_path and (not plan_path.is_file() or str(plan_path) != str(target / 'plan.json')):
        print(f"  plan_path 字段: {raw_plan_path}")
    return 0


def cmd_switch(root: Path, thread_id: str) -> int:
    target = goo_dir(root) / "threads" / thread_id
    if not target.is_dir():
        print(f"error: thread 不存在: {thread_id}", file=sys.stderr)
        return 1
    # set_current 现在会同时把兼容入口 .goo/plan.json 同步过去（thread-state.py 内实现）
    code, out, err = run_script(
        "thread-state.py",
        ["--goo-dir", str(goo_dir(root)), "set-current", "--id", thread_id],
        root,
    )
    if out.strip():
        print(out.strip())
    if err.strip():
        print(err.strip(), file=sys.stderr)
    if code != 0:
        print(f"error: 切换失败 (exit={code})", file=sys.stderr)
        return code

    plan_path = target / "plan.json"
    if plan_path.is_file():
        print(f"兼容入口 .goo/plan.json 已同步为 {thread_id} 的 plan")
    else:
        print("注意：该 thread 没有自己的 plan.json，兼容入口保持原样")
    print(f"现在 /goo-status 与 /goo-continue 都会作用于 thread {thread_id}")
    return 0


def cmd_new(root: Path, title: str, steps: int | None) -> int:
    code, out, err = run_script(
        "thread-state.py",
        ["--goo-dir", str(goo_dir(root)), "create", "--title", title],
        root,
    )
    if code != 0:
        print(err.strip() or f"error: 创建失败 (exit={code})", file=sys.stderr)
        return code
    try:
        created = json.loads(out) if out.strip().startswith("{") else {}
    except ValueError:
        created = {}
    thread_id = str(created.get("id") or "").strip()
    if not thread_id:
        # 回退：取最近创建的 thread 目录
        rows = sorted(thread_rows(root), key=lambda r: r["updated_at"], reverse=True)
        thread_id = rows[0]["id"] if rows else ""
    print(f"已创建 thread: {thread_id}（已设为当前）")
    if steps and steps > 0:
        code, out2, err2 = run_script(
            "init-plan.sh",
            [title, str(steps), "--thread-id", thread_id],
            root,
        )
        if code == 0:
            print(f"已生成 {steps} 步计划骨架（{goo_dir(root)}/threads/{thread_id}/plan.json）")
        else:
            print(f"计划骨架生成失败：{(err2 or out2).strip()[:200]}", file=sys.stderr)
    print(f"下一步：goo-thread.py show {thread_id}")
    return 0


def _update_thread_meta(root: Path, thread_id: str, mutate) -> bool:
    """Load thread.json, apply *mutate*, write back, and mirror into index.json."""
    threads_dir = goo_dir(root) / "threads"
    meta_path = threads_dir / thread_id / "thread.json"
    if not meta_path.is_file():
        return False
    meta = read_json(meta_path)
    mutate(meta)
    meta["updated_at"] = now_iso()
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    index_path = threads_dir / "index.json"
    index = read_json(index_path)
    entries = index.get("threads") if isinstance(index.get("threads"), list) else []
    for entry in entries:
        if isinstance(entry, dict) and str(entry.get("id")) == thread_id:
            entry["title"] = meta.get("title", entry.get("title"))
            entry["status"] = meta.get("status", entry.get("status"))
            entry["updated_at"] = meta.get("updated_at")
    index["threads"] = entries
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def cmd_rename(root: Path, thread_id: str, title: str) -> int:
    if not (goo_dir(root) / "threads" / thread_id / "thread.json").is_file():
        print(f"error: thread 不存在: {thread_id}", file=sys.stderr)
        return 1
    _update_thread_meta(root, thread_id, lambda m: m.__setitem__("title", title))
    print(f"已重命名 thread {thread_id} → {title}")
    return 0


def cmd_archive(root: Path, thread_id: str) -> int:
    if not (goo_dir(root) / "threads" / thread_id / "thread.json").is_file():
        print(f"error: thread 不存在: {thread_id}", file=sys.stderr)
        return 1

    def mutate(meta: dict) -> None:
        meta["previous_status"] = meta.get("status")
        meta["status"] = "archived"

    _update_thread_meta(root, thread_id, mutate)
    print(f"已归档 thread {thread_id}（恢复：goo-thread.py restore {thread_id}）")
    return 0


def cmd_restore(root: Path, thread_id: str) -> int:
    meta_path = goo_dir(root) / "threads" / thread_id / "thread.json"
    if not meta_path.is_file():
        print(f"error: thread 不存在: {thread_id}", file=sys.stderr)
        return 1
    meta = read_json(meta_path)
    restored = str(meta.get("previous_status") or "running")

    def mutate(m: dict) -> None:
        m["status"] = restored
        m.pop("previous_status", None)

    _update_thread_meta(root, thread_id, mutate)
    print(f"已恢复 thread {thread_id} → {restored}")
    return 0


def cmd_close(root: Path, thread_id: str, reason: str) -> int:
    code, out, err = run_script(
        "goo-plan-health.py",
        ["--root", str(root), "--close", "--thread", thread_id, "--close-reason", reason],
        root,
    )
    if code != 0:
        print(err.strip() or f"error: 关闭失败 (exit={code})", file=sys.stderr)
        return code
    print(f"已归档并关闭 thread: {thread_id}")
    print(f"  reason: {reason}")
    print(f"  备份在 {goo_dir(root)}/plans/history/")
    return 0


def cmd_doctor(root: Path, fix: bool) -> int:
    args = ["--root", str(root)]
    if fix:
        args.append("--fix")
    code, out, err = run_script("thread-doctor.py", args, root)
    sys.stdout.write(out)
    if err.strip():
        sys.stderr.write(err)
    return code


def cmd_health(root: Path) -> int:
    code, out, err = run_script("goo-plan-health.py", ["--root", str(root), "--all"], root)
    sys.stdout.write(out)
    if err.strip():
        sys.stderr.write(err)
    return code


def main() -> int:
    parser = argparse.ArgumentParser(
        description="统一管理 AutoGoo-Plugin thread（列表/详情/切换/新建/关闭/对账）",
    )
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="项目根（默认当前目录）")
    sub = parser.add_subparsers(dest="cmd")

    list_cmd = sub.add_parser("list", help="列出所有 thread（含健康状态）")
    list_cmd.add_argument("--json", action="store_true", help="机器可读输出")
    list_cmd.add_argument("--status", default=None, help="按状态过滤，逗号分隔，如 running,archived")
    list_cmd.add_argument("--active", action="store_true", help="只显示未结束的 thread")
    show = sub.add_parser("show", help="查看单个 thread 详情")
    show.add_argument("thread_id")
    show.add_argument("--json", action="store_true", help="机器可读输出")
    switch = sub.add_parser("switch", help="切换当前 thread（同时同步兼容入口）")
    switch.add_argument("thread_id")
    new = sub.add_parser("new", help="新建 thread")
    new.add_argument("title")
    new.add_argument("--steps", type=int, default=None, help="同时生成 N 步计划骨架")
    rename = sub.add_parser("rename", help="重命名 thread 标题")
    rename.add_argument("thread_id")
    rename.add_argument("title")
    archive = sub.add_parser("archive", help="归档 thread（可 restore 恢复）")
    archive.add_argument("thread_id")
    restore = sub.add_parser("restore", help="从归档恢复 thread")
    restore.add_argument("thread_id")
    close = sub.add_parser("close", help="归档并关闭 thread")
    close.add_argument("thread_id")
    close.add_argument("--reason", default="closed via goo-thread")
    doctor = sub.add_parser("doctor", help="对账 thread 记录")
    doctor.add_argument("--fix", action="store_true", help="执行安全自动修复")
    sub.add_parser("health", help="thread 健康检查")

    args = parser.parse_args()
    root = args.root.expanduser().resolve()

    if args.cmd in (None, "list"):
        return cmd_list(
            root,
            as_json=getattr(args, "json", False),
            status_filter=getattr(args, "status", None),
            only_active=getattr(args, "active", False),
        )
    if args.cmd == "show":
        return cmd_show(root, args.thread_id, as_json=getattr(args, "json", False))
    if args.cmd == "switch":
        return cmd_switch(root, args.thread_id)
    if args.cmd == "new":
        return cmd_new(root, args.title, args.steps)
    if args.cmd == "rename":
        return cmd_rename(root, args.thread_id, args.title)
    if args.cmd == "archive":
        return cmd_archive(root, args.thread_id)
    if args.cmd == "restore":
        return cmd_restore(root, args.thread_id)
    if args.cmd == "close":
        return cmd_close(root, args.thread_id, args.reason)
    if args.cmd == "doctor":
        return cmd_doctor(root, args.fix)
    if args.cmd == "health":
        return cmd_health(root)
    parser.error(f"unknown command: {args.cmd}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Observe AutoGoo-Plugin background agents, shell tracking, and step logs."""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_WORKSPACE_PATHS = {
    "threads_dir": ".goo/threads",
    "current_thread_file": ".goo/current_thread.json",
    "compat_plan_file": ".goo/plan.json",
    "logs_dir": ".goo/logs",
}


def read_json(path: Path) -> dict[str, Any] | list[Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone()


def age_text(value: Any, now: datetime | None = None) -> str:
    dt = parse_time(value)
    if not dt:
        return "无心跳"
    now = now or datetime.now().astimezone()
    seconds = max(0, int((now - dt).total_seconds()))
    if seconds < 60:
        return f"{seconds}s前"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}min前"
    return f"{minutes // 60}h{minutes % 60:02d}m前"


def shorten(value: Any, limit: int = 64) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "..."


def load_config(root: Path) -> dict[str, Any]:
    data = read_json(root / ".goo/config.json")
    return data if isinstance(data, dict) else {}


def workspace_paths(config: dict[str, Any]) -> dict[str, str]:
    merged = dict(DEFAULT_WORKSPACE_PATHS)
    workspace = config.get("workspace") if isinstance(config.get("workspace"), dict) else {}
    paths = workspace.get("paths") if isinstance(workspace.get("paths"), dict) else {}
    for key, value in paths.items():
        if key in merged and value:
            merged[key] = str(value)
    return merged


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else root / path


def current_plan(root: Path, config: dict[str, Any]) -> tuple[dict[str, Any] | None, Path | None, dict[str, Any] | None]:
    paths = workspace_paths(config)
    current_path = resolve_path(root, paths["current_thread_file"])
    current = read_json(current_path)
    if isinstance(current, dict) and current.get("thread_id"):
        thread_plan = resolve_path(root, paths["threads_dir"]) / str(current["thread_id"]) / "plan.json"
        data = read_json(thread_plan)
        if isinstance(data, dict):
            return data, thread_plan, current
    compat = resolve_path(root, paths["compat_plan_file"])
    data = read_json(compat)
    return (data, compat, None) if isinstance(data, dict) else (None, None, current if isinstance(current, dict) else None)


def logs_dir_for_plan(root: Path, config: dict[str, Any], plan_path: Path | None, plan: dict[str, Any] | None) -> Path:
    thread = plan.get("thread") if isinstance(plan, dict) and isinstance(plan.get("thread"), dict) else {}
    if thread.get("logs_dir"):
        return resolve_path(root, str(thread["logs_dir"]))
    if plan_path and plan_path.parent.name != ".goo":
        thread_logs = plan_path.parent / "logs"
        if thread_logs.exists() or "threads" in plan_path.parts:
            return thread_logs
    return resolve_path(root, workspace_paths(config)["logs_dir"])


def step_log_path(root: Path, logs_dir: Path, step: dict[str, Any]) -> Path | None:
    raw = step.get("log_path")
    if raw:
        path = Path(str(raw))
        return path if path.is_absolute() else root / path
    step_id = str(step.get("id") or "")
    if not step_id or not logs_dir.exists():
        return None
    # 口径必须和 goo-status 一致：派发路径写 `step-<id>.log`，
    # `update-step.py` 预创建写 `<ts>_step-<id>_<name>.md`。只认后者会让面板
    # 在新 thread 上「看不到日志」，这不是渲染问题，是归组口径问题。
    direct = logs_dir / f"step-{step_id}.log"
    if direct.is_file():
        return direct
    matches = sorted(logs_dir.glob(f"*_step-{step_id}_*.md"), key=lambda p: p.stat().st_mtime)
    return matches[-1] if matches else None


def tail(path: Path | None, lines: int = 8) -> list[str]:
    if not path or not path.exists() or not path.is_file():
        return []
    try:
        data = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return []
    return data[-lines:]


def claude_version() -> str:
    try:
        result = subprocess.run(["claude", "--version"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip()


def shell_log_dir(root: Path, logs_dir: Path) -> Path:
    thread_shell = logs_dir / "shell"
    if logs_dir.exists():
        return thread_shell
    return root / ".goo/logs/shell"


def snapshot(root: Path) -> dict[str, Any]:
    root = root.resolve()
    config = load_config(root)
    plan, plan_path, current = current_plan(root, config)
    logs_dir = logs_dir_for_plan(root, config, plan_path, plan)
    steps = [step for step in (plan or {}).get("steps", []) if isinstance(step, dict)]
    now = datetime.now().astimezone()
    running: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for step in steps:
        status = str(step.get("status") or "pending")
        log_path = step_log_path(root, logs_dir, step)
        item = {
            "id": step.get("id"),
            "name": step.get("name"),
            "status": status,
            "subagent": step.get("subagent"),
            "task_agent": step.get("task_agent"),
            "agent_id": step.get("agent_id"),
            "progress": int(step.get("progress") or 0),
            "heartbeat_at": step.get("heartbeat_at"),
            "heartbeat_age": age_text(step.get("heartbeat_at"), now),
            "log_path": str(log_path) if log_path else "",
            "log_tail": tail(log_path),
            "output": step.get("output"),
        }
        if status == "running":
            running.append(item)
        elif status == "blocked":
            blocked.append(item)
        elif status == "failed":
            failed.append(item)
    shell_dir = shell_log_dir(root, logs_dir)
    shell_logs = []
    if shell_dir.exists():
        shell_logs = [
            {"path": str(path), "mtime": path.stat().st_mtime, "tail": tail(path, 6)}
            for path in sorted(shell_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)[:8]
        ]
    return {
        "root": str(root),
        "current_thread": current or ((plan or {}).get("thread") if isinstance((plan or {}).get("thread"), dict) else {}),
        "plan_path": str(plan_path) if plan_path else "",
        "logs_dir": str(logs_dir),
        "shell_log_dir": str(shell_dir),
        "claude_version": claude_version(),
        "running": running,
        "blocked": blocked,
        "failed": failed,
        "shell_logs": shell_logs,
        "commands": {
            "agent_view": "claude agents",
            "status": "/auto-goo:goo-status",
            "publish_live": "/auto-goo:goo-publish --live",
            "shell_template": f"mkdir -p {shell_dir} && <command> 2>&1 | tee {shell_dir}/<name>-$(date +%Y%m%d-%H%M%S).log",
        },
    }


def print_text(data: dict[str, Any]) -> None:
    print("AutoGoo-Plugin Observe")
    print(f"  root:       {data.get('root')}")
    print(f"  thread:     {(data.get('current_thread') or {}).get('id') or 'legacy/current'}")
    print(f"  plan:       {data.get('plan_path') or '未找到'}")
    print(f"  logs:       {data.get('logs_dir')}")
    print(f"  shell logs: {data.get('shell_log_dir')}")
    if data.get("claude_version"):
        print(f"  claude:     {data['claude_version']}")
    print("")
    print("Agent View")
    print(f"  {data['commands']['agent_view']}     # 看后台 Claude session / shell job")
    print("  Space peek, Enter/Right attach；内部 subagent 细节看下面的 AutoGoo-Plugin step。")
    print("")
    print("RUNNING")
    if not data["running"]:
        print("  无运行中的 AutoGoo-Plugin step。")
    for item in data["running"]:
        print(f"  #{item['id']} {shorten(item['name'], 42)} · {item['progress']}% · hb {item['heartbeat_age']} · {item.get('subagent')}/{item.get('task_agent')}")
        if item.get("log_path"):
            print(f"    log: {item['log_path']}")
        for line in item.get("log_tail") or []:
            print(f"    | {shorten(line, 96)}")
    if data["blocked"] or data["failed"]:
        print("")
        print("ATTENTION")
        for item in data["blocked"] + data["failed"]:
            print(f"  #{item['id']} {shorten(item['name'], 48)} · {item['status']} · log {item.get('log_path') or '无'}")
    print("")
    print("Shell Tracking")
    print(f"  {data['commands']['shell_template']}")
    if data["shell_logs"]:
        print("  recent shell logs:")
        for item in data["shell_logs"]:
            print(f"  - {item['path']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="Project root.")
    parser.add_argument("--json", action="store_true", help="Emit JSON snapshot.")
    args = parser.parse_args()
    data = snapshot(args.root)
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print_text(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

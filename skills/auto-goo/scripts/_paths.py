"""Shared path-routing helpers for AutoGoo-Plugin scripts.

All scripts in this directory import from here instead of re-implementing
find_config_dir / workspace_paths / compute_plan_status / etc.  Keeping the
canonical versions in one place means a path bug only needs one fix.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_WORKSPACE_PATHS = {
    "threads_dir": ".goo/threads",
    "current_thread_file": ".goo/current_thread.json",
    "compat_plan_file": ".goo/plan.json",
    "compat_brainstorm_file": ".goo/brainstorm.json",
    "plans_history_dir": ".goo/plans/history",
    "brainstorms_history_dir": ".goo/brainstorms/history",
    "logs_dir": ".goo/logs",
    "artifacts_dir": ".goo/artifacts",
    "reports_dir": ".goo/reports",
    "change_requests_dir": ".goo/change-requests",
    "obsidian_dir": ".goo/obsidian",
    "locks_dir": ".goo/locks",
    "site_dir": ".goo/site",
}


# ── Time helpers ─────────────────────────────────────────────────────────────

def now() -> str:
    """Return current UTC time as ISO-8601 string with Z suffix."""
    return (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )


def stamp() -> str:
    """Return local timestamp as a compact string safe for filenames."""
    return datetime.now().strftime("%Y%m%d-%H%M%S")


# ── JSON I/O ─────────────────────────────────────────────────────────────────

def load_json(path: Path, default: dict[str, Any] | None = None) -> dict[str, Any]:
    """Read a JSON file, optionally returning *default* when missing.

    When *default* is None (the default) a missing file raises FileNotFoundError —
    this preserves the strict behaviour that update-step / change-requests relied on.
    """
    if not path.exists():
        if default is not None:
            return default
        raise FileNotFoundError(f"file not found: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        if default is not None:
            return default
        raise


def dump_json(path: Path, data: dict[str, Any]) -> None:
    """Atomically write JSON to *path* (parent dirs created on demand)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


# ── Config / path helpers ────────────────────────────────────────────────────

def project_root_from_config_dir(config_dir: Path | None, fallback: Path) -> Path:
    """Derive the project root from a .goo config directory."""
    if config_dir and config_dir.name == ".goo":
        return config_dir.parent.resolve()
    return fallback.resolve()


def find_config_dir(start: Path | None = None) -> Path:
    """Locate the nearest .goo/ directory, preferring ones with config.json.

    When *start* is given, walk upwards from it.  Otherwise start at cwd.
    Always returns a Path (falls back to .goo/ under cwd).
    """
    scopes: list[Path] = []
    if start:
        resolved = start.resolve()
        scopes.append(resolved)
        scopes.extend(resolved.parents)
    else:
        cwd = Path.cwd().resolve()
        scopes.append(cwd)
        scopes.extend(cwd.parents)

    # Prefer .goo dirs that already have config.json; track first .goo as fallback
    plain: Path | None = None
    for candidate in scopes:
        if candidate.name == ".goo":
            if (candidate / "config.json").exists():
                return candidate
            if plain is None:
                plain = candidate
            continue
        config_dir = candidate / ".goo"
        if (config_dir / "config.json").exists():
            return config_dir
    if plain is not None:
        return plain
    return Path.cwd() / ".goo"



def workspace_paths(config_dir: Path | None = None) -> dict[str, str]:
    """Return merged workspace path overrides from config.json."""
    merged = dict(DEFAULT_WORKSPACE_PATHS)
    if not config_dir:
        return merged
    try:
        config = json.loads((config_dir / "config.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return merged
    workspace = config.get("workspace") if isinstance(config.get("workspace"), dict) else {}
    paths = workspace.get("paths") if isinstance(workspace.get("paths"), dict) else {}
    for key, value in paths.items():
        if key in merged and value:
            merged[key] = str(value)
    return merged


def workspace_path(config_dir: Path, key: str) -> Path:
    """Resolve a single workspace path key relative to the project root."""
    if key not in DEFAULT_WORKSPACE_PATHS:
        raise ValueError(
            f"unknown workspace path key: {key!r}; "
            f"expected one of: {', '.join(sorted(DEFAULT_WORKSPACE_PATHS))}"
        )
    paths = workspace_paths(config_dir)
    raw = Path(paths[key]).expanduser()
    if raw.is_absolute():
        return raw
    return project_root_from_config_dir(config_dir, Path.cwd()) / raw


def resolve_plan_path(value: str) -> Path:
    """Resolve a plan.json path argument, falling back to workspace config."""
    plan_path = Path(value)
    if plan_path.exists() or value != ".goo/plan.json":
        return plan_path
    config_dir = find_config_dir(plan_path)
    paths = workspace_paths(config_dir)
    raw = Path(paths["compat_plan_file"])
    if raw.is_absolute():
        return raw
    return project_root_from_config_dir(config_dir, Path.cwd()) / raw



def project_root_from_plan(plan_path: Path) -> Path:
    """Derive the project root from a plan file path."""
    config_dir = find_config_dir(plan_path)
    fallback = (
        plan_path.parent.parent.parent.parent
        if plan_path.parent.parent.name == "threads"
        else plan_path.parent
    )
    return project_root_from_config_dir(config_dir, fallback)


def logs_dir_from_plan(plan_path: Path) -> Path:
    """Locate the logs directory for a given plan path."""
    parent = plan_path.parent
    config_dir = find_config_dir(plan_path)
    project_root = project_root_from_plan(plan_path)
    paths = workspace_paths(config_dir)
    threads_dir = Path(paths["threads_dir"])
    if not threads_dir.is_absolute():
        threads_dir = project_root / threads_dir
    try:
        plan_path.resolve().relative_to(threads_dir.resolve())
        return parent / "logs"
    except ValueError:
        pass
    logs_dir = Path(paths["logs_dir"])
    if logs_dir.is_absolute():
        return logs_dir
    return project_root / logs_dir


# ── Plan status ──────────────────────────────────────────────────────────────

def compute_plan_status(plan: dict[str, Any]) -> str:
    """Derive overall plan status from its steps."""
    if plan.get("status") == "paused":
        return "paused"
    steps = [s for s in plan.get("steps", []) if isinstance(s, dict)]
    if not steps:
        return str(plan.get("status") or "pending")
    total = len(steps)
    completed = sum(1 for s in steps if s.get("status") == "completed")
    if completed == total:
        return "completed"
    if any(s.get("status") == "blocked" for s in steps):
        return "blocked"
    if any(s.get("status") == "running" for s in steps):
        return "running"
    if any(s.get("status") == "interrupted" for s in steps):
        # wrapper 中断但任务本体可能继续：可恢复，优先于 failed 展示
        return "interrupted"
    if any(s.get("status") == "failed" for s in steps):
        return "failed"
    return "pending"

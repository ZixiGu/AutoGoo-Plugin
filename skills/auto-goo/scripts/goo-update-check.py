#!/usr/bin/env python3
"""AutoGoo-Plugin update check — notify when the installed copy is behind main.

Compares the **local git HEAD** with the remote branch HEAD. Version numbers are
deliberately not used: `package.json` may stay at the same version across
several commits, so a version comparison misses real updates (verified against
this repo: local was 6 commits ahead while both sides read 0.5.1).

Design constraints:
  * Never break the caller — every failure degrades to ``status=unknown`` and
    the process always exits 0 (unless ``--strict`` is passed).
  * Read-only — only ``git ls-remote`` is used; the local checkout is never
    mutated (no fetch, no pull).
  * Cached — results are reused for ``interval_hours`` (default 24) so a session
    start does not hit the network every time.
  * Respects opt-outs — ``AUTOGOO_SKIP_UPDATE_CHECK`` / ``PI_SKIP_VERSION_CHECK``
    / ``PI_OFFLINE`` / ``AUTOGOO_OFFLINE`` and ``update_check.enabled=false``.

Usage:
  goo-update-check.py [--check|--json] [--force] [--interval-hours N] [--root DIR]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_INTERVAL_HOURS = 24
GIT_TIMEOUT_SECONDS = 8
CACHE_VERSION = 1

TRUTHY = {"1", "true", "yes", "on"}


def _is_truthy(name: str) -> bool:
    return str(os.environ.get(name, "")).strip().lower() in TRUTHY


def _opted_out() -> str | None:
    """Return the reason updates checks are disabled, or None."""
    for var in ("AUTOGOO_SKIP_UPDATE_CHECK", "PI_SKIP_VERSION_CHECK"):
        if _is_truthy(var):
            return var
    for var in ("AUTOGOO_OFFLINE", "PI_OFFLINE"):
        if _is_truthy(var):
            return var
    return None


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def default_root() -> Path:
    """Derive the plugin root from this script's location."""
    return Path(__file__).resolve().parents[3]


def config_enabled(root: Path) -> bool | None:
    """Read update_check.enabled from project/user config; None when unset."""
    home = Path(os.environ.get("HOME") or "~").expanduser()
    for candidate in (root / ".goo" / "config.json", home / ".auto-goo" / "config.json"):
        data = _read_json(candidate)
        section = data.get("update_check")
        if isinstance(section, dict) and "enabled" in section:
            return bool(section.get("enabled"))
    return None


def _git(args: list[str], cwd: Path) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SECONDS,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, "", f"{type(exc).__name__}: {exc}"


def local_revision(root: Path) -> tuple[str | None, str | None, str | None]:
    """Return (sha, branch, remote_url) for the local checkout."""
    if not (root / ".git").exists():
        return None, None, None
    code, sha, _ = _git(["rev-parse", "HEAD"], root)
    if code != 0 or not sha:
        return None, None, None
    code, branch, _ = _git(["symbolic-ref", "--short", "HEAD"], root)
    if code != 0 or not branch:
        branch = "main"
    code, remote, _ = _git(["remote", "get-url", "origin"], root)
    if code != 0 or not remote:
        remote = "https://github.com/ZixiGu/AutoGoo-Plugin.git"
    return sha, branch, remote


def remote_revision(remote: str, branch: str) -> tuple[str | None, str | None]:
    """Return (sha, error) for the remote branch head. Read-only."""
    code, out, err = _git(["ls-remote", remote, f"refs/heads/{branch}"], Path.cwd())
    if code != 0:
        return None, err or f"git ls-remote exited {code}"
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == f"refs/heads/{branch}":
            return parts[0], None
    return None, f"branch {branch} not found on remote"


def install_kind(root: Path) -> str:
    """Best-effort classification used to pick the right update command."""
    text = str(root)
    home = str(Path(os.environ.get("HOME") or "~").expanduser())
    if f"{home}/.pi/agent/git/" in text:
        return "pi-git"
    if "/.claude/plugins/" in text or "marketplace" in text:
        return "claude-marketplace"
    return "local-checkout"


def update_hint(kind: str, root: Path) -> str:
    if kind == "pi-git":
        return "pi update --extensions  # 或 pi update git:github.com/ZixiGu/AutoGoo-Plugin"
    if kind == "claude-marketplace":
        return "/plugin update autogoo-plugin"
    return f"git -C {root} pull --ff-only"


def cache_path() -> Path:
    return Path(os.environ.get("HOME") or "~").expanduser() / ".auto-goo" / "cache" / "update-check.json"


def load_cache(ttl_seconds: float, root: Path | None = None) -> dict | None:
    data = _read_json(cache_path())
    if data.get("version") != CACHE_VERSION:
        return None
    # 缓存是全局的，但 root 可能是另一份安装（开发 checkout vs pi/git 安装）；
    # root 不匹配时必须重查，否则会把另一份安装的结论误报给当前安装。
    if root is not None and str(data.get("root", "")) != str(root):
        return None
    checked_at = data.get("checked_at")
    if not isinstance(checked_at, str):
        return None
    try:
        moment = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if datetime.now(timezone.utc) - moment > timedelta(seconds=ttl_seconds):
        return None
    return data


def save_cache(payload: dict) -> None:
    path = cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def evaluate(root: Path, use_cache: bool, ttl_seconds: float, cached_only: bool = False) -> dict:
    enabled = config_enabled(root)
    if enabled is False:
        return {"status": "disabled", "reason": "update_check.enabled=false"}

    opt_out = _opted_out()
    if opt_out:
        return {"status": "disabled", "reason": opt_out}

    cached = load_cache(ttl_seconds, root) if use_cache else None
    if cached:
        cached["cached"] = True
        return cached

    if cached_only:
        # 会话启动路径：只读缓存，绝不发网络请求（避免阻塞启动）
        return {"status": "unknown", "reason": "no fresh cache", "cached_only": True}

    local_sha, branch, remote = local_revision(root)
    if not local_sha:
        result = {"status": "unknown", "reason": "not a git checkout or git unavailable"}
    else:
        remote_sha, error = remote_revision(remote, branch)
        if not remote_sha:
            result = {
                "status": "unknown",
                "reason": error or "could not resolve remote head",
                "local_sha": local_sha,
                "branch": branch,
            }
        elif remote_sha == local_sha:
            result = {"status": "up-to-date", "local_sha": local_sha, "remote_sha": remote_sha, "branch": branch}
        else:
            result = {"status": "available", "local_sha": local_sha, "remote_sha": remote_sha, "branch": branch}

    kind = install_kind(root)
    result["version"] = CACHE_VERSION
    result["checked_at"] = now_iso()
    result["root"] = str(root)
    result["install_kind"] = kind
    result["update_command"] = update_hint(kind, root)
    save_cache(result)
    result["cached"] = False
    return result


def short(sha: str | None) -> str:
    return (sha or "?")[:12]


def render_human(result: dict) -> str:
    status = result.get("status")
    if status == "available":
        return (
            f"AutoGoo-Plugin 有更新：本地 {short(result.get('local_sha'))} → 远端 "
            f"{short(result.get('remote_sha'))} ({result.get('branch')})。"
            f"更新：{result.get('update_command')}"
        )
    if status == "up-to-date":
        return f"AutoGoo-Plugin 已是最新（{short(result.get('local_sha'))} @ {result.get('branch')}）"
    if status == "disabled":
        return f"AutoGoo-Plugin 更新检查已禁用（{result.get('reason')}）"
    if status == "unknown" and result.get("cached_only"):
        # 缓存未命中不是异常，调用方（会话启动）不应展示任何噪音
        return ""
    return f"AutoGoo-Plugin 更新检查不可用（{result.get('reason', 'unknown')}）"


def main() -> int:
    parser = argparse.ArgumentParser(description="Check whether AutoGoo-Plugin is behind its remote branch")
    parser.add_argument("--check", action="store_true", help="print a one-line status (default)")
    parser.add_argument("--json", action="store_true", help="print the raw result as JSON")
    parser.add_argument("--force", action="store_true", help="bypass the cache")
    parser.add_argument("--interval-hours", type=float, default=DEFAULT_INTERVAL_HOURS,
                        help=f"cache lifetime in hours (default {DEFAULT_INTERVAL_HOURS})")
    parser.add_argument("--root", type=Path, default=None, help="plugin root (default: derived from this script)")
    parser.add_argument("--quiet", action="store_true", help="no output; exit code only")
    parser.add_argument("--cached-only", action="store_true",
                        help="read the cache only and never touch the network (for session start)")
    parser.add_argument("--strict", action="store_true",
                        help="exit 1 when an update is available (default: always exit 0)")
    args = parser.parse_args()

    root = (args.root or default_root()).expanduser()
    ttl_seconds = max(0.0, args.interval_hours) * 3600

    try:
        result = evaluate(
            root,
            use_cache=not args.force,
            ttl_seconds=ttl_seconds,
            cached_only=args.cached_only,
        )
    except Exception as exc:  # never break session start
        result = {"status": "unknown", "reason": f"{type(exc).__name__}: {exc}"}

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif not args.quiet:
        line = render_human(result)
        if line:
            print(line)

    if args.strict and result.get("status") == "available":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

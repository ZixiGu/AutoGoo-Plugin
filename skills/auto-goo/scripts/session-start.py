#!/usr/bin/env python3
"""Print compact AutoGoo session context for the Claude Code SessionStart hook."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def main() -> int:
    cwd = Path.cwd()
    project = read_json(cwd / ".goo/config.json")
    user = read_json(Path.home() / ".auto-goo/config.json")
    wiki_text = project.get("wiki_dir") or user.get("wiki_dir") or "~/workspace/Goo-wiki"
    wiki_dir = Path(str(wiki_text)).expanduser()
    print(f"AutoGoo: wiki={'ready' if (wiki_dir / 'CLAUDE.md').exists() else 'unavailable'} ({wiki_dir})")

    plan = read_json(cwd / ".goo/plan.json")
    steps = plan.get("steps") if isinstance(plan.get("steps"), list) else []
    unfinished = [step for step in steps if isinstance(step, dict) and step.get("status") not in {"completed", "failed"}]
    if unfinished:
        print(f"AutoGoo: unfinished plan detected ({len(unfinished)}/{len(steps)} steps); use /auto-goo:goo-continue")

    project_goo = cwd / "goo.md"
    user_goo = Path.home() / ".auto-goo" / "goo.md"
    if project_goo.is_file():
        print(f"AutoGoo: goo.md=project ({project_goo})")
    elif user_goo.is_file():
        print(f"AutoGoo: goo.md=user ({user_goo})")
    else:
        here = Path(__file__).resolve().parent
        restore = f"python3 {here}/goo-md.py --ensure"
        print("AutoGoo: goo.md=missing（当前环境没有约定正文）")
        print(f"AutoGoo:   恢复内置备份：{restore}")
        print("AutoGoo:   或重新初始化：/auto-goo:goo-init --user")

    # 插件更新提醒（2026-10-08）：只读缓存，**绝不发网络请求**，避免拖慢启动。
    # 真正的检查由 goo-update-check.py 在别处（pi 启动时异步）完成并写缓存。
    print_update_notice()
    return 0


def print_update_notice() -> None:
    """Print a one-line notice when a cached update result says an update is available."""
    try:
        import subprocess

        script = Path(__file__).resolve().parent / "goo-update-check.py"
        if not script.is_file():
            return
        proc = subprocess.run(
            [sys.executable, str(script), "--cached-only"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        line = (proc.stdout or "").strip()
        if line and "\u6709\u66f4\u65b0" in line:
            # 脚本输出自带 "AutoGoo-Plugin " 前缀，避免出现 "AutoGoo: AutoGoo-Plugin ..."
            print(f"AutoGoo: {line.removeprefix('AutoGoo-Plugin ')}")
    except Exception:
        # 更新提醒绝不能影响会话启动
        pass


if __name__ == "__main__":
    raise SystemExit(main())

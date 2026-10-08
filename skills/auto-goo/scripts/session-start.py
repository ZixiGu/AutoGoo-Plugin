#!/usr/bin/env python3
"""Print compact AutoGoo session context for the Claude Code SessionStart hook."""

from __future__ import annotations

import json
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

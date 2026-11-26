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

    # thread 维度健康检查（2026-10-08）：区分当前 thread 与历史 thread，
    # 提示可能已中断/状态不一致的 DAG。Claude Code hook 无法交互提问，
    # 只能给出结论与下一步命令；交互式确认由 pi 扩展的 session_start 完成。
    print_memory_system(wiki_dir)
    print_plan_health(cwd)
    print_thread_doctor(cwd)

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


def print_memory_system(wiki_dir: Path) -> None:
    """一行指向记忆分层的口径出处（`<vault>/memory/`）。

    为什么必须在启动时打：分层口径页写好了但没人告诉 agent 它在哪，就等于不存在。
    实测过的失效：插件注入的 MEMORY_LAYERING_RULE 与 wiki 里的口径相反，两处都没人读对方。
    只打一行 —— 启动上下文预算很小，完整规则在 memory/index.md 里按需读。
    """
    memory_dir = wiki_dir / "memory"
    index = memory_dir / "index.md"
    if index.is_file():
        print(f"AutoGoo: memory={memory_dir}（分层口径唯一出处：memory/index.md → rules.md / policy.json）")
        return
    if (wiki_dir / "CLAUDE.md").is_file():
        print("AutoGoo: memory=missing（vault 里还没有 memory/ 口径页）")
        print("AutoGoo:   补齐：/auto-goo:goo-init --project（会创建 memory/{index,rules,policy.json}）")


def print_plan_health(cwd: Path) -> None:
    """Print the thread-aware plan health summary (never blocks, never raises)."""
    try:
        import subprocess

        script = Path(__file__).resolve().parent / "goo-plan-health.py"
        if not script.is_file():
            return
        proc = subprocess.run(
            [sys.executable, str(script), "--root", str(cwd)],
            capture_output=True,
            text=True,
            timeout=8,
        )
        for line in (proc.stdout or "").splitlines():
            if line.strip():
                print(line)
    except Exception:
        # 健康检查绝不能影响会话启动
        pass


def print_thread_doctor(cwd: Path) -> None:
    """Print a one-line thread-record reconciliation summary (never blocks)."""
    try:
        import subprocess

        script = Path(__file__).resolve().parent / "thread-doctor.py"
        if not script.is_file():
            return
        proc = subprocess.run(
            [sys.executable, str(script), "--root", str(cwd), "--json"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        report = json.loads(proc.stdout or "{}")
        count = int(report.get("issue_count") or 0)
        if count <= 0:
            return
        counts = report.get("counts") or {}
        detail = ", ".join(f"{k}×{v}" for k, v in sorted(counts.items()))
        print(
            f"AutoGoo: ⚠ thread 记录有 {count} 项不一致（{detail}）；"
            f"修复：python3 {script} --fix"
        )
    except Exception:
        # 对账检查绝不能影响会话启动
        pass


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

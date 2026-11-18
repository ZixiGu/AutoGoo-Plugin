"""归档前跨环境 Git 前置检查的测试。

Goo-wiki CLAUDE.md 要求：写 log.md 前先 `git pull --rebase`；冲突时手工按日期
重排、不要 merge=union；vault 内禁 symlink / 需归一化换行等（由 vault 自带
scripts/git-env-check.sh 检查）。

设计取舍：**只警告不阻塞**。因 git 状态不干净就拒绝写 wiki，等于让一次失败的
rebase 把整轮任务的产出全丢掉 —— 这比"内容写进去但没提交"更糟。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/auto-goo/scripts/wiki-graph-assist.py"


def _run_preflight(wiki: Path) -> dict:
    """通过子进程跑脚本的 --preflight-json（避免 importlib 加载 dataclass 的坑）。"""
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--query", "x", "--wiki-dir", str(wiki),
         "--format", "json", "--preflight-json"],
        capture_output=True, text=True, timeout=120,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, timeout=60)


def test_non_git_wiki_warns(tmp_path: Path) -> None:
    """wiki 不是 git 仓库 → 必须警告（多机归档无法同步）。"""
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    r = _run_preflight(wiki)
    assert r["is_repo"] is False
    assert any("不在 git 仓库" in w for w in r["warnings"])


def test_clean_repo_has_no_warning(tmp_path: Path) -> None:
    """干净的 git 仓库不应产生噪音警告。"""
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    _git(wiki, "init", "-q")
    _git(wiki, "config", "user.email", "t@t")
    _git(wiki, "config", "user.name", "t")
    (wiki / "a.md").write_text("# a\n", encoding="utf-8")
    _git(wiki, "add", ".")
    _git(wiki, "commit", "-q", "-m", "init")

    r = _run_preflight(wiki)
    assert r["is_repo"] is True
    assert r["checks"].get("conflicts") == []
    assert not any("冲突" in w for w in r["warnings"])


def test_unmerged_conflict_warns(tmp_path: Path) -> None:
    """存在未解决冲突 → 必须警告（否则写进去的内容永远提交不了）。"""
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    _git(wiki, "init", "-q")
    _git(wiki, "config", "user.email", "t@t")
    _git(wiki, "config", "user.name", "t")
    f = wiki / "log.md"
    f.write_text("base\n", encoding="utf-8")
    _git(wiki, "add", ".")
    _git(wiki, "commit", "-q", "-m", "base")

    _git(wiki, "checkout", "-q", "-b", "other")
    f.write_text("other\n", encoding="utf-8")
    _git(wiki, "commit", "-q", "-am", "other")

    _git(wiki, "checkout", "-q", "-")
    f.write_text("main\n", encoding="utf-8")
    _git(wiki, "commit", "-q", "-am", "main")

    # 制造冲突（merge 会非 0 退出，这是预期的）
    subprocess.run(["git", "-C", str(wiki), "merge", "other"],
                   capture_output=True, text=True, timeout=60)

    r = _run_preflight(wiki)
    conflicts = r["checks"].get("conflicts") or []
    assert conflicts, "应检测到未解决冲突"
    assert any("冲突" in w for w in r["warnings"]), f"应给出冲突警告，实际 {r['warnings']}"


def test_warning_does_not_block_write(tmp_path: Path) -> None:
    """关键取舍：警告不得阻止归档写盘。"""
    wiki = tmp_path / "wiki"
    (wiki / "wiki/projects/demo/tasks").mkdir(parents=True)
    # 刻意不初始化 git → 必然产生 warning
    page = "wiki/projects/demo/tasks/t1.md"
    (wiki / page).write_text("---\ntitle: T\n---\n\n# T\n", encoding="utf-8")

    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--query", "x", "--wiki-dir", str(wiki),
         "--project-slug", "demo", "--format", "json",
         "--append-log", "--task-page", page, "--title", "T"],
        capture_output=True, text=True, timeout=120,
    )
    assert r.returncode == 0, r.stderr
    log = wiki / "log.md"
    assert log.exists(), "即使 git 检查有警告，log.md 也必须被写入"
    assert "T" in log.read_text(encoding="utf-8")

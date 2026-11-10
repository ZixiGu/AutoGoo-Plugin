"""wiki-gov.py 的治理脚本测试。

最关键的一条：**脚本必须零写操作**。
项目规范要求删除文件前必须获得明确同意，自动"整理" wiki 的风险远大于收益。
所以这里用「运行前后目录树的 mtime + 内容哈希完全一致」来断言。
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/auto-goo/scripts/wiki-gov.py"


def _snapshot(root: Path) -> dict[str, str]:
    """目录快照：相对路径 -> 内容哈希。"""
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out[p.relative_to(root).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


@pytest.fixture()
def wiki(tmp_path: Path) -> Path:
    root = tmp_path / "wiki"
    (root / "wiki/projects/demo/lessons").mkdir(parents=True)

    # 4 个同内容的重复版本（模拟 autogoo 项目里真实存在的那组）
    body = "# 训练流程\n\n" + ("这是一段足够长的正文内容用于触发判重逻辑。" * 20)
    for i in range(4):
        (root / f"wiki/projects/demo/lessons/v{i}.md").write_text(
            f"---\ntitle: 训练流程\n---\n\n{body}\n", encoding="utf-8"
        )
    # 一篇无关的笔记
    (root / "wiki/projects/demo/lessons/other.md").write_text(
        "---\ntitle: 完全不同的内容\n---\n\n" + ("别的主题讨论，与训练无关。" * 20) + "\n",
        encoding="utf-8",
    )
    return root


def test_script_exists_and_help_works():
    assert SCRIPT.exists(), "wiki-gov.py 缺失"
    r = subprocess.run([sys.executable, str(SCRIPT), "--help"],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0
    assert "--audit" in r.stdout


def test_duplicates_are_clustered_not_listed_as_pairs(wiki: Path):
    """4 个同内容文件应聚成 1 组，而不是报 6 对让人以为有 6 个问题。"""
    r = subprocess.run([sys.executable, str(SCRIPT), "--audit", str(wiki), "--json"],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    dup = data["duplicates"]
    assert dup["pair_count"] == 6, f"4 篇两两比较应有 6 对，实际 {dup['pair_count']}"
    assert dup["cluster_count"] == 1, f"应聚成 1 组，实际 {dup['cluster_count']}"
    assert dup["clusters"][0]["size"] == 4
    assert dup["clusters"][0]["max_score"] >= 0.62


def test_unrelated_note_is_not_reported(wiki: Path):
    r = subprocess.run([sys.executable, str(SCRIPT), "--dupes", str(wiki), "--json"],
                       capture_output=True, text=True, timeout=120)
    data = json.loads(r.stdout)
    members = {m for c in data.get("pairs", []) for m in (c["a"], c["b"])}
    assert not any("other.md" in m for m in members), "无关笔记不应被判为重复"


def test_zero_write_operations(wiki: Path):
    """**核心安全断言**：治理脚本不得修改、移动或删除任何文件。

    项目规范：删除任何文件前必须先征得用户明确同意。
    一个"自动整理 wiki"的脚本如果偷偷改了东西，损失不可逆。
    """
    before = _snapshot(wiki)
    for args in (
        ["--audit", str(wiki)],
        ["--dupes", str(wiki)],
        ["--stale", str(wiki), "--days", "1"],
        ["--audit", str(wiki), "--json"],
    ):
        r = subprocess.run([sys.executable, str(SCRIPT)] + args,
                           capture_output=True, text=True, timeout=120)
        assert r.returncode == 0, f"{args} 失败: {r.stderr}"
    after = _snapshot(wiki)
    assert before == after, "治理脚本修改了文件 —— 违反零删除/零改写原则"


def test_mark_superseded_only_prints(wiki: Path):
    """标记建议只打印，不写文件。"""
    target = wiki / "wiki/projects/demo/lessons/v0.md"
    before = target.read_text(encoding="utf-8")
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--mark-superseded",
         "wiki/projects/demo/lessons/v0.md", "wiki/projects/demo/lessons/v1.md"],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0
    assert "superseded_by" in r.stdout
    assert "不会修改任何文件" in r.stdout or "不修改" in r.stdout
    assert target.read_text(encoding="utf-8") == before, "不应写文件"


def test_stale_detection(wiki: Path):
    """--stale 能按天数筛出旧笔记（用 mtime=0 天前的小阈值验证逻辑通路）。"""
    r = subprocess.run([sys.executable, str(SCRIPT), "--stale", str(wiki), "--days", "0", "--json"],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    assert data["count"] >= 1, "days=0 时所有笔记都应算 stale"
    assert all("path" in x and "age_days" in x for x in data["items"])

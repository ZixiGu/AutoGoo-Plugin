"""goo-gc.py 的行为断言。

本脚本存在的全部意义是「**零自动删除**」，所以测试的重心不是覆盖率，而是：

1. 默认（无参数）运行时 `.goo/` 一个字节都不能变 —— 用运行前后的目录快照断言。
2. `--apply` 只允许删 `site/`、旧 `backups/`、轮转日志；
   `.goo/plan.json`、`threads/*/plan.json`、`threads/*/logs/*.log`
   必须原样保留（哪怕真的被放进可清理目录也要 abort）。
3. 输出里有可复核的「删了会怎样」清单和将释放的字节数。
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/auto-goo/scripts"
SCRIPT = SCRIPTS / "goo-gc.py"


# ── 载入被测模块（需要 scripts/ 在 sys.path 上才能 import _paths） ────────────

@pytest.fixture(scope="module")
def gc():
    if str(SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location("goo_gc_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


# ── 夹具：一个「该有的大目录都有」的 .goo ─────────────────────────────────────

def _write(path: Path, content: str | bytes = "x", mtime: float | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    goo = tmp_path / ".goo"
    goo.mkdir()
    (goo / "config.json").write_text(json.dumps({"workspace": {}}), encoding="utf-8")
    (goo / "plan.json").write_text(json.dumps({"id": "p", "steps": []}), encoding="utf-8")

    # site/：12 个可重建文件，其中一个故意命名为 plan.json（应触发 abort 场景）
    for name in ("index", "plan", "status", "threads", "activity", "observe"):
        _write(goo / "site" / f"{name}.html", "<html>site</html>")
    _write(goo / "site" / "server.json", "{}")

    # backups/：5 份，按 mtime 从旧到新
    for index in range(5):
        _write(goo / "backups" / f"flip-{index}" / "snapshot.tar.gz", b"z" * 64,
               mtime=1_700_000_000 + index * 3600)
    _write(goo / "backups" / ".last-layer-flip", "flip-4")

    # threads/：plan + step log，绝对不能碰
    thread = goo / "threads" / "demo-thread"
    _write(thread / "plan.json", json.dumps({"id": "p", "thread": {"id": "demo-thread"}}))
    _write(thread / "thread.json", json.dumps({"id": "demo-thread"}))
    _write(thread / "logs" / "step-1.log", "step log line\n")
    _write(thread / "artifacts" / "s1-report.md", "# report\n")

    # logs/：当前日志 + 若干轮转归档
    _write(goo / "logs" / "current.md", "current log\n")
    for index in range(4):
        _write(goo / "logs" / f"task.log.{index}", b"r" * 4096,
               mtime=1_700_000_000 + index * 3600)

    _write(goo / "plans" / "history" / "plan-2026-05-06.archived.json", "{}")
    _write(goo / "artifacts" / "s1.md", "# artifact\n")
    return tmp_path


def _snapshot(root: Path) -> dict[str, str]:
    """目录快照：相对路径 -> (内容哈希 | 'DIR')。用于断言「一个字节都没动」。"""
    out: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if path.is_dir():
            out[rel + "/"] = "DIR"
        elif path.is_file():
            out[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def _run(project: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(project), *args],
        capture_output=True,
        text=True,
        cwd=str(project),
    )


# ── 1. 默认 dry-run：不删、不写 ──────────────────────────────────────────────

def test_default_run_is_dry_run_and_touches_nothing(project: Path) -> None:
    before = _snapshot(project / ".goo")
    result = _run(project)
    assert result.returncode == 0, result.stderr
    after = _snapshot(project / ".goo")

    assert before == after, "默认运行必须完全只读（任何新增/删除/改写都算违规）"
    assert "dry-run" in result.stdout
    assert "未删除任何文件" in result.stdout
    assert "--apply" in result.stdout


def test_dry_run_reports_reclaimable_bytes_and_impact(project: Path) -> None:
    payload = json.loads(_run(project, "--json").stdout)
    assert payload["mode"] == "dry-run"
    assert payload["reclaimable_count"] > 0
    assert payload["reclaimable_bytes"] > 0

    categories = {group["category"]: group for group in payload["groups"]}
    assert categories["site"]["count"] == 7  # 6 个 html + server.json
    # 「删了会怎样」清单必须覆盖所有被清理类别
    text = _run(project).stdout
    assert "删了会怎样" in text
    for category in ("site", "backups", "logs"):
        if categories[category]["count"]:
            assert f"[{category}]" in text


# ── 2. 受保护路径永不进候选 ──────────────────────────────────────────────────

def test_no_candidate_is_a_plan_or_step_log(project: Path) -> None:
    payload = json.loads(_run(project, "--json").stdout)
    candidates = [Path(item["path"]) for item in payload["candidates"]]
    assert candidates, "夹具应当有可清理项"

    for path in candidates:
        assert path.name != "plan.json", f"plan.json 不得成为候选: {path}"
        assert "threads" not in path.parts, f"threads/** 不得成为候选: {path}"
        assert not path.name.endswith(".log"), f"step log 不得成为候选: {path}"


def test_protection_reason_covers_hard_gates(gc) -> None:
    goo = Path("/tmp/proj/.goo")
    assert gc.protection_reason(goo / "plan.json")
    assert gc.protection_reason(goo / "threads" / "t1" / "plan.json")
    assert gc.protection_reason(goo / "threads" / "t1" / "logs" / "step-1.log")
    assert gc.protection_reason(goo / "current_thread.json")
    assert gc.protection_reason(goo / "config.json")
    assert gc.protection_reason(goo / "threads" / "index.json")
    # 可清理物的名字不应被误判
    assert gc.protection_reason(goo / "site" / "index.html") is None
    assert gc.protection_reason(goo / "backups" / "flip-1" / "snapshot.tar.gz") is None


# ── 3. --apply 只删可重建物 ──────────────────────────────────────────────────

def test_apply_removes_site_and_old_backups_but_keeps_state(project: Path) -> None:
    goo = project / ".goo"
    result = _run(project, "--apply", "--keep-backups", "3")
    assert result.returncode == 0, result.stderr

    # site/ 清空，但目录还在（goo-publish 会重建内容）
    assert (goo / "site").is_dir()
    assert list((goo / "site").iterdir()) == []

    # backups：保留最近 3 份 + 指针文件，删掉最旧 2 份
    remaining = sorted(p.name for p in (goo / "backups").iterdir())
    assert remaining == [".last-layer-flip", "flip-2", "flip-3", "flip-4"]

    # 执行状态与留痕一个都不能少
    assert (goo / "plan.json").exists()
    assert (goo / "threads" / "demo-thread" / "plan.json").exists()
    assert (goo / "threads" / "demo-thread" / "logs" / "step-1.log").read_text(encoding="utf-8")
    assert (goo / "threads" / "demo-thread" / "thread.json").exists()
    assert (goo / "threads" / "demo-thread" / "artifacts" / "s1-report.md").exists()
    assert (goo / "config.json").exists()
    assert (goo / "plans" / "history" / "plan-2026-05-06.archived.json").exists()
    assert (goo / "artifacts" / "s1.md").exists()
    # 非轮转日志保留
    assert (goo / "logs" / "current.md").exists()


def test_apply_writes_audit_log(project: Path) -> None:
    before = set(p.name for p in (project / ".goo" / "logs").iterdir())
    result = _run(project, "--apply")
    assert result.returncode == 0, result.stderr
    after = set(p.name for p in (project / ".goo" / "logs").iterdir())

    new = after - before
    logs = [name for name in new if name.startswith("gc-") and name.endswith(".md")]
    assert len(logs) == 1, f"--apply 必须留审计记录，实际新增: {sorted(new)}"
    audit = (project / ".goo" / "logs" / logs[0]).read_text(encoding="utf-8")
    assert "goo-gc 执行记录" in audit
    assert "site" in audit


def test_apply_aborts_when_candidate_is_protected(project: Path) -> None:
    # 模拟分类逻辑出错：plan.json 出现在可清理目录里
    stray = project / ".goo" / "site" / "plan.json"
    stray.write_text(json.dumps({"id": "leak"}), encoding="utf-8")
    before = _snapshot(project / ".goo")

    result = _run(project, "--apply")
    assert result.returncode == 2, "命中受保护路径必须整体 abort"
    assert _snapshot(project / ".goo") == before, "abort 时一个文件都不能删"
    assert "abort" in result.stdout.lower()


# ── 4. 各类保留策略 ──────────────────────────────────────────────────────────

def test_backups_keep_latest_three(project: Path) -> None:
    payload = json.loads(_run(project, "--json", "--keep-backups", "3").stdout)
    names = [
        Path(item["path"]).name
        for item in payload["candidates"]
        if item["category"] == "backups"
    ]
    assert sorted(names) == ["flip-0", "flip-1"]  # 最旧的两份


def test_log_budget_removes_oldest_rotated_only(gc, project: Path) -> None:
    logs_dir = project / ".goo" / "logs"
    threads_dir = project / ".goo" / "threads"
    # 4×4KiB 轮转 + 1KiB 当前日志 = 17KiB；预算 8KiB → 只清最旧的轮转归档
    candidates, meta = gc.log_candidates(logs_dir, 8 * 1024, 0, threads_dir)
    paths = sorted(Path(item["path"]).name for item in candidates)
    assert meta["budget_hit"] is True
    assert paths == ["task.log.0", "task.log.1", "task.log.2"]
    assert "current.md" not in paths


def test_log_candidates_never_target_step_logs(gc, project: Path) -> None:
    threads_dir = project / ".goo" / "threads"
    # 即便预算为 0（最激进），step log 也不能进入候选
    candidates, _ = gc.log_candidates(project / ".goo" / "logs", 0, 3650, threads_dir)
    for item in candidates:
        path = Path(item["path"])
        assert "threads" not in path.parts
        assert path.suffix != ".log"


def test_logs_untouched_when_under_budget_and_not_expired(gc, project: Path) -> None:
    candidates, meta = gc.log_candidates(
        project / ".goo" / "logs", 5 * 1024 * 1024, 0, project / ".goo" / "threads"
    )
    assert candidates == []
    assert meta["budget_hit"] is False


def test_only_site_leaves_backups_alone(project: Path) -> None:
    payload = json.loads(_run(project, "--json", "--only", "site").stdout)
    categories = {item["category"] for item in payload["candidates"]}
    assert categories == {"site"}

    result = _run(project, "--apply", "--only", "site")
    assert result.returncode == 0, result.stderr
    assert len(list((project / ".goo" / "backups").iterdir())) == 6  # 5 份 + 指针文件


# ── 5. 扫描分类与增长信息 ────────────────────────────────────────────────────

def test_scan_classifies_rebuildability(project: Path) -> None:
    payload = json.loads(_run(project, "--json").stdout)
    by_name = {row["name"]: row for row in payload["dirs"]}

    assert by_name["site"]["rebuildability"] == "可重建"
    assert by_name["site"]["action"] == "purge"
    assert by_name["backups"]["action"] == "keep-latest"
    assert by_name["logs"]["rebuildability"] == "部分可重建"
    assert by_name["threads"]["action"] == "never"
    assert by_name["plans"]["action"] == "never"
    assert by_name["threads"]["protected_files"] == by_name["threads"]["files"]
    assert by_name["site"]["bytes"] > 0
    assert by_name["site"]["growth_bytes_per_day"] is not None


def test_snapshot_enables_real_growth_delta(project: Path) -> None:
    first = _run(project, "--snapshot", "--json")
    assert first.returncode == 0, first.stderr
    payload = json.loads(first.stdout)
    assert Path(payload["snapshot_path"]).exists()

    # 新增 8KiB 后，第二次运行应报出 site 的正向 delta
    (project / ".goo" / "site" / "extra.html").write_bytes(b"y" * 8192)
    second = json.loads(_run(project, "--json").stdout)
    site = next(row for row in second["dirs"] if row["name"] == "site")
    assert site["delta_bytes"] == 8192


def test_missing_logs_dir_does_not_crash(tmp_path: Path):
    """`.goo/logs` 不存在时不得崩溃。

    回归：`log_candidates` 的早退分支曾只返回 3 个字段（正常路径 6 个），
    导致 `build_report` 访问 `log_meta['rotated_count']` 时 KeyError。
    而「logs 目录不存在」恰恰是新项目 / 刚清理完的最常见状态。
    """
    goo = tmp_path / ".goo"
    goo.mkdir()
    (goo / "plan.json").write_text('{"steps": []}', encoding="utf-8")
    # 刻意不创建 logs/ 子目录

    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(tmp_path)],
        capture_output=True, text=True, timeout=120,
    )
    assert r.returncode == 0, f"logs 缺失时应正常退出，实际 {r.returncode}:\n{r.stderr}"
    assert "KeyError" not in r.stderr
    assert "Traceback" not in r.stderr


def test_log_meta_fields_consistent_across_paths(tmp_path: Path):
    """有 logs 与无 logs 两条路径返回的 meta 字段集必须一致。"""
    import importlib.util

    spec = importlib.util.spec_from_file_location("goo_gc", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    missing = tmp_path / "missing"
    _, meta_missing = mod.log_candidates(missing, 1024, 7, tmp_path)

    present = tmp_path / "present"
    present.mkdir()
    (present / "app.log.1").write_text("x" * 100, encoding="utf-8")
    _, meta_present = mod.log_candidates(present, 10, 7, tmp_path / "threads")

    assert set(meta_missing) == set(meta_present), (
        f"字段集不一致：缺失路径 {sorted(meta_missing)} vs 存在路径 {sorted(meta_present)}"
    )

"""goo-status 的 step log 归组口径回归测试。

背景（0.34.1 实测）：`collect_step_logs` 只认 `*_step-N_*.md`，
而派发路径写的是 `logs/step-N.log`。两处后果都已实测到：

1. **假红**：thread 自己的 plan 下 7/7 步骤报「没有对应 step log」（日志都在）。
2. **假绿**：`.goo/plan.json` 镜像 plan 会把 `.goo/logs` 里**别的 plan 的同号
   日志**当成自己的证据（2026-05 的日志给 2026-11 的 plan 作证）。

这两条都不能只靠「面板看着没问题」判断，必须有断言。
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/auto-goo/scripts"
GOO_STATUS = SCRIPTS / "goo-status.py"

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def gs():
    return _load("goo_status", GOO_STATUS)


@pytest.fixture(scope="module")
def paths():
    return _load("_paths_under_test", SCRIPTS / "_paths.py")


# ── 1. 命名识别 ─────────────────────────────────────────────────────────────


def test_collect_step_logs_recognizes_dispatch_naming(gs, tmp_path: Path) -> None:
    (tmp_path / "step-3.log").write_text("start\n", encoding="utf-8")
    found = gs.collect_step_logs(tmp_path)
    assert "3" in found, "派发路径写的 step-N.log 必须被认成 step log（否则假红）"
    assert found["3"][0].name == "step-3.log"


def test_collect_step_logs_still_recognizes_legacy_naming(gs, tmp_path: Path) -> None:
    legacy = "2026-11-16T10-00-00_step-2_DAG调度.md"
    (tmp_path / legacy).write_text("body\n", encoding="utf-8")
    assert "2" in gs.collect_step_logs(tmp_path), "旧命名 update-step.py 产物仍要认"


def test_exec_trace_is_not_mistaken_for_step_log(gs, tmp_path: Path) -> None:
    (tmp_path / "step-1.exec.jsonl").write_text("{}\n", encoding="utf-8")
    assert gs.collect_step_logs(tmp_path) == {}, "执行轨迹不是状态日志，不能顶替"


def test_logs_older_than_plan_are_ignored(gs, tmp_path: Path) -> None:
    stale = "2026-05-06T17-32-00_step-1_旧plan.md"
    (tmp_path / stale).write_text("body\n", encoding="utf-8")
    since = datetime(2026, 11, 16, 7, 37, 26, tzinfo=timezone.utc)
    assert gs.collect_step_logs(tmp_path, since=since) == {}, (
        "早于 plan created_at 的日志一定是别的 plan 的，不能算本 plan 证据"
    )


# ── 2. 镜像 plan 的 logs 目录解析 ───────────────────────────────────────────


def _make_project(root: Path, *, mirror: bool) -> Path:
    goo = root / ".goo"
    thread = goo / "threads" / "tg-1"
    (thread / "logs").mkdir(parents=True)
    (goo / "logs").mkdir(parents=True)
    (thread / "logs" / "step-1.log").write_text("start\n", encoding="utf-8")
    # 别的 plan 留下的同号旧日志：绝不能被当成本 plan 的证据
    (goo / "logs" / "2026-05-06T17-32-00_step-1_旧任务.md").write_text("old\n", encoding="utf-8")
    plan = {
        "task": "t",
        "status": "completed",
        "created_at": "2026-11-16T07-37-26",
        "steps": [{"id": 1, "name": "s", "status": "completed", "progress": 100}],
        "thread": {"id": "tg-1", "logs_dir": ".goo/threads/tg-1/logs"},
    }
    plan_path = goo / "plan.json" if mirror else thread / "plan.json"
    plan_path.write_text(json.dumps(plan), encoding="utf-8")
    return plan_path


def test_mirror_plan_uses_declared_thread_logs_dir(paths, tmp_path: Path) -> None:
    plan_path = _make_project(tmp_path, mirror=True)
    data = json.loads(plan_path.read_text(encoding="utf-8"))
    resolved = paths.logs_dir_from_plan(plan_path, data)
    assert resolved.name == "logs"
    assert resolved.parent.name == "tg-1", "镜像 plan 必须按 thread.logs_dir 找日志，不能退回全局 .goo/logs"


def test_thread_plan_still_prefers_local_logs_dir(paths, tmp_path: Path) -> None:
    plan_path = _make_project(tmp_path, mirror=False)
    data = json.loads(plan_path.read_text(encoding="utf-8"))
    resolved = paths.logs_dir_from_plan(plan_path, data)
    assert resolved == plan_path.parent / "logs"


def test_stale_declared_logs_dir_is_ignored(paths, tmp_path: Path) -> None:
    plan_path = _make_project(tmp_path, mirror=True)
    data = json.loads(plan_path.read_text(encoding="utf-8"))
    data["thread"]["logs_dir"] = ".goo/threads/gone/logs"
    resolved = paths.logs_dir_from_plan(plan_path, data)
    assert resolved == tmp_path / ".goo" / "logs", "声明的目录不存在时要退回默认，而不是指向不存在的路径"


# ── 3. 端到端：面板不得出现假红/假绿 ────────────────────────────────────────


@pytest.mark.parametrize("mirror", [True, False])
def test_status_render_does_not_report_missing_logs(tmp_path: Path, mirror: bool) -> None:
    plan_path = _make_project(tmp_path, mirror=mirror)
    # 补一个真正的日志内容，让「有 log」可验证到行数
    (tmp_path / ".goo/threads/tg-1/logs/step-1.log").write_text("a\nb\nc\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(GOO_STATUS), "--plan", str(plan_path)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert "没有对应 step log" not in result.stdout, result.stdout


# ── 4. 两个消费者(goo-status / goo-observe)必须同一口径 ─────────────────────


def test_observe_resolves_dispatch_naming_for_step_without_log_path(tmp_path: Path) -> None:
    observe = _load("goo_observe_under_test", SCRIPTS / "goo-observe.py")
    logs_dir = tmp_path / "logs"
    logs_dir.mkdir()
    (logs_dir / "step-2.log").write_text("tail\n", encoding="utf-8")
    resolved = observe.step_log_path(tmp_path, logs_dir, {"id": 2})
    assert resolved == logs_dir / "step-2.log", "面板兜底也必须认出 step-N.log，否则「看不到日志」"

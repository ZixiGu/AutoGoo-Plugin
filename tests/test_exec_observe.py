"""执行事件流（`.goo/logs/exec.jsonl`）的回归测试。

覆盖 2026-11-16 实测暴露的缺口（见 artifacts/s2-alerting.md）：

1. 失败/卡住/超时以前**只在 TUI 与 step log 里出现**，无人值守时没人知道 DAG 停了
   → 每次状态跃迁必须落一条可聚合的事件（含耗时、退出码、stderr 摘录）。
2. 指标写入失败**绝不阻塞执行**：jsonl 写不进去时状态更新仍然成功。
3. JSONL 约定与 `recall.jsonl` 一致（追加写、单行 JSON、4MB 轮转）。
4. 误报防线：心跳不入事件流（否则真事件被淹）；`--status pending` 的
   「重试」与「解锁」不能混成一个事件（会让「平均重试几次」虚高）。

测试全部在 tmp_path 里构造 project，不碰仓库真实 `.goo/`。
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/auto-goo/scripts"
UPDATE_STEP = SCRIPTS / "update-step.py"

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def ex():
    return _load("exec_observe")


def make_plan(tmp: Path, *, steps: list[dict] | None = None, thread: str = "t-1") -> Path:
    """建一个最小可用 project：.goo/plan.json + schema_version 当前值。"""
    sys.path.insert(0, str(SCRIPTS))
    import plan_schema  # noqa: PLC0415 - 需要 SCRIPTS 先进 sys.path

    goo = tmp / ".goo"
    goo.mkdir(parents=True, exist_ok=True)
    plan = {
        "schema_version": plan_schema.CURRENT_SCHEMA_VERSION,
        "task": "exec observe test",
        "status": "running",
        "created_at": "2026-11-16T08:00:00Z",
        "thread": {"id": thread},
        "steps": steps
        or [
            {
                "id": 1,
                "name": "step one",
                "description": "demo",
                "depends_on": [],
                "type": "exec",
                "subagent": "implementer",
                "status": "pending",
                "progress": 0,
            }
        ],
    }
    plan_path = goo / "plan.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    return plan_path


def run_update(plan_path: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(UPDATE_STEP), "--plan", str(plan_path), *args],
        cwd=str(plan_path.parents[1]),
        capture_output=True,
        text=True,
        timeout=90,
    )


def read_log(plan_path: Path) -> list[dict]:
    log = plan_path.parent / "logs" / "exec.jsonl"
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]


# ── 1. 基础约定：路径 / JSONL / 轮转 ─────────────────────────────────────────


def test_exec_log_lives_next_to_recall_log(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    path = ex.exec_log_path(plan_path)
    # recall.jsonl 在 .goo/logs/ 下，exec.jsonl 必须同目录（同一套轮转/读取约定）
    assert path == tmp_path / ".goo" / "logs" / "exec.jsonl"


def test_append_writes_one_json_object_per_line(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    assert ex.append_event(plan_path, {"event": "step_start", "step_id": "1"})
    assert ex.append_event(plan_path, {"event": "step_complete", "step_id": "1"})
    rows = read_log(plan_path)
    assert [r["event"] for r in rows] == ["step_start", "step_complete"]
    assert all("ts" in r for r in rows), "每行都必须带 ts，否则无法算耗时/停滞"


def test_event_rotation_matches_recall_convention(tmp_path: Path, ex, monkeypatch) -> None:
    plan_path = make_plan(tmp_path)
    ex.append_event(plan_path, {"event": "step_start", "step_id": "1"})
    log = ex.exec_log_path(plan_path)
    # 缩小阈值模拟超大文件，验证轮转为 .1（与 recall.jsonl 同后缀约定）
    monkeypatch.setattr(ex, "MAX_BYTES", 10)
    ex.append_event(plan_path, {"event": "step_complete", "step_id": "1"})
    assert log.with_name("exec.jsonl.1").exists(), "超过阈值必须轮转"
    assert [r["event"] for r in read_log(plan_path)] == ["step_complete"]


# ── 2. 事件语义映射 ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "action,kwargs,expected",
    [
        ("start", {}, "step_start"),
        ("complete", {}, "step_complete"),
        ("fail", {}, "step_fail"),
        ("interrupt", {}, "step_interrupt"),
        ("interrupt", {"timed_out": True}, "step_timeout"),
        ("resume", {}, "step_resume"),
        ("block", {}, "step_block"),
        ("status:pending", {"retry": True}, "step_retry"),
        ("status:pending", {}, "step_pending"),
        ("heartbeat", {}, None),
    ],
)
def test_action_maps_to_event(tmp_path: Path, ex, action, kwargs, expected) -> None:
    plan_path = make_plan(tmp_path)
    step = {"id": 1, "name": "s", "status": "running", "progress": 10}
    ex.record_transition(plan_path, step, action, **kwargs)
    rows = read_log(plan_path)
    assert [r["event"] for r in rows] == ([expected] if expected else [])


def test_timeout_is_classified_from_error_text_too(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    step = {"id": 2, "name": "s", "status": "interrupted"}
    ex.record_transition(plan_path, step, "interrupt", error="Heartbeat timeout > 900s")
    rows = read_log(plan_path)
    assert rows[0]["event"] == "step_timeout"
    assert rows[0]["error_class"] == "timeout"


def test_classify_error_buckets(ex) -> None:
    assert ex.classify_error("subagent wrapper 中断", exit_code=143) == "signal_killed"
    assert ex.classify_error("Error: invalid api key", exit_code=1) == "auth"
    assert ex.classify_error("429 Too Many Requests") == "rate_limit"
    assert ex.classify_error("", exit_code=1) == "exit_code"
    assert ex.classify_error("") is None


def test_timed_out_flag_alone_is_timeout(ex) -> None:
    """timed_out=True 必须自己归到 timeout：不能靠 error 文本里恰好出现 timeout。

    旧用例全部走文本匹配（"Heartbeat timeout > 900s"），把 `if timed_out: return
    "timeout"` 这分支删掉 27 个用例仍然全绿 —— 这是实测到的假绿。
    wrapper 超时中断时 error 文本往往是「wrapper 中断（exit 143）」，不含 timeout 字样。
    """
    assert ex.classify_error(None, timed_out=True) == "timeout"
    assert ex.classify_error("wrapper 中断（exit 143）", exit_code=143, timed_out=True) == "timeout"
    assert ex.classify_error("", timed_out=True) == "timeout"


# ── 3. 耗时口径 ─────────────────────────────────────────────────────────────


def test_reported_duration_wins_over_plan_timestamps(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    step = {
        "id": 1,
        "name": "s",
        "status": "completed",
        "started_at": "2026-11-16T08:00:00Z",
        "completed_at": "2026-11-16T09:00:00Z",  # plan 口径 = 3600s
    }
    ex.record_transition(plan_path, step, "complete", duration_ms=12_500)
    row = read_log(plan_path)[0]
    # 调用方实测值优先：重试会让 started_at 保留第一次的时间，plan 口径会虚高
    assert row["duration_ms"] == 12_500
    assert row["duration_source"] == "reported"


def test_duration_falls_back_to_plan_timestamps(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    step = {
        "id": 1,
        "name": "s",
        "status": "completed",
        "started_at": "2026-11-16T08:00:00Z",
        "completed_at": "2026-11-16T08:02:30Z",
    }
    ex.record_transition(plan_path, step, "complete")
    row = read_log(plan_path)[0]
    assert row["duration_ms"] == 150_000
    assert row["duration_source"] == "plan"


def test_start_event_has_no_duration(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    ex.record_transition(plan_path, {"id": 1, "name": "s", "status": "running"}, "start")
    row = read_log(plan_path)[0]
    # 0 会被聚合成一个假的「飞快完成」样本，置空更诚实
    assert row.get("duration_ms") is None


def test_exit_code_and_stderr_are_recorded(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    step = {"id": 1, "name": "s", "status": "failed"}
    ex.record_transition(
        plan_path,
        step,
        "fail",
        exit_code=1,
        duration_ms=1000,
        stderr_excerpt="Error: model not found: nope",
        error="subagent exit 1",
    )
    row = read_log(plan_path)[0]
    assert row["exit_code"] == 1
    assert "model not found" in row["stderr_excerpt"]
    assert row["error_class"] == "model"


def test_long_fields_are_truncated(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    ex.record_transition(
        plan_path,
        {"id": 1, "name": "s", "status": "failed"},
        "fail",
        error="x" * 2000,
        stderr_excerpt="y" * 2000,
    )
    row = read_log(plan_path)[0]
    # 单行 JSON 不能因为一次失败就写出几百 KB
    assert len(row["error"]) <= 401
    assert len(row["stderr_excerpt"]) <= 301


# ── 4. 写入失败绝不阻塞执行 ─────────────────────────────────────────────────


def test_append_failure_never_raises(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    log = ex.exec_log_path(plan_path)
    log.parent.mkdir(parents=True, exist_ok=True)
    log.mkdir()  # 让 open(append) 必然失败（IsADirectoryError）
    assert ex.append_event(plan_path, {"event": "step_start"}) is False
    assert ex.record_transition(plan_path, {"id": 1, "status": "running"}, "start") is False


def test_update_step_succeeds_when_metrics_unwritable(tmp_path: Path, ex) -> None:
    plan_path = make_plan(tmp_path)
    log = ex.exec_log_path(plan_path)
    log.parent.mkdir(parents=True, exist_ok=True)
    log.mkdir()  # 指标文件位置被占成一个目录
    result = run_update(plan_path, "--step-id", "1", "--complete", "--duration-ms", "100")
    assert result.returncode == 0, result.stderr
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    assert plan["steps"][0]["status"] == "completed", "指标写失败不能影响状态落盘"


# ── 5. 端到端：真实 update-step CLI ──────────────────────────────────────────


def test_update_step_end_to_end_records_events(tmp_path: Path) -> None:
    plan_path = make_plan(tmp_path)
    assert run_update(plan_path, "--step-id", "1", "--start", "--agent-id", "agent-1").returncode == 0
    assert run_update(
        plan_path,
        "--step-id",
        "1",
        "--complete",
        "--exit-code",
        "0",
        "--duration-ms",
        "4200",
    ).returncode == 0
    rows = read_log(plan_path)
    assert [r["event"] for r in rows] == ["step_start", "step_complete"]
    assert rows[0]["agent_id"] == "agent-1"
    assert rows[1]["duration_ms"] == 4200
    assert rows[1]["exit_code"] == 0
    assert rows[1]["thread"] == "t-1"


def test_heartbeat_does_not_flood_event_stream(tmp_path: Path) -> None:
    plan_path = make_plan(tmp_path)
    assert run_update(plan_path, "--step-id", "1", "--start").returncode == 0
    for i in range(3):
        assert run_update(plan_path, "--step-id", "1", "--heartbeat", "--note", f"progress {i}").returncode == 0
    rows = read_log(plan_path)
    assert [r["event"] for r in rows] == ["step_start"], "心跳每 20s 一条会把真事件淹掉"


def test_interrupt_with_timed_out_flag_is_step_timeout(tmp_path: Path) -> None:
    plan_path = make_plan(tmp_path)
    run_update(plan_path, "--step-id", "1", "--start")
    result = run_update(
        plan_path,
        "--step-id",
        "1",
        "--interrupt",
        "--timed-out",
        "--error",
        "wrapper 中断（exit 143）",
        "--exit-code",
        "143",
    )
    assert result.returncode == 0, result.stderr
    rows = read_log(plan_path)
    assert rows[-1]["event"] == "step_timeout"
    assert rows[-1]["exit_code"] == 143


def test_retry_flag_distinguishes_retry_from_unblock(tmp_path: Path) -> None:
    plan_path = make_plan(tmp_path)
    run_update(plan_path, "--step-id", "1", "--start")
    run_update(plan_path, "--step-id", "1", "--fail", "--error", "boom")
    run_update(plan_path, "--step-id", "1", "--status", "pending", "--retry", "--note", "Auto-retry #1")
    run_update(plan_path, "--step-id", "1", "--block", "--error", "requires user confirm")
    run_update(plan_path, "--step-id", "1", "--status", "pending", "--note", "unblocked")
    events = [r["event"] for r in read_log(plan_path)]
    assert events.count("step_retry") == 1
    assert events.count("step_pending") == 1, "解锁不是重试，混在一起会让重试均值虚高"


def test_thread_id_derived_from_thread_plan_path(tmp_path: Path, ex) -> None:
    thread_dir = tmp_path / ".goo" / "threads" / "tg-abc" / "logs"
    thread_dir.mkdir(parents=True)
    plan_path = thread_dir.parent / "plan.json"
    plan_path.write_text(json.dumps({"steps": []}), encoding="utf-8")
    assert ex.thread_id_from_plan(plan_path) == "tg-abc"

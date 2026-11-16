"""plan schema 版本化 + checkpoint 幂等的回归测试。

覆盖三件曾在 0.30.0 实测中全部缺失的能力（见 references/plan-schema.md）：

1. 无 schema_version 的旧 plan 必须有明确迁移路径，**不能**静默按新语义解释。
2. 0.27.0 之前写入的 memory_layer（L0=原始日志）必须被识别为旧语义并在迁移时
   翻转成新语义；迁移必须可逆（migrate → revert 复现原文）。
3. resume / 自动重试必须按 checkpoint 比对副作用，已完成的写操作不重复施加。

测试全部在 tmp_path 里构造 plan，不碰仓库里真实的 .goo/。
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
PLAN_SCHEMA = SCRIPTS / "plan_schema.py"
UPDATE_STEP = SCRIPTS / "update-step.py"

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # 必须注册进 sys.modules：dataclass 在 3.12+ 解析注解时会回查 cls.__module__，
    # 未注册时会拿到 None 并抛 AttributeError。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def schema():
    return _load("plan_schema")


@pytest.fixture(scope="module")
def checkpoint():
    return _load("checkpoint")


# ── 夹具：旧语义 plan（0.27.0 之前：L0=原始日志，L3=项目总览） ────────────────

def legacy_plan() -> dict:
    return {
        "task": "legacy task",
        "status": "completed",
        "created_at": "2026-08-04T09:00:00Z",
        "thread": {"id": "t-legacy", "created_at": "2026-08-04T09:00:00Z"},
        "wiki_context": {
            "found": True,
            # 旧语义：原始 log 最热、项目总览最冷
            "reuse_note": "记忆分层原则:L0(原始 log)/L1(原子事实)/L2(场景知识)/L3(项目总览)",
            "memory_layer": "L0",
        },
        "steps": [
            {
                "id": 1,
                "name": "audit",
                "status": "completed",
                "memory_layer": "L0",
                "wiki_layers": ["L0", "L1"],
                "progress": 100,
            }
        ],
    }


def write_project(tmp: Path, plan: dict) -> Path:
    goo = tmp / ".goo"
    goo.mkdir(parents=True, exist_ok=True)
    plan_path = goo / "plan.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    return plan_path


def run_update(plan_path: Path, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(UPDATE_STEP), "--plan", str(plan_path), *args],
        cwd=str(cwd or plan_path.parents[1]),
        capture_output=True,
        text=True,
        timeout=60,
    )


# ── 1. 版本判定 ──────────────────────────────────────────────────────────────

def test_unversioned_legacy_plan_is_detected_as_v1(schema) -> None:
    det = schema.detect(legacy_plan())
    assert det.version == 1
    assert det.explicit is False
    assert det.semantics == "legacy"
    # 证据必须可复核，不能是"猜的"
    assert det.reasons and det.confidence in {"content", "timestamp", "mtime", "default"}


def test_unversioned_post_flip_plan_is_detected_as_v2(schema) -> None:
    plan = legacy_plan()
    plan["created_at"] = "2026-11-16T07:59:32Z"
    plan["thread"]["created_at"] = "2026-11-16T07:59:32Z"
    plan["wiki_context"]["reuse_note"] = "L0 项目总览最热,L3 原始日志最冷"
    plan["wiki_context"]["memory_layer"] = "L1"
    for step in plan["steps"]:
        step["memory_layer"] = "L1"
        step.pop("wiki_layers")
    det = schema.detect(plan)
    assert det.version == 2
    assert det.semantics == "modern"


def test_declared_semantics_beats_heuristics(schema) -> None:
    plan = legacy_plan()
    plan["memory_layer_semantics"] = "modern"
    det = schema.detect(plan)
    assert det.version == 2
    assert det.confidence == "declared"


def test_future_schema_version_is_rejected_with_guidance(schema) -> None:
    plan = {"schema_version": schema.CURRENT_SCHEMA_VERSION + 1, "steps": []}
    with pytest.raises(schema.PlanTooNew) as excinfo:
        schema.detect(plan, plan_path=Path("/tmp/plan.json"))
    message = str(excinfo.value)
    assert "高于本插件支持的上限" in message
    assert "升级插件" in message  # 必须给指引，而不是抛个裸异常


# ── 2. 迁移：语义翻转 + 可逆 ─────────────────────────────────────────────────

def test_migration_flips_legacy_memory_layer(schema) -> None:
    migrated, records = schema.migrate(legacy_plan())
    assert migrated["schema_version"] == schema.CURRENT_SCHEMA_VERSION
    # L0(原始日志) 在新语义里是 L3；L1 是 L2
    assert migrated["wiki_context"]["memory_layer"] == "L3"
    assert migrated["steps"][0]["memory_layer"] == "L3"
    assert migrated["steps"][0]["wiki_layers"] == ["L3", "L2"]
    assert migrated["memory_layer_semantics"] == "modern"
    # 旧语义的**自由文本**只标记待复核，不做机械替换
    first = records[0]
    # wiki_context.memory_layer + step.memory_layer + wiki_layers[0..1] = 4 处
    assert first["flipped_count"] == 4
    assert first["text_mentions_needing_review"]
    assert migrated["schema_migrations"] == records
    assert first["origin"] == {"version": 1, "explicit": False}


def test_migration_is_reversible_for_unversioned_plan(schema) -> None:
    original = legacy_plan()
    migrated, _ = schema.migrate(original)
    reverted, _ = schema.revert(migrated, target=1, drop_durable=True)
    assert reverted == original, "migrate → revert 未能复现原始内容（不可逆）"
    assert "schema_version" not in reverted


def test_migration_is_reversible_for_versioned_plan(schema) -> None:
    original = {"schema_version": 2, "task": "x", "steps": [{"id": 1, "status": "pending"}]}
    migrated, _ = schema.migrate(original)
    assert migrated["steps"][0]["checkpoint_seq"] == 0
    reverted, _ = schema.revert(migrated, target=2, drop_durable=True)
    assert reverted == original


def test_revert_refuses_to_drop_durable_data(schema) -> None:
    plan = {
        "schema_version": 3,
        "steps": [{"id": 1, "status": "completed", "checkpoints": [{"id": "ck-1"}]}],
    }
    with pytest.raises(schema.PlanRevertBlocked):
        schema.revert(plan, target=2)
    dropped, _ = schema.revert(plan, target=2, drop_durable=True)
    assert "checkpoints" not in dropped["steps"][0]


# ── 3. 加载：不静默 + 备份 ───────────────────────────────────────────────────

def test_load_plan_refuses_to_silently_interpret_legacy(schema, tmp_path, monkeypatch) -> None:
    plan_path = write_project(tmp_path, legacy_plan())
    monkeypatch.setenv(schema.AUTOMIGRATE_ENV, "0")
    with pytest.raises(schema.PlanNeedsMigration) as excinfo:
        schema.load_plan(plan_path, mode="write")
    message = str(excinfo.value)
    assert "plan_schema.py migrate" in message
    assert "回滚" in message
    # 严格模式下文件必须原样不动
    assert json.loads(plan_path.read_text(encoding="utf-8")) == legacy_plan()


def test_load_plan_migrates_with_backup_and_audit(schema, tmp_path, monkeypatch) -> None:
    plan_path = write_project(tmp_path, legacy_plan())
    monkeypatch.setenv(schema.AUTOMIGRATE_ENV, "1")
    loaded = schema.load_plan(plan_path, mode="write")
    assert loaded.migrated is True
    assert loaded.backup is not None and loaded.backup.exists()
    on_disk = json.loads(plan_path.read_text(encoding="utf-8"))
    assert on_disk["schema_version"] == schema.CURRENT_SCHEMA_VERSION
    assert on_disk["wiki_context"]["memory_layer"] == "L3"
    assert on_disk["schema_migrations"]
    # 备份必须保留原始（旧语义）内容 —— 历史 plan 不删除
    assert json.loads(loaded.backup.read_text(encoding="utf-8")) == legacy_plan()


def test_read_mode_never_writes(schema, tmp_path) -> None:
    plan_path = write_project(tmp_path, legacy_plan())
    before = plan_path.read_bytes()
    loaded = schema.load_plan(plan_path, mode="read")
    assert loaded.data["schema_version"] == schema.CURRENT_SCHEMA_VERSION
    assert loaded.migrated is False
    assert plan_path.read_bytes() == before


# ── 4. checkpoint：resume 不重复副作用 ───────────────────────────────────────

def _checkpoint_project(tmp_path: Path) -> tuple[Path, Path]:
    plan = {
        "schema_version": 3,
        "task": "durable",
        "status": "running",
        "thread": {"id": "t1"},
        "steps": [
            {
                "id": 1,
                "name": "write",
                "status": "running",
                "progress": 40,
                "checkpoints": [],
                "checkpoint_seq": 0,
            }
        ],
    }
    plan_path = write_project(tmp_path, plan)
    artifact = tmp_path / "out.txt"
    artifact.write_text("v1\n", encoding="utf-8")
    return plan_path, artifact


def test_resume_skips_intact_checkpoint(tmp_path, checkpoint) -> None:
    plan_path, artifact = _checkpoint_project(tmp_path)
    result = run_update(
        plan_path, "--step-id", "1", "--checkpoint-file", "out.txt", "--checkpoint-note", "写入产物"
    )
    assert result.returncode == 0, result.stderr
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    entry = plan["steps"][0]["checkpoints"][0]
    assert entry["kind"] == "file_write"
    assert entry["sha256"] == checkpoint.sha256_file(artifact)
    assert artifact.read_text(encoding="utf-8") == "v1\n"

    # 模拟 wrapper 中断 → resume
    assert run_update(plan_path, "--step-id", "1", "--interrupt", "--error", "exit 143").returncode == 0
    result = run_update(plan_path, "--step-id", "1", "--resume", "--note", "检查后恢复")
    assert result.returncode == 0, result.stderr
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    step = plan["steps"][0]
    # 本地步骤 resume 后必须是 pending，不能是 running：
    # subagent 是本地 pi 子进程，进程一死就没有东西在跑。若仍标 running，
    # scheduler 会看到「有步骤在跑」而空等，永远不重新派发 ——
    # 实测踩过：resume 后 full_cycle 报「等待运行中步骤完成(1 运行中)」，
    # ps 里却没有 pi 子进程，plan 卡死在 65% 不动。
    assert step["status"] == "pending", "本地步骤 resume 应回到 pending 以便重新派发"
    assert step["progress"] == 0
    state = step["resume_state"]
    assert [item["target"] for item in state["skip"]] == ["out.txt"]
    assert state["redo"] == []
    assert "跳过" in result.stdout
    # 副作用清单没有在 resume 时被重复施加（文件内容未变）
    assert artifact.read_text(encoding="utf-8") == "v1\n"


def test_resume_detects_drift_and_requires_redo(tmp_path) -> None:
    plan_path, artifact = _checkpoint_project(tmp_path)
    assert run_update(plan_path, "--step-id", "1", "--checkpoint-file", "out.txt").returncode == 0
    artifact.write_text("v2 drifted\n", encoding="utf-8")

    run_update(plan_path, "--step-id", "1", "--fail", "--error", "boom")
    result = run_update(plan_path, "--step-id", "1", "--resume")
    assert result.returncode == 0, result.stderr
    state = json.loads(plan_path.read_text(encoding="utf-8"))["steps"][0]["resume_state"]
    assert state["skip"] == []
    assert [item["target"] for item in state["redo"]] == ["out.txt"]
    assert "必须重做" in result.stdout


def test_resume_restart_is_explicit_and_warns(tmp_path) -> None:
    plan_path, _ = _checkpoint_project(tmp_path)
    run_update(plan_path, "--step-id", "1", "--checkpoint-file", "out.txt")
    run_update(plan_path, "--step-id", "1", "--fail", "--error", "boom")
    assert run_update(plan_path, "--step-id", "1", "--resume", "--restart").returncode == 0
    state = json.loads(plan_path.read_text(encoding="utf-8"))["steps"][0]["resume_state"]
    assert state["mode"] == "restart"
    assert "重复" in state["guidance"]


def test_restart_requires_resume(tmp_path) -> None:
    plan_path, _ = _checkpoint_project(tmp_path)
    result = run_update(plan_path, "--step-id", "1", "--restart")
    assert result.returncode != 0
    assert "--restart 只能与 --resume" in (result.stderr + result.stdout)


def test_auto_retry_pending_records_idempotency(tmp_path) -> None:
    """MAX_RETRIES 的 failed → pending 重试必须带幂等台账。"""
    plan_path, artifact = _checkpoint_project(tmp_path)
    run_update(plan_path, "--step-id", "1", "--checkpoint-file", "out.txt")
    run_update(plan_path, "--step-id", "1", "--fail", "--error", "boom")

    # execute.ts 自动重试走的就是 --status pending
    result = run_update(
        plan_path, "--step-id", "1", "--status", "pending", "--note", "Auto-retry #1"
    )
    assert result.returncode == 0, result.stderr
    step = json.loads(plan_path.read_text(encoding="utf-8"))["steps"][0]
    assert step["status"] == "pending"
    assert step["idempotency"]["intact"] == 1
    assert step["idempotency"]["redo"] == 0
    assert step["resume_state"]["skip"][0]["target"] == "out.txt"
    assert artifact.read_text(encoding="utf-8") == "v1\n"


def test_checkpoint_command_is_unverifiable(tmp_path) -> None:
    plan_path, _ = _checkpoint_project(tmp_path)
    assert (
        run_update(plan_path, "--step-id", "1", "--checkpoint-command", "python3 -m pytest -q").returncode
        == 0
    )
    result = run_update(plan_path, "--step-id", "1", "--list-checkpoints")
    assert result.returncode == 0
    assert "unverifiable" in result.stdout


def test_missing_file_checkpoint_is_redo(tmp_path) -> None:
    plan_path, artifact = _checkpoint_project(tmp_path)
    run_update(plan_path, "--step-id", "1", "--checkpoint-file", "out.txt")
    artifact.unlink()
    run_update(plan_path, "--step-id", "1", "--fail")
    run_update(plan_path, "--step-id", "1", "--resume")
    state = json.loads(plan_path.read_text(encoding="utf-8"))["steps"][0]["resume_state"]
    assert [item["target"] for item in state["redo"]] == ["out.txt"]


# ── 5. 演练可复现（历史 plan 存在时） ────────────────────────────────────────

def test_drill_roundtrip_on_real_history(schema) -> None:
    plans = schema.collect_drill_plans(ROOT, limit=5)
    if not plans:
        pytest.skip("没有历史 plan 可演练")
    report = schema.run_drill(ROOT, limit=5)
    assert report["plans"] >= 1
    for item in report["results"]:
        assert item["roundtrip_ok"], f"迁移不可逆: {item['plan']}\n{item['evidence']}"


def test_resume_remote_step_stays_running(tmp_path, checkpoint) -> None:
    """远程步骤 resume 后必须保持 running，不能重新派发。

    语义区分的原因：远程步骤的管线可能在远端继续运行，只是本地 wrapper 被信号杀。
    此时若改回 pending，scheduler 会再启动一遍远程任务，产生重复副作用。
    本测试与 test_resume_skips_intact_checkpoint（本地 → pending）互为对照。
    """
    plan = {
        "task": "remote resume",
        "status": "running",
        "thread": {"id": "t"},
        "steps": [
            {
                "id": 1,
                "name": "远程步骤",
                "status": "interrupted",
                "progress": 40,
                "depends_on": [],
                "execution_target": "remote",
                "remote_server": "eda-server",
                "checkpoints": [],
            }
        ],
    }
    plan_path = write_project(tmp_path, plan)
    result = run_update(plan_path, "--step-id", "1", "--resume", "--note", "远程管线仍在跑")
    assert result.returncode == 0, result.stderr

    after = json.loads(plan_path.read_text(encoding="utf-8"))
    step = after["steps"][0]
    assert step["status"] == "running", "远程步骤应保持 running（继续等待远端管线）"
    assert step["progress"] == 40, "远程步骤不应把进度清零"
    assert step["error"] is None

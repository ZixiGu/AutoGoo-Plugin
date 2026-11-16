#!/usr/bin/env python3
"""`.goo/plan.json` schema 版本化、迁移与回滚。

为什么需要这个文件
------------------
plan.json 长期是无版本号的裸 JSON。0.27.0 把 memory_layer 的编号方向**反转**
（旧：L0=原始日志 / L3=项目总览；新：L0=项目总览 / L3=原始日志），于是 0.27.0
之前写下的 plan 里的 `L0` 会被当成完全相反的意思读，而文件里没有任何字段能
让读取方察觉。这就是「静默失效」，和本项目反复记录的其它静默失效同类。

版本演进
--------
- v1  legacy-unsigned     无 schema_version；memory_layer = **旧**编号（L0=原始）
- v2  memory-layer-modern  0.27.0+ 但**仍未写 schema_version**；编号 = 新方向
- v3  durable-checkpoints  顶层 schema_version + step 级 checkpoints/resume_state

v1 与 v2 在文件上无法区分（都没有 schema_version），只能按文案特征 / 时间戳
推断。推断结果必须写进迁移记录（`schema_migrations`）让人复核，**不许静默**。

迁移链 v1→v2→v3 中每一步都可逆：`revert` 施加与 `migrate` 完全相反的编辑，
所以 `migrate` 后 `revert --to <原版本>` 能复现原始内容（`drill` 子命令用真实
历史 plan 验证这一点，见 references/plan-schema.md）。

不引入外部依赖：只用标准库 + 同目录的 `_paths.py`。
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from _paths import (
    dump_json,
    find_config_dir,
    format_iso,
    load_json,
    now,
    parse_iso,
    project_root_from_plan,
    resolve_plan_path,
    stamp,
    workspace_paths,
)

# ── 常量：版本表 / 语义翻转 ──────────────────────────────────────────────────

CURRENT_SCHEMA_VERSION = 3

SCHEMA_VERSIONS: dict[int, dict[str, str]] = {
    1: {
        "name": "legacy-unsigned",
        "memory_layer": "legacy",
        "summary": "无 schema_version；memory_layer 为旧编号（L0=原始日志，L3=项目总览）",
    },
    2: {
        "name": "memory-layer-modern",
        "memory_layer": "modern",
        "summary": "0.27.0+ 仍未写 schema_version；memory_layer 为新编号（L0=项目总览，L3=原始日志）",
    },
    3: {
        "name": "durable-checkpoints",
        "memory_layer": "modern",
        "summary": "顶层 schema_version + step 级 checkpoints/resume_state（durable execution）",
    },
}

# 0.27.0 = commit c7524eb "refactor(memory)!: L0-L3 编号方向反转"
# 该 commit 的提交时间（2026-11-11 10:51:08 +0800 → UTC）作为翻转时点。
MEMORY_FLIP_RELEASE = "0.27.0"
MEMORY_FLIP_CUTOFF = "2026-11-11T02:51:08Z"

# 翻转是自逆的：再翻转一次即回到原值。这是 revert 能复现原始内容的基础。
LAYER_FLIP: dict[str, str] = {"L0": "L3", "L3": "L0", "L1": "L2", "L2": "L1"}

# 只翻转**层号语义明确**的字段。刻意不碰自由文本 —— 描述里的层号可能与
# 上下文绑定（"L2/L3 引导" 之类），机械替换会改坏语义，改为记录待复核。
LAYER_FIELDS: frozenset[str] = frozenset(
    {"memory_layer", "memory_layers", "wiki_layers", "memory_layer_default"}
)

# 旧语义文案特征（0.27.0 之前）
LEGACY_SIGNATURES: tuple[str, ...] = (
    "L0(原始",
    "L0（原始",
    "L0=原始",
    "L0 原始",
    "L3(项目",
    "L3（项目",
    "L3=项目",
    "L3 项目总览",
    "L3 项目",
)
# 新语义文案特征（0.27.0 之后）
MODERN_SIGNATURES: tuple[str, ...] = (
    "L0(项目",
    "L0（项目",
    "L0=项目",
    "L0 项目总览",
    "L0 项目入口",
    "L3(原始",
    "L3（原始",
    "L3=原始",
    "L3 原始",
)

AUTOMIGRATE_ENV = "AUTOGOO_PLAN_AUTOMIGRATE"


# ── 异常 ─────────────────────────────────────────────────────────────────────

class PlanSchemaError(Exception):
    """schema 层面的通用错误。"""


class PlanTooNew(PlanSchemaError):
    """plan 的 schema_version 高于本插件支持的上限。"""


class PlanNeedsMigration(PlanSchemaError):
    """plan 需要迁移但调用方要求严格模式（未授权自动迁移）。"""


class PlanRevertBlocked(PlanSchemaError):
    """降级会丢 durable 数据但未显式授权。"""


# ── 判定 ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Detection:
    """一次版本判定 + 记忆层语义判定的结果。"""

    version: int
    explicit: bool
    semantics: str
    confidence: str
    reasons: tuple[str, ...] = ()

    @property
    def legacy(self) -> bool:
        return self.semantics == "legacy"

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "explicit": self.explicit,
            "schema": SCHEMA_VERSIONS.get(self.version, {}).get("name", "unknown"),
            "memory_layer_semantics": self.semantics,
            "confidence": self.confidence,
            "reasons": list(self.reasons),
        }


def _iter_strings(node: Any, path: str = "") -> Iterator[tuple[str, str]]:
    """Yield (path, string) for every string value, walking dicts/lists."""
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}" if path else str(key)
            yield from _iter_strings(value, child)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            yield from _iter_strings(item, f"{path}[{index}]")


def count_signatures(data: dict[str, Any]) -> tuple[int, int]:
    """Return (legacy_hits, modern_hits) over every string in the plan."""
    legacy = modern = 0
    for _, text in _iter_strings(data):
        for sig in LEGACY_SIGNATURES:
            if sig in text:
                legacy += 1
                break
        for sig in MODERN_SIGNATURES:
            if sig in text:
                modern += 1
                break
    return legacy, modern


def _first_timestamp(data: dict[str, Any]) -> str | None:
    thread = data.get("thread") if isinstance(data.get("thread"), dict) else {}
    for candidate in (
        data.get("created_at"),
        thread.get("created_at"),
        data.get("started_at"),
        data.get("updated_at"),
    ):
        if parse_iso(candidate):
            return str(candidate)
    return None


def infer_semantics(
    data: dict[str, Any],
    *,
    plan_path: Path | None = None,
    assume_semantics: str | None = None,
) -> tuple[str, str, list[str]]:
    """判定无 schema_version 的 plan 用的是哪套 memory_layer 编号。

    Returns (semantics, confidence, reasons)。semantics ∈ {"legacy", "modern"}。
    """
    declared = data.get("memory_layer_semantics")
    if declared in ("legacy", "modern"):
        return str(declared), "declared", [f"plan 显式声明 memory_layer_semantics={declared}"]

    if assume_semantics in ("legacy", "modern"):
        return assume_semantics, "assumed", [f"调用方指定 assume_semantics={assume_semantics}"]

    legacy_hits, modern_hits = count_signatures(data)
    if legacy_hits != modern_hits:
        winner = "legacy" if legacy_hits > modern_hits else "modern"
        return winner, "content", [
            f"文案特征命中: 旧语义 {legacy_hits} 处 / 新语义 {modern_hits} 处"
        ]

    created = _first_timestamp(data)
    if created:
        moment = parse_iso(created)
        cutoff = parse_iso(MEMORY_FLIP_CUTOFF)
        if moment and cutoff:
            winner = "legacy" if moment < cutoff else "modern"
            relation = "早于" if winner == "legacy" else "不早于"
            return winner, "timestamp", [
                f"created_at={format_iso(moment)} {relation} 0.27.0 翻转时点 {MEMORY_FLIP_CUTOFF}"
            ]

    if plan_path is not None and plan_path.exists():
        try:
            mtime = datetime.fromtimestamp(plan_path.stat().st_mtime, timezone.utc)
            cutoff = parse_iso(MEMORY_FLIP_CUTOFF)
            if cutoff:
                winner = "legacy" if mtime < cutoff else "modern"
                return winner, "mtime", [
                    f"文件 mtime={format_iso(mtime)} 与 0.27.0 翻转时点 {MEMORY_FLIP_CUTOFF} 比较"
                ]
        except OSError:
            pass

    return "legacy", "default", [
        "无 schema_version / 无层号文案 / 无时间戳：保守按旧语义处理，"
        "迁移后请人工复核（不静默假定为新语义）"
    ]


def _too_new_message(plan_path: Path | str, version: int) -> str:
    return (
        f"plan schema_version={version} 高于本插件支持的上限 {CURRENT_SCHEMA_VERSION}：{plan_path}\n"
        f"明确处理路径（不做静默降级解释）：\n"
        f"  1) 升级插件：`/plugin update autogoo-plugin` 或 git pull 到包含 v{version} 的版本\n"
        f"  2) 若确认是手改坏了：`python3 skills/auto-goo/scripts/plan_schema.py status --plan {plan_path}` 查看依据\n"
        f"  3) 不要手改 schema_version 降级 —— 高版本字段会被静默丢弃"
    )


def detect(
    data: dict[str, Any],
    *,
    plan_path: Path | None = None,
    assume_semantics: str | None = None,
) -> Detection:
    """判定 plan 的 schema 版本；无 schema_version 时按证据推断 v1/v2。"""
    raw = data.get("schema_version")
    if raw is not None:
        try:
            version = int(raw)
        except (TypeError, ValueError) as exc:
            raise PlanSchemaError(
                f"schema_version 非法: {raw!r}（必须是整数 1..{CURRENT_SCHEMA_VERSION}）"
            ) from exc
        if version < 1:
            raise PlanSchemaError(f"schema_version 非法: {version}")
        if version > CURRENT_SCHEMA_VERSION:
            raise PlanTooNew(_too_new_message(plan_path or "<plan>", version))
        semantics = SCHEMA_VERSIONS[version]["memory_layer"]
        return Detection(
            version=version,
            explicit=True,
            semantics=semantics,
            confidence="explicit",
            reasons=(f"plan 顶层 schema_version={version}",),
        )

    semantics, confidence, reasons = infer_semantics(
        data, plan_path=plan_path, assume_semantics=assume_semantics
    )
    return Detection(
        version=1 if semantics == "legacy" else 2,
        explicit=False,
        semantics=semantics,
        confidence=confidence,
        reasons=tuple(reasons),
    )


# ── 迁移 / 回滚（纯内存，不碰文件） ──────────────────────────────────────────

def _flip_layer_fields(node: Any, path: str, flips: list[dict[str, Any]]) -> None:
    """In-place flip of structured memory_layer values, recording every edit."""
    if isinstance(node, dict):
        for key in list(node.keys()):
            value = node[key]
            child = f"{path}.{key}" if path else str(key)
            if key in LAYER_FIELDS:
                if isinstance(value, str):
                    flipped = LAYER_FLIP.get(value.strip().upper())
                    if flipped and flipped != value:
                        node[key] = flipped
                        flips.append({"path": child, "old": value, "new": flipped})
                elif isinstance(value, list):
                    for index, item in enumerate(value):
                        if isinstance(item, str):
                            flipped = LAYER_FLIP.get(item.strip().upper())
                            if flipped and flipped != item:
                                value[index] = flipped
                                flips.append(
                                    {"path": f"{child}[{index}]", "old": item, "new": flipped}
                                )
            _flip_layer_fields(value, child, flips)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            _flip_layer_fields(item, f"{path}[{index}]", flips)


def _legacy_text_mentions(data: dict[str, Any], limit: int = 20) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    for path, text in _iter_strings(data):
        for sig in LEGACY_SIGNATURES:
            if sig in text:
                hits.append({"path": path, "phrase": sig})
                break
        if len(hits) >= limit:
            break
    return hits


def _v1_to_v2(data: dict[str, Any], det: Detection) -> dict[str, Any]:
    """旧编号 → 新编号：翻转结构化层号，记录待人工复核的自由文本。"""
    flips: list[dict[str, Any]] = []
    _flip_layer_fields(data, "", flips)
    mentions = _legacy_text_mentions(data)
    data["memory_layer_semantics"] = "modern"
    return {
        "from": 1,
        "to": 2,
        "at": now(),
        "by": "plan_schema.py",
        "change": "memory_layer 编号方向反转（L0↔L3, L1↔L2）",
        "reason": f"{MEMORY_FLIP_RELEASE} 把记忆层编号方向反转；本 plan 无 schema_version，按旧语义判定",
        "assumed_semantics": det.semantics,
        "confidence": det.confidence,
        "evidence": list(det.reasons),
        "flipped_fields": flips[:50],
        "flipped_count": len(flips),
        "text_mentions_needing_review": mentions,
        "review_recommended": det.confidence in {"content", "timestamp", "mtime", "default"},
        "reversible": True,
    }


def _v2_to_v3(data: dict[str, Any]) -> dict[str, Any]:
    """加 durable execution 骨架：step 级 checkpoints / resume_state 空位。"""
    added: list[Any] = []
    for step in data.get("steps", []):
        if not isinstance(step, dict):
            continue
        if "checkpoints" not in step:
            step["checkpoints"] = []
            added.append(step.get("id"))
        step.setdefault("checkpoint_seq", 0)
    return {
        "from": 2,
        "to": 3,
        "at": now(),
        "by": "plan_schema.py",
        "change": "补齐 step 级 checkpoints/checkpoint_seq（durable execution 的副作用台账）",
        "added_steps": added,
        "reversible": True,
        "revert_drops": [
            "schema_version",
            "step.checkpoints",
            "step.checkpoint_seq",
            "step.resume_state",
            "step.idempotency",
        ],
    }


def _v3_to_v2(data: dict[str, Any]) -> dict[str, Any]:
    dropped: list[Any] = []
    for step in data.get("steps", []):
        if not isinstance(step, dict):
            continue
        for key in ("checkpoints", "checkpoint_seq", "resume_state", "idempotency"):
            if key in step:
                step.pop(key, None)
                dropped.append(f"step#{step.get('id')}.{key}")
    return {
        "from": 3,
        "to": 2,
        "at": now(),
        "by": "plan_schema.py",
        "change": "移除 durable execution 字段（checkpoints/checkpoint_seq/resume_state/idempotency）",
        "dropped": dropped,
        "reversible": True,
    }


def _v2_to_v1(data: dict[str, Any]) -> dict[str, Any]:
    flips: list[dict[str, Any]] = []
    _flip_layer_fields(data, "", flips)
    data.pop("memory_layer_semantics", None)
    return {
        "from": 2,
        "to": 1,
        "at": now(),
        "by": "plan_schema.py",
        "change": "memory_layer 编号翻回旧方向（L0↔L3, L1↔L2），移除 schema_version",
        "flipped_count": len(flips),
        "flipped_fields": flips[:50],
        "reversible": True,
    }


def durable_artifacts(data: dict[str, Any]) -> list[str]:
    """列出降级会丢失的 durable 数据（非空 checkpoints / resume_state 等）。"""
    found: list[str] = []
    for step in data.get("steps", []):
        if not isinstance(step, dict):
            continue
        if step.get("checkpoints"):
            found.append(f"step#{step.get('id')}.checkpoints({len(step['checkpoints'])})")
        if step.get("resume_state"):
            found.append(f"step#{step.get('id')}.resume_state")
        if step.get("idempotency"):
            found.append(f"step#{step.get('id')}.idempotency")
    return found


def migrate(
    data: dict[str, Any],
    *,
    plan_path: Path | None = None,
    target: int | None = None,
    assume_semantics: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """把 plan 迁移到 *target*（默认当前版本），返回 (新 plan, 迁移记录)。"""
    wanted = CURRENT_SCHEMA_VERSION if target is None else int(target)
    if wanted < 1 or wanted > CURRENT_SCHEMA_VERSION:
        raise PlanSchemaError(f"target 必须在 1..{CURRENT_SCHEMA_VERSION}，收到 {wanted}")

    det = detect(data, plan_path=plan_path, assume_semantics=assume_semantics)
    if det.version >= wanted:
        return copy.deepcopy(data), []

    working = copy.deepcopy(data)
    records: list[dict[str, Any]] = []
    version = det.version
    while version < wanted:
        if version == 1:
            record = _v1_to_v2(working, det)
            version = 2
        elif version == 2:
            record = _v2_to_v3(working)
            version = 3
        else:  # pragma: no cover - 迁移链断档属于编程错误
            raise PlanSchemaError(f"缺少 v{version} 的迁移实现")
        record["schema_version"] = version
        # origin = 迁移前的真实形态。回滚到该版本时，只有原本显式带过 schema_version
        # 的 plan 才该保留该字段；否则要复现「无版本字段」的原状（可逆性靠它）。
        record["origin"] = {"version": det.version, "explicit": det.explicit}
        working["schema_version"] = version
        records.append(record)

    history = working.get("schema_migrations")
    working["schema_migrations"] = (history if isinstance(history, list) else []) + records
    return working, records


def revert(
    data: dict[str, Any],
    *,
    plan_path: Path | None = None,
    target: int = 1,
    drop_durable: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """把 plan 回滚到 *target*（migrate 的逆操作），返回 (新 plan, 记录)。"""
    det = detect(data, plan_path=plan_path)
    if target > CURRENT_SCHEMA_VERSION:
        raise PlanSchemaError(f"target 不能高于 {CURRENT_SCHEMA_VERSION}")
    if target < 1:
        raise PlanSchemaError("target 不能小于 1")
    if det.version <= target:
        return copy.deepcopy(data), []

    blocked = durable_artifacts(data) if target < 3 else []
    if blocked and not drop_durable:
        raise PlanRevertBlocked(
            "回滚会丢失 durable 数据，先归档或显式授权：\n  "
            + "\n  ".join(blocked)
            + "\n"
            + f"\n明确路径：\n  1) 先 `plan_schema.py migrate --plan <plan> --dry-run` 确认现状\n"
            f"  2) 需要保留证据：把 plan 复制到 .goo/plans/history/ 后再回滚\n"
            f"  3) 确认可丢：`plan_schema.py revert --plan <plan> --to {target} --drop-durable-data`"
        )

    working = copy.deepcopy(data)
    records: list[dict[str, Any]] = []
    history_in = working.get("schema_migrations")
    origin: dict[str, Any] | None = None
    if isinstance(history_in, list) and history_in and isinstance(history_in[0], dict):
        raw_origin = history_in[0].get("origin")
        if isinstance(raw_origin, dict):
            origin = raw_origin
    version = det.version
    while version > target:
        if version == 3:
            record = _v3_to_v2(working)
            version = 2
        elif version == 2:
            record = _v2_to_v1(working)
            version = 1
        else:  # pragma: no cover
            raise PlanSchemaError(f"缺少 v{version} 的回滚实现")
        records.append(record)
        if version == 1:
            working.pop("schema_version", None)
        else:
            working["schema_version"] = version

    history = working.get("schema_migrations")
    if isinstance(history, list):
        keep = history[: max(0, len(history) - len(records))]
        if keep:
            working["schema_migrations"] = keep
        else:
            working.pop("schema_migrations", None)
    # 回到「原本就无 schema_version」的形态：删字段才能复现原始内容（可逆性断言靠它）
    if origin and not origin.get("explicit") and target <= int(origin.get("version", 0)):
        working.pop("schema_version", None)
        working.pop("schema_migrations", None)
    return working, records


# ── 文件层：备份 / 加载 ──────────────────────────────────────────────────────

@dataclass
class LoadedPlan:
    """schema 感知的 plan 加载结果。"""

    data: dict[str, Any]
    detection: Detection
    migrations: list[dict[str, Any]] = field(default_factory=list)
    migrated: bool = False
    backup: Path | None = None


def history_dir(plan_path: Path) -> Path:
    """解析 `.goo/plans/history`（尊重 config.json 的 workspace.paths 覆盖）。"""
    root = project_root_from_plan(plan_path)
    try:
        paths = workspace_paths(find_config_dir(plan_path))
    except OSError:
        paths = workspace_paths(None)
    raw = Path(paths["plans_history_dir"]).expanduser()
    return raw if raw.is_absolute() else root / raw


def backup_plan(plan_path: Path, *, label: str) -> Path:
    """把 plan 原样复制进 plans/history/（历史 plan 不删除，只增不改）。"""
    target_dir = history_dir(plan_path)
    target_dir.mkdir(parents=True, exist_ok=True)
    base = f"{plan_path.stem}-{stamp()}-{label}.json"
    candidate = target_dir / base
    counter = 1
    while candidate.exists():
        candidate = target_dir / f"{base[:-5]}-{counter}.json"
        counter += 1
    shutil.copy2(plan_path, candidate)
    return candidate


def _migration_path_hint(plan_path: Path, det: Detection) -> str:
    target = CURRENT_SCHEMA_VERSION
    chain = " → ".join(f"v{v}" for v in range(det.version, target + 1))
    return (
        f"plan: {plan_path}\n"
        f"当前判定: schema_version={det.version} (未写版本字段)"
        f"{'' if det.explicit else '，memory_layer 语义=' + det.semantics}"
        f"，依据={det.confidence}\n"
        f"迁移链: {chain}\n"
        f"明确迁移路径（不会静默按新语义解释）：\n"
        f"  1) 看现状: python3 skills/auto-goo/scripts/plan_schema.py status --plan {plan_path}\n"
        f"  2) 演练:   python3 skills/auto-goo/scripts/plan_schema.py drill --root .\n"
        f"  3) 预览:   python3 skills/auto-goo/scripts/plan_schema.py migrate --plan {plan_path} --dry-run\n"
        f"  4) 迁移:   python3 skills/auto-goo/scripts/plan_schema.py migrate --plan {plan_path}\n"
        f"     （会先把原文件备份到 plans/history/，迁移记录写进 schema_migrations）\n"
        f"  5) 回滚:   python3 skills/auto-goo/scripts/plan_schema.py revert --plan {plan_path} --to {det.version}\n"
        f"或设 {AUTOMIGRATE_ENV}=1 让 update-step.py 自动备份后迁移。"
    )


def load_plan(
    plan_path: Path,
    *,
    mode: str = "write",
    assume_semantics: str | None = None,
) -> LoadedPlan:
    """加载 plan 并处理版本。

    mode="write"：版本落后时**显式**迁移（先备份 + 打印提示 + 写 schema_migrations）；
                  设 AUTOMIGRATE_ENV=0 则改为抛 PlanNeedsMigration，强制人工确认。
    mode="read" ：只做内存内迁移，绝不写盘（渲染/统计路径用）。

    版本高于上限一律拒绝（PlanTooNew），不做猜测式降级。
    """
    if mode not in {"read", "write"}:
        raise PlanSchemaError(f"mode 必须是 read/write，收到 {mode!r}")

    plan_path = Path(plan_path)
    data = load_json(plan_path)
    det = detect(data, plan_path=plan_path, assume_semantics=assume_semantics)

    if det.version == CURRENT_SCHEMA_VERSION:
        return LoadedPlan(data=data, detection=det)

    migrated, records = migrate(data, plan_path=plan_path, assume_semantics=assume_semantics)
    if mode == "read":
        return LoadedPlan(data=migrated, detection=det, migrations=records)

    if os.environ.get(AUTOMIGRATE_ENV, "1") not in {"1", "true", "yes", "on"}:
        raise PlanNeedsMigration(_migration_path_hint(plan_path, det))

    backup = backup_plan(plan_path, label=f"pre-schema-v{det.version}")
    dump_json(plan_path, migrated)
    _notice(
        f"schema 迁移完成: {plan_path} v{det.version} → v{CURRENT_SCHEMA_VERSION}"
        f"（memory_layer 语义 {det.semantics}，依据 {det.confidence}）；"
        f"原文件已备份到 {backup}"
    )
    return LoadedPlan(data=migrated, detection=det, migrations=records, migrated=True, backup=backup)


def _notice(message: str) -> None:
    sys.stderr.write(f"[plan-schema] {message}\n")


# ── 演练（drill）─────────────────────────────────────────────────────────────

def collect_drill_plans(root: Path, *, limit: int = 12) -> list[Path]:
    """收集可演练的历史 plan：plans/history/*.json + threads/*/plan.json。"""
    candidates: list[Path] = []
    history = root / ".goo" / "plans" / "history"
    if history.is_dir():
        candidates.extend(sorted(history.glob("*.json")))
    threads = root / ".goo" / "threads"
    if threads.is_dir():
        candidates.extend(sorted(threads.glob("*/plan.json")))
    return candidates[:limit]


def drill_plan(plan_path: Path, *, assume_semantics: str | None = None) -> dict[str, Any]:
    """在内存里对单个历史 plan 走一遍 migrate → revert，验证可逆性。

    绝不写回原文件：演练对象是真实历史 plan，只能读。
    """
    original = json.loads(plan_path.read_text(encoding="utf-8"))
    det = detect(original, plan_path=plan_path, assume_semantics=assume_semantics)
    migrated, records = migrate(original, plan_path=plan_path, assume_semantics=assume_semantics)
    reverted, _ = revert(migrated, plan_path=plan_path, target=det.version, drop_durable=True)
    flips = sum(int(record.get("flipped_count", 0)) for record in records)
    mentions = sum(len(record.get("text_mentions_needing_review", [])) for record in records)
    return {
        "plan": str(plan_path),
        "detected_version": det.version,
        "explicit": det.explicit,
        "memory_layer_semantics": det.semantics,
        "confidence": det.confidence,
        "evidence": list(det.reasons),
        "migrated_to": migrated.get("schema_version"),
        "steps": len(original.get("steps", []) or []),
        "flipped_fields": flips,
        "text_mentions_needing_review": mentions,
        "roundtrip_ok": reverted == original,
        "steps_with_checkpoints": sum(
            1
            for step in migrated.get("steps", [])
            if isinstance(step, dict) and "checkpoints" in step
        ),
        "records": [{"from": r.get("from"), "to": r.get("to")} for r in records],
    }


def run_drill(root: Path, *, limit: int = 12, assume_semantics: str | None = None) -> dict[str, Any]:
    plans = collect_drill_plans(root, limit=limit)
    results = [drill_plan(path, assume_semantics=assume_semantics) for path in plans]
    return {
        "generated_at": now(),
        "root": str(root),
        "plans": len(results),
        "all_roundtrip_ok": all(item["roundtrip_ok"] for item in results) and bool(results),
        "legacy_detected": sum(1 for item in results if item["memory_layer_semantics"] == "legacy"),
        "results": results,
    }


def write_drill_report(report: dict[str, Any], out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    tag = stamp()
    json_path = out_dir / f"drill-{tag}.json"
    md_path = out_dir / f"drill-{tag}.md"
    dump_json(json_path, report)

    lines = [
        "# plan schema 迁移演练报告",
        "",
        f"- 生成时间：{report['generated_at']}",
        f"- 演练根目录：{report['root']}",
        f"- 覆盖历史 plan：{report['plans']} 份（要求 ≥ 3）",
        f"- 全部往返一致（migrate → revert 复现原文）：{'✅ 是' if report['all_roundtrip_ok'] else '❌ 否'}",
        f"- 判定为旧语义（0.27.0 之前）：{report['legacy_detected']} 份",
        "",
        "| plan | 判定 | 层号语义 | 依据 | 翻转字段 | 待复核文案 | durable 骨架 | 往返一致 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for item in report["results"]:
        name = Path(item["plan"]).name
        parent = Path(item["plan"]).parent.name
        label = f"{parent}/{name}" if name == "plan.json" else name
        lines.append(
            f"| `{label}` | v{item['detected_version']}"
            f"{'' if item['explicit'] else '(无版本字段)'} | {item['memory_layer_semantics']} "
            f"| {item['confidence']} | {item['flipped_fields']} | {item['text_mentions_needing_review']} "
            f"| {item['steps_with_checkpoints']}/{item['steps']} | {'✅' if item['roundtrip_ok'] else '❌'} |"
        )
    lines.extend(
        [
            "",
            "## 判定依据（逐份）",
            "",
        ]
    )
    for item in report["results"]:
        lines.append(f"### `{item['plan']}`")
        lines.append("")
        for reason in item["evidence"]:
            lines.append(f"- {reason}")
        chain = ""
        if item["records"]:
            hops = [f"v{item['records'][0]['from']}"] + [f"v{r['to']}" for r in item["records"]]
            chain = " → ".join(hops)
        if not chain:
            chain = "已是当前版本"
        lines.append(f"- 迁移链：{chain}")
        lines.append("")
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, md_path


# ── CLI ──────────────────────────────────────────────────────────────────────

def _print_status(plan_path: Path, det: Detection, data: dict[str, Any]) -> None:
    schema = SCHEMA_VERSIONS.get(det.version, {})
    print(f"plan: {plan_path}")
    print(f"schema_version: {det.version}{'' if det.explicit else ' (未写版本字段)'}")
    print(f"schema name: {schema.get('name', 'unknown')}")
    print(f"memory_layer 语义: {det.semantics} ({schema.get('memory_layer', '?')})")
    print(f"判定依据: {det.confidence}")
    for reason in det.reasons:
        print(f"  - {reason}")
    if det.version < CURRENT_SCHEMA_VERSION:
        print(
            "迁移链: "
            + " → ".join(f"v{v}" for v in range(det.version, CURRENT_SCHEMA_VERSION + 1))
        )
        print("迁移命令: python3 skills/auto-goo/scripts/plan_schema.py migrate --plan " f"{plan_path}")
    durable = durable_artifacts(data)
    if durable:
        print(f"durable 数据: {len(durable)} 处（{', '.join(durable[:5])}）")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="plan.json schema 版本化 / 迁移 / 回滚 / 演练")
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", help="打印版本判定与迁移路径")
    status.add_argument("--plan", default=".goo/plan.json")
    status.add_argument("--assume-semantics", choices=["legacy", "modern"])

    migrate_cmd = sub.add_parser("migrate", help="迁移到当前 schema 版本（默认先备份）")
    migrate_cmd.add_argument("--plan", default=".goo/plan.json")
    migrate_cmd.add_argument("--to", type=int, default=CURRENT_SCHEMA_VERSION)
    migrate_cmd.add_argument("--dry-run", action="store_true")
    migrate_cmd.add_argument("--no-backup", action="store_true")
    migrate_cmd.add_argument("--assume-semantics", choices=["legacy", "modern"])

    revert_cmd = sub.add_parser("revert", help="回滚到旧 schema 版本（migrate 的逆操作）")
    revert_cmd.add_argument("--plan", default=".goo/plan.json")
    revert_cmd.add_argument("--to", type=int, default=1)
    revert_cmd.add_argument("--dry-run", action="store_true")
    revert_cmd.add_argument("--drop-durable-data", action="store_true")
    revert_cmd.add_argument("--no-backup", action="store_true")

    drill_cmd = sub.add_parser("drill", help="对历史 plan 演练 migrate→revert 可逆性")
    drill_cmd.add_argument("--root", default=".")
    drill_cmd.add_argument("--plan", action="append", default=[])
    drill_cmd.add_argument("--limit", type=int, default=12)
    drill_cmd.add_argument("--out", default=".goo/plans/migrations")
    drill_cmd.add_argument("--assume-semantics", choices=["legacy", "modern"])

    args = parser.parse_args(argv)

    try:
        if args.command == "status":
            plan_path = resolve_plan_path(args.plan)
            data = load_json(plan_path)
            det = detect(data, plan_path=plan_path, assume_semantics=args.assume_semantics)
            _print_status(plan_path, det, data)
            return 0

        if args.command == "migrate":
            plan_path = resolve_plan_path(args.plan)
            data = load_json(plan_path)
            det = detect(data, plan_path=plan_path, assume_semantics=args.assume_semantics)
            migrated, records = migrate(
                data,
                plan_path=plan_path,
                target=args.to,
                assume_semantics=args.assume_semantics,
            )
            print(f"plan: {plan_path}")
            print(
                f"v{det.version} → v{args.to}: {len(records)} 步迁移"
                f"（判定语义 {det.semantics}/{det.confidence}）"
            )
            for record in records:
                print(
                    f"  - v{record['from']} → v{record['to']}: {record.get('change', '')}"
                    f"（翻转 {record.get('flipped_count', 0)} 处，待复核文案 "
                    f"{len(record.get('text_mentions_needing_review', []))} 处）"
                )
            if not records:
                print("已是目标版本，无改动")
                return 0
            if args.dry_run:
                print("dry-run：未写盘")
                return 0
            if not args.no_backup:
                print(f"备份: {backup_plan(plan_path, label=f'pre-schema-v{det.version}')}")
            dump_json(plan_path, migrated)
            print(f"已写入 schema_version={migrated.get('schema_version')}")
            return 0

        if args.command == "revert":
            plan_path = resolve_plan_path(args.plan)
            data = load_json(plan_path)
            reverted, records = revert(
                data,
                plan_path=plan_path,
                target=args.to,
                drop_durable=args.drop_durable_data,
            )
            print(f"plan: {plan_path}")
            print(f"→ v{args.to}: {len(records)} 步回滚")
            for record in records:
                print(f"  - v{record['from']} → v{record['to']}: {record.get('change', '')}")
            if not records:
                print("已是目标版本，无改动")
                return 0
            if args.dry_run:
                print("dry-run：未写盘")
                return 0
            if not args.no_backup:
                print(f"备份: {backup_plan(plan_path, label=f'pre-revert-v{args.to}')}")
            dump_json(plan_path, reverted)
            print(f"已回滚（schema_version={reverted.get('schema_version', '未写')}）")
            return 0

        if args.command == "drill":
            root = Path(args.root).resolve()
            if args.plan:
                plans = [Path(item) for item in args.plan]
                report = {
                    "generated_at": now(),
                    "root": str(root),
                    "plans": len(plans),
                    "results": [
                        drill_plan(path, assume_semantics=args.assume_semantics) for path in plans
                    ],
                }
                report["all_roundtrip_ok"] = all(
                    item["roundtrip_ok"] for item in report["results"]
                ) and bool(report["results"])
                report["legacy_detected"] = sum(
                    1
                    for item in report["results"]
                    if item["memory_layer_semantics"] == "legacy"
                )
            else:
                report = run_drill(
                    root, limit=args.limit, assume_semantics=args.assume_semantics
                )
            json_path, md_path = write_drill_report(report, Path(args.out))
            for item in report["results"]:
                mark = "✅" if item["roundtrip_ok"] else "❌"
                print(
                    f"{mark} {item['plan']} → 判定 v{item['detected_version']}"
                    f" ({item['memory_layer_semantics']}/{item['confidence']}),"
                    f" 翻转 {item['flipped_fields']} 处"
                )
            print(f"演练 plan 数: {report['plans']}（要求 ≥ 3）")
            print(f"报告: {json_path}")
            print(f"报告: {md_path}")
            return 0 if report["plans"] >= 3 and report["all_roundtrip_ok"] else 1

    except (PlanSchemaError, FileNotFoundError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 3

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

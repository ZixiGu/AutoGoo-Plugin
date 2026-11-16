#!/usr/bin/env python3
"""step 级副作用台账（checkpoint）：让 `--resume` 和自动重试幂等。

问题
----
`update-step.py --resume` 只把 status 改回 running，Subagent 会从头重跑一遍；
已经产生的**外部副作用**（改过的文件、发过的请求、跑过的迁移）会被重复施加。
`MAX_RETRIES=1` 的自动重试（failed → pending）同样没有幂等保护。

做法
----
Subagent 每完成一个有外部副作用的动作，就登记一条 checkpoint：

    update-step.py --step-id 1 --checkpoint-file skills/auto-goo/scripts/x.py
    update-step.py --step-id 1 --checkpoint-command "python3 -m pytest -q"

文件类 checkpoint 记录 sha256，resume 时重新计算并比对：
  - intact        文件仍在且 hash 一致 → 副作用已完成，**跳过**
  - drift         文件被改过 → 不能假定完成，必须重做（或先判断是谁改的）
  - missing       文件不存在 → 副作用没落地或被回滚，必须重做
  - unverifiable  命令类无法回读结果 → 不重复执行有副作用的命令，先确认

只记录、不改写业务数据；台账存在 plan.json 的 step.checkpoints 里，随 plan 一起
被 schema 迁移（v3）和 resume 读取。
"""

from __future__ import annotations

import hashlib
import shlex
from pathlib import Path
from typing import Any

from _paths import now

KIND_FILE = "file_write"
KIND_COMMAND = "command"

STATUS_INTACT = "intact"
STATUS_DRIFT = "drift"
STATUS_MISSING = "missing"
STATUS_UNVERIFIABLE = "unverifiable"


def sha256_file(path: Path) -> str | None:
    """Return sha256 hex of *path*, or None when unreadable/missing."""
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(65536), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def command_fingerprint(command: str, *, cwd: str | None = None) -> str:
    """命令指纹：规范化后的命令 + 工作目录的 sha256。

    规范化只用 shlex 拆词再拼回去，目的是让多余空白/引号写法不产生不同指纹。
    指纹只证明「这条命令登记过」，不能证明它成功或只跑过一次 —— 所以命令类
    checkpoint 永远判 unverifiable，resume 时必须人工/模型判断。
    """
    try:
        normalized = " ".join(shlex.split(command))
    except ValueError:
        normalized = " ".join(command.split())
    basis = f"{cwd or ''}\x00{normalized}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def _resolve_target(root: Path | None, target: str) -> Path:
    path = Path(target).expanduser()
    if path.is_absolute():
        return path
    return (root or Path.cwd()) / path


def next_id(step: dict[str, Any]) -> str:
    """分配 checkpoint id（step.checkpoint_seq 单调递增，删除后不复用）。"""
    seq = int(step.get("checkpoint_seq") or 0) + 1
    step["checkpoint_seq"] = seq
    for entry in step.get("checkpoints", []) or []:
        if isinstance(entry, dict) and entry.get("id") == f"ck-{seq}":  # pragma: no cover
            return next_id(step)
    return f"ck-{seq}"


def record_file(step: dict[str, Any], target: str, *, root: Path | None = None,
                note: str | None = None) -> dict[str, Any]:
    """登记一次文件写入副作用，返回写入 plan 的 checkpoint 条目。"""
    path = _resolve_target(root, target)
    entry: dict[str, Any] = {
        "id": next_id(step),
        "kind": KIND_FILE,
        "target": target,
        "sha256": sha256_file(path),
        "at": now(),
    }
    if path.exists():
        try:
            entry["size"] = path.stat().st_size
        except OSError:
            pass
    if note:
        entry["note"] = note
    checkpoints = step.get("checkpoints")
    if not isinstance(checkpoints, list):
        checkpoints = []
    checkpoints.append(entry)
    step["checkpoints"] = checkpoints
    return entry


def record_command(step: dict[str, Any], command: str, *, root: Path | None = None,
                   note: str | None = None) -> dict[str, Any]:
    """登记一次命令执行副作用（不可回读验证，只留指纹）。"""
    entry: dict[str, Any] = {
        "id": next_id(step),
        "kind": KIND_COMMAND,
        "target": command,
        "fingerprint": command_fingerprint(command, cwd=str(root) if root else None),
        "at": now(),
    }
    if note:
        entry["note"] = note
    checkpoints = step.get("checkpoints")
    if not isinstance(checkpoints, list):
        checkpoints = []
    checkpoints.append(entry)
    step["checkpoints"] = checkpoints
    return entry


def verify(step: dict[str, Any], *, root: Path | None = None) -> list[dict[str, Any]]:
    """逐条比对 checkpoint 与磁盘现状，返回带 status 的副本列表。"""
    results: list[dict[str, Any]] = []
    for entry in step.get("checkpoints", []) or []:
        if not isinstance(entry, dict):
            continue
        item = dict(entry)
        kind = entry.get("kind")
        if kind == KIND_FILE:
            path = _resolve_target(root, str(entry.get("target", "")))
            actual = sha256_file(path)
            expected = entry.get("sha256")
            if not expected:
                item["status"] = STATUS_UNVERIFIABLE
                item["detail"] = "登记时文件不存在，无 hash 可比"
            elif actual is None:
                item["status"] = STATUS_MISSING
                item["detail"] = f"文件不存在: {path}"
            elif actual == expected:
                item["status"] = STATUS_INTACT
                item["detail"] = "sha256 一致"
            else:
                item["status"] = STATUS_DRIFT
                item["actual_sha256"] = actual
                item["detail"] = f"sha256 变化: {expected[:12]} → {actual[:12]}"
        else:
            item["status"] = STATUS_UNVERIFIABLE
            item["detail"] = "命令类副作用无法回读，需人工/模型判断是否重跑"
        results.append(item)
    return results


def resume_state(step: dict[str, Any], *, root: Path | None = None,
                 mode: str = "checkpoint") -> dict[str, Any]:
    """生成 resume 决策：哪些副作用已完成（跳过）、哪些必须重做。

    mode="checkpoint"（默认）：按 checkpoint 比对，已完成的副作用跳过。
    mode="restart"：显式要求从头重跑（调用方 --restart），仍保留清单供审计，
    但把 guidance 写成「副作用可能重复」。
    """
    verified = verify(step, root=root)
    buckets: dict[str, list[dict[str, Any]]] = {
        STATUS_INTACT: [],
        STATUS_DRIFT: [],
        STATUS_MISSING: [],
        STATUS_UNVERIFIABLE: [],
    }
    for item in verified:
        buckets.setdefault(str(item.get("status")), []).append(item)

    def brief(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {"id": item.get("id"), "kind": item.get("kind"), "target": item.get("target")}
            for item in items
        ]

    state: dict[str, Any] = {
        "checked_at": now(),
        "mode": mode,
        "root": str(root) if root else None,
        "counts": {key: len(value) for key, value in buckets.items()},
        "intact": brief(buckets[STATUS_INTACT]),
        "drift": brief(buckets[STATUS_DRIFT]),
        "missing": brief(buckets[STATUS_MISSING]),
        "unverifiable": brief(buckets[STATUS_UNVERIFIABLE]),
        "skip": brief(buckets[STATUS_INTACT]),
        "redo": brief(buckets[STATUS_DRIFT] + buckets[STATUS_MISSING]),
    }

    if mode == "restart":
        state["guidance"] = (
            "显式 --restart：已登记的副作用会被重复施加。"
            "重跑前先确认这些动作幂等，或只重做未完成部分。"
        )
    elif not verified:
        state["guidance"] = "无 checkpoint：无法证明副作用是否已完成，重跑前先自查。"
    else:
        parts = []
        if state["skip"]:
            parts.append(f"{len(state['skip'])} 个副作用已完成（hash 一致）→ 跳过，不要重做")
        if state["redo"]:
            parts.append(f"{len(state['redo'])} 个副作用已漂移/丢失 → 必须重做或先查明原因")
        if state["unverifiable"]:
            parts.append(
                f"{len(state['unverifiable'])} 个命令类副作用无法回读 → 不要盲目重复执行"
            )
        state["guidance"] = "；".join(parts) + "。"
    return state


def summarize(step: dict[str, Any], *, root: Path | None = None) -> str:
    """一行摘要，用于 step log / CLI 输出。"""
    state = resume_state(step, root=root)
    counts = state["counts"]
    total = sum(counts.values())
    if total == 0:
        return "checkpoints=0"
    return (
        f"checkpoints={total} intact={counts.get(STATUS_INTACT, 0)}"
        f" drift={counts.get(STATUS_DRIFT, 0)} missing={counts.get(STATUS_MISSING, 0)}"
        f" unverifiable={counts.get(STATUS_UNVERIFIABLE, 0)}"
    )

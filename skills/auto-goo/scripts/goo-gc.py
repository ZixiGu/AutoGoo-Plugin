#!/usr/bin/env python3
""".goo 数据生命周期管理 —— 只读扫描 + **默认 dry-run** 的清理建议。

为什么需要
----------
`.goo/` 只会单调增长，没有任何清理机制：`site/`（goo-publish 生成物）、
`backups/`（内存层翻转快照）、`logs/`（轮转归档）不断累积，最终拖慢发布、
备份和人工巡检，而且没人知道哪些能删、删了会怎样。

但 `.goo/` 里同时存放**不可重建的执行状态**：`.goo/plan.json`、
`threads/<id>/plan.json`、`threads/<id>/logs/*.log`。误删它们等于砍断任务
进度与审计链。所以本工具的铁律是：

1. **零自动删除**：不带参数运行时只扫描、只报告，`mode=dry-run`。
   必须显式 `--apply` 才会真的删除。
2. **只删可重建物**：`site/`（可随时重建）、旧 `backups/`（保留最近 N 份）、
   `logs/` 里的轮转归档（按大小预算 / 过期天数）。
3. **plan / log 是硬闸门**：`protection_reason()` 对 `.goo/plan.json`、
   `threads/**`（含 plan.json 与 step log）、`config.json`、
   `current_thread.json`、`threads/index.json` 一律返回拒绝原因。
   `--apply` 之前会先跑一遍全量校验：**只要有一条候选命中受保护路径就整体
   abort（exit 2），一个文件都不删** —— 这说明分类逻辑有 bug，宁可不动。
4. **可复核**：每条候选都给出路径、大小、归属类别和「删了会怎样」，
   删除成功后写审计记录到 `.goo/logs/gc-<时间戳>.md`。

目录分类（可重建性）
--------------------
  可重建      site/                                     goo-publish.py 生成
  可重建      backups/                                  保留最近 N 份
  部分可重建  logs/                                     仅轮转归档；当前日志与 step log 保留
  不可重建    threads/ plans/ artifacts/ reports/ ...    本工具永不处理（人工判断）
  未知        其他顶层条目                                只报告，不处理

用法
----
  goo-gc.py                        # 只读扫描 + dry-run 清理清单（默认）
  goo-gc.py --json                 # 机器可读报告
  goo-gc.py --only site           # 只看某几类，逗号分隔：site,backups,logs
  goo-gc.py --keep-backups 5      # 备份保留份数（默认 3）
  goo-gc.py --log-budget-mb 5     # 轮转日志大小预算（默认 5 MiB）
  goo-gc.py --log-max-age-days 90 # 轮转日志过期天数（默认 90，0 = 不按时间淘汰）
  goo-gc.py --snapshot            # 额外写扫描快照到 .goo/state/，下次可算真实增长
  goo-gc.py --apply               # **显式确认**后才真删；受保护路径命中则 abort
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _paths import find_config_dir, project_root_from_config_dir, workspace_path, workspace_paths

# ── 保留策略默认值 ───────────────────────────────────────────────────────────

DEFAULT_KEEP_BACKUPS = 3
DEFAULT_LOG_BUDGET_MB = 5.0
DEFAULT_LOG_MAX_AGE_DAYS = 90.0
SNAPSHOT_NAME = "goo-gc-scan.json"
MAX_LISTED = 8  # 文本输出里每类最多列出的候选数

# ── 硬闸门：这些路径任何情况下都不允许进入候选 ───────────────────────────────

PROTECTED_BASENAMES = {
    "plan.json",          # 当前执行状态源（.goo/plan.json 与 threads/*/plan.json）
    "current_thread.json",
    "config.json",
    "brainstorm.json",
    "thread.json",
    "index.json",         # threads/index.json
    "secrets.json",
}
PROTECTED_SEGMENTS = {"threads"}  # threads/** 全部受保护（plan.json + step log + 产物）

# ── 目录分类 ─────────────────────────────────────────────────────────────────

REBUILDABLE = "可重建"
PARTIAL = "部分可重建"
IRREPLACEABLE = "不可重建"
UNKNOWN = "未知"

# name -> (可重建性, 处置动作, 说明)
DIR_CLASSES: dict[str, tuple[str, str, str]] = {
    "site": (REBUILDABLE, "purge", "goo-publish.py 生成的静态站点，可随时重建"),
    "backups": (REBUILDABLE, "keep-latest", "内存层翻转前的 wiki 快照，保留最近 N 份即可回滚"),
    "logs": (PARTIAL, "budget", "仅轮转归档可清；当前日志与 threads/*/logs/*.log 保留"),
    "threads": (IRREPLACEABLE, "never", "含 plan.json / step log / thread.json —— 永不清理"),
    "plans": (IRREPLACEABLE, "never", "历史 plan 归档，恢复与追溯依赖它 —— 仅人工判断"),
    "artifacts": (IRREPLACEABLE, "never", "step 产物，可能仍被 plan/报告引用 —— 人工判断"),
    "reports": (IRREPLACEABLE, "never", "任务报告，交付物组成部分 —— 人工判断"),
    "brainstorms": (IRREPLACEABLE, "never", "brainstorm 历史，目标决策证据 —— 人工判断"),
    "brainstorm.json": (IRREPLACEABLE, "never", "当前 brainstorm 状态源"),
    "change-requests": (IRREPLACEABLE, "never", "Web 修改请求队列，未处理项不可丢"),
    "obsidian": (IRREPLACEABLE, "never", "Goo-wiki 不可用时的 fallback 归档"),
    "state": (IRREPLACEABLE, "never", "脚本状态与快照（含本工具扫描快照）"),
    "locks": (IRREPLACEABLE, "never", "并发锁，活跃期删除会导致双写"),
    "chat": (IRREPLACEABLE, "never", "会话摘录，含决策证据 —— 人工判断"),
    "iterations": (IRREPLACEABLE, "never", "优化迭代记录，指标基线证据 —— 人工判断"),
    "current_thread.json": (IRREPLACEABLE, "never", "当前 thread 指针"),
    "config.json": (IRREPLACEABLE, "never", "项目配置"),
    "plan.json": (IRREPLACEABLE, "never", "当前任务唯一执行状态源"),
}

# 轮转归档命名：foo.log.1 / foo.log.gz / foo.md.bak ...
ROTATED_LOG_RE = re.compile(r"\.(?:log|md|jsonl|txt|out|err)\.(?:gz|bz2|xz|zip|bak|old|\d+)$")

IMPACT_TEXT = {
    "site": "删除后本地站点暂时 404，下次 `goo-publish.py` 即可重建；"
            "plan/brainstorm/threads 数据不受影响",
    "backups": "该快照是「内存层翻转」的回滚点；删除后无法把 wiki frontmatter 回滚到这一版，"
               "最近保留的 {keep} 份仍可回滚",
    "logs": "轮转归档是已被取代的历史日志；当前日志与各 step log"
            "（threads/*/logs/*.log）完整保留，任务审计链不受影响",
}


# ── 基础工具 ─────────────────────────────────────────────────────────────────

def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(moment: datetime | None) -> str | None:
    if moment is None:
        return None
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def pad(text: str, width: int) -> str:
    """左对齐补齐；超长时截断并加省略号，保证表格不串列。"""
    if len(text) <= width:
        return text.ljust(width)
    return text[: max(1, width - 1)] + "…"


def human(size: float) -> str:
    """人类可读的字节数（1024 进制，保留 1 位小数）。"""
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    value = float(size)
    for unit in units:
        if abs(value) < 1024 or unit == units[-1]:
            return f"{value:.0f}{unit}" if unit == "B" else f"{value:.1f}{unit}"
        value /= 1024
    return f"{value:.1f}TiB"


def is_inside(path: Path, root: Path) -> bool:
    """path 是否严格位于 root 之内（不跟随 symlink，允许 root 自身）。"""
    try:
        resolved = path.resolve()
        base = root.resolve()
    except OSError:
        return False
    if resolved == base:
        return True
    return base in resolved.parents


def is_symlink(path: Path) -> bool:
    try:
        return path.is_symlink()
    except OSError:
        return True


def protection_reason(path: Path) -> str | None:
    """受保护路径的拒绝原因；返回 None 表示该路径本身不禁止删除。

    注意：这里只做「名字/位置」判定，不判包含关系；包含关系由调用方
    结合 allowed_roots 再判一次。
    """
    name = path.name
    if name in PROTECTED_BASENAMES:
        return f"受保护文件名 {name}"
    if any(part in PROTECTED_SEGMENTS for part in path.parts):
        return ".goo/threads/ 下的任何内容（plan.json / step log / thread 元数据）"
    if is_symlink(path):
        return "symlink（不跟随目标，避免误删真实文件）"
    if name.endswith(".log"):
        return "非轮转归档的日志文件（只有 *.log.N / *.log.gz 等轮转归档可清）"
    return None


def walk_files(root: Path) -> list[tuple[Path, int, float]]:
    """递归列出普通文件，返回 (path, size, mtime)；不跟随 symlink。"""
    found: list[tuple[Path, int, float]] = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                entries = list(it)
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    stat = entry.stat(follow_symlinks=False)
                    found.append((Path(entry.path), stat.st_size, stat.st_mtime))
            except OSError:
                continue
    found.sort(key=lambda item: item[0].as_posix())
    return found


def dir_stats(path: Path) -> dict[str, Any]:
    """单个目录/文件的大小、文件数、时间范围与增长速率估算。"""
    if not path.exists():
        return {"exists": False, "bytes": 0, "files": 0, "oldest": None, "newest": None,
                "growth_bytes_per_day": None, "protected_files": 0}
    if path.is_file():
        stat = path.stat()
        entries = [(path, stat.st_size, stat.st_mtime)]
    else:
        entries = walk_files(path)
    total = sum(size for _, size, _ in entries)
    mtimes = [mtime for _, _, mtime in entries]
    oldest = min(mtimes) if mtimes else None
    newest = max(mtimes) if mtimes else None
    growth = None
    if oldest is not None and newest is not None:
        span_days = (newest - oldest) / 86400.0
        if span_days >= 1.0:
            growth = total / span_days
        else:
            growth = float(total)  # 全部写入集中在一天内：速率至少是总量/天
    protected = sum(1 for probe, _, _ in entries if protection_reason(probe))
    return {
        "exists": True,
        "bytes": total,
        "files": len(entries),
        "oldest": iso(datetime.fromtimestamp(oldest, timezone.utc)) if oldest else None,
        "newest": iso(datetime.fromtimestamp(newest, timezone.utc)) if newest else None,
        "growth_bytes_per_day": growth,
        "protected_files": protected,
    }


def tree_size(path: Path) -> tuple[int, int, float | None]:
    """(bytes, files, newest_mtime) for a directory tree or single file."""
    if path.is_file() and not is_symlink(path):
        try:
            stat = path.stat()
            return stat.st_size, 1, stat.st_mtime
        except OSError:
            return 0, 0, None
    entries = walk_files(path)
    newest = max((mtime for _, _, mtime in entries), default=None)
    return sum(size for _, size, _ in entries), len(entries), newest


# ── 路径解析 ─────────────────────────────────────────────────────────────────

def resolve_roots(root: Path) -> tuple[Path, Path, dict[str, Path]]:
    """返回 (gc_root=.goo 目录, project_root, 关键子目录)。"""
    config_dir = find_config_dir(root)
    project_root = project_root_from_config_dir(config_dir, root)
    workspace_paths(config_dir)  # 读取一次，保证 config.json 可解析（失败时回落默认值）
    dirs = {
        "site": workspace_path(config_dir, "site_dir"),
        "logs": workspace_path(config_dir, "logs_dir"),
        "threads": workspace_path(config_dir, "threads_dir"),
        "backups": config_dir / "backups",  # 无 workspace 配置项，固定挂在 .goo/backups
    }
    return config_dir, project_root, dirs


# ── 扫描 ─────────────────────────────────────────────────────────────────────

def scan(gc_root: Path, previous: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """扫描 .goo 顶层每个条目的体积、增长与可重建性分类。"""
    prev_dirs = (previous or {}).get("dirs") if isinstance(previous, dict) else None
    prev_bytes = {}
    prev_at = None
    if isinstance(prev_dirs, list):
        for item in prev_dirs:
            if isinstance(item, dict) and item.get("name"):
                prev_bytes[str(item["name"])] = int(item.get("bytes") or 0)
    if isinstance(previous, dict) and previous.get("generated_at"):
        prev_at = str(previous["generated_at"])

    rows: list[dict[str, Any]] = []
    if not gc_root.exists():
        return rows
    try:
        children = sorted(gc_root.iterdir(), key=lambda p: p.name)
    except OSError:
        return rows

    for child in children:
        name = child.name
        if name.endswith(".lock") or name.endswith(".tmp"):
            continue
        rebuildability, action, note = DIR_CLASSES.get(
            name, (UNKNOWN, "never", "本工具不处理（未分类顶层条目），需人工判断")
        )
        stats = dir_stats(child)
        row = {
            "name": name,
            "path": str(child),
            "kind": "dir" if child.is_dir() and not is_symlink(child) else "file",
            "rebuildability": rebuildability,
            "action": action,
            "note": note,
            **stats,
        }
        if name in prev_bytes:
            row["previous_bytes"] = prev_bytes[name]
            row["delta_bytes"] = stats["bytes"] - prev_bytes[name]
            row["previous_scan_at"] = prev_at
        rows.append(row)
    return rows


def load_snapshot(config_dir: Path) -> dict[str, Any] | None:
    path = config_dir / "state" / SNAPSHOT_NAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def write_snapshot(config_dir: Path, report: dict[str, Any]) -> Path:
    path = config_dir / "state" / SNAPSHOT_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"generated_at": report["generated_at"], "gc_root": report["gc_root"],
               "dirs": [{"name": d["name"], "bytes": d["bytes"], "files": d["files"]}
                        for d in report["dirs"]]}
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


# ── 候选生成 ─────────────────────────────────────────────────────────────────

def candidate(category: str, path: Path, kind: str, size: int) -> dict[str, Any]:
    return {
        "category": category,
        "path": str(path),
        "kind": kind,
        "bytes": int(size),
        "impact": IMPACT_TEXT.get(category, "可重建/可再生成，删除后由对应命令重建"),
    }


def site_candidates(site_dir: Path) -> list[dict[str, Any]]:
    if not site_dir.is_dir() or is_symlink(site_dir):
        return []
    return [candidate("site", path, "file", size) for path, size, _ in walk_files(site_dir)]


def backup_candidates(
    backups_dir: Path, keep: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """返回 (可清理的旧备份, 全部备份条目快照)。"""
    if not backups_dir.is_dir() or is_symlink(backups_dir):
        return [], []
    entries: list[dict[str, Any]] = []
    for child in backups_dir.iterdir():
        if is_symlink(child) or child.name.startswith("."):
            continue  # .last-layer-flip 之类的指针文件保留
        try:
            dir_mtime = child.stat().st_mtime
        except OSError:
            continue
        size, files, newest = tree_size(child)
        # 快照目录本身的 mtime 会被"新建文件"刷新（甚至同秒内全部相同），
        # 内容最新时间才是可信排序依据；无内容时退回目录 mtime。
        mtime = newest if newest is not None else dir_mtime
        entries.append({
            "name": child.name,
            "path": str(child),
            "kind": "dir" if child.is_dir() else "file",
            "bytes": size,
            "files": files,
            "mtime": iso(datetime.fromtimestamp(mtime, timezone.utc)),
            "_mtime_ts": mtime,
            "_dir_mtime_ts": dir_mtime,
        })
    # 内容时间降序 → 目录时间降序 → 名字降序（备份名通常内嵌 ISO 时间戳）
    entries.sort(
        key=lambda item: (item["_mtime_ts"], item["_dir_mtime_ts"], item["name"]),
        reverse=True,
    )
    out: list[dict[str, Any]] = []
    for entry in entries[max(keep, 0):]:
        out.append(candidate("backups", Path(entry["path"]), entry["kind"], entry["bytes"]))
    for entry in entries:
        entry.pop("_mtime_ts", None)
        entry.pop("_dir_mtime_ts", None)
    return out, entries


def log_candidates(
    logs_dir: Path,
    budget_bytes: int,
    max_age_days: float,
    threads_dir: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """只挑轮转归档；按大小预算 + 过期天数产生候选。"""
    if not logs_dir.is_dir() or is_symlink(logs_dir):
        # ⚠ 必须与正常路径返回**完全相同的字段集**。
        # 实测 bug：这里曾少返回 rotated_count / rotated_bytes / budget_bytes /
        # max_age_days，导致 .goo/logs 不存在时（新项目、清理后）build_report
        # 直接 KeyError('rotated_count') 崩溃 —— 而 logs 缺失恰恰是最常见状态。
        return [], {
            "total_bytes": 0,
            "rotated_count": 0,
            "rotated_bytes": 0,
            "budget_hit": False,
            "budget_bytes": budget_bytes,
            "max_age_days": max_age_days,
        }
    all_entries = walk_files(logs_dir)
    total = sum(size for _, size, _ in all_entries)

    rotated = []
    for path, size, mtime in all_entries:
        if path.parent == threads_dir or is_inside(path, threads_dir):
            continue  # step log 永不处理（protection_reason 也会兜底）
        if not ROTATED_LOG_RE.search(path.name):
            continue
        if protection_reason(path):
            continue
        rotated.append({"path": path, "bytes": size, "mtime": mtime})
    rotated.sort(key=lambda item: item["mtime"])  # 最旧优先

    chosen: dict[str, dict[str, Any]] = {}
    projected = total
    for item in rotated:
        if projected <= budget_bytes:
            break
        chosen[str(item["path"])] = item
        projected -= item["bytes"]

    if max_age_days and max_age_days > 0:
        cutoff = now().timestamp() - max_age_days * 86400.0
        for item in rotated:
            if item["mtime"] < cutoff:
                chosen[str(item["path"])] = item

    out = [candidate("logs", item["path"], "file", item["bytes"]) for item in chosen.values()]
    out.sort(key=lambda c: c["path"])
    meta = {
        "total_bytes": total,
        "rotated_count": len(rotated),
        "rotated_bytes": sum(item["bytes"] for item in rotated),
        "budget_hit": total > budget_bytes,
        "budget_bytes": budget_bytes,
        "max_age_days": max_age_days,
    }
    return out, meta


# ── 报告 ─────────────────────────────────────────────────────────────────────

def build_report(
    gc_root: Path,
    project_root: Path,
    dirs: dict[str, Path],
    *,
    only: set[str],
    keep_backups: int,
    log_budget_bytes: int,
    log_max_age_days: float,
    previous: dict[str, Any] | None,
) -> dict[str, Any]:
    rows = scan(gc_root, previous)

    site_list = site_candidates(dirs["site"]) if "site" in only else []
    if "backups" in only:
        backup_list, backup_entries = backup_candidates(dirs["backups"], keep_backups)
    else:
        backup_list, backup_entries = [], []
    log_list, log_meta = (
        log_candidates(dirs["logs"], log_budget_bytes, log_max_age_days, dirs["threads"])
        if "logs" in only
        else ([], {"total_bytes": 0, "rotated_count": 0, "rotated_bytes": 0,
                   "budget_hit": False, "budget_bytes": log_budget_bytes,
                   "max_age_days": log_max_age_days})
    )

    candidates = site_list + backup_list + log_list
    candidates.sort(key=lambda c: (c["category"], c["path"]))

    groups = []
    for cat in ("site", "backups", "logs"):
        items = [c for c in candidates if c["category"] == cat]
        groups.append({
            "category": cat,
            "count": len(items),
            "bytes": sum(c["bytes"] for c in items),
            "impact": IMPACT_TEXT[cat].format(keep=keep_backups),
            "sample": [c["path"] for c in items[:MAX_LISTED]],
            "truncated": max(0, len(items) - MAX_LISTED),
        })

    total_bytes = sum(row["bytes"] for row in rows)
    total_files = sum(row["files"] for row in rows)
    site_row = next((r for r in rows if r["name"] == "site"), {})
    logs_row = next((r for r in rows if r["name"] == "logs"), {})

    policy = [
        {
            "category": "site",
            "rule": "全量可重建：goo-publish.py 生成物，无需保留",
            "status": f"{human(site_row.get('bytes', 0))} · {site_row.get('files', 0)} 文件 → "
                      f"{'可清' if site_list else '无可清（目录不存在或已空）'}",
            "candidates": len(site_list),
            "bytes": sum(c["bytes"] for c in site_list),
        },
        {
            "category": "backups",
            "rule": f"保留最近 {keep_backups} 份，更旧的按时间淘汰",
            "status": f"当前 {len(backup_entries)} 份 → "
                      f"{'可清 ' + str(len(backup_list)) + ' 份' if backup_list else '无需清理'}",
            "candidates": len(backup_list),
            "bytes": sum(c["bytes"] for c in backup_list),
        },
        {
            "category": "logs",
            "rule": f"只清轮转归档：预算 {human(log_budget_bytes)}，"
                    f"或超过 {log_max_age_days:g} 天",
            "status": f"当前 {human(log_meta['total_bytes'])} · "
                      f"轮转归档 {log_meta['rotated_count']} 个 → "
                      f"{'可清 ' + str(len(log_list)) + ' 个' if log_list else '无需清理'}",
            "candidates": len(log_list),
            "bytes": sum(c["bytes"] for c in log_list),
        },
    ]

    protected_rules = [
        ".goo/plan.json（当前任务唯一执行状态源）",
        ".goo/threads/*/plan.json（各 thread 执行状态）",
        ".goo/threads/*/logs/*.log（step 留痕，审计链）",
        ".goo/threads/**（thread.json / index 相关元数据）",
        ".goo/config.json、.goo/current_thread.json、.goo/brainstorm.json、.goo/secrets.json",
        ".goo/plans/**、.goo/artifacts/**、.goo/reports/**（不可重建，人工判断）",
    ]

    return {
        "generated_at": iso(now()),
        "mode": "dry-run",
        "gc_root": str(gc_root),
        "project_root": str(project_root),
        "totals": {"bytes": total_bytes, "files": total_files},
        "dirs": rows,
        "policy": policy,
        "candidates": candidates,
        "groups": groups,
        "logs_meta": log_meta,
        "backups": backup_entries,
        "reclaimable_bytes": sum(c["bytes"] for c in candidates),
        "reclaimable_count": len(candidates),
        "protected": {
            "rules": protected_rules,
            "files": sum(row.get("protected_files", 0) for row in rows),
            "bytes": sum(row.get("bytes", 0) for row in rows if row.get("action") == "never"),
        },
        "log_snapshot_bytes": logs_row.get("bytes", 0),
        "roots": {key: str(value) for key, value in dirs.items()},
    }


def relative(path: str, root: str) -> str:
    """尽量用项目内相对路径展示，便于人工复核。"""
    try:
        return str(Path(path).relative_to(Path(root)))
    except ValueError:
        return path


def render(report: dict[str, Any], *, apply_requested: bool) -> str:
    lines: list[str] = []
    mode = report["mode"]
    lines.append(f"AutoGoo .goo 生命周期扫描（{mode}）")
    lines.append(f"根目录: {report['gc_root']}")
    lines.append(f"总计: {human(report['totals']['bytes'])} / {report['totals']['files']} 文件")
    if mode == "dry-run":
        lines.append("本工具默认 dry-run：以下只是清单，未删除任何文件。")
    lines.append("")

    # 目录分类
    lines.append("── 目录扫描（体积 / 增长 / 可重建性）")
    lines.append(
        f"{pad('dir', 22)}{'size':>9}{'files':>7}{'prot':>6}"
        f"{'growth/day':>13}  {'rebuild':<12}action"
    )
    for row in report["dirs"]:
        growth = row.get("growth_bytes_per_day")
        growth_text = human(growth) if growth else "-"
        delta = row.get("delta_bytes")
        if delta is not None:
            growth_text += f" Δ{'+' if delta >= 0 else '-'}{human(abs(delta))}"
        name = row["name"] + ("/" if row["kind"] == "dir" else "")
        lines.append(
            f"{pad(name, 22)}{human(row['bytes']):>9}{row['files']:>7}"
            f"{row.get('protected_files', 0):>6}{growth_text:>13}  "
            f"{pad(row['rebuildability'], 12)}{row['action']}"
        )
    lines.append("")

    # 保留策略
    lines.append("── 保留策略")
    for item in report["policy"]:
        lines.append(f"  {item['category']:<9} {item['rule']}")
        lines.append(f"  {'':<9} {item['status']}")
    lines.append("")

    # 候选
    lines.append("── 可清理候选" + ("（dry-run：未执行）" if mode == "dry-run" else "（已执行）"))
    if not report["candidates"]:
        lines.append("  无 —— 当前没有任何可清理项。")
    for group in report["groups"]:
        if not group["count"]:
            continue
        lines.append(f"  [{group['category']}] {group['count']} 项 / {human(group['bytes'])}")
        for path in group["sample"]:
            lines.append(f"    - {relative(path, report['project_root'])}")
        if group["truncated"]:
            lines.append(f"    … 其余 {group['truncated']} 项（--json 查看全量）")
    lines.append("")

    # 删了会怎样
    lines.append("── 删了会怎样")
    for group in report["groups"]:
        if not group["count"]:
            continue
        lines.append(f"  [{group['category']}] {group['impact']}")
    if not any(group["count"] for group in report["groups"]):
        lines.append("  无可清理项，无影响。")
    lines.append("")

    # 受保护
    lines.append("── 受保护（本工具永不删除）")
    for rule in report["protected"]["rules"]:
        lines.append(f"  · {rule}")
    lines.append(f"  本次扫描命中受保护文件 {report['protected']['files']} 个（已排除在候选之外）")
    lines.append("")

    # 汇总
    lines.append("── 汇总")
    if report["reclaimable_count"]:
        lines.append(
            f"  可释放: {human(report['reclaimable_bytes'])}"
            f"（{report['reclaimable_count']} 项）"
        )
        if mode == "dry-run":
            lines.append("  执行: goo-gc.py --apply    # 显式确认后才会真删")
    else:
        lines.append("  可释放: 0B（无需清理）")
    return "\n".join(lines)


# ── 执行 ─────────────────────────────────────────────────────────────────────

def apply_candidates(
    report: dict[str, Any],
    gc_root: Path,
    dirs: dict[str, Path],
) -> dict[str, Any]:
    """执行删除。先做全量安全校验，任一候选越界/受保护则整体 abort。"""
    allowed_roots = [dirs["site"], dirs["backups"], dirs["logs"]]
    violations: list[dict[str, str]] = []
    for item in report["candidates"]:
        path = Path(item["path"])
        reason = protection_reason(path)
        if reason:
            violations.append({"path": str(path), "reason": reason})
            continue
        if not is_inside(path, gc_root):
            violations.append({"path": str(path), "reason": f"不在 {gc_root} 之内"})
            continue
        if not any(is_inside(path, root) for root in allowed_roots):
            violations.append(
                {"path": str(path), "reason": "不在可清理根目录（site/backups/logs）之内"}
            )
    if violations:
        return {"aborted": True, "violations": violations, "deleted": [], "freed_bytes": 0}

    deleted: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    freed = 0
    for item in report["candidates"]:
        path = Path(item["path"])
        try:
            if path.is_dir() and not is_symlink(path):
                shutil.rmtree(path)
            elif path.exists() or is_symlink(path):
                path.unlink()
            else:
                skipped.append({"path": str(path), "reason": "已不存在（可能被其他进程清理）"})
                continue
        except OSError as exc:
            skipped.append({"path": str(path), "reason": f"{type(exc).__name__}: {exc}"})
            continue
        freed += int(item["bytes"])
        deleted.append({"path": str(path), "category": item["category"], "bytes": item["bytes"]})

    return {"aborted": False, "violations": [], "deleted": deleted, "skipped": skipped,
            "freed_bytes": freed}


def write_audit_log(gc_root: Path, result: dict[str, Any], report: dict[str, Any]) -> Path | None:
    logs_dir = gc_root / "logs"
    try:
        logs_dir.mkdir(parents=True, exist_ok=True)
        path = logs_dir / f"gc-{now().strftime('%Y%m%d-%H%M%S')}.md"
        body = [
            "# goo-gc 执行记录",
            "",
            f"- 时间: {report['generated_at']}",
            f"- .goo 根: {gc_root}",
            f"- 释放: {human(result['freed_bytes'])} / {len(result['deleted'])} 项",
            f"- 跳过: {len(result.get('skipped') or [])} 项",
            "",
            "## 已删除",
            "",
        ]
        for item in result["deleted"]:
            body.append(f"- [{item['category']}] {item['path']} ({human(item['bytes'])})")
        if result.get("skipped"):
            body += ["", "## 跳过", ""]
            for item in result["skipped"]:
                body.append(f"- {item['path']} — {item['reason']}")
        body.append("")
        path.write_text("\n".join(body), encoding="utf-8")
        return path
    except OSError:
        return None


# ── CLI ──────────────────────────────────────────────────────────────────────

def parse_only(raw: str) -> set[str]:
    allowed = {"site", "backups", "logs"}
    requested = {part.strip().lower() for part in raw.split(",") if part.strip()}
    unknown = requested - allowed
    if unknown:
        raise SystemExit(f"--only 只支持 {sorted(allowed)}，收到未知项: {sorted(unknown)}")
    return requested or allowed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="AutoGoo .goo 数据生命周期管理（默认 dry-run，零自动删除）"
    )
    parser.add_argument("--root", type=Path, default=Path.cwd(),
                        help="项目根或 .goo 目录（默认 cwd）")
    parser.add_argument("--json", action="store_true", help="输出机器可读报告")
    parser.add_argument("--quiet", action="store_true", help="静默（仅 --json 时有意义）")
    parser.add_argument("--only", default="site,backups,logs",
                        help="只处理某几类：site,backups,logs")
    parser.add_argument("--keep-backups", type=int, default=DEFAULT_KEEP_BACKUPS,
                        help=f"保留最近 N 份备份"
                             f"（默认 {DEFAULT_KEEP_BACKUPS}）")
    parser.add_argument("--log-budget-mb", type=float, default=DEFAULT_LOG_BUDGET_MB,
                        help="logs 目录预算，超出后从最旧的轮转归档开始清"
                             f"（默认 {DEFAULT_LOG_BUDGET_MB:g}MiB）")
    parser.add_argument("--log-max-age-days", type=float, default=DEFAULT_LOG_MAX_AGE_DAYS,
                        help="轮转归档过期天数"
                             f"（默认 {DEFAULT_LOG_MAX_AGE_DAYS:g}，0 = 不按时间淘汰）")
    parser.add_argument("--snapshot", action="store_true",
                        help="写扫描快照到 .goo/state/，下次运行可计算真实增长")
    parser.add_argument("--apply", action="store_true",
                        help="显式执行删除（默认 dry-run）；受保护路径命中则整体 abort")
    args = parser.parse_args(argv)

    gc_root, project_root, dirs = resolve_roots(args.root.expanduser())
    only = parse_only(args.only)
    budget_bytes = max(0, int(args.log_budget_mb * 1024 * 1024))

    report = build_report(
        gc_root,
        project_root,
        dirs,
        only=only,
        keep_backups=max(0, args.keep_backups),
        log_budget_bytes=budget_bytes,
        log_max_age_days=max(0.0, args.log_max_age_days),
        previous=load_snapshot(gc_root),
    )

    if args.snapshot:
        report["snapshot_path"] = str(write_snapshot(gc_root, report))

    exit_code = 0
    if args.apply:
        result = apply_candidates(report, gc_root, dirs)
        if result["aborted"]:
            report["mode"] = "aborted"
            report["violations"] = result["violations"]
            exit_code = 2
        else:
            report["mode"] = "applied"
            report["applied"] = result
            audit = write_audit_log(gc_root, result, report)
            if audit:
                report["audit_log"] = str(audit)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    elif not args.quiet:
        print(render(report, apply_requested=args.apply))
        if report["mode"] == "aborted":
            print()
            print("已 abort：以下候选命中受保护路径，未删除任何文件（分类逻辑需修复）")
            for item in report.get("violations", []):
                print(f"  - {item['path']} — {item['reason']}")
        elif report["mode"] == "applied":
            applied = report["applied"]
            print()
            print(f"已释放: {human(applied['freed_bytes'])}（{len(applied['deleted'])} 项）")
            if applied.get("skipped"):
                print(f"跳过: {len(applied['skipped'])} 项")
            if report.get("audit_log"):
                print(f"审计记录: {report['audit_log']}")

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

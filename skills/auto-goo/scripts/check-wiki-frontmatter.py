#!/usr/bin/env python3
"""校验 Goo-wiki 归档笔记的 frontmatter 完整性。

为什么需要这个脚本
------------------
SKILL.md 写着「归档笔记必须含 memory_layer: L0|L1|L2|L3」，但**没有任何强制
机制**。实测结果：843 篇笔记里只有 423 篇填了（50%），L3 项目画像仅 11 篇
（其中 autogoo-plugin 这个项目本身是 0）。

配置项/字段「写了但没人执行」是本项目的反复出现的失效模式
（planning.recall_wiki 曾零引用、execution.heartbeat_seconds 曾零引用）。
所以这里把它变成可执行的检查，而不是继续停留在文档约定。

用法
----
  check-wiki-frontmatter.py --check <file.md>          # 校验单个文件，违规退出 1
  check-wiki-frontmatter.py --audit <wiki_dir>         # 审计全库，输出缺口报告
  check-wiki-frontmatter.py --audit <wiki_dir> --json  # 机器可读
  check-wiki-frontmatter.py --suggest <file.md>        # 按路径/类型推断建议层级

层级语义（references/setup.md 记忆分层原则）：
  L0 原始记录   .goo/logs、raw/、journal/daily —— 不进 Subagent 默认上下文
  L1 原子事实   execution/、findings/、step 报告
  L2 场景知识   lessons/、references/、concepts/、tasks/
  L3 项目画像   项目入口 <slug>.md、operations.md —— 主 Agent 启动时读
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

VALID_LAYERS = {"L0", "L1", "L2", "L3"}

# wiki 根目录的基础设施文件：它们不是「任务归档笔记」，而是 wiki 自身的
# 索引/说明/模板。对它们要求 memory_layer 属于指标造假，应当显式排除。
INFRA_NAMES = {
    "CLAUDE.md", "AGENTS.md", "README.md",
    "index.md", "log.md", "home.md",
    "obsidian-cli.md", "llm-wiki.md", "llm-wiki.zh.md",
}


def is_infra(rel: str) -> bool:
    """是否是 wiki 基础设施文件（根目录或 wiki/ 一层下的说明类文件）。"""
    if "/" not in rel:
        return True
    parts = rel.split("/")
    return len(parts) <= 2 and parts[-1] in INFRA_NAMES

# 路径片段 -> 建议层级（**按顺序匹配，先命中先用，所以更具体的放前面**）
#
# ⚠ 这只是**兜底建议**，不是判定标准。实测 75 篇有标注的笔记里，
# 路径推断与人工标注有 39% 冲突 —— 说明「内容属于哪一层」本质上是语义
# 判断，路径只能覆盖最常见的情况。冲突时应以语义为准（见 classify_hint）。
LAYER_HINTS: list[tuple[str, str]] = [
    # ── L0：原始记录，只有追溯价值 ──
    ("/raw/", "L0"),
    ("/journal/", "L0"),            # daily + weekly 都是原始记录
    ("/logs/", "L0"),
    ("/execution/record.md", "L0"),        # 执行流水原文（不是提炼后的结论）
    ("/execution/evidence-index.md", "L0"),# 证据索引，仍是原始材料
    ("/execution/transcript", "L0"),
    # ── L1：原子事实，只有查证价值 ──
    ("/execution/", "L1"),          # 提炼过的执行结论
    ("/findings/", "L1"),
    ("/evidence/", "L1"),
    # ── L2：场景知识，有复用价值（默认层）──
    ("/lessons/", "L2"),
    ("/references/", "L2"),
    ("/concepts/", "L2"),
    ("/tasks/", "L2"),
    ("/archive/", "L2"),
]

# 文件名模式 -> 层级（用于 tasks/task-xxx.md 这类任务页：结论 → L1）
FILENAME_HINTS: list[tuple[str, str]] = [
    # 任务页实测 14 篇 L2 / 4 篇 L1 —— 多数含可复用的分析与决策，默认 L2。
    # 少数纯修复记录会被人工标为 L1，这种语义差异路径推断不了，属正常冲突。
    ("/operations.md", "L3"),       # 项目运维手册 → 项目画像
]


def read_frontmatter(text: str) -> dict[str, str] | None:
    """极简 frontmatter 解析（不引入 yaml 依赖）。返回 None 表示没有 frontmatter。"""
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    fm: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if not line or line.startswith(" ") or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        fm[key.strip()] = value.strip().strip("'\"")
    return fm


def suggest_layer(rel: str, fm: dict[str, str] | None, text: str) -> str:
    """按路径推断层级；项目入口文件优先判为 L3。"""
    fm = fm or {}
    if fm.get("type") == "project":
        return "L3"
    # 项目入口：wiki/projects/<slug>.md（两层，末尾是文件名）
    if re.match(r"^wiki/projects/[^/]+\.md$", rel):
        return "L3"
    if rel.endswith("/operations.md"):
        return "L3"
    for needle, layer in FILENAME_HINTS:
        if needle in f"/{rel}":
            return layer
    for needle, layer in LAYER_HINTS:
        if needle in f"/{rel}":
            return layer
    return "L2"


def check_file(path: Path, wiki_root: Path | None = None) -> list[str]:
    """返回问题列表（空表示合规）。"""
    problems: list[str] = []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError as e:
        return [f"{path}: 无法读取: {e}"]

    fm = read_frontmatter(text)
    if fm is None:
        return [f"{path}: 缺少 frontmatter（归档笔记必须有 --- 块）"]

    layer = fm.get("memory_layer")
    if not layer:
        rel = path.relative_to(wiki_root).as_posix() if wiki_root else path.name
        problems.append(
            f"{path}: 缺少 memory_layer（建议 {suggest_layer(rel, fm, text)}）"
        )
    elif layer not in VALID_LAYERS:
        problems.append(f"{path}: memory_layer 非法值 {layer!r}（必须是 L0/L1/L2/L3）")

    if not fm.get("title"):
        problems.append(f"{path}: 缺少 title")

    return problems


def audit(wiki_root: Path) -> dict:
    """全库审计。只读，不修改任何文件。"""
    md_files = [
        p for p in wiki_root.rglob("*.md")
        if ".obsidian" not in p.parts and ".git" not in p.parts
    ]
    missing: list[dict] = []
    invalid: list[str] = []
    layer_counts: dict[str, int] = {"L0": 0, "L1": 0, "L2": 0, "L3": 0, "(missing)": 0}
    project_l3: dict[str, int] = {}

    for p in md_files:
        rel = p.relative_to(wiki_root).as_posix()
        if is_infra(rel):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        fm = read_frontmatter(text) or {}
        layer = fm.get("memory_layer")
        if not layer:
            layer_counts["(missing)"] += 1
            missing.append({
                "path": rel,
                "suggested": suggest_layer(rel, fm, text),
            })
        elif layer not in VALID_LAYERS:
            invalid.append(f"{rel}: {layer}")
        else:
            layer_counts[layer] += 1

        # 统计每个项目的 L3 覆盖
        m = re.match(r"^wiki/projects/([^/]+)/", rel) or re.match(r"^wiki/projects/([^/]+)\.md$", rel)
        if m:
            slug = m.group(1)
            project_l3.setdefault(slug, 0)
            if layer == "L3":
                project_l3[slug] += 1

    counted = len(md_files) - sum(
        1 for p in md_files if is_infra(p.relative_to(wiki_root).as_posix())
    )
    return {
        "total": counted,
        "infra_excluded": len(md_files) - counted,
        "layer_counts": layer_counts,
        "missing_count": len(missing),
        "missing": missing,
        "invalid": invalid,
        "projects_without_l3": sorted(k for k, v in project_l3.items() if v == 0),
        "project_l3": dict(sorted(project_l3.items())),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", metavar="FILE", help="校验单个文件")
    g.add_argument("--audit", metavar="WIKI_DIR", help="审计整个 wiki（只读）")
    g.add_argument("--suggest", metavar="FILE", help="按路径/类型推断建议层级")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--strict", action="store_true", help="审计时有缺失即退出 1")
    args = ap.parse_args()

    if args.check:
        path = Path(args.check).expanduser()
        problems = check_file(path)
        if problems:
            for msg in problems:
                print(msg, file=sys.stderr)
            return 1
        print(f"OK: {path}")
        return 0

    if args.suggest:
        path = Path(args.suggest).expanduser()
        text = path.read_text(encoding="utf-8", errors="ignore")
        fm = read_frontmatter(text)
        print(suggest_layer(path.name, fm, text))
        return 0

    wiki_root = Path(args.audit).expanduser()
    if not wiki_root.is_dir():
        print(f"不是目录: {wiki_root}", file=sys.stderr)
        return 2
    report = audit(wiki_root)

    if args.json:
        # missing 可能很长，JSON 模式下默认截断到 50 条，避免爆输出
        trimmed = dict(report)
        trimmed["missing"] = report["missing"][:50]
        trimmed["missing_truncated"] = len(report["missing"]) > 50
        print(json.dumps(trimmed, ensure_ascii=False, indent=2))
    else:
        lc = report["layer_counts"]
        print(f"总计 {report['total']} 篇")
        print(f"  L0={lc['L0']}  L1={lc['L1']}  L2={lc['L2']}  L3={lc['L3']}  缺={lc['(missing)']}")
        if report["invalid"]:
            print(f"\n非法 memory_layer（{len(report['invalid'])}）:")
            for item in report["invalid"][:20]:
                print(f"  {item}")
        if report["missing"]:
            print(f"\n缺失 memory_layer（{report['missing_count']}），前 20 条:")
            for item in report["missing"][:20]:
                print(f"  {item['path']}  → 建议 {item['suggested']}")
        if report["projects_without_l3"]:
            print(f"\n没有 L3 项目画像的项目（{len(report['projects_without_l3'])}）:")
            for slug in report["projects_without_l3"][:20]:
                print(f"  {slug}")

    if args.strict and (report["missing_count"] or report["invalid"]):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

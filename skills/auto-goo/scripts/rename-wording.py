#!/usr/bin/env python3
"""术语统一：把 profile 直译出来的「画像」按语义拆开改名（幂等）。

背景：用户质疑「项目画像」是 profile 的字面直译 —— 中文里「画像」默认指
「用户/数据画像（profiling）」，读成「项目的画像」会误以为是一次性侦察产物，
而它实际是 Goo-wiki 的 L0 层：项目入口、边界和铁律的常驻总览。因此按语义改名：

    项目画像    → 项目总览    （L0 project profile）
    性能画像    → 性能剖析    （profiler，profiling 的本义）
    任务画像    → 细分任务    （task_agent 是角色下的细分任务）

同一条规则表同时覆盖代码注释、文档、模板 HTML 和 wiki 正文，避免各处自己改
自己的版本。规则**按顺序**应用且有前缀特化（见 RULES），所以重复执行不会
二次改写（幂等）：第二次跑结果一定是 0 处改动。

默认只报告（dry-run）。改 wiki 需要显式 `--wiki`，因为 wiki 里其他项目的
「数据画像 / 规模画像 / 图元画像 / 学科画像」是**另一个概念**（真正的数据
profiling），不在本规则表里，永远不会被误改。

用法::

    rename-wording.py                 # 报告（默认 dry-run）
    rename-wording.py --apply         # 改仓库内代码 + 文档
    rename-wording.py --apply --wiki  # 同时改 Goo-wiki 本项目页
    rename-wording.py --check         # CI：仓库内残留「画像」→ 退出码 1
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SELF = Path(__file__).resolve()

# 顺序敏感：前缀特化的规则必须排在兜底规则之前，否则会被兜底规则拆坏。
RULES: list[tuple[str, str]] = [
    # L0 记忆层（project profile）
    ("项目画像", "项目总览"),
    # profiler agent（profiling 的本义）
    ("性能画像", "性能剖析"),
    # task_agent 是角色下的细分任务，不是「任务的画像」
    ("细分任务画像", "细分任务"),
    ("个任务画像", "个细分任务"),
    ("缺少任务画像", "缺少细分任务"),
    ("任务画像文件", "细分任务文件"),
    ("task_agent 画像", "task_agent 细分"),
    ("角色 / 画像映射", "角色 / 任务映射"),
    ("任务画像", "任务细分"),  # 兜底
    # 「场景与画像」= 场景知识(L1) + 项目总览(L0)
    ("场景与画像", "场景知识与项目总览"),
]

# 仓库内需要覆盖的路径（相对 REPO_ROOT）。.goo/ 故意排除：里面是当前 plan、
# brainstorm 和历史 thread 的原始记录，属于状态源和 L0 留痕，不做批量改写。
REPO_TARGETS = [
    ".pi/extensions/autogoo-plugin",
    "skills",
    "commands",
    "docs",
    "agents",
    "hooks",
    "tests",
    "README.md",
    "CLAUDE.md",
]

SUFFIXES = {".ts", ".tsx", ".md", ".py", ".sh", ".html", ".json", ".yml", ".yaml"}

EXCLUDE_DIRS = {
    "node_modules",
    "__pycache__",
    ".git",
    ".goo",
    "dist",
    ".venv",
    "venv",
    "site",
}

# 术语残留检查（--check）要跳过的文件：本脚本自身必须写出「画像」才能定义规则。
CHECK_SKIP = {SELF}

# --check 只关心「项目/任务/性能画像」这三个被改名的组合；其他「画像」
# （数据画像、规模画像、图元画像…）属于别的概念，不在这里判红。
CHECK_PATTERN = re.compile(r"(项目|任务|性能)画像")

WIKI_GLOBS = ["wiki/projects/autogoo-plugin/**/*.md", "wiki/projects/autogoo-plugin.md"]


def default_wiki_root() -> Path:
    """Goo-wiki 根目录：环境变量优先，其次 ~/workspace/Goo-wiki。"""
    env = os.environ.get("AUTOGOO_PLUGIN_WIKI_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / "workspace" / "Goo-wiki"


def iter_files(targets: list[Path]) -> list[Path]:
    """展开目标路径为文件列表（目录递归，跳过 EXCLUDE_DIRS / 非目标后缀）。"""
    out: list[Path] = []
    for target in targets:
        if not target.exists():
            continue
        if target.is_file():
            if target.suffix in SUFFIXES:
                out.append(target)
            continue
        for path in sorted(target.rglob("*")):
            if not path.is_file() or path.suffix not in SUFFIXES:
                continue
            # 本脚本自身必须写出「画像」才能定义规则，永远跳过
            if path.resolve() in CHECK_SKIP:
                continue
            if any(part in EXCLUDE_DIRS for part in path.relative_to(REPO_ROOT).parts):
                continue
            out.append(path)
    return out


def wiki_files(wiki_root: Path) -> list[Path]:
    """Goo-wiki 本项目页（只碰 autogoo-plugin，别动其他项目的记录）。"""
    out: list[Path] = []
    for pattern in WIKI_GLOBS:
        out.extend(p for p in wiki_root.glob(pattern) if p.is_file())
    return sorted(set(out))


def rewrite(text: str) -> tuple[str, dict[str, int]]:
    """按 RULES 顺序替换，返回新文本与每条规则的命中次数。"""
    counts: dict[str, int] = {}
    for old, new in RULES:
        hits = text.count(old)
        if not hits:
            continue
        counts[old] = hits
        text = text.replace(old, new)
    return text, counts


def report(paths: list[Path], apply: bool) -> tuple[int, int]:
    """遍历文件；返回（改动文件数，改动处数）。"""
    changed_files = 0
    changed_hits = 0
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        new_text, counts = rewrite(text)
        if not counts:
            continue
        total = sum(counts.values())
        changed_files += 1
        changed_hits += total
        detail = "，".join(f"{old}×{n}" for old, n in counts.items())
        try:
            shown = path.relative_to(REPO_ROOT)
        except ValueError:
            shown = path
        print(f"{'rewrite' if apply else 'would rewrite'}: {shown}  ({detail})")
        if apply:
            path.write_text(new_text, encoding="utf-8")
    return changed_files, changed_hits


def check(paths: list[Path]) -> int:
    """返回残留命中数（>0 即需要改名）。"""
    residuals = 0
    for path in paths:
        if path.resolve() in CHECK_SKIP:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if CHECK_PATTERN.search(line):
                residuals += 1
                try:
                    shown = path.relative_to(REPO_ROOT)
                except ValueError:
                    shown = path
                print(f"residual: {shown}:{lineno}: {line.strip()[:120]}")
    return residuals


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把 profile 直译的「画像」按语义改名（幂等）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--apply", action="store_true", help="落盘改写（默认只报告）")
    parser.add_argument("--check", action="store_true", help="只检查残留，有命中则退出码 1")
    parser.add_argument("--wiki", action="store_true", help="同时处理 Goo-wiki 本项目页")
    parser.add_argument("--wiki-root", metavar="PATH", help="Goo-wiki 根目录（默认自动解析）")
    args = parser.parse_args()

    repo_paths = iter_files([REPO_ROOT / t for t in REPO_TARGETS])
    targets = list(repo_paths)
    if args.wiki or args.wiki_root:
        wiki_root = Path(args.wiki_root).expanduser() if args.wiki_root else default_wiki_root()
        if not wiki_root.is_dir():
            print(f"wiki 目录不存在，跳过: {wiki_root}")
        else:
            targets.extend(wiki_files(wiki_root))

    if args.check:
        residuals = check(targets)
        if residuals:
            print(f"\n❌ 仍有 {residuals} 处「项目/任务/性能画像」，运行 --apply 统一措辞")
            return 1
        print(f"✓ 已扫描 {len(targets)} 个文件，无残留")
        return 0

    files, hits = report(targets, apply=args.apply)
    verb = "已改写" if args.apply else "待改写"
    print(f"\n{verb} {hits} 处，涉及 {files} 个文件（扫描 {len(targets)} 个文件）")
    if not args.apply and files:
        print("提示：加 --apply 落盘；--wiki 同时改 Goo-wiki 本项目页")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

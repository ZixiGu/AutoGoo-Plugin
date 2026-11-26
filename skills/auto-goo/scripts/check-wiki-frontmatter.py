#!/usr/bin/env python3
"""校验 Goo-wiki 归档笔记的 frontmatter 完整性。

为什么需要这个脚本
------------------
SKILL.md 写着「归档笔记必须含 memory_layer: L0|L1|L2|L3」，但**没有任何强制
机制**。实测（首次）：843 篇笔记里只有 423 篇填了（50%）。

配置项/字段「写了但没人执行」是本项目的反复出现的失效模式
（planning.recall_wiki 曾零引用、execution.heartbeat_seconds 曾零引用）。
所以这里把它变成可执行的检查，而不是继续停留在文档约定。

用法
----
  check-wiki-frontmatter.py --check <file.md>          # 校验单个文件，违规退出 1
  check-wiki-frontmatter.py --audit <vault_dir>        # 审计全库，输出缺口报告
  check-wiki-frontmatter.py --audit <vault_dir> --json # 机器可读
  check-wiki-frontmatter.py --suggest <file.md>        # 按路径/类型推断建议层级
  check-wiki-frontmatter.py ... --policy <policy.json> # 显式指定机器口径（默认自动查找）

层级语义（**现代口径**，数字越大越原始/越冷；0.27.0 `c7524eb` 起翻转）：
  L0 项目总览   <slug>.md、operations.md、跨项目元教训 —— 最热，启动必读
  L1 场景知识   lessons/、references/、concepts/、tasks/、domains/ —— 默认层
  L2 原子事实   execution/（提炼后）、findings/、reports/、code-graph/
  L3 原始记录   .goo/logs、raw/、journal/、execution/record.md、evidence-index

**口径不在这份脚本里。** 唯一事实源是 Goo-wiki 仓库的 `<vault>/memory/`：
  - `memory/index.md` —— 四层定义与口径历史（为什么这么分）
  - `memory/rules.md` —— 写笔记时的可执行规则
  - `memory/policy.json` —— 机器可读口径（本脚本的 `--audit` / `--suggest` 直读它）
本文件只保留**同构内置兜底**（读不到 policy.json 时使用）。改口径改 `policy.json`，
不要改这里的表 —— 否则会出现「两个检查器对同一篇笔记给出不同层级」的静默漂移。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

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

# ── 机器口径：唯一事实源是 Goo-wiki 的 <vault>/memory/policy.json ────────────
#
# 为什么脚本里不再自带一份 LAYER_HINTS
# ------------------------------------
# 记忆分层口径在 Goo-wiki 的 `memory/` 下维护（index.md 讲为什么、rules.md 讲
# 怎么写、policy.json 是机器可读的唯一口径）。脚本自带一份的后果实测过：
# 两边对 51 篇笔记给出不同层级（`*/reports/`、`*/code-graph/` 只在 policy 里有，
# `/archive/` 只在脚本里有），而检查器自己不会报「我和 policy 不一致」。
# 所以这里只留**同构内置兜底**（读不到 policy.json 时用），字段名与 policy.json 一致。

POLICY_REL = Path("memory") / "policy.json"

DEFAULT_POLICY: dict[str, Any] = {
    "semantics": "modern",
    "layers": {
        "L0": {"name": "项目总览"},
        "L1": {"name": "场景知识"},
        "L2": {"name": "原子事实"},
        "L3": {"name": "原始记录"},
    },
    "required_fields": ["memory_layer", "title"],
    "path_hints": [
        {"match": "/raw/", "layer": "L3"},
        {"match": "/journal/", "layer": "L3"},
        {"match": "/logs/", "layer": "L3"},
        {"match": "/execution/record.md", "layer": "L3"},
        {"match": "/execution/evidence-index.md", "layer": "L3"},
        {"match": "/execution/", "layer": "L2"},
        {"match": "/findings/", "layer": "L2"},
        {"match": "/evidence/", "layer": "L2"},
        {"match": "/reports/", "layer": "L2"},
        {"match": "/code-graph/", "layer": "L2"},
        {"match": "/memory/audit.md", "layer": "L2"},
        {"match": "/memory/", "layer": "L0"},
        {"match": "/operations.md", "layer": "L0"},
        {"match": "/lessons/", "layer": "L1"},
        {"match": "/references/", "layer": "L1"},
        {"match": "/concepts/", "layer": "L1"},
        {"match": "/tasks/", "layer": "L1"},
        {"match": "/domains/", "layer": "L1"},
    ],
    "defaults": {"fallback_layer": "L1", "project_entry_layer": "L0"},
    "exclude_paths": ["memory/"],
}

# 项目入口的两种并存写法（根目录模式 / 子目录模式），语义固定为 L0
PROJECT_ENTRY_PATTERNS = (
    re.compile(r"^wiki/projects/([^/]+)\.md$"),
    re.compile(r"^wiki/projects/([^/]+)/\1\.md$"),
)


def load_policy(wiki_dir: Path | str | None = None, explicit: str | None = None) -> dict[str, Any]:
    """读 Goo-wiki 的 `memory/policy.json`；读不到就用 ``DEFAULT_POLICY``。

    解析顺序：`--policy` > 环境变量 GOO_MEMORY_POLICY > 从 wiki_dir 向上找
    `memory/policy.json`（容纳 vault 根与 wiki/ 两种传参）> 内置兜底。
    """
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env = os.environ.get("GOO_MEMORY_POLICY")
    if env:
        candidates.append(Path(env).expanduser())
    if wiki_dir is not None:
        # 从给定目录逐级向上找：传进来的可能是 wiki/、也可能是某个深目录
        # （`--suggest` 常传笔记自身所在目录），固定「向上两层」会漏掉 vault 根。
        base = Path(wiki_dir).expanduser().resolve()
        for up in [base, *list(base.parents)[:7]]:
            candidates.append(up / POLICY_REL)
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and isinstance(data.get("path_hints"), list):
            merged = dict(DEFAULT_POLICY)
            merged.update(data)
            return merged
    return dict(DEFAULT_POLICY)


def is_excluded(rel: str, policy: dict[str, Any] | None = None) -> bool:
    """policy.exclude_paths 命中的路径不纳入统计（如 `memory/` 规则自身）。"""
    for prefix in (policy or DEFAULT_POLICY).get("exclude_paths") or []:
        text = str(prefix or "")
        if text and (rel == text.rstrip("/") or rel.startswith(text)):
            return True
    return False


def project_entry_slug(rel: str) -> str | None:
    """项目入口文件 -> 项目 slug（两种写法都认）。"""
    for pattern in PROJECT_ENTRY_PATTERNS:
        match = pattern.match(rel)
        if match:
            return match.group(1)
    return None


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


def rel_from_path(path: Path) -> str:
    """从（可能绝对的）路径里切出「相对 wiki 根」的路径。

    为什么需要：`suggest_layer` 的路径规则全靠 `wiki/projects/...` 这类前缀，
    而 `--suggest` 之前传的是 `path.name`（只有文件名）—— 于是**所有路径规则
    从来没生效过**，一律落到默认 L1。

    实测：`wiki/projects/doc_collect/execution/record.md` 应为 L3（原始记录），
    修复前返回 L1。所有 `execution/` `/journal/` `/raw/` 的层级标注都受影响。

    切分规则：找路径里的 `wiki` 段，从它开始取；找不到就用文件名。
    """
    parts = path.parts
    if "wiki" in parts:
        return "/".join(parts[parts.index("wiki"):])
    return path.name


def suggest_layer(
    rel: str,
    fm: dict[str, str] | None,
    text: str = "",
    policy: dict[str, Any] | None = None,
) -> str:
    """按 policy.json 的 path_hints 推断层级（只做兜底建议，不是判定标准）。

    `text` 保留在签名里是为了兼容既有调用方与将来可能的语义判断；当前不参与推断。

    项目入口（`type: project` 或两种路径写法）优先判为 policy 的
    `defaults.project_entry_layer`（默认 L0）—— 语义固定，与文件名无关。
    """
    active = policy or DEFAULT_POLICY
    defaults = active.get("defaults") or {}
    entry_layer = str(defaults.get("project_entry_layer") or "L0")
    fallback = str(defaults.get("fallback_layer") or "L1")

    meta = fm or {}
    if project_entry_slug(rel):
        return entry_layer

    # 顺序有意义：**路径优先于 frontmatter 的 type**。
    # 实测 6 篇 lessons/tasks 页写着 `type: project`（多半是复制粘贴的错值），
    # 若让 type 先行，检查器就会把「错值」当成 L0 并盖住真实的路径语义，
    # 与 Goo-wiki memory/policy.json 的判定也永久对不上。
    target = f"/{rel}"
    for hint in active.get("path_hints") or []:
        needle = str(hint.get("match") or "")
        if needle and needle in target:
            layer = str(hint.get("layer") or fallback)
            return layer if layer in VALID_LAYERS else fallback

    # 路径未命中任何提示时，type: project 是「这是一页项目总览」的语义补充信号
    if meta.get("type") == "project":
        return entry_layer
    return fallback


def check_file(
    path: Path,
    wiki_root: Path | None = None,
    policy: dict[str, Any] | None = None,
) -> list[str]:
    """返回问题列表（空表示合规）。"""
    problems: list[str] = []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError as e:
        return [f"{path}: 无法读取: {e}"]

    fm = read_frontmatter(text)
    if fm is None:
        return [f"{path}: 缺少 frontmatter（归档笔记必须有 --- 块）"]

    if policy is None:
        policy = load_policy(path.parent)

    layer = fm.get("memory_layer")
    if not layer:
        rel = path.relative_to(wiki_root).as_posix() if wiki_root else rel_from_path(path)
        problems.append(
            f"{path}: 缺少 memory_layer（建议 {suggest_layer(rel, fm, text, policy)}）"
        )
    elif layer not in VALID_LAYERS:
        problems.append(f"{path}: memory_layer 非法值 {layer!r}（必须是 L0/L1/L2/L3）")

    if not fm.get("title"):
        problems.append(f"{path}: 缺少 title")

    return problems


def audit(wiki_root: Path, policy: dict[str, Any] | None = None) -> dict:
    """全库审计。只读，不修改任何文件。"""
    active = policy or load_policy(wiki_root)
    md_files = [
        p for p in wiki_root.rglob("*.md")
        if ".obsidian" not in p.parts and ".git" not in p.parts
    ]
    missing: list[dict] = []
    invalid: list[str] = []
    layer_counts: dict[str, int] = {"L0": 0, "L1": 0, "L2": 0, "L3": 0, "(missing)": 0}
    # 项目入口 -> 实际层（一个 slug 可能有多种入口写法，取最「高」的那个：
    # 任一处标了 L0 就算这个项目有 L0 总览）
    entry_layers: dict[str, list[str]] = {}
    excluded = 0

    for p in md_files:
        rel = p.relative_to(wiki_root).as_posix()
        if is_infra(rel):
            continue
        if is_excluded(rel, active):
            excluded += 1
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
                "suggested": suggest_layer(rel, fm, text, active),
            })
        elif layer not in VALID_LAYERS:
            invalid.append(f"{rel}: {layer}")
        else:
            layer_counts[layer] += 1

        slug = project_entry_slug(rel)
        if slug:
            entry_layers.setdefault(slug, []).append(layer or "(missing)")

    def entry_layer(layers: list[str]) -> str:
        for candidate in ("L0", "L1", "L2", "L3"):
            if candidate in layers:
                return candidate
        return "(missing)"

    entries = {slug: entry_layer(layers) for slug, layers in sorted(entry_layers.items())}
    counted = len(md_files) - sum(
        1
        for p in md_files
        if is_infra(p.relative_to(wiki_root).as_posix())
        or is_excluded(p.relative_to(wiki_root).as_posix(), active)
    )
    return {
        "total": counted,
        "infra_excluded": len(md_files) - counted - excluded,
        "excluded_by_policy": excluded,
        "layer_counts": layer_counts,
        "missing_count": len(missing),
        "missing": missing,
        "invalid": invalid,
        # 旧口径（0.27.0 前 L3=项目总览）下这里统计的是 L3；现代口径看 L0。
        "project_entries": entries,
        "projects_without_l0": sorted(slug for slug, layer in entries.items() if layer != "L0"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", metavar="FILE", help="校验单个文件")
    g.add_argument("--audit", metavar="WIKI_DIR", help="审计整个 wiki（只读）")
    g.add_argument("--suggest", metavar="FILE", help="按路径/类型推断建议层级")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--strict", action="store_true", help="审计时有缺失即退出 1")
    ap.add_argument(
        "--policy",
        metavar="POLICY_JSON",
        help="机器口径文件（默认从 <vault>/memory/policy.json 自动查找）",
    )
    args = ap.parse_args()
    policy = load_policy(None, args.policy)

    if args.check:
        path = Path(args.check).expanduser()
        problems = check_file(path, policy=load_policy(path.parent, args.policy))
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
        print(suggest_layer(rel_from_path(path), fm, text, load_policy(path.parent, args.policy)))
        return 0

    wiki_root = Path(args.audit).expanduser()
    if not wiki_root.is_dir():
        print(f"不是目录: {wiki_root}", file=sys.stderr)
        return 2
    report = audit(wiki_root, load_policy(wiki_root, args.policy))

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
        if report["excluded_by_policy"]:
            print(f"\n按 policy.exclude_paths 排除 {report['excluded_by_policy']} 篇（如 memory/ 规则自身）")
        if report["projects_without_l0"]:
            print(f"\n项目入口未标 L0 的项目（{len(report['projects_without_l0'])}）:")
            for slug in report["projects_without_l0"][:20]:
                print(f"  {slug}  → 当前 {report['project_entries'][slug]}")

    if args.strict and (report["missing_count"] or report["invalid"]):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

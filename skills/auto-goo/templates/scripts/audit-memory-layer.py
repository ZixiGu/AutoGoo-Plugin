#!/usr/bin/env python3
"""审计 memory_layer 覆盖率与口径，生成 memory/audit.md。

层级语义（**现代口径**，数字越大越原始/越冷；0.27.0 `c7524eb` 起翻转）：
    L0 项目总览   项目入口、operations.md、跨项目元教训
    L1 场景知识   lessons、references、concepts、任务页（默认层）
    L2 原子事实   提炼后的决策、指标、错误码、findings
    L3 原始记录   step log、命令输出、execution/record.md、journal、raw

判定「这篇笔记属于哪层」按 **memory/policy.json** 的 `path_hints`（唯一机器口径），
不要在本脚本里另写一份；本脚本只读，不修改任何笔记。

用法：
    python3 scripts/audit-memory-layer.py            # 写 memory/audit.md
    python3 scripts/audit-memory-layer.py --print    # 只打印，不写文件
"""
from __future__ import annotations

import collections
import datetime
import json
import os
import re
import sys

ROOT = "."
OUT = "memory/audit.md"
POLICY_PATH = "memory/policy.json"

FALLBACK_POLICY = {
    "semantics": "modern",
    "layers": {
        "L0": {"name": "项目总览"}, "L1": {"name": "场景知识"},
        "L2": {"name": "原子事实"}, "L3": {"name": "原始记录"},
    },
    "required_fields": ["memory_layer", "title"],
    "infra_files": [
        "CLAUDE.md", "AGENTS.md", "README.md", "index.md", "log.md", "home.md",
        "obsidian-cli.md", "llm-wiki.md", "llm-wiki.zh.md",
    ],
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
    "exclude_paths": ["memory/", ".goo/"],
}


def load_policy() -> dict:
    """读 memory/policy.json；缺失或损坏时退回内置副本并告警。"""
    try:
        pol = json.load(open(POLICY_PATH, encoding="utf-8"))
        for key in ("layers", "path_hints", "infra_files", "defaults"):
            if key not in pol:
                raise KeyError(f"缺少字段 {key}")
        return pol
    except Exception as e:  # noqa: BLE001
        print(f"warn: 读取 {POLICY_PATH} 失败（{e}），使用内置兜底口径", file=sys.stderr)
        return FALLBACK_POLICY


POLICY = load_policy()
INFRA = set(POLICY["infra_files"])
VALID = set(POLICY["layers"].keys())
PATH_HINTS = [(h["match"], h["layer"]) for h in POLICY["path_hints"]]
FALLBACK_LAYER = POLICY["defaults"]["fallback_layer"]
EXCLUDE_PATHS = tuple(POLICY.get("exclude_paths", []))
ENTRY_LAYER = POLICY["defaults"].get("project_entry_layer", "L0")
SEMANTICS = POLICY.get("semantics", "modern")


def is_excluded(rel: str) -> bool:
    """policy.exclude_paths 命中的路径不纳入统计（`memory/` 规则自身、`.goo/` 运行时状态）。"""
    return bool(EXCLUDE_PATHS) and rel.startswith(EXCLUDE_PATHS)


def is_infra(rel: str) -> bool:
    parts = rel.split("/")
    return len(parts) <= 2 and parts[-1] in INFRA


def read_fm(path: str) -> dict[str, str] | None:
    try:
        text = open(path, encoding="utf-8", errors="ignore").read()
    except OSError:
        return None
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return None
    fm: dict[str, str] = {}
    for line in m.group(1).split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip()
    return fm


def is_project_entry(rel: str) -> str | None:
    """wiki/projects/<slug>.md 或 wiki/projects/<slug>/<slug>.md → slug"""
    m = re.fullmatch(r"wiki/projects/([^/]+)\.md", rel)
    if m:
        return m.group(1)
    m = re.fullmatch(r"wiki/projects/([^/]+)/([^/]+)\.md", rel)
    if m and m.group(1) == m.group(2):
        return m.group(1)
    return None


def suggest(rel: str) -> str:
    if is_project_entry(rel):
        return ENTRY_LAYER
    padded = "/" + rel
    for needle, layer in PATH_HINTS:
        if needle in padded:
            return layer
    return FALLBACK_LAYER


def collect() -> dict:
    counts = collections.Counter()
    missing_by_top: collections.Counter = collections.Counter()
    missing: list[tuple[str, str]] = []
    wrong: list[tuple[str, str, str]] = []
    entries: list[tuple[str, str | None]] = []
    invalid: list[tuple[str, str]] = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in {".git", ".obsidian", "node_modules", "__pycache__"}]
        for fn in filenames:
            if not fn.endswith(".md"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            if is_infra(rel) or is_excluded(rel):
                continue
            total += 1
            fm = read_fm(full) or {}
            layer = fm.get("memory_layer")
            slug = is_project_entry(rel)
            if slug:
                entries.append((rel, layer))
            if not layer:
                counts["missing"] += 1
                missing_by_top[rel.split("/")[0]] += 1
                missing.append((rel, suggest(rel)))
                continue
            if layer not in VALID:
                invalid.append((rel, layer))
                continue
            counts[layer] += 1
            want = suggest(rel)
            if layer != want:
                wrong.append((rel, layer, want))
    return {
        "total": total,
        "counts": counts,
        "missing": missing,
        "missing_by_top": missing_by_top,
        "wrong": wrong,
        "entries": entries,
        "invalid": invalid,
    }


def render(d: dict) -> str:
    today = datetime.date.today().isoformat()
    c = d["counts"]
    covered = sum(c[k] for k in VALID)
    pct = round(100 * covered / d["total"], 1) if d["total"] else 0
    ent = d["entries"]
    ent_c = collections.Counter((lay or "missing") for _, lay in ent)
    ent_bad = [(r, l) for r, l in ent if l != ENTRY_LAYER]

    out = [
        "---",
        "type: memory-audit",
        "title: memory_layer 覆盖率审计",
        "memory_layer: L2",
        "status: generated",
        f"generated_at: {today}",
        "generator: scripts/audit-memory-layer.py",
        f"policy: {POLICY_PATH}（semantics={SEMANTICS}）",
        "---",
        "",
        "# memory_layer 覆盖率审计",
        "",
        "> 机械统计，**不含解读**。口径见 [[memory/index|记忆系统]]、[[memory/rules|记忆分层规则]]、`memory/policy.json`。",
        f"> 生成时间 {today}，重跑 `python3 scripts/audit-memory-layer.py` 覆盖本页；判据来自 policy.json，改规则不需改脚本。",
        "",
        "## 总览",
        "",
        "| 项 | 值 |",
        "|---|---|",
        f"| 纳入统计的笔记 | {d['total']} |",
        f"| 已标注 | {covered}（{pct}%） |",
        f"| 缺失 `memory_layer` | {c['missing']} |",
        f"| 非法值 | {len(d['invalid'])} |",
        f"| 与路径提示不符 | {len(d['wrong'])} |",
        "",
        "| 层 | 名称 | 篇数 |",
        "|---|---|---|",
    ]
    for k in sorted(VALID):
        out.append(f"| {k} | {POLICY['layers'][k].get('name', '')} | {c[k]} |")

    out += ["", "## 缺失分布（按顶层目录）", "", "| 目录 | 缺失篇数 |", "|---|---|"]
    for top, n in d["missing_by_top"].most_common():
        out.append(f"| `{top}/` | {n} |")

    out += [
        "",
        f"## 项目入口层级（应为 {ENTRY_LAYER}）",
        "",
        f"共 {len(ent)} 篇：L0={ent_c['L0']}、L1={ent_c['L1']}、L2={ent_c['L2']}、L3={ent_c['L3']}、缺失={ent_c['missing']}。",
        "",
    ]
    if ent_bad:
        out += ["| 项目入口 | 当前值 | 应为 |", "|---|---|---|"]
        for r, l in sorted(ent_bad):
            out.append(f"| `{r}` | {l or '缺失'} | {ENTRY_LAYER} |")
    else:
        out.append("全部合规。")

    out += ["", "## 与路径提示不符（前 40 条）", ""]
    if d["wrong"]:
        out += ["| 笔记 | 当前 | 路径提示 |", "|---|---|---|"]
        for r, got, want in d["wrong"][:40]:
            out.append(f"| `{r}` | {got} | {want} |")
        if len(d["wrong"]) > 40:
            out.append(f"| … | 另 {len(d['wrong']) - 40} 条 | |")
    else:
        out.append("无。")

    if d["invalid"]:
        out += ["", "## 非法值", "", "| 笔记 | 值 |", "|---|---|"]
        for r, v in d["invalid"]:
            out.append(f"| `{r}` | `{v}` |")

    out += [
        "",
        "## 命令",
        "",
        "```bash",
        "python3 scripts/audit-memory-layer.py          # 重新生成本页",
        "python3 scripts/audit-memory-layer.py --print  # 只看不写",
        "```",
        "",
        "> 回填步骤见 [[memory/rules#5. 写入与回填流程|rules.md §回填流程]]。",
        "> 外部 checker 的 `--audit` 里「没有 L3 项目总览的项目」仍是**旧口径**（L3=项目总览），与它自己的 `LAYER_HINTS` 矛盾；合规判定以本页为准。",
        "",
        "## 相关",
        "",
        "- [[memory/index|记忆系统（定义与历史）]]",
        "- [[memory/rules|记忆分层规则（写笔记时怎么定层）]]",
        "- [[wiki/domains/knowledge-methodology|知识管理与方法论]]",
        "",
    ]
    return "\n".join(out)


def main() -> None:
    d = collect()
    body = render(d)
    if "--print" in sys.argv:
        print(body)
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(body)
    c = d["counts"]
    print(
        f"ok {OUT} | policy={POLICY_PATH} | 总计 {d['total']} 篇："
        f"L0={c['L0']} L1={c['L1']} L2={c['L2']} L3={c['L3']} 缺={c['missing']} 不符={len(d['wrong'])}"
    )


if __name__ == "__main__":
    main()

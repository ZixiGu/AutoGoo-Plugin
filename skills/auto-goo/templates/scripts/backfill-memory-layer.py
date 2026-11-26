#!/usr/bin/env python3
"""回填 / 纠正笔记 frontmatter 的 memory_layer（机械可判定部分）。

分工：``audit-memory-layer.py`` 只统计不改；本脚本负责「改」，且**只改无歧义的**。

为什么不是「全部按路径提示刷一遍」
----------------------------------
路径提示是兜底建议，不是判定标准。实测 194 篇「与路径提示不符」里混着三类东西：

1. **真错值**：项目入口标成 L3（11 篇）、lessons 标成 L0、领域日志索引标成 L2 —— 该改；
2. **路径规则够不着**：``execution/biology-record.md`` 是执行流水（人判断 L3），
   但 policy 只匹配 ``/execution/record.md``，于是提示 L2 —— 改了就降级；
3. **文档化的例外**：``tasks/`` 页已提炼成纯结论可人工提升 L2（rules.md §4.2）——
   自动改会把人的判断刷掉。

所以本脚本只处理第 1 类（外加「缺失即补」），并按 ``FIX_RULES`` 显式列出可自动修的类别；
其余保持原值，打印成「需人工判断」清单。宁可少改，也不要批量覆盖人的语义判断。

用法
----
    python3 scripts/backfill-memory-layer.py --print      # 只看要改什么（默认）
    python3 scripts/backfill-memory-layer.py --apply      # 真写
    python3 scripts/backfill-memory-layer.py --apply --json

只改 frontmatter 的 ``memory_layer`` 行，正文一个字节不动；可重复执行（幂等）。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

ROOT = "."
AUDIT_SCRIPT = "scripts/audit-memory-layer.py"

# 可自动修（机械、无歧义）的路径类别 -> 目标层。顺序即优先级。
FIX_RULES: list[tuple[str, str]] = [
    ("/execution/record.md", "L3"),
    ("/execution/evidence-index.md", "L3"),
    ("/journal/", "L3"),
    ("/raw/", "L3"),
    ("/logs/", "L3"),
    ("/reports/", "L2"),
    ("/code-graph/", "L2"),
    ("/lessons/", "L1"),
    ("/references/", "L1"),
    ("/concepts/", "L1"),
    ("/domains/", "L1"),
    ("/operations.md", "L0"),
]

# 明确留给人工的路径（语义边界，机器判断会丢信息）
MANUAL_PREFIXES = ("wiki/projects/", )  # 仅用于 tasks/ 页判定，见下
MANUAL_SEGMENTS = ("/tasks/", "/findings/", "/evidence/", "/execution/", "/syntheses/", "wiki/syntheses/")


def load_audit_module():
    """复用审计脚本的口径实现（policy 读取、路径提示、项目入口判定），不复制一份规则。"""
    spec = importlib.util.spec_from_file_location("audit_memory_layer", AUDIT_SCRIPT)
    if spec is None or spec.loader is None:
        raise SystemExit(f"找不到口径实现: {AUDIT_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


FM_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)


def fix_target(rel: str, aml) -> tuple[str, str] | None:
    """返回 (目标层, 依据)。只有无歧义类别才返回，否则 None（留人工）。"""
    if aml.is_excluded(rel):
        return None
    slug = aml.is_project_entry(rel)
    if slug:
        return aml.ENTRY_LAYER, "项目入口语义固定"
    padded = "/" + rel
    for needle, layer in FIX_RULES:
        if needle in padded:
            return layer, f"路径规则 {needle}"
    return None


def desired_layer(rel: str, aml) -> tuple[str, str]:
    """该文件应有的层 + 依据（缺失时用「路径提示兜底」，所以比 fix_target 宽松）。"""
    fixed = fix_target(rel, aml)
    if fixed:
        return fixed
    return aml.suggest(rel), "路径提示兜底（policy.defaults.fallback_layer）"


def derive_title(rel: str, text: str) -> str:
    """从首个 H1 取标题，取不到就用文件名（不猜内容语义）。"""
    for line in text.splitlines()[:40]:
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1).strip()
    return Path(rel).stem


def rewrite_frontmatter(text: str, layer: str, rel: str = "", create: bool = True) -> tuple[str, str]:
    """只碰 memory_layer（必要时也补 title）。返回 (新文本, 动作)。"""
    match = FM_RE.match(text)
    if not match:
        if not create:
            return text, "no_frontmatter"
        # `raw/` 是不可变原始来源，不在回填范围（要统计就把它加进 exclude_paths）
        if rel.startswith("raw/") or rel.startswith("./raw/"):
            return text, "raw_immutable"
        block = f"---\ntitle: {derive_title(rel, text)}\nmemory_layer: {layer}\n---\n\n"
        return block + text, "create_frontmatter"
    body = match.group(1)
    lines = body.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("memory_layer:"):
            current = line.split(":", 1)[1].strip()
            if current == layer:
                return text, "unchanged"
            lines[i] = f"memory_layer: {layer}"
            new_body = "\n".join(lines)
            return text[: match.start(1)] + new_body + text[match.end(1) :], "set"
    # 缺失：优先插在 title 之后，否则插在 frontmatter 末尾
    insert_at = len(lines)
    for i, line in enumerate(lines):
        if line.startswith("title:"):
            insert_at = i + 1
            break
    lines.insert(insert_at, f"memory_layer: {layer}")
    new_body = "\n".join(lines)
    return text[: match.start(1)] + new_body + text[match.end(1) :], "insert"


def collect(aml) -> dict:
    fills: list[dict] = []
    fixes: list[dict] = []
    manual: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [
            d for d in dirnames
            if d not in {".git", ".obsidian", "node_modules", "__pycache__", ".goo"}
            and not aml.is_excluded((os.path.relpath(os.path.join(dirpath, d), ROOT) + "/").replace(os.sep, "/"))
        ]
        for fn in filenames:
            if not fn.endswith(".md"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            if aml.is_infra(rel) or aml.is_excluded(rel):
                continue
            fm = aml.read_fm(full) or {}
            current = fm.get("memory_layer")
            if current and current in aml.VALID:
                fixed = fix_target(rel, aml)
                if fixed and current != fixed[0]:
                    fixes.append({"path": rel, "from": current, "to": fixed[0], "why": fixed[1]})
                elif not fixed and current != aml.suggest(rel):
                    manual.append({"path": rel, "current": current, "hint": aml.suggest(rel)})
                continue
            target, why = desired_layer(rel, aml)
            fills.append({"path": rel, "layer": target, "why": why, "invalid": current or None})
    return {"fills": fills, "fixes": fixes, "manual": manual}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="真写（默认只打印）")
    ap.add_argument("--json", action="store_true", help="输出 JSON 摘要")
    ap.add_argument("--limit", type=int, default=0, help="最多处理 N 个文件（便于分批）")
    ap.add_argument(
        "--no-create-frontmatter",
        action="store_true",
        help="缺 frontmatter 的文件不动（默认补 title+memory_layer；raw/ 永远不补）",
    )
    ap.add_argument("--print", dest="print_only", action="store_true", help="兼容 audit 脚本的语感，等同默认")
    args = ap.parse_args()

    if not Path(AUDIT_SCRIPT).is_file():
        print(f"缺少 {AUDIT_SCRIPT}（口径实现）", file=sys.stderr)
        return 2
    aml = load_audit_module()
    plan = collect(aml)

    actions = [(item["path"], item["layer"], "insert") for item in plan["fills"]]
    actions += [(item["path"], item["to"], "set") for item in plan["fixes"]]
    if args.limit:
        actions = actions[: args.limit]

    written, skipped = [], []
    for rel, layer, _kind in actions:
        try:
            text = Path(rel).read_text(encoding="utf-8")
        except OSError as e:
            skipped.append({"path": rel, "error": str(e)})
            continue
        new_text, act = rewrite_frontmatter(text, layer, rel, create=not args.no_create_frontmatter)
        if act in ("unchanged", "no_frontmatter", "raw_immutable"):
            skipped.append({"path": rel, "reason": act})
            continue
        written.append({"path": rel, "layer": layer, "action": act})
        if args.apply:
            Path(rel).write_text(new_text, encoding="utf-8")

    summary = {
        "applied": args.apply,
        "planned": {"fill_missing": len(plan["fills"]), "fix_wrong": len(plan["fixes"])},
        "changed": len(written),
        "skipped": skipped,
        "manual_review": plan["manual"],
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    verb = "已写入" if args.apply else "将写入（--apply 才真写）"
    print(f"{verb} {len(written)} 篇：补缺失 {len(plan['fills'])} / 纠错值 {len(plan['fixes'])}")
    for item in plan["fixes"][:20]:
        print(f"  fix  {item['path']}: {item['from']} → {item['to']}（{item['why']}）")
    if len(plan["fixes"]) > 20:
        print(f"  ... 另有 {len(plan['fixes']) - 20} 处纠错")
    if skipped:
        print(f"跳过 {len(skipped)} 篇（无 frontmatter 或已一致）")
    if plan["manual"]:
        print(f"\n需人工判断（路径规则够不着 / 文档化例外，未自动改）{len(plan['manual'])} 篇：")
        for item in plan["manual"][:20]:
            print(f"  {item['path']}: 现 {item['current']}，路径提示 {item['hint']}")
        if len(plan["manual"]) > 20:
            print(f"  ... 另有 {len(plan['manual']) - 20} 篇")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

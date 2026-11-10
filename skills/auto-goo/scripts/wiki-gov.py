#!/usr/bin/env python3
"""Goo-wiki 规模治理 —— **只读扫描 + 建议，绝不删除或移动任何文件**。

为什么需要
----------
wiki 已达 843 篇 / 42 个项目，进入「找不到、不敢删、越写越乱」的区间。
没有去重与过期机制，召回精度会随使用量**线性劣化** —— 这是必然，不是偶然。

设计原则（重要）
----------------
1. **零删除**：本脚本只读文件、只输出报告。任何删除/移动/合并都必须由
   人工确认后手动执行（项目规范：删文件前必须征得明确同意）。
2. **可复核**：每个"重复"结论都给出证据（相似度、共同标题、内容片段）。
3. **幂等**：重复运行输出一致（排序稳定）。
4. **够用就好**：不引入第三方依赖，不做语义向量，用可解释的启发式。

判重启发式（四类信号，加权）
----------------------------
  - 标题完全相同 / 高度相似         权重最高
  - 首段（frontmatter 后前 400 字）相同  强信号
  - 正文 shingle 重叠（3-gram 集合 Jaccard）
  - 文件名 stem 相似（仅作辅助）

用法
----
  wiki-gov.py --audit <wiki_dir>              # 全库体检（重复 + 过期标记 + 规模）
  wiki-gov.py --dupes <wiki_dir> --json       # 只输出重复候选
  wiki-gov.py --stale <wiki_dir> --days 180   # 长期未更新的笔记
  wiki-gov.py --mark-superseded <old> <new>   # **打印**建议的 frontmatter（不写文件）
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

# ── 参数 ────────────────────────────────────────────────────────────────────
DUP_THRESHOLD = 0.62        # shingle Jaccard 达到此值才报重复
TITLE_HIGH = 0.90           # 标题相似度视为「同名」
MIN_BODY_CHARS = 200        # 正文太短不参与判重（模板/占位）
SHINGLE_N = 3


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    fm: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if not line or line.startswith(" ") or line.startswith("#") or ":" not in line:
            continue
        k, _, v = line.partition(":")
        fm[k.strip()] = v.strip().strip("'\"")
    return fm, text[end + 4 :]


def norm(s: str) -> str:
    """归一化：去 markdown 语法、去空白、小写。"""
    s = re.sub(r"```.*?```", " ", s, flags=re.S)
    s = re.sub(r"`[^`]*`", " ", s)
    s = re.sub(r"\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]", r"\1", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"[#>*_\-|]+", " ", s)
    s = re.sub(r"\s+", "", s)
    return s.lower()


def shingles(s: str, n: int = SHINGLE_N) -> set[str]:
    s = norm(s)
    if len(s) <= n:
        return {s} if s else set()
    return {s[i : i + n] for i in range(len(s) - n + 1)}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def title_similarity(a: str, b: str) -> float:
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    sa, sb = shingles(na, 2), shingles(nb, 2)
    return jaccard(sa, sb)


class Doc:
    __slots__ = ("rel", "path", "title", "fm", "body", "shingle_set", "first_para", "mtime")

    def __init__(self, path: Path, wiki_root: Path) -> None:
        self.path = path
        self.rel = path.relative_to(wiki_root).as_posix()
        text = read_text(path)
        self.fm, body = split_frontmatter(text)
        self.title = self.fm.get("title") or _first_heading(body) or path.stem
        self.body = body
        self.shingle_set = shingles(body)
        paras = [p.strip() for p in re.split(r"\n\s*\n", body) if len(p.strip()) > 40]
        self.first_para = norm(paras[0])[:400] if paras else ""
        try:
            self.mtime = date.fromtimestamp(path.stat().st_mtime)
        except OSError:
            self.mtime = date.today()

    @property
    def layer(self) -> str | None:
        return self.fm.get("memory_layer") or None

    @property
    def superseded(self) -> str | None:
        return self.fm.get("superseded_by") or None

    @property
    def size(self) -> int:
        return len(self.body)


def _first_heading(body: str) -> str | None:
    for line in body.splitlines():
        if line.startswith("# "):
            return line[2:].strip() or None
    return None


def is_infra(rel: str) -> bool:
    """wiki 根目录的索引/说明文件不属于"笔记"，不参与治理。"""
    if "/" not in rel:
        return True
    parts = rel.split("/")
    return len(parts) <= 2 and parts[-1] in {
        "CLAUDE.md", "AGENTS.md", "README.md", "index.md", "log.md", "home.md",
    }


def collect(wiki_root: Path) -> list[Doc]:
    docs: list[Doc] = []
    for p in sorted(wiki_root.rglob("*.md")):
        if ".obsidian" in p.parts or ".git" in p.parts:
            continue
        rel = p.relative_to(wiki_root).as_posix()
        if is_infra(rel):
            continue
        doc = Doc(p, wiki_root)
        if doc.size < MIN_BODY_CHARS:
            continue
        docs.append(doc)
    return docs


def find_duplicates(docs: list[Doc], threshold: float = DUP_THRESHOLD) -> list[dict]:
    """返回重复候选对，按相似度降序。只输出证据，不做任何处置。"""
    pairs: list[dict] = []

    # 先用标题分桶缩小比较范围
    buckets: dict[str, list[int]] = defaultdict(list)
    for i, d in enumerate(docs):
        buckets[norm(d.title)[:24]].append(i)

    seen: set[tuple[int, int]] = set()
    def consider(i: int, j: int) -> None:
        if i == j or (i, j) in seen or (j, i) in seen:
            return
        seen.add((i, j))
        a, b = docs[i], docs[j]
        if a.superseded or b.superseded:
            return
        sim = jaccard(a.shingle_set, b.shingle_set)
        tsim = title_similarity(a.title, b.title)
        same_para = bool(a.first_para) and a.first_para == b.first_para
        # 综合分：正文为主，标题/首段为加权信号
        score = max(sim, sim * 0.6 + tsim * 0.4)
        if same_para:
            score = max(score, 0.75)
        if score >= threshold:
            pairs.append({
                "a": a.rel,
                "b": b.rel,
                "score": round(score, 3),
                "body_similarity": round(sim, 3),
                "title_similarity": round(tsim, 3),
                "same_first_paragraph": same_para,
                "size_a": a.size,
                "size_b": b.size,
                "hint": _hint(a, b, sim, tsim, same_para),
            })

    for idxs in buckets.values():
        for x in range(len(idxs)):
            for y in range(x + 1, len(idxs)):
                consider(idxs[x], idxs[y])

    pairs.sort(key=lambda p: (-p["score"], p["a"], p["b"]))
    return pairs


def _hint(a: Doc, b: Doc, sim: float, tsim: float, same_para: bool) -> str:
    if same_para and tsim > TITLE_HIGH:
        return "几乎完全重复（同标题 + 同首段）→ 建议合并，保留较新/较全的一篇"
    if same_para:
        return "首段完全相同 → 疑似复制粘贴产生，建议人工比对后合并"
    if sim > 0.85:
        return "正文高度重合 → 疑似同内容不同版本"
    if tsim > TITLE_HIGH:
        return "标题相同但内容有差异 → 可能是不同阶段的同名笔记，建议加日期前缀区分"
    return "部分重合 → 可能共享大段背景描述，人工判断是否需要抽取公共引用"


def cluster_duplicates(pairs: list[dict]) -> list[dict]:
    """把两两重复对聚成簇。

    4 个同内容文件会产生 6 对两两比较结果 —— 直接列 6 条对人有误导性
    （看起来像 6 个问题，其实是 1 个）。聚类后一眼能看出
    「这一组是同一篇的 4 个版本，保留哪一篇即可」。
    """
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for p in pairs:
        union(p["a"], p["b"])

    groups: dict[str, list[str]] = defaultdict(list)
    for path in list(parent):
        groups[find(path)].append(path)

    out: list[dict] = []
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort()
        # 组内最高相似度
        best = max(
            (p["score"] for p in pairs if p["a"] in members and p["b"] in members),
            default=0.0,
        )
        out.append({
            "members": members,
            "size": len(members),
            "max_score": round(best, 3),
            "pair_count": sum(1 for p in pairs if p["a"] in members and p["b"] in members),
        })
    out.sort(key=lambda g: (-g["size"], -g["max_score"]))
    return out


def find_stale(docs: list[Doc], days: int) -> list[dict]:
    today = date.today()
    out = []
    for d in docs:
        age = (today - d.mtime).days
        if age >= days and not d.superseded:
            out.append({"path": d.rel, "age_days": age, "mtime": d.mtime.isoformat(),
                        "layer": d.layer, "size": d.size})
    out.sort(key=lambda x: -x["age_days"])
    return out


def stale_proposal(doc_path: str, days: int) -> str:
    """打印建议的 frontmatter 变更（不写文件）。"""
    return (
        f"# 对 {doc_path} 的建议变更（需人工确认后再执行）\n"
        f"# 在 frontmatter 中追加：\n"
        f"stale_since: {date.today().isoformat()}   # 已 {days} 天未更新\n"
        f"# 或者，如果它已被新笔记取代：\n"
        f"superseded_by: <新笔记路径>\n"
    )


def summarize(docs: list[Doc]) -> dict:
    by_layer: dict[str, int] = defaultdict(int)
    by_top: dict[str, int] = defaultdict(int)
    for d in docs:
        by_layer[d.layer or "(missing)"] += 1
        parts = d.rel.split("/")
        top = "/".join(parts[:2]) if len(parts) >= 2 else parts[0]
        by_top[top] += 1
    return {
        "total_notes": len(docs),
        "total_bytes": sum(d.size for d in docs),
        "by_layer": dict(sorted(by_layer.items())),
        "by_area": dict(sorted(by_top.items(), key=lambda kv: -kv[1])[:15]),
        "marked_superseded": sum(1 for d in docs if d.superseded),
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--audit", metavar="WIKI_DIR", help="全库体检（只读）")
    g.add_argument("--dupes", metavar="WIKI_DIR", help="只输出重复候选")
    g.add_argument("--stale", metavar="WIKI_DIR", help="输出长期未更新的笔记")
    g.add_argument("--mark-superseded", nargs=2, metavar=("OLD", "NEW"),
                   help="打印建议的 frontmatter（不写文件）")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--threshold", type=float, default=DUP_THRESHOLD)
    ap.add_argument("--days", type=int, default=180)
    args = ap.parse_args()

    if args.mark_superseded:
        old, new = args.mark_superseded
        print(f"# 在 {old} 的 frontmatter 中追加（需人工确认后执行）：")
        print(f"superseded_by: {new}")
        print(f"# 注意：本脚本不会修改任何文件。")
        return 0

    wiki_root = Path((args.audit or args.dupes or args.stale)).expanduser()
    if not wiki_root.is_dir():
        print(f"不是目录: {wiki_root}", file=sys.stderr)
        return 2

    docs = collect(wiki_root)

    if args.stale:
        rows = find_stale(docs, args.days)
        if args.json:
            print(json.dumps({"days": args.days, "count": len(rows), "items": rows[:100]},
                             ensure_ascii=False, indent=2))
        else:
            print(f"超过 {args.days} 天未更新的笔记：{len(rows)} 篇\n")
            for r in rows[:40]:
                print(f"  {r['age_days']:5}天  {r['layer'] or '-':4}  {r['path']}")
            if rows:
                print()
                print(stale_proposal(rows[0]["path"], rows[0]["age_days"]))
        return 0

    dupes = find_duplicates(docs, args.threshold)

    if args.dupes:
        if args.json:
            print(json.dumps({"threshold": args.threshold, "count": len(dupes), "pairs": dupes},
                             ensure_ascii=False, indent=2))
        else:
            print(f"重复候选：{len(dupes)} 对（阈值 {args.threshold}）\n")
            for p in dupes[:30]:
                print(f"  {p['score']:.3f}  {p['a']}")
                print(f"           {p['b']}")
                print(f"           → {p['hint']}\n")
        return 0

    # --audit
    clusters = cluster_duplicates(dupes)
    report = {
        "summary": summarize(docs),
        "duplicates": {
            "threshold": args.threshold,
            "pair_count": len(dupes),
            "cluster_count": len(clusters),
            "clusters": clusters,
            "pairs": dupes[:50],
        },
        "stale": {"days": args.days, "count": len(find_stale(docs, args.days))},
        "note": "本报告只读生成，未修改任何文件。删除/合并需人工确认后手动执行。",
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    s = report["summary"]
    print(f"=== 规模 ===")
    print(f"  笔记数 {s['total_notes']}  正文字节 {s['total_bytes']:,}")
    print(f"  已标记 superseded: {s['marked_superseded']}")
    print(f"  层级分布: {s['by_layer']}")
    print(f"\n=== 重复内容 {len(clusters)} 组 / {len(dupes)} 对（阈值 {args.threshold}）===")
    for c in clusters[:8]:
        print(f"  [{c['size']} 篇，最高相似度 {c['max_score']}]")
        for m in c["members"]:
            print(f"      {m}")
        print(f"      → 建议保留其中 1 篇，其余标记 superseded_by（需人工确认）")
    if len(clusters) > 8:
        print(f"  …另有 {len(clusters) - 8} 组，用 --json 查看全部")
    print(f"\n=== 长期未更新 {report['stale']['count']} 篇（>{args.days} 天）===")
    for r in find_stale(docs, args.days)[:10]:
        print(f"  {r['age_days']:5}天  {r['path']}")
    print(f"\n{report['note']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

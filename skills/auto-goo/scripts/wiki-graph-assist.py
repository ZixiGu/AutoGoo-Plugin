#!/usr/bin/env python3
"""Build compact Goo-wiki link context and optionally update project page/log.

This helper keeps common archive graph work out of the LLM context window:
it scans only Markdown metadata/snippets, ranks related pages, prints a small
link packet for Recorder, and can maintain the project index/log links.

图结构（2026-11-16 起）：关键词打分是**种子**，不是全部。命中后沿 wikilink
扩展 1–2 跳（出链 + 入链），按距离衰减 + 出度稀释加权（``wiki_graph.py``）。
历史问题：``PageHit.links`` 抽出来后全代码零引用 —— 图被采集了、携带了、丢弃了。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

# 同目录模块：直接运行（python3 wiki-graph-assist.py）时脚本目录已是 sys.path[0]，
# 但被测试/其他脚本以包方式导入时不保证，这里显式补一次。
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import wiki_graph  # noqa: E402

DEFAULT_SEARCH_PATHS = wiki_graph.DEFAULT_SEARCH_PATHS
AUTO_RECENT_BEGIN = "<!-- AUTOGOO-PLUGIN-RECENT-BEGIN -->"
AUTO_RECENT_END = "<!-- AUTOGOO-PLUGIN-RECENT-END -->"
# 图新增页的摘要/小节只读首屏，避免为几行 snippet 翻 100KB 日志
HEAD_BYTES = 8192


@dataclass
class PageHit:
    path: Path
    rel: str
    title: str
    score: int
    headings: list[str]
    snippet: str
    memory_layer: str | None = None
    # ── 图结构（2026-11-16）：关键词分为 seed，图扩展分单独记录，便于对比与排噪 ──
    key: str = ""
    keyword_score: int = 0
    graph_boost: float = 0.0
    graph_hop: int = 0
    graph_via: str = ""
    graph_direction: str = ""

    @property
    def from_graph(self) -> bool:
        return self.keyword_score <= 0 and self.graph_boost > 0



# 未标注 memory_layer 的页面得分折扣（约一半存量笔记没填该字段，
# 直接丢弃会让召回凭空少一半；完全平等又会让层过滤失去意义）。
UNLABELED_WEIGHT = 0.8


def expand_path(value: str | None) -> Path:
    if value:
        return Path(os.path.expandvars(os.path.expanduser(value))).resolve()
    env = os.environ.get("AUTOGOO_PLUGIN_WIKI_DIR")
    if env:
        return Path(os.path.expandvars(os.path.expanduser(env))).resolve()
    return Path.home() / "workspace" / "Goo-wiki"


def words(text: str) -> set[str]:
    tokens = re.findall(r"[A-Za-z0-9_./:-]+|[\u4e00-\u9fff]{2,}", text.lower())
    stop = {"the", "and", "with", "from", "wiki", "goo", "auto", "md", "json", "path"}
    return {t.strip("./:-_") for t in tokens if len(t.strip("./:-_")) >= 2 and t not in stop}


# 以下静态解析工具统一来自 wiki_graph.py（单一实现，避免两处正则走样）
iter_markdown = wiki_graph.iter_markdown
frontmatter_field = wiki_graph.frontmatter_field
page_title = wiki_graph.page_title


def compact_snippet(text: str, query_terms: set[str], limit: int = 180) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("---")]
    for line in lines:
        low = line.lower()
        if any(term in low for term in query_terms):
            return line[:limit]
    return (lines[0] if lines else "")[:limit]


def score_page(
    rel: str, title: str, text: str, query_terms: set[str], project_slug: str | None
) -> int:
    """给页面打分。

    关键设计：**query 相关性为 0 时直接返回 0**，即使路径命中所属项目。

    历史 bug：原先 `if project_slug in low_rel: score += 12` 是**无条件加分**，
    结果 autogoo-plugin 项目的每一页都保底 12 分 —— query 填 "zzz-不存在"
    也能召回满 12 条，命中率恒为 100%。这让召回指标完全失去意义，
    也让 prompt 里塞进大量无关页面。

    项目归属是**加权信号**，不能替代相关性：只有当页面与 query 有实质匹配时，
    属于当前项目的页面才获得额外权重。
    """
    low_rel = rel.lower()
    low_title = title.lower()
    low_text = text.lower()

    relevance = 0
    for term in query_terms:
        if not term:
            continue
        if term in low_title:
            relevance += 8
        if term in low_rel:
            relevance += 5
        count = low_text.count(term)
        if count:
            relevance += min(count, 6)

    if relevance <= 0:
        # 与 query 毫无交集 → 不返回（哪怕它属于本项目）
        return 0

    # 项目归属加权：仅在已有相关性时生效，且有上限，避免喧宾夺主
    project_boost = 12 if (project_slug and project_slug.lower() in low_rel) else 0
    return relevance + project_boost


def wikilink(rel: str, title: str | None = None) -> str:
    target = rel[:-3] if rel.endswith(".md") else rel
    # No longer stripping /index — project entry is now <slug>.md
    if title:
        return f"[[{target}|{title}]]"
    return f"[[{target}]]"


def cjk_bigram_terms(text: str) -> set[str]:
    """CJK 二元组 + 英文词。

    诊断用途：现有 ``words()`` 对中文取的是**最长连续汉字串**（如
    “书单去重：同书不同版次…” → ``{"书单去重", "同书不同版次与只按题名误报"}``），
    这种 token 几乎不可能在正文里原样出现 —— 实测 22 条 query 里有 8 条
    关键词召回零命中，原因就在此处，与图无关。这里提供 bigram 口径，
    用于评测对照与图遍历的弱种子（不改变默认召回打分）。
    """
    terms: set[str] = set()
    for run in re.findall(r"[\u4e00-\u9fff]{2,}", text):
        for i in range(len(run) - 1):
            terms.add(run[i : i + 2])
    for token in re.findall(r"[A-Za-z0-9_]{3,}", text.lower()):
        terms.add(token)
    return terms


def find_related(
    wiki_dir: Path,
    query: str,
    project_slug: str | None,
    search_paths: list[str],
    limit: int,
    layers: set[str] | None = None,
    include_unlabeled: bool = True,
    min_score: int = 3,
    terms: set[str] | None = None,
) -> list[PageHit]:
    """按 query 召回页面。

    layers: 只保留这些 memory_layer（如 {"L2","L3"}）；None 表示不过滤。
    include_unlabeled: 无 memory_layer 字段的页面是否保留。
        注意默认保留 —— 存量笔记中约一半没有该字段（420/843），
        默认丢弃会让召回突然变差。
    terms: 显式指定分词结果（评测对照用），缺省按 ``words(query)``。
    """
    # ⚠ 不能把 project_slug 拼进 query_terms：
    # 那样项目内每一页的路径都含 slug，`term in low_rel` 恒真 →
    # relevance 恒 > 0 → 任何 query 都能召回满额结果。
    # 项目归属由 score_page 的 project_boost 单独处理（且仅在已有相关性时生效）。
    query_terms = terms if terms is not None else words(query)
    metas, texts, _stats = wiki_graph.scan_pages(wiki_dir, search_paths, need_text=True)
    return score_pages(
        metas,
        texts,
        query_terms,
        project_slug,
        layers=layers,
        include_unlabeled=include_unlabeled,
        min_score=min_score,
        limit=limit,
    )


def score_pages(
    metas: list,
    texts: dict[str, str],
    query_terms: set[str],
    project_slug: str | None,
    *,
    layers: set[str] | None = None,
    include_unlabeled: bool = True,
    min_score: int = 3,
    limit: int = 12,
) -> list[PageHit]:
    """给已扫描的页面打分（文本已读入，避免二次 IO）。"""
    hits: list[PageHit] = []
    for meta in metas:
        text = texts.get(meta.rel, "")
        rel = meta.rel
        title = meta.title
        layer = meta.layer
        if layers is not None:
            if layer is None:
                if not include_unlabeled:
                    continue
            elif layer not in layers:
                continue
        score = score_page(rel, title, text, query_terms, project_slug)
        # 未标注层的页面降权：存量约一半没填 memory_layer（408/832），
        # 直接丢弃会让召回凭空少一半；完全平等对待又会让层过滤失去意义。
        # 折中：保留但打 8 折 —— 标注过的优先，未标的仍有机会被召回。
        if layer is None and score > 0:
            score = max(1, int(score * UNLABELED_WEIGHT))
        # min_score 过滤掉「单词偶然命中一次」级别的噪音。
        # 实测：query "zzz-完全不存在-zzz" 仍会因某文件里恰有一个 zzz
        # 占位符而得 1 分被召回 —— 单次文本匹配不构成相关性。
        if score < min_score:
            continue
        headings = [m.group(1).strip() for m in re.finditer(r"^##\s+(.+)$", text, re.M)][:5]
        hits.append(
            PageHit(
                path=Path(rel),
                rel=rel,
                title=title,
                score=score,
                headings=headings,
                snippet=compact_snippet(text, query_terms),
                memory_layer=layer,
                key=meta.key,
                keyword_score=score,
            )
        )
    hits.sort(key=lambda hit: (-hit.score, hit.rel))
    return hits[:limit]


def scan_and_score(
    wiki_dir: Path,
    search_paths: list[str],
    query: str,
    query_terms: set[str],
    project_slug: str | None,
    *,
    layers: set[str] | None = None,
    include_unlabeled: bool = True,
    min_score: int = 3,
    limit: int = 18,
) -> tuple[list[PageHit], list]:
    """一次扫描同时产出打分结果与图元数据（避免把 800 个文件读两遍）。

    派发路径上 recall 本来就要读全部正文；建图只需要元数据。分两次扫会让
    「加图」变成「多读一遍 wiki」，那是实打实的 p95 退化。
    """
    hits: list[PageHit] = []
    metas: list = []
    for path in wiki_graph.iter_markdown(wiki_dir, search_paths):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
            stat = path.stat()
        except OSError:
            continue
        rel = path.relative_to(wiki_dir).as_posix()
        title = wiki_graph.page_title(path, text)
        layer = wiki_graph.frontmatter_field(text, "memory_layer")
        seen: dict[str, None] = {}
        occurrences = 0
        for match in wiki_graph.LINK_RE.finditer(wiki_graph.strip_code_fences(text)):
            target = match.group(1).strip()
            if target:
                occurrences += 1
                seen.setdefault(target, None)
        metas.append(
            wiki_graph.PageMeta(
                rel=rel,
                key=rel[:-3] if rel.endswith(".md") else rel,
                title=title,
                aliases=wiki_graph.frontmatter_list(text, "aliases")
                + wiki_graph.frontmatter_list(text, "alias"),
                raw_links=tuple(seen),
                layer=layer,
                mtime_ns=stat.st_mtime_ns,
                size=stat.st_size,
                link_count=occurrences,
            )
        )
        if layers is not None:
            if layer is None:
                if not include_unlabeled:
                    continue
            elif layer not in layers:
                continue
        score = score_page(rel, title, text, query_terms, project_slug)
        if layer is None and score > 0:
            score = max(1, int(score * UNLABELED_WEIGHT))
        if score < min_score:
            continue
        headings = [m.group(1).strip() for m in re.finditer(r"^##\s+(.+)$", text, re.M)][:5]
        hits.append(
            PageHit(
                path=path,
                rel=rel,
                title=title,
                score=score,
                headings=headings,
                snippet=compact_snippet(text, query_terms),
                memory_layer=layer,
                key=metas[-1].key,
                keyword_score=score,
            )
        )
    hits.sort(key=lambda hit: (-hit.score, hit.rel))
    return hits[:limit], metas


def title_bigram_seeds(
    graph: "wiki_graph.WikiGraph",
    query: str,
    min_overlap: int = 2,
    weight: float = 8.0,
) -> dict[str, float]:
    """弱种子：用标题 bigram 重叠选图遍历入口页（这些页**不会**直接进包里）。

    为什么需要：``words()`` 不切分中文（实测 22 条 query 里 8 条零命中），
    零命中就没有种子，图遍历无从起步 —— 这是「图召回在中文 query 上无效」
    的真正原因。这里用标题 bigram 重叠作入口，只用于**扩散**，分数仍由
    图遍历算，并不会把弱匹配页当成结果输出。
    """
    bigrams = cjk_bigram_terms(query)
    if not bigrams:
        return {}
    seeds: dict[str, float] = {}
    for key, node in graph.nodes.items():
        haystack = f"{node.title} {key}".lower()
        overlap = sum(1 for bg in bigrams if bg in haystack)
        if overlap >= min_overlap:
            seeds[key] = overlap * weight
    return seeds


def apply_graph_expansion(
    graph: "wiki_graph.WikiGraph",
    hits: list[PageHit],
    query_terms: set[str],
    *,
    limit: int,
    hops: int = wiki_graph.DEFAULT_HOPS,
    decay: float = wiki_graph.DEFAULT_DECAY,
    direction: str = "both",
    weight_cap: float = wiki_graph.DEFAULT_GRAPH_WEIGHT,
    seed_floor: float = wiki_graph.DEFAULT_SEED_FLOOR,
    max_added: int = 6,
    layers: set[str] | None = None,
    include_unlabeled: bool = True,
    min_score: int = 3,
    wiki_dir: Path | None = None,
    extra_seeds: dict[str, float] | None = None,
    hub_damp: float = 1.0,
    hub_min: int = 25,
) -> tuple[list[PageHit], dict]:
    """把图遍历分合并进关键词命中，返回（重排后的命中, 统计）。

    三道防线防止「链接相关 ≠ 内容相关」汚染召回：
      1. 只有**过 min_score 的命中**才能当种子（弱命中不扩散）；
      2. 图分本身也必须达到 `min_score` 才能新增页面；
      3. 图分上限 `weight_cap × 最强种子分` —— 图永远不能把强关键词命中挤下去。
    """
    if graph is None or hops <= 0:
        return hits, {"enabled": False}

    seed_scores = {hit.key: float(hit.keyword_score) for hit in hits if hit.key}
    weak_seeds = {k: v for k, v in (extra_seeds or {}).items() if k in graph.nodes}
    for key, value in weak_seeds.items():
        seed_scores.setdefault(key, value)
    boosts = graph.expand(
        seed_scores,
        hops=hops,
        decay=decay,
        direction=direction,
        seed_floor=seed_floor,
        weight_cap=weight_cap,
        max_added=max(max_added, 1) * 4,
        hub_damp=hub_damp,
        hub_min=hub_min,
    )
    by_key = {hit.key: hit for hit in hits if hit.key}
    added: list[PageHit] = []
    for key, info in boosts.items():
        node = graph.nodes.get(key)
        if node is None:
            continue
        if info.boost < min_score:
            continue
        if layers is not None:
            if node.layer is None:
                if not include_unlabeled:
                    continue
            elif node.layer not in layers:
                continue
        existing = by_key.get(key)
        if existing is not None:
            existing.graph_boost = round(info.boost, 2)
            existing.graph_hop = info.hop
            existing.graph_via = info.via
            existing.graph_direction = info.direction
            existing.score = int(round(existing.keyword_score + info.boost))
            continue
        text = ""
        path = (wiki_dir / node.rel) if wiki_dir else Path(node.rel)
        try:
            # 图新增页只需要标题/首屏/小节名，读全文件（log.md 100KB+）纯属浪费
            with path.open(encoding="utf-8", errors="ignore") as handle:
                text = handle.read(HEAD_BYTES)
        except OSError:
            text = ""
        headings = [m.group(1).strip() for m in re.finditer(r"^##\s+(.+)$", text, re.M)][:5]
        added.append(
            PageHit(
                path=path,
                rel=node.rel,
                title=node.title,
                score=int(round(info.boost)),
                headings=headings,
                snippet=compact_snippet(text, query_terms),
                memory_layer=node.layer,
                key=key,
                keyword_score=0,
                graph_boost=round(info.boost, 2),
                graph_hop=info.hop,
                graph_via=info.via,
                graph_direction=info.direction,
            )
        )

    merged = hits + added
    merged.sort(key=lambda hit: (-hit.score, -(hit.graph_boost), hit.rel))
    # 按分数合并 + 限制图新增页在包里的条数上限。
    # 历史教训：早期版本是「先取 keyword 命中再预留槽位」乙乙乙乙 —— 那会
    # 无条件挤掉关键词命中（实测 recall 从 0.484 降到 0.452），
    # 图好处没有、代价倒有。现在只有图分**真的高于**被挤掉的末尾时才能进。
    kept: list[PageHit] = []
    graph_in_packet = 0
    for hit in merged:
        if len(kept) >= limit:
            break
        if hit.from_graph:
            if graph_in_packet >= max_added:
                continue
            graph_in_packet += 1
        kept.append(hit)
    stats = {
        "enabled": True,
        "hops": hops,
        "decay": decay,
        "direction": direction,
        "seeds": len(seed_scores),
        "weak_seeds": len(weak_seeds),
        "candidates": len(boosts),
        "seed_hits": len(hits),
        "added": len(added),
        "added_in_packet": sum(1 for hit in kept if hit.from_graph),
        "graph_in_packet": graph_in_packet,
        "truncated": max(0, len(merged) - len(kept)),
        "weight_cap": weight_cap,
    }
    return kept, stats


def replace_or_append_recent(index_path: Path, task_link: str, title: str, today: str) -> bool:
    entry = f"- {today} {task_link}：{title}"
    if index_path.exists():
        text = index_path.read_text(encoding="utf-8")
    else:
        text = "# Project Index\n"

    if entry in text:
        return False

    block = f"{AUTO_RECENT_BEGIN}\n## 最近记录\n\n{entry}\n{AUTO_RECENT_END}"
    if AUTO_RECENT_BEGIN in text and AUTO_RECENT_END in text:
        pattern = re.compile(re.escape(AUTO_RECENT_BEGIN) + r".*?" + re.escape(AUTO_RECENT_END), re.S)
        old = pattern.search(text)
        if not old:
            return False
        body = old.group(0)
        lines = body.splitlines()
        insert_at = 3 if len(lines) >= 3 and lines[1].startswith("## ") else 1
        lines.insert(insert_at, entry)
        new_block = "\n".join(lines)
        new_text = pattern.sub(new_block, text, count=1)
    else:
        sep = "" if text.endswith("\n\n") else "\n\n" if text.endswith("\n") else "\n\n"
        new_text = text + sep + block + "\n"

    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(new_text, encoding="utf-8")
    return True


def preflight_git(wiki_dir: Path, timeout: int = 20) -> dict:
    """归档写盘前的跨环境 Git 前置检查（**只警告，不阻塞**）。

    为什么需要（Goo-wiki CLAUDE.md「跨环境 Git 协作」）：
      - 写入 log.md 与领域索引前应先 `git pull --rebase`，否则多机同时归档
        会产生冲突；冲突时要求手工按日期重排，**不要 `merge=union`**。
      - vault 内不得有 symlink、换行/Unicode 需归一化、运行时文件不得入库
        —— 这些由 vault 自带的 `scripts/git-env-check.sh` 检查。

    为什么只警告不阻塞：归档的价值在于「内容落盘」。因为 git 状态不干净就
    拒绝写 wiki，等于让一次失败的 rebase 把整轮任务的产出全丢掉 —— 这是更糟的
    结局。所以这里把问题**显式说出来**（recorder 会看到），由人或后续步骤处理。
    """
    result: dict = {"is_repo": False, "warnings": [], "checks": {}}
    try:
        top = subprocess.run(
            ["git", "-C", str(wiki_dir), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=timeout,
        )
        if top.returncode != 0:
            result["warnings"].append("wiki 不在 git 仓库内：多机归档无法自动同步")
            return result
        result["is_repo"] = True
        repo = Path(top.stdout.strip())

        # 1) 有冲突标记 → 必须先解决（否则写进去的内容永远不会被提交）
        unmerged = subprocess.run(
            ["git", "-C", str(repo), "diff", "--name-only", "--diff-filter=U"],
            capture_output=True, text=True, timeout=timeout,
        )
        conflicts = [l for l in unmerged.stdout.splitlines() if l.strip()]
        result["checks"]["conflicts"] = conflicts
        if conflicts:
            result["warnings"].append(
                f"仓库存在未解决的合并冲突（{len(conflicts)} 个文件）："
                + ", ".join(conflicts[:3])
                + "；CLAUDE.md 要求冲突时手工按日期重排，不要 merge=union"
            )

        # 2) 落后远端 → 提示先 pull --rebase
        behind = subprocess.run(
            ["git", "-C", str(repo), "rev-list", "--count", "HEAD..@{upstream}"],
            capture_output=True, text=True, timeout=timeout,
        )
        if behind.returncode == 0 and behind.stdout.strip().isdigit():
            n = int(behind.stdout.strip())
            result["checks"]["behind"] = n
            if n > 0:
                result["warnings"].append(
                    f"本地落后远端 {n} 个提交：写 log.md 前应先 `git pull --rebase`（CLAUDE.md 要求）"
                )

        # 3) vault 自带检查脚本
        env_check = repo / "scripts" / "git-env-check.sh"
        if env_check.exists():
            chk = subprocess.run(
                ["bash", str(env_check)],
                capture_output=True, text=True, timeout=max(timeout, 60), cwd=str(repo),
            )
            tail = (chk.stdout or "").strip().splitlines()
            summary = next((l for l in reversed(tail) if l.startswith("== 结果")), "")
            result["checks"]["git_env"] = summary or f"exit={chk.returncode}"
            if chk.returncode != 0:
                result["warnings"].append(
                    f"git-env-check.sh 失败：{summary or chk.stderr.strip()[:120]}"
                )
            elif summary:
                result["checks"]["git_env_summary"] = summary
    except (subprocess.TimeoutExpired, OSError) as e:
        result["warnings"].append(f"git 前置检查未完成：{e}")
    return result


def append_log(log_path: Path, task_link: str, title: str, project_slug: str | None, git_remote: str | None) -> bool:
    today = date.today().isoformat()
    header = f"## [{today}] auto-goo | {title}"
    text = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
    if header in text and task_link in text:
        return False
    lines = [
        header,
        "",
        f"项目页：{task_link}",
    ]
    if project_slug:
        lines.append(f"项目：`{project_slug}`")
    if git_remote:
        lines.append(f"Git: {git_remote}")
    lines.append("")
    new_text = text.rstrip() + ("\n\n" if text.strip() else "") + "\n".join(lines) + "\n"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(new_text, encoding="utf-8")
    return True


def render_markdown(
    wiki_dir: Path,
    project_slug: str | None,
    query: str,
    hits: list[PageHit],
    task_page: str | None,
    title: str,
    graph_stats: dict | None = None,
) -> str:
    out = [
        "# AutoGoo-Plugin Wiki Graph Packet",
        "",
        f"- wiki_dir: `{wiki_dir}`",
        f"- project_slug: `{project_slug or ''}`",
        f"- query: {query}",
    ]
    if task_page:
        out.append(f"- task_page: {wikilink(task_page, title)}")
    if graph_stats and graph_stats.get("enabled"):
        out.append(
            "- graph: 种子 {seeds} → 候选 {candidates}（新增 {added}，"
            "入包 {added_in_packet}）hops={hops} decay={decay} dir={direction}".format(**graph_stats)
        )
    out.extend(["", "## Suggested Links", ""])
    if not hits:
        out.append("- No related pages found in configured search paths.")
    for hit in hits:
        detail = f"score={hit.score}"
        if hit.graph_boost:
            detail += f" (kw {hit.keyword_score} + graph {hit.graph_boost:+g}, hop {hit.graph_hop})"
        elif hit.keyword_score == hit.score:
            detail += " (keyword)"
        out.append(f"- {wikilink(hit.rel, hit.title)} {detail}")
        if hit.graph_via:
            via_title = hit.graph_via
            out.append(f"  - graph: {hit.graph_direction} link via `{via_title}`")
        heads = ", ".join(hit.headings[:3])
        if heads:
            out.append(f"  - headings: {heads}")
        if hit.snippet:
            out.append(f"  - snippet: {hit.snippet}")
    out.extend(
        [
            "",
            "## Recorder Checklist",
            "",
            "- Link the task page back to the project entry page.",
            "- Link reused wiki_context/context_artifacts from the task page.",
            "- Update project index and log.md after writing the task page.",
            "- Keep only high-value semantic links; do not link every repeated word.",
        ]
    )
    return "\n".join(out) + "\n"


def _norm_scope(value: str) -> str:
    return value.strip().strip("/")


def _graph_cache_path(args) -> Path | None:
    if args.no_graph_cache:
        return None
    if args.graph_cache:
        return Path(os.path.expandvars(os.path.expanduser(args.graph_cache)))
    return wiki_graph.default_cache_path()


def load_graph(
    wiki_dir: Path,
    graph_scope: list[str],
    cache: str | None,
    no_cache: bool,
    refresh: bool,
    max_age: float = 300.0,
    metas: list | None = None,
) -> tuple["wiki_graph.WikiGraph", dict]:
    if no_cache:
        cache_path = None
    elif cache:
        cache_path = Path(os.path.expandvars(os.path.expanduser(cache)))
    else:
        cache_path = wiki_graph.default_cache_path()
    graph, stats = wiki_graph.build_graph(
        wiki_dir, graph_scope, cache_path=cache_path, refresh=refresh, max_age=max_age, metas=metas
    )
    return graph, stats.as_dict()


def _percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * q))], 1)


def _norm_key(value: str) -> str:
    key = value.strip()
    if key.endswith(".md"):
        key = key[:-3]
    return key[5:] if key.startswith("wiki/") else key


def _load_eval_queries(path: Path) -> list[dict]:
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rows.append(json.loads(line))
    return rows


EVAL_CONFIGS: tuple[tuple[str, dict], ...] = (
    ("keyword", {"use_graph": False, "token_mode": "words", "seed_mode": "hits"}),
    ("keyword-bigram", {"use_graph": False, "token_mode": "bigram", "seed_mode": "hits"}),
    ("graph-hits", {"use_graph": True, "token_mode": "words", "seed_mode": "hits"}),
    ("graph-both", {"use_graph": True, "token_mode": "words", "seed_mode": "both"}),
    # 最强关键词基线（bigram）上再叠图：图必须证明它在**已经不弱**的召回上还有增量
    ("graph-bigram", {"use_graph": True, "token_mode": "bigram", "seed_mode": "both"}),
)


def _eval_config(
    queries: list[dict],
    label: str,
    *,
    wiki_dir: Path,
    search_paths: list[str],
    graph_scope: list[str],
    layers: set[str] | None,
    include_unlabeled: bool,
    min_score: int,
    k: int,
    repeats: int,
    use_graph: bool,
    token_mode: str,
    seed_mode: str,
    hops: int,
    decay: float,
    direction: str,
    weight_cap: float,
    cache: str | None,
    no_cache: bool,
    refresh_first: bool,
    hub_damp: float = 1.0,
    hub_min: int = 25,
) -> dict:
    """跑一侧配置（纯关键词 / 关键词+图）的命中指标与耗时。"""
    times: list[float] = []
    cold_ms = 0.0
    graph = None
    scan: dict = {}
    max_added = max(2, k // 2)
    for rep in range(repeats):
        for row in queries:
            query = row["query"]
            terms = words(query) if token_mode == "words" else cjk_bigram_terms(query)
            started = time.perf_counter()
            same_scope = [_norm_scope(x) for x in graph_scope] == [
                _norm_scope(x) for x in search_paths
            ]
            if use_graph and same_scope:
                # 与生产路径一致：建图与打分共用一次扫描
                hits, metas = scan_and_score(
                    wiki_dir,
                    search_paths,
                    query,
                    terms,
                    None,
                    layers=layers,
                    include_unlabeled=include_unlabeled,
                    min_score=min_score,
                    limit=k + max_added,
                )
                graph = wiki_graph.WikiGraph(wiki_dir, metas)
                scan = {"files": len(metas), "combined_scan": True}
            else:
                if use_graph:
                    graph, scan = load_graph(
                        wiki_dir,
                        graph_scope,
                        cache,
                        no_cache,
                        refresh=refresh_first and rep == 0,
                    )
                    if rep == 0 and cold_ms == 0.0:
                        cold_ms = round((time.perf_counter() - started) * 1000, 1)
                hits = find_related(
                    wiki_dir,
                    query,
                    None,
                    search_paths,
                    k + (max_added if use_graph else 0),
                    layers=layers,
                    include_unlabeled=include_unlabeled,
                    min_score=min_score,
                    terms=terms,
                )
            if use_graph and graph is not None:
                extra_seeds: dict[str, float] = {}
                if seed_mode in ("bigram", "both"):
                    extra_seeds = title_bigram_seeds(graph, query)
                hits, _stats = apply_graph_expansion(
                    graph,
                    hits,
                    terms,
                    limit=k,
                    hops=hops,
                    decay=decay,
                    direction=direction,
                    weight_cap=weight_cap,
                    seed_floor=float(min_score),
                    max_added=max_added,
                    layers=layers,
                    include_unlabeled=include_unlabeled,
                    min_score=min_score,
                    wiki_dir=wiki_dir,
                    extra_seeds=extra_seeds,
                    hub_damp=hub_damp,
                    hub_min=hub_min,
                )
            times.append(round((time.perf_counter() - started) * 1000, 1))
            row.setdefault("runs", {}).setdefault(label, []).append(
                [_norm_key(hit.rel) for hit in hits]
            )

    total_relevant = 0
    matched_total = 0
    hits_total = 0
    misses = 0
    reciprocal = 0.0
    for row in queries:
        ranked = row["runs"][label][0]
        relevant = {_norm_key(x) for x in row["relevant"]}
        total_relevant += len(relevant)
        hit_set = set(ranked)
        matched = relevant & hit_set
        matched_total += len(matched)
        hits_total += len(ranked)
        if not matched:
            misses += 1
            continue
        for rank, key in enumerate(ranked, start=1):
            if key in relevant:
                reciprocal += 1.0 / rank
                break
    return {
        "label": label,
        "use_graph": use_graph,
        "token_mode": token_mode,
        "seed_mode": seed_mode,
        "hit_rate": round((len(queries) - misses) / len(queries), 4) if queries else 0.0,
        "recall_at_k": round(matched_total / total_relevant, 4) if total_relevant else 0.0,
        "precision_at_k": round(matched_total / hits_total, 4) if hits_total else 0.0,
        "mrr": round(reciprocal / len(queries), 4) if queries else 0.0,
        "misses": misses,
        "matched": matched_total,
        "relevant_pool": total_relevant,
        "p50_ms": _percentile(times, 0.5),
        "p95_ms": _percentile(times, 0.95),
        "max_ms": round(max(times), 1) if times else 0.0,
        "cold_build_ms": cold_ms,
        "scan": scan,
    }


def _production_recall_p95(log_path: Path) -> dict:
    """读取生产 recall.jsonl 的 p95（与派发路径同一口径，用于确认没退化）。"""
    out = {"path": str(log_path), "rows": 0}
    if not log_path.is_file():
        out["error"] = "missing"
        return out
    times: list[float] = []
    per_source: dict[str, list[float]] = {}
    for line in log_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        ms = float(row.get("ms") or 0)
        if ms <= 0:
            continue
        times.append(ms)
        per_source.setdefault(str(row.get("source") or "?"), []).append(ms)
    out["rows"] = len(times)
    out["p50_ms"] = _percentile(times, 0.5)
    out["p95_ms"] = _percentile(times, 0.95)
    out["max_ms"] = round(max(times), 1) if times else 0.0
    out["per_source"] = {k: {"rows": len(v), "p95_ms": _percentile(v, 0.95)} for k, v in per_source.items()}
    return out


def run_eval(args, wiki_dir: Path, search_paths: list[str], graph_scope: list[str], layers: set[str] | None) -> int:
    """同一批标注 query 上对比「纯关键词」与「关键词 + 图遍历」。

    为什么是五组而不是两组：实测发现 22 条 query 里 8 条**纯关键词零命中**，
    根因是 ``words()`` 不切分中文（整段汉字串当 token），不是图的问题。
    只报两组会得出「图没用」的错误结论，所以把变量拆开：

      1. keyword        —— 现状（对照组）
      2. keyword-bigram —— 换 CJK bigram 分词（诊断：证明零命中是分词问题）
      3. graph-hits     —— 图遍历，种子只来自关键词命中
      4. graph-both     —— 图遍历，种子 = 关键词命中 ∪ 标题 bigram 弱种子（默认）
      5. graph-bigram   —— 最强关键词基线上再叠图（验证图在**已经不弱**的召回上还有增量）

    指标口径（可被下次数推翻）：
      - hit_rate：至少命中一篇相关页的 query 占比
      - recall_at_k：micro 召回 = Σ命中相关页 / Σ标注相关页
      - precision_at_k：Σ命中相关页 / Σ返回条数
      - mrr：首个相关页排名倒数均值
      - p95_ms：单次召回墙钟耗时（含建图/读索引），与 recall.jsonl 同口径
    """
    queries = _load_eval_queries(Path(args.eval))
    if not queries:
        print("--eval 查询集为空", file=sys.stderr)
        return 2

    common = {
        "wiki_dir": wiki_dir,
        "search_paths": search_paths,
        "graph_scope": graph_scope,
        "layers": layers,
        "include_unlabeled": not args.exclude_unlabeled,
        "min_score": args.min_score,
        "k": args.eval_k,
        "repeats": max(1, args.eval_repeats),
        "hops": args.graph_hops,
        "decay": args.graph_decay,
        "direction": args.graph_direction,
        "weight_cap": args.graph_weight,
        "cache": args.graph_cache,
        "no_cache": args.no_graph_cache,
        "refresh_first": args.graph_refresh,
        "hub_damp": args.graph_hub_damp,
        "hub_min": args.graph_hub_min,
    }
    configs: dict[str, dict] = {}
    for label, flags in EVAL_CONFIGS:
        configs[label] = _eval_config(queries, label, **flags, **common)

    base = configs["keyword"]
    for label, cfg in configs.items():
        cfg["delta_vs_keyword"] = {
            "hit_rate": round(cfg["hit_rate"] - base["hit_rate"], 4),
            "recall_at_k": round(cfg["recall_at_k"] - base["recall_at_k"], 4),
            "precision_at_k": round(cfg["precision_at_k"] - base["precision_at_k"], 4),
            "mrr": round(cfg["mrr"] - base["mrr"], 4),
            "p95_ms": round(cfg["p95_ms"] - base["p95_ms"], 1),
        }

    per_query = []
    for row in queries:
        relevant = {_norm_key(x) for x in row["relevant"]}
        entry = {"query": row["query"], "relevant": len(relevant)}
        for label, _flags in EVAL_CONFIGS:
            runs = row.get("runs", {}).get(label) or [[]]
            entry[label] = len(relevant & set(runs[0]))
        per_query.append(entry)

    production_log = Path(args.eval_baseline_log) if args.eval_baseline_log else Path(".goo/logs/recall.jsonl")
    result = {
        "wiki_dir": str(wiki_dir),
        "queries": len(queries),
        "k": args.eval_k,
        "repeats": max(1, args.eval_repeats),
        "configs": configs,
        "production_recall": _production_recall_p95(production_log),
        "per_query": per_query,
    }

    if args.eval_json:
        out = Path(args.eval_json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.eval_log:
        log_path = Path(args.eval_log)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as handle:
            for label, cfg in configs.items():
                handle.write(
                    json.dumps(
                        {
                            "source": f"graph-eval-{label}",
                            "queries": result["queries"],
                            "k": result["k"],
                            "p50_ms": cfg["p50_ms"],
                            "p95_ms": cfg["p95_ms"],
                            "max_ms": cfg["max_ms"],
                            "hit_rate": cfg["hit_rate"],
                            "recall_at_k": cfg["recall_at_k"],
                            "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )

    print(_render_eval_markdown(result), end="")
    return 0


def _render_eval_markdown(result: dict) -> str:
    configs = result["configs"]
    labels = [label for label, _f in EVAL_CONFIGS if label in configs]
    prod = result.get("production_recall") or {}

    lines = [
        "# 召回对比：纯关键词 vs 关键词 + 图遍历",
        "",
        f"- 标注 query 数: {result['queries']}，截断深度 k={result['k']}，重复 {result['repeats']} 轮",
        f"- wiki_dir: `{result['wiki_dir']}`",
        f"- 生产 recall.jsonl（新代码上线前）: rows={prod.get('rows', 0)} "
        f"p50={prod.get('p50_ms', 0)}ms p95={prod.get('p95_ms', 0)}ms",
        "",
        "| 指标 | " + " | ".join(labels) + " |",
        "| --- | " + " | ".join("---" for _ in labels) + " |",
    ]
    for metric in ("hit_rate", "recall_at_k", "precision_at_k", "mrr", "misses", "p50_ms", "p95_ms"):
        lines.append(
            f"| {metric} | " + " | ".join(str(configs[label][metric]) for label in labels) + " |"
        )
    lines.append("")
    lines.append("| 相对 keyword 的差值 | " + " | ".join(labels) + " |")
    lines.append("| --- | " + " | ".join("---" for _ in labels) + " |")
    for metric in ("hit_rate", "recall_at_k", "precision_at_k", "mrr", "p95_ms"):
        cells = []
        for label in labels:
            value = configs[label]["delta_vs_keyword"][metric]
            cells.append(f"{value:+.4f}" if isinstance(value, float) else str(value))
        lines.append(f"| Δ{metric} | " + " | ".join(cells) + " |")

    lines.extend(["", "## 每条 query 的相关页命中数", ""])
    lines.append("| query | 标注 | " + " | ".join(labels) + " |")
    lines.append("| --- | " + " | ".join("---" for _ in range(len(labels) + 1)) + " |")
    best_label = max(labels, key=lambda x: configs[x]["recall_at_k"]) if labels else "keyword"
    for row in result["per_query"]:
        cells = [str(row.get(label, 0)) for label in labels]
        mark = " ✅" if row.get(best_label, 0) > row.get("keyword", 0) else ""
        lines.append(f"| {row['query'][:60]} | {row['relevant']} | " + " | ".join(cells) + f" |{mark}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare compact Goo-wiki graph context for AutoGoo-Plugin archive steps")
    parser.add_argument("--wiki-dir", help="Goo-wiki vault path; defaults to AUTOGOO_PLUGIN_WIKI_DIR or ~/workspace/Goo-wiki")
    parser.add_argument("--project-slug", help="Project slug under wiki/projects/")
    parser.add_argument("--project-dir", help="Project archive dir relative to wiki_dir, e.g. wiki/projects/foo")
    parser.add_argument("--query", help="Task/query text used to find related pages")
    parser.add_argument("--title", help="Human-readable task title")
    parser.add_argument("--task-page", help="Task page path relative to wiki_dir, used for index/log updates")
    parser.add_argument("--git-remote", help="Git remote URL to include in log entry")
    parser.add_argument("--search-path", action="append", help="Additional or overriding search path; can be repeated")
    parser.add_argument("--max-pages", type=int, default=12, help="Maximum related pages to return")
    parser.add_argument("--format", choices=("md", "json"), default="md")
    parser.add_argument(
        "--layer",
        action="append",
        help="Only include pages with this memory_layer (L0/L1/L2/L3); repeatable",
    )
    parser.add_argument(
        "--min-score",
        type=int,
        default=3,
        help="Drop hits scoring below this (default 3; 1 = only drop zero-relevance)",
    )
    parser.add_argument(
        "--exclude-unlabeled",
        action="store_true",
        help="When --layer is used, also drop pages that have no memory_layer field",
    )
    parser.add_argument("--update-index", action="store_true", help="Update project index recent-record marker")
    parser.add_argument("--append-log", action="store_true", help="Append a compact linked activity entry to log.md")
    parser.add_argument(
        "--preflight-json",
        action="store_true",
        help="Only run the cross-environment git preflight and print JSON (no search / no writes)",
    )

    graph_group = parser.add_argument_group("wiki graph（图遍历召回）")
    graph_group.add_argument(
        "--graph",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="关键词命中后沿 wikilink 扩展 1-2 跳（默认开；--no-graph 回到纯关键词）",
    )
    graph_group.add_argument("--graph-scope", action="append", help="建图范围，可重复；默认全库默认搜索路径")
    graph_group.add_argument("--graph-hops", type=int, default=wiki_graph.DEFAULT_HOPS)
    graph_group.add_argument("--graph-decay", type=float, default=wiki_graph.DEFAULT_DECAY)
    graph_group.add_argument(
        "--graph-direction", choices=("out", "in", "both"), default="both", help="沿出链/入链/双向扩展"
    )
    graph_group.add_argument(
        "--graph-weight",
        type=float,
        default=wiki_graph.DEFAULT_GRAPH_WEIGHT,
        help="图分上限 = graph_weight × 最强关键词分（防图反客为主）",
    )
    graph_group.add_argument(
        "--graph-max-added",
        type=int,
        default=0,
        help="图最多新增几篇（默认 max(2, max-pages/2)；0 = 自动）",
    )
    graph_group.add_argument("--graph-cache", help="索引缓存路径（默认 <cwd>/.goo/cache/wiki-graph-index.json）")
    graph_group.add_argument("--no-graph-cache", action="store_true", help="不读不写索引缓存")
    graph_group.add_argument("--graph-refresh", action="store_true", help="忽略缓存，全量重解析链接")
    graph_group.add_argument(
        "--graph-max-age",
        type=float,
        default=300.0,
        help="索引缓存可信时长秒数（默认 300；0 = 每次都 stat 全库校验，最慢但最新）",
    )
    graph_group.add_argument(
        "--graph-seed",
        choices=("hits", "bigram", "both"),
        default="both",
        help="图遍历种子来源：关键词命中 / 标题 bigram 弱种子 / 两者（默认；中文 query 零命中时的唯一入口）",
    )
    graph_group.add_argument(
        "--graph-hub-damp",
        type=float,
        default=1.0,
        help="入度枢纽抑制强度（0=关闭；防止 log.md 这类导航页出现在每份 packet）",
    )
    graph_group.add_argument(
        "--graph-hub-min",
        type=int,
        default=25,
        help="入度达到多少才算导航枢纽（默认 25 ≈ p99；只压 log/项目入口这类导航页）",
    )
    graph_group.add_argument(
        "--graph-seed-overlap",
        type=int,
        default=2,
        help="弱种子要求的标题 bigram 重叠数（默认 2；调大降噪、调小提召回）",
    )

    eval_group = parser.add_argument_group("对比评测（图 vs 纯关键词）")
    eval_group.add_argument("--eval", help="标注查询集 JSONL（{query, relevant[]}）；跑基线/图两轮对比")
    eval_group.add_argument("--eval-k", type=int, default=12, help="评测截断深度（默认 12，与 max-pages 对齐）")
    eval_group.add_argument("--eval-repeats", type=int, default=3, help="每条 query 重复次数（算 p50/p95）")
    eval_group.add_argument("--eval-log", help="把本轮耗时追加到指定 JSONL（默认不写）")
    eval_group.add_argument("--eval-json", help="把评测结果写到该 JSON 文件")
    eval_group.add_argument(
        "--eval-baseline-log",
        help="生产召回日志（默认 .goo/logs/recall.jsonl），用于对比 p95 是否退化",
    )
    args = parser.parse_args()

    wiki_dir = expand_path(args.wiki_dir)

    if args.preflight_json:
        print(json.dumps(preflight_git(wiki_dir), ensure_ascii=False, indent=2))
        return 0

    search_paths = args.search_path or list(DEFAULT_SEARCH_PATHS)
    graph_scope = args.graph_scope or list(DEFAULT_SEARCH_PATHS)
    title = args.title or (args.query.strip().splitlines()[0][:80] if args.query else "")
    layers = {x.strip().upper() for x in args.layer} if args.layer else None

    if args.eval:
        return run_eval(args, wiki_dir, search_paths, graph_scope, layers)

    if not args.query:
        parser.error("--query is required unless --eval is used")

    query_terms = words(args.query)
    max_added = args.graph_max_added or max(2, args.max_pages // 2)
    want_graph = bool(args.graph)

    # 建图与打分共用一次扫描：搜索范围与建图范围一致时不需要读两遍 wiki
    # （805 个文件 ≈ 150ms，派发路径上这是主要成本）。
    same_scope = [_norm_scope(x) for x in graph_scope] == [_norm_scope(x) for x in search_paths]
    graph = None
    scan: dict = {"enabled": False}
    if want_graph and same_scope:
        hits, metas = scan_and_score(
            wiki_dir,
            search_paths,
            args.query,
            query_terms,
            args.project_slug,
            layers=layers,
            include_unlabeled=not args.exclude_unlabeled,
            min_score=args.min_score,
            limit=args.max_pages + max_added,
        )
        graph = wiki_graph.WikiGraph(wiki_dir, metas)
        scan = {"enabled": True, "combined_scan": True, "files": len(metas)}
    else:
        hits = find_related(
            wiki_dir,
            args.query,
            args.project_slug,
            search_paths,
            args.max_pages + (max_added if want_graph else 0),
            layers=layers,
            include_unlabeled=not args.exclude_unlabeled,
            min_score=args.min_score,
            terms=query_terms,
        )
        if want_graph:
            graph, scan = load_graph(
                wiki_dir,
                graph_scope,
                args.graph_cache,
                args.no_graph_cache,
                args.graph_refresh,
                max_age=args.graph_max_age,
            )
            scan = dict(scan, combined_scan=False)

    graph_stats: dict = {"enabled": False}
    if graph is not None:
        extra_seeds: dict[str, float] = {}
        if args.graph_seed in ("bigram", "both"):
            extra_seeds = title_bigram_seeds(graph, args.query, min_overlap=args.graph_seed_overlap)
        hits, graph_stats = apply_graph_expansion(
            graph,
            hits,
            query_terms,
            limit=args.max_pages,
            hops=args.graph_hops,
            decay=args.graph_decay,
            direction=args.graph_direction,
            weight_cap=args.graph_weight,
            seed_floor=float(args.min_score),
            max_added=max_added,
            layers=layers,
            include_unlabeled=not args.exclude_unlabeled,
            min_score=args.min_score,
            wiki_dir=wiki_dir,
            extra_seeds=extra_seeds,
            hub_damp=args.graph_hub_damp,
            hub_min=args.graph_hub_min,
        )
        graph_stats["scan"] = scan

    changed: list[str] = []
    if args.update_index:
        if not args.task_page:
            raise SystemExit("--update-index requires --task-page")
        project_dir = args.project_dir or (f"wiki/projects/{args.project_slug}" if args.project_slug else None)
        if not project_dir:
            raise SystemExit("--update-index requires --project-dir or --project-slug")
        index_path = (wiki_dir / project_dir / f"{args.project_slug}.md") if args.project_slug else (wiki_dir / project_dir / "index.md")
        # Guard against path traversal
        if not index_path.resolve().is_relative_to(wiki_dir.resolve()):
            raise SystemExit("index path must stay inside wiki-dir")
        if replace_or_append_recent(index_path, wikilink(args.task_page, title), title, date.today().isoformat()):
            changed.append(index_path.relative_to(wiki_dir).as_posix())

    if args.append_log:
        if not args.task_page:
            raise SystemExit("--append-log requires --task-page")
        log_path = wiki_dir / "log.md"
        # 跨环境 Git 前置检查：只警告不阻塞（理由见 preflight_git 文档串）
        _pf = preflight_git(wiki_dir)
        for _w in _pf["warnings"]:
            print(f"::warning:: {_w}", file=sys.stderr)
        if append_log(log_path, wikilink(args.task_page, title), title, args.project_slug, args.git_remote):
            changed.append("log.md")

    if args.format == "json":
        payload = {
            "wiki_dir": str(wiki_dir),
            "project_slug": args.project_slug,
            "query": args.query,
            "task_page": args.task_page,
            "graph": graph_stats,
            "suggested_links": [
                {
                    "path": hit.rel,
                    "title": hit.title,
                    "wikilink": wikilink(hit.rel, hit.title),
                    "score": hit.score,
                    "keyword_score": hit.keyword_score,
                    "graph_boost": hit.graph_boost,
                    "graph_hop": hit.graph_hop,
                    "graph_via": hit.graph_via,
                    "graph_direction": hit.graph_direction,
                    "from_graph": hit.from_graph,
                    "headings": hit.headings,
                    "snippet": hit.snippet,
                    "memory_layer": hit.memory_layer,
                }
                for hit in hits
            ],
            "changed": changed,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(
            render_markdown(
                wiki_dir, args.project_slug, args.query, hits, args.task_page, title, graph_stats
            ),
            end="",
        )
        if changed:
            print("## Files Updated\n")
            for item in changed:
                print(f"- `{item}`")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build compact Goo-wiki link context and optionally update project page/log.

This helper keeps common archive graph work out of the LLM context window:
it scans only Markdown metadata/snippets, ranks related pages, prints a small
link packet for Recorder, and can maintain the project index/log links.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable

DEFAULT_SEARCH_PATHS = ("wiki/projects", "wiki/concepts", "wiki/questions", "journal/weekly", "log.md")
AUTO_RECENT_BEGIN = "<!-- AUTOGOO-PLUGIN-RECENT-BEGIN -->"
AUTO_RECENT_END = "<!-- AUTOGOO-PLUGIN-RECENT-END -->"


@dataclass
class PageHit:
    path: Path
    rel: str
    title: str
    score: int
    headings: list[str]
    links: list[str]
    snippet: str
    memory_layer: str | None = None


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


def iter_markdown(wiki_dir: Path, search_paths: Iterable[str]) -> Iterable[Path]:
    for item in search_paths:
        root = wiki_dir / item
        if root.is_file() and root.suffix == ".md":
            yield root
        elif root.is_dir():
            yield from root.rglob("*.md")


def frontmatter_field(text: str, key: str) -> str | None:
    """读取 frontmatter 的单个标量字段（不引入 yaml 依赖）。"""
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    fm = text[4:end]
    prefix = f"{key}:"
    for line in fm.splitlines():
        if line.startswith(prefix):
            return line.split(":", 1)[1].strip().strip("'\"") or None
    return None


def frontmatter_title(text: str) -> str | None:
    return frontmatter_field(text, "title")


def first_heading(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip() or None
    return None


def page_title(path: Path, text: str) -> str:
    return frontmatter_title(text) or first_heading(text) or path.stem


def compact_snippet(text: str, query_terms: set[str], limit: int = 180) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("---")]
    for line in lines:
        low = line.lower()
        if any(term in low for term in query_terms):
            return line[:limit]
    return (lines[0] if lines else "")[:limit]


def score_page(rel: str, title: str, text: str, query_terms: set[str], project_slug: str | None) -> int:
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


def find_related(
    wiki_dir: Path,
    query: str,
    project_slug: str | None,
    search_paths: list[str],
    limit: int,
    layers: set[str] | None = None,
    include_unlabeled: bool = True,
    min_score: int = 3,
) -> list[PageHit]:
    """按 query 召回页面。

    layers: 只保留这些 memory_layer（如 {"L2","L3"}）；None 表示不过滤。
    include_unlabeled: 无 memory_layer 字段的页面是否保留。
        注意默认保留 —— 存量笔记中约一半没有该字段（420/843），
        默认丢弃会让召回突然变差。
    """
    # ⚠ 不能把 project_slug 拼进 query_terms：
    # 那样项目内每一页的路径都含 slug，`term in low_rel` 恒真 →
    # relevance 恒 > 0 → 任何 query 都能召回满额结果。
    # 项目归属由 score_page 的 project_boost 单独处理（且仅在已有相关性时生效）。
    query_terms = words(query)
    hits: list[PageHit] = []
    for path in iter_markdown(wiki_dir, search_paths):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel = path.relative_to(wiki_dir).as_posix()
        title = page_title(path, text)
        layer = frontmatter_field(text, "memory_layer")
        if layers is not None:
            if layer is None:
                if not include_unlabeled:
                    continue
            elif layer not in layers:
                continue
        score = score_page(rel, title, text, query_terms, project_slug)
        # min_score 过滤掉「单词偶然命中一次」级别的噪音。
        # 实测：query "zzz-完全不存在-zzz" 仍会因某文件里恰有一个 zzz
        # 占位符而得 1 分被召回 —— 单次文本匹配不构成相关性。
        if score < min_score:
            continue
        headings = [m.group(1).strip() for m in re.finditer(r"^##\s+(.+)$", text, re.M)][:5]
        links = re.findall(r"\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]", text)[:8]
        hits.append(PageHit(path, rel, title, score, headings, links, compact_snippet(text, query_terms), layer))
    hits.sort(key=lambda hit: (-hit.score, hit.rel))
    return hits[:limit]


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
    out.extend(["", "## Suggested Links", ""])
    if not hits:
        out.append("- No related pages found in configured search paths.")
    for hit in hits:
        heads = ", ".join(hit.headings[:3])
        out.append(f"- {wikilink(hit.rel, hit.title)} score={hit.score}")
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare compact Goo-wiki graph context for AutoGoo-Plugin archive steps")
    parser.add_argument("--wiki-dir", help="Goo-wiki vault path; defaults to AUTOGOO_PLUGIN_WIKI_DIR or ~/workspace/Goo-wiki")
    parser.add_argument("--project-slug", help="Project slug under wiki/projects/")
    parser.add_argument("--project-dir", help="Project archive dir relative to wiki_dir, e.g. wiki/projects/foo")
    parser.add_argument("--query", required=True, help="Task/query text used to find related pages")
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
    args = parser.parse_args()

    wiki_dir = expand_path(args.wiki_dir)
    search_paths = args.search_path or list(DEFAULT_SEARCH_PATHS)
    title = args.title or args.query.strip().splitlines()[0][:80]
    layers = {x.strip().upper() for x in args.layer} if args.layer else None
    hits = find_related(
        wiki_dir,
        args.query,
        args.project_slug,
        search_paths,
        args.max_pages,
        layers=layers,
        include_unlabeled=not args.exclude_unlabeled,
        min_score=args.min_score,
    )

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
        if append_log(log_path, wikilink(args.task_page, title), title, args.project_slug, args.git_remote):
            changed.append("log.md")

    if args.format == "json":
        payload = {
            "wiki_dir": str(wiki_dir),
            "project_slug": args.project_slug,
            "query": args.query,
            "task_page": args.task_page,
            "suggested_links": [
                {
                    "path": hit.rel,
                    "title": hit.title,
                    "wikilink": wikilink(hit.rel, hit.title),
                    "score": hit.score,
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
        print(render_markdown(wiki_dir, args.project_slug, args.query, hits, args.task_page, title), end="")
        if changed:
            print("## Files Updated\n")
            for item in changed:
                print(f"- `{item}`")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

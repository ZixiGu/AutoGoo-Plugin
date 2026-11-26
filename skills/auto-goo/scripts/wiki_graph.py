#!/usr/bin/env python3
"""Goo-wiki 图结构引擎 —— 反向链接索引、图遍历召回、孤岛/枢纽检测、图形状报告。

为什么需要
----------
wiki 里已经有几千条 ``[[wikilink]]``，但召回一直是**纯关键词打分**：链接被抽取出来
装进 ``PageHit.links``，然后没有任何代码读过它（死字段）。于是这个图从未被当作图用，
也就无法回答三个最常被问的问题：

  - 谁被引用最多（枢纽）？
  - 哪些页面完全孤立（写完就没人引用，也没引用别人）？
  - 从某篇已知相关页出发，1–2 跳内还有哪些上下文？

本模块把 wikilink 建成有向图，并提供：

1. **反向链接索引**：``in_links`` / ``backlinks()``，可增量更新（见下）。
2. **图遍历召回**：``expand()`` —— 从关键词命中出发沿出链+入链扩展 1–2 跳，
   按跳数衰减 + 出度稀释加权。**衰减是必须的**：链接相关 ≠ 内容相关，
   一个 548 出链的 ``log.md`` 如果不稀释，会把整个 wiki 都拉进召回。
3. **孤岛 / 枢纽检测**：``islands()`` / ``hubs()`` —— **只报告不建议删除**
   （与 ``wiki-gov.py`` 同一零删除约定）。
4. **图形状报告**：``report()`` —— 入度/出度分布，先量后做。

只读承诺
--------
本模块**不修改、不删除、不移动 wiki 里的任何文件**。唯一的写操作是可选索引缓存
（默认 ``<项目根>/.goo/cache/wiki-graph-index.json``），位置限定在项目 ``.goo/`` 下。
缓存失效按 ``mtime_ns + size`` 判定，只重解析变化的文件（增量更新）。

链接解析
--------
实测（2026-11-16，805 篇 / 4624 条链接）链接目标有四种写法：

  - 完整相对路径：``wiki/projects/foo/lessons/bar``
  - 省略 ``wiki/`` 前缀：``projects/foo/lessons/bar``
  - 部分路径（省略项目目录）：``lessons/bar``、``tasks/2026-08-05-x/index``
  - 裸 basename / 标题：``circuit_gen``、``[[某个概念]]``
  - 带 ``|别名`` 或 ``#anchor``（抽取时已剥离）

解析优先级：精确路径 → 补/去 ``wiki/`` 前缀 → 大小写不敏感路径 → 路径后缀（部分路径）
→ basename/标题/别名
。最后一级**多候选即歧义**（``index.md`` 有 75 个、``record.md`` 70 个），此时按调用页
的目录就近择一，仍不唯一则判为 unresolved —— 宁可少一条边，也不要接错一条边。

用法（独立运行）
----------------
    wiki_graph.py --wiki-dir ~/workspace/Goo-wiki --report
    wiki_graph.py --report --json --top 20
    wiki_graph.py --backlinks wiki/projects/foo/lessons/bar --hops 2
    wiki_graph.py --related wiki/projects/foo --hops 2 --json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence

INDEX_VERSION = 1
# 记忆口径页（`<vault>/memory/`）必须在扫描范围内，否则「唯一口径出处」不会被
# 图索引、也不会进 dispatch packet —— 有文件没人读，等于不存在（实测过的失效模式）。
DEFAULT_SEARCH_PATHS = (
    "wiki/projects",
    "wiki/concepts",
    "wiki/questions",
    "journal/weekly",
    "memory",
    "log.md",
)
LINK_RE = re.compile(r"\[\[([^\]|#]*)(?:[#|][^\]]*)?\]\]")
FENCE_RE = re.compile(r"^```.*?^```", re.S | re.M)

# 图遍历默认参数。全部可通过 CLI 覆盖，默认值来自 2026-11-16 的实测调参：
#   - 2 跳：3 跳后 boost 已被衰减到噪音级别（见 artifacts/s4-graph.md 的对比数据）
#   - decay 0.5/跳：距离每远一跳权重减半，保证 1 跳邻居始终强于 2 跳
#   - graph_weight 0.6：图加成最多追平最强关键词命中的 60%，**不允许图反客为主**
DEFAULT_HOPS = 2
DEFAULT_DECAY = 0.5
DEFAULT_GRAPH_WEIGHT = 0.6
DEFAULT_SEED_FLOOR = 3.0

SUMMARY_TOP = 10


# ── 页面解析 ────────────────────────────────────────────────────────────────


@dataclass
class PageMeta:
    """一个 wiki 页面的图元数据（不含正文，便于缓存）。"""

    rel: str  # wiki-relative path with .md
    key: str  # wiki-relative path without .md（＝wikilink 目标形式）
    title: str
    aliases: tuple[str, ...]
    raw_links: tuple[str, ...]
    layer: str | None
    mtime_ns: int = 0
    size: int = 0
    # 页面内 wikilink 的**出现次数**（raw_links 已按目标去重，用于算边；这里算密度）
    link_count: int = 0

    def to_cache(self) -> dict:
        return {
            "title": self.title,
            "aliases": list(self.aliases),
            "links": list(self.raw_links),
            "link_count": self.link_count,
            "layer": self.layer,
            "mtime_ns": self.mtime_ns,
            "size": self.size,
        }


@dataclass
class ScanStats:
    files: int = 0
    parsed: int = 0
    reused: int = 0
    cache_hit: bool = False
    cache_written: bool = False
    reuse_file_list: bool = False

    def as_dict(self) -> dict:
        return {
            "files": self.files,
            "parsed": self.parsed,
            "reused": self.reused,
            "cache_hit": self.cache_hit,
            "cache_written": self.cache_written,
            "reuse_file_list": self.reuse_file_list,
        }


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def strip_code_fences(text: str) -> str:
    """去掉围栏代码块后再抽链接。

    代码块里的 ``[[example]]`` 是**示例**不是引用。实测这些示例链接会凭空
    制造边，把「谁引用谁」算错。
    """
    if "```" not in text:
        return text
    return FENCE_RE.sub("\n", text)


def split_frontmatter(text: str) -> tuple[str, str]:
    if not text.startswith("---\n"):
        return "", text
    end = text.find("\n---", 4)
    if end < 0:
        return "", text
    return text[4:end], text[end + 4 :]


def frontmatter_field(text: str, key: str) -> str | None:
    """读取 frontmatter 的单个标量字段（不引入 yaml 依赖）。"""
    fm, _ = split_frontmatter(text)
    if not fm:
        return None
    prefix = f"{key}:"
    for line in fm.splitlines():
        if line.startswith(prefix):
            return line.split(":", 1)[1].strip().strip("'\"") or None
    return None


def frontmatter_list(text: str, key: str) -> tuple[str, ...]:
    """读取 frontmatter 的列表字段：``key: [a, b]`` 或 ``key:\\n  - a`` 两种写法。"""
    fm, _ = split_frontmatter(text)
    if not fm:
        return ()
    lines = fm.splitlines()
    prefix = f"{key}:"
    for i, line in enumerate(lines):
        if not line.startswith(prefix):
            continue
        inline = line.split(":", 1)[1].strip()
        if inline.startswith("["):
            items = [x.strip().strip("'\"") for x in inline.strip("[]").split(",")]
            return tuple(x for x in items if x)
        if inline:
            return (inline.strip("'\""),)
        items: list[str] = []
        for follow in lines[i + 1 :]:
            if follow.startswith(("  - ", "- ")):
                items.append(follow.split("- ", 1)[1].strip().strip("'\""))
            elif follow.strip() == "":
                continue
            else:
                break
        return tuple(x for x in items if x)
    return ()


def first_heading(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip() or None
    return None


def page_title(path: Path, text: str) -> str:
    return frontmatter_field(text, "title") or first_heading(text) or path.stem


def extract_links(text: str) -> tuple[str, ...]:
    """按出现顺序去重抽取 wikilink 目标（已剥离 ``#anchor`` 与 ``|别名``）。"""
    seen: dict[str, None] = {}
    for match in LINK_RE.finditer(strip_code_fences(text)):
        target = match.group(1).strip()
        if target:
            seen.setdefault(target, None)
    return tuple(seen)


def count_links(text: str) -> int:
    """wikilink 出现次数（不去重）—— 用于区分「边数」与「引用密度」。"""
    return sum(1 for m in LINK_RE.finditer(strip_code_fences(text)) if m.group(1).strip())


def iter_markdown(wiki_dir: Path, search_paths: Iterable[str]) -> Iterator[Path]:
    for item in search_paths:
        root = wiki_dir / item
        if root.is_file() and root.suffix == ".md":
            yield root
        elif root.is_dir():
            yield from root.rglob("*.md")


def _parse_meta(path: Path, wiki_dir: Path, text: str) -> PageMeta:
    rel = path.relative_to(wiki_dir).as_posix()
    stat = path.stat()
    # 链接只扫一遍：去重后的目标（边）+ 出现次数（密度）
    seen: dict[str, None] = {}
    occurrences = 0
    for match in LINK_RE.finditer(strip_code_fences(text)):
        target = match.group(1).strip()
        if not target:
            continue
        occurrences += 1
        seen.setdefault(target, None)
    return PageMeta(
        rel=rel,
        key=rel[:-3] if rel.endswith(".md") else rel,
        title=page_title(path, text),
        aliases=frontmatter_list(text, "aliases") + frontmatter_list(text, "alias"),
        raw_links=tuple(seen),
        layer=frontmatter_field(text, "memory_layer"),
        mtime_ns=stat.st_mtime_ns,
        size=stat.st_size,
        link_count=occurrences,
    )


# ── 索引缓存（增量更新）────────────────────────────────────────────────────


def default_cache_path() -> Path | None:
    """缓存写到项目 ``.goo/cache/``；项目没有 ``.goo/`` 时返回 None（纯内存）。

    不往任意 cwd 里创建 ``.goo`` —— 在别人的仓库里跑一下召回不该留下目录。
    """
    env = os.environ.get("AUTOGOO_PLUGIN_GRAPH_CACHE")
    if env:
        return Path(os.path.expandvars(os.path.expanduser(env))).resolve()
    goo = Path.cwd() / ".goo"
    if goo.is_dir():
        return goo / "cache" / "wiki-graph-index.json"
    return None


def load_cache(cache_path: Path | None, wiki_dir: Path, search_paths: Sequence[str]) -> dict:
    """读索引缓存 payload；版本/位置/扫描范围不匹配时返回 {}（相当于全量重建）。"""
    if not cache_path or not cache_path.is_file():
        return {}
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if payload.get("version") != INDEX_VERSION:
        return {}
    if payload.get("wiki_dir") != str(wiki_dir):
        return {}
    if payload.get("search_paths") != list(search_paths):
        return {}
    if not isinstance(payload.get("pages"), dict):
        return {}
    return payload


def save_cache(
    cache_path: Path | None,
    wiki_dir: Path,
    search_paths: Sequence[str],
    pages: dict[str, dict],
    dirs: dict[str, int] | None = None,
) -> bool:
    if not cache_path:
        return False
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": INDEX_VERSION,
            "wiki_dir": str(wiki_dir),
            "search_paths": list(search_paths),
            "pages": pages,
            "dirs": dirs or {},
            "generated_at": time.time(),
        }
        tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        os.replace(tmp, cache_path)
        return True
    except OSError:
        # 缓存失败绝不阻塞召回（与 recall.jsonl 同一原则）
        return False


def dir_signature(wiki_dir: Path, files: Sequence[Path]) -> dict[str, int]:
    """目录级签名（mtime_ns）：用于判断「是否新增/删除了页面」。

    rglob 整个 wiki 要 ~35ms（805 文件），而 step 派发时往往只扫很小的子目录。
    有了目录签名，无结构变化时直接复用缓存里的文件列表，只做 stat。
    """
    sig: dict[str, int] = {}
    for directory in {p.parent for p in files}:
        try:
            sig[directory.relative_to(wiki_dir).as_posix()] = directory.stat().st_mtime_ns
        except OSError:
            continue
    return sig


def dirs_unchanged(wiki_dir: Path, sig: dict[str, int]) -> bool:
    if not sig:
        return False
    for rel, mtime in sig.items():
        try:
            if (wiki_dir / rel).stat().st_mtime_ns != mtime:
                return False
        except OSError:
            return False
    return True


def _metas_from_cache(cached_pages: dict[str, dict]) -> list[PageMeta]:
    metas: list[PageMeta] = []
    for rel in sorted(cached_pages):
        entry = cached_pages[rel]
        key = rel[:-3] if rel.endswith(".md") else rel
        metas.append(
            PageMeta(
                rel=rel,
                key=key,
                title=entry.get("title") or Path(rel).stem,
                aliases=tuple(entry.get("aliases") or ()),
                raw_links=tuple(entry.get("links") or ()),
                layer=entry.get("layer"),
                mtime_ns=int(entry.get("mtime_ns") or 0),
                size=int(entry.get("size") or 0),
                link_count=int(entry.get("link_count") or len(entry.get("links") or ())),
            )
        )
    return metas


def scan_pages(
    wiki_dir: Path,
    search_paths: Sequence[str],
    cache_path: Path | None = None,
    need_text: bool = False,
    refresh: bool = False,
    max_age: float = 0.0,
) -> tuple[list[PageMeta], dict[str, str], ScanStats]:
    """扫描 wiki 页面元数据（可选同时取正文）。

    ``need_text=True`` 时返回 ``rel -> text``，此时**总是重解析**（要打分必须读正文），
    缓存只用于 ``need_text=False`` 的纯图查询/报告路径。返回值第二项在
    ``need_text=False`` 时为空字典。

    增量更新：目录签名未变→直接复用缓存的文件列表（省 rglob）；文件
    ``mtime_ns+size`` 未变→直接复用解析结果（省读文件 + 正则）。
    """
    stats = ScanStats()
    payload = {} if refresh else load_cache(cache_path, wiki_dir, search_paths)
    cached_pages = payload.get("pages") or {}
    cached_dirs = payload.get("dirs") or {}
    stats.cache_hit = bool(cached_pages)

    # 热路径：索引足够新（默认 300s）时直接信任缓存，连 800 次 stat 都省掉。
    # 派发路径每次都是新进程，图索引必须便宜到可以被忽略（实测 32ms → 12ms）。
    # 代价：TTL 内新增/修改的页面不会影响**图结构**（正文打分仍走实时扫描）。
    if cached_pages and not need_text and max_age > 0:
        age = time.time() - float(payload.get("generated_at") or 0)
        if 0 <= age <= max_age:
            stats.files = len(cached_pages)
            stats.reused = len(cached_pages)
            stats.reuse_file_list = True
            return _metas_from_cache(cached_pages), {}, stats

    if cached_pages and not need_text and dirs_unchanged(wiki_dir, cached_dirs):
        files = [wiki_dir / rel for rel in sorted(cached_pages)]
        stats.reuse_file_list = True
    else:
        files = sorted({p.resolve() for p in iter_markdown(wiki_dir, search_paths)})
    stats.files = len(files)

    metas: list[PageMeta] = []
    texts: dict[str, str] = {}
    fresh_cache: dict[str, dict] = {}

    for path in files:
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.relative_to(wiki_dir).as_posix()
        entry = cached_pages.get(rel)
        unchanged = (
            entry is not None
            and entry.get("mtime_ns") == st.st_mtime_ns
            and entry.get("size") == st.st_size
        )
        if unchanged and not need_text:
            key = rel[:-3] if rel.endswith(".md") else rel
            metas.append(
                PageMeta(
                    rel=rel,
                    key=key,
                    title=entry.get("title") or path.stem,
                    aliases=tuple(entry.get("aliases") or ()),
                    raw_links=tuple(entry.get("links") or ()),
                    layer=entry.get("layer"),
                    mtime_ns=st.st_mtime_ns,
                    size=st.st_size,
                    link_count=int(entry.get("link_count") or len(entry.get("links") or ())),
                )
            )
            fresh_cache[rel] = entry
            stats.reused += 1
            continue
        text = read_text(path)
        meta = _parse_meta(path, wiki_dir, text)
        metas.append(meta)
        fresh_cache[rel] = meta.to_cache()
        stats.parsed += 1
        if need_text:
            texts[rel] = text

    if cache_path and (stats.parsed or len(fresh_cache) != len(cached_pages)):
        stats.cache_written = save_cache(
            cache_path, wiki_dir, search_paths, fresh_cache, dir_signature(wiki_dir, files)
        )
    return metas, texts, stats


# ── 链接解析 ────────────────────────────────────────────────────────────────


def normalize_target(raw: str) -> str:
    target = raw.strip()
    target = target.split("|")[0].split("#")[0].strip()
    while target.startswith("./"):
        target = target[2:]
    target = target.lstrip("/")
    if target.endswith(".md"):
        target = target[:-3]
    return target.rstrip("/")


def _path_variants(key: str) -> tuple[str, str]:
    """返回 (去掉 wiki/ 前缀, 补上 wiki/ 前缀)。"""
    if key.startswith("wiki/"):
        return key[5:], key
    return key, f"wiki/{key}"


@dataclass
class ResolveStats:
    exact: int = 0
    prefixed: int = 0
    ci_exact: int = 0
    suffix: int = 0
    alias: int = 0
    ambiguous: int = 0
    unresolved: int = 0
    empty: int = 0

    @property
    def total(self) -> int:
        return (
            self.exact
            + self.prefixed
            + self.ci_exact
            + self.suffix
            + self.alias
            + self.ambiguous
            + self.unresolved
            + self.empty
        )

    @property
    def resolved(self) -> int:
        return self.exact + self.prefixed + self.ci_exact + self.suffix + self.alias

    def as_dict(self) -> dict[str, int]:
        return {
            "exact": self.exact,
            "prefixed": self.prefixed,
            "ci_exact": self.ci_exact,
            "suffix": self.suffix,
            "alias": self.alias,
            "ambiguous": self.ambiguous,
            "unresolved": self.unresolved,
            "empty": self.empty,
            "resolved": self.resolved,
            "total": self.total,
        }


# ── 图 ──────────────────────────────────────────────────────────────────────


@dataclass
class GraphBoost:
    """一条图遍历结果：加权值、跳数、经由节点、方向。"""

    boost: float
    hop: int
    via: str
    direction: str  # "out" | "in"

    def as_dict(self) -> dict:
        return {"boost": round(self.boost, 3), "hop": self.hop, "via": self.via, "direction": self.direction}


class WikiGraph:
    """wikilink 有向图：反向链接索引 + 遍历扩展 + 图形状统计。"""

    def __init__(self, wiki_dir: Path, pages: Sequence[PageMeta]):
        self.wiki_dir = wiki_dir
        self.nodes: dict[str, PageMeta] = {p.key: p for p in pages}
        self.resolve_stats = ResolveStats()
        self._alias: dict[str, set[str]] = defaultdict(set)
        self._lower_exact: dict[str, str] = {}
        # 路径后缀索引：``lessons/foo`` → 所有以该后缀结尾的 key
        self._suffix: dict[str, set[str]] = defaultdict(set)
        self._out: dict[str, tuple[str, ...]] = {}
        self._in: dict[str, list[str]] = defaultdict(list)
        self._build()

    # -- 构建 --------------------------------------------------------------

    def _register_alias(self, alias: str, key: str) -> None:
        alias = alias.strip()
        if len(alias) < 2:
            return
        self._alias[alias.lower()].add(key)
        for variant in _path_variants(alias.lower()):
            self._alias[variant].add(key)

    def _register_suffixes(self, key: str) -> None:
        """把 key 的每一段路径后缀登记进索引：``a/b/c`` → ``a/b/c``、``b/c``、``c``。

        实测真实 wiki 有 116 条链接写成**部分路径**（``[[lessons/xpu-vllm-deploy]]``，
        省略项目目录）。此前这类链接全部落到 unresolved，等于把项目入口页连到
        自己子页的边全丢了。
        """
        parts = key.split("/")
        for i in range(len(parts)):
            self._suffix["/".join(parts[i:]).lower()].add(key)

    def _build(self) -> None:
        for key, node in self.nodes.items():
            self._lower_exact[key.lower()] = key
            self._lower_exact[_path_variants(key.lower())[0]] = key
            self._register_suffixes(key)
            self._register_alias(key.rsplit("/", 1)[-1], key)
            self._register_alias(node.title, key)
            for alias in node.aliases:
                self._register_alias(alias, key)

        for key, node in self.nodes.items():
            resolved: dict[str, None] = {}
            for raw in node.raw_links:
                target, _how = self.resolve(raw, source=key)
                if target is None or target == key:
                    continue
                resolved.setdefault(target, None)
            self._out[key] = tuple(sorted(resolved))

        for key, targets in self._out.items():
            for target in targets:
                self._in[target].append(key)
        for key in self._in:
            self._in[key] = sorted(self._in[key])

    # -- 解析 --------------------------------------------------------------

    def resolve(self, raw: str, source: str | None = None) -> tuple[str | None, str]:
        """把一个 wikilink 目标解析成图节点 key。返回 (key, 方式)。"""
        target = normalize_target(raw)
        if not target:
            self.resolve_stats.empty += 1
            return None, "empty"
        if target in self.nodes:
            self.resolve_stats.exact += 1
            return target, "exact"
        for variant in _path_variants(target):
            if variant in self.nodes:
                self.resolve_stats.prefixed += 1
                return variant, "prefixed"
        lower = target.lower()
        if lower in self._lower_exact:
            self.resolve_stats.ci_exact += 1
            return self._lower_exact[lower], "ci-exact"
        # 部分路径（后缀）匹配：``lessons/foo`` 能接上 ``wiki/projects/x/lessons/foo``。
        # 后缀匹配比 basename 别名更精确（要求整段路径吻合），所以排在别名之前。
        suffix_candidates = self._suffix.get(lower)
        if suffix_candidates:
            chosen = self._pick_qualified(suffix_candidates, source)
            if chosen:
                self.resolve_stats.suffix += 1
                return chosen, "suffix"
            self.resolve_stats.ambiguous += 1
            return None, "ambiguous"
        candidates = self._alias.get(lower)
        if candidates:
            chosen = self._pick_qualified(candidates, source)
            if chosen:
                self.resolve_stats.alias += 1
                return chosen, "alias"
            self.resolve_stats.ambiguous += 1
            return None, "ambiguous"
        self.resolve_stats.unresolved += 1
        return None, "unresolved"

    def _pick_qualified(self, candidates: Iterable[str], source: str | None) -> str | None:
        """单候选直接接受；多候选取与来源页最同目录的一个，仍并列则放弃。"""
        pool = sorted(set(candidates))
        if not pool:
            return None
        if len(pool) == 1:
            return pool[0]
        return self._pick_by_context(pool, source)

    @staticmethod
    def _pick_by_context(candidates: Iterable[str], source: str | None) -> str | None:
        """歧义候选按「与来源页同目录」就近择一；仍不唯一则放弃（宁缺勿错）。"""
        if not source:
            return None
        source_parts = source.split("/")[:-1]
        best: str | None = None
        best_depth = -1
        tie = False
        for candidate in candidates:
            parts = candidate.split("/")[:-1]
            depth = 0
            for a, b in zip(source_parts, parts):
                if a != b:
                    break
                depth += 1
            if depth > best_depth:
                best, best_depth, tie = candidate, depth, False
            elif depth == best_depth:
                tie = True
        if best is None or best_depth <= 0 or tie:
            return None
        return best

    def key_for_path(self, value: str) -> str | None:
        """把用户给的路径（可带 .md / 可省略 wiki/）解析成节点 key。"""
        target = normalize_target(value)
        if target in self.nodes:
            return target
        hit, _how = self.resolve(value)
        return hit

    # -- 索引访问 ----------------------------------------------------------

    def out_links(self, key: str) -> tuple[str, ...]:
        return self._out.get(key, ())

    def in_links(self, key: str) -> list[str]:
        return list(self._in.get(key, ()))

    def degrees(self) -> tuple[dict[str, int], dict[str, int]]:
        indeg = {key: len(self._in.get(key, ())) for key in self.nodes}
        outdeg = {key: len(self._out.get(key, ())) for key in self.nodes}
        return indeg, outdeg

    def backlinks(self, key: str, hops: int = 1) -> dict[str, int]:
        """反向链接（谁引用了我）。返回 ``key -> 距离(1..hops)``。"""
        return self._bfs(key, hops, direction="in")

    def related(self, key: str, hops: int = 1) -> dict[str, int]:
        """双向邻域（出链 + 入链），返回 ``key -> 距离``。"""
        return self._bfs(key, hops, direction="both")

    def _bfs(self, key: str, hops: int, direction: str) -> dict[str, int]:
        if key not in self.nodes:
            return {}
        seen = {key: 0}
        queue: deque[tuple[str, int]] = deque([(key, 0)])
        while queue:
            current, depth = queue.popleft()
            if depth >= hops:
                continue
            for neighbour in self._neighbours(current, direction):
                if neighbour in seen:
                    continue
                seen[neighbour] = depth + 1
                queue.append((neighbour, depth + 1))
        seen.pop(key, None)
        return seen

    def _neighbours(self, key: str, direction: str) -> tuple[str, ...]:
        if direction == "out":
            return self._out.get(key, ())
        if direction == "in":
            return tuple(self._in.get(key, ()))
        merged = dict.fromkeys(self._out.get(key, ()))
        merged.update(dict.fromkeys(self._in.get(key, ())))
        merged.pop(key, None)
        return tuple(merged)

    # -- 图遍历召回 --------------------------------------------------------

    def expand(
        self,
        seed_scores: dict[str, float],
        hops: int = DEFAULT_HOPS,
        decay: float = DEFAULT_DECAY,
        direction: str = "both",
        seed_floor: float = DEFAULT_SEED_FLOOR,
        weight_cap: float = DEFAULT_GRAPH_WEIGHT,
        max_added: int | None = None,
        hub_damp: float = 1.0,
        hub_min: int = 10,
    ) -> dict[str, GraphBoost]:
        """从关键词命中出发沿 wikilink 扩展，返回 ``key -> GraphBoost``。

        权重公式（每一跳）：``贡献 = 上跳分值 × decay^hop × 1/sqrt(邻居数)``。

        - ``decay`` 让 1 跳强于 2 跳（距离衰减）；
        - ``1/sqrt(邻居数)`` 是**出度稀释**：``log.md`` 有 548 条出链，不稀释就等于
          「谁引用 log.md，谁就与整个 wiki 相关」—— 这是链接相关的典型噪音；
        - ``1/sqrt(1+入度)`` 是**入度稀释（hub damping）**，只对入度 ≥ ``hub_min`` 的
          导航型枢纽生效：``log.md``（43 入链 / 548 出链）不抑制就会出现在**每一份**
          packet 里（所有页面都链接它）。普通页面（90% 入度 < 10）不受影响。
        - ``weight_cap`` 把图加成限制为最强种子分的比例，保证**图不会把纯关键词强命中挤掉**；
        - 种子只取 ``seed_floor`` 以上的命中，避免弱命中把小半个图拉进来。
        """
        seeds = {k: float(v) for k, v in seed_scores.items() if k in self.nodes and v > 0}
        if seed_floor and seed_floor > 0:
            seeds = {k: v for k, v in seeds.items() if v >= seed_floor}
        if not seeds or hops <= 0:
            return {}

        top_seed = max(seeds.values())
        cap = top_seed * weight_cap
        best: dict[str, GraphBoost] = {}
        frontier = dict(seeds)
        visited = set(seeds)

        for hop in range(1, hops + 1):
            nxt: dict[str, tuple[float, str, str]] = {}
            for source, score in frontier.items():
                neighbours = self._neighbours(source, direction)
                if not neighbours:
                    continue
                dilution = 1.0 / math.sqrt(len(neighbours))
                step = score * (decay**hop) * dilution
                for neighbour in neighbours:
                    if neighbour in seeds:
                        continue
                    value = step
                    if hub_damp > 0:
                        indeg = len(self._in.get(neighbour, ()))
                        if indeg >= hub_min:
                            value = step / math.sqrt(1.0 + hub_damp * indeg)
                    current = nxt.get(neighbour)
                    if current is None or value > current[0]:
                        direction_of = "in" if neighbour in self._in.get(source, ()) else "out"
                        nxt[neighbour] = (value, source, direction_of)
            if not nxt:
                break
            for key, (value, via, dirn) in nxt.items():
                if value > cap:
                    value = cap
                previous = best.get(key)
                if previous is None or value > previous.boost:
                    best[key] = GraphBoost(boost=value, hop=hop, via=via, direction=dirn)
                visited.add(key)
            frontier = {k: v[0] for k, v in nxt.items()}
            if len(best) > (max_added or 10**9) * 20:
                # 极端稠密图保护：候选太多时只保留当前最强的一批继续扩散
                frontier = dict(sorted(frontier.items(), key=lambda kv: -kv[1])[: max_added or 200])

        if max_added is not None and max_added > 0 and len(best) > max_added:
            kept = sorted(best.items(), key=lambda kv: (-kv[1].boost, kv[0]))[:max_added]
            best = dict(kept)
        return best

    # -- 结构统计 ----------------------------------------------------------

    def islands(self) -> list[str]:
        """完全孤立：无入链且无出链。**只报告，不建议删除。**"""
        indeg, outdeg = self.degrees()
        return sorted(k for k in self.nodes if indeg[k] == 0 and outdeg[k] == 0)

    def zero_inbound(self) -> list[str]:
        indeg, _ = self.degrees()
        return sorted(k for k in self.nodes if indeg[k] == 0)

    def dangling(self) -> list[str]:
        """有入链但自己没有出链（引用收口点）。"""
        indeg, outdeg = self.degrees()
        return sorted(k for k in self.nodes if indeg[k] > 0 and outdeg[k] == 0)

    def sources(self) -> list[str]:
        """有出链但无人引用。"""
        indeg, outdeg = self.degrees()
        return sorted(k for k in self.nodes if indeg[k] == 0 and outdeg[k] > 0)

    def hubs(self, top: int = SUMMARY_TOP) -> list[tuple[str, int]]:
        indeg, _ = self.degrees()
        ranked = sorted(indeg.items(), key=lambda kv: (-kv[1], kv[0]))
        return [(k, v) for k, v in ranked if v > 0][:top]

    def components(self) -> list[int]:
        seen: set[str] = set()
        sizes: list[int] = []
        for start in self.nodes:
            if start in seen:
                continue
            seen.add(start)
            stack = [start]
            size = 0
            while stack:
                current = stack.pop()
                size += 1
                for neighbour in self._neighbours(current, "both"):
                    if neighbour not in seen:
                        seen.add(neighbour)
                        stack.append(neighbour)
            sizes.append(size)
        return sorted(sizes, reverse=True)

    def report(self, top: int = SUMMARY_TOP) -> dict:
        indeg, outdeg = self.degrees()
        nodes = len(self.nodes)
        edges = sum(outdeg.values())
        in_values = sorted(indeg.values())
        out_values = sorted(outdeg.values())
        comps = self.components()
        linked = sum(1 for k in self.nodes if indeg[k] > 0 or outdeg[k] > 0)
        ratio = (linked / nodes) if nodes else 0.0
        return {
            "wiki_dir": str(self.wiki_dir),
            "nodes": nodes,
            "edges": edges,
            "density": round(edges / (nodes * (nodes - 1)), 6) if nodes > 1 else 0.0,
            "link_occurrences": sum(n.link_count for n in self.nodes.values()),
            "unique_link_targets": len({raw for n in self.nodes.values() for raw in n.raw_links}),
            "resolution": self.resolve_stats.as_dict(),
            "components": len(comps),
            "largest_component": comps[0] if comps else 0,
            "largest_component_ratio": round(comps[0] / nodes, 4) if comps and nodes else 0.0,
            "in_degree": _degree_summary(in_values),
            "out_degree": _degree_summary(out_values),
            "zero_inbound": len(self.zero_inbound()),
            "islands": len(self.islands()),
            "dangling": len(self.dangling()),
            "sources": len(self.sources()),
            "top_cited": [{"key": k, "in_degree": v, "title": self.nodes[k].title} for k, v in self.hubs(top)],
            "island_samples": self.islands()[:top],
            "linked_ratio": round(ratio, 4),
            "verdict": _verdict(ratio, edges),
        }


def _degree_summary(values: Sequence[int]) -> dict[str, float | int]:
    if not values:
        return {"p50": 0, "p90": 0, "p99": 0, "max": 0, "mean": 0.0}
    n = len(values)

    def pick(q: float) -> int:
        return values[min(n - 1, int(n * q))]

    return {
        "p50": pick(0.50),
        "p90": pick(0.90),
        "p99": pick(0.99),
        "max": values[-1],
        "mean": round(sum(values) / n, 2),
    }


def _verdict(linked_ratio: float, edges: int) -> str:
    """图形状是否值得继续做图召回 —— 先量后做，结论必须可被数据推翻。"""
    if edges == 0:
        return "图无可用边：先修链接解析，不要谈图召回"
    if linked_ratio >= 0.6:
        return "值得：多数页面在图上，图遍历能带来关键词打不出的上下文"
    if linked_ratio >= 0.4:
        return "有条件值得：连通度中等，图召回只能作为补充信号（不可替代关键词）"
    return "暂缓：大量页面孤立，图遍历收益低于关键词召回，先把链接补上"


def render_report_markdown(report: dict, top: int = SUMMARY_TOP) -> str:
    res = report["resolution"]
    lines = [
        "# Goo-wiki 图形状报告",
        "",
        f"- wiki_dir: `{report['wiki_dir']}`",
        f"- 页面（节点）: **{report['nodes']}**",
        f"- 已解析边: **{report['edges']}**（密度 {report['density']}）",
        f"- wikilink 出现次数: {report['link_occurrences']}（唯一目标 {report['unique_link_targets']}）",
        f"- 解析方式: 精确 {res['exact']} / 补前缀 {res['prefixed']} / 大小写 {res['ci_exact']} / "
        f"后缀 {res['suffix']} / 别名 {res['alias']} / 歧义 {res['ambiguous']} / "
        f"未解析 {res['unresolved']}",
        f"- 连通分量: {report['components']}（最大分量 {report['largest_component']}，"
        f"占 {report['largest_component_ratio']:.0%}）",
        f"- 有边的页面占比: {report['linked_ratio']:.0%}",
        "",
        "## 度分布",
        "",
        "| 方向 | p50 | p90 | p99 | max | mean |",
        "| --- | --- | --- | --- | --- | --- |",
        f"| 入度 | {report['in_degree']['p50']} | {report['in_degree']['p90']} | "
        f"{report['in_degree']['p99']} | {report['in_degree']['max']} | {report['in_degree']['mean']} |",
        f"| 出度 | {report['out_degree']['p50']} | {report['out_degree']['p90']} | "
        f"{report['out_degree']['p99']} | {report['out_degree']['max']} | {report['out_degree']['mean']} |",
        "",
        "## 被引用最多（枢纽）",
        "",
    ]
    if report["top_cited"]:
        for item in report["top_cited"]:
            lines.append(f"- `{item['key']}` ← **{item['in_degree']}** 条入链（{item['title']}）")
    else:
        lines.append("- 无入链")

    lines.extend(
        [
            "",
            "## 孤立页面（只报告，不建议删除）",
            "",
            f"- 完全孤立（无入链无出链）: **{report['islands']}**",
            f"- 零入链: **{report['zero_inbound']}**",
            f"- 只入不出（dangling）: **{report['dangling']}**",
            f"- 只出不入（source）: **{report['sources']}**",
        ]
    )
    for key in report["island_samples"]:
        lines.append(f"  - `{key}`")
    lines.extend(["", "## 判断", "", f"- {report['verdict']}", ""])
    return "\n".join(lines)


def build_graph(
    wiki_dir: Path,
    search_paths: Sequence[str] = DEFAULT_SEARCH_PATHS,
    cache_path: Path | None = None,
    refresh: bool = False,
    max_age: float = 0.0,
    metas: Sequence[PageMeta] | None = None,
) -> tuple[WikiGraph, ScanStats]:
    """建图。传入 metas 时直接复用（调用方已经扫过同一批页面，避免二次 IO）。"""
    if metas is not None:
        return WikiGraph(wiki_dir, list(metas)), ScanStats(files=len(metas), reuse_file_list=True)
    found, _texts, stats = scan_pages(
        wiki_dir,
        search_paths,
        cache_path=cache_path,
        need_text=False,
        refresh=refresh,
        max_age=max_age,
    )
    return WikiGraph(wiki_dir, found), stats


# ── CLI ─────────────────────────────────────────────────────────────────────


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Goo-wiki 图结构：反向链接索引 / 图遍历召回 / 孤岛检测 / 形状报告（只读）"
    )
    parser.add_argument("--wiki-dir", help="wiki 根目录；默认 $AUTOGOO_PLUGIN_WIKI_DIR 或 ~/workspace/Goo-wiki")
    parser.add_argument("--search-path", action="append", help="扫描范围，可重复；默认 wiki/projects 等")
    parser.add_argument("--cache", help="索引缓存路径（默认 <cwd>/.goo/cache/wiki-graph-index.json）")
    parser.add_argument("--no-cache", action="store_true", help="不读不写索引缓存（纯内存）")
    parser.add_argument("--refresh", action="store_true", help="忽略缓存内容，全量重解析")
    parser.add_argument("--report", action="store_true", help="输出图形状报告（默认动作）")
    parser.add_argument("--json", action="store_true", help="报告/查询以 JSON 输出")
    parser.add_argument("--top", type=int, default=SUMMARY_TOP, help="报告中展示的条目数（默认 10）")
    parser.add_argument("--backlinks", help="列出引用该页面的页面（可带 .md / 可省略 wiki/）")
    parser.add_argument("--related", help="列出该页面双向 1..N 跳邻域")
    parser.add_argument("--hops", type=int, default=1, help="--backlinks/--related 的跳数（默认 1）")
    args = parser.parse_args(argv)

    wiki_dir = Path(
        os.path.expandvars(os.path.expanduser(args.wiki_dir or os.environ.get("AUTOGOO_PLUGIN_WIKI_DIR") or ""))
    ) if (args.wiki_dir or os.environ.get("AUTOGOO_PLUGIN_WIKI_DIR")) else Path.home() / "workspace" / "Goo-wiki"
    wiki_dir = wiki_dir.resolve()
    if not wiki_dir.is_dir():
        print(f"wiki-dir 不存在: {wiki_dir}", file=sys.stderr)
        return 2

    search_paths = list(args.search_path or DEFAULT_SEARCH_PATHS)
    cache_path = None if args.no_cache else (Path(args.cache).expanduser() if args.cache else default_cache_path())
    graph, stats = build_graph(wiki_dir, search_paths, cache_path=cache_path, refresh=args.refresh)

    if args.backlinks:
        key = graph.key_for_path(args.backlinks)
        if not key:
            print(f"无法解析页面: {args.backlinks}", file=sys.stderr)
            return 2
        hits = graph.backlinks(key, hops=max(1, args.hops))
        if args.json:
            print(json.dumps({"key": key, "backlinks": hits, "scan": stats.as_dict()}, ensure_ascii=False, indent=2))
        else:
            print(f"# 反向链接: `{key}`（{len(hits)} 条，{args.hops} 跳内）")
            for target, depth in sorted(hits.items(), key=lambda kv: (kv[1], kv[0])):
                print(f"- {'  ' * (depth - 1)}`{target}` (hop {depth})")
        return 0

    if args.related:
        key = graph.key_for_path(args.related)
        if not key:
            print(f"无法解析页面: {args.related}", file=sys.stderr)
            return 2
        hits = graph.related(key, hops=max(1, args.hops))
        if args.json:
            print(json.dumps({"key": key, "related": hits, "scan": stats.as_dict()}, ensure_ascii=False, indent=2))
        else:
            print(f"# 相关上下文: `{key}`（{len(hits)} 个，{args.hops} 跳内）")
            for target, depth in sorted(hits.items(), key=lambda kv: (kv[1], kv[0])):
                print(f"- {'  ' * (depth - 1)}`{target}` (hop {depth})")
        return 0

    report = graph.report(top=args.top)
    report["scan"] = stats.as_dict()
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(render_report_markdown(report, top=args.top), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

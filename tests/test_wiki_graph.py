"""wiki 图结构（反向链接 / 图遍历召回 / 孤岛检测）的回归测试。

覆盖 2026-11-16 实测暴露的缺口（见 artifacts/s4-graph.md）：

1. **图存在但从未被当图用**：``PageHit.links`` 被抽取、携带、丢弃。
   现在链接要真的解析成边，并且 ``PageHit`` 里不再有那个死字段。
2. **链接相关 ≠ 内容相关**：纯遍历会把 ``log.md``（548 出链 / 43 入链）
   拉进每一份 packet，所以遍历必须做出度稀释 + 枢纽抑制。
3. **零删除**：孤岛检测只报告，不删不改；所有写操作只能落在项目 ``.goo/`` 缓存。
4. **增量索引**：未变化的文件必须复用解析结果（否则召回 p95 会退化）。

测试全部在 tmp_path 里造 wiki，不碰真实 vault。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/auto-goo/scripts"
GRAPH_CLI = SCRIPTS / "wiki_graph.py"
ASSIST_CLI = SCRIPTS / "wiki-graph-assist.py"

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import wiki_graph  # noqa: E402


def _load_assist():
    """wiki-graph-assist.py 文件名带连字符，只能按路径加载。"""
    spec = importlib.util.spec_from_file_location("wiki_graph_assist", ASSIST_CLI)
    module = importlib.util.module_from_spec(spec)
    sys.modules["wiki_graph_assist"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def wiki(tmp_path: Path) -> Path:
    """一个微型 wiki：4 种链接写法 + 1 个导航枢纽 + 2 个孤岛。"""
    root = tmp_path / "vault"
    lessons = root / "wiki/projects/demo/lessons"
    lessons.mkdir(parents=True)

    (root / "wiki/projects/demo/demo.md").write_text(
        "---\ntitle: demo 项目入口\nmemory_layer: L0\n---\n\n"
        "# demo 项目入口\n\n"
        "链接：[[wiki/projects/demo/lessons/alpha]] "
        "[[projects/demo/lessons/beta]] [[gamma-lesson]] [[Beta]]\n",
        encoding="utf-8",
    )
    (lessons / "alpha.md").write_text(
        "---\ntitle: alpha 链式召回\nmemory_layer: L2\n---\n\n"
        "# alpha 链式召回\n\n"
        "[[wiki/projects/demo/lessons/beta]] "
        "[[wiki/projects/demo/lessons/missing-page]]\n\n"
        "```\n[[wiki/projects/demo/lessons/alpha]]  # 代码块里的示例不算边\n```\n",
        encoding="utf-8",
    )
    (lessons / "beta.md").write_text(
        "---\ntitle: Beta\nmemory_layer: L2\n---\n\n# Beta\n\n[[wiki/projects/demo/demo]]\n",
        encoding="utf-8",
    )
    (lessons / "gamma-lesson.md").write_text(
        "---\ntitle: gamma 孤岛笔记\nmemory_layer: L2\n---\n\n# gamma 孤岛笔记\n\n没有任何链接。\n",
        encoding="utf-8",
    )
    (lessons / "lonely.md").write_text(
        "---\ntitle: 完全孤立\nmemory_layer: L2\n---\n\n# 完全孤立\n\n没有入链也没有出链。\n",
        encoding="utf-8",
    )
    # 导航枢纽：入度 >= hub_min 会把 boost 压下去
    log_lines = ["# 活动日志", ""]
    for i in range(30):
        log_lines.append(f"- [[wiki/projects/demo/lessons/alpha]] 事件 {i}")
    (root / "log.md").write_text("---\ntitle: 活动日志\n---\n\n" + "\n".join(log_lines) + "\n", encoding="utf-8")
    return root


def _snapshot(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def _search_paths() -> list[str]:
    return ["wiki/projects", "wiki/concepts", "wiki/questions", "journal/weekly", "log.md"]


# ── 链接解析与反向链接 ─────────────────────────────────────────────────────


def test_link_resolution_covers_four_target_forms(wiki: Path) -> None:
    graph, _stats = wiki_graph.build_graph(wiki, _search_paths())
    entry = graph.nodes["wiki/projects/demo/demo"]
    assert set(graph.out_links(entry.key)) == {
        "wiki/projects/demo/lessons/alpha",
        "wiki/projects/demo/lessons/beta",
        "wiki/projects/demo/lessons/gamma-lesson",
    }, "精确路径 / 省略 wiki 前缀 / 裸 basename / 标题别名都应解析成边"
    res = graph.resolve_stats
    assert res.exact >= 1
    assert res.prefixed >= 1
    # 裸 basename / 标题别名：先走路径后缀，再走别名表（后缀更精确）
    assert res.suffix + res.alias >= 2
    assert res.unresolved >= 1, "missing-page 必须被计为未解析，而不是静默丢弃"


def test_code_fence_examples_do_not_create_edges(wiki: Path) -> None:
    graph, _stats = wiki_graph.build_graph(wiki, _search_paths())
    alpha = "wiki/projects/demo/lessons/alpha"
    assert alpha not in graph.out_links(alpha), "代码块里的示例链接不是引用"


def test_ambiguous_basename_prefers_same_project_then_gives_up(tmp_path: Path) -> None:
    """basename 冲突（index.md 在真实 wiki 里有 75 个）不能乱接边。

    规则：先按「与来源页同目录就近」择一；仍不唯一就放弃 —— 宁可少一条边，
    也不要接错一条边。
    """
    root = tmp_path / "vault"
    for project in ("p1", "p2", "p3"):
        (root / f"wiki/projects/{project}/sub").mkdir(parents=True)
        (root / f"wiki/projects/{project}/index.md").write_text("# index\n", encoding="utf-8")
    (root / "wiki/projects/p1/sub/a.md").write_text("# a\n\n[[index]]\n", encoding="utf-8")
    (root / "wiki/projects/p3/sub/b.md").write_text("# b\n\n[[index]]\n", encoding="utf-8")
    # 真正的歧义：来源页与 p1/index、p2/index 的目录公共深度相同（都是 wiki/projects）
    (root / "wiki/projects/orphan.md").write_text("# orphan\n\n[[index]]\n", encoding="utf-8")
    graph, _stats = wiki_graph.build_graph(root, ["wiki/projects"])

    # p1/sub/a 与 p1/index、p3/sub/b 与 p3/index 都能按「同项目就近」判定
    assert graph.out_links("wiki/projects/p1/sub/a") == ("wiki/projects/p1/index",)
    assert graph.out_links("wiki/projects/p3/sub/b") == ("wiki/projects/p3/index",), (
        "同项目就近优先于全局歧义——这正是真实 wiki 里 75 个 index.md 的正确接法"
    )
    # orphan 无法就近，必须判歧义并放弃
    assert graph.out_links("wiki/projects/orphan") == (), "无唯一上下文时不能瞎猜"
    assert graph.resolve_stats.ambiguous >= 1


def test_backlinks_and_related_walk_the_graph(wiki: Path) -> None:
    graph, _stats = wiki_graph.build_graph(wiki, _search_paths())
    beta = "wiki/projects/demo/lessons/beta"
    one_hop = graph.backlinks(beta, hops=1)
    assert set(one_hop) == {"wiki/projects/demo/demo", "wiki/projects/demo/lessons/alpha"}
    two_hop = graph.backlinks(beta, hops=2)
    assert all(depth <= 2 for depth in two_hop.values())
    related = graph.related("wiki/projects/demo/demo", hops=1)
    assert "wiki/projects/demo/lessons/alpha" in related


# ── 图形状：孤岛 / 枢纽 / 悬挂（只报告） ───────────────────────────────────


def test_islands_and_hubs_are_reported(wiki: Path) -> None:
    graph, _stats = wiki_graph.build_graph(wiki, _search_paths())
    islands = graph.islands()
    assert "wiki/projects/demo/lessons/lonely" in islands
    # gamma-lesson 被入口页引用（入链 1、出链 0）→ 不是孤岛，是「只入不出」
    assert "wiki/projects/demo/lessons/gamma-lesson" not in islands
    assert "wiki/projects/demo/lessons/gamma-lesson" in graph.dangling()
    hubs = dict(graph.hubs(top=5))
    assert hubs["wiki/projects/demo/demo"] >= 1

    report = graph.report(top=5)
    assert report["nodes"] == 6
    assert report["edges"] >= 5
    assert report["islands"] == len(islands) == 1
    assert report["verdict"].startswith(("值得", "有条件")) or "图" in report["verdict"]
    assert report["top_cited"], "必须能回答『谁被引用最多』"


def test_dangling_and_sources_are_distinguished(tmp_path: Path) -> None:
    root = tmp_path / "vault"
    (root / "wiki/projects").mkdir(parents=True)
    (root / "wiki/projects/a.md").write_text("# a\n\n[[b]]\n", encoding="utf-8")
    (root / "wiki/projects/b.md").write_text("# b\n", encoding="utf-8")
    (root / "wiki/projects/c.md").write_text("# c\n\n[[b]]\n", encoding="utf-8")
    graph, _stats = wiki_graph.build_graph(root, ["wiki/projects"])
    assert graph.dangling() == ["wiki/projects/b"]
    assert graph.sources() == ["wiki/projects/a", "wiki/projects/c"]
    assert graph.islands() == []


# ── 图遍历：衰减 / 稀释 / 枢纽抑制 ────────────────────────────────────────


def test_expand_orders_one_hop_above_two_hops(tmp_path: Path) -> None:
    root = tmp_path / "vault"
    (root / "wiki/projects").mkdir(parents=True)
    (root / "wiki/projects/seed.md").write_text("# seed\n\n[[n1]]\n", encoding="utf-8")
    (root / "wiki/projects/n1.md").write_text("# n1\n\n[[n2]]\n", encoding="utf-8")
    (root / "wiki/projects/n2.md").write_text("# n2\n", encoding="utf-8")
    graph, _stats = wiki_graph.build_graph(root, ["wiki/projects"])
    boosts = graph.expand({"wiki/projects/seed": 40.0}, hops=2, decay=0.5, hub_min=999)
    assert boosts["wiki/projects/n1"].hop == 1
    assert boosts["wiki/projects/n2"].hop == 2
    assert boosts["wiki/projects/n1"].boost > boosts["wiki/projects/n2"].boost


def test_expand_dilutes_high_out_degree_spreaders(tmp_path: Path) -> None:
    root = tmp_path / "vault"
    fans = root / "wiki/projects/fans"
    fans.mkdir(parents=True)
    links = "\n".join(f"- [[wiki/projects/fans/t{i}]]" for i in range(50))
    (root / "wiki/projects/hub.md").write_text(f"# hub\n\n{links}\n", encoding="utf-8")
    (root / "wiki/projects/small.md").write_text("# small\n\n[[fans/t0]]\n", encoding="utf-8")
    for i in range(50):
        (fans / f"t{i}.md").write_text(f"# t{i}\n", encoding="utf-8")
    graph, _stats = wiki_graph.build_graph(root, ["wiki/projects"])
    from_hub = graph.expand({"wiki/projects/hub": 40.0}, hops=1, decay=0.5, hub_min=999)
    from_small = graph.expand({"wiki/projects/small": 40.0}, hops=1, decay=0.5, hub_min=999)
    assert from_small["wiki/projects/fans/t0"].boost > from_hub["wiki/projects/fans/t0"].boost, (
        "同一目标，来自 50 出链枢纽的贡献必须显著小于来自 1 出链页面的贡献"
    )


def test_partial_path_links_resolve_by_suffix(tmp_path: Path) -> None:
    """真实 wiki 有 116 条链接写成部分路径（``[[lessons/foo]]``），必须接上。"""
    root = tmp_path / "vault"
    (root / "wiki/projects/p/lessons").mkdir(parents=True)
    (root / "wiki/projects/p/p.md").write_text(
        "# p\n\n[[lessons/probe]] [[tasks/x/index]]\n", encoding="utf-8"
    )
    (root / "wiki/projects/p/lessons/probe.md").write_text("# probe\n", encoding="utf-8")
    (root / "wiki/projects/p/tasks/x").mkdir(parents=True)
    (root / "wiki/projects/p/tasks/x/index.md").write_text("# x\n", encoding="utf-8")
    graph, _stats = wiki_graph.build_graph(root, ["wiki/projects"])
    assert graph.out_links("wiki/projects/p/p") == (
        "wiki/projects/p/lessons/probe",
        "wiki/projects/p/tasks/x/index",
    )
    assert graph.resolve_stats.suffix >= 2
    # 后缀多候选时必须放弃，不能跨项目乱接
    (root / "wiki/projects/q/lessons").mkdir(parents=True)
    (root / "wiki/projects/q/lessons/probe.md").write_text("# probe q\n", encoding="utf-8")
    (root / "wiki/projects/p/p.md").write_text("# p\n\n[[lessons/probe]]\n", encoding="utf-8")
    graph2, _stats2 = wiki_graph.build_graph(root, ["wiki/projects"])
    assert graph2.out_links("wiki/projects/p/p") == ("wiki/projects/p/lessons/probe",), (
        "同项目就近优先"
    )


def test_hub_damping_only_hits_navigational_hubs(tmp_path: Path) -> None:
    """导航型枢纽（log.md：入度 30、出链 1）必须被抑制，普通页面不受影响。"""
    root = tmp_path / "vault"
    (root / "wiki/projects").mkdir(parents=True)
    (root / "wiki/projects/alpha.md").write_text("# alpha\n\n[[wiki/projects/normal]]\n", encoding="utf-8")
    (root / "wiki/projects/normal.md").write_text("# normal\n", encoding="utf-8")
    (root / "log.md").write_text("# 活动日志\n\n[[wiki/projects/alpha]]\n", encoding="utf-8")
    for i in range(30):
        (root / f"wiki/projects/f{i}.md").write_text("# f\n\n[[log]]\n", encoding="utf-8")
    graph, _stats = wiki_graph.build_graph(root, ["wiki/projects", "log.md"])
    assert len(graph.in_links("log")) == 30

    seeds = {"wiki/projects/alpha": 40.0}
    damped = graph.expand(seeds, hops=1, decay=0.5, hub_damp=1.0, hub_min=25)
    plain = graph.expand(seeds, hops=1, decay=0.5, hub_damp=0.0)
    assert damped["log"].boost < plain["log"].boost, "入度 30 的导航枢纽必须被抑制"
    # 普通页面（入度 1）在两种设置下得分一致
    assert damped["wiki/projects/normal"].boost == pytest.approx(
        plain["wiki/projects/normal"].boost
    )


def test_expand_orders_one_hop_above_two_hops(tmp_path: Path) -> None:
    root = tmp_path / "vault"
    (root / "wiki/projects").mkdir(parents=True)
    (root / "wiki/projects/seed.md").write_text("# seed\n\n[[n1]]\n", encoding="utf-8")
    (root / "wiki/projects/n1.md").write_text("# n1\n\n[[n2]]\n", encoding="utf-8")
    (root / "wiki/projects/n2.md").write_text("# n2\n", encoding="utf-8")
    graph, _stats = wiki_graph.build_graph(root, ["wiki/projects"])
    boosts = graph.expand({"wiki/projects/seed": 40.0}, hops=2, decay=0.5, hub_min=999)
    assert boosts["wiki/projects/n1"].hop == 1
    assert boosts["wiki/projects/n2"].hop == 2
    assert boosts["wiki/projects/n1"].boost > boosts["wiki/projects/n2"].boost


def test_expand_respects_weight_cap_and_seed_floor(tmp_path: Path) -> None:
    root = tmp_path / "vault"
    (root / "wiki/projects").mkdir(parents=True)
    (root / "wiki/projects/seed.md").write_text("# seed\n\n[[n1]]\n", encoding="utf-8")
    (root / "wiki/projects/n1.md").write_text("# n1\n", encoding="utf-8")
    graph, _stats = wiki_graph.build_graph(root, ["wiki/projects"])
    capped = graph.expand({"wiki/projects/seed": 100.0}, hops=1, decay=1.0, weight_cap=0.1)
    assert capped["wiki/projects/n1"].boost <= 10.0 + 1e-6
    skipped = graph.expand({"wiki/projects/seed": 1.0}, hops=1, seed_floor=3.0)
    assert skipped == {}, "弱命中不能当种子扩散"


# ── 索引缓存：增量与只读 ──────────────────────────────────────────────────


def test_cache_is_incremental(wiki: Path, tmp_path: Path) -> None:
    cache = tmp_path / "cache" / "index.json"
    metas, _texts, stats = wiki_graph.scan_pages(wiki, _search_paths(), cache_path=cache)
    assert stats.parsed == len(metas) > 0
    assert cache.is_file()

    metas2, _texts2, stats2 = wiki_graph.scan_pages(
        wiki, _search_paths(), cache_path=cache, max_age=0.0
    )
    assert stats2.parsed == 0 and stats2.reused == len(metas2)

    target = wiki / "wiki/projects/demo/lessons/alpha.md"
    target.write_text(target.read_text(encoding="utf-8") + "\n新增一行\n", encoding="utf-8")
    metas3, _texts3, stats3 = wiki_graph.scan_pages(
        wiki, _search_paths(), cache_path=cache, max_age=0.0
    )
    assert stats3.parsed == 1, "只有变化的文件需要重解析"
    assert len(metas3) == len(metas2)


def test_cache_fresh_ttl_skips_stats(wiki: Path, tmp_path: Path) -> None:
    cache = tmp_path / "cache" / "index.json"
    wiki_graph.scan_pages(wiki, _search_paths(), cache_path=cache)
    _metas, _texts, stats = wiki_graph.scan_pages(
        wiki, _search_paths(), cache_path=cache, max_age=300.0
    )
    assert stats.reuse_file_list is True
    assert stats.parsed == 0


def test_graph_build_never_writes_into_wiki(wiki: Path) -> None:
    before = _snapshot(wiki)
    graph, _stats = wiki_graph.build_graph(wiki, _search_paths())
    graph.report(top=5)
    graph.backlinks("wiki/projects/demo/lessons/beta", hops=2)
    graph.expand({"wiki/projects/demo/demo": 10.0})
    assert _snapshot(wiki) == before, "图模块必须只读：孤岛只报告，绝不删除或改写"


def test_cli_report_and_backlinks(wiki: Path, tmp_path: Path) -> None:
    cache = tmp_path / "cache.json"
    out = subprocess.run(
        [
            sys.executable,
            str(GRAPH_CLI),
            "--wiki-dir",
            str(wiki),
            "--report",
            "--json",
            "--no-cache",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(out.stdout)
    assert payload["nodes"] == 6
    assert payload["edges"] >= 5
    assert payload["islands"] == 1
    assert payload["island_samples"] == ["wiki/projects/demo/lessons/lonely"]
    assert payload["verdict"]
    assert payload["resolution"]["resolved"] >= 4

    back = subprocess.run(
        [
            sys.executable,
            str(GRAPH_CLI),
            "--wiki-dir",
            str(wiki),
            "--backlinks",
            "wiki/projects/demo/lessons/beta.md",
            "--json",
            "--cache",
            str(cache),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    bl = json.loads(back.stdout)
    assert bl["key"] == "wiki/projects/demo/lessons/beta"
    assert "wiki/projects/demo/lessons/alpha" in bl["backlinks"]


# ── 召回接线：图必须真的被消费 ────────────────────────────────────────────


def test_pagehit_has_no_dead_links_field() -> None:
    assist = _load_assist()
    assert "links" not in assist.PageHit.__dataclass_fields__, (
        "PageHit.links 曾是死字段（抽出后无人读取）；图遍历应该吃 wiki_graph 的边"
    )


def test_recall_expands_from_keyword_hits(wiki: Path, tmp_path: Path) -> None:
    assist = _load_assist()
    query = "alpha 链式召回"
    paths = ["wiki/projects"]
    baseline = assist.find_related(wiki, query, None, paths, 5, min_score=3)
    assert [hit.rel for hit in baseline] == ["wiki/projects/demo/lessons/alpha.md"]

    graph, _scan = assist.load_graph(wiki, paths, str(tmp_path / "c.json"), False, False, max_age=0)
    hits, stats = assist.apply_graph_expansion(
        graph,
        baseline,
        assist.words(query),
        limit=5,
        min_score=3,
        max_added=3,
        wiki_dir=wiki,
        hub_min=25,
    )
    rels = [hit.rel for hit in hits]
    assert "wiki/projects/demo/lessons/beta.md" in rels, "1 跳邻居 beta 必须被图召回带进来"
    assert stats["added_in_packet"] >= 1
    assert any(hit.from_graph for hit in hits)


def test_assist_cli_no_graph_flag_disables_graph(wiki: Path, tmp_path: Path) -> None:
    cache = str(tmp_path / "c.json")
    base = [
        sys.executable,
        str(ASSIST_CLI),
        "--wiki-dir",
        str(wiki),
        "--query",
        "alpha 链式召回",
        "--search-path",
        "wiki/projects",
        "--format",
        "json",
        "--graph-cache",
        cache,
    ]
    with_graph = json.loads(subprocess.run(base, capture_output=True, text=True, check=True).stdout)
    without = json.loads(
        subprocess.run(base + ["--no-graph"], capture_output=True, text=True, check=True).stdout
    )
    assert with_graph["graph"]["enabled"] is True
    assert without["graph"]["enabled"] is False
    assert with_graph["graph"]["candidates"] >= 1
    assert all(not link["from_graph"] for link in without["suggested_links"])


def test_markdown_packet_marks_keyword_and_graph_hits(wiki: Path, tmp_path: Path) -> None:
    out = subprocess.run(
        [
            sys.executable,
            str(ASSIST_CLI),
            "--wiki-dir",
            str(wiki),
            "--query",
            "alpha 链式召回",
            "--search-path",
            "wiki/projects",
            "--graph-cache",
            str(tmp_path / "c.json"),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "## Suggested Links" in out
    assert "graph:" in out
    assert "(keyword)" in out
    assert "graph:" in out.split("## Suggested Links")[1]


def test_graph_seed_bigram_reaches_zero_keyword_queries(wiki: Path, tmp_path: Path) -> None:
    """中文 query 在现状分词下常常零命中 —— 弱种子是唯一入口。"""
    assist = _load_assist()
    graph, _scan = assist.load_graph(
        wiki, ["wiki/projects"], str(tmp_path / "c.json"), False, False, max_age=0
    )
    hits = assist.find_related(wiki, "完全孤立笔记", None, ["wiki/projects"], 5, min_score=3)
    seeds = assist.title_bigram_seeds(graph, "完全孤立笔记")
    assert "wiki/projects/demo/lessons/lonely" in seeds, "标题 bigram 应能选中入口页"
    expanded, stats = assist.apply_graph_expansion(
        graph,
        hits,
        assist.words("完全孤立笔记"),
        limit=5,
        min_score=3,
        max_added=3,
        wiki_dir=wiki,
        extra_seeds=seeds,
    )
    assert stats["weak_seeds"] >= 1
    assert isinstance(expanded, list)

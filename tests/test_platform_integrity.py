import json
import importlib.util
import re
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/auto-goo/scripts"


def test_versions_are_consistent() -> None:
    # package.json 是单一事实源：其余位置必须与它一致。
    # 不要把具体版本号写进断言，否则每次 bump 都要改测试。
    source = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    expected = str(source)

    manifests = [
        ROOT / ".claude-plugin/plugin.json",
        ROOT / ".codex-plugin/plugin.json",
        ROOT / "package.json",
        ROOT / ".pi/extensions/autogoo-plugin/package.json",
        ROOT / ".claude-plugin/marketplace.json",
    ]
    versions = {json.loads(path.read_text(encoding="utf-8"))["version"] for path in manifests}
    assert versions == {expected}, f"manifest versions {versions} != {expected}"

    skill = (ROOT / "skills/auto-goo/SKILL.md").read_text(encoding="utf-8")
    assert re.search(rf"^version:\s*{re.escape(expected)}$", skill, re.MULTILINE), "SKILL.md version out of sync"

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert f"当前版本：**v{expected}**" in readme, "README version out of sync"
    assert f"version-{expected}-green" in readme, "README badge out of sync"

    # 工具数量从源码推导，不硬编码 —— 增删工具时只改代码，README 必须跟着对。
    ext = ROOT / ".pi/extensions/autogoo-plugin"
    tool_count = 0
    for source in ext.rglob("*.ts"):
        if "__tests__" in source.parts:
            continue
        tool_count += len(re.findall(r'name: "auto_goo', source.read_text(encoding="utf-8")))
    assert tool_count > 0, "no auto_goo tools found"
    assert f"{tool_count} 个自定义工具" in readme, (
        f"README tool count out of sync: source has {tool_count}"
    )

    entry = (ROOT / ".pi/extensions/autogoo-plugin/index.ts").read_text(encoding="utf-8")
    assert f"v{expected}" in entry, "extension banner/header out of sync"


def test_pi_relative_imports_exist() -> None:
    pi_root = ROOT / ".pi/extensions/autogoo-plugin"
    patterns = [r'from\s+["\'](\./?[^"\']+\.js)["\']', r'import\(["\'](\./?[^"\']+\.js)["\']\)']
    missing: list[str] = []
    for source in pi_root.rglob("*.ts"):
        text = source.read_text(encoding="utf-8")
        for pattern in patterns:
            for reference in re.findall(pattern, text):
                target = (source.parent / reference).with_suffix(".ts")
                if not target.exists():
                    missing.append(f"{source.relative_to(ROOT)} -> {reference}")
    assert not missing, "missing Pi modules:\n" + "\n".join(missing)
    paths = (pi_root / "utils/paths.ts").read_text(encoding="utf-8")
    assert '.pi/extensions/autogoo-plugin' in paths
    assert '.pi/extensions/auto-goo"' not in paths


def test_codex_contract_is_current() -> None:
    skill = (ROOT / "skills/auto-goo/SKILL.md").read_text(encoding="utf-8")
    assert "task_name" in skill and "message" in skill and "fork_turns" in skill
    assert "不要传旧字段 `agent_type` 或 `fork_context`" in skill
    resolver = (ROOT / "skills/auto-goo/scripts/resolve-root.py").read_text(encoding="utf-8")
    assert '.codex/config.toml' in resolver
    assert '.agents/plugins/marketplace.json' in resolver


def test_codex_only_root_resolution(tmp_path: Path) -> None:
    plugin = tmp_path / "plugins/autogoo-plugin"
    marker = plugin / "skills/auto-goo/scripts/update-step.py"
    marker.parent.mkdir(parents=True)
    marker.write_text("# marker\n", encoding="utf-8")
    config = tmp_path / ".codex/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[plugins."autogoo-plugin@personal"]\nenabled = true\n', encoding="utf-8")
    market = tmp_path / ".agents/plugins/marketplace.json"
    market.parent.mkdir(parents=True)
    market.write_text(
        json.dumps({"name": "personal", "plugins": [{"name": "autogoo-plugin", "source": {"path": "./plugins/autogoo-plugin"}}]}),
        encoding="utf-8",
    )
    module_path = ROOT / "skills/auto-goo/scripts/resolve-root.py"
    spec = importlib.util.spec_from_file_location("autogoo_resolver", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.resolve_root(tmp_path) == plugin


def test_claude_components_are_registered() -> None:
    expected = {"researcher", "implementer", "optimizer", "evaluator", "reviewer", "auditor", "recorder"}
    registered = {path.stem for path in (ROOT / "agents").glob("*.md")}
    assert expected <= registered
    hooks = json.loads((ROOT / "hooks/hooks.json").read_text(encoding="utf-8"))
    assert hooks["hooks"]["SessionStart"]
    assert (ROOT / "skills/auto-goo/scripts/session-start.py").exists()


# ── wiki frontmatter 校验脚本 ────────────────────────────────────────────────

def test_wiki_frontmatter_script_exists_and_runs():
    """memory_layer 曾是「文档要求但零强制」的字段（实测覆盖率仅 50%）。

    这个脚本把约定变成可执行检查。它必须能跑、能识别缺失、且能给出层级建议。
    """
    script = SCRIPTS / "check-wiki-frontmatter.py"
    assert script.exists(), "check-wiki-frontmatter.py 缺失"

    # --suggest：项目入口应判为 L3
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "wiki/projects").mkdir(parents=True)
        entry = root / "wiki/projects/demo.md"
        entry.write_text("---\ntitle: Demo\ntype: project\n---\n\n# Demo\n", encoding="utf-8")

        r = subprocess.run(
            ["python3", str(script), "--suggest", str(entry)],
            capture_output=True, text=True, timeout=60,
        )
        assert r.returncode == 0, r.stderr
        assert r.stdout.strip() == "L3", f"项目入口应建议 L3，实际 {r.stdout.strip()}"

        # --check：缺 memory_layer 必须失败
        r = subprocess.run(
            ["python3", str(script), "--check", str(entry)],
            capture_output=True, text=True, timeout=60,
        )
        assert r.returncode == 1, "缺 memory_layer 时应当失败"
        assert "memory_layer" in (r.stderr + r.stdout)

        # 补上后应当通过
        entry.write_text(
            "---\ntitle: Demo\ntype: project\nmemory_layer: L3\n---\n\n# Demo\n",
            encoding="utf-8",
        )
        r = subprocess.run(
            ["python3", str(script), "--check", str(entry)],
            capture_output=True, text=True, timeout=60,
        )
        assert r.returncode == 0, r.stderr

        # 非法值必须被抓
        entry.write_text("---\ntitle: Demo\nmemory_layer: L9\n---\n", encoding="utf-8")
        r = subprocess.run(
            ["python3", str(script), "--check", str(entry)],
            capture_output=True, text=True, timeout=60,
        )
        assert r.returncode == 1, "非法 memory_layer 值应当失败"


def test_wiki_recall_supports_layer_filter():
    """召回必须能按 memory_layer 过滤 —— 否则字段填了也没人用。"""
    script = SCRIPTS / "wiki-graph-assist.py"
    r = subprocess.run(
        ["python3", str(script), "--help"],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0
    assert "--layer" in r.stdout, "wiki-graph-assist.py 缺少 --layer"
    assert "--exclude-unlabeled" in r.stdout, (
        "缺少 --exclude-unlabeled：存量约一半笔记没有 memory_layer，"
        "默认丢弃会让召回凭空变差，必须显式可选"
    )

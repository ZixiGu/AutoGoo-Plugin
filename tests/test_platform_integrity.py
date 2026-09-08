import json
import importlib.util
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_versions_are_consistent() -> None:
    manifests = [
        ROOT / ".claude-plugin/plugin.json",
        ROOT / ".codex-plugin/plugin.json",
        ROOT / "package.json",
        ROOT / ".pi/extensions/autogoo-plugin/package.json",
    ]
    versions = {json.loads(path.read_text(encoding="utf-8"))["version"] for path in manifests}
    assert versions == {"0.5.1"}
    skill = (ROOT / "skills/auto-goo/SKILL.md").read_text(encoding="utf-8")
    assert re.search(r"^version:\s*0\.5\.1$", skill, re.MULTILINE)
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "当前版本：**v0.5.1**" in readme
    assert "17 个自定义工具" in readme


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

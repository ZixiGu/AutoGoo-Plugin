#!/usr/bin/env python3
"""goo-md.py — detect or restore the AutoGoo-Plugin ``goo.md`` convention file.

The plugin ships a backup template at ``templates/goo.md`` so that a missing
user-level (or project-level) ``goo.md`` can be detected and rebuilt without
re-running the full ``goo-init`` flow.

Usage::

    goo-md.py [--check|--ensure] [--json] [--root DIR] [--scope user|project]

* ``--check`` (default): report where ``goo.md`` lives.  Exit 0 when found,
  exit 1 when missing.
* ``--ensure``: create the file from the bundled template when missing.  An
  existing file is left untouched (marker-free user content is never clobbered),
  but rendering is idempotent: the marker block is replaced rather than
  duplicated, and text outside the markers is preserved.

Only the standard library (Python >= 3.10) is used.  ``~/.claude`` and
``~/.codex`` are deliberately never written here — goo-init owns those
pointers.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _paths import resolve_goo_md  # noqa: E402

BEGIN = "<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN -->"
END = "<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-END -->"

TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "templates" / "goo.md"

DEFAULT_WIKI_DIR = "~/workspace/Goo-wiki"
DEFAULT_INIT_HINT = "/auto-goo:goo-init"
DEFAULT_CONFIG_DISPLAY = "~/.auto-goo/config.json"

PLACEHOLDERS = (
    "WIKI_DIR",
    "PROJECT_ARCHIVE_DIR",
    "FALLBACK_PROJECT_DIR",
    "CONFIG_DISPLAY",
    "INIT_HINT",
)


# ── Tolerant IO ──────────────────────────────────────────────────────────────

def read_json(path: Path) -> dict[str, Any]:
    """Read a JSON object, returning ``{}`` for any missing/invalid file."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def read_text(path: Path) -> str:
    """Read UTF-8 text, returning ``""`` on any error."""
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


# ── Config / placeholder resolution ──────────────────────────────────────────

def project_slug(root: Path) -> str:
    """Derive a Goo-wiki archive slug from the project directory name.

    Mirrors ``default_project_slug`` in goo-init.sh so the generated
    ``archive.project_dir`` matches what goo-init would have written.
    """
    raw = root.name.lower()
    raw = re.sub(r"[^a-z0-9._-]+", "-", raw)
    raw = re.sub(r"-+", "-", raw).strip("-")
    return raw or "project"


def _config_chain(root: Path, home: Path) -> list[Path]:
    """Candidate config files, most specific first."""
    return [root / ".goo" / "config.json", home / ".auto-goo" / "config.json"]


def resolve_context(root: Path, home: Path) -> dict[str, Any]:
    """Resolve wiki_dir / archive dirs and the config file that supplied them.

    Priority for ``wiki_dir``: ``AUTOGOO_PLUGIN_WIKI_DIR`` env >
    ``<root>/.goo/config.json`` > ``~/.auto-goo/config.json`` >
    ``~/workspace/Goo-wiki``.  Archive dirs fall back to the Goo-wiki layout.
    """
    slug = project_slug(root)
    chain = _config_chain(root, home)

    wiki_dir: str | None = None
    config_used: Path | None = None
    archive: dict[str, Any] = {}
    for config_file in chain:
        config = read_json(config_file)
        if not config:
            continue
        if wiki_dir is None and isinstance(config.get("wiki_dir"), str) and config["wiki_dir"]:
            wiki_dir = config["wiki_dir"]
            config_used = config_file
        if not archive and isinstance(config.get("archive"), dict):
            archive = config["archive"]

    env_wiki = os.environ.get("AUTOGOO_PLUGIN_WIKI_DIR", "").strip()
    if env_wiki:
        wiki_dir = env_wiki
        config_used = None  # env override, not a config file

    if not wiki_dir:
        wiki_dir = str(home / "workspace" / "Goo-wiki")

    project_archive_dir = archive.get("project_dir")
    if not isinstance(project_archive_dir, str) or not project_archive_dir:
        project_archive_dir = f"wiki/projects/{slug}"

    fallback_project_dir = archive.get("fallback_project_dir")
    if not isinstance(fallback_project_dir, str) or not fallback_project_dir:
        fallback_project_dir = f".goo/obsidian/{slug}"

    if env_wiki:
        config_display = f"${'AUTOGOO_PLUGIN_WIKI_DIR'} 环境变量"
    elif config_used is not None:
        config_display = display_path(config_used, home)
    else:
        config_display = DEFAULT_CONFIG_DISPLAY

    return {
        "wiki_dir": wiki_dir,
        "project_archive_dir": project_archive_dir,
        "fallback_project_dir": fallback_project_dir,
        "config_display": config_display,
        "slug": slug,
        "config_file": config_used,
    }


def display_path(path: Path, home: Path) -> str:
    """Render *path* with ``~`` when it lives under *home*."""
    try:
        return "~/" + str(path.relative_to(home))
    except ValueError:
        return str(path)


def render_content(context: dict[str, Any]) -> str:
    """Load the bundled template and substitute the five placeholders."""
    template = read_text(TEMPLATE_PATH)
    if not template.strip():
        raise FileNotFoundError(f"goo.md template not readable: {TEMPLATE_PATH}")
    values = {
        "WIKI_DIR": str(context["wiki_dir"]),
        "PROJECT_ARCHIVE_DIR": str(context["project_archive_dir"]),
        "FALLBACK_PROJECT_DIR": str(context["fallback_project_dir"]),
        "CONFIG_DISPLAY": str(context["config_display"]),
        "INIT_HINT": DEFAULT_INIT_HINT,
    }
    body = template
    for key in PLACEHOLDERS:
        body = body.replace("{{" + key + "}}", values[key])
    # The template ships its own marker wrapper (so it is self-describing and
    # interchangeable with the block goo-init renders).  render_marker_block
    # re-adds exactly one wrapper, so strip the template's copy here.
    if BEGIN in body and END in body:
        body = body.split(BEGIN, 1)[1].split(END, 1)[0]
    return body.strip() + "\n"


# ── Idempotent marker block rendering (mirrors goo-init.sh) ───────────────────

def render_marker_block(path: Path, content: str) -> bool:
    """Write exactly one marker block into *path*; return True if it changed.

    Every complete ``BEGIN..END`` block is removed first, orphaned single-sided
    markers are cleaned up, then one fresh block is appended.  Text outside the
    markers is never modified, so repeated calls are a no-op.
    """
    old_text = read_text(path) if path.exists() else ""
    text = old_text

    while BEGIN in text and END in text:
        prefix, rest = text.split(BEGIN, 1)
        _, suffix = rest.split(END, 1)
        if prefix.strip():
            text = prefix.rstrip() + "\n" + suffix.lstrip("\n")
        else:
            text = suffix.lstrip("\n")

    # orphan begin without end: the incomplete block runs to EOF
    if BEGIN in text:
        idx = text.find(BEGIN)
        line_start = text.rfind("\n", 0, idx) + 1
        text = text[:line_start].rstrip() + "\n"

    # orphan end without begin: drop only the dangling marker line
    if END in text:
        idx = text.find(END)
        line_end = text.find("\n", idx)
        line_end = len(text) if line_end == -1 else line_end + 1
        text = (text[:idx].rstrip() + "\n" + text[line_end:].lstrip("\n")).rstrip() + "\n"

    block = f"{BEGIN}\n{content.rstrip()}\n{END}\n"
    base = text.rstrip()
    new_text = base + "\n\n" + block if base else block

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(new_text, encoding="utf-8")
    return new_text != old_text


# ── Behaviour ────────────────────────────────────────────────────────────────

def target_path(scope: str, root: Path, home: Path) -> Path:
    """Path that ``--ensure --scope <scope>`` writes to."""
    if scope == "project":
        return root / "goo.md"
    return home / ".auto-goo" / "goo.md"


def do_check(root: Path, home: Path) -> dict[str, Any]:
    """Detection-only result (no writes)."""
    resolved = resolve_goo_md(root, home)
    return {
        "action": "check",
        "scope": resolved["scope"],
        "path": str(resolved["path"]) if resolved["path"] is not None else None,
        "candidates": [
            {
                "scope": candidate["scope"],
                "path": str(candidate["path"]),
                "exists": bool(candidate["exists"]),
            }
            for candidate in resolved["candidates"]
        ],
    }


def do_ensure(scope: str, root: Path, home: Path, context: dict[str, Any]) -> dict[str, Any]:
    """Create/refresh ``goo.md`` for the requested scope."""
    target = target_path(scope, root, home)
    resolved = resolve_goo_md(root, home)

    base = {
        "action": "kept",
        "scope": resolved["scope"],
        "path": str(resolved["path"]) if resolved["path"] is not None else None,
        "candidates": [
            {
                "scope": candidate["scope"],
                "path": str(candidate["path"]),
                "exists": bool(candidate["exists"]),
            }
            for candidate in resolved["candidates"]
        ],
        "target": str(target),
        "wiki_dir": str(context["wiki_dir"]),
        "project_archive_dir": str(context["project_archive_dir"]),
        "fallback_project_dir": str(context["fallback_project_dir"]),
        "config_display": str(context["config_display"]),
        "template": str(TEMPLATE_PATH),
    }

    if target.exists():
        # Existing file: only refresh managed marker content, never append a
        # second block and never touch text outside the markers.
        text = read_text(target)
        if BEGIN in text and END in text:
            changed = render_marker_block(target, render_content(context))
            base["action"] = "refreshed" if changed else "kept"
            base["scope"] = scope
            base["path"] = str(target)
        else:
            base["action"] = "kept"
            base["scope"] = scope
            base["path"] = str(target)
            base["reason"] = "existing file has no marker block; left untouched"
        return base

    render_marker_block(target, render_content(context))
    base["action"] = "created"
    base["scope"] = scope
    base["path"] = str(target)
    for candidate in base["candidates"]:
        if candidate["scope"] == scope:
            candidate["exists"] = True
    return base


def print_human(result: dict[str, Any]) -> None:
    action = result.get("action", "check")
    if action == "check":
        if result["scope"] == "missing":
            print("goo.md: missing")
        else:
            print(f"goo.md: {result['scope']} -> {result['path']}")
        for candidate in result.get("candidates", []):
            mark = "found" if candidate["exists"] else "absent"
            print(f"  - [{candidate['scope']}] {candidate['path']} ({mark})")
        return

    verb = {"created": "created", "kept": "kept", "refreshed": "refreshed"}.get(action, action)
    print(f"goo.md: {verb} ({result.get('scope')}) -> {result.get('path')}")
    if result.get("reason"):
        print(f"  note: {result['reason']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="goo-md.py",
        description="Detect or restore the AutoGoo-Plugin goo.md convention file.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="report where goo.md lives (default)")
    mode.add_argument("--ensure", action="store_true", help="create goo.md from the bundled template")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument("--root", default=None, help="project root (default: cwd)")
    parser.add_argument(
        "--scope",
        choices=["user", "project"],
        default="user",
        help="scope to write with --ensure (default: user)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    root = Path(args.root).expanduser().resolve() if args.root else Path.cwd().resolve()
    home = Path.home().expanduser().resolve()

    context = resolve_context(root, home)

    if args.ensure:
        result = do_ensure(args.scope, root, home, context)
    else:
        result = do_check(root, home)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_human(result)

    if not args.ensure and result.get("scope") == "missing":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

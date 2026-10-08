#!/usr/bin/env python3
"""Bump the AutoGoo-Plugin version across every manifest and doc.

A release touches ~11 places (manifests, SKILL frontmatter, README badge,
extension banner, integrity test). Missing one leaves the repo in an
inconsistent state, so this script owns the whole list.

`package.json` is the **single source of truth**; everything else is asserted to
match it (see `tests/test_platform_integrity.py` and `check-plugin.sh` §14).

Usage:
  bump-version.py 0.6.0        # set an explicit version
  bump-version.py --minor      # 0.5.1 -> 0.6.0
  bump-version.py --patch      # 0.5.1 -> 0.5.2
  bump-version.py --major      # 0.5.1 -> 1.0.0
  bump-version.py --check      # verify consistency only, change nothing
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def read_current(root: Path) -> str:
    data = json.loads((root / "package.json").read_text(encoding="utf-8"))
    version = str(data.get("version", ""))
    if not SEMVER.match(version):
        raise SystemExit(f"package.json has a non-semver version: {version!r}")
    return version


def bump(current: str, part: str) -> str:
    major, minor, patch = (int(x) for x in current.split("."))
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def _json_version(path: Path) -> str | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = data.get("version")
    return str(value) if isinstance(value, (str, int)) else None


def apply_json_version(path: Path, old: str, new: str) -> bool:
    """Replace the top-level "version" value, preserving formatting."""
    text = path.read_text(encoding="utf-8")
    # 只替换顶层的首个 version 字段（manifest 都是扁平结构）
    pattern = re.compile(r'("version"\s*:\s*)"' + re.escape(old) + r'"')
    updated, count = pattern.subn(r'\1"' + new + '"', text, count=1)
    if count == 0:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def apply_text_version(path: Path, old: str, new: str) -> bool:
    text = path.read_text(encoding="utf-8")
    updated = text.replace(old, new)
    if updated == text:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def targets(root: Path) -> list[tuple[str, Path]]:
    return [
        ("json", root / "package.json"),
        ("json", root / ".pi/extensions/autogoo-plugin/package.json"),
        ("json", root / ".claude-plugin/plugin.json"),
        ("json", root / ".codex-plugin/plugin.json"),
        ("json", root / ".claude-plugin/marketplace.json"),
        ("text", root / "skills/auto-goo/SKILL.md"),
        ("text", root / "README.md"),
        ("text", root / ".pi/extensions/autogoo-plugin/index.ts"),
    ]


def collect(root: Path) -> list[tuple[Path, str | None]]:
    """Return (path, found_version_or_None) for every versioned location."""
    found: list[tuple[Path, str | None]] = []
    for kind, path in targets(root):
        if not path.is_file():
            found.append((path, None))
            continue
        if kind == "json":
            value = _json_version(path)
        else:
            text = path.read_text(encoding="utf-8")
            match = re.search(r"v?(\d+\.\d+\.\d+)", text)
            value = match.group(1) if match else None
        found.append((path, value))
    return found


def check(root: Path) -> int:
    expected = read_current(root)
    problems: list[str] = []
    for path, value in collect(root):
        rel = path.relative_to(root)
        if value is None:
            problems.append(f"{rel}: version not found")
        elif value != expected:
            problems.append(f"{rel}: {value} != {expected}")
    if problems:
        print(f"version mismatch (expected {expected} from package.json):", file=sys.stderr)
        for item in problems:
            print(f"  - {item}", file=sys.stderr)
        return 1
    print(f"version consistent: {expected}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Bump / verify the AutoGoo-Plugin version everywhere")
    parser.add_argument("version", nargs="?", help="explicit target version, e.g. 0.6.0")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--major", action="store_true")
    group.add_argument("--minor", action="store_true")
    group.add_argument("--patch", action="store_true")
    parser.add_argument("--check", action="store_true", help="verify consistency only")
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()

    root = args.root.expanduser()
    if args.check:
        return check(root)

    current = read_current(root)
    if args.version:
        if not SEMVER.match(args.version):
            raise SystemExit(f"not a semver version: {args.version!r}")
        target = args.version
    elif args.major or args.minor or args.patch:
        target = bump(current, "major" if args.major else "minor" if args.minor else "patch")
    else:
        raise SystemExit("specify a version or one of --major/--minor/--patch (or --check)")

    if target == current:
        print(f"version already {target}; nothing to do")
        return 0

    changed: list[str] = []
    missed: list[str] = []
    for kind, path in targets(root):
        if not path.is_file():
            missed.append(str(path.relative_to(root)))
            continue
        ok = apply_json_version(path, current, target) if kind == "json" else apply_text_version(path, current, target)
        (changed if ok else missed).append(str(path.relative_to(root)))

    print(f"{current} -> {target}")
    for item in changed:
        print(f"  updated {item}")
    if missed:
        print("  no change / missing:", file=sys.stderr)
        for item in missed:
            print(f"    - {item}", file=sys.stderr)

    rc = check(root)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())

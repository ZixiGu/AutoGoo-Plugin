#!/usr/bin/env python3
"""Measure AutoGoo-Plugin TypeScript test coverage — reproducibly, with a gate.

Why this exists
---------------
The old way of measuring "coverage" for this repo was folklore: *"40 源文件仅 9 个有测试
（22%）"*. That number counts **test files**, not what actually gets executed, and it
cannot be reproduced from a command.

`node --experimental-test-coverage` alone is not enough either: its summary only lists
modules that were **loaded** during the run, so an untouched 1,000-line file is simply
absent from the table and the printed "all files" percentage looks healthy (measured:
81% "line coverage" while half the source tree had never been imported).

This script therefore reports three metrics over an explicitly enumerated source set:

A. 文件覆盖率 (file-level)   = 至少被执行一行的源文件 / 源文件总数
      —— 与「40 文件里 9 个有测试 = 22%」同一口径，可直接对比。
B. 全源集行覆盖率 (whole-set) = Σ已覆盖行 / Σ总行，**从未加载的文件按 0% 计入分母**
      —— 最严格的口径，不会被"只跑少数大文件"刷高。
C. 已加载行覆盖率 (loaded)    = Σ已覆盖行 / Σ总行，只算被加载过的文件
      —— node 自己的汇总口径，用来防"改造后反而变差"。

Numbers come from node's structured coverage summary (via `coverage-reporter.mjs`),
not from parsing the human table: the table encodes directory nesting with indentation
and hides unloaded files entirely.

Usage
-----
  coverage-report.py                       # run the suite, print the table, apply gates
  coverage-report.py --json                # machine readable
  coverage-report.py --out report.json     # write JSON to file
  coverage-report.py --list-sources        # only enumerate the source set (fast)
  coverage-report.py --reuse cov.json      # re-analyse an existing coverage dump
  coverage-report.py --min-files 40 --min-lines 20 --min-loaded-lines 75
  coverage-report.py --no-gate             # measure only, always exit 0

Exit codes: 0 = gates pass, 1 = gate failed, 2 = harness problem (no tsx / no JSON).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

# 源文件集合的边界写死在脚本里，避免"改个 glob 就把覆盖率做高"。
PLUGIN_DIR = Path(".pi/extensions/autogoo-plugin")
EXCLUDE_PARTS = {"node_modules", "__tests__", "tmp"}
EXCLUDE_SUFFIXES = (".test.ts", ".d.ts")

# 默认闸门。A 与 B 必须同时成立，两个方向各自堵一种刷分方式：
#   - 只测 A（文件覆盖率）→ 给 40 个文件各加一个 import 就能刷满；
#   - 只测 B（全源集行覆盖率）→ 只覆盖少数大文件也能到 40%。
# C 默认**不作为闸门**：它只统计被加载过的文件，加载一个几乎没覆盖的大文件就会下降，
# 拿它当闸门等于惩罚"多测一个文件"。它只作为诊断指标打印。
DEFAULT_MIN_FILES = 40.0
DEFAULT_MIN_LINES = 40.0
DEFAULT_MIN_LOADED_LINES = 0.0


@dataclass
class FileCoverage:
    """单个源文件的行/分支/函数覆盖情况。`loaded=False` 表示测试从未 import 过它。"""

    path: Path
    rel: str
    total_lines: int
    covered_lines: int = 0
    total_branches: int = 0
    covered_branches: int = 0
    total_functions: int = 0
    covered_functions: int = 0
    loaded: bool = False

    @property
    def line_pct(self) -> float:
        if self.total_lines <= 0:
            return 100.0
        return self.covered_lines / self.total_lines * 100.0

    @property
    def branch_pct(self) -> float:
        if self.total_branches <= 0:
            return 100.0
        return self.covered_branches / self.total_branches * 100.0

    @property
    def function_pct(self) -> float:
        if self.total_functions <= 0:
            return 100.0
        return self.covered_functions / self.total_functions * 100.0


@dataclass
class Summary:
    """三个口径的汇总，外加闸门结果。"""

    files: int
    files_covered: int
    total_lines: int
    covered_lines: int
    loaded_total_lines: int
    loaded_covered_lines: int
    details: list[FileCoverage] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    @property
    def file_pct(self) -> float:
        return self.files_covered / self.files * 100.0 if self.files else 0.0

    @property
    def line_pct(self) -> float:
        return self.covered_lines / self.total_lines * 100.0 if self.total_lines else 0.0

    @property
    def loaded_line_pct(self) -> float:
        if not self.loaded_total_lines:
            return 0.0
        return self.loaded_covered_lines / self.loaded_total_lines * 100.0


# ── 源文件枚举 ──────────────────────────────────────────────────────────────


def repo_root_from(start: Path) -> Path:
    """从脚本位置回溯到仓库根（含 package.json 且带 skills/ 目录的那一层）。"""
    for candidate in [start, *start.parents]:
        if (candidate / "package.json").is_file() and (candidate / "skills").is_dir():
            return candidate
    raise SystemExit(f"找不到仓库根（从 {start} 向上）")


def iter_sources(plugin_dir: Path) -> list[Path]:
    """枚举被测源文件集合 —— 这是**唯一**的分母定义，任何统计都必须用它。"""
    out: list[Path] = []
    for path in sorted(plugin_dir.rglob("*.ts")):
        rel_parts = set(path.relative_to(plugin_dir).parts[:-1])
        if rel_parts & EXCLUDE_PARTS:
            continue
        if path.name.endswith(EXCLUDE_SUFFIXES):
            continue
        out.append(path)
    return out


# ── 覆盖率数据获取 ──────────────────────────────────────────────────────────


def find_tsx(root: Path) -> Path:
    candidate = root / "node_modules/.bin/tsx"
    if candidate.exists():
        return candidate
    raise SystemExit("找不到 node_modules/.bin/tsx（先在仓库根跑一次 npm install）")


def test_files(plugin_dir: Path) -> list[str]:
    """测试文件清单：`__tests__/*.test.ts` + `utils/*.test.ts`（历史遗留位置）。"""
    found: list[str] = []
    for pattern in ("__tests__/*.test.ts", "utils/*.test.ts"):
        found.extend(str(p.relative_to(plugin_dir)) for p in sorted(plugin_dir.glob(pattern)))
    if not found:
        raise SystemExit("没有找到任何测试文件")
    return found


def run_tests(root: Path, plugin_dir: Path, quiet: bool) -> dict[str, Any]:
    """跑一遍测试并把 node 的结构化覆盖率 JSON 读回来。"""
    reporter = root / "skills/auto-goo/scripts/coverage-reporter.mjs"
    if not reporter.is_file():
        raise SystemExit(f"缺少 reporter: {reporter}")

    with tempfile.TemporaryDirectory(prefix="autogoo-cov-") as tmp:
        cov_json = Path(tmp) / "coverage.json"
        spec_log = Path(tmp) / "spec.log"
        reporter_log = Path(tmp) / "reporter.log"
        cmd = [
            str(find_tsx(root)),
            "--test",
            "--experimental-test-coverage",
            "--test-coverage-exclude=__tests__/**",
            "--test-coverage-exclude=**/*.test.ts",
            "--test-coverage-exclude=**/node_modules/**",
            "--test-reporter=spec",
            f"--test-reporter-destination={spec_log}",
            f"--test-reporter={reporter}",
            f"--test-reporter-destination={reporter_log}",
            *test_files(plugin_dir),
        ]
        env = {"AUTOGOO_COVERAGE_JSON": str(cov_json)}
        proc = subprocess.run(  # noqa: S603 - 固定参数，无 shell
            cmd,
            cwd=plugin_dir,
            env={**os.environ, **env},
            capture_output=True,
            text=True,
            check=False,
        )
        spec_output = spec_log.read_text("utf-8", errors="replace") if spec_log.exists() else ""
        if not quiet:
            sys.stdout.write(spec_output)
            if proc.stderr.strip():
                sys.stdout.write(proc.stderr[-4000:])
            sys.stdout.write("\n")
        if not cov_json.exists():
            raise SystemExit(
                "测试跑完但没有拿到覆盖率数据（reporter 没触发 test:coverage 事件）\n"
                f"--- spec(log) ---\n{spec_output[-2000:]}\n--- stderr ---\n{proc.stderr[-2000:]}"
            )
        return json.loads(cov_json.read_text("utf-8"))


# ── 指标计算 ────────────────────────────────────────────────────────────────


def line_count(path: Path) -> int:
    """按 node 的口径计数行数（含注释与空行），未加载文件用它做分母。"""
    try:
        return len(path.read_text("utf-8", errors="replace").splitlines())
    except OSError:
        return 0


def build_summary(plugin_dir: Path, coverage: dict[str, Any]) -> Summary:
    """把 coverage dump 与「源文件全集」做差集，未加载文件按 0% 计入。"""
    by_rel: dict[str, FileCoverage] = {}
    sources = iter_sources(plugin_dir)
    for path in sources:
        rel = path.relative_to(plugin_dir).as_posix()
        by_rel[rel] = FileCoverage(path=path, rel=rel, total_lines=line_count(path))

    for entry in coverage.get("files") or []:
        abs_path = Path(str(entry.get("path") or "")).resolve()
        try:
            rel = abs_path.relative_to(plugin_dir.resolve()).as_posix()
        except ValueError:
            # 项目外的文件（测试夹具、临时模块）不属于源集，直接忽略
            continue
        target = by_rel.get(rel)
        if target is None:
            continue
        target.loaded = True
        target.total_lines = int(entry.get("totalLineCount") or target.total_lines)
        target.covered_lines = int(entry.get("coveredLineCount") or 0)
        target.total_branches = int(entry.get("totalBranchCount") or 0)
        target.covered_branches = int(entry.get("coveredBranchCount") or 0)
        target.total_functions = int(entry.get("totalFunctionCount") or 0)
        target.covered_functions = int(entry.get("coveredFunctionCount") or 0)

    details = sorted(by_rel.values(), key=lambda f: (f.line_pct, f.rel))
    loaded = [f for f in details if f.loaded]
    return Summary(
        files=len(details),
        files_covered=sum(1 for f in details if f.covered_lines > 0),
        total_lines=sum(f.total_lines for f in details),
        covered_lines=sum(f.covered_lines for f in details),
        loaded_total_lines=sum(f.total_lines for f in loaded),
        loaded_covered_lines=sum(f.covered_lines for f in loaded),
        details=details,
    )


def apply_gates(summary: Summary, args: argparse.Namespace) -> list[str]:
    """三条闸门：文件名面（对照 22% 历史口径）+ 全源集行 + 已加载行。"""
    failures: list[str] = []
    if summary.file_pct < args.min_files:
        failures.append(
            f"文件覆盖率 {summary.file_pct:.1f}% < {args.min_files:.0f}% "
            f"({summary.files_covered}/{summary.files} 个源文件被执行过)"
        )
    if summary.line_pct < args.min_lines:
        failures.append(
            f"全源集行覆盖率 {summary.line_pct:.1f}% < {args.min_lines:.0f}% "
            f"({summary.covered_lines}/{summary.total_lines} 行)"
        )
    if args.min_loaded_lines > 0 and summary.loaded_line_pct < args.min_loaded_lines:
        failures.append(
            f"已加载行覆盖率 {summary.loaded_line_pct:.1f}% < {args.min_loaded_lines:.0f}% "
            f"({summary.loaded_covered_lines}/{summary.loaded_total_lines} 行)"
        )
    return failures


# ── 输出 ────────────────────────────────────────────────────────────────────


def render_table(summary: Summary, limit: int = 0) -> str:
    rows = summary.details
    if limit > 0:
        rows = rows[:limit]
    width = max([len(f.rel) for f in summary.details] + [12])
    out = [
        f"{'文件'.ljust(width)}  行%     分支%   函数%   状态",
        f"{'-' * width}  ------  ------  ------  --------",
    ]
    for f in rows:
        state = "loaded" if f.loaded else "未加载"
        out.append(
            f"{f.rel.ljust(width)}  {f.line_pct:6.2f}  {f.branch_pct:6.2f}  "
            f"{f.function_pct:6.2f}  {state}"
        )
    if limit > 0 and len(summary.details) > limit:
        out.append(f"… 其余 {len(summary.details) - limit} 个文件见 --json")
    return "\n".join(out)


def render_summary(summary: Summary, args: argparse.Namespace) -> str:
    lines = [
        "",
        "── 汇总（3 个口径，分母都写死在脚本里）──",
        f"A. 文件覆盖率     {summary.file_pct:6.2f}%   "
        f"{summary.files_covered}/{summary.files} 个源文件至少执行过一行"
        f"   （历史口径 22%＝9/40，闸门 ≥ {args.min_files:.0f}%）",
        f"B. 全源集行覆盖率 {summary.line_pct:6.2f}%   "
        f"{summary.covered_lines}/{summary.total_lines} 行（未加载文件按 0% 计入）"
        f"   （闸门 ≥ {args.min_lines:.0f}%）",
        f"C. 已加载行覆盖率 {summary.loaded_line_pct:6.2f}%   "
        f"{summary.loaded_covered_lines}/{summary.loaded_total_lines} 行（仅诊断，不作闸门）",
        "",
        "未加载的源文件（这些文件的逻辑一行都没被执行过）：",
    ]
    missing = [f.rel for f in summary.details if not f.loaded]
    if missing:
        lines.extend(f"  - {rel}" for rel in missing)
    else:
        lines.append("  （无）")
    return "\n".join(lines)


def to_json(summary: Summary, args: argparse.Namespace) -> dict[str, Any]:
    return {
        "metric": {
            "file_coverage_pct": round(summary.file_pct, 2),
            "line_coverage_pct": round(summary.line_pct, 2),
            "loaded_line_coverage_pct": round(summary.loaded_line_pct, 2),
            "files": summary.files,
            "files_covered": summary.files_covered,
            "total_lines": summary.total_lines,
            "covered_lines": summary.covered_lines,
        },
        "gates": {
            "min_files": args.min_files,
            "min_lines": args.min_lines,
            "min_loaded_lines": args.min_loaded_lines,
            "failures": summary.failures,
            "passed": not summary.failures,
        },
        "files": [
            {
                "path": f.rel,
                "loaded": f.loaded,
                "line_pct": round(f.line_pct, 2),
                "covered_lines": f.covered_lines,
                "total_lines": f.total_lines,
                "branch_pct": round(f.branch_pct, 2),
                "function_pct": round(f.function_pct, 2),
            }
            for f in summary.details
        ],
    }


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="AutoGoo-Plugin TS coverage（文件/全源集/已加载 三口径 + 闸门）",
    )
    parser.add_argument("--root", default=None, help="仓库根（默认从脚本位置推导）")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而不是人读表格")
    parser.add_argument("--out", default=None, help="把 JSON 写到文件")
    parser.add_argument("--reuse", default=None, help="复用已有 coverage dump（不跑测试）")
    parser.add_argument("--list-sources", action="store_true", help="只列出源文件集（快）")
    parser.add_argument("--limit", type=int, default=0, help="表格最多显示多少行（0=全部）")
    parser.add_argument("--quiet", action="store_true", help="不转发测试输出")
    parser.add_argument("--no-gate", action="store_true", help="只测量，不判定（总是 exit 0）")
    parser.add_argument("--min-files", type=float, default=DEFAULT_MIN_FILES)
    parser.add_argument("--min-lines", type=float, default=DEFAULT_MIN_LINES)
    parser.add_argument(
        "--min-loaded-lines",
        type=float,
        default=DEFAULT_MIN_LOADED_LINES,
        help="已加载文件行覆盖率闸门（0=不启用；加载低覆盖文件会拉低它，默认只看不用）",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    root = Path(args.root).resolve() if args.root else repo_root_from(Path(__file__).resolve().parent)
    plugin_dir = root / PLUGIN_DIR
    if not plugin_dir.is_dir():
        raise SystemExit(f"找不到插件目录: {plugin_dir}")

    if args.list_sources:
        sources = iter_sources(plugin_dir)
        for path in sources:
            print(path.relative_to(plugin_dir).as_posix())
        print(f"\n共 {len(sources)} 个源文件")
        return 0

    if args.reuse:
        coverage = json.loads(Path(args.reuse).read_text("utf-8"))
    else:
        coverage = run_tests(root, plugin_dir, args.quiet)

    summary = build_summary(plugin_dir, coverage)
    if not args.no_gate:
        summary.failures = apply_gates(summary, args)

    payload = to_json(summary, args)
    if args.out:
        Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(render_table(summary, args.limit))
        print(render_summary(summary, args))
        print("")
        if summary.failures:
            for reason in summary.failures:
                print(f"✗ 闸门未通过：{reason}")
            print("\n复现：python3 skills/auto-goo/scripts/coverage-report.py")
            return 1
        print("✓ 闸门通过（A 文件覆盖率 / B 全源集行覆盖率）")
        print("复现：python3 skills/auto-goo/scripts/coverage-report.py")

    return 0 if (args.no_gate or not summary.failures) else 1


if __name__ == "__main__":
    sys.exit(main())

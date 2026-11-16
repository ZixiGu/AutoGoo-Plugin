#!/usr/bin/env python3
"""测量扩展的模块级测试覆盖率。

为什么需要这个脚本
------------------
本项目对覆盖率的估计错过两次，都是因为统计方式本身不严谨：

  第一次报 22%：只扫了 `from "../utils/x.js"` 这种**静态 import**，
                漏掉 `await import("...")`（面板测试全用动态 import 绕 pi-tui）
                和根目录模块（constants.ts / index.ts）。

  第二次报 33%：仍是同一个 bug，只补了一部分。

真实值是 69%。**度量口径错了，结论就全错** —— 这和 plan.started_at
被 wall-clock 覆盖导致耗时算出负数，是同一类问题（口径 ≠ 事实）。

口径定义
--------
- **分子**：被至少一个 `*.test.ts` 引用（静态或动态）的源文件
- **分母**：所有非测试源文件（`*.ts`，排除 `__tests__/` 与 `*.test.ts`）
- 判定按**模块名**（basename without .ts），不按路径 —— 文件名在本项目内唯一，
  且路径匹配会在目录调整后静默失效
- `index.ts` 作为入口必须单独检查（它没有调用方，只能被测试直接 import）

用法
----
  measure-coverage.py [root]            # 人类可读
  measure-coverage.py [root] --json     # 机器可读
  measure-coverage.py [root] --min 60   # 低于阈值退出 1（供 CI 用）
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_ROOT = Path(".pi/extensions/autogoo-plugin")

# 静态 import：from "../utils/x.js" / from "./x.js" / from "../constants.js"
STATIC_RE = re.compile(r'from\s+"(\.[^"]+)"')
# 动态 import("...")
DYNAMIC_RE = re.compile(r'import\(\s*"(\.[^"]+)"\s*\)')
# 裸模块名 import：from "x.js"
BARE_RE = re.compile(r'from\s+"([\w.-]+\.js)"')


def is_test_file(p: Path) -> bool:
    return "__tests__" in p.parts or p.name.endswith(".test.ts")


def collect_module_refs(path: Path) -> set[str]:
    """从测试文件里抽取它引用的模块名（basename 去掉 .ts）。"""
    names: set[str] = set()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return names
    for regex in (STATIC_RE, DYNAMIC_RE, BARE_RE):
        for m in regex.finditer(text):
            spec = m.group(1)
            base = spec.rsplit("/", 1)[-1]
            if base.endswith(".js"):
                names.add(base[:-3])
    return names


def measure(root: Path) -> dict:
    sources = [p for p in root.rglob("*.ts") if not is_test_file(p)]
    tests = [p for p in root.rglob("*.test.ts")]

    referenced: set[str] = set()
    per_test: dict[str, list[str]] = {}
    for t in tests:
        refs = collect_module_refs(t)
        per_test[t.relative_to(root).as_posix()] = sorted(refs)
        referenced |= refs

    covered, uncovered = [], []
    for p in sources:
        (covered if p.stem in referenced else uncovered).append(p.relative_to(root).as_posix())

    total = len(sources)
    pct = round(len(covered) / total * 100, 1) if total else 0.0
    return {
        "root": str(root),
        "total_sources": total,
        "covered": len(covered),
        "percent": pct,
        "uncovered": sorted(uncovered),
        "test_files": len(tests),
        "per_test": per_test,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("root", nargs="?", default=str(DEFAULT_ROOT))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--min", type=float, default=0, help="低于该百分比时 exit 1")
    args = ap.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        print(f"不是目录: {root}", file=sys.stderr)
        return 2

    r = measure(root)

    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(f"模块覆盖率: {r['percent']}%  ({r['covered']}/{r['total_sources']} 源文件有测试)")
        print(f"测试文件: {r['test_files']} 个")
        if r["uncovered"]:
            print(f"\n未被任何测试引用的模块（{len(r['uncovered'])}）:")
            for p in r["uncovered"]:
                print(f"  {p}")

    if args.min > 0 and r["percent"] < args.min:
        print(f"\n❌ 覆盖率 {r['percent']}% 低于阈值 {args.min}%", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

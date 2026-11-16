#!/usr/bin/env python3
"""Mutation check — prove the new tests actually catch bugs.

Why this exists
---------------
"新增测试反向验证能抓到注入的 bug" is an acceptance criterion that is easy to fake:
a test that asserts nothing meaningful still passes, and nobody notices until the
regression ships. This script mechanises the check: for each mutation it

1. verifies the file still contains the exact snippet it wants to break (so it never
   rewrites code it does not understand),
2. applies the mutation,
3. runs **only** the test file that is supposed to catch it,
4. requires the run to FAIL,
5. restores the original bytes and verifies the file hash is back to the original.

A mutation that leaves the test suite green is reported as ``未被抓到`` and the script
exits 1 — that means the corresponding test is decorative and must be strengthened.

Every mutation is a bug that would plausibly ship: dropping the width clamp, ignoring
DAG dependencies, freezing the scroll window, re-introducing the broken ANSI handling,
losing the "…" affordance, crashing a command handler, or wiring a command to a
missing handler.

Usage
-----
  mutation-check.py              # run all mutations
  mutation-check.py --list       # show the mutation table only
  mutation-check.py --only 3     # run a single mutation (1-based index)
"""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

PLUGIN_DIR = Path(".pi/extensions/autogoo-plugin")


@dataclass
class Mutation:
    """一处"看起来合理"的 bug 注入，以及它必须被哪个测试文件抓到。"""

    index: int
    target: str
    test: str
    note: str
    old: str
    new: str


MUTATIONS: list[Mutation] = [
    Mutation(
        index=1,
        target="utils/observe-tabs.ts",
        test="__tests__/observe-tabs.test.ts",
        note="env tab 的 kv() 去掉 fit → 长路径不再截断，必然超宽",
        old='const kv = (k: string, v: string) => L.push(fit(`  ${color(theme, "dim", k.padEnd(16))}${v}`, w));\n\n  kv("root", d.root);',
        new='const kv = (k: string, v: string) => L.push(`  ${color(theme, "dim", k.padEnd(16))}${v}`);\n\n  kv("root", d.root);',
    ),
    Mutation(
        index=2,
        target="utils/observe-tabs.ts",
        test="__tests__/observe-tabs.test.ts",
        note="computeReady 不再跳过非 pending 步骤 → ready/waiting 失真",
        old='    if (step.status !== "pending") continue;',
        new="    // mutation: 不再按状态过滤",
    ),
    Mutation(
        index=3,
        target="utils/observe-tabs.ts",
        test="__tests__/observe-tabs.test.ts",
        note="steps tab 窗口固定在 0 号 → 选中项滚出可视区（第一版面板的老 bug）",
        old="  const list = new ListState(windowSize, selected);\n  list.clamp(d.steps.length);",
        new="  const list = new ListState(windowSize, 0);\n  list.clamp(d.steps.length);",
    ),
    Mutation(
        index=4,
        target="utils/tui-kit.ts",
        test="__tests__/tui-kit.test.ts",
        note="truncateToWidth 不识别 ANSI（回到 2026-11 之前的半个转义序列 bug）",
        old="    const esc = ansiAt(text, i);",
        new="    const esc = null as string | null;",
    ),
    Mutation(
        index=5,
        target="utils/tui-kit.ts",
        test="__tests__/tui-kit.test.ts",
        note="keyHelp 丢项后不补 … → 用户看不出还有更多按键",
        old='  const text = list.length > 0 ? `${render(list)}  ·  …` : " …";',
        new='  const text = list.length > 0 ? render(list) : " ";',
    ),
    Mutation(
        index=6,
        target="commands/chat.ts",
        test="__tests__/commands-smoke.test.ts",
        note="命令 handler 里抛未捕获异常（pi 会因 uncaughtException 退出）",
        old="  const parts = splitArgs(args);\n  if (parts.length < 2) {",
        new='  const parts = splitArgs(args);\n  if (parts.length < 2) {\n    throw new TypeError("mutation: handler crash");',
    ),
    Mutation(
        index=7,
        target="index.ts",
        test="__tests__/extension-entry.test.ts",
        note="命令表指向不存在的 handler → 激活期 ReferenceError，所有 /goo-* 消失",
        old="    handler: handleGooBenchmark,",
        new="    handler: (undefined as any),",
    ),
]


def repo_root_from(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "package.json").is_file() and (candidate / "skills").is_dir():
            return candidate
    raise SystemExit(f"找不到仓库根（从 {start} 向上）")


def find_tsx(root: Path) -> Path:
    tsx = root / "node_modules/.bin/tsx"
    if not tsx.exists():
        raise SystemExit("找不到 node_modules/.bin/tsx（先 npm install）")
    return tsx


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_test(root: Path, plugin_dir: Path, test_file: str) -> tuple[bool, str]:
    """跑单个测试文件；返回 (是否通过, 输出尾部)。"""
    proc = subprocess.run(  # noqa: S603 - 固定参数，无 shell
        [str(find_tsx(root)), "--test", test_file],
        cwd=plugin_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode == 0, output[-1500:]


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AutoGoo-Plugin 测试反向验证（mutation check）")
    parser.add_argument("--root", default=None, help="仓库根（默认从脚本位置推导）")
    parser.add_argument("--list", action="store_true", help="只列出变更表")
    parser.add_argument("--only", type=int, default=None, help="只跑第 N 条（1 基）")
    args = parser.parse_args(list(argv) if argv is not None else None)

    root = Path(args.root).resolve() if args.root else repo_root_from(Path(__file__).resolve().parent)
    plugin_dir = root / PLUGIN_DIR
    if not plugin_dir.is_dir():
        raise SystemExit(f"找不到插件目录: {plugin_dir}")

    selected = [m for m in MUTATIONS if args.only is None or m.index == args.only]
    if not selected:
        raise SystemExit(f"没有第 {args.only} 条变更")

    if args.list:
        for m in selected:
            print(f"{m.index}. {m.target} → {m.test}\n   {m.note}")
        return 0

    escaped: list[Mutation] = []
    missing: list[Mutation] = []
    print(f"{'#':>2}  {'结果':<8} {'目标':<24} 说明")
    print("-" * 96)
    for m in selected:
        target = plugin_dir / m.target
        original = target.read_text("utf-8")
        before_hash = hashlib.sha256(original.encode()).hexdigest()
        if m.old not in original:
            missing.append(m)
            print(f"{m.index:>2}  {'跳过':<8} {m.target:<24} 找不到待替换片段（代码已变，需更新脚本）")
            continue

        mutated = original.replace(m.old, m.new, 1)
        try:
            target.write_text(mutated, "utf-8")
            passed, output = run_test(root, plugin_dir, m.test)
        finally:
            target.write_text(original, "utf-8")

        after_hash = sha256(target)
        if after_hash != before_hash:
            raise SystemExit(f"✗ 还原失败：{m.target} 哈希不一致，请手工 git diff 检查")

        if passed:
            escaped.append(m)
            print(f"{m.index:>2}  {'未抓到':<8} {m.target:<24} {m.note}")
            print(f"      ↳ 注入 bug 后 {m.test} 仍然全绿，说明该断言是装饰性的")
            print(f"      ↳ 测试输出尾部：{output.strip()[-400:]}")
        else:
            first_failure = ""
            for line in output.splitlines():
                if line.strip().startswith("✖") and "failing tests" not in line:
                    first_failure = line.strip()
                    break
            print(f"{m.index:>2}  {'已抓到':<8} {m.target:<24} {m.note}")
            if first_failure:
                print(f"      ↳ 抓它的用例：{first_failure}")

    print("-" * 96)
    caught = len(selected) - len(escaped) - len(missing)
    print(f"抓到 {caught}/{len(selected)}；逃逸 {len(escaped)}；跳过 {len(missing)}")
    if escaped:
        print("\n✗ 有 bug 注入没有被测试拦住 —— 对应测试需要加强（不是放宽）")
        return 1
    if missing:
        print("\n⚠ 有变更因代码移动被跳过 —— 请更新 MUTATIONS 里的片段")
        return 1
    print("\n✓ 每条注入的 bug 都被测试抓到，且文件已按哈希确认还原")
    return 0


if __name__ == "__main__":
    sys.exit(main())

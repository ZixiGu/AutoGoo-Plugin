#!/usr/bin/env python3
"""文档引用一致性扫描器（只读）。

抽取 Markdown 文档里对 `.py` 脚本与 `goo-*` 命令的引用，与仓库里的实际实现比对，
把"表格/正文引用"和"代码块示例/占位符"分开，只对前者强制存在性。

为什么需要它：文档把不存在的脚本写成 evaluator 工具（`packet-validate.py`）时，
Subagent 会照着文档去调用一个永远找不到的文件；这类悬空引用只有人工通读才抓得到。

判定规则（全部是**上下文识别**，没有文件名白名单）：

脚本引用 `.py`
  - basename 命中 `skills/auto-goo/scripts/` → ok
  - 占位符 token（`xxx`/`<...>`/`...`/`*`/`{{...}}`）→ 豁免（模板占位）
  - 代码块内且 token 不带 `scripts/` 前缀 → 豁免（示例命令、mock 输出、用户自己的 step 名）
  - 代码块内但带 `scripts/` 前缀 → **仍强制**（项目路径写法没有歧义，写错就是悬空）
  - 绝对路径且首段不是 `skills`/`scripts`（如 `/src/parser/baseline.py`）→ 豁免（用户项目路径示例）
  - 同行带示例标记（`例如`/`示例`/`e.g.`/`for example` …）→ 豁免
  - 其余 → **悬空引用**

命令引用 `/goo-*`、`/auto-goo:goo-*`
  - 命中 `commands/*.md`（Claude Code slash command）→ ok
  - 只命中 pi 扩展命令表 → info（pi 独有），但 README 平台表必须同时声明它 pi 独有
  - 占位符（`/goo-xxx`）/ 后面紧跟 `.` 或 `/`（其实是 `goo-ssh.sh` 这类文件名）→ 豁免
  - 其余 → **悬空命令**

用法：
    python3 doc-ref-check.py             # 扫描仓库文档
    python3 doc-ref-check.py --json      # 机器可读输出
    python3 doc-ref-check.py --self-test # 反向验证：注入悬空引用必须报红
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

# ── 扫描范围（相对仓库根）──
DOC_GLOBS = (
    "README.md",
    "skills/auto-goo/SKILL.md",
    "skills/auto-goo/references/**/*.md",
    "commands/*.md",
    "agents/**/*.md",
    "docs/**/*.md",
)

SCRIPTS_DIR = Path("skills/auto-goo/scripts")
COMMANDS_DIR = Path("commands")
PI_INDEX = Path(".pi/extensions/autogoo-plugin/index.ts")
README = Path("README.md")

# ── 上下文识别用的模式 ──
FENCE_RE = re.compile(r"^(\s*)(`{3,}|~{3,})(.*)$")
# 只吃路径字符，避免把中文括号/标点带进 token
SCRIPT_TOKEN_RE = re.compile(r"[A-Za-z0-9_$<>{}~/.*\\-]*[A-Za-z0-9_-]\.py(?![A-Za-z0-9_])")
COMMAND_TOKEN_RE = re.compile(r"(?<![\w./:$-])/(?:auto-goo:)?(goo-[a-z0-9-]+)")
PLACEHOLDER_RE = re.compile(r"xxx|XXX|\.\.\.|<[^<>]*>|\*|\{\{|\}\}|NAME|名称")
EXAMPLE_MARKERS = (
    "例如",
    "示例",
    "举例",
    "比如",
    "例：",
    "e.g.",
    "for example",
    "illustrative",
    "示范",
)
PI_ONLY_MARKERS = ("pi 独有", "pi独有", "pi-only", "PI 独有")
PI_KEY_RE = re.compile('^\\s*"(goo-[a-z0-9-]+)":\\s*\\{', re.M)


@dataclass
class Ref:
    """一条文档引用及其判定结果。"""

    path: str
    lineno: int
    kind: str  # script | command
    token: str
    code_block: bool
    verdict: str  # ok | exempt | info | dangling
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "lineno": self.lineno,
            "kind": self.kind,
            "token": self.token,
            "code_block": self.code_block,
            "verdict": self.verdict,
            "reason": self.reason,
        }


@dataclass
class Index:
    """仓库实际实现索引。"""

    root: Path
    scripts: set[str] = field(default_factory=set)
    commands: set[str] = field(default_factory=set)
    pi_commands: set[str] = field(default_factory=set)

    @property
    def all_commands(self) -> set[str]:
        return self.commands | self.pi_commands


def build_index(root: Path) -> Index:
    index = Index(root=root)
    scripts_dir = root / SCRIPTS_DIR
    if scripts_dir.is_dir():
        index.scripts = {p.name for p in scripts_dir.iterdir() if p.is_file()}
    commands_dir = root / COMMANDS_DIR
    if commands_dir.is_dir():
        index.commands = {p.stem for p in commands_dir.glob("*.md")}
    pi_index = root / PI_INDEX
    if pi_index.is_file():
        index.pi_commands = set(PI_KEY_RE.findall(pi_index.read_text(encoding="utf-8")))
    return index


def iter_docs(root: Path) -> list[Path]:
    seen: list[Path] = []
    for pattern in DOC_GLOBS:
        for path in sorted(root.glob(pattern)):
            if path.is_file() and path not in seen:
                seen.append(path)
    return seen


def _has_example_marker(line: str) -> bool:
    return any(marker in line for marker in EXAMPLE_MARKERS)


def _is_placeholder(token: str) -> bool:
    return bool(PLACEHOLDER_RE.search(token))


def _is_foreign_path(token: str) -> bool:
    """绝对路径示例：`/src/parser/baseline.py` 属于用户项目，不是插件脚本。"""
    if not token.startswith("/"):
        return False
    head = token.lstrip("/").split("/", 1)[0]
    return head not in {"skills", "scripts"}


def _split_frontmatter_free(text: str) -> Iterable[tuple[int, str, bool]]:
    """逐行产出 (行号, 内容, 是否在围栏代码块内)。"""
    in_code = False
    fence_marker = ""
    for lineno, line in enumerate(text.splitlines(), 1):
        match = FENCE_RE.match(line)
        if match:
            marker = match.group(2)
            if not in_code:
                in_code = True
                fence_marker = marker[0] * 3
            elif marker.startswith(fence_marker):
                in_code = False
                fence_marker = ""
            continue
        yield lineno, line, in_code


def scan_file(path: Path, rel: str, index: Index) -> list[Ref]:
    refs: list[Ref] = []
    text = path.read_text(encoding="utf-8")
    for lineno, line, in_code in _split_frontmatter_free(text):
        example_context = _has_example_marker(line)

        for match in SCRIPT_TOKEN_RE.finditer(line):
            token = match.group(0)
            basename = token.rsplit("/", 1)[-1]
            if basename in index.scripts:
                verdict, reason = "ok", "scripts/ 下存在"
            elif _is_placeholder(token):
                verdict, reason = "exempt", "占位符 token"
            elif in_code and "scripts/" not in token:
                verdict, reason = "exempt", "代码块示例/mock 输出"
            elif _is_foreign_path(token):
                verdict, reason = "exempt", "用户项目路径示例"
            elif example_context:
                verdict, reason = "exempt", "同行示例标记"
            else:
                verdict, reason = "dangling", "scripts/ 下不存在"
            refs.append(Ref(rel, lineno, "script", token, in_code, verdict, reason))

        for match in COMMAND_TOKEN_RE.finditer(line):
            name = match.group(1).rstrip("-")
            if not name:
                continue
            token = match.group(0)
            tail = line[match.end() : match.end() + 1]
            if name in index.commands:
                verdict, reason = "ok", "commands/ 下有 slash command"
            elif name in index.pi_commands:
                verdict, reason = "info", "pi 独有命令（需 README 平台表声明）"
            elif _is_placeholder(token) or tail in {".", "/"}:
                verdict, reason = "exempt", "占位符或文件名片段"
            elif example_context:
                verdict, reason = "exempt", "同行示例标记"
            else:
                verdict, reason = "dangling", "既无 slash command 也不在 pi 命令表"
            refs.append(Ref(rel, lineno, "command", token, in_code, verdict, reason))
    return refs


def check_pi_only_declared(index: Index, refs: list[Ref]) -> list[Ref]:
    """pi 独有命令必须在 README 平台对比表里被标注 pi 独有。"""
    readme = index.root / README
    if not readme.is_file():
        return [
            Ref(str(README), 0, "command", name, False, "dangling", "README.md 缺失，pi 独有命令无处标注")
            for name in sorted(index.pi_commands - index.commands)
        ]
    lines = readme.read_text(encoding="utf-8").splitlines()
    issues: list[Ref] = []
    for name in sorted(index.pi_commands - index.commands):
        declared = False
        for lineno, line in enumerate(lines, 1):
            if name not in line:
                continue
            if any(marker in line for marker in PI_ONLY_MARKERS):
                declared = True
                break
        if not declared:
            issues.append(
                Ref(
                    str(README),
                    0,
                    "command",
                    "/" + name,
                    False,
                    "dangling",
                    "pi 独有命令未在 README 平台表标注 pi 独有（Claude Code 用户会以为能直接用）",
                )
            )
    return issues


def scan(root: Path) -> tuple[list[Ref], Index]:
    index = build_index(root)
    refs: list[Ref] = []
    for path in iter_docs(root):
        refs.extend(scan_file(path, path.relative_to(root).as_posix(), index))
    refs.extend(check_pi_only_declared(index, refs))
    return refs, index


def summarize(refs: list[Ref]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for ref in refs:
        counts[ref.verdict] = counts.get(ref.verdict, 0) + 1
    return counts


def print_report(refs: list[Ref], index: Index) -> int:
    dangling = [r for r in refs if r.verdict == "dangling"]
    counts = summarize(refs)
    print(
        "doc-ref-check: {0} 处引用（ok={1} exempt={2} info={3} dangling={4}）".format(
            len(refs),
            counts.get("ok", 0),
            counts.get("exempt", 0),
            counts.get("info", 0),
            counts.get("dangling", 0),
        )
    )
    if dangling:
        for ref in dangling:
            kind = "脚本" if ref.kind == "script" else "命令"
            location = ref.path if ref.lineno == 0 else "{0}:{1}".format(ref.path, ref.lineno)
            print("  ✗ {0}  {1}  [{2}] {3}".format(location, ref.token, kind, ref.reason))
    else:
        print("  ✓ 文档里的脚本/命令引用全部可解析")
    info = [r for r in refs if r.verdict == "info"]
    if info:
        uniq = sorted({r.token for r in info})
        print("  ℹ pi 独有命令引用 {0} 种：{1}".format(len(uniq), ", ".join(uniq)))
    return 1 if dangling else 0


# ── 反向验证：注入悬空引用必须报红 ──


SELF_TEST_CASES: dict[str, tuple[str, int, int]] = {
    # 文件名 -> (内容, 期望 dangling 脚本数, 期望 dangling 命令数)
    "docs/01-table.md": ("| 脚本 | 说明 |\n|---|---|\n| `goo-real.py` | 存在 |\n", 0, 0),
    "docs/02-dangling-script.md": ("运行 `missing-script.py` 做校验。\n", 1, 0),
    "docs/03-code-example.md": ("```bash\npython script.py --help\n```\n", 0, 0),
    "docs/04-code-project-path.md": (
        "```bash\npython3 skills/auto-goo/scripts/ghost-tool.py\n```\n",
        1,
        0,
    ),
    "docs/05-dangling-command.md": ("用 `/goo-ghost` 触发流程。\n", 0, 1),
    "docs/06-placeholder.md": ("把 `/goo-xxx` 替换成真实命令。\n", 0, 0),
    "docs/07-example-marker.md": ("例如 `train.py` 这类业务脚本。\n", 0, 0),
    "docs/08-foreign-path.md": ("| 代码文件 | 传递文件路径 | `/src/parser/baseline.py` |\n", 0, 0),
}

SELF_TEST_FILES: dict[str, str] = {
    "skills/auto-goo/scripts/goo-real.py": "#!/usr/bin/env python3\n",
    "commands/goo-real.md": "# /goo-real\n",
    ".pi/extensions/autogoo-plugin/index.ts": (
        "const COMMANDS = {\n"
        '  "goo-real": {\n    handler: x,\n  },\n'
        '  "goo-chat": {\n    handler: x,\n  },\n'
        '  "goo-alias": {\n    handler: x,\n  },\n'
        "};\n"
    ),
    "README.md": "| 跨 session 对话 | ✗ | ✗ | ✅ `goo-chat`（**pi 独有**） |\n",
}

SELF_TEST_DECLARED_README = SELF_TEST_FILES["README.md"] + "| `goo-alias`（pi 独有） |\n"


def _write_tree(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def run_self_test() -> int:
    """注入已知悬空引用，验证扫描器会报红、且示例词不误报。"""
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="doc-ref-selftest-") as tmp:
        root = Path(tmp)
        _write_tree(root, SELF_TEST_FILES)
        _write_tree(root, {rel: content for rel, (content, _, _) in SELF_TEST_CASES.items()})
        refs, _ = scan(root)
        dangling_scripts = [r for r in refs if r.verdict == "dangling" and r.kind == "script"]
        dangling_commands = [r for r in refs if r.verdict == "dangling" and r.kind == "command"]
        for rel, (_, want_script, want_command) in SELF_TEST_CASES.items():
            got_script = [r for r in dangling_scripts if r.path == rel]
            got_command = [r for r in dangling_commands if r.path == rel]
            if len(got_script) != want_script:
                failures.append(
                    "{0}: 期望 {1} 个悬空脚本引用，实际 {2}".format(rel, want_script, len(got_script))
                )
            if len(got_command) != want_command:
                failures.append(
                    "{0}: 期望 {1} 个悬空命令引用，实际 {2}".format(rel, want_command, len(got_command))
                )

        # pi 独有命令未在 README 声明 -> 必须报红
        loose = [r for r in dangling_commands if r.path == "README.md"]
        if len(loose) != 1 or "goo-alias" not in loose[0].token:
            failures.append("pi 独有命令未在 README 声明时未报红（实际：{0}）".format(
                [r.token for r in dangling_commands if r.path == "README.md"]
            ))

        # 声明后必须转绿（docs/05 注入的 /goo-ghost 仍应报红，只放过 pi 独有命令）
        (root / "README.md").write_text(SELF_TEST_DECLARED_README, encoding="utf-8")
        refs2, _ = scan(root)
        remaining = [
            r
            for r in refs2
            if r.verdict == "dangling" and r.kind == "command" and r.path == "README.md"
        ]
        if remaining:
            failures.append(
                "README 标注 pi 独有后仍报红：{0}".format([r.token for r in remaining])
            )

    if failures:
        print("doc-ref-check --self-test: 失败")
        for item in failures:
            print("  ✗ " + item)
        return 1
    print("doc-ref-check --self-test: 通过（悬空脚本/命令/pi 标注均能报红，示例词零误报）")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="文档引用一致性扫描（只读）")
    parser.add_argument("--root", default=None, help="仓库根目录（默认按脚本位置推导）")
    parser.add_argument("--json", action="store_true", help="输出机器可读结果")
    parser.add_argument("--self-test", action="store_true", help="反向验证扫描器本身")
    args = parser.parse_args(argv)

    if args.self_test:
        return run_self_test()

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[3]
    if not root.is_dir():
        print("doc-ref-check: 根目录不存在: {0}".format(root))
        return 2

    refs, index = scan(root)
    if args.json:
        payload = {
            "root": root.as_posix(),
            "docs_scanned": len(iter_docs(root)),
            "scripts_indexed": len(index.scripts),
            "commands_indexed": len(index.commands),
            "pi_commands_indexed": len(index.pi_commands),
            "counts": summarize(refs),
            "refs": [r.as_dict() for r in refs],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 1 if any(r.verdict == "dangling" for r in refs) else 0
    return print_report(refs, index)


if __name__ == "__main__":
    raise SystemExit(main())

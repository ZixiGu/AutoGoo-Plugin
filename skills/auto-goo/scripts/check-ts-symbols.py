#!/usr/bin/env python3
"""Static check: undefined identifiers in the Pi extension's TypeScript.

Why this exists
---------------
`node --experimental-strip-types --check` only parses syntax, and `esbuild
--bundle` only resolves modules. **Neither catches an undefined identifier.**
That is how `logInfo is not defined` shipped: the call was added but the import
was not, the bundle succeeded, and pi failed to load the extension at startup.

`tsc --noEmit` would catch it, but TypeScript is not always available in the
environments where `check-plugin.sh` runs, so this script does a focused
approximation:

  * strip comments, strings and template literals;
  * collect bare calls `name(` that are NOT property access (`x.name(`);
  * a call is OK if the name is
      - imported in this file,
      - declared in this file (function/const/let/var/class/type alias),
      - a parameter or destructured binding we can see,
      - a known global / keyword.

False negatives are acceptable; **false positives are not** (they would block
commits), so the whitelist is generous.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

KNOWN_GLOBALS = {
    # JS / Node
    "Array", "ArrayBuffer", "BigInt", "Boolean", "Buffer", "DataView", "Date",
    "Error", "EvalError", "Function", "Infinity", "Intl", "JSON", "Map", "Math",
    "NaN", "Number", "Object", "Promise", "Proxy", "RangeError", "ReferenceError",
    "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError", "TypeError",
    "URIError", "URL", "URLSearchParams", "WeakMap", "WeakSet",
    "clearInterval", "clearTimeout", "console", "decodeURIComponent",
    "encodeURIComponent", "fetch", "globalThis", "isFinite", "isNaN", "parseFloat",
    "parseInt", "process", "queueMicrotask", "require", "setImmediate",
    "setInterval", "setTimeout", "structuredClone", "undefined",
    "AbortController", "AbortSignal", "TextDecoder", "TextEncoder",
    # 语言关键字里会带括号的
    "catch", "delete", "do", "else", "for", "function", "if", "in", "instanceof",
    "new", "of", "return", "switch", "throw", "try", "typeof", "void", "while",
    "with", "yield", "await", "async", "super", "this", "import", "export", "constructor",
}

DECL_RE = re.compile(
    r"\b(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)"
)
IMPORT_RE = re.compile(r"import\s+(?:type\s+)?\{([^}]*)\}\s+from", re.S)
IMPORT_NS_RE = re.compile(r"import\s+(?:type\s+)?\*?\s*as\s+([A-Za-z_$][\w$]*)\s+from")
DEFAULT_IMPORT_RE = re.compile(r"import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from")
PARAM_RE = re.compile(r"\(([^()]*)\)\s*(?::\s*[^=>{]+)?\s*=>")
BARE_CALL_RE = re.compile(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(")


def strip_noise(src: str) -> str:
    """去掉注释、字符串、模板字符串，避免把文字当成代码。"""
    out: list[str] = []
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        # 行注释（保留换行，行号才能对齐原文）
        if ch == "/" and nxt == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        # 块注释
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            i += 2
            continue
        # 正则字面量：靠前一个有效字符判断（`/` 在 ( , = : [ ! & | ? { } ; 之后视为正则）
        if ch == "/" and nxt not in ("/", "*"):
            prev = ""
            for back in range(len("".join(out)) - 1, -1, -1):
                if not "".join(out)[back].isspace():
                    prev = "".join(out)[back]
                    break
            starts_regex = prev in ("", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", ">")
            if not starts_regex:
                # 检查是否是 `return /.../`
                tail = "".join(out)[-12:]
                starts_regex = tail.rstrip().endswith("return")
            if starts_regex:
                i += 1
                in_class = False
                while i < n:
                    if src[i] == "\\":
                        i += 2
                        continue
                    if src[i] == "[":
                        in_class = True
                    elif src[i] == "]":
                        in_class = False
                    elif src[i] == "/" and not in_class:
                        i += 1
                        break
                    elif src[i] == "\n":
                        break
                    i += 1
                while i < n and src[i].isalpha():
                    i += 1  # flags: gimsuy
                continue
        # 字符串 / 模板字符串
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            while i < n:
                if src[i] == "\\":
                    out.append("\n" if src[i] == "\n" else " ")
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def collect_declared(code: str) -> set[str]:
    declared: set[str] = set(DECL_RE.findall(code))
    for group in IMPORT_RE.findall(code):
        for item in group.split(","):
            name = item.strip().split(" as ")[-1].strip()
            if name:
                declared.add(name)
    declared |= set(IMPORT_NS_RE.findall(code))
    declared |= set(DEFAULT_IMPORT_RE.findall(code))
    # 箭头函数/方法的参数列表（粗粒度，宁可漏报）
    for group in PARAM_RE.findall(code):
        for part in group.split(","):
            token = part.strip()
            if not token:
                continue
            token = token.split(":")[0].strip()
            token = token.lstrip(".")
            name = re.match(r"^\{?\s*([A-Za-z_$][\w$]*)", token)
            if name:
                declared.add(name.group(1))
    # 形如 `onWriteConfig: (provider, model) => Promise<boolean>,` 的函数类型参数
    for name in re.findall(r"\b([A-Za-z_$][\w$]*)\s*:\s*\([^()]*\)\s*=>", code):
        declared.add(name)
    # 对象/类的方法简写：`async execute(...) {` / `render(width) {`
    for name in re.findall(r"(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^{;]+)?\{", code):
        declared.add(name)
    # 解构/对象字面量属性简写：`{ a, b }` 与 `(x) =>`
    declared |= set(re.findall(r"\b(?:const|let|var)\s*\{([^}]*)\}", code) and [])
    for group in re.findall(r"\b(?:const|let|var)\s*\{([^}]*)\}", code):
        for part in group.split(","):
            name = part.strip().split(":")[0].strip().split("=")[0].strip()
            if re.match(r"^[A-Za-z_$][\w$]*$", name):
                declared.add(name)
    return declared


def strip_type_declarations(code: str) -> str:
    """删掉 interface/type 声明块：里面的 `select(...): Promise<...>;` 是类型签名，
    不是调用，扫进来会产生大量误报。"""
    out = code
    # interface X { ... }（按大括号配平）
    for match in list(re.finditer(r"\binterface\s+[A-Za-z_$][\w$]*(?:\s+extends\s+[^{]+)?\{", out)):
        start = match.end() - 1
        depth = 0
        end = start
        for idx in range(start, len(out)):
            if out[idx] == "{":
                depth += 1
            elif out[idx] == "}":
                depth -= 1
                if depth == 0:
                    end = idx + 1
                    break
        chunk = out[match.start():end]
        out = out[: match.start()] + "".join("\n" if c == "\n" else " " for c in chunk) + out[end:]
    # type X = { ... };  与  type X = A | B;
    out = re.sub(
        r"\btype\s+[A-Za-z_$][\w$]*(?:<[^>]*>)?\s*=[^;]*;",
        lambda m: "".join("\n" if c == "\n" else " " for c in m.group(0)),
        out,
    )
    return out


def matching_paren(code: str, open_idx: int) -> int:
    """返回与 code[open_idx]=='(' 匹配的 ')' 下标；找不到返回 -1。"""
    depth = 0
    for idx in range(open_idx, len(code)):
        if code[idx] == "(":
            depth += 1
        elif code[idx] == ")":
            depth -= 1
            if depth == 0:
                return idx
    return -1


def looks_like_signature(code: str, call_start: int) -> bool:
    """`name(...)` 后面跟 `{` 或 `: Type;` → 是方法/类型签名，不是调用。"""
    open_idx = code.find("(", call_start)
    if open_idx < 0:
        return False
    close_idx = matching_paren(code, open_idx)
    if close_idx < 0:
        return False
    rest = code[close_idx + 1 : close_idx + 400].lstrip()
    if rest.startswith("{"):
        return True  # 方法定义
    # 调用后面永远不会直接跟 `:`；跟 `:` 的一律是「返回值类型注解」，
    # 即方法定义（`subscribe(...): void {`）或接口签名（`select(...): Promise<X>;`）。
    return rest.startswith(":")


# 全大写常量引用（UPPER_SNAKE）：作为**变量**使用（传参、赋值、比较），
# 不是函数调用，BARE_CALL_RE 扫不到。
# 回归：GOO_STATUS_PY 在 tools-execution.ts 里被使用但未 import，
# `auto_goo_dag_status` 一调用就 ReferenceError，而检查器当时报「全部通过」。
CONST_REF_RE = re.compile(r"(?<![.\w$])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b")


def scan(path: Path) -> list[str]:
    code = strip_type_declarations(strip_noise(path.read_text(encoding="utf-8")))
    declared = collect_declared(code)
    problems: list[str] = []
    for match in BARE_CALL_RE.finditer(code):
        name = match.group(1)
        if name in declared or name in KNOWN_GLOBALS:
            continue
        if looks_like_signature(code, match.start()):
            continue
        line = code[: match.start()].count("\n") + 1
        problems.append(f"{path}:{line} {name}(…)")
    # 常量引用：同样要求已声明/已导入
    seen: set[str] = set()
    for match in CONST_REF_RE.finditer(code):
        name = match.group(1)
        if name in declared or name in KNOWN_GLOBALS or name in seen:
            continue
        # 对象字面量键名 / 类型字段（`{ FOO: "1" }`、`FOO?: string`）不是引用
        tail = code[match.end() : match.end() + 2]
        if tail.startswith(":") or tail.startswith("?"):
            continue
        seen.add(name)
        line = code[: match.start()].count("\n") + 1
        problems.append(f"{path}:{line} {name} (undefined constant)")
    return problems


def main(argv: list[str]) -> int:
    roots = [Path(a) for a in argv[1:]] or [Path(".pi/extensions/autogoo-plugin")]
    problems: list[str] = []
    for root in roots:
        for path in sorted(root.rglob("*.ts")):
            if "__tests__" in path.parts:
                continue
            problems.extend(scan(path))

    if problems:
        print("undefined identifiers (would throw at runtime):", file=sys.stderr)
        for item in problems:
            print(f"  ✗ {item}", file=sys.stderr)
        return 1
    print("no undefined identifiers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

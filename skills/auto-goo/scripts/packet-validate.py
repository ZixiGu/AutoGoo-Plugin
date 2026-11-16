#!/usr/bin/env python3
"""校验分析型 Subagent 回传的 Evidence-Packet JSON。

协议出处：`references/execution-engine.md` 的 "Evidence-Packet 协议"。
分析型 Subagent（researcher / evaluator / auditor / collector）回传的 packet 必须紧凑，
主模型直接综合而不重读全文；形状不对时主模型会漏读证据或把 change_list 当散文猜。

契约（按协议原文）：
  - `purpose`           必填，非空字符串
  - `findings[]`        必填，非空数组；每项 `claim` / `evidence_path` / `confidence`
  - `change_list[]`     可选（collector 场景可缺）；存在时每项 `target` / `action` / `why`，
                        `detail` 缺省时给警告（不同文档口径不一致，不判死）

`confidence` 接受 0~1 的数字，或 `high` / `medium` / `low`。

用法：
    python3 packet-validate.py .goo/threads/<id>/artifacts/step-3-packet.json
    python3 packet-validate.py packet.json --json
    cat packet.json | python3 packet-validate.py -
    python3 packet-validate.py packet.json --require-change-list   # 评审型 packet
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

CONFIDENCE_WORDS = {"high", "medium", "low"}
FINDING_FIELDS = ("claim", "evidence_path", "confidence")
CHANGE_FIELDS_REQUIRED = ("target", "action", "why")
CHANGE_FIELDS_OPTIONAL = ("detail",)
KNOWN_TOP_LEVEL = (
    "purpose",
    "findings",
    "change_list",
    "step_id",
    "agent",
    "subagent",
    "thread_id",
    "generated_at",
    "notes",
)


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _is_path_like(value: str) -> bool:
    """evidence_path 必须是可追溯路径（含目录分隔符或 .goo/ 前缀），不能是散文。"""
    stripped = value.strip()
    return "/" in stripped or "\\" in stripped or stripped.startswith(".")


def validate_packet(data: Any, require_change_list: bool = False) -> tuple[list[str], list[str]]:
    """返回 (errors, warnings)。"""
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(data, dict):
        return ["packet 顶层必须是 JSON object，实际是 {0}".format(type(data).__name__)], []

    # 兼容包一层 {"packet": {...}} 的信封写法
    if "purpose" not in data and isinstance(data.get("packet"), dict):
        data = data["packet"]

    if not _nonempty_str(data.get("purpose")):
        errors.append("缺少非空 purpose（packet 要说明这次分析为解决什么问题）")

    findings = data.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings 必须是非空数组（没有 findings 的 packet 无法被综合）")
        findings = []
    for idx, finding in enumerate(findings):
        where = "findings[{0}]".format(idx)
        if not isinstance(finding, dict):
            errors.append("{0} 必须是 object".format(where))
            continue
        for name in FINDING_FIELDS:
            if name not in finding:
                errors.append("{0} 缺少 {1}".format(where, name))
        claim = finding.get("claim")
        if "claim" in finding and not _nonempty_str(claim):
            errors.append("{0}.claim 必须是非空字符串".format(where))
        evidence = finding.get("evidence_path")
        if "evidence_path" in finding:
            if not _nonempty_str(evidence):
                errors.append("{0}.evidence_path 必须是非空字符串".format(where))
            elif not _is_path_like(evidence):
                errors.append(
                    "{0}.evidence_path 必须是可追溯路径（含目录分隔符），实际是 {1!r}".format(
                        where, evidence
                    )
                )
        if "confidence" in finding:
            confidence = finding.get("confidence")
            if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
                if not (isinstance(confidence, str) and confidence.lower() in CONFIDENCE_WORDS):
                    errors.append(
                        "{0}.confidence 必须是 0~1 的数字或 high/medium/low，实际是 {1!r}".format(
                            where, confidence
                        )
                    )
            elif not 0 <= float(confidence) <= 1:
                errors.append("{0}.confidence 数字必须在 0~1，实际是 {1}".format(where, confidence))

    change_list = data.get("change_list")
    if change_list is None:
        if require_change_list:
            errors.append("change_list 缺失（本模式要求给出可执行改动清单）")
    elif not isinstance(change_list, list):
        errors.append("change_list 必须是数组")
    elif require_change_list and not change_list:
        errors.append("change_list 为空（本模式要求给出可执行改动清单）")
    else:
        for idx, change in enumerate(change_list):
            where = "change_list[{0}]".format(idx)
            if not isinstance(change, dict):
                errors.append("{0} 必须是 object".format(where))
                continue
            for name in CHANGE_FIELDS_REQUIRED:
                if name not in change:
                    errors.append("{0} 缺少 {1}".format(where, name))
                elif not _nonempty_str(change.get(name)):
                    errors.append("{0}.{1} 必须是非空字符串".format(where, name))
            for name in CHANGE_FIELDS_OPTIONAL:
                if name not in change:
                    warnings.append("{0} 未写 {1}（建议补充改动细节）".format(where, name))

    for key in data:
        if key not in KNOWN_TOP_LEVEL:
            warnings.append("未知字段 {0}（拼错会让主模型漏读）".format(key))

    return errors, warnings


def load_packet(path_arg: str) -> Any:
    if path_arg == "-":
        return json.load(sys.stdin)
    path = Path(path_arg)
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验 Evidence-Packet JSON 形状")
    parser.add_argument("paths", nargs="+", help="packet JSON 路径，'-' 表示 stdin")
    parser.add_argument("--require-change-list", action="store_true", help="要求给出 change_list")
    parser.add_argument("--strict", action="store_true", help="把警告也视为失败")
    parser.add_argument("--json", action="store_true", help="输出机器可读结果")
    args = parser.parse_args(argv)

    results: list[dict[str, Any]] = []
    failed = False
    for path_arg in args.paths:
        try:
            data = load_packet(path_arg)
        except (OSError, json.JSONDecodeError) as exc:
            errors, warnings = ["无法读取或解析 JSON：{0}".format(exc)], []
        else:
            errors, warnings = validate_packet(data, require_change_list=args.require_change_list)
        ok = not errors and not (args.strict and warnings)
        failed = failed or not ok
        results.append(
            {
                "path": path_arg,
                "ok": ok,
                "errors": errors,
                "warnings": warnings,
            }
        )

    if args.json:
        print(json.dumps({"ok": not failed, "results": results}, ensure_ascii=False, indent=2))
        return 1 if failed else 0

    for item in results:
        label = item["path"]
        if item["ok"]:
            print("packet valid: {0}".format(label))
        else:
            print("packet invalid: {0}".format(label))
        for error in item["errors"]:
            print("  - {0}".format(error))
        for warning in item["warnings"]:
            print("  ! {0}".format(warning))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Update one AutoGoo-Plugin plan step status, progress, and heartbeat."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

from _paths import (
    compute_plan_status,
    dump_json,
    find_config_dir,
    load_json,
    logs_dir_from_plan,
    now,
    project_root_from_config_dir,
    project_root_from_plan,
    resolve_plan_path,
    workspace_paths,
)


def safe_name(value: Any, limit: int = 48) -> str:
    """Convert a value to a safe filename fragment."""
    text = str(value or "step").strip()
    text = re.sub(r"[^\w.\-]+", "_", text, flags=re.UNICODE).strip("_")
    return (text or "step")[:limit]


def _resolve_step(data: dict[str, Any], step_id: str) -> dict[str, Any]:
    for step in data.get("steps", []):
        if str(step.get("id")) == step_id:
            return step
    raise SystemExit(f"step id not found: {step_id}")


def precreate_step_log(plan_path: Path, step_id: str, dispatch_note: str | None = None) -> Path:
    """Main-Agent pre-dispatch hook: ensure the step log file exists and is populated.

    Creates logs/{timestamp}_step-{id}_{name}.md with a dispatch skeleton
    (dispatched_at, subagent role, allowlists, expected outputs, dispatch note)
    so that even if the Subagent never heartbeats we still have evidence the
    step was dispatched. Writes the resolved path back into plan.json under
    steps[i].log_path so the Subagent and subsequent updates reuse it.
    """
    data = load_json(plan_path)
    step = _resolve_step(data, step_id)
    stamp = now()
    log_path = ensure_log_path(plan_path, step, stamp)
    project_root = project_root_from_plan(plan_path)
    is_new = not log_path.exists()
    if is_new:
        body = [
            f"# Step {step.get('id')} - {step.get('name', '')}",
            "",
            f"- step_id: {step.get('id')}",
            f"- name: {step.get('name', '')}",
            f"- subagent: {step.get('subagent', '')}",
            f"- task_agent: {step.get('task_agent', '')}",
            f"- dispatched_at: {stamp}",
            "",
            "## Dispatch Skeleton (precreated by Main Agent)",
            "",
            "Main Agent dispatched this step and precreated this log skeleton.",
            "The Subagent MUST heartbeat + append context before writing the first",
            "line of code, otherwise the Main Agent's post-check will mark this",
            "step as `dispatch_no_log`.",
            "",
            "### Plan context",
            f"- cwd: {project_root}",
            f"- plan: {plan_path}",
            f"- allowed_read_paths: {step.get('allowed_read_paths', [])}",
            f"- allowed_write_paths: {step.get('allowed_write_paths', [])}",
            f"- declared_outputs: {step.get('outputs', [])}",
            f"- output: {step.get('output', '')}",
            f"- validation: {step.get('validation', '')}",
            f"- requires_user_confirm: {step.get('requires_user_confirm', False)}",
            f"- log_required: {step.get('log_required', True)}",
            "",
            "### Subagent MUST append after takeover",
            "- 读懂的输入、边界、上游产物路径",
            "- 关键决策（含被拒绝的备选方案）",
            "- 每个里程碑的 progress + --note（缺 --note 会报错）",
            "- 实际写入的产物路径，不是描述",
            "- 验证命令与结果",
            "- 失败时：error 摘要、阻塞点、恢复建议",
            "",
        ]
        if dispatch_note:
            body.append("### Dispatch note from Main Agent")
            body.append("")
            body.append(dispatch_note)
            body.append("")
        log_path.write_text("\n".join(body), encoding="utf-8")
    update_plan_status(data, stamp)
    dump_json(plan_path, data)
    sync_thread(plan_path)
    print(f"precreated log: {log_path}")
    print(f"step {step_id} log_path={step.get('log_path')}")
    return log_path



def ensure_log_path(plan_path: Path, step: dict[str, Any], stamp: str) -> Path:
    project_root = project_root_from_plan(plan_path)
    logs_dir = logs_dir_from_plan(plan_path)
    logs_dir.mkdir(parents=True, exist_ok=True)

    existing = step.get("log_path")
    if existing:
        existing_path = Path(existing)
        if not existing_path.is_absolute():
            existing_path = project_root / existing_path
        existing_path.parent.mkdir(parents=True, exist_ok=True)
        return existing_path

    timestamp = stamp.replace(":", "-").replace("Z", "")
    filename = f"{timestamp}_step-{safe_name(step.get('id'))}_{safe_name(step.get('name'))}.md"
    log_path = logs_dir / filename
    try:
        stored = log_path.relative_to(project_root).as_posix()
    except ValueError:
        stored = log_path.as_posix()
    step["log_path"] = stored
    return log_path


def log_event(plan_path: Path, step: dict[str, Any], stamp: str, action: str, detail: str | None = None) -> None:
    log_path = ensure_log_path(plan_path, step, stamp)
    is_new = not log_path.exists()
    lines: list[str] = []
    if is_new:
        lines.extend(
            [
                f"# Step {step.get('id')} - {step.get('name', '')}",
                "",
                f"- step_id: {step.get('id')}",
                f"- name: {step.get('name', '')}",
                f"- subagent: {step.get('subagent', '')}",
                f"- task_agent: {step.get('task_agent', '')}",
                f"- started_at: {stamp}",
                "",
                "## Events",
            ]
        )
    progress = step.get("progress")
    status = step.get("status")
    agent = step.get("agent_id", "")
    suffix = f" status={status}"
    if progress is not None:
        suffix += f" progress={progress}"
    if agent:
        suffix += f" agent={agent}"
    if detail:
        suffix += f" detail={detail}"
    lines.append(f"- {stamp} {action}{suffix}")
    if is_new:
        log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    else:
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
def update_plan_status(data: dict[str, Any], stamp: str) -> None:
    new_status = compute_plan_status(data)
    old_status = data.get("status")
    if old_status == new_status:
        return
    data["status"] = new_status
    if new_status == "running" and not data.get("started_at"):
        data["started_at"] = stamp
    if new_status in {"completed", "failed"}:
        data["completed_at"] = stamp
    elif old_status == "completed":
        # 状态从 completed 回退(重新打开步骤)时清除旧的完成时间
        data["completed_at"] = None


def sync_thread(plan_path: Path) -> None:
    script = Path(__file__).with_name("thread-state.py")
    if not script.exists():
        return
    import subprocess

    subprocess.run(
        ["python3", str(script), "sync", "--plan", str(plan_path)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Update .goo/plan.json step state")
    parser.add_argument("--plan", default=".goo/plan.json", help="plan.json path")
    parser.add_argument("--step-id", required=True, help="step id to update")
    parser.add_argument("--status", choices=["pending", "running", "completed", "failed", "interrupted", "blocked"], help="new status")
    parser.add_argument("--progress", type=int, help="progress 0-100")
    parser.add_argument("--agent-id", help="agent id/name")
    parser.add_argument("--error", help="failure summary")
    parser.add_argument("--heartbeat", action="store_true", help="update heartbeat_at")
    parser.add_argument("--start", action="store_true", help="set started_at and heartbeat_at")
    parser.add_argument("--complete", action="store_true", help="set status=completed, progress=100, completed_at")
    parser.add_argument("--fail", action="store_true", help="set status=failed, completed_at, optional error")
    parser.add_argument(
        "--interrupt",
        action="store_true",
        help=(
            "set status=interrupted: subagent wrapper 被信号杀/超时，任务本体状态"
            "未知（远程管线可能继续运行）。非终态，不写 completed_at，保留 progress。"
        ),
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help=(
            "set status=running from interrupted/failed: 主 Agent 检查确认任务本体"
            "仍在运行（如远程管线）后恢复，保留 progress，清 error/agent_id，重置心跳。"
        ),
    )
    parser.add_argument("--block", action="store_true", help="set status=blocked, optional approval/error summary")
    parser.add_argument(
        "--confirmed",
        action="store_true",
        help=(
            "record user confirmation for a requires_user_confirm step: sets"
            " confirmed=true + confirmed_at, clears blocked_at/error, and if"
            " currently blocked, unblocks back to pending."
        ),
    )
    parser.add_argument(
        "--precreate-log",
        action="store_true",
        help=(
            "Main-Agent pre-dispatch hook: create a dispatch-skeleton log file"
            " (cwd, allowlists, declared outputs, dispatch note) BEFORE handing"
            " off to the Subagent. Writes log_path back into plan.json so the"
            " Subagent and later --heartbeat calls reuse the same file."
        ),
    )
    parser.add_argument("--note", help="append a short step-log note for this update")
    args = parser.parse_args()

    # Mutually exclusive action flags
    _action_flags = [args.start, args.complete, args.fail, args.interrupt, args.resume, args.block, args.confirmed]
    if sum(bool(f) for f in _action_flags) > 1:
        raise SystemExit(
            "only one of --start, --complete, --fail, --interrupt, --resume, --block, --confirmed may be used at a time"
        )

    plan_path = resolve_plan_path(args.plan)

    # C3 修复：对 plan.json 加进程间写锁（flock），防止并发 update-step 时
    # 读-改-写竞态（后写覆盖先写）。锁文件为 plan_path.lock；
    # Windows 无 fcntl 时退化无锁（仅 Linux/mac 生效）。
    lock_fh = None
    try:
        import fcntl

        lock_path = Path(str(plan_path) + ".lock")
        lock_fh = lock_path.open("w")
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
    except (ImportError, OSError):
        pass  # 无 fcntl（Windows）或锁失败：退化无锁，保持原有行为

    try:
        return _main_locked(plan_path, args)
    finally:
        if lock_fh is not None:
            try:
                import fcntl

                fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
                lock_fh.close()
            except (ImportError, OSError):
                pass


def _main_locked(plan_path: Path, args: argparse.Namespace) -> int:
    data = load_json(plan_path)

    # --precreate-log short-circuits: it is the Main Agent's pre-dispatch hook.
    # Run before any state mutation, and do not require --note (the dispatch
    # note is the body of the skeleton itself, not a state-change note).
    if args.precreate_log:
        precreate_step_log(plan_path, args.step_id, args.note)
        return 0

    # Heartbeat must carry a meaningful --note. The note is the only signal
    # of "alive + making progress"; without it the heartbeat is hollow and
    # useless for post-mortems. We fail loud instead of silently dropping it.
    if args.heartbeat and not (args.note or "").strip():
        sys.stderr.write(
            "error: --heartbeat requires --note \"<短进展>\"; 留痕是产物的一部分"
            "，空白 heartbeat 等于没记录。\n"
        )
        return 2
    stamp = now()

    target = None
    for step in data.get("steps", []):
        if str(step.get("id")) == args.step_id:
            target = step
            break
    if target is None:
        raise SystemExit(f"step id not found: {args.step_id}")

    if args.start:
        target["status"] = "running"
        target.setdefault("progress", 0)
        target["started_at"] = target.get("started_at") or stamp
        target["heartbeat_at"] = stamp

    if args.complete:
        target["status"] = "completed"
        target["progress"] = 100
        target["heartbeat_at"] = stamp
        target["completed_at"] = stamp

    if args.fail:
        target["status"] = "failed"
        target["completed_at"] = stamp
        target["heartbeat_at"] = stamp
        if args.error:
            target["error"] = args.error

    if args.interrupt:
        # 非终态：不写 completed_at（任务本体可能仍在运行），保留 progress 供恢复
        target["status"] = "interrupted"
        target["heartbeat_at"] = stamp
        target["agent_id"] = None
        if args.error:
            target["error"] = args.error
        else:
            target["error"] = target.get("error") or "subagent wrapper 中断，任务本体状态未知"

    if args.resume:
        # 仅从 interrupted/failed 恢复：任务本体仍在运行（如远程管线）
        if target.get("status") not in ("interrupted", "failed"):
            raise SystemExit(
                f"--resume 仅适用于 interrupted/failed 步骤（当前: {target.get('status')}）"
            )
        target["status"] = "running"
        target["heartbeat_at"] = stamp
        target["started_at"] = target.get("started_at") or stamp
        target["agent_id"] = None
        target["error"] = None
        target["completed_at"] = None

    if args.block:
        target["status"] = "blocked"
        target["blocked_at"] = stamp
        target["heartbeat_at"] = stamp
        if args.error:
            target["error"] = args.error

    if args.confirmed:
        target["confirmed"] = True
        target["confirmed_at"] = stamp
        target["blocked_at"] = None
        target["error"] = None
        # 确认即解除阻塞：blocked（等待确认）→ pending（可派发）
        if target.get("status") == "blocked":
            target["status"] = "pending"
            target["progress"] = 0
            target["heartbeat_at"] = None
            target["agent_id"] = None

    if args.status:
        target["status"] = args.status
        if args.status == "pending":
            # P15: 状态回退到 pending（失败自动重试/心跳超时重试）时，清除心跳时间、
            # agent_id、error 与 progress 残留，保证 plan.json 与调度器内存状态一致。
            target["heartbeat_at"] = None
            target["agent_id"] = None
            target["error"] = None
            target["progress"] = 0
    if args.progress is not None:
        target["progress"] = max(0, min(100, args.progress))
    if args.agent_id:
        target["agent_id"] = args.agent_id
    if args.heartbeat:
        target["heartbeat_at"] = stamp
    if target.get("status") == "running" and not target.get("heartbeat_at"):
        target["heartbeat_at"] = stamp
    if "progress" not in target:
        target["progress"] = 0 if target.get("status") != "completed" else 100

    actions = []
    if args.start:
        actions.append("start")
    if args.heartbeat:
        actions.append("heartbeat")
    if args.complete:
        actions.append("complete")
    if args.fail:
        actions.append("fail")
    if args.block:
        actions.append("block")
    if args.confirmed:
        actions.append("confirm")
    if args.status and args.status not in actions:
        actions.append(f"status:{args.status}")
    if args.note and not actions:
        actions.append("note")
    if actions or target.get("status") in {"running", "completed", "failed", "blocked"}:
        log_event(plan_path, target, stamp, "+".join(actions or ["update"]), args.note or args.error)

    update_plan_status(data, stamp)
    dump_json(plan_path, data)
    sync_thread(plan_path)
    print(f"updated step {args.step_id}: status={target.get('status')} progress={target.get('progress')} heartbeat={target.get('heartbeat_at')} log={target.get('log_path', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

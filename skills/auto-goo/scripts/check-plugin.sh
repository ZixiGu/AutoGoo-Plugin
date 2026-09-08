#!/usr/bin/env bash
# AutoGoo-Plugin 插件自检脚本
# 验证插件结构完整性，安装后快速确认所有组件就绪
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ERRORS=0
WARNINGS=0

info()  { echo -e "  \033[1;34m•\033[0m $1"; }
pass()  { echo -e "  \033[1;32m✓\033[0m $1"; }
warn()  { echo -e "  \033[1;33m⚠\033[0m $1"; WARNINGS=$((WARNINGS + 1)); }
fail()  { echo -e "  \033[1;31m✗\033[0m $1"; ERRORS=$((ERRORS + 1)); }

echo ""
echo "============================================"
echo "  AutoGoo-Plugin 插件自检"
echo "============================================"
echo ""

# ── 1. Plugin 元数据 ──
echo "── 1. Plugin 元数据 ──"

if [[ -f "$ROOT/.claude-plugin/plugin.json" ]]; then
  pass ".claude-plugin/plugin.json 存在"
  if command -v python3 &>/dev/null; then
    python3 -c "import json; json.load(open('$ROOT/.claude-plugin/plugin.json'))" 2>/dev/null \
      && pass "  plugin.json 格式正确" \
      || fail "  plugin.json 格式错误"
  fi
else
  fail ".claude-plugin/plugin.json 缺失"
fi

# ── 1b. Cross-platform manifests ──
echo ""
echo "── 1b. 三平台清单 ──"
for manifest in ".codex-plugin/plugin.json" ".pi/extensions/autogoo-plugin/package.json"; do
  if [[ -f "$ROOT/$manifest" ]] && python3 -c "import json; json.load(open('$ROOT/$manifest'))" 2>/dev/null; then
    pass "$manifest 格式正确"
  else
    fail "$manifest 缺失或格式错误"
  fi
done

for agent in researcher collector implementer optimizer evaluator reviewer auditor recorder; do
  [[ -f "$ROOT/agents/$agent.md" ]] || fail "Claude Agent 未注册: agents/$agent.md"
done
[[ -f "$ROOT/hooks/hooks.json" ]] && pass "Claude SessionStart hook 存在" || fail "hooks/hooks.json 缺失"

if command -v pytest &>/dev/null; then
  if (cd "$ROOT" && pytest -q tests/test_platform_integrity.py >/dev/null); then
    pass "三平台 pytest 完整性测试通过"
  else
    fail "三平台 pytest 完整性测试失败"
  fi
else
  warn "pytest 不可用，跳过三平台 pytest 完整性测试"
fi

# ── 2. SKILL ──
echo ""
echo "── 2. SKILL 定义 ──"

SKILLS=("auto-goo")
for skill_dir in "${SKILLS[@]}"; do
  SKILL="$ROOT/skills/$skill_dir/SKILL.md"
  if [[ -f "$SKILL" ]]; then
    pass "skills/$skill_dir/SKILL.md 存在"
    if head -1 "$SKILL" | grep -q '^---$'; then
      pass "  YAML frontmatter 起始正确"
    else
      fail "  YAML frontmatter 起始缺失"
    fi
    if command -v python3 &>/dev/null; then
      set +e
      python3 - "$SKILL" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
match = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
if not match:
    print("missing-frontmatter")
    raise SystemExit(1)
fields = {}
for line in match.group(1).splitlines():
    if ":" not in line:
        continue
    key, value = line.split(":", 1)
    fields[key.strip()] = value.strip().strip('"').strip("'")
missing = [key for key in ("name", "description") if not fields.get(key)]
if missing:
    print("missing:" + ",".join(missing))
    raise SystemExit(2)
if len(fields["description"]) > 1024:
    raise SystemExit(3)
PY
      rc=$?
      set -e
      case "$rc" in
        0) pass "  frontmatter name/description 格式正确" ;;
        1) fail "  frontmatter 解析失败" ;;
        2) fail "  frontmatter 缺少 name 或 description" ;;
        3) fail "  description 超过 1024 字符，会浪费启动上下文" ;;
        *) fail "  frontmatter 校验异常" ;;
      esac
    fi
  else
    fail "skills/$skill_dir/SKILL.md 缺失"
  fi
done

if rg -q 'spawn_agent.*task_name|`spawn_agent` 使用 `task_name`' "$ROOT/skills/auto-goo/SKILL.md" \
  && rg -q '\.codex/config\.toml' "$ROOT/skills/auto-goo/scripts/resolve-root.py"; then
  pass "Codex spawn_agent 契约和 root resolver 已适配"
else
  fail "Codex spawn_agent 契约或 root resolver 仍是旧版"
fi

# ── 3. Reference 文件 ──
echo ""
echo "── 3. Reference 文件 ──"

REFS=(
  "execution-engine.md"
  "heartbeat.md"
  "interaction-templates.md"
  "obsidian-archive.md"
  "optimization-loop.md"
  "python-standards.md"
  "self-improvement.md"
  "setup.md"
  "skill-design.md"
  "task-parsing.md"
)

for ref in "${REFS[@]}"; do
  f="$ROOT/skills/auto-goo/references/$ref"
  if [[ -f "$f" ]]; then
    pass "references/$ref"
  else
    fail "references/$ref 缺失"
  fi
done

INTERACTION_TEMPLATES="$ROOT/skills/auto-goo/references/interaction-templates.md"
if [[ -f "$INTERACTION_TEMPLATES" ]] && command -v python3 &>/dev/null; then
  set +e
  python3 - "$INTERACTION_TEMPLATES" <<'PY'
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
blocks = re.findall(r"```json\n(.*?)\n```", text, re.S)
if not blocks:
    print("no-json-blocks")
    raise SystemExit(1)

seen = set()
required = {
    "config_scope",
    "wiki_dir",
    "project_workspace_create",
    "project_workspace_layout",
    "project_workspace_claude_md",
    "project_workspace_organize_existing",
    "project_workspace_apply_organization",
    "update_claude_md",
    "configure_servers",
    "server_type",
    "server_name",
    "server_ip",
    "server_port",
    "server_user",
    "server_purpose",
    "server_password",
    "add_another_server",
    "git_init_project",
    "brainstorm_review",
    "existing_brainstorm_goal",
    "thread_action",
    "thread_select",
    "existing_plan_action",
    "plan_review",
    "start_plan_review",
    "remote_resource_usage",
    "failed_step_action",
    "research_followup",
    "usage_view",
    "publish_public_confirm",
    "post_archive_html_report",
    "improve_confirm",
    "permission_block_action",
}

for block in blocks:
    obj = json.loads(block)
    for key in ("header", "id", "question", "options"):
        if not obj.get(key):
            print(f"missing-{key}")
            raise SystemExit(2)
    if obj["id"] in seen:
        print(f"duplicate-id:{obj['id']}")
        raise SystemExit(3)
    seen.add(obj["id"])
    options = obj["options"]
    if not isinstance(options, list) or len(options) < 2:
        print(f"bad-options:{obj['id']}")
        raise SystemExit(4)
    if "(Recommended)" not in options[0].get("label", ""):
        print(f"missing-recommended:{obj['id']}")
        raise SystemExit(5)
    for opt in options:
        if not opt.get("label") or not opt.get("description"):
            print(f"bad-option-field:{obj['id']}")
            raise SystemExit(6)

missing = sorted(required - seen)
if missing:
    print("missing-required:" + ",".join(missing))
    raise SystemExit(7)
PY
  rc=$?
  set -e
  case "$rc" in
    0) pass "  interaction-templates.md JSON 模板正确" ;;
    1) fail "  interaction-templates.md 缺少 JSON 模板" ;;
    2) fail "  interaction-templates.md 模板缺少必填字段" ;;
    3) fail "  interaction-templates.md 模板 id 重复" ;;
    4) fail "  interaction-templates.md 模板选项少于 2 个" ;;
    5) fail "  interaction-templates.md 模板第一项缺少 Recommended" ;;
    6) fail "  interaction-templates.md 模板选项缺少 label/description" ;;
    7) fail "  interaction-templates.md 缺少必需模板 id" ;;
    *) fail "  interaction-templates.md JSON 校验异常" ;;
  esac
fi

# ── 4. 命令文件 ──
echo ""
echo "── 4. 命令文件 ──"

CMDS=("goo-init" "goo-brainstorm" "goo-plan" "goo-start" "goo-research" "goo-benchmark" "goo-continue" "goo-improve" "goo-status" "goo-observe" "goo-daily-report" "goo-usage" "goo-usage-analyse" "goo-publish")
for cmd in "${CMDS[@]}"; do
  f="$ROOT/commands/$cmd.md"
  if [[ -f "$f" ]]; then
    pass "commands/$cmd.md"
    if grep -q "^name: auto-goo:$cmd$" "$f"; then
      pass "  /auto-goo:$cmd 注册名正确"
    else
      fail "  commands/$cmd.md 注册名应为 name: auto-goo:$cmd"
    fi
  else
    fail "commands/$cmd.md 缺失"
  fi
done

# ── 5. Agent 文件 ──
echo ""
echo "── 5. Agent 文件 ──"

ROLE_AGENTS=("researcher" "collector" "implementer" "optimizer" "evaluator" "reviewer" "auditor" "recorder")
TASK_AGENTS=(
  "tasks/research/codebase-scout"
  "tasks/research/document-analyst"
  "tasks/research/domain-researcher"
  "tasks/research/requirement-analyst"
  "tasks/collection/data-collector"
  "tasks/collection/usage-collector"
  "tasks/collection/session-aggregator"
  "tasks/collection/wiki-gatherer"
  "tasks/collection/log-analyst"
  "tasks/implementation/feature-builder"
  "tasks/implementation/bug-fixer"
  "tasks/implementation/refactorer"
  "tasks/implementation/script-writer"
  "tasks/implementation/doc-editor"
  "tasks/optimization/profiler"
  "tasks/optimization/performance-optimizer"
  "tasks/optimization/token-cost-optimizer"
  "tasks/optimization/workflow-optimizer"
  "tasks/evaluation/test-runner"
  "tasks/evaluation/benchmark-runner"
  "tasks/evaluation/data-validator"
  "tasks/evaluation/acceptance-checker"
  "tasks/review/code-reviewer"
  "tasks/review/api-contract-reviewer"
  "tasks/review/doc-reviewer"
  "tasks/audit/security-checker"
  "tasks/audit/compliance-auditor"
  "tasks/audit/evidence-auditor"
  "tasks/audit/traceability-auditor"
  "tasks/audit/risk-auditor"
  "tasks/recording/obsidian-recorder"
  "tasks/recording/wiki-curator"
  "tasks/recording/execution-summarizer"
  "tasks/recording/lesson-extractor"
)
for agent in "${ROLE_AGENTS[@]}"; do
  f="$ROOT/agents/roles/$agent.md"
  if [[ -f "$f" ]]; then
    pass "agents/roles/$agent.md"
    if head -1 "$f" | grep -q '^---$\|^#'; then
      pass "  frontmatter/heading 起始正确"
    else
      warn "  agents/roles/$agent.md 缺少 frontmatter 或 heading"
    fi
  else
    fail "agents/roles/$agent.md 缺失"
  fi
done

for agent in "${TASK_AGENTS[@]}"; do
  f="$ROOT/agents/$agent.md"
  if [[ -f "$f" ]]; then
    pass "agents/$agent.md"
    if head -1 "$f" | grep -q '^---$\|^#'; then
      pass "  frontmatter/heading 起始正确"
    else
      warn "  agents/$agent.md 缺少 frontmatter 或 heading"
    fi
  else
    fail "agents/$agent.md 缺失"
  fi
done

# ── 6. 脚本文件 ──
echo ""
echo "── 6. 脚本文件 ──"

SCRIPTS=("goo-init.sh" "init-plan.sh" "goo-status.py" "goo-observe.py" "update-step.py" "thread-state.py" "thread-locks.py" "change-requests.py" "brainstorm-validate.py" "wiki-graph-assist.py" "daily-report-sessions.py" "goo-usage.py" "goo-publish.py" "goo-ssh.sh" "remote-resources.py" "resolve-root.sh" "resolve-root.py" "session-start.py" "check-plugin.sh")
for s in "${SCRIPTS[@]}"; do
  f="$ROOT/skills/auto-goo/scripts/$s"
  if [[ -f "$f" ]]; then
    pass "scripts/$s"
    if [[ -x "$f" ]]; then
      pass "  $s 可执行"
    else
      warn "  $s 不可执行 —— 请 chmod +x"
    fi
  else
    fail "scripts/$s 缺失"
  fi
done

if command -v python3 &>/dev/null; then
  for py in "$ROOT"/skills/auto-goo/scripts/*.py; do
    [[ -f "$py" ]] || continue
    if PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/autogoo-plugin-check-pycache" python3 -m py_compile "$py" 2>/dev/null; then
      pass "  $(basename "$py") 语法正确"
    else
      fail "  $(basename "$py") 语法错误"
    fi
  done
fi

for sh in "$ROOT"/skills/auto-goo/scripts/*.sh; do
  [[ -f "$sh" ]] || continue
  if bash -n "$sh" 2>/dev/null; then
    pass "  $(basename "$sh") 语法正确"
  else
    fail "  $(basename "$sh") 语法错误"
  fi
done

if command -v python3 &>/dev/null; then
  THREAD_SYNC_DIR="${TMPDIR:-/tmp}/autogoo-plugin-check-thread-sync-$$"
  mkdir -p "$THREAD_SYNC_DIR/project/.goo/threads/demo-thread"
  python3 - "$THREAD_SYNC_DIR/project" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
goo = root / ".goo"
thread = goo / "threads" / "demo-thread"
plan = {
    "task": "thread sync smoke",
    "status": "running",
    "thread": {
        "id": "demo-thread",
        "plan_path": ".goo/threads/demo-thread/plan.json",
        "logs_dir": ".goo/threads/demo-thread/logs",
        "artifacts_dir": ".goo/threads/demo-thread/artifacts",
    },
    "steps": [
        {"id": "s1", "name": "done", "status": "completed"},
        {"id": "s2", "name": "run", "status": "running"},
    ],
}
thread.mkdir(parents=True, exist_ok=True)
(thread / "thread.json").write_text(json.dumps({"id": "demo-thread"}, ensure_ascii=False) + "\n", encoding="utf-8")
(thread / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(goo / "current_thread.json").write_text(json.dumps({"thread_id": None}, ensure_ascii=False) + "\n", encoding="utf-8")
PY
  if python3 "$ROOT/skills/auto-goo/scripts/thread-state.py" \
      --goo-dir "$THREAD_SYNC_DIR/project/.goo" \
      sync --plan "$THREAD_SYNC_DIR/project/.goo/threads/demo-thread/plan.json" --set-current >/dev/null 2>&1 \
    && python3 - "$THREAD_SYNC_DIR/project" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
goo = root / ".goo"
current = json.loads((goo / "current_thread.json").read_text(encoding="utf-8"))
compat = json.loads((goo / "plan.json").read_text(encoding="utf-8"))
index = json.loads((goo / "threads" / "index.json").read_text(encoding="utf-8"))
assert current["thread_id"] == "demo-thread"
assert current["plan_path"] == ".goo/threads/demo-thread/plan.json"
assert compat["thread"]["id"] == "demo-thread"
assert compat["steps"][1]["status"] == "running"
assert index["current_thread_id"] == "demo-thread"
PY
  then
    pass "  thread-state.py sync 同步 current_thread/index/.goo/plan.json"
  else
    fail "  thread-state.py sync 未同步 current_thread/index/.goo/plan.json"
  fi

  mkdir -p "$THREAD_SYNC_DIR/project/.goo/threads/other-thread"
  python3 - "$THREAD_SYNC_DIR/project" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
goo = root / ".goo"
other = goo / "threads" / "other-thread"
plan = {
    "task": "other thread sync smoke",
    "status": "running",
    "thread": {
        "id": "other-thread",
        "plan_path": ".goo/threads/other-thread/plan.json",
        "logs_dir": ".goo/threads/other-thread/logs",
        "artifacts_dir": ".goo/threads/other-thread/artifacts",
    },
    "steps": [{"id": "s1", "name": "run", "status": "running"}],
}
other.mkdir(parents=True, exist_ok=True)
(other / "thread.json").write_text(json.dumps({"id": "other-thread"}, ensure_ascii=False) + "\n", encoding="utf-8")
(other / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  if python3 "$ROOT/skills/auto-goo/scripts/thread-state.py" \
      --goo-dir "$THREAD_SYNC_DIR/project/.goo" \
      sync --plan "$THREAD_SYNC_DIR/project/.goo/threads/other-thread/plan.json" >/dev/null 2>&1 \
    && python3 - "$THREAD_SYNC_DIR/project" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
goo = root / ".goo"
current = json.loads((goo / "current_thread.json").read_text(encoding="utf-8"))
compat = json.loads((goo / "plan.json").read_text(encoding="utf-8"))
index = json.loads((goo / "threads" / "index.json").read_text(encoding="utf-8"))
assert current["thread_id"] == "demo-thread"
assert compat["thread"]["id"] == "demo-thread"
assert index["current_thread_id"] == "demo-thread"
assert any(item["id"] == "other-thread" for item in index["threads"])
PY
  then
    pass "  thread-state.py sync 不会让后台旧线程抢占 current thread"
  else
    fail "  thread-state.py sync current thread 保护失败"
  fi

  LOCK_SMOKE_DIR="${TMPDIR:-/tmp}/autogoo-plugin-check-locks-$$"
  mkdir -p "$LOCK_SMOKE_DIR/project/.goo/threads/t1" "$LOCK_SMOKE_DIR/project/.goo/threads/t2"
  python3 - "$LOCK_SMOKE_DIR/project" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
goo = root / ".goo"
for thread_id, path in (("t1", "src"), ("t2", "src/app.py")):
    tdir = goo / "threads" / thread_id
    plan = {
        "thread": {"id": thread_id},
        "steps": [{
            "id": "s1",
            "status": "pending",
            "allowed_write_paths": [path],
            "wiki_pages": ["wiki/projects/demo.md"],
            "ports": [9877],
        }],
    }
    (tdir / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  if python3 "$ROOT/skills/auto-goo/scripts/thread-locks.py" \
      --goo-dir "$LOCK_SMOKE_DIR/project/.goo" \
      acquire-plan --plan "$LOCK_SMOKE_DIR/project/.goo/threads/t1/plan.json" >/dev/null 2>&1 \
    && ! python3 "$ROOT/skills/auto-goo/scripts/thread-locks.py" \
      --goo-dir "$LOCK_SMOKE_DIR/project/.goo" \
      check-plan --plan "$LOCK_SMOKE_DIR/project/.goo/threads/t2/plan.json" >/dev/null 2>&1 \
    && python3 "$ROOT/skills/auto-goo/scripts/thread-locks.py" \
      --goo-dir "$LOCK_SMOKE_DIR/project/.goo" \
      release-plan --plan "$LOCK_SMOKE_DIR/project/.goo/threads/t1/plan.json" >/dev/null 2>&1; then
    pass "  thread-locks.py 检测文件目录/wiki/port 冲突并可释放"
  else
    fail "  thread-locks.py 资源锁 smoke test 失败"
  fi

  REQUEST_SMOKE_DIR="${TMPDIR:-/tmp}/autogoo-plugin-check-requests-$$"
  mkdir -p "$REQUEST_SMOKE_DIR/project/.goo/change-requests"
  python3 - "$REQUEST_SMOKE_DIR/project/.goo/change-requests/r1.json" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(json.dumps({
    "id": "r1",
    "thread_id": "demo-thread",
    "status": "pending_model_update",
    "request": "update plan",
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  if python3 "$ROOT/skills/auto-goo/scripts/change-requests.py" \
      --goo-dir "$REQUEST_SMOKE_DIR/project/.goo" \
      claim --thread-id demo-thread --actor check-plugin >/dev/null 2>&1 \
    && python3 "$ROOT/skills/auto-goo/scripts/change-requests.py" \
      --goo-dir "$REQUEST_SMOKE_DIR/project/.goo" \
      status --request r1 --status completed --actor check-plugin --plan-step-id s1 >/dev/null 2>&1 \
    && python3 - "$REQUEST_SMOKE_DIR/project/.goo/change-requests/r1.json" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
assert data["status"] == "completed"
assert data["claimed_by"] == "check-plugin"
assert data["plan_step_id"] == "s1"
assert len(data["history"]) == 2
PY
  then
    pass "  change-requests.py 支持 claim/status 状态机"
  else
    fail "  change-requests.py smoke test 失败"
  fi

  BRAINSTORM_SMOKE_DIR="${TMPDIR:-/tmp}/autogoo-plugin-check-brainstorm-$$"
  mkdir -p "$BRAINSTORM_SMOKE_DIR/project/.goo"
  python3 - "$BRAINSTORM_SMOKE_DIR/project/.goo/brainstorm.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
goals = []
for idx in range(1, 4):
    goals.append({
        "id": f"cg{idx}",
        "name": f"候选目标 {idx}",
        "why": "来自 wiki 信号和当前上下文",
        "expected_output": f"产物 {idx}",
        "acceptance_criteria": [f"验收 {idx}"],
        "evidence": [f"证据 {idx}"],
        "risk": "低风险",
        "prerequisites": ["用户确认范围"],
        "readiness_checklist": ["路径已确认"],
        "first_step": "读取相关上下文",
        "priority_hint": "high" if idx == 1 else "medium",
    })
path.write_text(json.dumps({
    "task": "示例 brainstorm",
    "thread": {
        "id": "demo-thread",
        "brainstorm_path": ".goo/threads/demo-thread/brainstorm.json",
        "plan_path": ".goo/threads/demo-thread/plan.json",
        "logs_dir": ".goo/threads/demo-thread/logs",
    },
    "status": "pending_decision",
    "wiki_context": {"sources": ["wiki/projects/demo.md"], "signals": ["未完成事项"]},
    "global_prerequisites": ["用户确认优先级"],
    "divergence_axes": [
        {"axis": "快速交付", "signals": ["短期 unblock"], "candidate_goal_ids": ["cg1"]},
        {"axis": "长期架构", "signals": ["结构演进"], "candidate_goal_ids": ["cg2"]},
        {"axis": "风险债务", "signals": ["历史问题"], "candidate_goal_ids": ["cg2"]},
        {"axis": "验证评测", "signals": ["缺测试"], "candidate_goal_ids": ["cg3"]},
        {"axis": "自动化工具化", "signals": ["重复操作"], "candidate_goal_ids": ["cg3"]},
    ],
    "candidate_goals": goals,
    "self_check": {
        "coverage": ["快速交付", "长期架构", "风险债务", "验证评测", "自动化工具化"],
        "deduped_or_merged": [],
        "evidence_gaps": [],
        "risk_calibration": [],
        "recommendation_rationale": "cg1 成本最低且能快速验证方向。",
    },
    "recommended_goal_ids": ["cg1", "cg2"],
    "decision_needed": True,
    "review": {"status": "pending_user_review", "summary": "等待用户选择候选目标。"},
    "next_action": "/auto-goo:goo-plan <明确目标>",
    "archive": {"status": "pending_user_review"},
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  cp "$BRAINSTORM_SMOKE_DIR/project/.goo/brainstorm.json" "$BRAINSTORM_SMOKE_DIR/project/.goo/bad-brainstorm.json"
  python3 - "$BRAINSTORM_SMOKE_DIR/project/.goo/bad-brainstorm.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data.pop("self_check")
data["recommended_goal_ids"] = ["missing-goal"]
data["archive"] = {"status": "completed"}
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  if python3 "$ROOT/skills/auto-goo/scripts/brainstorm-validate.py" \
      "$BRAINSTORM_SMOKE_DIR/project/.goo/brainstorm.json" --mode draft >/dev/null 2>&1 \
    && ! python3 "$ROOT/skills/auto-goo/scripts/brainstorm-validate.py" \
      "$BRAINSTORM_SMOKE_DIR/project/.goo/bad-brainstorm.json" --mode draft >/dev/null 2>&1; then
    pass "  brainstorm-validate.py 校验草案结构和自检字段"
  else
    fail "  brainstorm-validate.py smoke test 失败"
  fi
fi

if command -v python3 &>/dev/null; then
  INIT_WORKSPACE_DIR="${TMPDIR:-/tmp}/autogoo-plugin-check-init-workspace-$$"
  mkdir -p "$INIT_WORKSPACE_DIR/project" "$INIT_WORKSPACE_DIR/wiki"
  if (cd "$INIT_WORKSPACE_DIR/project" && bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
      --project \
      --wiki-dir "$INIT_WORKSPACE_DIR/wiki" \
      --project-layout ml \
      --project-dirs experiments,docs/notes \
      --project-slug smoke \
      --skip-claude-md \
      --force \
      --yes >/dev/null 2>&1) \
    && python3 - "$INIT_WORKSPACE_DIR/project" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
config = json.loads((root / ".goo" / "config.json").read_text(encoding="utf-8"))
paths = config["workspace"]["paths"]
project_workspace = config["project_workspace"]
assert config["workspace"]["root"] == ".goo"
assert config["workspace"]["layout"] == "standard"
assert paths["threads_dir"] == ".goo/threads"
assert project_workspace["layout"] == "ml"
for rel in ("src", "configs", "references", "references/papers", "data/raw", "data/processed", "models", "outputs", "reports", "docs", "tests", "experiments", "docs/notes"):
    assert rel in project_workspace["dirs"], rel
for rel in (
    ".goo/threads",
    ".goo/logs",
    ".goo/artifacts",
    ".goo/reports",
    ".goo/locks",
    ".goo/change-requests",
    ".goo/site",
    "src",
    "references/papers",
    "data/raw",
    "docs/notes",
    "experiments",
):
    assert (root / rel).is_dir(), rel
PY
  then
    pass "  goo-init.sh 支持业务项目目录结构模板"
  else
    fail "  goo-init.sh 业务项目目录结构 smoke test 失败"
  fi

  INIT_CLAUDE_DIR="${TMPDIR:-/tmp}/autogoo-plugin-check-init-claude-$$"
  mkdir -p "$INIT_CLAUDE_DIR/project" "$INIT_CLAUDE_DIR/wiki"
  if (cd "$INIT_CLAUDE_DIR/project" && bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
      --project \
      --wiki-dir "$INIT_CLAUDE_DIR/wiki" \
      --project-layout data \
      --project-slug smoke \
      --update-claude-md \
      --force \
      --yes >/dev/null 2>&1) \
    && python3 - "$INIT_CLAUDE_DIR/project" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
pointer = (root / "CLAUDE.md").read_text(encoding="utf-8")
text = (root / "goo.md").read_text(encoding="utf-8")
assert "<!-- AUTOGOO-PLUGIN-POINTER-BEGIN -->" in pointer
assert "[goo.md](goo.md)" in pointer
assert "<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN -->" in text
assert "## 项目目录约定" in text
assert "data/raw/" in text
assert "data/processed/" in text
assert "references/papers/" in text
assert "AutoGoo-Plugin 自身状态仍固定写入 `.goo/`" in text
assert "allowed_read_paths" in text and "allowed_write_paths" in text
assert "execution/record.md" in text
assert "execution/evidence-index.md" in text
assert "不得静默遗漏失败、重试和未验证项" in text
assert "论文解读/深读以及代码库结构、调用链、数据流、架构、实现模式分析" in text
assert "pending_wiki_sync" in text
PY
  then
    pass "  goo-init.sh 创建业务目录后可写入 CLAUDE.md 目录约定"
  else
    fail "  goo-init.sh 未正确写入 CLAUDE.md 目录约定"
  fi

  mkdir -p "$INIT_WORKSPACE_DIR/project/.goo/threads/split-thread"
  python3 - "$INIT_WORKSPACE_DIR/project" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
thread = root / ".goo" / "threads" / "split-thread"
plan = {
    "task": "project layout runtime smoke",
    "status": "pending",
    "thread": {
        "id": "split-thread",
        "plan_path": ".goo/threads/split-thread/plan.json",
        "logs_dir": ".goo/threads/split-thread/logs",
        "artifacts_dir": ".goo/artifacts",
    },
    "steps": [{"id": "s1", "name": "runtime", "status": "pending"}],
}
thread.mkdir(parents=True, exist_ok=True)
(thread / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  python3 - "$INIT_WORKSPACE_DIR/project/.goo/change-requests/r2.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps({
    "id": "r2",
    "thread_id": "split-thread",
    "status": "pending_model_update",
    "request": "change",
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  if (cd "$INIT_WORKSPACE_DIR/project" \
      && python3 "$ROOT/skills/auto-goo/scripts/thread-state.py" sync \
        --plan .goo/threads/split-thread/plan.json --set-current >/dev/null 2>&1 \
      && python3 "$ROOT/skills/auto-goo/scripts/update-step.py" --step-id s1 --start >/dev/null 2>&1 \
      && python3 "$ROOT/skills/auto-goo/scripts/goo-status.py" >/dev/null 2>&1 \
      && python3 "$ROOT/skills/auto-goo/scripts/thread-locks.py" acquire \
        --type files --resource output/demo.txt --thread-id split-thread --step-id s1 >/dev/null 2>&1 \
      && python3 "$ROOT/skills/auto-goo/scripts/change-requests.py" claim \
        --thread-id split-thread --actor smoke --limit 1 >/dev/null 2>&1 \
      && python3 "$ROOT/skills/auto-goo/scripts/goo-publish.py" \
        --root "$INIT_WORKSPACE_DIR/project" --output "$INIT_WORKSPACE_DIR/project/.goo/site/index.html" >/dev/null 2>&1) \
    && python3 - "$INIT_WORKSPACE_DIR/project" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
assert json.loads((root / ".goo" / "current_thread.json").read_text(encoding="utf-8"))["thread_id"] == "split-thread"
assert json.loads((root / ".goo" / "plan.json").read_text(encoding="utf-8"))["steps"][0]["status"] == "running"
assert list((root / ".goo" / "logs").glob("*.md"))
assert (root / ".goo" / "locks" / "files.json").is_file()
assert json.loads((root / ".goo" / "change-requests" / "r2.json").read_text(encoding="utf-8"))["status"] == "in_progress"
assert (root / ".goo" / "site" / "index.html").is_file()
PY
  then
    pass "  固定 .goo 运行脚本读取 workspace.paths"
  else
    fail "  固定 .goo 运行脚本未正确读取 workspace.paths"
  fi
fi

# ── 6b. 模板文件 ──
echo ""
echo "── 6b. 模板文件 ──"

TEMPLATES=("config.example.json" "user-config.example.json" "publish/workflow-shell.html" "publish/workflow-theme.css")
for tmpl in "${TEMPLATES[@]}"; do
  f="$ROOT/skills/auto-goo/templates/$tmpl"
  if [[ -f "$f" ]]; then
    pass "templates/$tmpl"
    if [[ "$tmpl" == *.json ]] && command -v python3 &>/dev/null; then
      python3 -c "import json; json.load(open('$f'))" 2>/dev/null \
        && pass "  $tmpl 格式正确" \
        || fail "  $tmpl 格式错误"
    elif [[ "$tmpl" == *.html ]]; then
      grep -q '{{DYNAMIC_CSS}}' "$f" \
        && grep -q '{{PAGE_BODY}}' "$f" \
        && grep -q '{{NAV_INDEX_CLASS}}' "$f" \
        && grep -q '{{PAGE_TITLE}}' "$f" \
        && pass "  $tmpl 占位符正确" \
        || fail "  $tmpl 缺少必要占位符"
    fi
  else
    fail "templates/$tmpl 缺失"
  fi
done

PUBLISH_SHELL="$ROOT/skills/auto-goo/templates/publish/workflow-shell.html"
PUBLISH_THEME="$ROOT/skills/auto-goo/templates/publish/workflow-theme.css"
if [[ -f "$PUBLISH_SHELL" ]] && grep -q 'workflow-theme.css' "$PUBLISH_SHELL"; then
  pass "  workflow-shell.html 引用正式发布主题"
else
  fail "  workflow-shell.html 未引用 workflow-theme.css"
fi
if [[ -f "$PUBLISH_THEME" ]] \
  && grep -q 'body\[data-page="brainstorm"\]' "$PUBLISH_THEME" \
  && grep -q 'summary-card:nth-child' "$PUBLISH_THEME" \
  && grep -q 'html\[data-theme="dark"\]' "$PUBLISH_THEME"; then
  pass "  workflow-theme.css 包含页面语义色、指标卡配色和暗色主题"
else
  fail "  workflow-theme.css 缺少正式主题关键样式"
fi
if ! grep -q 'split_pages' "$ROOT/skills/auto-goo/scripts/goo-publish.py"; then
  pass "  goo-publish.py 固定多页输出，不保留 split_pages 旧分支"
else
  fail "  goo-publish.py 仍残留 split_pages 旧分支"
fi

# ── 6c. HTML 发布 smoke test ──
echo ""
echo "── 6c. HTML 发布 smoke test ──"

if command -v python3 &>/dev/null; then
  PUBLISH_SMOKE_DIR="${TMPDIR:-/tmp}/autogoo-plugin-check-publish-$$"
  mkdir -p "$PUBLISH_SMOKE_DIR/project/.goo/artifacts" "$PUBLISH_SMOKE_DIR/project/.goo/logs"
  python3 - "$PUBLISH_SMOKE_DIR/project" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
goo = root / ".goo"
(goo / "plan.json").write_text(json.dumps({
    "status": "pending",
    "steps": [{
        "id": 1,
        "name": "示例步骤",
        "status": "completed",
        "progress": 100,
        "subagent": "implementer",
        "task_agent": "feature-builder",
        "tier": 1,
        "depends_on": [],
        "output": ".goo/artifacts/out.txt",
    }],
    "goals": [{"id": "g1", "name": "示例目标", "status": "completed"}],
}, ensure_ascii=False) + "\n", encoding="utf-8")
(goo / "brainstorm.json").write_text(json.dumps({
    "candidate_goals": [{
        "id": "cg1",
        "title": "示例候选",
        "priority": "high",
        "why": "用于发布 smoke test",
        "expected_output": "HTML",
    }],
}, ensure_ascii=False) + "\n", encoding="utf-8")
(goo / "artifacts" / "out.txt").write_text("artifact\n", encoding="utf-8")
PY
  if python3 "$ROOT/skills/auto-goo/scripts/goo-publish.py" \
      --root "$PUBLISH_SMOKE_DIR/project" \
      --output "$PUBLISH_SMOKE_DIR/project/.goo/site/index.html" >/dev/null 2>&1; then
    missing_pages=0
    for page in index.html threads.html plan.html activity.html brainstorm.html status.html observe.html agents.html artifacts.html requests.html workflow-theme.css; do
      if [[ ! -f "$PUBLISH_SMOKE_DIR/project/.goo/site/$page" ]]; then
        missing_pages=$((missing_pages + 1))
      fi
    done
    if [[ "$missing_pages" -eq 0 ]]; then
      pass "  goo-publish.py 可生成完整多页站点"
    else
      fail "  goo-publish.py 缺少 $missing_pages 个预期页面"
    fi
  else
    fail "  goo-publish.py smoke test 失败"
  fi
fi

# ── 6d. 远程服务器 helper smoke test ──
echo ""
echo "── 6d. 远程服务器 helper ──"

if command -v python3 &>/dev/null; then
  REMOTE_SMOKE_DIR="${TMPDIR:-/tmp}/autogoo-plugin-check-remote-$$"
  mkdir -p "$REMOTE_SMOKE_DIR/project/.goo"
  python3 - "$REMOTE_SMOKE_DIR/project/.goo/config.json" "$REMOTE_SMOKE_DIR/project/.goo/secrets.json" <<'PY'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
secrets_path = Path(sys.argv[2])
config_path.write_text(json.dumps({
    "servers": [{
        "ip": "10.0.0.8",
        "user": "ubuntu",
        "port": 22,
        "type": "gpu",
        "purpose": "smoke",
        "defaults": {
            "workdir": "/home/ubuntu/project",
            "setup_commands": ["source ~/.bashrc", "conda activate smoke"],
            "paths": {"data_dir": "/data/smoke", "artifacts_dir": "/outputs/smoke"}
        },
        "secrets_file": ".goo/secrets.json",
    }]
}, ensure_ascii=False) + "\n", encoding="utf-8")
secrets_path.write_text(json.dumps([{
    "ip": "10.0.0.8",
    "user": "ubuntu",
    "password": "",
}], ensure_ascii=False) + "\n", encoding="utf-8")
PY
  if bash "$ROOT/skills/auto-goo/scripts/goo-ssh.sh" \
      --config "$REMOTE_SMOKE_DIR/project/.goo/config.json" \
      --server ubuntu@10.0.0.8:22 \
      --dry-run -- nvidia-smi 2>/dev/null \
      | grep -q 'plain ssh (key/manual auth; no password loaded)'; then
    pass "  goo-ssh.sh 支持无密码 dry-run / SSH key 模式"
  else
    fail "  goo-ssh.sh 无密码 dry-run 失败"
  fi

  python3 - "$REMOTE_SMOKE_DIR/project/.goo/secrets.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data[0]["password"] = "smoke-password"
path.write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8")
PY
  if bash "$ROOT/skills/auto-goo/scripts/goo-ssh.sh" \
      --config "$REMOTE_SMOKE_DIR/project/.goo/config.json" \
      --server 0 \
      --dry-run -- hostname 2>/dev/null \
      | grep -q 'password via sshpass'; then
    pass "  goo-ssh.sh 支持密码 dry-run / sshpass 模式"
  else
    fail "  goo-ssh.sh 密码 dry-run 失败"
  fi

  if python3 "$ROOT/skills/auto-goo/scripts/remote-resources.py" \
      --config "$REMOTE_SMOKE_DIR/project/.goo/config.json" \
      --root "$ROOT" 2>/dev/null \
      | grep -q 'workdir:  /home/ubuntu/project'; then
    pass "  remote-resources.py 可读取远程服务器配置摘要"
  else
    fail "  remote-resources.py 配置摘要 smoke test 失败"
  fi
fi

# ── 7. 示例文件 ──
echo ""
echo "── 7. 示例文件 ──"

EXAMPLES=("csv-analysis-workflow" "optimization-workflow" "multi-step-orchestration")
for ex in "${EXAMPLES[@]}"; do
  f="$ROOT/skills/auto-goo/examples/$ex.md"
  if [[ -f "$f" ]]; then
    pass "examples/$ex.md"
  else
    warn "examples/$ex.md 缺失（可选）"
  fi
done

# ── 8. 配置文件 ──
echo ""
echo "── 8. 配置文件 ──"

if [[ -f "$ROOT/.claude/settings.json" ]]; then
  pass ".claude/settings.json"
else
  fail ".claude/settings.json 缺失"
fi

if [[ -f "$ROOT/.gitignore" ]]; then
  pass ".gitignore"
else
  warn ".gitignore 缺失"
fi

if [[ -f "$ROOT/README.md" ]]; then
  pass "README.md"
else
  warn "README.md 缺失"
fi

# ── 结果汇总 ──
echo ""
echo "============================================"
if [[ $ERRORS -eq 0 && $WARNINGS -eq 0 ]]; then
  echo -e "  \033[1;32m全部通过 ✓\033[0m"
elif [[ $ERRORS -eq 0 ]]; then
  echo -e "  \033[1;33m通过（$WARNINGS 个警告）\033[0m"
else
  echo -e "  \033[1;31m$ERRORS 个错误，$WARNINGS 个警告\033[0m"
fi
echo "============================================"
echo ""

exit $ERRORS

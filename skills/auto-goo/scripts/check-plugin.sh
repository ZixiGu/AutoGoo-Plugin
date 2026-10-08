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
assert "<!-- AUTOGOO-PLUGIN-POINTER-END -->" in pointer
assert "优先" in pointer
assert "[goo.md](goo.md)" in pointer
assert (root / "goo.md").is_file()
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

# ── 6e. 用户级 goo.md 与指针 smoke test ──
echo ""
echo "── 6e. 用户级 goo.md 与指针 ──"

if command -v python3 &>/dev/null; then
  # 用例 1：默认 --user 生成用户级 goo.md + ~/.claude/CLAUDE.md + ~/.codex/AGENTS.md
  USER_DEFAULT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/autogoo-plugin-check-user-default-XXXXXX")"
  mkdir -p "$USER_DEFAULT_DIR/home" "$USER_DEFAULT_DIR/wiki" "$USER_DEFAULT_DIR/project"
  if (cd "$USER_DEFAULT_DIR/project" && HOME="$USER_DEFAULT_DIR/home" bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
      --user --wiki-dir "$USER_DEFAULT_DIR/wiki" --yes --force >/dev/null 2>&1) \
    && python3 - "$USER_DEFAULT_DIR/home" <<'PY'
import sys
from pathlib import Path

home = Path(sys.argv[1])
goo_md = home / ".auto-goo" / "goo.md"
assert goo_md.is_file(), "user goo.md missing"
goo_text = goo_md.read_text(encoding="utf-8")
assert goo_text.count("<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN -->") == 1
assert goo_text.count("<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-END -->") == 1
for rel in (".claude/CLAUDE.md", ".codex/AGENTS.md"):
    pointer = home / rel
    assert pointer.is_file(), f"user pointer missing: {rel}"
    text = pointer.read_text(encoding="utf-8")
    assert text.count("<!-- AUTOGOO-PLUGIN-POINTER-BEGIN -->") == 1, rel
    assert text.count("<!-- AUTOGOO-PLUGIN-POINTER-END -->") == 1, rel
    assert "~/.auto-goo/goo.md" in text, rel
    assert "优先" in text, rel
PY
  then
    pass "  goo-init.sh --user 默认生成用户级 goo.md 与 CLAUDE.md/AGENTS.md 指针"
  else
    fail "  goo-init.sh --user 未正确生成用户级 goo.md 或指针"
  fi

  # 用例 2：重复执行同一 --user 命令，marker 计数仍恒为 1
  if (cd "$USER_DEFAULT_DIR/project" && HOME="$USER_DEFAULT_DIR/home" bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
      --user --wiki-dir "$USER_DEFAULT_DIR/wiki" --yes --force >/dev/null 2>&1) \
    && python3 - "$USER_DEFAULT_DIR/home" <<'PY'
import sys
from pathlib import Path

home = Path(sys.argv[1])
goo_text = (home / ".auto-goo" / "goo.md").read_text(encoding="utf-8")
assert goo_text.count("<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN -->") == 1
assert goo_text.count("<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-END -->") == 1
for rel in (".claude/CLAUDE.md", ".codex/AGENTS.md"):
    text = (home / rel).read_text(encoding="utf-8")
    assert text.count("<!-- AUTOGOO-PLUGIN-POINTER-BEGIN -->") == 1, rel
    assert text.count("<!-- AUTOGOO-PLUGIN-POINTER-END -->") == 1, rel
PY
  then
    pass "  goo-init.sh --user 重复执行保持 marker 幂等（计数 == 1）"
  else
    fail "  goo-init.sh --user 重复执行后 marker 计数异常"
  fi

  # 用例 3：--skip-user-pointer 仍写 goo.md，但不创建用户级指针
  USER_SKIP_POINTER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/autogoo-plugin-check-user-skip-pointer-XXXXXX")"
  mkdir -p "$USER_SKIP_POINTER_DIR/home" "$USER_SKIP_POINTER_DIR/wiki" "$USER_SKIP_POINTER_DIR/project"
  if (cd "$USER_SKIP_POINTER_DIR/project" && HOME="$USER_SKIP_POINTER_DIR/home" bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
      --user --wiki-dir "$USER_SKIP_POINTER_DIR/wiki" --yes --force --skip-user-pointer >/dev/null 2>&1) \
    && [[ -f "$USER_SKIP_POINTER_DIR/home/.auto-goo/goo.md" ]] \
    && [[ ! -e "$USER_SKIP_POINTER_DIR/home/.claude/CLAUDE.md" ]] \
    && [[ ! -e "$USER_SKIP_POINTER_DIR/home/.codex/AGENTS.md" ]]; then
    pass "  goo-init.sh --user --skip-user-pointer 仅写 goo.md，不创建用户级指针"
  else
    fail "  goo-init.sh --user --skip-user-pointer 行为不符合契约"
  fi

  # 用例 4：--agent claude 只创建 ~/.claude/CLAUDE.md，不创建 ~/.codex/AGENTS.md
  USER_AGENT_CLAUDE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/autogoo-plugin-check-user-agent-claude-XXXXXX")"
  mkdir -p "$USER_AGENT_CLAUDE_DIR/home" "$USER_AGENT_CLAUDE_DIR/wiki" "$USER_AGENT_CLAUDE_DIR/project"
  if (cd "$USER_AGENT_CLAUDE_DIR/project" && HOME="$USER_AGENT_CLAUDE_DIR/home" bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
      --user --wiki-dir "$USER_AGENT_CLAUDE_DIR/wiki" --yes --force --agent claude >/dev/null 2>&1) \
    && [[ -f "$USER_AGENT_CLAUDE_DIR/home/.claude/CLAUDE.md" ]] \
    && grep -q 'AUTOGOO-PLUGIN-POINTER-BEGIN' "$USER_AGENT_CLAUDE_DIR/home/.claude/CLAUDE.md" \
    && [[ ! -e "$USER_AGENT_CLAUDE_DIR/home/.codex/AGENTS.md" ]]; then
    pass "  goo-init.sh --user --agent claude 只创建 ~/.claude/CLAUDE.md"
  else
    fail "  goo-init.sh --user --agent claude 指针目标选择不符合契约"
  fi

  # 用例 5：--agent bogus 非法值 exit 2
  USER_AGENT_BOGUS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/autogoo-plugin-check-user-agent-bogus-XXXXXX")"
  mkdir -p "$USER_AGENT_BOGUS_DIR/home" "$USER_AGENT_BOGUS_DIR/wiki" "$USER_AGENT_BOGUS_DIR/project"
  AGENT_BOGUS_RC=0
  if (cd "$USER_AGENT_BOGUS_DIR/project" && HOME="$USER_AGENT_BOGUS_DIR/home" bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
      --user --wiki-dir "$USER_AGENT_BOGUS_DIR/wiki" --yes --force --agent bogus >/dev/null 2>&1); then
    AGENT_BOGUS_RC=0
  else
    AGENT_BOGUS_RC=$?
  fi
  if [[ "$AGENT_BOGUS_RC" -eq 2 ]]; then
    pass "  goo-init.sh --agent bogus 拒绝非法值并 exit 2"
  else
    fail "  goo-init.sh --agent bogus 未按契约 exit 2（实际 $AGENT_BOGUS_RC）"
  fi

  # 用例 6：project 按需——已有用户级 goo.md 且无项目专属内容时不生成项目 goo.md
  PROJECT_ONDEMAND_DIR="$(mktemp -d "${TMPDIR:-/tmp}/autogoo-plugin-check-project-ondemand-XXXXXX")"
  mkdir -p "$PROJECT_ONDEMAND_DIR/home" "$PROJECT_ONDEMAND_DIR/wiki" "$PROJECT_ONDEMAND_DIR/project"
  if (cd "$PROJECT_ONDEMAND_DIR/project" && HOME="$PROJECT_ONDEMAND_DIR/home" bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
        --user --wiki-dir "$PROJECT_ONDEMAND_DIR/wiki" --yes --force >/dev/null 2>&1) \
    && (cd "$PROJECT_ONDEMAND_DIR/project" && HOME="$PROJECT_ONDEMAND_DIR/home" bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
        --project --wiki-dir "$PROJECT_ONDEMAND_DIR/wiki" --yes --force >/dev/null 2>&1) \
    && [[ ! -e "$PROJECT_ONDEMAND_DIR/project/goo.md" ]] \
    && [[ ! -e "$PROJECT_ONDEMAND_DIR/project/CLAUDE.md" ]]; then
    pass "  goo-init.sh --project 无项目专属内容时不生成项目 goo.md"
  else
    fail "  goo-init.sh --project 按需语义失败（不应生成项目 goo.md）"
  fi

  # 用例 7：项目级初始化时指针声明项目 goo.md 优先级
  PROJECT_PRIORITY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/autogoo-plugin-check-project-priority-XXXXXX")"
  mkdir -p "$PROJECT_PRIORITY_DIR/home" "$PROJECT_PRIORITY_DIR/wiki" "$PROJECT_PRIORITY_DIR/project"
  if (cd "$PROJECT_PRIORITY_DIR/project" && HOME="$PROJECT_PRIORITY_DIR/home" bash "$ROOT/skills/auto-goo/scripts/goo-init.sh" \
      --project --wiki-dir "$PROJECT_PRIORITY_DIR/wiki" --project-layout data --project-slug smoke \
      --update-claude-md --force --yes >/dev/null 2>&1) \
    && python3 - "$PROJECT_PRIORITY_DIR/project" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
assert (root / "goo.md").is_file(), "project goo.md missing"
pointer = (root / "CLAUDE.md").read_text(encoding="utf-8")
assert "<!-- AUTOGOO-PLUGIN-POINTER-BEGIN -->" in pointer
assert "优先" in pointer
assert "goo.md" in pointer
assert "[goo.md](goo.md)" in pointer
PY
  then
    pass "  goo-init.sh --project 指针声明项目 goo.md 优先级"
  else
    fail "  goo-init.sh --project 指针未声明项目 goo.md 优先级"
  fi
fi

# ── 6f. goo-usage 数据源可移植性 ──
echo ""
echo "── 6f. goo-usage 数据源可移植性 ──"

if command -v python3 &>/dev/null; then
  GU="$ROOT/skills/auto-goo/scripts/goo-usage.py"
  GU_TMP="$(mktemp -d "${TMPDIR:-/tmp}/autogoo-plugin-check-usage-XXXXXX")"
  mkdir -p "$GU_TMP/home" "$GU_TMP/nope" "$GU_TMP/pi/sessions/demo-proj"
  # 合法但无 usage 的 pi jsonl：只要文件存在即可让 pi 源计入 jsonl（隔离真实 ~/）
  printf '%s\n' '{"type":"session","id":"smoke","cwd":"/tmp/demo"}' \
    > "$GU_TMP/pi/sessions/demo-proj/x.jsonl"

  # 从 --sources 人类可读输出按源名配对解析 path，避免 grep 脆断言
  gu_source_path() {
    python3 -c '
import re
import sys

name = sys.argv[1]
paths = {}
current = None
for line in sys.stdin.read().splitlines():
    header = re.match(r"^\s*(claude|codex|pi)\s+\S+", line)
    if header:
        current = header.group(1)
        continue
    entry = re.match(r"^\s*path:\s*(.+?)\s*$", line)
    if entry and current:
        paths[current] = entry.group(1)
        current = None
print(paths.get(name, ""))
' "$1"
  }

  # 用例 1：三源全缺失 → exit 非零且 stderr 有明确提示（--sources / source）
  GU_ALL_MISSING_RC=0
  GU_ALL_MISSING_ERR="$(HOME="$GU_TMP/home" python3 "$GU" --once \
    --input-dir "$GU_TMP/nope" --codex-dir "$GU_TMP/nope" --pi-dir "$GU_TMP/nope" \
    </dev/null 2>&1 >/dev/null)" || GU_ALL_MISSING_RC=$?
  if [[ "$GU_ALL_MISSING_RC" -ne 0 ]] \
    && printf '%s\n' "$GU_ALL_MISSING_ERR" | grep -q -- '--sources\|source'; then
    pass "  goo-usage.py 三源全缺失时 exit 非零并提示 --sources"
  else
    fail "  goo-usage.py 三源全缺失未按契约报错（rc=$GU_ALL_MISSING_RC）"
  fi

  # 用例 2：缺 claude 源时仍成功（单源缺失不致命）
  GU_DEGRADED_RC=0
  GU_DEGRADED_OUT="$(HOME="$GU_TMP/home" python3 "$GU" --once \
    --input-dir "$GU_TMP/nope" --codex-dir "$GU_TMP/nope" --pi-dir "$GU_TMP/pi/sessions" \
    </dev/null 2>/dev/null)" || GU_DEGRADED_RC=$?
  if [[ "$GU_DEGRADED_RC" -eq 0 ]] && [[ -n "$GU_DEGRADED_OUT" ]]; then
    pass "  goo-usage.py 缺 claude/codex 源时仍成功渲染 pi 数据"
  else
    fail "  goo-usage.py 单源缺失不应致命（rc=$GU_DEGRADED_RC）"
  fi

  # 用例 3：--sources 列出三源名字与至少两行 path
  GU_SOURCES_OUT="$(HOME="$GU_TMP/home" python3 "$GU" --sources </dev/null 2>/dev/null)" || true
  GU_PATH_LINES="$(printf '%s\n' "$GU_SOURCES_OUT" | grep -c 'path:' || true)"
  if printf '%s\n' "$GU_SOURCES_OUT" | grep -q 'claude' \
    && printf '%s\n' "$GU_SOURCES_OUT" | grep -q 'codex' \
    && printf '%s\n' "$GU_SOURCES_OUT" | grep -q 'pi' \
    && [[ "${GU_PATH_LINES:-0}" -ge 2 ]]; then
    pass "  goo-usage.py --sources 列出 claude/codex/pi 三源路径（$GU_PATH_LINES 行 path）"
  else
    fail "  goo-usage.py --sources 输出不完整（path 行=$GU_PATH_LINES）"
  fi

  # 用例 4：PI_CODING_AGENT_DIR 生效
  GU_PIAGENT_PATH="$(env -u PI_CODING_AGENT_SESSION_DIR -u PI_SESSION_FILE \
    HOME="$GU_TMP/home" PI_CODING_AGENT_DIR="$GU_TMP/piagent" \
    python3 "$GU" --sources </dev/null 2>/dev/null | gu_source_path pi)" || true
  if [[ "$GU_PIAGENT_PATH" == "$GU_TMP/piagent/sessions" ]]; then
    pass "  PI_CODING_AGENT_DIR 生效（pi path = \$PI_CODING_AGENT_DIR/sessions）"
  else
    fail "  PI_CODING_AGENT_DIR 未生效（pi path=$GU_PIAGENT_PATH）"
  fi

  # 用例 5：PI_CODING_AGENT_SESSION_DIR 优先级高于 PI_CODING_AGENT_DIR
  GU_PI_PRIO_PATH="$(env -u PI_SESSION_FILE \
    HOME="$GU_TMP/home" PI_CODING_AGENT_DIR="$GU_TMP/a" \
    PI_CODING_AGENT_SESSION_DIR="$GU_TMP/b" \
    python3 "$GU" --sources </dev/null 2>/dev/null | gu_source_path pi)" || true
  if [[ "$GU_PI_PRIO_PATH" == "$GU_TMP/b" ]]; then
    pass "  PI_CODING_AGENT_SESSION_DIR 优先于 PI_CODING_AGENT_DIR"
  else
    fail "  PI_CODING_AGENT_SESSION_DIR 优先级错误（pi path=$GU_PI_PRIO_PATH）"
  fi

  # 用例 6：CODEX_HOME 生效
  GU_CODEX_PATH="$(env -u PI_CODING_AGENT_SESSION_DIR -u PI_CODING_AGENT_DIR \
    -u PI_SESSION_FILE -u CLAUDE_CONFIG_DIR HOME="$GU_TMP/home" \
    CODEX_HOME="$GU_TMP/codex" \
    python3 "$GU" --sources </dev/null 2>/dev/null | gu_source_path codex)" || true
  if [[ "$GU_CODEX_PATH" == "$GU_TMP/codex/sessions" ]]; then
    pass "  CODEX_HOME 生效（codex path = \$CODEX_HOME/sessions）"
  else
    fail "  CODEX_HOME 未生效（codex path=$GU_CODEX_PATH）"
  fi

  # 用例 7：CLAUDE_CONFIG_DIR 生效
  GU_CLAUDE_PATH="$(env -u PI_CODING_AGENT_SESSION_DIR -u PI_CODING_AGENT_DIR \
    -u PI_SESSION_FILE -u CODEX_HOME HOME="$GU_TMP/home" \
    CLAUDE_CONFIG_DIR="$GU_TMP/claude" \
    python3 "$GU" --sources </dev/null 2>/dev/null | gu_source_path claude)" || true
  if [[ "$GU_CLAUDE_PATH" == "$GU_TMP/claude/projects" ]]; then
    pass "  CLAUDE_CONFIG_DIR 生效（claude path = \$CLAUDE_CONFIG_DIR/projects）"
  else
    fail "  CLAUDE_CONFIG_DIR 未生效（claude path=$GU_CLAUDE_PATH）"
  fi

  # 用例 8：--json 输出包含长度为 3 的 resolved_sources
  if HOME="$GU_TMP/home" python3 "$GU" --json </dev/null 2>/dev/null | python3 -c '
import json
import sys

data = json.load(sys.stdin)
resolved = data.get("resolved_sources")
assert isinstance(resolved, list), resolved
assert len(resolved) == 3, resolved
assert [e.get("name") for e in resolved] == ["claude", "codex", "pi"], resolved
for entry in resolved:
    for key in ("name", "path", "exists", "jsonl_count", "origin"):
        assert key in entry, (key, entry)
'; then
    pass "  goo-usage.py --json 输出 resolved_sources（3 源）"
  else
    fail "  goo-usage.py --json 缺少 resolved_sources"
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

# ── 9. pi 包资源 manifest ──
# 回归：pi 的 DefaultPackageManager 只要 package.json 存在 `pi` 对象，就会走
# "只加载 manifest 声明的资源" 分支并 return，**不再扫描约定目录 skills/**。
# 因此根 package.json 的 pi manifest 必须显式声明 skills，否则 pi install 后技能全部丢失。
echo ""
echo "── 9. pi 包资源 manifest ──"

if python3 - "$ROOT" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
pkg_path = root / "package.json"
if not pkg_path.is_file():
    raise SystemExit("package.json missing")
pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
pi = pkg.get("pi")
if not isinstance(pi, dict):
    raise SystemExit("package.json has no `pi` manifest")

extensions = pi.get("extensions")
if not isinstance(extensions, list) or not extensions:
    raise SystemExit("pi.extensions missing or empty")
for entry in extensions:
    if not (root / entry).is_file():
        raise SystemExit(f"pi.extensions entry not found: {entry}")

skills = pi.get("skills")
if not isinstance(skills, list) or not skills:
    raise SystemExit(
        "pi.skills missing: pi only loads manifest-declared resources "
        "(skills would be silently dropped)"
    )
found = []
for entry in skills:
    base = root / entry
    if not base.is_dir():
        raise SystemExit(f"pi.skills entry is not a directory: {entry}")
    found.extend(sorted(base.rglob("SKILL.md")))
if not found:
    raise SystemExit("pi.skills declares no directory containing SKILL.md")

codeskills = None
codex_manifest = root / ".codex-plugin/plugin.json"
if codex_manifest.is_file():
    codeskills = json.loads(codex_manifest.read_text(encoding="utf-8")).get("skills")
    if not codeskills:
        raise SystemExit(".codex-plugin/plugin.json missing `skills`")

print(f"pi.skills={len(skills)} skill_md={len(found)}")
PY
then
  pass "package.json 的 pi manifest 显式声明 skills（含 SKILL.md），Codex manifest 含 skills"
else
  fail "pi manifest 未声明 skills，pi install 后技能会全部丢失"
fi

# 动态复验：直接用 pi 自己的包加载器确认技能真的能被解析出来。
# pi 未安装到全局 node_modules 时降级为跳过（不影响结论）。
PI_PKG="$(npm root -g 2>/dev/null || true)/@earendil-works/pi-coding-agent"
if [[ -f "$PI_PKG/dist/core/package-manager.js" ]]; then
  PI_PROBE_OUT="$(node --input-type=module -e '
const { DefaultPackageManager } = await import(process.argv[1] + "/dist/core/package-manager.js");
const root = process.argv[2];
const pm = new DefaultPackageManager({ cwd: "/tmp", agentDir: "/tmp", settingsManager: {} });
const acc = { extensions: new Map(), skills: new Map(), prompts: new Map(), themes: new Map() };
pm.collectPackageResources(root, acc, null, { source: "local", scope: "user", origin: "package" });
console.log(acc.extensions.size + " " + acc.skills.size);
' "$PI_PKG" "$ROOT" 2>/dev/null || true)"
  PI_EXT_COUNT="${PI_PROBE_OUT%% *}"
  PI_SKILL_COUNT="${PI_PROBE_OUT##* }"
  if [[ -n "$PI_PROBE_OUT" && "$PI_SKILL_COUNT" =~ ^[0-9]+$ && "$PI_SKILL_COUNT" -ge 1 ]]; then
    pass "pi 包加载器实际解析到技能（extensions=$PI_EXT_COUNT skills=$PI_SKILL_COUNT）"
  elif [[ -n "$PI_PROBE_OUT" ]]; then
    fail "pi 包加载器解析到 extensions=$PI_EXT_COUNT 但 skills=$PI_SKILL_COUNT"
  else
    warn "pi 包加载器探测执行失败（跳过动态复验）"
  fi
else
  warn "未找到全局 pi 包，跳过 pi 包加载器动态探测"
fi

# ── 10. 交互超时保护 ──
# 回归：任何 ctx.ui 对话框都必须经 utils/ui.ts 的超时感知封装调用，
# 否则无人应答时工作流会无限挂起。
echo ""
echo "── 10. 交互超时保护 ──"

UI_TS="$ROOT/.pi/extensions/autogoo-plugin/utils/ui.ts"
if python3 - "$ROOT" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
ui = root / ".pi/extensions/autogoo-plugin/utils/ui.ts"
text = ui.read_text(encoding="utf-8")

for symbol in (
    "UIDialogOptions",
    "getInteractionTimeoutMs",
    "uiSelectDetailed",
    "uiConfirmDetailed",
    "uiInputDetailed",
    "DEFAULT_INTERACTION_TIMEOUT_MS",
):
    if symbol not in text:
        raise SystemExit(f"ui.ts missing {symbol}")

# 裸 ctx.ui.<dialog>( 调用只允许出现在 ui.ts 自身
import re
bare = re.compile(r"ctx\.ui\.(select|confirm|input)\s*\(")
offenders = []
for path in sorted((root / ".pi/extensions/autogoo-plugin").rglob("*.ts")):
    if "__tests__" in path.parts or path.name == "ui.ts":
        continue
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if bare.search(line):
            offenders.append(f"{path.relative_to(root)}:{lineno}")
if offenders:
    raise SystemExit("bare ctx.ui dialog calls (must use ui.ts helpers): " + ", ".join(offenders))

# 不可逆操作必须显式禁用超时兜底
init = (root / ".pi/extensions/autogoo-plugin/commands/init.ts").read_text(encoding="utf-8")
plan = (root / ".pi/extensions/autogoo-plugin/commands/plan.ts").read_text(encoding="utf-8")
checks = [
    (init, "选择要删除的服务器", 'onTimeout: "cancel"'),
    (init, "选择要替换的服务器", 'onTimeout: "cancel"'),
    (init, "清空服务器", "defaultOnTimeout: false"),
    (init, "TEMPLATE_PROJECT_WORKSPACE_APPLY_ORGANIZATION", 'onTimeout: "cancel"'),
    (plan, "TEMPLATE_PLAN_REVIEW_START", 'onTimeout: "cancel"'),
    (plan, "TEMPLATE_THREAD_ACTION", 'onTimeout: "cancel"'),
]
for source, marker, guard in checks:
    # 调用可能跨行，在 marker 出现位置后的窗口内找 guard（避开 import 行的干扰）
    if not re.search(re.escape(marker) + r"[\s\S]{0,400}?" + re.escape(guard), source):
        raise SystemExit(f"unsafe dialog (missing {guard}): {marker}")

idx = (root / ".pi/extensions/autogoo-plugin/index.ts").read_text(encoding="utf-8")
for token in ("timeoutSeconds", "onTimeout", "details.source", "autoResolved"):
    if token not in idx:
        raise SystemExit(f"auto_goo_ask_user missing {token}")

print("ok")
PY
then
  pass "ui.ts 提供超时感知封装，且无裸 ctx.ui 对话框调用"
  pass "不可逆操作（删/换/清服务器、文件整理、plan 确认、新建 thread）已禁用超时兜底"
  pass "auto_goo_ask_user 支持 timeoutSeconds/onTimeout 并回报 source"
else
  fail "交互超时保护缺失或不完整"
fi

# ── 11. goo.md 检测与备份恢复 ──
# 回归：环境里缺 goo.md 时必须能检测出来并从内置模板恢复，
# 否则工作流会在“没有任何约定来源”的沙地上运行。
echo ""
echo "── 11. goo.md 检测与备份恢复 ──"

GMD="$ROOT/skills/auto-goo/scripts/goo-md.py"
GMD_TPL="$ROOT/skills/auto-goo/templates/goo.md"

if python3 - "$GMD_TPL" <<'PY'
try:
    import sys
    from pathlib import Path
    tpl = Path(sys.argv[1])
    if not tpl.is_file():
        raise SystemExit("templates/goo.md missing")
    text = tpl.read_text(encoding="utf-8")
    for token in ("AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN", "AUTOGOO-PLUGIN-WIKI-ARCHIVE-END"):
        if token not in text:
            raise SystemExit(f"template missing marker {token}")
    if "{{WIKI_DIR}}" not in text:
        raise SystemExit("template missing {{WIKI_DIR}} placeholder")
except SystemExit:
    raise
except Exception as exc:
    raise SystemExit(f"template check error: {exc}")
PY
then
  pass "templates/goo.md 存在且含 WIKI-ARCHIVE marker 与占位符"
else
  fail "templates/goo.md 缺失或不完整"
fi

GMD_TMP="$(mktemp -d)"
mkdir -p "$GMD_TMP/home" "$GMD_TMP/proj"

if HOME="$GMD_TMP/home" python3 "$GMD" --check --root "$GMD_TMP/proj" >/dev/null 2>&1; then
  fail "goo-md.py --check 在无 goo.md 时未返回非零"
else
  pass "goo-md.py --check 无 goo.md 时 exit 1"
fi

if HOME="$GMD_TMP/home" python3 "$GMD" --ensure --root "$GMD_TMP/proj" >/dev/null 2>&1 \
  && [[ -f "$GMD_TMP/home/.auto-goo/goo.md" ]] \
  && grep -q "AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN" "$GMD_TMP/home/.auto-goo/goo.md" \
  && ! grep -q '{{' "$GMD_TMP/home/.auto-goo/goo.md"; then
  pass "goo-md.py --ensure 从模板恢复用户级 goo.md 且占位符已替换"
else
  fail "goo-md.py --ensure 未正确恢复 goo.md"
fi

# 幂等：在 marker 段外手工追加一行，再 ensure 两次
echo "KEEP-ME-OUTSIDE-MARKER" >> "$GMD_TMP/home/.auto-goo/goo.md"
HOME="$GMD_TMP/home" python3 "$GMD" --ensure --root "$GMD_TMP/proj" >/dev/null 2>&1
HOME="$GMD_TMP/home" python3 "$GMD" --ensure --root "$GMD_TMP/proj" >/dev/null 2>&1
GMD_MARKERS="$(grep -c 'AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN' "$GMD_TMP/home/.auto-goo/goo.md")"
if [[ "$GMD_MARKERS" == "1" ]] && grep -q "KEEP-ME-OUTSIDE-MARKER" "$GMD_TMP/home/.auto-goo/goo.md"; then
  pass "goo-md.py --ensure 幂等（marker 计数 1）且不改 marker 段外内容"
else
  fail "goo-md.py --ensure 幂等失败（marker=$GMD_MARKERS）或覆盖了段外内容"
fi

if HOME="$GMD_TMP/home" python3 "$GMD" --check --root "$GMD_TMP/proj" >/dev/null 2>&1; then
  pass "goo-md.py --check 恢复后 exit 0"
else
  fail "goo-md.py --check 恢复后仍报失败"
fi

# project 级优先于 user 级
printf '# project goo\n<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN -->\n<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-END -->\n' > "$GMD_TMP/proj/goo.md"
GMD_SCOPE="$(HOME="$GMD_TMP/home" python3 "$GMD" --check --root "$GMD_TMP/proj" --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("scope",""))' 2>/dev/null)"
if [[ "$GMD_SCOPE" == "project" ]]; then
  pass "goo-md.py --check 项目级 goo.md 优先于用户级"
else
  fail "goo-md.py --check 优先级错误（got scope=$GMD_SCOPE）"
fi

# 真实 ~/ 未被触碰
echo "" >/dev/null

# ── 12. DAG 唤醒消息投递 ──
# 回归：sendUserMessage({deliverAs:"followUp"}) 只在当前 turn 结束后投递。
# 主 Agent 在同一 turn 内连续调度时若仍发 followUp，通知会全部堆到 turn 结束才
# 一次性倒出（实测现象）。因此必须用 agent_start/agent_end 跟踪忙闲，忙时不入队。
echo ""
echo "── 12. DAG 唤醒消息投递 ──"

if python3 - "$ROOT" <<'PY'
import sys
from pathlib import Path

start = (Path(sys.argv[1]) / ".pi/extensions/autogoo-plugin/commands/start.ts").read_text(encoding="utf-8")

required = [
    "agentBusy",
    "wakeupPending",
    "registerBusyTracking",
    'pi.on("agent_start"',
    'pi.on("agent_end"',
]
for token in required:
    if token not in start:
        raise SystemExit(f"missing busy-tracking token: {token}")

# 忙时必须走 UI 反馈而不是 followUp：确认 agentBusy 分支存在且先于 sendUserMessage
busy_idx = start.find("if (agentBusy)")
send_idx = start.find('deliverAs: "followUp"', busy_idx if busy_idx >= 0 else 0)
if busy_idx < 0 or send_idx < 0 or busy_idx > send_idx:
    raise SystemExit("followUp 未被 agentBusy 门控（可能在 turn 内仍入队）")

# 依赖跳过子进程递归的守门不得被删掉
if 'process.env.AUTOGOO_SUBAGENT !== "1"' not in start:
    raise SystemExit('missing AUTOGOO_SUBAGENT guard')
print("ok")
PY
then
  pass "update-step 唤醒消息受 agent 忙闲门控（忙时改 UI 反馈，不入队）"
else
  fail "DAG 唤醒消息未做忙闲门控，会堆到 turn 结束一次性发送"
fi

# ── 13. 插件更新提醒 ──
# 回归：更新检测必须只读（不 fetch/pull）、尊重 opt-out、失败降级为 unknown
# 且 exit 0（会话启动路径不能被网络问题拖死）。
echo ""
echo "── 13. 插件更新提醒 ──"

UPD="$ROOT/skills/auto-goo/scripts/goo-update-check.py"

if [[ -f "$UPD" ]] && python3 -m py_compile "$UPD" 2>/dev/null; then
  pass "goo-update-check.py 存在且可编译"
else
  fail "goo-update-check.py 缺失或无法编译"
fi

# 不得修改本地 checkout：只检查**真实执行的 git 子命令**
# （update_hint() 里的 "git ... pull" 只是给用户的建议文本，不在此列）
if python3 - "$UPD" <<'PY'
import re, sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding="utf-8")
calls = re.findall(r"_git\(\[(.*?)\]", src, re.S)
if not calls:
    raise SystemExit("no _git([...]) calls found")
allowed = {"ls-remote", "rev-parse", "symbolic-ref", "remote"}
for call in calls:
    tokens = re.findall(r'"([^"]+)"', call)
    if not tokens:
        raise SystemExit(f"unparsable git call: {call!r}")
    if tokens[0] not in allowed:
        raise SystemExit(f"disallowed git subcommand: {tokens[0]}")
if not any('"ls-remote"' in c for c in calls):
    raise SystemExit("ls-remote not used")
PY
then
  pass "goo-update-check.py 只读（仅 ls-remote/rev-parse/symbolic-ref/remote，不 fetch/pull）"
else
  fail "goo-update-check.py 执行了修改性 git 子命令"
fi

# opt-out 全部生效
UPD_OPTIN=1
for v in AUTOGOO_SKIP_UPDATE_CHECK PI_SKIP_VERSION_CHECK PI_OFFLINE AUTOGOO_OFFLINE; do
  OUT="$(env "$v=1" python3 "$UPD" --force 2>&1 | head -1)"
  case "$OUT" in
    *已禁用*) ;;
    *) UPD_OPTIN=0 ;;
  esac
done
if [[ "$UPD_OPTIN" -eq 1 ]]; then
  pass "更新检查尊重 AUTOGOO_SKIP_UPDATE_CHECK / PI_SKIP_VERSION_CHECK / PI_OFFLINE / AUTOGOO_OFFLINE"
else
  fail "更新检查未尊重全部 opt-out 环境变量"
fi

# 非 git 目录 → unknown 且 exit 0（不阻断启动）
UPD_TMP="$(mktemp -d)"
UPD_OUT="$(python3 "$UPD" --root "$UPD_TMP" --force --quiet 2>&1)"; UPD_RC=$?
if [[ "$UPD_RC" -eq 0 ]]; then
  pass "更新检查在非 git 目录下 exit 0（不阻断会话启动）"
else
  fail "更新检查在非 git 目录下 exit $UPD_RC（应恒为 0）"
fi

# --cached-only 绝不联网：清掉缓存后应无输出且不写缓存
UPD_CACHE="$HOME/.auto-goo/cache/update-check.json"
UPD_BAK=""
if [[ -f "$UPD_CACHE" ]]; then UPD_BAK="$(cat "$UPD_CACHE")"; rm -f "$UPD_CACHE"; fi
UPD_CO="$(python3 "$UPD" --root "$UPD_TMP" --cached-only 2>&1)"; UPD_CO_RC=$?
if [[ -z "$UPD_CO" && "$UPD_CO_RC" -eq 0 && ! -f "$UPD_CACHE" ]]; then
  pass "--cached-only 缓存未命中时无输出、exit 0 且不写缓存"
else
  fail "--cached-only 行为异常（out='$UPD_CO' rc=$UPD_CO_RC）"
fi
if [[ -n "$UPD_BAK" ]]; then printf '%s' "$UPD_BAK" > "$UPD_CACHE"; fi

# --json 必须包含 status 字段
if python3 "$UPD" --root "$UPD_TMP" --force --json 2>/dev/null | grep -q '"status"'; then
  pass "goo-update-check.py --json 输出含 status"
else
  fail "goo-update-check.py --json 输出异常"
fi

# session-start 必须引用更新检查（只读缓存路径）
if grep -q "goo-update-check.py" "$ROOT/skills/auto-goo/scripts/session-start.py" \
  && grep -q -- "--cached-only" "$ROOT/skills/auto-goo/scripts/session-start.py"; then
  pass "session-start.py 用 --cached-only 做更新提醒（不阻塞网络）"
else
  fail "session-start.py 未接入只读更新提醒"
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

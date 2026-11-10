#!/usr/bin/env bash
# AutoGoo-Plugin 插件自检脚本
# 验证插件结构完整性，安装后快速确认所有组件就绪
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# 断言应扫「整个 commands 目录」而不是单个文件 —— 文件拆分不该让断言误伤
COMMANDS_DIR="$ROOT/.pi/extensions/autogoo-plugin/commands"
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

# TS 单元/集成测试（此前从未进 CI —— 55 个用例一直没人跑）
# 需要 tsx；缺失时 warn 而非 fail，避免阻塞没有 node 工具链的环境。
# 注意：本脚本 set -euo pipefail，任何 grep 无匹配都会让整条管道非零退出，
#      所以这里的每个取值都必须用 `|| true` 兜住，并用 --test-reporter=tap
#      拿到稳定的 `# pass N` / `# fail N` 机器可读行。
EXT_TEST_DIR="$ROOT/.pi/extensions/autogoo-plugin"
TSX_BIN="$ROOT/node_modules/.bin/tsx"
if [[ -x "$TSX_BIN" ]]; then
  TS_TEST_OUT="$(cd "$EXT_TEST_DIR" && "$TSX_BIN" --test --test-reporter=tap \
    __tests__/*.test.ts utils/*.test.ts 2>&1 || true)"
  TS_TEST_PASS="$(printf '%s\n' "$TS_TEST_OUT" | sed -n 's/^# pass \([0-9]*\)$/\1/p' | head -1 || true)"
  TS_TEST_FAIL="$(printf '%s\n' "$TS_TEST_OUT" | sed -n 's/^# fail \([0-9]*\)$/\1/p' | head -1 || true)"
  if [[ -n "$TS_TEST_PASS" && "${TS_TEST_FAIL:-1}" == "0" ]]; then
    pass "TS 测试全部通过（${TS_TEST_PASS} 个用例）"
  else
    fail "TS 测试失败（pass=${TS_TEST_PASS:-?} fail=${TS_TEST_FAIL:-?}）"
    printf '%s\n' "$TS_TEST_OUT" | sed -n 's/^not ok /    ✗ /p' | head -5 || true
  fi
else
  warn "tsx 不可用，跳过 TS 测试"
fi

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
for skill_dir in ${SKILLS[@]+"${SKILLS[@]}"}; do
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

for ref in ${REFS[@]+"${REFS[@]}"}; do
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
for cmd in ${CMDS[@]+"${CMDS[@]}"}; do
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
for agent in ${ROLE_AGENTS[@]+"${ROLE_AGENTS[@]}"}; do
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

for agent in ${TASK_AGENTS[@]+"${TASK_AGENTS[@]}"}; do
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

SCRIPTS=("goo-init.sh" "init-plan.sh" "goo-status.py" "goo-observe.py" "update-step.py" "thread-state.py" "thread-locks.py" "goo-thread.py" "thread-doctor.py" "goo-plan-health.py" "goo-md.py" "goo-update-check.py" "bump-version.py" "change-requests.py" "brainstorm-validate.py" "wiki-graph-assist.py" "daily-report-sessions.py" "goo-usage.py" "goo-publish.py" "goo-ssh.sh" "remote-resources.py" "resolve-root.sh" "resolve-root.py" "session-start.py" "check-plugin.sh")
for s in ${SCRIPTS[@]+"${SCRIPTS[@]}"}; do
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
for tmpl in ${TEMPLATES[@]+"${TEMPLATES[@]}"}; do
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
for ex in ${EXAMPLES[@]+"${EXAMPLES[@]}"}; do
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

if python3 - "$COMMANDS_DIR" "$ROOT/.pi/extensions/autogoo-plugin/utils/pi-state.ts" <<'PY'
import sys
from pathlib import Path

d = Path(sys.argv[1])
files = sorted(d.rglob("*.ts")) + [Path(sys.argv[2])]
start = "\n".join(p.read_text(encoding="utf-8") for p in files if p.is_file())

required = [
    "isAgentBusy",
    "claimWakeup",
    "registerBusyTracking",
    'pi.on("agent_start"',
    'pi.on("agent_end"',
]
for token in required:
    if token not in start:
        raise SystemExit(f"missing busy-tracking token: {token}")

# 忙时必须走 UI 反馈而不是 followUp：确认忙闲分支存在且先于 sendUserMessage
busy_idx = start.find("if (isAgentBusy())")
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

# ── 14. 版本号一致性 ──
# 约定：package.json 是单一事实源，其余 manifest / SKILL / README / 扩展入口
# 必须与它一致；**每次提交都要 bump**（用 bump-version.py 一次改全）。
echo ""
echo "── 14. 版本号一致性 ──"

if python3 "$ROOT/skills/auto-goo/scripts/bump-version.py" --check --root "$ROOT" >/dev/null 2>&1; then
  VER="$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")"
  pass "版本号全位置一致（$VER）"
else
  fail "版本号不一致：运行 python3 skills/auto-goo/scripts/bump-version.py --check 查看差异"
fi

# bump-version.py 必须覆盖全部已知位置，不能漏
if python3 - "$ROOT" <<'PY'
import re, sys
from pathlib import Path

root = Path(sys.argv[1])
src = (root / "skills/auto-goo/scripts/bump-version.py").read_text(encoding="utf-8")
required = [
    "package.json",
    ".pi/extensions/autogoo-plugin/package.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "skills/auto-goo/SKILL.md",
    "README.md",
    ".pi/extensions/autogoo-plugin/index.ts",
]
missing = [item for item in required if item not in src]
if missing:
    raise SystemExit("bump-version.py 未覆盖: " + ", ".join(missing))
PY
then
  pass "bump-version.py 覆盖全部 8 个版本位置"
else
  fail "bump-version.py 覆盖不全，bump 时会漏改"
fi

# 版本一致性测试不得硬编码版本号（否则每次 bump 都要改测试）
if grep -qE 'versions == \{"[0-9]' "$ROOT/tests/test_platform_integrity.py"; then
  fail "test_platform_integrity.py 硬编码了版本号，bump 时会失败"
else
  pass "版本测试从 package.json 推导期望值（bump 无需改测试）"
fi

# ── 15. thread 健康检查（中断/搁置 plan 确认）──
# 回归：中断的 DAG 要能被识别，且必须区分「当前 thread」与「历史 thread」——
# 混在一起会让人误关当前任务线。
echo ""
echo "── 15. thread 健康检查 ──"

PH="$ROOT/skills/auto-goo/scripts/goo-plan-health.py"

if [[ -f "$PH" ]] && python3 -m py_compile "$PH" 2>/dev/null; then
  pass "goo-plan-health.py 存在且可编译"
else
  fail "goo-plan-health.py 缺失或无法编译"
fi

if python3 - "$PH" <<'PY'
import sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding="utf-8")
for token in ("active_thread_id", "active_needs_attention", "other_needing_attention", "current_thread.json"):
    if token not in src:
        raise SystemExit(f"missing thread-awareness token: {token}")
# --close 必须同时维护 plan 与 thread 记录，否则又会制造状态不一致
if "meta[\"status\"] = \"abandoned\"" not in src:
    raise SystemExit("--close does not update thread.json status")
if '"abandoned"' not in src:
    raise SystemExit("--close does not set abandoned")
PY
then
  pass "goo-plan-health.py 区分 current/历史 thread，且 --close 同步 plan 与 thread"
else
  fail "thread 维度处理缺失（会误关当前任务线或制造新的状态不一致）"
fi

# 场景：plan 完成但 thread 仍 running → 必须报 inconsistent
PH_TMP="$(mktemp -d)"
mkdir -p "$PH_TMP/.goo/threads/t1"
printf '{"id":"t1","title":"T","status":"running","updated_at":"2099-01-01T00:00:00Z"}' > "$PH_TMP/.goo/threads/t1/thread.json"
printf '{"status":"completed","steps":[{"id":1,"status":"completed"}]}' > "$PH_TMP/.goo/threads/t1/plan.json"
printf '{"thread_id":"t1"}' > "$PH_TMP/.goo/current_thread.json"

PH_STATE="$(python3 "$PH" --root "$PH_TMP" --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["active"]["state"])' 2>/dev/null)"
if [[ "$PH_STATE" == "inconsistent" ]]; then
  pass "plan 完成但 thread 仍 running 被识别为 inconsistent"
else
  fail "状态不一致未被识别（got state=$PH_STATE）"
fi

# 场景：当前 thread 心跳停滞 → active_needs_attention=true
PH_TMP2="$(mktemp -d)"
mkdir -p "$PH_TMP2/.goo/threads/t1"
printf '{"id":"t1","title":"T","status":"running","updated_at":"2099-01-01T00:00:00Z"}' > "$PH_TMP2/.goo/threads/t1/thread.json"
printf '{"status":"running","updated_at":"2099-01-01T00:00:00Z","steps":[{"id":1,"status":"running","heartbeat_at":"2020-01-01T00:00:00Z"}]}' > "$PH_TMP2/.goo/threads/t1/plan.json"
printf '{"thread_id":"t1"}' > "$PH_TMP2/.goo/current_thread.json"

if python3 "$PH" --root "$PH_TMP2" --json 2>/dev/null | python3 -c 'import json,sys;raise SystemExit(0 if json.load(sys.stdin)["active_needs_attention"] else 1)'; then
  pass "当前 thread 心跳停滞时 active_needs_attention=true"
else
  fail "心跳停滞的当前 thread 未被标记"
fi

# 场景：--close 不得伪造步骤完成，且要归档
python3 "$PH" --root "$PH_TMP2" --close --thread t1 --close-reason check >/dev/null 2>&1
if python3 - "$PH_TMP2" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
plan = json.loads((root / ".goo/threads/t1/plan.json").read_text())
thread = json.loads((root / ".goo/threads/t1/thread.json").read_text())
steps = [s["status"] for s in plan["steps"]]
assert plan["status"] == "abandoned", plan["status"]
assert thread["status"] == "abandoned", thread["status"]
assert steps == ["running"], steps  # 不得把 running 改写成 completed
assert list((root / ".goo/plans/history").glob("*.json")), "no archived copy"
PY
then
  pass "--close 标记 abandoned、保留原步骤状态、生成归档副本"
else
  fail "--close 行为不正确（伪造完成/未归档/状态未同步）"
fi

rm -rf "$PH_TMP" "$PH_TMP2"

# session-start 必须接入（Claude Code 侧的可观测性）
if grep -q "goo-plan-health.py" "$ROOT/skills/auto-goo/scripts/session-start.py"; then
  pass "session-start.py 已接入 thread 健康检查"
else
  fail "session-start.py 未接入 thread 健康检查"
fi

# ── 16. thread 记录对账（thread-doctor）──
# 回归：plan/thread/index/current/文件系统 五处没有交叉校验时会出现静默漂移。
# 要求：能检出各类不一致；--fix 只能做安全修复（不伪造状态、不删文件、幂等）。
echo ""
echo "── 16. thread 记录对账 ──"

TD="$ROOT/skills/auto-goo/scripts/thread-doctor.py"

if [[ -f "$TD" ]] && python3 -m py_compile "$TD" 2>/dev/null; then
  pass "thread-doctor.py 存在且可编译"
else
  fail "thread-doctor.py 缺失或无法编译"
fi

# 构造一份脏数据：幽灵索引 + 状态漂移 + plan_path 越界 + 时间戳倒置
TD_TMP="$(mktemp -d)"
mkdir -p "$TD_TMP/.goo/threads/ok" "$TD_TMP/.goo/threads/drift"
printf '{"id":"ok","title":"OK","status":"completed","created_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-02T00:00:00Z"}' > "$TD_TMP/.goo/threads/ok/thread.json"
printf '{"status":"completed","thread":{"id":"ok"},"steps":[{"id":1,"status":"completed"}]}' > "$TD_TMP/.goo/threads/ok/plan.json"
printf '{"id":"drift","title":"D","status":"running","created_at":"2026-01-01T00:00:00Z","completed_at":"2025-12-01T00:00:00Z"}' > "$TD_TMP/.goo/threads/drift/thread.json"
printf '{"status":"completed","thread":{"id":"drift"},"steps":[{"id":1,"status":"completed"}]}' > "$TD_TMP/.goo/threads/drift/plan.json"
printf '{"threads":[{"id":"ok"},{"id":"drift"},{"id":"ghost"}]}' > "$TD_TMP/.goo/threads/index.json"
printf '{"thread_id":"missing-thread"}' > "$TD_TMP/.goo/current_thread.json"

TD_JSON="$(python3 "$TD" --root "$TD_TMP" --json 2>/dev/null)"
if echo "$TD_JSON" | python3 -c '
import json, sys
kinds = {i["kind"] for i in json.load(sys.stdin)["issues"]}
need = {"ghost_index", "thread_status_drift", "timestamp_inverted", "current_missing"}
missing = need - kinds
raise SystemExit(f"missing detections: {missing}" if missing else 0)
'; then
  pass "thread-doctor 检出 ghost_index / 状态漂移 / 时间戳倒置 / current 失效"
else
  fail "thread-doctor 未能检出上述不一致"
fi

# --fix 只能修安全项，且不得改动步骤状态、不得删目录
BEFORE_DIRS="$(find "$TD_TMP/.goo/threads" -maxdepth 1 -type d | wc -l)"
python3 "$TD" --root "$TD_TMP" --fix >/dev/null 2>&1
AFTER_DIRS="$(find "$TD_TMP/.goo/threads" -maxdepth 1 -type d | wc -l)"
TD_AFTER="$(python3 "$TD" --root "$TD_TMP" --json 2>/dev/null)"
DRIFT_STATUS="$(python3 -c "import json;print(json.load(open('$TD_TMP/.goo/threads/drift/thread.json'))['status'])")"
PLAN_STEPS="$(python3 -c "import json;print([s['status'] for s in json.load(open('$TD_TMP/.goo/threads/drift/plan.json'))['steps']])")"

if [[ "$BEFORE_DIRS" == "$AFTER_DIRS" ]] && [[ "$DRIFT_STATUS" == "completed" ]] && [[ "$PLAN_STEPS" == "['completed']" ]]; then
  pass "--fix 同步 thread 状态且不删目录、不改步骤状态"
else
  fail "--fix 行为异常（dirs $BEFORE_DIRS->$AFTER_DIRS, drift=$DRIFT_STATUS, steps=$PLAN_STEPS）"
fi

if echo "$TD_AFTER" | python3 -c '
import json, sys
kinds = {i["kind"] for i in json.load(sys.stdin)["issues"]}
raise SystemExit(0 if "ghost_index" not in kinds else 1)
'; then
  pass "--fix 清除了 ghost_index 记录"
else
  fail "--fix 未清除 ghost_index"
fi

# 幂等：第二次 --fix 不应再产生变更
TD_CHANGED2="$(python3 "$TD" --root "$TD_TMP" --fix --json 2>/dev/null | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["fix"]["changed"]))' 2>/dev/null)"
if [[ "$TD_CHANGED2" == "0" ]]; then
  pass "--fix 幂等（第二次无变更）"
else
  fail "--fix 非幂等（第二次仍变更 $TD_CHANGED2 项）"
fi

# --fix 必须先备份 index
if find "$TD_TMP/.goo/plans/history" -path "*thread-fix-*" -name "index.json" 2>/dev/null | grep -q .; then
  pass "--fix 修改前备份 threads/index.json"
else
  fail "--fix 未备份 index"
fi

rm -rf "$TD_TMP"

# ── 扩展可修复项（plan_path / thread 块 / 时间戳）必须安全且幂等 ──
TD2="$(mktemp -d)"
mkdir -p "$TD2/.goo/threads/arc" "$TD2/.goo/threads/bad" "$TD2/.goo/threads/nothr"
# arc: 已归档、无本地 plan、plan_path 指向已消失的位置
printf '{"id":"arc","title":"A","status":"archived","created_at":"2026-01-01T00:00:00Z","plan_path":"/tmp/gone/plan.json"}' > "$TD2/.goo/threads/arc/thread.json"
# bad: plan 完成但 thread 仍在跑，且 completed_at 早于 created_at
printf '{"id":"bad","title":"B","status":"running","created_at":"2026-02-01T10:00:00Z","completed_at":"2026-02-01T08:00:00Z"}' > "$TD2/.goo/threads/bad/thread.json"
printf '{"status":"completed","thread":{"id":"bad"},"completed_at":"2026-02-01T07:00:00Z","steps":[{"id":1,"status":"completed","completed_at":"2026-02-01T07:00:00Z"}]}' > "$TD2/.goo/threads/bad/plan.json"
# nothr: plan 缺 thread 块
printf '{"id":"nothr","title":"C","status":"completed","created_at":"2026-03-01T00:00:00Z"}' > "$TD2/.goo/threads/nothr/thread.json"
printf '{"status":"completed","steps":[{"id":1,"status":"completed"}]}' > "$TD2/.goo/threads/nothr/plan.json"
printf '{"threads":[{"id":"arc"},{"id":"bad"},{"id":"nothr"}]}' > "$TD2/.goo/threads/index.json"

TD2_BEFORE_DIRS="$(find "$TD2/.goo/threads" -maxdepth 1 -type d | wc -l)"
python3 "$TD" --root "$TD2" --fix >/dev/null 2>&1
TD2_AFTER_DIRS="$(find "$TD2/.goo/threads" -maxdepth 1 -type d | wc -l)"

if python3 - "$TD2" <<'PY2'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
arc = json.loads((root / ".goo/threads/arc/thread.json").read_text())
bad = json.loads((root / ".goo/threads/bad/thread.json").read_text())
nothr_plan = json.loads((root / ".goo/threads/nothr/plan.json").read_text())
# 归档且无本地 plan → 清空悬空引用
assert arc.get("plan_path") in (None, ""), arc
# thread 状态跟随 plan
assert bad["status"] == "completed", bad
# 不可信时间戳必须被移除，而不是伪造成 now
assert "completed_at" not in bad, bad
# plan 补上 thread 块
assert isinstance(nothr_plan.get("thread"), dict) and nothr_plan["thread"]["id"] == "nothr", nothr_plan
PY2
then
  pass "扩展修复：清空悬空 plan_path、同步 thread 状态、不伪造时间戳、补齐 thread 块"
else
  fail "扩展修复行为不正确"
fi

if [[ "$TD2_BEFORE_DIRS" == "$TD2_AFTER_DIRS" ]]; then
  pass "扩展修复不删除任何 thread 目录"
else
  fail "扩展修复删除了目录（$TD2_BEFORE_DIRS -> $TD2_AFTER_DIRS）"
fi

TD2_CHANGED="$(python3 "$TD" --root "$TD2" --fix --json 2>/dev/null | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["fix"]["changed"]))' 2>/dev/null)"
if [[ "$TD2_CHANGED" == "0" ]]; then
  pass "扩展修复幂等（第二次 0 变更）"
else
  fail "扩展修复非幂等（第二次仍变更 $TD2_CHANGED 项）"
fi

# 失败不得伪装成「无问题」
if python3 -c '
import re, sys
from pathlib import Path
src = Path("'"$TD"'").read_text()
# 异常分支必须标记 failed 且 issue_count 不得为 0
assert "\"failed\": True" in src, "exception path missing failed flag"
assert "\"issue_count\": None" in src, "exception path must not report 0"
' 2>/dev/null; then
  pass "对账异常时标记 failed（不会把崩溃伪装成“无问题”）"
else
  fail "对账异常会被误报为 issue_count=0"
fi

rm -rf "$TD2"

# session-start 必须接入
if grep -q "thread-doctor.py" "$ROOT/skills/auto-goo/scripts/session-start.py"; then
  pass "session-start.py 已接入 thread 对账"
else
  fail "session-start.py 未接入 thread 对账"
fi

# ── 17. wiki 默认路径查询入口 ──
# 回归：Claude Code / Codex 侧问「用哪个 Goo-wiki 路径」时，必须能**查询**
# 实际生效的默认值，而不是靠 agent 自己读配置或拍脑袋用 ~/workspace/Goo-wiki。
# 一旦 agent 自己填了硬编码默认值，用户本机已配好的路径就会被覆盖。
echo ""
echo "── 17. wiki 默认路径查询入口 ──"

GI="$ROOT/skills/auto-goo/scripts/goo-init.sh"
WK_TMP="$(mktemp -d)"
mkdir -p "$WK_TMP/home/.auto-goo" "$WK_TMP/proj" "$WK_TMP/custom-wiki"
printf '{"wiki_dir":"%s"}' "$WK_TMP/custom-wiki" > "$WK_TMP/home/.auto-goo/config.json"

# A) 未配置时 source=default，且 path 等于 hard_default
WK_JSON="$(HOME="$WK_TMP/empty" bash "$GI" --print-wiki-default --json 2>/dev/null)"
if echo "$WK_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["source"] == "default", d
assert d["path"] == d["hard_default"], d
'; then
  pass "--print-wiki-default：未配置时 source=default"
else
  fail "--print-wiki-default 未配置时行为异常"
fi

# B) 用户级已配置 → source=user-config 且 path 指向它
WK_JSON="$(HOME="$WK_TMP/home" bash "$GI" --print-wiki-default --json 2>/dev/null)"
if echo "$WK_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["source"] == "user-config", d
assert d["path"].endswith("custom-wiki"), d
'; then
  pass "--print-wiki-default：已配置时复用它（source=user-config）"
else
  fail "--print-wiki-default 未复用已配置路径"
fi

# C) env 优先级最高
if HOME="$WK_TMP/home" AUTOGOO_PLUGIN_WIKI_DIR=/tmp/env-wiki bash "$GI" --print-wiki-default --json 2>/dev/null \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["source"]=="env" and d["path"]=="/tmp/env-wiki", d'; then
  pass "--print-wiki-default：AUTOGOO_PLUGIN_WIKI_DIR 优先级最高"
else
  fail "--print-wiki-default 环境变量优先级错误"
fi

# D) 不带 --json 时只输出路径（可直接拼进命令）
WK_PLAIN="$(HOME="$WK_TMP/home" bash "$GI" --print-wiki-default 2>/dev/null)"
if [[ "$WK_PLAIN" == "$WK_TMP/custom-wiki" ]]; then
  pass "--print-wiki-default 不带 --json 时只输出路径"
else
  fail "--print-wiki-default 裸输出异常（got=$WK_PLAIN）"
fi

# E) C 项：显式传硬编码默认值但本机已配置 → 必须警告
WK_WARN="$(cd "$WK_TMP/proj" && HOME="$WK_TMP/home" bash "$GI" --project --wiki-dir "$WK_TMP/home/workspace/Goo-wiki" --yes --force 2>&1 >/dev/null)"
if echo "$WK_WARN" | grep -q "与硬编码默认值相同"; then
  pass "显式传入硬编码默认值且本机有配置时给出警告"
else
  fail "覆盖用户配置时未给出任何警告"
fi

rm -rf "$WK_TMP"

# E2) 配置指向不存在路径时：recommend 必须为 false，并给出 alternatives
WK_TMP2="$(mktemp -d)"
mkdir -p "$WK_TMP2/home/.auto-goo"
printf '{"wiki_dir":"/nonexistent-goo-wiki-xyz"}' > "$WK_TMP2/home/.auto-goo/config.json"
if HOME="$WK_TMP2/home" bash "$GI" --print-wiki-default --json 2>/dev/null | python3 -c '
import json, sys
## 配置指向不存在的目录时绝不能推荐，否则会把另一台机器的路径推给用户
d = json.load(sys.stdin)
assert d["source"] == "user-config", d
assert d["exists"] is False, d
assert d["recommend"] is False, d
assert d["alternatives"], d
assert d["home"], d
'; then
  pass "配置路径不存在时 recommend=false 且给出 alternatives/home"
else
  fail "配置路径不存在时仍被当作可推荐路径"
fi
rm -rf "$WK_TMP2"

# E3) 配置路径存在时 recommend 必须为 true
WK_TMP3="$(mktemp -d)"
mkdir -p "$WK_TMP3/home/.auto-goo" "$WK_TMP3/real-wiki"
printf '{"wiki_dir":"%s"}' "$WK_TMP3/real-wiki" > "$WK_TMP3/home/.auto-goo/config.json"
if HOME="$WK_TMP3/home" bash "$GI" --print-wiki-default --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["exists"] is True and d["recommend"] is True, d
'; then
  pass "配置路径存在时 recommend=true"
else
  fail "配置路径存在时未标记为可推荐"
fi
rm -rf "$WK_TMP3"

# E4) HOME 被环境变量覆盖时必须可诊断（跨环境问题的头号根源）
WK_TMP4="$(mktemp -d)"
mkdir -p "$WK_TMP4/fakehome/.auto-goo"
printf '{"wiki_dir":"/nonexistent-goo-wiki-xyz"}' > "$WK_TMP4/fakehome/.auto-goo/config.json"
if HOME="$WK_TMP4/fakehome" bash "$GI" --print-wiki-default --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["home_mismatch"] is True, d
assert d["passwd_home"], d
assert d["recommend"] is False, d
assert "HOME" in d["recommend_reason"], d
'; then
  pass "HOME 被覆盖时 home_mismatch=true 且原因包含 HOME"
else
  fail "未检测 HOME 不一致（跨环境会读错配置文件）"
fi
rm -rf "$WK_TMP4"

# E5) init 的输出不得用 ~ 掩盖真实路径（否则看不出写到了哪个 HOME）
if grep -q 'const target = isUser ? "~/.auto-goo/config.json"' "$ROOT/.pi/extensions/autogoo-plugin/commands/init.ts"; then
  fail "init 完成提示仍用 ~ 掩盖真实配置路径"
else
  pass "init 完成提示输出真实绝对路径与 HOME"
fi

# E6) 脚本必须如实报告 config 是否真的写入 + 回读实际生效 wiki_dir
WK_TMP6="$(mktemp -d)"
mkdir -p "$WK_TMP6/home/.auto-goo" "$WK_TMP6/new-wiki"
printf '{"wiki_dir":"/old-wiki"}' > "$WK_TMP6/home/.auto-goo/config.json"
WK_SKIP_OUT="$(HOME="$WK_TMP6/home" bash "$GI" --user --wiki-dir "$WK_TMP6/new-wiki" --yes 2>&1)"
if echo "$WK_SKIP_OUT" | grep -q "config_write: skipped" \
  && echo "$WK_SKIP_OUT" | grep -q "wiki_dir_effective: /old-wiki"; then
  pass "既有 config 未覆盖时如实报告 skipped + 实际 wiki_dir"
else
  fail "既有 config 未覆盖时报告不实（会误导用户以为已写入）"
fi
WK_WRITE_OUT="$(HOME="$WK_TMP6/home" bash "$GI" --user --wiki-dir "$WK_TMP6/new-wiki" --yes --force 2>&1)"
if echo "$WK_WRITE_OUT" | grep -q "config_write: written" \
  && echo "$WK_WRITE_OUT" | grep -q "wiki_dir_effective: $WK_TMP6/new-wiki"; then
  pass "--force 时报告 written + 新的实际 wiki_dir"
else
  fail "--force 时报告不实"
fi
rm -rf "$WK_TMP6"

# E7) pi 扩展必须先询问是否覆盖，并报告实际生效值
if grep -q "overwriteConfirmed" "$ROOT/.pi/extensions/autogoo-plugin/commands/init.ts" \
  && grep -q "wiki_dir_effective" "$ROOT/.pi/extensions/autogoo-plugin/commands/init.ts"; then
  pass "pi 扩展先询问覆盖并回读实际生效 wiki_dir"
else
  fail "pi 扩展未处理覆盖确认或未回读实际值"
fi

# F) 三端必须共用同一个入口（禁止 TS 里重写优先级逻辑）
if grep -q "print-wiki-default" "$ROOT/.pi/extensions/autogoo-plugin/commands/init.ts"; then
  pass "pi 扩展复用 --print-wiki-default（不另写一套优先级）"
else
  fail "pi 扩展未复用脚本入口，优先级逻辑存在双份漂移风险"
fi

# F2) pi 扩展必须尊重 recommend 字段，不能只按 source 判断
if grep -q "def.recommend" "$ROOT/.pi/extensions/autogoo-plugin/commands/init.ts"; then
  pass "pi 扩展按 recommend 决定是否标 Recommended"
else
  fail "pi 扩展未使用 recommend，会把不存在的路径推荐给用户"
fi

# G) 文档必须要求先查询（否则 agent 又会拍脑袋给默认值）
if grep -q "print-wiki-default" "$ROOT/commands/goo-init.md"; then
  pass "commands/goo-init.md 要求先查询默认值"
else
  fail "commands/goo-init.md 未要求先查询默认值"
fi

# ── 18. thread 统一命令（goo-thread）──
# 回归：switch 必须同时同步 current_thread.json 与兼容入口 .goo/plan.json；
# 反向：内部 sync 不得把陈旧的 thread plan 回写覆盖刚更新的兼容入口。
echo ""
echo "── 18. thread 统一命令 ──"

GT="$ROOT/skills/auto-goo/scripts/goo-thread.py"

if [[ -f "$GT" ]] && python3 -m py_compile "$GT" 2>/dev/null; then
  pass "goo-thread.py 存在且可编译"
else
  fail "goo-thread.py 缺失或无法编译"
fi

GT_TMP="$(mktemp -d)"
mkdir -p "$GT_TMP/.goo/threads/aaa" "$GT_TMP/.goo/threads/bbb" "$GT_TMP/.goo/threads/noplan"
for tid in aaa bbb; do
  printf '{"id":"%s","title":"T-%s","status":"running","updated_at":"2026-01-01T00:00:00Z"}' "$tid" "$tid" > "$GT_TMP/.goo/threads/$tid/thread.json"
  printf '{"status":"running","thread":{"id":"%s"},"steps":[{"id":"s1","status":"pending"}]}' "$tid" > "$GT_TMP/.goo/threads/$tid/plan.json"
done
printf '{"id":"noplan","title":"T-noplan","status":"archived","updated_at":"2026-01-01T00:00:00Z"}' > "$GT_TMP/.goo/threads/noplan/thread.json"
printf '{"threads":[{"id":"aaa"},{"id":"bbb"},{"id":"noplan"}]}' > "$GT_TMP/.goo/threads/index.json"
printf '{"thread_id":"aaa"}' > "$GT_TMP/.goo/current_thread.json"
cp "$GT_TMP/.goo/threads/aaa/plan.json" "$GT_TMP/.goo/plan.json"

# list 可用
if python3 "$GT" --root "$GT_TMP" list 2>/dev/null | grep -q "\* aaa"; then
  pass "goo-thread list 标出当前 thread"
else
  fail "goo-thread list 异常"
fi

# switch 必须同时同步两处
python3 "$GT" --root "$GT_TMP" switch bbb >/dev/null 2>&1
if python3 - "$GT_TMP" <<'PY2'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
cur = json.loads((root / ".goo/current_thread.json").read_text())["thread_id"]
compat_owner = json.loads((root / ".goo/plan.json").read_text())["thread"]["id"]
assert cur == "bbb", cur
assert compat_owner == "bbb", compat_owner
PY2
then
  pass "switch 同时同步 current_thread 与兼容入口（经典陷阱已消除）"
else
  fail "switch 只切了 current_thread，兼容入口未跟随"
fi

# 切到无 plan 的 thread：指针切换，兼容入口保持原样
GT_BEFORE="$(python3 -c "import json;print(json.load(open('$GT_TMP/.goo/plan.json'))['thread']['id'])")"
python3 "$GT" --root "$GT_TMP" switch noplan >/dev/null 2>&1
GT_AFTER="$(python3 -c "import json;print(json.load(open('$GT_TMP/.goo/plan.json'))['thread']['id'])")"
if [[ "$GT_BEFORE" == "$GT_AFTER" ]]; then
  pass "切到无 plan 的 thread 时兼容入口保持原样（不制造空指针）"
else
  fail "切到无 plan 的 thread 时错误改写了兼容入口"
fi

# 反向回归：update-step 写兼容入口后，内部 sync 不得把旧 thread plan 盖回去
python3 "$GT" --root "$GT_TMP" switch aaa >/dev/null 2>&1
(cd "$GT_TMP" && python3 "$ROOT/skills/auto-goo/scripts/update-step.py" --step-id s1 --start >/dev/null 2>&1)
GT_STEP="$(python3 -c "import json;print(json.load(open('$GT_TMP/.goo/plan.json'))['steps'][0]['status'])")"
if [[ "$GT_STEP" == "running" ]]; then
  pass "update-step 后兼容入口状态未被内部 sync 回滚"
else
  fail "内部 sync 用陈旧 thread plan 覆盖了兼容入口（状态回滚）"
fi

rm -rf "$GT_TMP"

# 文档与 pi 注册
if [[ -f "$ROOT/commands/goo-thread.md" ]]; then
  pass "commands/goo-thread.md 存在"
else
  fail "commands/goo-thread.md 缺失"
fi
if grep -q '"goo-thread"' "$ROOT/.pi/extensions/autogoo-plugin/index.ts"; then
  pass "pi 扩展已注册 goo-thread"
else
  fail "pi 扩展未注册 goo-thread"
fi

# ── 19. thread-locks 真正接入派发 ──
# 回归：规则一直写在 SKILL.md 里（"并发执行前必须使用 thread-locks.py"），
# 但在 2026-10-08 之前**没有任何代码调用它** —— 两个会话可同时写同一批文件。
# 这里断言调度代码真的调用了 check/acquire/release，且配对释放。
echo ""
echo "── 19. thread-locks 接入派发 ──"

LOCKS_TS="$ROOT/.pi/extensions/autogoo-plugin/utils/locks.ts"
DISPATCH_TS="$ROOT/.pi/extensions/autogoo-plugin/commands/start.ts"
EXECUTE_TS="$ROOT/.pi/extensions/autogoo-plugin/tools/execute.ts"

if [[ -f "$LOCKS_TS" ]]; then
  pass "utils/locks.ts 存在"
else
  fail "utils/locks.ts 缺失（thread-locks 无法接入派发）"
fi

for sym in checkPlanLocks acquirePlanLocks releasePlanLocks describeConflicts; do
  if grep -q "export function $sym" "$LOCKS_TS" 2>/dev/null; then
    pass "locks.ts 导出 $sym"
  else
    fail "locks.ts 未导出 $sym"
  fi
done

for f in "$COMMANDS_DIR" "$EXECUTE_TS"; do
  base="$(basename "$f")"
  if grep -rq "checkPlanLocks(" "$f" && grep -rq "acquirePlanLocks(" "$f" && grep -rq "releasePlanLocks(" "$f"; then
    pass "$base 同时调用 check/acquire/release（配对加锁）"
  else
    fail "$base 未完整接入 thread-locks（check/acquire/release 必须配对）"
  fi
  if grep -rq "资源冲突" "$f" && grep -rq '"--block"' "$f"; then
    pass "$base 冲突时标记 blocked（按 SKILL 规则）"
  else
    fail "$base 冲突时未标记 blocked"
  fi
done

# 冲突语义的端到端验证（脚本层）
LT_TMP="$(mktemp -d)"
mkdir -p "$LT_TMP/.goo/threads/a" "$LT_TMP/.goo/threads/b"
printf '{"task":"A","status":"running","thread":{"id":"a"},"steps":[{"id":"s1","status":"pending","allowed_write_paths":["shared/out.txt"]}]}' > "$LT_TMP/.goo/threads/a/plan.json"
printf '{"task":"B","status":"running","thread":{"id":"b"},"steps":[{"id":"s1","status":"pending","allowed_write_paths":["shared/out.txt"]}]}' > "$LT_TMP/.goo/threads/b/plan.json"
TL="$ROOT/skills/auto-goo/scripts/thread-locks.py"
python3 "$TL" --goo-dir "$LT_TMP/.goo" acquire-plan --plan "$LT_TMP/.goo/threads/a/plan.json" >/dev/null 2>&1
if python3 "$TL" --goo-dir "$LT_TMP/.goo" check-plan --plan "$LT_TMP/.goo/threads/b/plan.json" >/dev/null 2>&1; then
  fail "跨 thread 同资源未报冲突"
else
  pass "跨 thread 同资源判定为冲突（exit 2）"
fi
if python3 "$TL" --goo-dir "$LT_TMP/.goo" acquire-plan --plan "$LT_TMP/.goo/threads/b/plan.json" >/dev/null 2>&1; then
  fail "冲突时仍抢到了锁"
else
  pass "冲突时不会抢占对方的锁"
fi
python3 "$TL" --goo-dir "$LT_TMP/.goo" release-plan --plan "$LT_TMP/.goo/threads/a/plan.json" >/dev/null 2>&1
if python3 "$TL" --goo-dir "$LT_TMP/.goo" check-plan --plan "$LT_TMP/.goo/threads/b/plan.json" >/dev/null 2>&1; then
  pass "释放后冲突消失"
else
  fail "释放后仍报冲突"
fi
# thread 自己的锁不算冲突
if python3 "$TL" --goo-dir "$LT_TMP/.goo" check-plan --plan "$LT_TMP/.goo/threads/a/plan.json" >/dev/null 2>&1; then
  pass "同 thread 自己的锁不构成冲突（可重入）"
else
  fail "同 thread 自检误报冲突"
fi
rm -rf "$LT_TMP"

if grep -q "THREAD_LOCKS_PY" "$ROOT/.pi/extensions/autogoo-plugin/utils/paths.ts"; then
  pass "paths.ts 定义 THREAD_LOCKS_PY"
else
  fail "paths.ts 未定义 THREAD_LOCKS_PY"
fi

# ── 20. goo-thread 交互式管理界面 ──
# 回归：`/goo-thread` 无参数时必须是**键盘驱动的 TUI**（ctx.ui.custom），
# 而不是 print 一张表；非 TUI 模式要能优雅降级到脚本输出。
echo ""
echo "── 20. thread 交互式界面 ──"

TUI_TS="$ROOT/.pi/extensions/autogoo-plugin/utils/thread-ui.ts"
THREAD_CMD="$ROOT/.pi/extensions/autogoo-plugin/commands/thread.ts"

if [[ -f "$TUI_TS" ]] && grep -q "export class ThreadManager" "$TUI_TS"; then
  pass "utils/thread-ui.ts 导出 ThreadManager"
else
  fail "utils/thread-ui.ts 缺失或未导出 ThreadManager"
fi

for sym in "render(width" "handleInput(data" "matchesKey" "truncateToWidth"; do
  if grep -q "$sym" "$TUI_TS" 2>/dev/null; then
    pass "ThreadManager 实现 $sym"
  else
    fail "ThreadManager 缺少 $sym"
  fi
done

if grep -q "ctx.ui.custom" "$THREAD_CMD" && grep -q "new ThreadManager" "$THREAD_CMD"; then
  pass "/goo-thread 无参数时打开 ctx.ui.custom 交互界面"
else
  fail "/goo-thread 仍是纯打印输出（未使用 ctx.ui.custom）"
fi

if grep -q 'ctx.mode === "tui"' "$THREAD_CMD"; then
  pass "非 TUI 模式有降级判定（ctx.mode === tui）"
else
  fail "缺少非 TUI 模式的降级判定"
fi

# 危险动作必须走确认（关闭 thread）
if grep -q 'uiConfirm' "$THREAD_CMD" && grep -q 'defaultOnTimeout: false' "$THREAD_CMD"; then
  pass "关闭 thread 走结构化确认（超时不动作）"
else
  fail "关闭 thread 缺少确认或超时安全默认"
fi

# 脚本层：--json / rename / archive / restore
GT2_TMP="$(mktemp -d)"
mkdir -p "$GT2_TMP/.goo/threads/t1"
printf '{"id":"t1","title":"原名","status":"running","updated_at":"2026-01-01T00:00:00Z"}' > "$GT2_TMP/.goo/threads/t1/thread.json"
printf '{"status":"running","thread":{"id":"t1"},"steps":[{"id":"s1","status":"pending"}]}' > "$GT2_TMP/.goo/threads/t1/plan.json"
printf '{"threads":[{"id":"t1","title":"原名","status":"running"}]}' > "$GT2_TMP/.goo/threads/index.json"
printf '{"thread_id":"t1"}' > "$GT2_TMP/.goo/current_thread.json"
cp "$GT2_TMP/.goo/threads/t1/plan.json" "$GT2_TMP/.goo/plan.json"

if python3 "$GT" --root "$GT2_TMP" list --json 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["count"]==1 and d["threads"][0]["id"]=="t1"'; then
  pass "goo-thread list --json 可用（供 TUI 消费）"
else
  fail "goo-thread list --json 异常"
fi

python3 "$GT" --root "$GT2_TMP" rename t1 "新标题" >/dev/null 2>&1
if python3 -c 'import json,sys;assert json.load(open("'"$GT2_TMP"'/.goo/threads/t1/thread.json"))["title"]=="新标题"'; then
  pass "rename 同时更新 thread.json"
else
  fail "rename 未生效"
fi
if python3 -c 'import json,sys;d=json.load(open("'"$GT2_TMP"'/.goo/threads/index.json"));assert d["threads"][0]["title"]=="新标题"'; then
  pass "rename 同步 index.json"
else
  fail "rename 未同步 index"
fi

python3 "$GT" --root "$GT2_TMP" archive t1 >/dev/null 2>&1
if python3 -c 'import json,sys;m=json.load(open("'"$GT2_TMP"'/.goo/threads/t1/thread.json"));assert m["status"]=="archived" and m["previous_status"]=="running"'; then
  pass "archive 记录 previous_status（可恢复）"
else
  fail "archive 未记录 previous_status"
fi
python3 "$GT" --root "$GT2_TMP" restore t1 >/dev/null 2>&1
if python3 -c 'import json,sys;m=json.load(open("'"$GT2_TMP"'/.goo/threads/t1/thread.json"));assert m["status"]=="running"'; then
  pass "restore 恢复到归档前状态"
else
  fail "restore 未恢复原状态"
fi
rm -rf "$GT2_TMP"

# ── 21. 初始化环境自检与失败可诊断 ──
# 回归：「初始化失败 (exit 1)」曾无任何可读信息 —— 脚本开了 set -u，
# HOME 未设置就直接退出；扩展又把 stderr 丢了。两者都必须修住。
echo ""
echo "── 21. 初始化环境自检 ──"

# 1) HOME 未设置时不能崩，且要给出合法 JSON
if OUT="$(env -u HOME bash "$GI" --print-wiki-default --json 2>/dev/null)" \
  && echo "$OUT" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["path"] and "home" in d'; then
  pass "HOME 未设置时仍能输出合法 JSON（不再 exit 1）"
else
  fail "HOME 未设置时初始化失败——这正是 exit 1 的常见成因"
fi

# 2) HOME 未设置时要给出 warning，而不是静默回退
if env -u HOME bash "$GI" --print-wiki-default --json 2>&1 >/dev/null | grep -q "HOME 未设置"; then
  pass "HOME 回退时给出 warning"
else
  fail "HOME 回退无提示（用户不知道读到了哪个家目录）"
fi

# 3) python3 缺失要有明确提示与用法
if grep -q "未找到 python3" "$GI" && grep -q "exit 2" "$GI"; then
  pass "python3 缺失时给出明确报错"
else
  fail "python3 缺失时无明确提示"
fi

# 4) 解析器失败必须有兜底 JSON（否则后续 json.load 抛错 → exit 1）
if grep -q "resolver fallback" "$GI"; then
  pass "默认值解析器失败时有兜底 JSON"
else
  fail "解析器失败会连锁导致 exit 1"
fi

# 5) 禁止裸数组展开：bash 4.2/4.3 在 set -u 下对空数组执行
#    "${ARR[@]}" 会报 unbound variable（bash 4.4+ 才修）。
#    必须写成 ${ARR[@]+"${ARR[@]}"}。本地 bash 5.x 测不出来，只能静态校验。
if python3 - "$ROOT" <<'PY2'
import pathlib
import re
import sys

pattern = re.compile(r'"\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"')
bad = []
for path in pathlib.Path(sys.argv[1]).rglob("*.sh"):
    if "node_modules" in path.parts:
        continue
    text = path.read_text(encoding="utf-8")
    for match in pattern.finditer(text):
        name = match.group(1)
        if text[: match.start()].endswith(f"${{{name}[@]+"):
            continue
        start_of_line = text.rfind("\n", 0, match.start()) + 1
        end_of_line = text.find("\n", match.start())
        line_text = text[start_of_line : end_of_line if end_of_line != -1 else len(text)]
        # 注释里的示例不执行，不算问题（本文件的解释文字就含有示例）
        if line_text.lstrip().startswith("#"):
            continue
        line = text[: match.start()].count("\n") + 1
        bad.append(f"{path.relative_to(sys.argv[1])}:{line} ${{{name}[@]}}")
if bad:
    raise SystemExit("bare array expansion (breaks on bash 4.2 + set -u): " + "; ".join(bad[:5]))
PY2
then
  pass "无裸数组展开（兼容 bash 4.2 + set -u）"
else
  fail "存在裸 \"\${ARR[@]}\"，在 bash 4.2/4.3 上会 unbound variable"
fi

# 6) 空数组场景端到端：--user 初始化不带任何 --server/--remove-server
AE_TMP="$(mktemp -d)"
mkdir -p "$AE_TMP/home" "$AE_TMP/work"
if HOME="$AE_TMP/home" bash "$GI" --user --wiki-dir "$AE_TMP/work/Goo-wiki" --write-user-pointer --yes >/dev/null 2>&1; then
  pass "空 SERVER_SPECS / REMOVE_SERVERS 下 --user 初始化成功"
else
  fail "空数组场景初始化失败（bash 4.2 上会 unbound variable）"
fi
if [[ -f "$AE_TMP/home/.auto-goo/goo.md" && -f "$AE_TMP/home/.claude/CLAUDE.md" ]]; then
  pass "空数组场景仍生成 goo.md 与用户级指针"
else
  fail "空数组场景缺少产物"
fi
rm -rf "$AE_TMP"

# 7) 扩展失败时必须暴露 stderr/stdout，而不是只报 exit code
INIT_TS="$ROOT/.pi/extensions/autogoo-plugin/commands/init.ts"
if grep -q "result.stderr" "$INIT_TS" && grep -q "复现命令" "$INIT_TS"; then
  pass "初始化失败时暴露 stderr/stdout 与复现命令"
else
  fail "初始化失败只报 exit code（无从判断原因）"
fi

# ── 22. 共享 TUI 组件与面板 ──
# 回归：/goo-usage 曾把脚本输出 strip ANSI 后塞进
# sendUserMessage(deliverAs:"followUp") —— 既被排队，又变成"发给模型"的消息，
# 用户实际看不到面板。必须用 ctx.ui.custom 渲染真正的 TUI。
echo ""
echo "── 22. 共享 TUI 组件与面板 ──"

KIT="$ROOT/.pi/extensions/autogoo-plugin/utils/tui-kit.ts"
UPANEL="$ROOT/.pi/extensions/autogoo-plugin/utils/usage-panel.ts"
OPANEL="$ROOT/.pi/extensions/autogoo-plugin/utils/observe-panel.ts"
OTHER_TS="$ROOT/.pi/extensions/autogoo-plugin/commands/other.ts"

for sym in "export function fit" "export function bar" "export class ListState" "export function keyHelp" "export function statusToken"; do
  if grep -q "$sym" "$KIT" 2>/dev/null; then
    pass "tui-kit 提供 $sym"
  else
    fail "tui-kit 缺少 $sym"
  fi
done

if grep -q "export class UsagePanel" "$UPANEL" 2>/dev/null \
  && grep -q "ctx.ui.custom" "$OTHER_TS" \
  && grep -q "new UsagePanel" "$OTHER_TS"; then
  pass "/goo-usage 用 ctx.ui.custom 渲染 UsagePanel"
else
  fail "/goo-usage 未接入 TUI 面板"
fi

# 关键回归：usage 不得再通过 sendUserMessage 发给模型
if python3 - "$OTHER_TS" <<'PY2'
import re, sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding="utf-8")
start = src.find("export async function handleGooUsage(")
end = src.find("export async function handleGooUsageAnalyse(")
body = src[start:end] if start >= 0 and end > start else ""
# 只匹配真实调用，不匹配注释/字符串里的词
code_lines = [
    line for line in body.splitlines()
    if not line.lstrip().startswith("//") and not line.lstrip().startswith("*")
]
if any(".sendUserMessage(" in line for line in code_lines):
    raise SystemExit("handleGooUsage still calls sendUserMessage (queued followUp, not a visible panel)")
PY2
then
  pass "/goo-usage 不再用 sendUserMessage 排队（用户能直接看到面板）"
else
  fail "/goo-usage 仍把输出塞进 sendUserMessage（会被排队）"
fi

if grep -rq 'ctx.mode !== "tui"' "$OTHER_TS" "$COMMANDS_DIR"; then
  pass "usage / observe 都有非 TUI 降级判定"
else
  fail "缺少非 TUI 降级判定"
fi

# venv: goo-status 与 goo-observe 必须共用同一个面板（合并回归）
if grep -rq "openObservePanel(ctx, \"steps\")" "$COMMANDS_DIR" \
  && grep -q "openObservePanel(ctx, \"env\")" "$OTHER_TS"; then
  pass "goo-status 与 goo-observe 共用 ObservePanel（仅初始 tab 不同）"
else
  fail "两个命令未共用同一面板（合并失效）"
fi

if [[ ! -f "$ROOT/.pi/extensions/autogoo-plugin/utils/status-panel.ts" ]] \
  && ! grep -rq "status-panel" "$ROOT/.pi/extensions/autogoo-plugin" --include=*.ts 2>/dev/null; then
  pass "旧的 status-panel.ts 已移除且无残留引用"
else
  fail "status-panel.ts 仍存在或有残留引用（两套面板会再次分叉）"
fi

if grep -q 'TAB_ORDER: ObserveTab\[\] = \["steps", "overview", "env", "shell"\]' "$OPANEL"; then
  pass "ObservePanel 提供 steps/overview/env/shell 四个 tab"
else
  fail "ObservePanel 缺少四个 tab"
fi

if grep -q "export class ObservePanel" "$OPANEL" 2>/dev/null \
  && grep -rq "new ObservePanel" "$COMMANDS_DIR"; then
  pass "/goo-status 用 ctx.ui.custom 渲染 ObservePanel"
else
  fail "/goo-status 未接入 TUI 面板"
fi

if grep -q "dispose(): void" "$OPANEL" && grep -q "clearInterval" "$OPANEL"; then
  pass "ObservePanel 在 dispose 中清理自动刷新定时器"
else
  fail "ObservePanel 未清理定时器（会泄漏）"
fi

# 渲染兜底：面板 render 抛异常不得杀死 pi 进程
if grep -q "export function guardRender" "$KIT" \
  && grep -q "guardRender" "$ROOT/.pi/extensions/autogoo-plugin/commands/start.ts" \
  && grep -q "guardRender" "$ROOT/.pi/extensions/autogoo-plugin/commands/other.ts" \
  && grep -q "guardRender" "$ROOT/.pi/extensions/autogoo-plugin/commands/thread.ts"; then
  pass "三个面板均经 guardRender 兜底（渲染异常不会让 pi 崩掉）"
else
  fail "面板 render 未兜底——一个渲染 bug 会让 pi uncaughtException 退出"
fi

# ready/waiting 必须按 depends_on 计算（曾错误地恒为 pending 数 / 0）
if grep -q "computeReady" "$OPANEL" && grep -q "depends_on" "$OPANEL"; then
  pass "ObservePanel 按 depends_on 计算 ready/waiting"
else
  fail "ObservePanel 未按依赖计算就绪步数"
fi

# renderBody 不得引用 render() 的局部变量（曾因 total 未定义导致崩溃）
if python3 - "$OPANEL" <<'PY2'
import re, sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding="utf-8")
start = src.find("private renderBody(")
if start < 0:
    raise SystemExit("renderBody not found")
end = src.find("\n  invalidate(", start)
body = src[start:end] if end > start else src[start:]
for name in ("total", "doneCount"):
    # 函数体内必须自己声明，否则运行时 ReferenceError
    if re.search(rf"\b{name}\b", body) and not re.search(rf"const {name}\s*=", body):
        raise SystemExit(f"renderBody references `{name}` without declaring it")
PY2
then
  pass "renderBody 自行声明 total/doneCount（不再引用 render() 的局部变量）"
else
  fail "renderBody 引用了未声明的变量（会 ReferenceError 崩掉 pi）"
fi

if grep -q "setInterval" "$OPANEL" && grep -q "requestRender" "$OPANEL"; then
  pass "ObservePanel 具备自动刷新"
else
  fail "ObservePanel 缺少自动刷新"
fi

# ── 23. 扩展不得直写终端 ──
# pi 的 TUI 独占屏幕：console.* / process.std*.write 会插进渲染流，绕过宽度与
# 光标计算，表现为乱码、残影、界面错位。曾有一行
# process.stderr.write("✅ 扩展已加载 …") 导致进入 pi 时出现乱码。
echo ""
echo "── 23. 扩展不得直写终端 ──"

EXT_DIR="$ROOT/.pi/extensions/autogoo-plugin"
# 断言应扫「整个 commands 目录」而不是单个文件 —— 文件拆分不该让断言误伤

if python3 - "$EXT_DIR" <<'PY2'
import sys
from pathlib import Path

root = Path(sys.argv[1])
offenders = []
for path in root.rglob("*.ts"):
    if "__tests__" in path.parts or path.name == "log.ts":
        continue
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.lstrip()
        if stripped.startswith("//") or stripped.startswith("*"):
            continue
        for needle in ("console.", "process.stdout.write", "process.stderr.write"):
            if needle in line:
                offenders.append(f"{path.relative_to(root)}:{lineno} {needle}")
if offenders:
    raise SystemExit("terminal writes (corrupt pi TUI): " + "; ".join(offenders[:5]))
PY2
then
  pass "扩展内无 console.* / process.std*.write（不会污染 TUI）"
else
  fail "扩展直接写终端，会导致 pi 界面乱码"
fi

if python3 - "$EXT_DIR/utils/log.ts" <<'PY2'
import sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding="utf-8")
if "appendFileSync" not in src:
    raise SystemExit("log.ts does not append to a file")
for lineno, line in enumerate(src.splitlines(), 1):
    stripped = line.lstrip()
    if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
        continue  # 注释里说明"禁止写终端"是正常的，不是实现
    if "console." in line or "process.stdout.write" in line or "process.stderr.write" in line:
        raise SystemExit(f"log.ts writes to terminal at line {lineno}")
PY2
then
  pass "utils/log.ts 只写日志文件，不写终端"
else
  fail "utils/log.ts 可能写终端"
fi

if grep -q "logError\|logWarn\|logInfo" "$EXT_DIR/index.ts"; then
  pass "index.ts 的诊断信息已走 log.ts"
else
  fail "index.ts 未使用 log.ts"
fi

# 启动 banner 不得残留（它会直接打在 TUI 上）
if grep -q "扩展已加载" "$EXT_DIR/index.ts"; then
  fail "启动 banner 仍往终端写（会乱码）"
else
  pass "启动 banner 已移除（加载状态由 pi 的 [Extensions] 展示）"
fi

# ── 24. 派发进度显示工具参数 ──
# 回归：进度行里工具调用曾被硬编码成 ⟦bash(...⟧ —— 参数全丢，用户只看到
# "有个 bash 在跑"，看不到在跑什么。
echo ""
echo "── 24. 派发进度可读性 ──"

TS_TS="$ROOT/.pi/extensions/autogoo-plugin/utils/tool-summary.ts"

for sym in "function describeToolCall" "export function describeMessageContent" "export function describeToolResult"; do
  if grep -q "$sym" "$TS_TS" 2>/dev/null; then
    pass "tool-summary 提供 $sym"
  else
    fail "tool-summary 缺少 $sym"
  fi
done

for f in "$COMMANDS_DIR" "$EXECUTE_TS"; do
  base="$(basename "$f")"
  if grep -rq "describeMessageContent(" "$f"; then
    pass "$base 用 describeMessageContent 渲染工具参数"
  else
    fail "$base 未使用 describeMessageContent（进度里看不到工具参数）"
  fi
done

# 关键回归：不得残留 ⟦name(...⟧ 占位。
# 注意跳过注释行 —— 解释"以前是 ⟦bash(...⟧"的说明文字本身包含该子串，
# 本项目已因同类误判踩坑 5 次，静态检查必须区分「代码」与「描述代码的文字」。
if python3 - "$ROOT/.pi/extensions/autogoo-plugin" <<'PY2'
import sys
from pathlib import Path

root = Path(sys.argv[1])
needle = "(...⟧"
offenders = []
for path in root.rglob("*.ts"):
    if "__tests__" in path.parts:
        continue
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.lstrip()
        if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
            continue
        if needle in line:
            offenders.append(f"{path.relative_to(root)}:{lineno}")
if offenders:
    raise SystemExit("tuple placeholder still in code: " + "; ".join(offenders[:5]))
PY2
then
  pass "无 ⟦工具(...⟧ 参数丢失占位（跳过注释行）"
else
  fail "仍存在 ⟦工具(...⟧ 占位（参数被丢弃）"
fi

# ── 25. subagent 实时活动（widget + 面板）──
# 需求：状态栏下面常驻显示 subagent 在做什么，并能切换进去看完整时间线。
echo ""
echo "── 25. subagent 实时活动 ──"

ACT_TS="$ROOT/.pi/extensions/autogoo-plugin/utils/activity.ts"
ACT_PANEL="$ROOT/.pi/extensions/autogoo-plugin/utils/subagent-panel.ts"

# Enter 必须真的进入详情视图（用户实测按 Enter 没反应 —— 当时根本没实现）
if grep -q "detailMode" "$ACT_PANEL" && grep -q "renderDetail" "$ACT_PANEL" \
  && grep -q 'matchesKey(data, "return")' "$ACT_PANEL"; then
  pass "SubagentPanel 支持 Enter 进入详情视图"
else
  fail "SubagentPanel 不支持 Enter 详情（按键会无反应）"
fi

SUB_CMD="$ROOT/.pi/extensions/autogoo-plugin/commands/subagent.ts"

for sym in "export const activityBus" "export function kindMark"; do
  if grep -q "$sym" "$ACT_TS" 2>/dev/null; then
    pass "activity 提供 $sym"
  else
    fail "activity 缺少 $sym"
  fi
done

if grep -q "export class SubagentPanel" "$ACT_PANEL" 2>/dev/null; then
  pass "SubagentPanel 存在"
else
  fail "SubagentPanel 缺失"
fi

for f in "$COMMANDS_DIR" "$EXECUTE_TS"; do
  base="$(basename "$f")"
  if grep -rq "activityBus.begin(" "$f" && grep -rq "activityBus.push(" "$f" && grep -rq "activityBus.end(" "$f"; then
    pass "$base 完整记录 begin/push/end"
  else
    fail "$base 未完整接入 activityBus（面板会看不到活动）"
  fi
done

# 用户反馈常驻 widget 与状态栏重复、太吵 —— 只保留按需打开的面板。
if ! grep -rq "setWidget(" "$ROOT/.pi/extensions/autogoo-plugin" --include=*.ts 2>/dev/null; then
  pass "不安装常驻 widget（活动只在 /goo-subagent 面板里看）"
else
  fail "仍在安装常驻 widget（用户已要求移除）"
fi

if grep -q '"goo-subagent"' "$ROOT/.pi/extensions/autogoo-plugin/index.ts" \
  && grep -q 'registerShortcut("alt+a"' "$ROOT/.pi/extensions/autogoo-plugin/index.ts"; then
  pass "/goo-subagent 命令与 alt+a 快捷键已注册"
else
  fail "缺少 /goo-subagent 命令或快捷键"
fi

if grep -q "new SubagentPanel" "$SUB_CMD" && grep -q "guardRender" "$SUB_CMD"; then
  pass "面板经 guardRender 兜底"
else
  fail "面板未兜底（渲染异常会崩 pi）"
fi

# 键位必须真的实现（写进 footer 但没实现 = 按不动）
SUB_MISSING=""
for key in '"tab"' '"pageUp"' '"pageDown"' '"home"' '"end"' '"up"' '"down"' '"escape"' '"return"'; do
  grep -q "matchesKey(data, $key)" "$ACT_PANEL" || SUB_MISSING="$SUB_MISSING $key"
done
if [[ -z "$SUB_MISSING" ]]; then
  pass "面板键位全部有实现（tab/pageUp/pageDown/home/end/up/down/escape）"
else
  fail "面板声明了但没实现的键:$SUB_MISSING"
fi

# footer 在窄宽度下不得截断成半个按键说明
if grep -q "while (list.length > 0 && visibleWidth(render(list)) > w)" "$ROOT/.pi/extensions/autogoo-plugin/utils/tui-kit.ts"; then
  pass "keyHelp 自适应宽度（放不下丢项而非截断）"
else
  fail "keyHelp 会截断按键提示文本"
fi

# ── 26. TypeScript 未定义标识符 ──
# node --check 只查语法，esbuild 只查模块解析 —— **两者都查不出未定义标识符**。
# 这就是 `logInfo is not defined` 能通过全部本地检查、却在 pi 启动时报错的原因。
echo ""
echo "── 26. TypeScript 未定义标识符 ──"

TS_CHECK="$ROOT/skills/auto-goo/scripts/check-ts-symbols.py"

if [[ -f "$TS_CHECK" ]] && python3 -m py_compile "$TS_CHECK" 2>/dev/null; then
  pass "check-ts-symbols.py 存在且可编译"
else
  fail "check-ts-symbols.py 缺失"
fi

if python3 "$TS_CHECK" "$ROOT/.pi/extensions/autogoo-plugin" >/dev/null 2>&1; then
  pass "扩展内无未定义标识符（运行时不会 ReferenceError）"
else
  fail "存在未定义标识符 —— 会在运行时抛 ReferenceError（如 logInfo is not defined）"
  python3 "$TS_CHECK" "$ROOT/.pi/extensions/autogoo-plugin" 2>&1 | sed -n '2,6p' | sed 's/^/    /'
fi

# 回归自检：检查器必须能抓出人为构造的缺失导入
TS_TMP="$(mktemp -d)"
mkdir -p "$TS_TMP/probe"
printf 'export function helper(): number { return 1; }\n' > "$TS_TMP/probe/lib.ts"
printf 'import { helper } from "./lib.js";\nexport function run(): number { return missing(helper()); }\n' > "$TS_TMP/probe/main.ts"
if python3 "$TS_CHECK" "$TS_TMP/probe" >/dev/null 2>&1; then
  fail "检查器自身失效：未能发现 missing()"
else
  pass "检查器能抓出缺失的标识符（自检通过）"
fi
rm -rf "$TS_TMP"

# ── 27. TUI 面板一致性 ──
# 四个面板（thread / usage / observe / subagent）必须共用同一套约定：
# 底部键提示走 keyHelp（自适应），头部带 ◆ 标记，窄宽度用 tabsLine/fitColumns。
echo ""
echo "── 27. TUI 面板一致性 ──"

TUIKIT="$ROOT/.pi/extensions/autogoo-plugin/utils/tui-kit.ts"

for sym in "export function tabsLine" "export function keyHelp" "export class ListState"; do
  if grep -q "$sym" "$TUIKIT" 2>/dev/null; then
    pass "tui-kit 提供 $sym"
  else
    fail "tui-kit 缺少 $sym"
  fi
done

for f in thread-ui.ts usage-panel.ts observe-panel.ts subagent-panel.ts; do
  path="$ROOT/.pi/extensions/autogoo-plugin/utils/$f"
  if grep -q "keyHelp(" "$path" && grep -q "guardRender\|render(width" "$path"; then
    pass "$f 使用 keyHelp 渲染底部键提示"
  else
    fail "$f 未使用 keyHelp（手写键提示会在窄终端被截断）"
  fi
done

# 有 tab 的面板必须用 tabsLine（否则 40 列下会显示成 "[4" 残句）
for f in usage-panel.ts observe-panel.ts; do
  path="$ROOT/.pi/extensions/autogoo-plugin/utils/$f"
  if grep -q "tabsLine(" "$path"; then
    pass "$f 使用 tabsLine（窄宽度自动紧凑）"
  else
    fail "$f 手写 tab 栏（窄终端会截断）"
  fi
done

# 头部统一用 ◆ 标记
MISSING_MARK=""
for f in thread-ui.ts usage-panel.ts observe-panel.ts subagent-panel.ts; do
  grep -q "◆" "$ROOT/.pi/extensions/autogoo-plugin/utils/$f" || MISSING_MARK="$MISSING_MARK $f"
done
if [[ -z "$MISSING_MARK" ]]; then
  pass "四个面板头部统一带 ◆ 标记"
else
  fail "面板头部标记不统一:$MISSING_MARK"
fi

# ── 28. 不使用重复的自定义 shell 工具 ──
# pi 自带 `bash` 工具（docs/cli.md:143）。插件曾额外注册 auto_goo_shell，
# 能力重复且**每次调用都强制 yes/no 确认**，系统提示也未引导使用它 —— 已移除。
echo ""
echo "── 28. shell 工具去重 ──"

if grep -rq 'name: "auto_goo_shell"' "$ROOT/.pi/extensions/autogoo-plugin" --include=*.ts 2>/dev/null; then
  fail "仍注册 auto_goo_shell（与 pi 内置 bash 重复，且每次强制确认）"
else
  pass "未注册 auto_goo_shell，shell 执行统一走 pi 内置 bash"
fi

# README 的工具数量必须与源码一致（避免增删工具后文档漂移）
if python3 - "$ROOT" <<'PY2'
import re, sys
from pathlib import Path

root = Path(sys.argv[1])
ext = root / ".pi/extensions/autogoo-plugin"
count = 0
for source in ext.rglob("*.ts"):
    if "__tests__" in source.parts:
        continue
    count += len(re.findall(r'name: "auto_goo', source.read_text(encoding="utf-8")))
readme = (root / "README.md").read_text(encoding="utf-8")
if f"{count} 个自定义工具" not in readme:
    raise SystemExit(f"README tool count out of sync (source={count})")
PY2
then
  pass "README 工具数量与源码一致"
else
  fail "README 工具数量与源码不一致"
fi

# ── 29. 更新检查缓存必须随本地 HEAD 失效 ──
# 实际误报：pi update 之后仍显示「有更新：本地 f5dec80 → 远端 3301aa0」——
# 因为缓存只校验 version/root/TTL，没校验本地 HEAD 是否已变。
echo ""
echo "── 29. 更新检查缓存失效 ──"

UPD2="$ROOT/skills/auto-goo/scripts/goo-update-check.py"

if grep -q "def load_cache(" "$UPD2" && grep -q "local_sha: str | None = None" "$UPD2" \
  && grep -q 'data.get("local_sha") not in (None, local_sha)' "$UPD2"; then
  pass "缓存读取会校验 local_sha（HEAD 变了就失效）"
else
  fail "缓存不校验 local_sha —— pi update 后会在 TTL 内持续误报有更新"
fi

if grep -q "local_sha, branch, remote = local_revision(root)" "$UPD2" \
  && python3 - "$UPD2" <<'PY2'
import sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding="utf-8")
# local_revision 必须出现在 load_cache 调用之前
rev = src.find("local_sha, branch, remote = local_revision(root)")
cache = src.find("cached = load_cache(")
if rev < 0 or cache < 0 or rev > cache:
    raise SystemExit("local_revision must run before load_cache")
PY2
then
  pass "先算本地 HEAD 再读缓存（顺序正确）"
else
  fail "缓存读取早于本地 HEAD 计算，校验必然失效"
fi

# ── 30. Subagent 超时优化（idle 检测 / 可配置 / 提前结束）──
# 回归：原来只有 30 分钟总超时，子进程卡住时整个 DAG 要白等半小时。
echo ""
echo "── 30. Subagent 超时优化 ──"

SUB_TS="$ROOT/.pi/extensions/autogoo-plugin/utils/subagent.ts"

for sym in "idleTimeoutMs?: number" "shouldStop?: () => boolean" "timeoutReason" "stoppedEarly"; do
  if grep -q "$sym" "$SUB_TS" 2>/dev/null; then
    pass "subagent 提供 $sym"
  else
    fail "subagent 缺少 $sym"
  fi
done

if grep -q "DEFAULT_IDLE_TIMEOUT_MS" "$SUB_TS" && grep -q "idleTimer" "$SUB_TS"; then
  pass "实现 idle 检测（无事件即判定卡住）"
else
  fail "缺少 idle 检测 —— 卡住时要等满总超时"
fi

# 关键安全性：idle 判定必须多信号，不能只看 JSON 事件
# （实测：subagent 跑 sleep/编译/训练期间 --mode json 完全静默，只看事件会误杀）
for sig in "readCpuTicks" "hasActiveDescendant" "cpuBusy" "descendantsBusy"; do
  if grep -q "$sig" "$SUB_TS" 2>/dev/null; then
    pass "idle 检测包含信号 $sig"
  else
    fail "idle 检测缺少信号 $sig —— 会误杀长命令"
  fi
done

if grep -q "长命令执行期间不误杀" "$ROOT/.pi/extensions/autogoo-plugin/__tests__/subagent-idle-safety.test.ts" 2>/dev/null; then
  pass "有「长命令不误杀」的回归测试"
else
  fail "缺少「长命令不误杀」测试 —— 这是 idle 检测最危险的失效模式"
fi

if grep -q "clearInterval(idleTimer)" "$SUB_TS"; then
  pass "idle 定时器在 stopTimers 中清理"
else
  fail "idle 定时器未清理（会泄漏）"
fi

# 超时必须可配置（两个派发路径都读 config.execution）
if grep -q "subagent_idle_timeout_seconds" "$ROOT/.pi/extensions/autogoo-plugin/utils/paths.ts"; then
  pass "config.execution 支持 subagent_idle_timeout_seconds"
else
  fail "超时不可配置（硬编码）"
fi
CFG_HITS=0
for f in "$COMMANDS_DIR" "$ROOT/.pi/extensions/autogoo-plugin/tools/execute.ts"; do
  grep -rq "subagentIdleTimeoutMs" "$f" && CFG_HITS=$((CFG_HITS + 1))
done
if [[ "$CFG_HITS" -ge 2 ]]; then
  pass "两个派发路径都传入 idle 超时"
else
  fail "有派发路径未传 idle 超时（会回退默认值）"
fi

# 提前结束：step 已结束就不必等
if grep -q "shouldStop" "$SUB_TS" && grep -rq "loadPlanSync" "$COMMANDS_DIR"; then
  pass "step 结束后提前终止子进程（不等满 timeout）"
else
  fail "缺少 shouldStop 接入 —— 干完活没退出的子进程会拖满超时"
fi

# ── 31. 工具参数必须用 TypeBox ──
# pi 的 registerTool<TParams extends TSchema> 要求 TypeBox schema。
# 传原生 JSON Schema（{ type: "object", properties: {...} }）会让参数解析失效 ——
# 表现为工具调用内容被当普通文本打印，而不是渲染成 UI（用户实测看到 XML 原文）。
echo ""
echo "── 31. 工具参数用 TypeBox ──"

if python3 - "$ROOT/.pi/extensions/autogoo-plugin" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
offenders = []
for path in root.rglob("*.ts"):
    if "__tests__" in path.parts:
        continue
    text = path.read_text(encoding="utf-8")
    # 找 `parameters:` 后面紧跟原生 JSON Schema 的写法（而非 Type.Object）
    for match in re.finditer(r"parameters:\s*\{", text):
        line = text[: match.start()].count("\n") + 1
        offenders.append(f"{path.relative_to(root)}:{line}")
if offenders:
    raise SystemExit("native JSON schema in parameters (must use Type.Object): " + "; ".join(offenders))
PY
then
  pass "所有工具 parameters 都用 Type.Object（TypeBox）"
else
  fail "有工具用原生 JSON Schema 定义 parameters —— UI 会渲染失败"
fi

if grep -q 'import { Type } from "typebox";' "$ROOT/.pi/extensions/autogoo-plugin/index.ts"; then
  pass "index.ts 已引入 TypeBox 的 Type"
else
  fail "index.ts 未引入 TypeBox"
fi

# ── 32. 配置字段必须有消费点 ──
# 回归：planning.recall_wiki / require_wiki_context 曾经**全仓零引用** ——
# 用户改了配置毫无反应，且没有任何提示（与 auto_goo_ask_user 的 TypeBox 问题
# 同属「静默失效」）。这里静态检查 TS 侧声明的每个 config 字段是否被消费。
echo ""
echo "── 32. 配置字段消费 ──"

if python3 - "$ROOT" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
ext = root / ".pi/extensions/autogoo-plugin"
paths_ts = (ext / "utils/paths.ts").read_text(encoding="utf-8")
scripts = root / "skills/auto-goo/scripts"

# 只查「纯 TS 侧」的配置段：execution / planning / interaction / init。
# publish / archive 等由 Python 脚本消费，不在此列。
INTERFACES = ("ExecutionConfig", "execution", "planning", "interaction", "init")
fields = set()
for m in re.finditer(r"(execution|planning|interaction|init)\??:\s*\{([^}]*)\}", paths_ts, re.S):
    for f in re.findall(r"^\s*([a-z_]+)\??:", m.group(2), re.M):
        fields.add(f)

# 认为「有意不消费」的白名单（需写明理由）
ALLOW = {
    "prompt_for_scope",   # init 段仅作文档性声明，交互与否由命令流程决定
    "prompt_for_wiki_dir",
}

ts_sources = "\n".join(
    p.read_text(encoding="utf-8")
    for p in ext.rglob("*.ts")
    if "__tests__" not in p.parts and p.name != "paths.ts"
)
py_sources = "\n".join(
    p.read_text(encoding="utf-8") for p in scripts.glob("*.py")
) if scripts.is_dir() else ""

dead = []
for f in sorted(fields - ALLOW):
    # ⚠ 必须用**词边界**匹配：`heartbeat_seconds` 曾被 `stale_heartbeat_seconds`
    # 子串命中而误判为「有消费点」——但它其实没人用。
    pattern = re.compile(rf"\b{re.escape(f)}\b")
    if pattern.search(ts_sources) or pattern.search(py_sources):
        continue
    dead.append(f)
if dead:
    raise SystemExit("config fields with no consumer: " + ", ".join(dead))
PY
then
  pass "所有 TS 侧声明、由 TS 消费的配置字段都有消费点"
else
  fail "存在「声明了但没人用」的配置字段 —— 用户改了不生效"
fi

# ── 33. Python 兼容性（f-string 引号嵌套）──
# 回归：goo-usage.py 有 16 处 `f"...{..."<"...}..."`（f-string 内用与外层
# 相同的引号）。PEP 701(Python 3.12) 之后才允许，而 pyproject 声明 >=3.10 ——
# 在 3.10/3.11 上直接 SyntaxError，而本机 3.14 完全测不出来。
echo ""
echo "── 33. Python 兼容性（f-string 引号）──"

if python3 - "$ROOT" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
scripts = root / "skills/auto-goo/scripts"
offenders = []
for path in sorted(scripts.glob("*.py")):
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        # f" 开头且 {...} 内含 " ；或 f' 且 {...} 内含 '
        if re.search(r'f"[^\n]*\{[^}\n]*"[^}\n]*\}', line) or re.search(r"f'[^\n]*\{[^}\n]*'[^}\n]*\}", line):
            offenders.append(f"{path.name}:{lineno}")
if offenders:
    raise SystemExit(
        "f-string with same-quote nesting (breaks on Python <3.12): " + "; ".join(offenders[:8])
    )
PY
then
  pass "Python 脚本无 f-string 同种引号嵌套（兼容 3.10/3.11）"
else
  fail "存在 f-string 同种引号嵌套 —— Python 3.10/3.11 会 SyntaxError"
fi

# 有条件时用真正的 3.10 编译验证（本机 3.14 测不出 PEP 701 之前的限制）
PY310=""
for cand in python3.10 python3.11; do
  if command -v "$cand" >/dev/null 2>&1; then PY310="$cand"; break; fi
done
if [[ -n "$PY310" ]]; then
  PY_FAIL=""
  for f in "$ROOT"/skills/auto-goo/scripts/*.py; do
    "$PY310" -c 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$f" 2>/dev/null || PY_FAIL="$PY_FAIL $(basename "$f")"
  done
  if [[ -z "$PY_FAIL" ]]; then
    pass "全部 Python 脚本在 $PY310 下可解析"
  else
    fail "Python 脚本在 $PY310 下解析失败:$PY_FAIL"
  fi
else
  warn "未安装 python3.10/3.11，跳过真机解析（静态规则已覆盖）"
fi

# ── 34. 「让 LLM 干活」的提示词必须直接发送 ──
# 回归：goo-brainstorm / goo-research / goo-usage-report / goo-improve /
# goo-benchmark 都用 setEditorText() 塞提示词 —— 文字进了输入框，用户必须
# 再按一次 Enter 才发送，表现就是"选了之后没反应，文字跑到输入框里"。
# 展示给用户看的内容（如 plan 摘要）用 setEditorText 是正确的，不计入。
echo ""
echo "── 34. 提示词直发（而非塞输入框）──"

if python3 - "$ROOT" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
cmds = root / ".pi/extensions/autogoo-plugin/commands"
offenders = []
# 这些 handler 的末尾 setEditorText 都是「让模型执行」的 prompt
DISPATCH_HANDLERS = (
    "handleGooBrainstorm",
    "handleGooResearch",
    "handleGooUsageAnalyse",
    "handleGooImprove",
    "handleGooBenchmark",
)
for path in cmds.glob("*.ts"):
    text = path.read_text(encoding="utf-8")
    for h in DISPATCH_HANDLERS:
        m = re.search(rf"(?:export )?async function {h}\b", text)
        if not m:
            continue
        # 取函数体（到下一个顶层 export/async function 为止）
        nxt = re.search(r"\n(?:export )?async function ", text[m.end():])
        body = text[m.end(): m.end() + (nxt.start() if nxt else len(text))]
        # 允许 dispatchPrompt(...) 形式，或用 getPi() 后 sendUserMessage
        if "dispatchPrompt(" in body or "sendUserMessage(" in body:
            continue
        if "setEditorText(" in body:
            offenders.append(f"{path.name}:{h}")
if offenders:
    raise SystemExit("prompt sent to editor instead of agent: " + "; ".join(offenders))
PY
then
  pass "所有 LLM 任务型命令都直接发送（dispatchPrompt / sendUserMessage）"
else
  fail "有命令把提示词塞进输入框 —— 用户需手动按 Enter 才发送"
fi

# ── 35. 调用脚本时不得传它不支持的参数 ──
# 回归：plan.ts 给 wiki-graph-assist.py 传了 `--compact`（脚本没这个参数），
# argparse 直接 exit 2 → stdout 空 → 静默 found:false，
# /goo-plan 的 wiki 召回从未成功过一次。
echo ""
echo "── 35. 脚本参数真实性 ──"

if python3 - "$ROOT" <<'EOFPY35'
"""
校验 TS 调用 Python 脚本时，传的参数确实是脚本支持的。

精确匹配策略（避免把同文件里别的脚本的参数算进来）：
  1. 建立「变量 -> 脚本名」映射：`const VAR = join(..., "foo.py")` 或 `const VAR = "...foo.py"`
  2. 只检查 `execPython(VAR, [ ... ])` / `execPythonAsync(VAR, [ ... ])` 的数组字面量
  3. 直接内联字符串的调用 `execPython("...foo.py", [...])` 也支持

历史 bug：plan.ts 给 wiki-graph-assist.py 传了 `--compact`（脚本没这个参数），
argparse exit 2 → stdout 空 → 静默 found:false，召回从未成功过。
"""

import re
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1])
ext = root / ".pi/extensions/autogoo-plugin"
scripts = root / "skills/auto-goo/scripts"

help_cache: dict[str, set[str] | None] = {}


def supported(script: str):
    if script in help_cache:
        return help_cache[script]
    path = scripts / script
    if not path.exists():
        help_cache[script] = None
        return None
    try:
        out = subprocess.run(
            [sys.executable, str(path), "--help"],
            capture_output=True,
            text=True,
            timeout=20,
        )
        opts = set(re.findall(r"--[a-z0-9][a-z0-9-]*", out.stdout + out.stderr))
        help_cache[script] = opts
        return opts
    except Exception:
        help_cache[script] = None
        return None


def array_literal(code: str, start: int) -> str:
    """code[start] 应为 '['；返回匹配的 [...] 片段。"""
    if start >= len(code) or code[start] != "[":
        return ""
    depth = 0
    for i in range(start, len(code)):
        ch = code[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return code[start : i + 1]
    return ""


problems = []

for f in ext.rglob("*.ts"):
    if "__tests__" in f.parts:
        continue
    text = f.read_text(encoding="utf-8")

    # 1) 变量赋值位置清单（同一变量名在文件里会被不同函数重复使用，
    #    所以不能做全局映射 —— 必须取「调用点之前、距离最近」的那次赋值）
    decls: list[tuple[int, str, str]] = []  # (pos, var, script)
    for m in re.finditer(
        r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?\"([a-zA-Z0-9/_.-]+\.py)\"",
        text,
    ):
        decls.append((m.start(), m.group(1), m.group(2).rsplit("/", 1)[-1]))

    def script_for_var(var: str, at: int):
        """取 at 之前最近的同名变量赋值。"""
        best = None
        for pos, name, script in decls:
            if name == var and pos < at:
                if best is None or pos > best[0]:
                    best = (pos, script)
        return best[1] if best else None

    # 2) execPython(VAR, [ ... ]) / execPython("x.py", [ ... ])
    for m in re.finditer(
        r"\bexec(?:Python|PythonAsync)\s*\(\s*(?:\"([a-zA-Z0-9/_.-]+\.py)\"|([A-Za-z_$][\w$]*))\s*,\s*",
        text,
    ):
        if m.group(1):
            script = m.group(1).rsplit("/", 1)[-1]
        else:
            script = script_for_var(m.group(2) or "", m.start())
        if not script:
            continue
        opts = supported(script)
        if opts is None:
            continue
        # 逗号后跳过空白，期望数组字面量；也可能是变量，则解引用到它的赋值
        pos = m.end()
        while pos < len(text) and text[pos] in " \t\n":
            pos += 1
        arr = ""
        if pos < len(text) and text[pos] == "[":
            arr = array_literal(text, pos)
        elif pos < len(text) and (text[pos].isalpha() or text[pos] in "_$"):
            vm = re.match(r"([A-Za-z_$][\w$]*)", text[pos:])
            if vm:
                vname = vm.group(1)
                # 就近向前找 `const vname = [ ... ]`
                best = -1
                for dm in re.finditer(
                    rf"\b(?:const|let|var)\s+{re.escape(vname)}\s*(?::[^=]+)?=\s*\[", text
                ):
                    if dm.start() < pos:
                        best = dm.start()
                if best >= 0:
                    bpos = text.index("[", best)
                    arr = array_literal(text, bpos)
                    # 加上后续 args.push("--flag") 形式的追加
                    tail = text[pos : pos + 3000]
                    arr += "".join(
                        re.findall(rf"{re.escape(vname)}\.push\(([^)]*)\)", tail)
                    )
        if not arr:
            continue
        for flag in sorted(set(re.findall(r"\"(--[a-z0-9][a-z0-9-]*)\"", arr))):
            if flag not in opts:
                line = text[: m.start()].count("\n") + 1
                problems.append(f"{f.name}:{line} {script} 不支持 {flag}")

if problems:
    print("; ".join(problems[:8]), file=sys.stderr)
    raise SystemExit(1)

EOFPY35
then
  pass "TS 调用的脚本参数均真实存在（脚本 -h 校验）"
else
  fail "有 TS 传给脚本的参数脚本并不支持 —— 会 exit 2 且通常静默失败"
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

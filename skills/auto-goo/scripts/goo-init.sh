#!/usr/bin/env bash
# AutoGoo-Plugin: interactive configuration initializer
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  goo-init.sh [--user|--project] [--wiki-dir PATH] [--project-layout NAME] [--project-dirs LIST] [--project-slug SLUG] [--server SPEC] [--yes] [--force] [--agent claude|codex|both] [--update-claude-md] [--skip-claude-md]

Options:
  --user            Write user-level config + conventions to ~/.auto-goo/ (config.json + goo.md)
  --project         Write project-level config to .goo/config.json
  --wiki-dir PATH   Set Goo-wiki directory (default: ~/workspace/Goo-wiki)
  --project-layout NAME
                    Create/record a project directory layout: none, standard, ml, data, docs (default: none)
  --project-dirs LIST
                    Comma-separated project directories to create/record, e.g. src,data/raw,docs,references/papers
  --project-slug SLUG
                    Set Goo-wiki project archive folder name (default: project directory name)
  --server SPEC     Add a remote server without entering the TTY prompts. Repeatable.
                    SPEC uses comma-separated key=value pairs:
                    name=gpu-box,host=HOST,user=USER,port=22,type=gpu,purpose=模型训练
                    If a server with the same name already exists it is REPLACED (upsert).
                    Passwords are not accepted on the command line; edit the
                    generated secrets file after init and keep chmod 600.
  --remove-server NAME
                    Remove an existing remote server by name. Repeatable.
                    Also removes the matching entry from the secrets file.
  --clear-servers   Remove ALL existing remote servers (config + secrets).
  --yes             Use defaults for unanswered prompts
  --force           Overwrite existing config without asking
  --update-claude-md
                    Update goo.md + CLAUDE.md/AGENTS.md pointers without asking
  --skip-claude-md  Do not update goo.md + CLAUDE.md/AGENTS.md pointers
  --write-user-pointer
                    Write user-level pointer to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
  --skip-user-pointer
                    Do not write user-level pointer (overrides the --user default)
  --agent TARGET     Write pointer to claude, codex (AGENTS.md), or both (default: both)
  -h, --help        Show this help
EOF
}

SCOPE=""
WIKI_DIR="${AUTOGOO_PLUGIN_WIKI_DIR:-}"
WIKI_DIR_PROVIDED=0
WORK_DIR=".goo"
WORKSPACE_LAYOUT="standard"
PROJECT_LAYOUT="none"
PROJECT_DIRS=""
PROJECT_LAYOUT_PROVIDED=0
PROJECT_DIRS_PROVIDED=0
WRITE_PROJECT_WORKSPACE_CLAUDE=0
PROJECT_SLUG=""
YES=0
FORCE=0
UPDATE_CLAUDE_MD=0
SKIP_CLAUDE_MD=0
AGENT_TARGET=""
USER_POINTER=""
USER_POINTER_SEEN=0
SERVER_SPECS=()
REMOVE_SERVERS=()
CLEAR_SERVERS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      SCOPE="user"
      shift
      ;;
    --project)
      SCOPE="project"
      shift
      ;;
    --wiki-dir)
      if [[ $# -lt 2 ]]; then
        echo "error: --wiki-dir requires a path" >&2
        exit 2
      fi
      WIKI_DIR="$2"
      WIKI_DIR_PROVIDED=1
      shift 2
      ;;
    --project-layout)
      if [[ $# -lt 2 ]]; then
        echo "error: --project-layout requires a value" >&2
        exit 2
      fi
      PROJECT_LAYOUT="$2"
      PROJECT_LAYOUT_PROVIDED=1
      shift 2
      ;;
    --project-dirs)
      if [[ $# -lt 2 ]]; then
        echo "error: --project-dirs requires a comma-separated list" >&2
        exit 2
      fi
      PROJECT_DIRS="$2"
      PROJECT_DIRS_PROVIDED=1
      shift 2
      ;;
    --project-slug)
      if [[ $# -lt 2 ]]; then
        echo "error: --project-slug requires a value" >&2
        exit 2
      fi
      PROJECT_SLUG="$2"
      shift 2
      ;;
    --server)
      if [[ $# -lt 2 ]]; then
        echo "error: --server requires a key=value spec" >&2
        exit 2
      fi
      SERVER_SPECS+=("$2")
      shift 2
      ;;
    --remove-server)
      if [[ $# -lt 2 ]]; then
        echo "error: --remove-server requires a server name" >&2
        exit 2
      fi
      REMOVE_SERVERS+=("$2")
      shift 2
      ;;
    --clear-servers)
      CLEAR_SERVERS=1
      shift
      ;;
    --yes|-y)
      YES=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --update-claude-md)
      UPDATE_CLAUDE_MD=1
      shift
      ;;
    --skip-claude-md)
      SKIP_CLAUDE_MD=1
      shift
      ;;
    --write-user-pointer)
      USER_POINTER="yes"
      USER_POINTER_SEEN=$((USER_POINTER_SEEN + 1))
      shift
      ;;
    --skip-user-pointer)
      USER_POINTER="no"
      USER_POINTER_SEEN=$((USER_POINTER_SEEN + 1))
      shift
      ;;
    --agent)
      if [[ $# -lt 2 ]]; then
        echo "error: --agent requires claude|codex|both" >&2
        exit 2
      fi
      case "$2" in
        claude|codex|both)
          ;;
        *)
          echo "error: --agent must be one of: claude, codex, both (got: $2)" >&2
          exit 2
          ;;
      esac
      AGENT_TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$UPDATE_CLAUDE_MD" -eq 1 && "$SKIP_CLAUDE_MD" -eq 1 ]]; then
  echo "error: --update-claude-md and --skip-claude-md cannot be used together" >&2
  exit 2
fi

if [[ "$USER_POINTER_SEEN" -gt 1 ]]; then
  echo "error: --write-user-pointer and --skip-user-pointer cannot be used together" >&2
  exit 2
fi

prompt() {
  local message="$1"
  local default_value="$2"
  local answer

  if [[ "$YES" -eq 1 || ! -t 0 ]]; then
    printf '%s\n' "$default_value"
    return
  fi

  read -r -p "$message [$default_value]: " answer
  if [[ -z "$answer" ]]; then
    printf '%s\n' "$default_value"
  else
    printf '%s\n' "$answer"
  fi
}

confirm() {
  local message="$1"
  local default_value="${2:-n}"
  local answer

  if [[ "$YES" -eq 1 || "$FORCE" -eq 1 || ! -t 0 ]]; then
    [[ "$default_value" == "y" ]]
    return
  fi

  read -r -p "$message [y/N]: " answer
  answer="${answer:-$default_value}"
  [[ "$answer" == "y" || "$answer" == "Y" || "$answer" == "yes" || "$answer" == "YES" ]]
}

expand_path() {
  local raw="$1"
  if [[ "$raw" == "~" ]]; then
    printf '%s\n' "$HOME"
  elif [[ "$raw" == "~/"* ]]; then
    printf '%s/%s\n' "$HOME" "${raw#\~/}"
  else
    printf '%s\n' "$raw"
  fi
}

join_path() {
  local root="$1"
  local child="$2"
  if [[ "$root" == "." || -z "$root" ]]; then
    printf '%s\n' "$child"
  else
    printf '%s/%s\n' "${root%/}" "$child"
  fi
}

workspace_path() {
  local key="$1"
  case "$key" in
    threads_dir) join_path "$WORK_DIR" "threads" ;;
    current_thread_file) join_path "$WORK_DIR" "current_thread.json" ;;
    compat_plan_file) join_path "$WORK_DIR" "plan.json" ;;
    compat_brainstorm_file) join_path "$WORK_DIR" "brainstorm.json" ;;
    plans_history_dir) join_path "$WORK_DIR" "plans/history" ;;
    brainstorms_history_dir) join_path "$WORK_DIR" "brainstorms/history" ;;
    logs_dir) join_path "$WORK_DIR" "logs" ;;
    artifacts_dir) join_path "$WORK_DIR" "artifacts" ;;
    reports_dir) join_path "$WORK_DIR" "reports" ;;
    locks_dir) join_path "$WORK_DIR" "locks" ;;
    change_requests_dir) join_path "$WORK_DIR" "change-requests" ;;
    obsidian_dir) join_path "$WORK_DIR" "obsidian" ;;
    site_dir) join_path "$WORK_DIR" "site" ;;
    index_file) join_path "$WORK_DIR" "site/index.html" ;;
  esac
}

project_layout_dirs() {
  case "$PROJECT_LAYOUT" in
    none)
      ;;
    standard)
      printf '%s\n' src tests docs references references/papers scripts data artifacts
      ;;
    ml)
      printf '%s\n' src configs scripts notebooks references references/papers data/raw data/processed data/external models outputs reports docs tests
      ;;
    data)
      printf '%s\n' src scripts notebooks references references/papers data/raw data/interim data/processed data/external reports docs tests
      ;;
    docs)
      printf '%s\n' docs docs/adr docs/assets references references/papers scripts src tests
      ;;
    custom)
      ;;
  esac
  if [[ -n "$PROJECT_DIRS" ]]; then
    python3 - "$PROJECT_DIRS" <<'PY'
import sys

for item in sys.argv[1].split(","):
    text = item.strip().strip("/")
    if text:
        print(text)
PY
  fi
}

project_layout_dirs_json() {
  PROJECT_LAYOUT_DIRS="$(project_layout_dirs | awk '!seen[$0]++')"
  python3 - "$PROJECT_LAYOUT_DIRS" <<'PY'
import json
import sys

raw = sys.argv[1]
items = [line.strip() for line in raw.splitlines() if line.strip()]
print(json.dumps(items, ensure_ascii=False))
PY
}

ensure_wiki_vault() {
  local wiki_dir="$1"
  WIKI_CREATED=0

  if [[ ! -d "$wiki_dir" ]]; then
    mkdir -p "$wiki_dir"
    WIKI_CREATED=1
  fi

  mkdir -p \
    "$wiki_dir/wiki/projects" \
    "$wiki_dir/wiki/concepts" \
    "$wiki_dir/wiki/questions" \
    "$wiki_dir/journal/daily" \
    "$wiki_dir/journal/weekly"

  if [[ ! -f "$wiki_dir/CLAUDE.md" ]]; then
    cat > "$wiki_dir/CLAUDE.md" <<'EOF'
# Goo-wiki Instructions

This vault stores reusable project memory for AutoGoo-Plugin workflows.

- Put project notes under `wiki/projects/`.
- Put reusable concepts under `wiki/concepts/`.
- Put daily and weekly work logs under `journal/daily/` and `journal/weekly/`.
- Keep `log.md` as a compact activity index.
EOF
    WIKI_CREATED=1
  fi

  if [[ ! -f "$wiki_dir/log.md" ]]; then
    printf '# Goo-wiki Log\n' > "$wiki_dir/log.md"
    WIKI_CREATED=1
  fi
}

project_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

default_project_slug() {
  local root="$1"
  local raw
  raw="$(basename "$root")"
  raw="$(printf '%s\n' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
  if [[ -z "$raw" ]]; then
    raw="project"
  fi
  printf '%s\n' "$raw"
}

git_remote_url() {
  local root="$1"
  local remote
  if ! git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 1
  fi
  if git -C "$root" remote get-url origin 2>/dev/null; then
    return 0
  fi
  remote="$(git -C "$root" remote 2>/dev/null | sed -n '1p')"
  if [[ -n "$remote" ]]; then
    git -C "$root" remote get-url "$remote" 2>/dev/null
    return $?
  fi
  return 1
}

prompt_secret() {
  local message="$1"
  local answer

  if [[ "$YES" -eq 1 || ! -t 0 ]]; then
    printf '%s\n' ""
    return
  fi

  read -r -s -p "$message: " answer
  echo >&2
  printf '%s\n' "$answer"
}

save_server_secrets() {
  local secrets_file="$1"
  local name="$2"
  local host="$3"
  local user="$4"
  local pass="$5"
  local secrets_dir
  secrets_dir="$(dirname "$secrets_file")"

  mkdir -p "$secrets_dir"
  python3 - "$secrets_file" "$name" "$host" "$user" "$pass" <<'PY'
import json
import sys
from pathlib import Path

secrets_file = Path(sys.argv[1])
name = sys.argv[2]
host = sys.argv[3]
user = sys.argv[4]
password = sys.argv[5]

if secrets_file.exists():
    try:
        secrets = json.loads(secrets_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, ValueError):
        secrets = []
else:
    secrets = []

if not isinstance(secrets, list):
    secrets = []

updated = False
for item in secrets:
    if not isinstance(item, dict):
        continue
    item_host = str(item.get("host") or item.get("ip") or "")
    item_name = str(item.get("name") or "")
    if (item_host == host or (name and item_name == name)) and str(item.get("user") or "") == user:
        if name:
            item["name"] = name
        item["host"] = host
        item.setdefault("ip", host)
        item["user"] = user
        if password:
            item["password"] = password
        else:
            item.setdefault("password", "")
        updated = True
        break

if not updated:
    item = {"host": host, "user": user, "password": password}
    if name:
        item["name"] = name
    item["ip"] = host
    secrets.append(item)
secrets_file.write_text(json.dumps(secrets, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  chmod 600 "$secrets_file"
}

load_existing_servers_json() {
  local config_file="$1"
  if [[ ! -f "$config_file" ]]; then
    printf '[]\n'
    return
  fi
  python3 - "$config_file" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    config = json.loads(path.read_text(encoding="utf-8"))
except (json.JSONDecodeError, OSError):
    print("[]")
    raise SystemExit(0)

servers = config.get("servers")
if not servers:
    servers = config.get("compute_servers")
if not isinstance(servers, list):
    servers = []
print(json.dumps(servers, ensure_ascii=False))
PY
}

append_server_json() {
  local current_json="$1"
  local name="$2"
  local host="$3"
  local user="$4"
  local port="$5"
  local server_type="$6"
  local purpose="$7"
  local secrets_file="$8"

  local workdir="${9:-}"
  local setup_commands="${10:-}"
  local data_dir="${11:-}"
  local artifacts_dir="${12:-}"

  python3 - "$current_json" "$name" "$host" "$user" "$port" "$server_type" "$purpose" "$secrets_file" "$workdir" "$setup_commands" "$data_dir" "$artifacts_dir" <<'PY'
import json
import sys

current_json, name, host, user, port, server_type, purpose, secrets_file, workdir, setup_commands, data_dir, artifacts_dir = sys.argv[1:13]
try:
    servers = json.loads(current_json)
except (json.JSONDecodeError, ValueError):
    servers = []
if not isinstance(servers, list):
    servers = []
server = {
    "name": name,
    "host": host,
    "ip": host,
    "user": user,
    "port": int(port) if str(port).isdigit() else port,
    "type": server_type,
    "purpose": purpose,
    "secrets_file": secrets_file,
}
defaults = {}
if workdir:
    defaults["workdir"] = workdir
if setup_commands:
    defaults["setup_commands"] = [item.strip() for item in setup_commands.split(";") if item.strip()]
paths = {}
if data_dir:
    paths["data_dir"] = data_dir
if artifacts_dir:
    paths["artifacts_dir"] = artifacts_dir
if paths:
    defaults["paths"] = paths
if defaults:
    server["defaults"] = defaults
if not name:
    server.pop("name", None)
# Upsert: replace an existing server with the same name instead of duplicating it
if name:
    servers = [s for s in servers if not (isinstance(s, dict) and s.get("name") == name)]
servers.append(server)
print(json.dumps(servers, ensure_ascii=False))
PY
}

remove_server_json() {
  local current_json="$1"
  local name="$2"
  python3 - "$current_json" "$name" <<'PY'
import json
import sys

current_json, name = sys.argv[1:3]
try:
    servers = json.loads(current_json)
except (json.JSONDecodeError, ValueError):
    servers = []
if not isinstance(servers, list):
    servers = []
servers = [s for s in servers if not (isinstance(s, dict) and s.get("name") == name)]
print(json.dumps(servers, ensure_ascii=False))
PY
}

remove_server_secrets() {
  local secrets_file="$1"
  local name="$2"
  if [[ -z "$name" || ! -f "$secrets_file" ]]; then
    return 0
  fi
  python3 - "$secrets_file" "$name" <<'PY'
import json
import sys
from pathlib import Path

secrets_file = Path(sys.argv[1])
name = sys.argv[2]
try:
    secrets = json.loads(secrets_file.read_text(encoding="utf-8"))
except (json.JSONDecodeError, ValueError, OSError):
    raise SystemExit(0)
if not isinstance(secrets, list):
    raise SystemExit(0)
new_secrets = [s for s in secrets if not (isinstance(s, dict) and s.get("name") == name)]
if len(new_secrets) != len(secrets):
    secrets_file.write_text(json.dumps(new_secrets, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    chmod = 0o600
    secrets_file.chmod(chmod)
PY
}

parse_server_spec() {
  local spec="$1"
  python3 - "$spec" <<'PY'
import sys

spec = sys.argv[1]
values = {}
for part in spec.split(","):
    part = part.strip()
    if not part:
        continue
    if "=" not in part:
        print(f"error: invalid --server segment without '=': {part}", file=sys.stderr)
        raise SystemExit(2)
    key, value = part.split("=", 1)
    values[key.strip().lower()] = value.strip()

name = values.get("name") or values.get("alias") or values.get("label") or ""
host = values.get("host") or values.get("ip")
user = values.get("user")
port = values.get("port") or "22"
server_type = (values.get("type") or "cpu").lower()
purpose = values.get("purpose") or "-"
workdir = values.get("workdir") or values.get("workspace") or values.get("working_dir") or ""
setup = values.get("setup") or values.get("setup_commands") or values.get("env_setup") or ""
data_dir = values.get("data_dir") or values.get("data") or ""
artifacts_dir = values.get("artifacts_dir") or values.get("outputs_dir") or values.get("output_dir") or ""

if not host:
    print("error: --server requires host=HOST or ip=HOST", file=sys.stderr)
    raise SystemExit(2)
if not user:
    print("error: --server requires user=USER", file=sys.stderr)
    raise SystemExit(2)
if not str(port).isdigit():
    print("error: --server port must be numeric", file=sys.stderr)
    raise SystemExit(2)
if server_type not in {"cpu", "gpu"}:
    print("error: --server type must be cpu or gpu", file=sys.stderr)
    raise SystemExit(2)

for value in (name, host, user, port, server_type, purpose, workdir, setup, data_dir, artifacts_dir):
    print(value)
PY
}

if [[ -z "$SCOPE" ]]; then
  if [[ ! -t 0 ]]; then
    echo "error: cannot choose init scope in non-interactive mode" >&2
    echo "hint: pass --user or --project explicitly" >&2
    exit 2
  fi
  SCOPE="$(prompt "Configure AutoGoo-Plugin for user or project? (user/project)" "user")"
fi

case "$SCOPE" in
  user)
    CONFIG_DIR="$HOME/.auto-goo"
    CONFIG_FILE="$CONFIG_DIR/config.json"
    ;;
  project)
    ROOT="$(project_root)"
    CONFIG_DIR="$ROOT/.goo"
    CONFIG_FILE="$CONFIG_DIR/config.json"
    ;;
  *)
    echo "error: scope must be 'user' or 'project'" >&2
    exit 2
    ;;
esac

# 解析 wiki 目录默认值：已配置的用户级路径应被复用，而不是每个项目重新输入。
# 优先级：--wiki-dir 显式传入 > AUTOGOO_PLUGIN_WIKI_DIR > 用户级 config.json.wiki_dir > ~/workspace/Goo-wiki
resolve_default_wiki_dir() {
  local user_cfg="$HOME/.auto-goo/config.json"
  if [[ -n "${AUTOGOO_PLUGIN_WIKI_DIR:-}" ]]; then
    printf '%s\n' "$AUTOGOO_PLUGIN_WIKI_DIR"
    return
  fi
  if [[ -f "$user_cfg" ]]; then
    local configured
    configured="$(python3 - "$user_cfg" <<'PY'
import json, sys
from pathlib import Path
try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    value = data.get("wiki_dir") if isinstance(data, dict) else None
    print(value if isinstance(value, str) else "")
except (OSError, ValueError):
    print("")
PY
)"
    if [[ -n "$configured" ]]; then
      printf '%s\n' "$configured"
      return
    fi
  fi
  printf '%s\n' "$HOME/workspace/Goo-wiki"
}

if [[ -z "$WIKI_DIR" ]]; then
  DEFAULT_WIKI_DIR="$(resolve_default_wiki_dir)"
  if [[ ! -t 0 ]]; then
    # 非交互：直接采用解析出的默认值（用户级已配置则复用），不再报错退出。
    WIKI_DIR="$DEFAULT_WIKI_DIR"
    WIKI_DIR_PROVIDED=1
    echo "wiki_dir: using $WIKI_DIR (from user config / env / default)"
  else
    WIKI_DIR="$(prompt "Goo-wiki directory (press Enter to use default)" "$DEFAULT_WIKI_DIR")"
    WIKI_DIR_PROVIDED=1
  fi
elif [[ "$WIKI_DIR_PROVIDED" -eq 0 && -n "${AUTOGOO_PLUGIN_WIKI_DIR:-}" ]]; then
  WIKI_DIR_PROVIDED=1
fi

if [[ "$SCOPE" == "project" && "$PROJECT_LAYOUT_PROVIDED" -eq 0 && "$PROJECT_DIRS_PROVIDED" -eq 0 && -t 0 && "$YES" -ne 1 ]]; then
  if confirm "Create business project directories such as src/data/docs?" "n"; then
    PROJECT_LAYOUT="$(prompt "Project directory layout (standard/ml/data/docs/custom)" "standard")"
    if [[ "$PROJECT_LAYOUT" == "custom" ]]; then
      PROJECT_DIRS="$(prompt "Comma-separated project directories" "src,data/raw,docs,references/papers")"
      PROJECT_DIRS_PROVIDED=1
    fi
    PROJECT_LAYOUT_PROVIDED=1
  fi
fi

case "$PROJECT_LAYOUT" in
  none|standard|ml|data|docs|custom)
    ;;
  *)
    echo "error: --project-layout must be one of: none, standard, ml, data, docs, custom" >&2
    exit 2
    ;;
esac

if [[ -n "$PROJECT_DIRS" && "$PROJECT_LAYOUT" == "none" ]]; then
  PROJECT_LAYOUT="custom"
fi

WIKI_DIR_EXPANDED="$(expand_path "$WIKI_DIR")"
WORK_DIR_EXPANDED="$(expand_path "$WORK_DIR")"
PROJECT_LAYOUT_DIRS_JSON="$(project_layout_dirs_json)"
FALLBACK_DIR="$(workspace_path obsidian_dir)"
WORKSPACE_THREADS_DIR="$(workspace_path threads_dir)"
WORKSPACE_CURRENT_THREAD_FILE="$(workspace_path current_thread_file)"
WORKSPACE_COMPAT_PLAN_FILE="$(workspace_path compat_plan_file)"
WORKSPACE_COMPAT_BRAINSTORM_FILE="$(workspace_path compat_brainstorm_file)"
WORKSPACE_PLANS_HISTORY_DIR="$(workspace_path plans_history_dir)"
WORKSPACE_BRAINSTORMS_HISTORY_DIR="$(workspace_path brainstorms_history_dir)"
WORKSPACE_LOGS_DIR="$(workspace_path logs_dir)"
WORKSPACE_ARTIFACTS_DIR="$(workspace_path artifacts_dir)"
WORKSPACE_REPORTS_DIR="$(workspace_path reports_dir)"
WORKSPACE_LOCKS_DIR="$(workspace_path locks_dir)"
WORKSPACE_CHANGE_REQUESTS_DIR="$(workspace_path change_requests_dir)"
WORKSPACE_OBSIDIAN_DIR="$(workspace_path obsidian_dir)"
WORKSPACE_SITE_DIR="$(workspace_path site_dir)"
WORKSPACE_INDEX_FILE="$(workspace_path index_file)"
WIKI_READY=0
WIKI_CREATED=0
PROJECT_ARCHIVE_DIR=""
FALLBACK_PROJECT_ARCHIVE_DIR=""
GIT_REMOTE_URL=""

if [[ "$SCOPE" == "project" ]]; then
  SECRETS_FILE="$CONFIG_DIR/secrets.json"
  SECRETS_REF=".goo/secrets.json"
else
  SECRETS_FILE="$CONFIG_DIR/secrets.json"
  SECRETS_REF="$SECRETS_FILE"
fi

SERVERS_JSON="[]"
CONFIG_WRITE_SKIPPED=0
SKIP_CONVENTIONS=0

# Load existing servers as the base for management (add/remove/replace/clear)
if [[ -f "$CONFIG_FILE" ]]; then
  SERVERS_JSON="$(load_existing_servers_json "$CONFIG_FILE")"
fi

# TTY interactive server management (only when no --server/--remove-server args given)
if [[ "${#SERVER_SPECS[@]}" -eq 0 && "${#REMOVE_SERVERS[@]}" -eq 0 && "$CLEAR_SERVERS" -eq 0 && -t 0 && "$YES" -ne 1 ]]; then
  if [[ "$SERVERS_JSON" != "[]" ]]; then
    echo ""
    echo "Existing remote servers:"
    python3 - "$SERVERS_JSON" <<'PY'
import json
import sys

servers = json.loads(sys.argv[1])
for i, s in enumerate(servers, 1):
    if isinstance(s, dict):
        print(f"  {i}. {s.get('name') or '(unnamed)'} -> {s.get('host') or s.get('ip')}:{s.get('port')} ({s.get('user')}, {s.get('type')})")
PY
    if confirm "Remove any of these servers?" "n"; then
      read -r -p "Names to REMOVE (comma-separated, Enter to skip): " TO_REMOVE
      if [[ -n "$TO_REMOVE" ]]; then
        IFS=',' read -r -a REMOVE_SERVERS <<< "$TO_REMOVE"
      fi
      if confirm "Remove ALL existing servers?" "n"; then
        CLEAR_SERVERS=1
      fi
    fi
  fi
fi

# Apply server changes in order: clear -> remove -> upsert
if [[ "$CLEAR_SERVERS" -eq 1 ]]; then
  SERVERS_JSON="[]"
  if [[ -f "$SECRETS_FILE" ]]; then
    python3 - "$SECRETS_FILE" <<'PY'
import json
import sys
from pathlib import Path

secrets_file = Path(sys.argv[1])
try:
    secrets = json.loads(secrets_file.read_text(encoding="utf-8"))
except (json.JSONDecodeError, ValueError, OSError):
    raise SystemExit(0)
if isinstance(secrets, list) and secrets:
    secrets_file.write_text("[]\n", encoding="utf-8")
    secrets_file.chmod(0o600)
PY
  fi
  echo "Removed ALL existing servers."
fi
for remove_name in "${REMOVE_SERVERS[@]}"; do
  remove_name_trimmed="$(echo "$remove_name" | xargs)"
  if [[ -z "$remove_name_trimmed" ]]; then
    continue
  fi
  SERVERS_JSON="$(remove_server_json "$SERVERS_JSON" "$remove_name_trimmed")"
  remove_server_secrets "$SECRETS_FILE" "$remove_name_trimmed"
  echo "Removed server: $remove_name_trimmed"
done

for spec in "${SERVER_SPECS[@]}"; do
  if ! mapfile -t SERVER_FIELDS < <(parse_server_spec "$spec"); then
    exit 2
  fi
  if [[ "${#SERVER_FIELDS[@]}" -lt 10 ]]; then
    echo "error: failed to parse --server spec" >&2
    exit 2
  fi
  SERVER_NAME="${SERVER_FIELDS[0]}"
  SERVER_HOST="${SERVER_FIELDS[1]}"
  SERVER_USER="${SERVER_FIELDS[2]}"
  SERVER_PORT="${SERVER_FIELDS[3]}"
  SERVER_TYPE="${SERVER_FIELDS[4]}"
  SERVER_PURPOSE="${SERVER_FIELDS[5]}"
  SERVER_WORKDIR="${SERVER_FIELDS[6]}"
  SERVER_SETUP="${SERVER_FIELDS[7]}"
  SERVER_DATA_DIR="${SERVER_FIELDS[8]}"
  SERVER_ARTIFACTS_DIR="${SERVER_FIELDS[9]}"
  save_server_secrets "$SECRETS_FILE" "$SERVER_NAME" "$SERVER_HOST" "$SERVER_USER" ""
  SERVERS_JSON="$(append_server_json "$SERVERS_JSON" "$SERVER_NAME" "$SERVER_HOST" "$SERVER_USER" "$SERVER_PORT" "$SERVER_TYPE" "$SERVER_PURPOSE" "$SECRETS_REF" "$SERVER_WORKDIR" "$SERVER_SETUP" "$SERVER_DATA_DIR" "$SERVER_ARTIFACTS_DIR")"
done

if [[ "${#SERVER_SPECS[@]}" -eq 0 && -t 0 && "$YES" -ne 1 ]]; then
  if confirm "Do you have remote servers to configure?" "n"; then
    SERVER_INDEX=1
    while true; do
      echo ""
      echo "--- Server $SERVER_INDEX ---"
      SERVER_TYPE="$(prompt "Server type (cpu/gpu)" "cpu")"
      read -r -p "Server name/alias for plans (e.g. gpu-a100, lab-cpu): " SERVER_NAME
      if [[ -z "$SERVER_NAME" ]]; then
        echo "Server name is required, skipping this server."
        break
      fi
      read -r -p "SSH host/IP/DNS for connection: " SERVER_HOST
      if [[ -z "$SERVER_HOST" ]]; then
        echo "SSH host is required, skipping this server."
        break
      fi
      read -r -p "Username: " SERVER_USER
      if [[ -z "$SERVER_USER" ]]; then
        echo "Username is required, skipping this server."
        break
      fi
      read -r -p "SSH port [22]: " SERVER_PORT
      SERVER_PORT="${SERVER_PORT:-22}"
      read -r -p "Purpose (e.g. model training, data processing): " SERVER_PURPOSE
      if [[ -z "$SERVER_PURPOSE" ]]; then
        echo "Purpose is required, skipping this server."
        break
      fi
      read -r -p "Default remote workdir (optional, e.g. /home/ubuntu/project): " SERVER_WORKDIR
      read -r -p "Environment setup commands (optional, separate with ';'): " SERVER_SETUP
      read -r -p "Default remote data dir (optional): " SERVER_DATA_DIR
      read -r -p "Default remote artifacts/output dir (optional): " SERVER_ARTIFACTS_DIR
      SERVER_PASS="$(prompt_secret "Password (input hidden, Enter to skip)")"

      save_server_secrets "$SECRETS_FILE" "$SERVER_NAME" "$SERVER_HOST" "$SERVER_USER" "$SERVER_PASS"
      SERVERS_JSON="$(append_server_json "$SERVERS_JSON" "$SERVER_NAME" "$SERVER_HOST" "$SERVER_USER" "$SERVER_PORT" "$SERVER_TYPE" "$SERVER_PURPOSE" "$SECRETS_REF" "$SERVER_WORKDIR" "$SERVER_SETUP" "$SERVER_DATA_DIR" "$SERVER_ARTIFACTS_DIR")"
      SERVER_INDEX=$((SERVER_INDEX + 1))

      if ! confirm "Add another server?" "n"; then
        break
      fi
    done
  fi
fi

if [[ "$SCOPE" == "project" ]]; then
  DEFAULT_PROJECT_SLUG="$(default_project_slug "$ROOT")"
  if [[ -z "$PROJECT_SLUG" ]]; then
    PROJECT_SLUG="$(prompt "Goo-wiki project archive slug" "$DEFAULT_PROJECT_SLUG")"
  fi
  PROJECT_SLUG="$(default_project_slug "$PROJECT_SLUG")"
  PROJECT_ARCHIVE_DIR="wiki/projects/$PROJECT_SLUG"
  FALLBACK_PROJECT_ARCHIVE_DIR="$FALLBACK_DIR/$PROJECT_SLUG"
  GIT_REMOTE_URL="$(git_remote_url "$ROOT" || true)"
fi

echo ""
echo "AutoGoo-Plugin init"
echo "  scope:      $SCOPE"
echo "  config:     $CONFIG_FILE"
echo "  wiki_dir:   $WIKI_DIR"
echo "  state_dir:  .goo"
if [[ "$SCOPE" == "project" ]]; then
  echo "  project:    $PROJECT_SLUG"
  if [[ "$PROJECT_LAYOUT" != "none" ]]; then
    echo "  layout:     $PROJECT_LAYOUT"
  fi
  if [[ -n "$GIT_REMOTE_URL" ]]; then
    echo "  git remote: $GIT_REMOTE_URL"
  fi
fi
if [[ "$SERVERS_JSON" != "[]" ]]; then
  SERVER_COUNT=$(echo "$SERVERS_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  echo "  servers:    $SERVER_COUNT server(s) configured"
  echo "  secrets:    $SECRETS_FILE"
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "  sshpass:    not found (install with: sudo apt install sshpass)"
  fi
fi

ensure_wiki_vault "$WIKI_DIR_EXPANDED"
if [[ "$WIKI_CREATED" -eq 1 ]]; then
  WIKI_READY=1
  echo "  wiki check: created ($WIKI_DIR_EXPANDED/CLAUDE.md)"
else
  WIKI_READY=1
  echo "  wiki check: ready ($WIKI_DIR_EXPANDED/CLAUDE.md)"
fi

if [[ "$SCOPE" == "project" ]]; then
  mkdir -p \
    "$ROOT/$WORKSPACE_THREADS_DIR" \
    "$ROOT/$WORKSPACE_PLANS_HISTORY_DIR" \
    "$ROOT/$WORKSPACE_BRAINSTORMS_HISTORY_DIR" \
    "$ROOT/$WORKSPACE_LOGS_DIR" \
    "$ROOT/$WORKSPACE_ARTIFACTS_DIR" \
    "$ROOT/$WORKSPACE_REPORTS_DIR" \
    "$ROOT/$WORKSPACE_LOCKS_DIR" \
    "$ROOT/$WORKSPACE_CHANGE_REQUESTS_DIR" \
    "$ROOT/$WORKSPACE_OBSIDIAN_DIR" \
    "$ROOT/$WORKSPACE_SITE_DIR"
  echo "  workspace:  AutoGoo-Plugin state directories ready under .goo"
  python3 - "$ROOT" "$PROJECT_LAYOUT" "$PROJECT_LAYOUT_DIRS_JSON" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
layout = sys.argv[2]
dirs = json.loads(sys.argv[3])
if layout == "none" or not dirs:
    raise SystemExit(0)
created = []
for item in dirs:
    rel = Path(str(item))
    if rel.is_absolute() or ".." in rel.parts or not rel.parts or rel.parts[0] == ".goo":
        raise SystemExit(f"unsafe project layout dir: {item}")
    path = root / rel
    path.mkdir(parents=True, exist_ok=True)
    created.append(rel.as_posix())
print("  project dirs: " + ", ".join(created))
PY
fi

if [[ -f "$CONFIG_FILE" && "$FORCE" -ne 1 ]]; then
  echo ""
  echo "Existing config found:"
  sed -n '1,120p' "$CONFIG_FILE"
  echo ""
  if ! confirm "Overwrite $CONFIG_FILE?" "n"; then
    CONFIG_WRITE_SKIPPED=1
    echo "Skipped config write. Existing config kept."
    # Do NOT exit here: convention writing (phase B) must still run for --user scope.
    if [[ "$SKIP_CLAUDE_MD" -eq 1 ]]; then
      SKIP_CONVENTIONS=1
    elif [[ "$SCOPE" == "project" && "$UPDATE_CLAUDE_MD" -ne 1 && ("$YES" -eq 1 || ! -t 0) ]]; then
      SKIP_CONVENTIONS=1
      echo "Project goo.md was not updated; rerun with --update-claude-md to add configuration."
    fi
  fi
fi

if [[ "$CONFIG_WRITE_SKIPPED" -eq 0 && "$SCOPE" == "project" && "$WIKI_READY" -eq 1 ]]; then
  mkdir -p "$WIKI_DIR_EXPANDED/$PROJECT_ARCHIVE_DIR"
  echo "  archive root: $WIKI_DIR_EXPANDED/$PROJECT_ARCHIVE_DIR"
  if [[ -n "$GIT_REMOTE_URL" ]]; then
    python3 - "$WIKI_DIR_EXPANDED/$PROJECT_ARCHIVE_DIR/$PROJECT_SLUG.md" "$PROJECT_SLUG" "$ROOT" "$GIT_REMOTE_URL" <<'PY'
import sys
from pathlib import Path

target = Path(sys.argv[1])
project_slug = sys.argv[2]
project_root = sys.argv[3]
git_remote_url = sys.argv[4]

begin = "<!-- AUTOGOO-PLUGIN-PROJECT-META-BEGIN -->"
end = "<!-- AUTOGOO-PLUGIN-PROJECT-META-END -->"
block = f"""{begin}
## Project Metadata

- Project slug: `{project_slug}`
- Local path: `{project_root}`
- Git repository: `{git_remote_url}`
{end}
"""

if target.exists():
    text = target.read_text(encoding="utf-8")
else:
    text = f"""# {project_slug}

> 项目描述待补充：请在此处填写项目的背景、目标和核心功能说明。

## 项目说明

（请填写）

## 最近任务

## 可复用经验

## 代码结构

"""

if begin in text and end in text:
    prefix, rest = text.split(begin, 1)
    _, suffix = rest.split(end, 1)
    new_text = prefix.rstrip() + "\n\n" + block + suffix.lstrip("\n")
else:
    new_text = text.rstrip() + "\n\n" + block

target.write_text(new_text, encoding="utf-8")
PY
    echo "  project page: updated git repository in $WIKI_DIR_EXPANDED/$PROJECT_ARCHIVE_DIR/$PROJECT_SLUG.md"
  fi
fi

if [[ "$CONFIG_WRITE_SKIPPED" -eq 0 ]]; then
  mkdir -p "$CONFIG_DIR"

  python3 - "$CONFIG_FILE" "$WIKI_DIR" "$FALLBACK_DIR" "$PROJECT_SLUG" "$PROJECT_ARCHIVE_DIR" "$FALLBACK_PROJECT_ARCHIVE_DIR" "$GIT_REMOTE_URL" "$SERVERS_JSON" "$WORK_DIR" "$WORKSPACE_LAYOUT" "$WORKSPACE_THREADS_DIR" "$WORKSPACE_CURRENT_THREAD_FILE" "$WORKSPACE_COMPAT_PLAN_FILE" "$WORKSPACE_COMPAT_BRAINSTORM_FILE" "$WORKSPACE_PLANS_HISTORY_DIR" "$WORKSPACE_BRAINSTORMS_HISTORY_DIR" "$WORKSPACE_LOGS_DIR" "$WORKSPACE_ARTIFACTS_DIR" "$WORKSPACE_REPORTS_DIR" "$WORKSPACE_LOCKS_DIR" "$WORKSPACE_CHANGE_REQUESTS_DIR" "$WORKSPACE_OBSIDIAN_DIR" "$WORKSPACE_SITE_DIR" "$WORKSPACE_INDEX_FILE" "$PROJECT_LAYOUT" "$PROJECT_LAYOUT_DIRS_JSON" <<'PY'
import json
import sys
from pathlib import Path

target = Path(sys.argv[1])
wiki_dir = sys.argv[2]
fallback_dir = sys.argv[3]
project_slug = sys.argv[4]
project_archive_dir = sys.argv[5]
fallback_project_archive_dir = sys.argv[6]
git_remote_url = sys.argv[7]
servers_json = sys.argv[8]
work_dir = sys.argv[9]
workspace_layout = sys.argv[10]
workspace_threads_dir = sys.argv[11]
workspace_current_thread_file = sys.argv[12]
workspace_compat_plan_file = sys.argv[13]
workspace_compat_brainstorm_file = sys.argv[14]
workspace_plans_history_dir = sys.argv[15]
workspace_brainstorms_history_dir = sys.argv[16]
workspace_logs_dir = sys.argv[17]
workspace_artifacts_dir = sys.argv[18]
workspace_reports_dir = sys.argv[19]
workspace_locks_dir = sys.argv[20]
workspace_change_requests_dir = sys.argv[21]
workspace_obsidian_dir = sys.argv[22]
workspace_site_dir = sys.argv[23]
workspace_index_file = sys.argv[24]
project_layout = sys.argv[25]
project_layout_dirs = json.loads(sys.argv[26])

config = {
    "version": 1,
    "wiki_dir": wiki_dir,
    "wiki": {
        "search_paths": [
            "wiki/projects",
            "wiki/concepts",
            "journal/weekly",
            "log.md",
        ],
    },
    "archive": {
        "enabled": True,
        "fallback_dir": fallback_dir,
        "plan_history_dir": workspace_plans_history_dir,
        "brainstorm_history_dir": workspace_brainstorms_history_dir,
    },
    "workspace": {
        "root": work_dir,
        "layout": workspace_layout,
        "paths": {
            "threads_dir": workspace_threads_dir,
            "current_thread_file": workspace_current_thread_file,
            "compat_plan_file": workspace_compat_plan_file,
            "compat_brainstorm_file": workspace_compat_brainstorm_file,
            "plans_history_dir": workspace_plans_history_dir,
            "brainstorms_history_dir": workspace_brainstorms_history_dir,
            "logs_dir": workspace_logs_dir,
            "artifacts_dir": workspace_artifacts_dir,
            "reports_dir": workspace_reports_dir,
            "locks_dir": workspace_locks_dir,
            "change_requests_dir": workspace_change_requests_dir,
            "obsidian_dir": workspace_obsidian_dir,
            "site_dir": workspace_site_dir,
        },
    },
    "project_workspace": {
        "layout": project_layout,
        "dirs": project_layout_dirs,
    },
    "publish": {
        "enabled": True,
        "site_dir": workspace_site_dir,
        "index_file": workspace_index_file,
        "host": "127.0.0.1",
        "port": 9877,
        "open_browser": True,
        "include_workflow_activity": True,
        "include_dag": True,
    },
    "execution": {
        "max_concurrent": 6,
        "heartbeat_seconds": 30,
        "stale_after_seconds": 120,
    },
    "planning": {
        "recall_wiki": True,
        "require_wiki_context": False,
    },
    "init": {
        "prompt_for_scope": True,
        "prompt_for_wiki_dir": True,
    },
}

if project_slug:
    config["archive"]["project_slug"] = project_slug
    config["archive"]["project_dir"] = project_archive_dir
    config["archive"]["fallback_project_dir"] = fallback_project_archive_dir
    if git_remote_url:
        config["archive"]["git_remote_url"] = git_remote_url

try:
    servers = json.loads(servers_json)
    if servers:
        config["servers"] = servers
except (json.JSONDecodeError, ValueError):
    pass

target.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

  if [[ "$SCOPE" == "project" && -f "$SECRETS_FILE" ]]; then
    GITIGNORE="$ROOT/.gitignore"
    if [[ -f "$GITIGNORE" ]]; then
      if ! grep -qF '.goo/secrets.json' "$GITIGNORE" 2>/dev/null; then
        echo '.goo/secrets.json' >> "$GITIGNORE"
        echo "Added .goo/secrets.json to .gitignore"
      fi
    else
      echo '.goo/secrets.json' > "$GITIGNORE"
      echo "Created .gitignore with .goo/secrets.json"
    fi
  fi

  echo ""
  echo "Wrote $CONFIG_FILE"
else
  echo ""
  echo "Kept $CONFIG_FILE"
fi

# ---------------------------------------------------------------------------
# Phase B: convention writing (goo.md body + agent pointers)
# This phase must run before any early exit so that --user scope is reachable.
# ---------------------------------------------------------------------------
USER_POINTER_EFFECTIVE="$USER_POINTER"

if [[ "$SKIP_CLAUDE_MD" -eq 1 ]]; then
  echo "Skipped goo.md/pointer update (--skip-claude-md)"
elif [[ "$SKIP_CONVENTIONS" -eq 1 ]]; then
  : # reason already reported while handling the existing config
else
  SHOULD_UPDATE_CLAUDE_MD=0
  AGENT_TARGET="${AGENT_TARGET:-both}"
  PROJECT_LAYOUT_DIR_COUNT="$(python3 - "$PROJECT_LAYOUT_DIRS_JSON" <<'PY'
import json
import sys

print(len(json.loads(sys.argv[1])))
PY
)"
  PROJECT_GOO_GENERATED=0

  if [[ "$SCOPE" == "user" ]]; then
    # User-level conventions are always generated (unless --skip-claude-md).
    SHOULD_UPDATE_CLAUDE_MD=1
    if [[ -z "$USER_POINTER_EFFECTIVE" ]]; then
      if [[ "$YES" -ne 1 && -t 0 ]]; then
        if confirm "是否写用户级指针到 ~/.claude/CLAUDE.md 和 ~/.codex/AGENTS.md？" "y"; then
          USER_POINTER_EFFECTIVE="yes"
        else
          USER_POINTER_EFFECTIVE="no"
        fi
      else
        USER_POINTER_EFFECTIVE="yes"
      fi
    fi
  else
    if [[ "$UPDATE_CLAUDE_MD" -eq 1 ]]; then
      SHOULD_UPDATE_CLAUDE_MD=1
      if [[ "$PROJECT_LAYOUT_DIR_COUNT" -gt 0 ]]; then
        WRITE_PROJECT_WORKSPACE_CLAUDE=1
      fi
    elif [[ "$YES" -eq 1 || ! -t 0 ]]; then
      if [[ "$PROJECT_LAYOUT_DIR_COUNT" -gt 0 || "$SERVERS_JSON" != "[]" ]]; then
        SHOULD_UPDATE_CLAUDE_MD=1
        if [[ "$PROJECT_LAYOUT_DIR_COUNT" -gt 0 ]]; then
          WRITE_PROJECT_WORKSPACE_CLAUDE=1
        else
          echo "Project goo.md will be updated with remote server summary and safety constraints."
        fi
      elif [[ -f "$HOME/.auto-goo/goo.md" ]]; then
        echo "Project goo.md not needed; using user-level ~/.auto-goo/goo.md."
      else
        echo "Project goo.md was not updated; rerun with --update-claude-md to add configuration."
      fi
    elif [[ "$PROJECT_LAYOUT_DIR_COUNT" -gt 0 ]]; then
      if confirm "Write project directory conventions to goo.md?" "y"; then
        SHOULD_UPDATE_CLAUDE_MD=1
        WRITE_PROJECT_WORKSPACE_CLAUDE=1
      else
        echo "Skipped project directory conventions in goo.md by user choice."
      fi
      if [[ "$SERVERS_JSON" != "[]" && "$WIKI_READY" -eq 1 ]]; then
        if confirm "Also write server config and archive principles to goo.md?" "y"; then
          SHOULD_UPDATE_CLAUDE_MD=1
        fi
      elif [[ "$SERVERS_JSON" != "[]" ]]; then
        if confirm "Also write server config to goo.md?" "y"; then
          SHOULD_UPDATE_CLAUDE_MD=1
        fi
      elif [[ "$WIKI_READY" -eq 1 ]]; then
        if confirm "Also add Goo-wiki archive principles to goo.md?" "y"; then
          SHOULD_UPDATE_CLAUDE_MD=1
        fi
      fi
    elif [[ "$SERVERS_JSON" != "[]" && "$WIKI_READY" -eq 1 ]]; then
      if confirm "Update goo.md with server config and archive principles?" "y"; then
        SHOULD_UPDATE_CLAUDE_MD=1
      else
        echo "Skipped project goo.md update by user choice."
      fi
    elif [[ "$SERVERS_JSON" != "[]" ]]; then
      if confirm "Update goo.md with server config?" "y"; then
        SHOULD_UPDATE_CLAUDE_MD=1
      else
        echo "Skipped project goo.md update by user choice."
      fi
    elif [[ "$WIKI_READY" -eq 1 ]]; then
      if confirm "Add Goo-wiki archive principles to goo.md?" "y"; then
        SHOULD_UPDATE_CLAUDE_MD=1
      else
        echo "Skipped project goo.md update by user choice."
      fi
    fi
    if [[ "$SERVERS_JSON" != "[]" && "$SHOULD_UPDATE_CLAUDE_MD" -eq 0 ]]; then
      SHOULD_UPDATE_CLAUDE_MD=1
      if [[ "$PROJECT_LAYOUT_DIR_COUNT" -gt 0 ]]; then
        WRITE_PROJECT_WORKSPACE_CLAUDE=1
      fi
      echo "Project goo.md will be updated with remote server summary and safety constraints."
    fi
    if [[ "$SHOULD_UPDATE_CLAUDE_MD" -eq 1 ]]; then
      PROJECT_GOO_GENERATED=1
    fi
  fi

  # Pointer targets and scope-aware display strings
  POINTER_TARGETS=""
  if [[ "$SCOPE" == "user" ]]; then
    GOO_MD_TARGET="$HOME/.auto-goo/goo.md"
    GOO_MD_HEADER="# AutoGoo-Plugin 用户级约定"
    POINTER_HEADER="# AutoGoo-Plugin 用户级约定"
    CONFIG_DISPLAY="~/.auto-goo/config.json"
    SECRETS_DISPLAY="~/.auto-goo/secrets.json"
    INIT_HINT="/auto-goo:goo-init --user"
    if [[ "$USER_POINTER_EFFECTIVE" == "yes" ]]; then
      if [[ "$AGENT_TARGET" == "claude" || "$AGENT_TARGET" == "both" ]]; then
        POINTER_TARGETS+="$HOME/.claude/CLAUDE.md"$'\n'
      fi
      if [[ "$AGENT_TARGET" == "codex" || "$AGENT_TARGET" == "both" ]]; then
        POINTER_TARGETS+="$HOME/.codex/AGENTS.md"$'\n'
      fi
    else
      echo "Skipped user-level pointer (pass --write-user-pointer to enable)."
    fi
  else
    GOO_MD_TARGET="$ROOT/goo.md"
    GOO_MD_HEADER="# AutoGoo-Plugin 项目约定"
    POINTER_HEADER="# Project Instructions"
    CONFIG_DISPLAY=".goo/config.json"
    SECRETS_DISPLAY=".goo/secrets.json"
    INIT_HINT="/auto-goo:goo-init --project"
    if [[ "$SHOULD_UPDATE_CLAUDE_MD" -eq 1 ]]; then
      if [[ "$AGENT_TARGET" == "claude" || "$AGENT_TARGET" == "both" ]]; then
        POINTER_TARGETS+="$ROOT/CLAUDE.md"$'\n'
      fi
      if [[ "$AGENT_TARGET" == "codex" || "$AGENT_TARGET" == "both" ]]; then
        POINTER_TARGETS+="$ROOT/AGENTS.md"$'\n'
      fi
    fi
  fi

  if [[ "$SHOULD_UPDATE_CLAUDE_MD" -eq 0 ]]; then
    echo "goo.md not modified (no content to write)"
  else
    set +e
    python3 - \
      "$SCOPE" "$GOO_MD_TARGET" "$WIKI_DIR" "$FALLBACK_PROJECT_ARCHIVE_DIR" \
      "$PROJECT_ARCHIVE_DIR" "$SERVERS_JSON" "$WIKI_READY" "$PROJECT_LAYOUT" \
      "$PROJECT_LAYOUT_DIRS_JSON" "$WRITE_PROJECT_WORKSPACE_CLAUDE" \
      "$AGENT_TARGET" "$PROJECT_GOO_GENERATED" "$GOO_MD_HEADER" \
      "$POINTER_HEADER" "$CONFIG_DISPLAY" "$SECRETS_DISPLAY" "$INIT_HINT" \
      "$POINTER_TARGETS" <<'PY'
import json
import sys
from pathlib import Path

scope = sys.argv[1]
goo_md_target = Path(sys.argv[2])
wiki_dir = sys.argv[3]
fallback_project_dir = sys.argv[4]
project_archive_dir = sys.argv[5]
servers_json = sys.argv[6]
wiki_ready = sys.argv[7] == "1"
project_layout = sys.argv[8]
project_layout_dirs = json.loads(sys.argv[9])
write_project_workspace = sys.argv[10] == "1"
agent_target = sys.argv[11] or "both"
project_goo_generated = sys.argv[12] == "1"
goo_md_header = sys.argv[13] or "# AutoGoo-Plugin 项目约定"
pointer_header = sys.argv[14] or "# Project Instructions"
config_display = sys.argv[15]
secrets_display = sys.argv[16]
init_hint = sys.argv[17]
raw_targets = sys.argv[18] if len(sys.argv) > 18 else ""
pointer_targets = [line for line in raw_targets.splitlines() if line.strip()]

if not project_archive_dir:
    project_archive_dir = "wiki/projects/<project-slug>"
if not fallback_project_dir:
    fallback_project_dir = ".goo/obsidian/<project-slug>"

begin = "<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN -->"
end = "<!-- AUTOGOO-PLUGIN-WIKI-ARCHIVE-END -->"
pb_begin = "<!-- AUTOGOO-PLUGIN-POINTER-BEGIN -->"
pb_end = "<!-- AUTOGOO-PLUGIN-POINTER-END -->"


def render_marker_block(path, content, mb_begin, mb_end, default_header=""):
    """Idempotently write exactly one marker block into ``path``.

    - removes *every* complete mb_begin..mb_end block (R6)
    - cleans up an orphan single-sided marker before inserting (R5)
    - appends one fresh block; never rewrites text outside the markers
    """
    path = Path(path)
    if path.exists():
        text = path.read_text(encoding="utf-8")
    elif default_header:
        text = default_header.rstrip("\n") + "\n"
    else:
        text = ""

    while mb_begin in text and mb_end in text:
        prefix, rest = text.split(mb_begin, 1)
        _, suffix = rest.split(mb_end, 1)
        if prefix.strip():
            text = prefix.rstrip() + "\n" + suffix.lstrip("\n")
        else:
            text = suffix.lstrip("\n")

    # orphan begin without end: the incomplete block runs to EOF
    if mb_begin in text:
        idx = text.find(mb_begin)
        line_start = text.rfind("\n", 0, idx) + 1
        text = text[:line_start].rstrip() + "\n"

    # orphan end without begin: drop only the dangling marker line
    if mb_end in text:
        idx = text.find(mb_end)
        line_end = text.find("\n", idx)
        line_end = len(text) if line_end == -1 else line_end + 1
        text = (text[:idx].rstrip() + "\n" + text[line_end:].lstrip("\n")).rstrip() + "\n"

    block = f"{mb_begin}\n{content.rstrip()}\n{mb_end}\n"
    base = text.rstrip()
    new_text = base + "\n\n" + block if base else block
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(new_text, encoding="utf-8")
    return path.resolve()


server_section = ""
try:
    servers = json.loads(servers_json)
    if servers:
        def server_purpose(server):
            raw = str(server.get("purpose") or "").strip()
            if raw and raw != "-":
                return raw
            server_type = str(server.get("type") or "").strip().lower()
            if server_type == "gpu":
                return "用于 GPU 相关任务：模型训练、推理评测、批量生成、图像/数据处理等重算力步骤。"
            if server_type == "cpu":
                return "用于 CPU 相关任务：数据整理、预处理、轻量脚本、索引构建和批量文件操作。"
            return "用于本项目需要远程算力或长时间后台执行的步骤。"

        def usage_hint(server, purpose):
            server_type = str(server.get("type") or "").strip().lower()
            if server_type == "gpu":
                return f"{purpose} 当任务涉及训练、推理、批量评测、自动标注图片生成或本机资源不足时优先使用。"
            if server_type == "cpu":
                return f"{purpose} 当任务主要是数据清洗、格式转换、批处理或不需要 GPU 时优先使用。"
            return f"{purpose} 使用前先确认任务是否需要远程环境、长时间运行或特定依赖。"

        lines = ["\n## 远程服务器\n"]
        lines.append("| 名称 | Host | 端口 | 用户名 | 类型 | 用途 | 密码来源 |")
        lines.append("|------|------|------|--------|------|------|----------|")
        for s in servers:
            purpose = server_purpose(s)
            name = s.get("name") or s.get("host") or s.get("ip")
            host = s.get("host") or s.get("ip")
            lines.append(f"| {name} | {host} | {s.get('port', '22')} | {s['user']} | {s['type']} | {purpose} | `{s['secrets_file']}` |")
        lines.append("")
        lines.append("### 何时使用")
        for s in servers:
            purpose = server_purpose(s)
            name = s.get("name") or s.get("host") or s.get("ip")
            host = s.get("host") or s.get("ip")
            lines.append(f"- **{name}**（{s['type']}，host: `{host}`）：{usage_hint(s, purpose)}连接信息见 `{s['secrets_file']}`。")
        lines.append("")
        if scope == "project":
            lines.append(f"config 位于 `{config_display}`，secrets 位于 `{secrets_display}`（chmod 600，已加入 .gitignore）。")
        else:
            lines.append(f"config 位于 `{config_display}`，secrets 位于 `{secrets_display}`（chmod 600）。")
        lines.append(f"连接远程服务器由 AutoGoo-Plugin 工具读取 `{config_display}` 与 `{secrets_display}` 处理；执行任务时必须显式选择目标服务器，不依赖默认第一个。")
        lines.append("不得把 secrets 展开到命令行、日志、计划正文或 subagent prompt。")
        lines.append("")
        lines.append("添加新服务器：")
        lines.append("```bash")
        lines.append(init_hint)
        lines.append("```")
        server_section = "\n".join(lines)
except (json.JSONDecodeError, ValueError):
    pass

project_workspace_section = ""
if write_project_workspace and project_layout_dirs:
    lines = ["## 项目目录约定\n"]
    lines.append(f"- 本项目采用 `{project_layout}` 业务目录结构；AutoGoo-Plugin 自身状态仍固定写入 `.goo/`。")
    lines.append("- 规划、执行和归档时优先复用以下目录语义，不要把业务代码、数据或文档混入 `.goo/`：")
    for item in project_layout_dirs:
        if item.startswith("data/raw"):
            meaning = "原始数据，只读使用；清洗或转换结果不要覆盖这里"
        elif item.startswith("data/processed"):
            meaning = "处理后的可复用数据"
        elif item.startswith("data/interim"):
            meaning = "处理中间数据，可按任务清理或重建"
        elif item.startswith("data/external"):
            meaning = "外部来源数据或第三方下载数据"
        elif item == "references" or item.startswith("references/"):
            if item.startswith("references/papers"):
                meaning = "论文、paper PDF、arXiv/DOI 元数据和阅读材料；可读写但需保留来源信息"
            else:
                meaning = "参考资料、论文、规范、外部文档和资料索引；区别于项目产出文档"
        elif item == "src" or item.startswith("src/"):
            meaning = "项目源码"
        elif item == "tests" or item.startswith("tests/"):
            meaning = "测试与验收用例"
        elif item == "docs" or item.startswith("docs/"):
            meaning = "项目文档、设计记录和说明材料"
        elif item == "configs" or item.startswith("configs/"):
            meaning = "配置文件和实验参数"
        elif item == "scripts" or item.startswith("scripts/"):
            meaning = "可复用脚本和批处理入口"
        elif item == "notebooks" or item.startswith("notebooks/"):
            meaning = "探索分析 notebook"
        elif item == "models" or item.startswith("models/"):
            meaning = "模型权重、检查点或模型产物"
        elif item == "outputs" or item.startswith("outputs/"):
            meaning = "任务输出、生成结果和临时导出"
        elif item == "reports" or item.startswith("reports/"):
            meaning = "评测报告、分析报告和汇总材料"
        elif item == "artifacts" or item.startswith("artifacts/"):
            meaning = "业务产物；区别于 `.goo/artifacts/` 的 AutoGoo-Plugin 执行产物"
        else:
            meaning = "项目约定目录"
        lines.append(f"- `{item}/`: {meaning}。")
    lines.append("- 新增计划步骤时，`allowed_read_paths` / `allowed_write_paths` 应优先落在上述业务目录或 `.goo/` 的明确 AutoGoo-Plugin 状态目录内；涉及原始数据覆盖、批量改写或大文件生成时先请求用户确认。")
    project_workspace_section = "\n".join(lines) + "\n"

archive_section = ""
if wiki_ready:
    archive_section = f"""## AutoGoo-Plugin / Goo-wiki 归档原则

- 本项目启用 Goo-wiki 作为项目记忆层；规划前先检索 `{wiki_dir}` 中相关项目页、概念页、周报和 `log.md`，复用已有约束、命令、路径、指标口径和历史经验。
- 使用 `/auto-goo:goo-plan` 生成计划时，必须在当前 thread plan 最后保留 `归档到 Goo-wiki` 步骤，并依赖所有非归档叶子步骤；计划必须包含 `thread`、`wiki_context` 和 `context_digest`，让后续执行不依赖主会话聊天记录。
- 如果当前对话已经形成方案、取舍、约束或验收标准，短内容写入当前 thread plan 的 `context_digest`；长方案、会议纪要或 prompt 草案优先写入 `Goo-wiki/{project_archive_dir}/context/`，并在当前 thread plan 的 `context_artifacts` 中引用。
- 如果当前 thread plan 已生成后又通过对话产生新方案、约束、验收标准或用户偏好，`/auto-goo:goo-start` 和 `/auto-goo:goo-continue` 默认先做 context sync：把旧 plan 复制到 `.goo/plans/history/`，短内容写入 `context_digest.post_plan_updates`，长内容写入 `context_artifacts` 指向的 Markdown；只有与原 plan 冲突、扩大范围、改变验收标准或涉及危险操作时才询问用户确认。
- 使用 `/auto-goo:goo-start` 或 `/auto-goo:goo-continue` 执行时，只能基于当前 thread plan、`context_artifacts` 指向的 Goo-wiki/Markdown、相关 `wiki_context`、当前 thread logs 和上游产物路径恢复任务；不得依赖“刚才讨论过”的隐含上下文。
- 使用 `/auto-goo:goo-start` 或 `/auto-goo:goo-continue` 执行时，所有 `research` / `exec` / `optimize` / `eval` / `review` / `audit` / `archive` step 必须派发给当前 thread plan 中声明的 `subagent`；主 Agent 只负责编排、状态修复、上下文补全和产物审核，不直接代写步骤产物或代跑步骤命令。
- 如果待执行 step 缺少 `subagent`、`depends_on`、`output`、读写边界或必要上下文，先更新当前 thread plan / `context_artifacts` 后再派发，不用主会话聊天记录临时补齐。
- 使用 `/auto-goo:goo-start` 或 `/auto-goo:goo-continue` 执行后，必须归档任务目标、计划摘要、步骤证据、产物路径、验证结果、关键决策、问题处理和可复用经验。
- 任何产生可复用内容的命令最终都必须归档到 Goo-wiki 或 `.goo/obsidian/` fallback；不得只写 `.goo/*.json` 或只在聊天中展示。brainstorm 候选目标和 plan 摘要必须先给用户审阅，确认后或进入执行前再归档最终版；usage/token 降本分析、日报/周报、改进建议、benchmark 指标和执行经验按命令规则归档。
- 用户要求日报、周报、总结今天或调用 `/auto-goo:goo-daily-report` 时，必须把 Claude Code / Codex 会话沉淀到 Goo-wiki `journal/daily/`，并更新 `log.md`；同日日报已存在时只追加新增内容，不整体覆盖已有人工整理。
- Goo-wiki 可用时优先写入 `{wiki_dir}/{project_archive_dir}/` 并追加 `Goo-wiki/log.md`；不可用时写入 `{fallback_project_dir}` 作为本地 fallback。
- 模型摘要只作阅读入口；最终任务归档还必须生成 `execution/record.md` 详细事实记录和 `execution/evidence-index.md` 来源覆盖表。先枚举当前 thread plan、全部 step logs、artifacts、reports 和 context artifacts；小型安全文本证据原样保留，大型/二进制产物记录路径、大小和可取得时的校验值；每项来源必须标记已收录、仅索引、不可用或已脱敏，不得静默遗漏失败、重试和未验证项。
- 论文解读/深读以及代码库结构、调用链、数据流、架构、实现模式分析必须生成独立 Markdown 分析文档并实际写入 Goo-wiki，同时更新项目入口和 Goo-wiki `log.md`。`.goo/`、step log、聊天回复或 `.goo/obsidian/` fallback 都不能作为最终归档；Goo-wiki 不可写时 fallback 只作临时防丢失，状态保持 `pending_wiki_sync` 或 `failed`。
- 归档完成前必须补齐并验收 Markdown 连接图谱：任务页链接项目入口、复用的 `wiki_context` / `context_artifacts` 和关键概念/问题/指标/历史任务页；项目 `<project-slug>.md` 与 `log.md` 反向链接任务页；新增 concept/lessons/metrics 页面链接回任务页或项目入口。缺少这些链接时不得把 archive step 标记为 completed。
- 不把归档当作事后报告；归档内容要能支撑下一次任务的召回、规划和复用。
"""

user_default_section = f"""## 用户级默认约定

- 本文件是 AutoGoo-Plugin 的**用户级默认约定**，对所有项目生效。
- 约定正文优先级：项目根 `goo.md`（若存在）> 用户级 `~/.auto-goo/goo.md`；项目级约定覆盖用户级约定。
- 用户级配置位于 `{config_display}`；重新生成本文件请运行 `{init_hint}`。
- 用户级指针写入 `~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md` 的 `AUTOGOO-PLUGIN-POINTER` marker 段。
- 项目级初始化请运行 `/auto-goo:goo-init --project`。
"""

if scope == "user":
    content = archive_section + server_section
    if not content.strip():
        content = user_default_section
else:
    content = project_workspace_section + archive_section + server_section
    if not content.strip():
        sys.exit(2)

if scope == "project" and project_goo_generated:
    effective_goo_md = "[goo.md](goo.md)"
else:
    effective_goo_md = "`~/.auto-goo/goo.md`"

pointer_body = f"""## AutoGoo-Plugin

本项目使用 AutoGoo-Plugin 进行任务编排。
约定正文优先级：项目根 `goo.md`（若存在）> 用户级 `~/.auto-goo/goo.md`。
完整约定见 {effective_goo_md}。
"""

written = []
written.append(render_marker_block(goo_md_target, content, begin, end, default_header=goo_md_header))
for target in pointer_targets:
    written.append(render_marker_block(target, pointer_body, pb_begin, pb_end, default_header=pointer_header))

for path in written:
    print(f"  wrote: {path}")
PY
    PY_EXIT=$?
    set -e
    if [[ "$PY_EXIT" -eq 0 ]]; then
      echo "Updated goo.md + agent pointers ($AGENT_TARGET)"
    else
      echo "goo.md not modified (no content to write)"
    fi
  fi
fi

echo ""
echo "Recommended SessionStart hook:"
cat <<'EOF'
{
  "hooks": {
    "SessionStart": [{
      "hooks": [
        {
          "type": "command",
          "command": "test -f \"${AUTOGOO_PLUGIN_WIKI_DIR:-$HOME/workspace/Goo-wiki}/CLAUDE.md\" && echo 'Goo-wiki vault ready' || echo 'Goo-wiki not found; using .goo/obsidian fallback'"
        },
        {
          "type": "command",
          "command": "cat .goo/plan.json 2>/dev/null && echo 'Unfinished AutoGoo-Plugin plan found; run /auto-goo:goo-continue to resume' || true"
        }
      ]
    }]
  }
}
EOF

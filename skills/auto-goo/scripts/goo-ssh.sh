#!/usr/bin/env bash
# AutoGoo-Plugin SSH helper: connect to a configured server using password from .goo/secrets.json.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  goo-ssh.sh [--config .goo/config.json] [--server NAME_HOST_OR_INDEX] [--dry-run] [--] [ssh args or remote command]
  goo-ssh.sh --host HOST --user USER [--port PORT] [--dry-run] [--] [ssh args or remote command]

Examples:
  goo-ssh.sh
  goo-ssh.sh --server 0
  goo-ssh.sh --server gpu-a100
  goo-ssh.sh --server gpu-a100.local:2222 -- nvidia-smi
  goo-ssh.sh --server user@gpu-a100.local:2222 -- nvidia-smi
  goo-ssh.sh --host 192.168.1.100 --user ubuntu --port 2222

Options:
  --workdir DIR    run the command in DIR (cd DIR && ...). Default: server defaults.workdir or ~
  --no-env         skip sourcing ~/.bashrc / ~/.profile / ~/.bash_profile before the command
                   (default: on, so conda/cuda PATH from remote rc files is loaded)

Notes:
  --server accepts a configured server index, name, host/IP, host:port,
  user@host, or user@host:port.
  When a password exists in the configured secrets file, key-based auth is
  tried first (BatchMode), and password via sshpass is used only on
  auth/connection failure. If no password is configured, plain ssh is used
  so key-based login and manual SSH auth still work.
EOF
}

CONFIG=".goo/config.json"
SERVER_SELECTOR=""
HOST_OVERRIDE=""
USER_OVERRIDE=""
PORT_OVERRIDE=""
WORKDIR=""
ENV_LOAD=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || { echo "error: --config requires a path" >&2; exit 2; }
      CONFIG="$2"
      shift 2
      ;;
    --server)
      [[ $# -ge 2 ]] || { echo "error: --server requires NAME_HOST_OR_INDEX" >&2; exit 2; }
      SERVER_SELECTOR="$2"
      shift 2
      ;;
    --host|--ip)
      [[ $# -ge 2 ]] || { echo "error: $1 requires HOST" >&2; exit 2; }
      HOST_OVERRIDE="$2"
      shift 2
      ;;
    --user)
      [[ $# -ge 2 ]] || { echo "error: --user requires USER" >&2; exit 2; }
      USER_OVERRIDE="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "error: --port requires PORT" >&2; exit 2; }
      PORT_OVERRIDE="$2"
      shift 2
      ;;
    --workdir)
      [[ $# -ge 2 ]] || { echo "error: --workdir requires a path" >&2; exit 2; }
      WORKDIR="$2"
      shift 2
      ;;
    --no-env)
      ENV_LOAD=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      break
      ;;
    *)
      break
      ;;
  esac
done

if [[ ! -f "$CONFIG" ]]; then
  echo "error: config not found: $CONFIG" >&2
  exit 2
fi

if ! mapfile -t SSH_INFO < <(python3 - "$CONFIG" "$SERVER_SELECTOR" "$HOST_OVERRIDE" "$USER_OVERRIDE" "$PORT_OVERRIDE" "$DRY_RUN" <<'PY'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1]).resolve()
selector = sys.argv[2]
host_override = sys.argv[3]
user_override = sys.argv[4]
port_override = sys.argv[5]
dry_run = sys.argv[6] == "1"
project_root = config_path.parent.parent

def fail(message, code=2):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)

def split_target(raw):
    user = ""
    host_port = raw
    if "@" in host_port:
        user, host_port = host_port.split("@", 1)
    host = host_port
    port = ""
    if host_port.count(":") == 1:
        maybe_host, maybe_port = host_port.rsplit(":", 1)
        if maybe_port.isdigit():
            host = maybe_host
            port = maybe_port
    return user, host, port

def server_host(server):
    return str(server.get("host") or server.get("ip") or "")

def server_name(server):
    return str(server.get("name") or "")

def server_port(server):
    return str(server.get("port", 22))

def server_user(server):
    return str(server.get("user") or "")

def server_matches(server, host="", port="", user="", selector_value=""):
    host_value = server_host(server)
    port_value = server_port(server)
    user_value = server_user(server)
    name_value = server_name(server)
    candidates = {
        host_value,
        f"{host_value}:{port_value}",
        f"{user_value}@{host_value}",
        f"{user_value}@{host_value}:{port_value}",
        name_value,
    }
    if selector_value and selector_value in candidates:
        return True
    if host and host != host_value:
        return False
    if port and port != port_value:
        return False
    if user and user != user_value:
        return False
    return bool(host)

try:
    config = json.loads(config_path.read_text(encoding="utf-8"))
except (json.JSONDecodeError, OSError) as exc:
    fail(f"cannot read config: {exc}")

servers = config.get("servers") or config.get("compute_servers") or []
if not isinstance(servers, list):
    servers = []

if host_override:
    requested_user = user_override
    requested_host = host_override
    requested_port = port_override or "22"
    matches = [
        i for i, candidate in enumerate(servers)
        if server_matches(candidate, requested_host, port_override, requested_user)
    ]
    if matches:
        index = matches[0]
        server = dict(servers[index])
        if user_override:
            server["user"] = user_override
        if port_override:
            server["port"] = port_override
    else:
        if not requested_user:
            fail("--host requires --user when host is not present in config")
        server = {
            "ip": requested_host,
            "user": requested_user,
            "port": requested_port,
            "secrets_file": config.get("secrets_file") or ".goo/secrets.json",
        }
elif not selector:
    if not servers:
        fail("no servers configured in config")
    index = 0
    server = servers[index]
elif selector.isdigit():
    if not servers:
        fail("no servers configured in config")
    index = int(selector)
    if index < 0 or index >= len(servers):
        fail(f"server index out of range: {index}")
    server = servers[index]
else:
    requested_user, requested_host, requested_port = split_target(selector)
    matches = [
        i for i, candidate in enumerate(servers)
        if server_matches(candidate, requested_host, requested_port, requested_user, selector)
    ]
    if not matches:
        fail(f"server not found: {selector}")
    index = matches[0]
    server = servers[index]

name = server.get("name")
host = server.get("host") or server.get("ip")
user = server.get("user")
port = str(server.get("port", 22))
secrets_file = server.get("secrets_file") or ".goo/secrets.json"
if not host or not user:
    fail("selected server is missing ip/host or user")

secrets_path = Path(secrets_file)
if not secrets_path.is_absolute():
    secrets_path = project_root / secrets_path

# secrets 文件不存在 → 视为无密码（密钥认证 / manual auth），不报错；
# 只有走密码认证（sshpass）时才需要 secrets 里有对应条目。
password = None
if secrets_path.exists():
    try:
        secrets = json.loads(secrets_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        fail(f"cannot read secrets: {exc}")

    entries = secrets
    if isinstance(secrets, dict):
        entries = secrets.get("servers", [])

    if isinstance(entries, list):
        for item in entries:
            if not isinstance(item, dict):
                continue
            item_host = str(item.get("ip") or item.get("host") or "")
            item_name = str(item.get("name") or "")
            if (item_host == str(host) or (name and item_name == str(name))) and str(item.get("user") or "") == str(user):
                password = item.get("password")
                break
    elif isinstance(entries, dict):
        candidate_keys = [
            str(name or ""),
            str(host),
            f"{host}:{port}",
            f"{user}@{host}",
            f"{user}@{host}:{port}",
        ]
        for key in candidate_keys:
            item = entries.get(key)
            if isinstance(item, dict) and item.get("password"):
                password = item.get("password")
                break
            if isinstance(item, str) and item:
                password = item
                break
    else:
        fail("secrets file must contain a server list, a {'servers': [...]} object, or a {'servers': {'host:port': ...}} object")

if password is None:
    password = ""

print(host)
print(user)
print(port)
print(password)
print(secrets_path)
PY
); then
  exit 2
fi

if [[ "${#SSH_INFO[@]}" -lt 5 ]]; then
  echo "error: failed to parse ssh configuration" >&2
  exit 2
fi

HOST="${SSH_INFO[0]}"
USER_NAME="${SSH_INFO[1]}"
PORT="${SSH_INFO[2]}"
PASSWORD="${SSH_INFO[3]}"
SECRETS_PATH="${SSH_INFO[4]}"

SSH_TARGET="${USER_NAME}@${HOST}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "ssh target: $SSH_TARGET"
  echo "ssh port:   $PORT"
  echo "secrets:    $SECRETS_PATH"
  if [[ -n "$WORKDIR" && "$WORKDIR" != "~" ]]; then
    echo "workdir:    $WORKDIR"
  fi
  [[ "$ENV_LOAD" -eq 1 ]] && echo "env load:   on (sources ~/.bashrc ~/.profile ~/.bash_profile)"
  if [[ -n "$PASSWORD" ]]; then
    echo "auth:       key first, fallback password via sshpass"
  else
    echo "auth:       plain ssh (key/manual auth; no password loaded)"
  fi
  echo "command:    ssh -p $PORT $SSH_TARGET ${WORKDIR:+cd $WORKDIR && }$*"
  exit 0
fi

# 连接参数统一收紧：目标不可达（防火墙丢包）时 ConnectTimeout=15 保证
# 快速失败并输出错误，而不是 TCP 层挂起数分钟无任何输出；
# ServerAlive* 在命令长时间无输出时探测保活，避免连接被中途掐断。
SSH_BASE_ARGS=(-o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3)

# 远程命令前缀：workdir（cd）+ 环境加载（source 远程 rc 文件）。
# ssh 默认非登录 shell 不加载 ~/.bashrc 等，conda/cuda 的 PATH 会丢失，
# 导致 nvidia-smi / python 找不到 —— 默认加载，--no-env 可关闭。
REMOTE_CMD=()
if [[ -n "$WORKDIR" && "$WORKDIR" != "~" ]]; then
  WORKDIR_ESCAPED="${WORKDIR//\'/\'\\'\'}"
  REMOTE_CMD+=( "cd '$WORKDIR_ESCAPED' 2>/dev/null || { echo 'workdir not found: $WORKDIR' >&2; exit 126; };" )
fi
if [[ "$ENV_LOAD" -eq 1 ]]; then
  REMOTE_CMD+=( '[ -f ~/.bashrc ] && . ~/.bashrc 2>/dev/null; [ -f ~/.profile ] && . ~/.profile 2>/dev/null; [ -f ~/.bash_profile ] && . ~/.bash_profile 2>/dev/null;' )
fi
REMOTE_CMD+=( "$@" )

# 密钥优先：有密码时先试 BatchMode 密钥认证（不弹交互提示）。
# 仅当失败原因是认证/连接类（Permission denied 等）才 return 2 允许密码回退；
# 认证成功但命令执行失败时原样退出（绝不重复执行远程命令）。
run_key_first() {
  local errf msg ec
  errf="$(mktemp "${TMPDIR:-/tmp}/autogoo-plugin-ssh-err.XXXXXX")"
  if ssh -o BatchMode=yes "${SSH_BASE_ARGS[@]}" -p "$PORT" "$SSH_TARGET" "${REMOTE_CMD[@]}" 2>"$errf"; then
    rm -f "$errf"
    exit 0
  else
    ec=$?
  fi
  msg="$(cat "$errf" 2>/dev/null || true)"
  rm -f "$errf"
  if grep -qiE 'Permission denied|Host key verification|Connection refused|Connection timed out|Could not resolve|No route to host|Operation timed out|Too many authentication failures|Connection reset|Network is unreachable' <<<"$msg" 2>/dev/null; then
    return 2
  fi
  [[ -n "$msg" ]] && printf '%s\n' "$msg" >&2
  exit $ec
}

if [[ -z "$PASSWORD" ]]; then
  if [[ ! -t 0 ]]; then
    exec ssh -o BatchMode=yes "${SSH_BASE_ARGS[@]}" -p "$PORT" "$SSH_TARGET" "${REMOTE_CMD[@]}"
  fi
  exec ssh "${SSH_BASE_ARGS[@]}" -p "$PORT" "$SSH_TARGET" "${REMOTE_CMD[@]}"
fi

# 有密码：密钥优先，认证/连接失败（rc=2）再回退 sshpass
if run_key_first; then
  exit 0
else
  rc=$?
fi
if [[ "$rc" -ne 2 ]]; then
  exit "$rc"
fi

PASS_FILE="$(mktemp "${TMPDIR:-/tmp}/autogoo-plugin-ssh-pass.XXXXXX")"
cleanup() {
  if [[ -f "$PASS_FILE" ]]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u "$PASS_FILE" 2>/dev/null || rm -f "$PASS_FILE"
    else
      rm -f "$PASS_FILE"
    fi
  fi
}
trap cleanup EXIT
chmod 600 "$PASS_FILE"
printf '%s\n' "$PASSWORD" > "$PASS_FILE"
unset PASSWORD

if ! command -v sshpass >/dev/null 2>&1; then
  echo "error: sshpass is required for password-based scripted SSH." >&2
  echo "Install it first, or connect manually with: ssh -p $PORT $SSH_TARGET" >&2
  exit 127
fi

# StrictHostKeyChecking=accept-new：新主机密钥自动加入 known_hosts，
# 避免 ssh 输出 "Are you sure you want to continue connecting (yes/no)?"
# 后 sshpass 匹配不到 password 提示而长时间无响应（旧行为：无输出直到超时）。
exec sshpass -f "$PASS_FILE" ssh -o StrictHostKeyChecking=accept-new "${SSH_BASE_ARGS[@]}" -p "$PORT" "$SSH_TARGET" "${REMOTE_CMD[@]}"

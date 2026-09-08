#!/usr/bin/env python3
"""Claude Code usage monitor — rich multi-color terminal dashboard.

Tabs: Overview | Projects | Models | History
Controls: ←→ / 1-4 switch tabs, q quit
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import select
import sys
import time
import tty
import termios
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# ── Constants ────────────────────────────────────────────────────────────────

TABS = ["overview", "projects", "models", "history"]
TAB_LABELS = {
    "overview": "Overview",
    "projects": "Projects",
    "models": "Models",
    "history": "History",
}
TAB_KEYS = {"overview": "1", "projects": "2", "models": "3", "history": "4"}


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (ValueError, TypeError):
        return default

HISTORY_PERIODS = ["7d", "30d", "all"]
HISTORY_PERIOD_LABELS = {"7d": "7 Days", "30d": "30 Days", "all": "All Time"}

TOKEN_FIELDS = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
]

PRICE_FIELD_ALIASES = {
    "input": "input_tokens", "input_tokens": "input_tokens",
    "output": "output_tokens", "output_tokens": "output_tokens",
    "cache": "cache_read_input_tokens", "cache_read": "cache_read_input_tokens",
    "cache_read_input_tokens": "cache_read_input_tokens",
}

PRICE_OUTPUT_FIELDS = {
    "input_tokens": "input_cost_usd",
    "output_tokens": "output_cost_usd",
    "cache_read_input_tokens": "cache_read_cost_usd",
}

# Built-in pricing (USD per 1M tokens): input / output / cache_read

# Built-in pricing for Codex/OpenAI models (USD per 1M tokens)
DEFAULT_CODEX_PRICING: dict[str, tuple[float, float, float]] = {
    "gpt-5.5":              (15.00, 60.00, 0.10),
    "gpt-5.4":              (3.00,  15.00, 0.30),
    "gpt-5.4-mini":         (0.25,  2.00,  0.03),
    "gpt-5.3-codex":        (3.00,  15.00, 0.30),
    "gpt-5.2":              (3.00,  15.00, 0.30),
    "LongCat-2.0":          (0.00,  0.00,  0.00),
    "gpt-4o":               (2.50,  10.00, 1.25),
    "gpt-4o-mini":          (0.15,  0.60,  0.08),
    "gpt-4-turbo":          (10.00, 30.00, 0.10),
    "o1":                   (15.00, 60.00, 0.10),
    "o3":                   (2.00,  8.00,  0.10),
    "o3-mini":              (1.10,  4.40,  0.10),
}

CODEX_SOURCE_LABELS = {
    "claude": "Claude Code",
    "codex":  "Codex CLI",
    "pi":     "Pi",
}
DEFAULT_PRICING: dict[str, tuple[float, float, float]] = {
    "claude-opus-4-7":      (15.00, 75.00, 1.50),
    "claude-opus-4-6":      (15.00, 75.00, 1.50),
    "claude-opus-4-5":      (15.00, 75.00, 1.50),
    "claude-sonnet-4-6":    (3.00,  15.00, 0.30),
    "claude-sonnet-4-5":    (3.00,  15.00, 0.30),
    "claude-haiku-4-5":     (0.80,  4.00,  0.08),
    "claude-haiku-4-5-max": (1.00,  5.00,  0.10),
    "claude-3.5-sonnet":    (3.00,  15.00, 0.30),
    "claude-3.5-haiku":     (0.80,  4.00,  0.08),
    "claude-3-opus":        (15.00, 75.00, 1.50),
}

# ── 24-bit RGB Color System ──────────────────────────────────────────────────

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"


def rgb_fg(r: int, g: int, b: int) -> str:
    return f"\033[38;2;{r};{g};{b}m"


def rgb_bg(r: int, g: int, b: int) -> str:
    return f"\033[48;2;{r};{g};{b}m"


# Semantic named colors (256-color fallbacks for wider terminal compat)
def _c256(code: int) -> str:
    return f"\033[38;5;{code}m"


def _c256b(code: int) -> str:
    return f"\033[48;5;{code}m"


CYAN = _c256(51)
MUTED = _c256(243)
GREEN = _c256(42)
YELLOW = _c256(220)
ORANGE = _c256(208)
BLUE = _c256(39)
MAGENTA = _c256(201)
RED = _c256(196)
WHITE = _c256(255)
PINK = _c256(213)
TEAL = _c256(49)
LIME = _c256(46)
GOLD = _c256(214)
PURPLE = _c256(129)
SKY = _c256(117)

# Model → dedicated color
MODEL_COLORS: dict[str, str] = {}


def model_color(model: str) -> str:
    if model not in MODEL_COLORS:
        palette = [CYAN, GREEN, MAGENTA, YELLOW, BLUE, ORANGE, PINK, TEAL, LIME, GOLD, PURPLE, SKY]
        idx = hash(model) % len(palette)
        MODEL_COLORS[model] = palette[idx]
    return MODEL_COLORS[model]


def c(text: str, color: str) -> str:
    return f"{color}{text}{RESET}"


def cbold(text: str, color: str) -> str:
    return f"{BOLD}{color}{text}{RESET}"


# ── ANSI-aware string helpers ────────────────────────────────────────────────

import re as _re

_ANSI_RE = _re.compile(r'\x1b\[[0-9;]*m')


def visible_len(s: str) -> int:
    """String length excluding ANSI escape sequences."""
    return len(_ANSI_RE.sub('', s))


def vis_ljust(s: str, width: int) -> str:
    """Left-justify to visible width, accounting for embedded ANSI codes."""
    return s + ' ' * max(0, width - visible_len(s))


def vis_rjust(s: str, width: int) -> str:
    """Right-justify to visible width, accounting for embedded ANSI codes."""
    return ' ' * max(0, width - visible_len(s)) + s


def fmt_col(col: str, width: int, align: str = '<') -> str:
    """Format a column to exact visible width, ANSI-aware."""
    if align == '<':
        return vis_ljust(col, width)
    elif align == '>':
        return vis_rjust(col, width)
    return col


# ── Gradient / Visualization Helpers ─────────────────────────────────────────

SPARK_TIERS = " ▁▂▃▄▅▆▇█"


def sparkline(values: list[float], width: int = 30) -> str:
    """Render a Unicode sparkline from a list of values."""
    if not values:
        return SPARK_TIERS[0] * width
    vmax = max(values)
    if vmax <= 0:
        return SPARK_TIERS[0] * width
    n = len(values)
    if n <= width:
        result = []
        for i in range(width):
            src_idx = i * n / width
            lo = int(src_idx)
            hi = min(lo + 1, n - 1)
            frac = src_idx - lo
            val = values[lo] * (1 - frac) + values[hi] * frac
            tier = min(8, int(val / vmax * 8))
            result.append(SPARK_TIERS[tier])
        return "".join(result)
    else:
        bucket_size = n / width
        result = []
        for i in range(width):
            lo = int(i * bucket_size)
            hi = int((i + 1) * bucket_size)
            avg = sum(values[lo:hi]) / max(1, hi - lo)
            tier = min(8, int(avg / vmax * 8))
            result.append(SPARK_TIERS[tier])
        return "".join(result)


def gradient_bar(percent: float, width: int = 30, blocks: tuple[str, str] = ("█", "░")) -> str:
    """Bar with 24-bit RGB color gradient: green → yellow → red."""
    fill_char, empty_char = blocks
    clamped = max(0.0, min(100.0, percent))
    filled = round(width * clamped / 100)
    parts = []
    for i in range(filled):
        ratio = i / max(1, width - 1)
        if ratio < 0.5:
            r_ = int(ratio * 2 * 255)
            g_ = 255
            b_ = 0
        else:
            r_ = 255
            g_ = int((1.0 - (ratio - 0.5) * 2) * 255)
            b_ = 0
        parts.append(f"{rgb_fg(r_, g_, b_)}{fill_char}")
    if parts:
        parts.append(RESET)
    parts.append(c(empty_char * (width - filled), MUTED))
    return "".join(parts)


def heat_blocks(value: float, maximum: float) -> str:
    """Single-character heat indicator using 24-bit color."""
    if maximum <= 0:
        return " "
    ratio = min(1.0, value / maximum)
    if ratio < 0.125:
        return " "
    elif ratio < 0.25:
        r, g, b = 30, 30, 30
    elif ratio < 0.5:
        r, g, b = int(ratio * 2 * 100), int(ratio * 2 * 180), int(ratio * 2 * 255)
    else:
        r, g, b = 100 + int((ratio - 0.5) * 2 * 155), 180 + int((ratio - 0.5) * 2 * 75), 255
    return f"{rgb_bg(r, g, b)} {RESET}"


def percent_bar(percent: float, width: int = 20, fill: str = "█", empty: str = "░") -> str:
    """Simple percentage bar with fixed colors."""
    filled = round(width * max(0.0, min(100.0, percent)) / 100)
    bar_color = GREEN if percent < 50 else (YELLOW if percent < 80 else RED)
    return c(fill * filled, bar_color) + c(empty * (width - filled), MUTED)


def hbar(value: int, maximum: int, width: int = 20, color_fn=None) -> str:
    """Horizontal bar scaled to width. Color transitions green→yellow→red."""
    if maximum <= 0:
        return c("░" * width, MUTED)
    pct = min(100.0, value / maximum * 100)
    filled = round(width * pct / 100)
    if filled == 0 and value > 0:
        filled = 1
    parts = []
    for i in range(filled):
        ratio = i / max(1, width - 1)
        if ratio < 0.4:
            r_, g_, b_ = int(ratio / 0.4 * 255), 255, 40
        elif ratio < 0.7:
            r_, g_, b_ = 255, int((1 - (ratio - 0.4) / 0.3) * 255), 40
        else:
            r_, g_, b_ = 255, int((1 - (ratio - 0.7) / 0.3) * 100), 40
        parts.append(f"{rgb_fg(r_, g_, b_)}█")
    if parts:
        parts.append(RESET)
    parts.append(c("░" * (width - filled), MUTED))
    return "".join(parts)


# ── Argument Parsing ─────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Claude Code / Pi usage monitor — rich terminal dashboard",
        epilog="Example: /auto-goo:goo-usage",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("-i", "--input-dir", type=Path,
                   default=Path.home() / ".claude" / "projects",
                   help="Claude Code projects log directory")
    p.add_argument("--since", help="ISO timestamp lower bound")
    p.add_argument("--until", help="ISO timestamp upper bound")
    p.add_argument("--view", choices=("realtime", "daily", "monthly"), default="realtime")
    p.add_argument("--timezone", default="auto")
    p.add_argument("--time-format", choices=("auto", "12h", "24h"), default="auto")
    p.add_argument("--pricing", type=Path, help="JSON pricing table (USD/1M tokens)")
    p.add_argument("--price", action="append", default=[],
                   metavar="MODEL=INPUT,OUTPUT,CACHE_READ",
                   help="Add model price per 1M tokens")
    p.add_argument("--include-synthetic", action="store_true",
                   help="Include <synthetic> log rows")
    p.add_argument("--once", action="store_true",
                   help="Print once, then open the interactive selection UI (q to exit); "
                        "without a TTY prints once and exits")
    p.add_argument("--interval", type=float, default=30.0, help="Refresh interval (seconds)")
    p.add_argument("--tab", choices=TABS, default="overview",
                   help="Initial tab (default: overview)")
    p.add_argument("--no-builtin-pricing", action="store_true",
                   help="Disable built-in model pricing")
    p.add_argument("--serve", action="store_true", help="Start HTTP server with HTML dashboard")
    p.add_argument("--host", default="127.0.0.1", help="HTTP host (default: 127.0.0.1)")
    p.add_argument("--port", type=int, default=9876, help="HTTP server port (default: 9876)")
    p.add_argument("--codex", action="store_true",
                   help="Read Codex CLI usage from ~/.codex/sessions (combine with --claude/--pi for multiple sources)")
    p.add_argument("--codex-dir", type=Path,
                   default=Path.home() / ".codex" / "sessions",
                   help="Codex CLI sessions directory (default: ~/.codex/sessions)")
    p.add_argument("--claude", action="store_true",
                   help="Read Claude Code usage from --input-dir (default: ~/.claude/projects)")
    p.add_argument("--pi", action="store_true",
                   help="Read Pi usage from ~/.pi/agent/sessions")
    p.add_argument("--json", action="store_true",
                   help="Print a JSON summary (for analysis / automation) and exit")
    return p.parse_args()


# ── Keyboard Input ───────────────────────────────────────────────────────────

# 会话级 raw 模式：read_key(keep_raw=True) 首次进入 cbreak 后保持，避免
# 每次调用后恢复 canonical 造成微秒级间隙把按键卡进行缓冲（等换行才送达）。
_RAW_STATE: dict = {"fd": None, "old": None, "active": False}


def _enter_raw(fd: int) -> None:
    if _RAW_STATE["active"]:
        return
    _RAW_STATE["old"] = termios.tcgetattr(fd)
    tty.setcbreak(fd)
    _RAW_STATE["fd"] = fd
    _RAW_STATE["active"] = True


def restore_raw() -> None:
    """退出时恢复终端原始属性（与 keep_raw=True 配对使用）。"""
    if _RAW_STATE["active"] and _RAW_STATE["fd"] is not None and _RAW_STATE["old"] is not None:
        try:
            termios.tcsetattr(_RAW_STATE["fd"], termios.TCSADRAIN, _RAW_STATE["old"])
        except (termios.error, OSError):
            pass
        _RAW_STATE["active"] = False


def read_key(timeout: float = 0.1, keep_raw: bool = False) -> str | None:
    if not sys.stdin.isatty():
        return None
    try:
        fd = sys.stdin.fileno()
        if not _RAW_STATE["active"]:
            _enter_raw(fd)
        try:
            if select.select([sys.stdin], [], [], timeout)[0]:
                ch = os.read(fd, 1)
                if ch == b'\x1b':
                    # 逐字节读后续序列（方向键/PgUp/PgDn/Home/End/SGR 滚轮）。
                    # 每读一字节即检查是否已构成完整已知序列，一旦完整立即 break：
                    # 不会吞掉紧随其后的按键（如快速连按后接 q），也不会等满超时。
                    seq = b''
                    while len(seq) < 16:
                        if not select.select([sys.stdin], [], [], 0.05)[0]:
                            break
                        seq += os.read(fd, 1)
                        if seq.startswith(b'[<') and seq[-1:] in (b'M', b'm'):
                            break  # SGR 鼠标序列完成
                        if seq in (b'[A', b'[B', b'[C', b'[D', b'[H', b'[F', b'[5~', b'[6~'):
                            break  # 方向键/PgUp/PgDn/Home/End 完成
                    if seq.startswith(b'[<') and seq[-1:] in (b'M', b'm'):
                        m = _re.match(rb'^\[<(\d+);(\d+);(\d+)([Mm])$', seq)
                        if m:
                            btn = int(m.group(1))
                            if btn == 64:
                                return 'wheel_up'
                            if btn == 65:
                                return 'wheel_down'
                            return None
                    if seq == b'[A':
                        return 'up'
                    elif seq == b'[B':
                        return 'down'
                    elif seq == b'[C':
                        return 'right'
                    elif seq == b'[D':
                        return 'left'
                    elif seq == b'[H':
                        return 'home'
                    elif seq == b'[F':
                        return 'end'
                    elif seq == b'[5~':
                        return 'page_up'
                    elif seq == b'[6~':
                        return 'page_down'
                elif ch in (b'j', b'k'):
                    return 'down' if ch == b'j' else 'up'
                elif ch in (b'1', b'2', b'3', b'4'):
                    return ch.decode()
                elif ch == b'\t':
                    return 'tab'
                elif ch == b'q':
                    return 'quit'
                elif ch == b'[':
                    return 'bracket_left'
                elif ch == b']':
                    return 'bracket_right'
                elif ch == b'h':
                    return 'bracket_left'
                elif ch == b'l':
                    return 'bracket_right'
        finally:
            if not keep_raw:
                restore_raw()
    except (termios.error, OSError):
        pass
    return None


# ── Time Helpers ─────────────────────────────────────────────────────────────

def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = value.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone()


def resolve_timezone(name: str) -> timezone | ZoneInfo:
    if not name or name == "auto":
        return datetime.now().astimezone().tzinfo or timezone.utc
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        tz = datetime.now().astimezone().tzinfo or timezone.utc
        print(f"Unknown timezone {name!r}, using local", file=sys.stderr)
        return tz


def format_clock(dt: datetime, time_format: str) -> str:
    if time_format == "12h":
        return dt.strftime("%I:%M:%S %p").lstrip("0")
    return dt.strftime("%H:%M:%S")


def iso_bound(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def window_bounds(args: argparse.Namespace, tz: timezone | ZoneInfo) -> tuple[datetime, datetime]:
    now = datetime.now(tz)
    until = parse_time(args.until).astimezone(tz) if args.until else now
    if args.since:
        since = parse_time(args.since)
        if since:
            return since.astimezone(tz), until
    return now.replace(hour=0, minute=0, second=0, microsecond=0), until


# ── Data Loading ─────────────────────────────────────────────────────────────

def message_text(message: object, limit: int = 160) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    parts: list[str] = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
    text = " ".join(" ".join(parts).split())
    return text[:limit - 1] + "…" if len(text) > limit else text


def resolve_user_turn(parent_uuid: str | None, nodes: dict[str, dict[str, object]]) -> dict[str, object]:
    seen: set[str] = set()
    current = parent_uuid
    while current and current not in seen:
        seen.add(current)
        node = nodes.get(current)
        if not node:
            break
        if node.get("type") == "user":
            return node
        current = str(node.get("parentUuid") or "")
    return {}


def _parse_claude_file(path: Path, since: str | None, until: str | None) -> list[dict[str, object]]:
    """解析单个 Claude Code session JSONL 文件 → 该文件的行。
    nodes 为文件内引用表，线程内独立，可安全并行。"""
    out: list[dict[str, object]] = []
    nodes: dict[str, dict[str, object]] = {}
    with path.open(encoding="utf-8", errors="ignore") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            uuid = obj.get("uuid")
            if uuid:
                nodes[str(uuid)] = {
                    "uuid": str(uuid),
                    "parentUuid": obj.get("parentUuid") or "",
                    "type": obj.get("type") or "",
                    "timestamp": obj.get("timestamp") or "",
                }
            message = obj.get("message") or {}
            usage = message.get("usage") or {}
            if not usage:
                continue
            timestamp = str(obj.get("timestamp", ""))
            if since and timestamp < since:
                continue
            if until and timestamp > until:
                continue
            user_turn = resolve_user_turn(obj.get("parentUuid"), nodes)
            out.append({
                "timestamp": timestamp,
                "sessionId": str(obj.get("sessionId", "")),
                "cwd": str(obj.get("cwd", "")),
                "model": str(message.get("model", "")),
                "input_tokens": _safe_int(usage.get("input_tokens")),
                "output_tokens": _safe_int(usage.get("output_tokens")),
                "cache_creation_input_tokens": _safe_int(usage.get("cache_creation_input_tokens")),
                "cache_read_input_tokens": _safe_int(usage.get("cache_read_input_tokens")),
                "turnId": str(user_turn.get("uuid", obj.get("parentUuid", ""))),
            })
    return out


def iter_records(input_dir: Path, since: str | None, until: str | None):
    # 顺序解析（实测线程池因 GIL 反而更慢）；首帧慢由磁盘缓存解决
    for path in sorted(input_dir.glob("**/*.jsonl")):
        yield from _parse_claude_file(path, since, until)


def _parse_codex_file(jsonl: Path, since: str | None, until: str | None,
                      thread_info: dict[str, tuple[str, str]]) -> list[dict[str, object]]:
    """解析单个 Codex rollout JSONL 文件。thread_info 只读共享，安全。"""
    out: list[dict[str, object]] = []
    session_id = None
    cwd = ""
    model_name = "unknown"
    with jsonl.open(encoding="utf-8", errors="ignore") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "session_meta":
                session_id = obj["payload"].get("session_id", "")
                _tinfo = thread_info.get(session_id or "", ("", "unknown"))
                cwd = _tinfo[0]
                model_name = _tinfo[1]
                continue
            if obj.get("type") != "event_msg":
                continue
            if obj["payload"].get("type") != "token_count":
                continue
            info = obj["payload"].get("info") or {}
            ltu = info.get("last_token_usage") or {}
            if not ltu:
                continue
            timestamp = obj.get("timestamp", "")
            if since and timestamp < since:
                continue
            if until and timestamp > until:
                continue
            inp = _safe_int(ltu.get("input_tokens"))
            out_t = _safe_int(ltu.get("output_tokens"))
            cached = _safe_int(ltu.get("cached_input_tokens"))
            reasoning = _safe_int(ltu.get("reasoning_output_tokens"))
            pass  # cwd already set from thread_info
            out.append({
                "timestamp": timestamp,
                "sessionId": f"codex:{session_id}" if session_id else "",
                "cwd": cwd,
                "model": model_name or "unknown",
                "input_tokens": inp,
                "output_tokens": out_t + reasoning,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": cached,
                "turnId": timestamp,
                "source": "codex",
            })
    return out


def iter_codex_records(sessions_dir: Path, since: str | None, until: str | None):
    """Read Codex CLI rollout JSONL files and yield normalized usage rows."""
    if not sessions_dir.exists():
        return
    state_db = sessions_dir.parent / "state_5.sqlite"
    thread_info: dict[str, tuple[str, str]] = {}
    if state_db.exists():
        try:
            import sqlite3 as _sql
            _conn = _sql.connect(str(state_db))
            for _r in _conn.execute("SELECT id, cwd, model FROM threads"):
                thread_info[_r[0]] = (_r[1] or "", _r[2] or "unknown")
            _conn.close()
        except Exception:
            pass
    files = sorted(sessions_dir.rglob("rollout-*.jsonl"))
    # 顺序解析（GIL 下线程池更慢，见 iter_records 注释）
    for jsonl in files:
        yield from _parse_codex_file(jsonl, since, until, thread_info)


def _parse_pi_file(sess_file: Path, since: str | None, until: str | None) -> list[dict[str, object]]:
    """解析单个 Pi Coding Agent session JSONL 文件。文件内状态独立，可并行。"""
    out: list[dict[str, object]] = []
    header = None
    with sess_file.open(encoding="utf-8", errors="ignore") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "session":
                header = obj
                continue
            if obj.get("type") != "message":
                continue
            msg = obj.get("message") or {}
            if msg.get("role") != "assistant":
                continue
            usage = msg.get("usage") or {}
            if not usage:
                continue
            timestamp = str(obj.get("timestamp", ""))
            if since and timestamp < since:
                continue
            if until and timestamp > until:
                continue
            sid = (header or {}).get("id", "") or sess_file.stem
            out.append({
                "timestamp": timestamp,
                "sessionId": sid,
                "cwd": (header or {}).get("cwd", ""),
                "model": str(msg.get("model", "")),
                "input_tokens": _safe_int(usage.get("input")),
                "output_tokens": _safe_int(usage.get("output")),
                "cache_creation_input_tokens": _safe_int(usage.get("cacheWrite")),
                "cache_read_input_tokens": _safe_int(usage.get("cacheRead")),
                "turnId": timestamp,
                "source": "pi",
            })
    return out


def iter_pi_records(pi_dir: Path, since: str | None, until: str | None):
    """Read Pi Coding Agent session JSONL files and yield normalized usage rows."""
    if not pi_dir.exists():
        return
    files = [f for d in sorted(pi_dir.iterdir()) if d.is_dir() for f in sorted(d.glob("*.jsonl"))]
    # 顺序解析（GIL 下线程池更慢，见 iter_records 注释）
    for sess_file in files:
        yield from _parse_pi_file(sess_file, since, until)


def load_records(input_dir: Path, since: str | None, until: str | None,
                 include_synthetic: bool,
                 use_claude: bool = True,
                 codex_dir: Path | None = None,
                 pi_dir: Path | None = None) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    if use_claude:
        rows.extend(iter_records(input_dir, since, until))
    if codex_dir:
        rows.extend(iter_codex_records(codex_dir, since, until))
    if pi_dir:
        rows.extend(iter_pi_records(pi_dir, since, until))
    if not include_synthetic:
        rows = [r for r in rows if str(r.get("model") or "") != "<synthetic>"]
    return rows


def source_flags(args: argparse.Namespace) -> tuple[bool, Path | None, Path | None]:
    """Resolve (use_claude, codex_dir, pi_dir) from the CLI args.

    When none of --claude / --codex / --pi is given, ALL sources are enabled
    (Claude Code + Codex + Pi). When any flag is given, only the selected
    sources are read; flags can be combined.
    """
    want_claude = bool(getattr(args, "claude", False))
    want_codex = bool(getattr(args, "codex", False))
    want_pi = bool(getattr(args, "pi", False))
    if not (want_claude or want_codex or want_pi):
        want_claude = want_codex = want_pi = True
    codex_dir = args.codex_dir if want_codex else None
    pi_dir = Path.home() / ".pi" / "agent" / "sessions" if want_pi else None
    return want_claude, codex_dir, pi_dir


# ── Pricing ──────────────────────────────────────────────────────────────────

def normalize_price_entry(raw: object) -> dict[str, float]:
    if not isinstance(raw, dict):
        raise ValueError("pricing entries must be objects")
    entry: dict[str, float] = {}
    for key, value in raw.items():
        canonical = PRICE_FIELD_ALIASES.get(str(key))
        if canonical:
            entry[canonical] = _safe_float(value)
    return entry


def load_pricing(path: Path | None, inline_prices: list[str],
                 use_builtin: bool) -> dict[str, dict[str, float]]:
    pricing: dict[str, dict[str, float]] = {}
    if path:
        with path.open(encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            raise ValueError("pricing file must contain a JSON object")
        for model, entry in raw.items():
            pricing[str(model)] = normalize_price_entry(entry)
    for spec in inline_prices:
        if "=" not in spec:
            raise ValueError(f"invalid --price value: {spec}")
        model, rates = spec.split("=", 1)
        values = [v.strip() for v in rates.split(",")]
        if len(values) != 3:
            raise ValueError(f"--price needs 3 comma-separated rates: {spec}")
        pricing[model.strip()] = {
            "input_tokens": _safe_float(values[0]),
            "output_tokens": _safe_float(values[1]),
            "cache_read_input_tokens": _safe_float(values[2]),
        }
    if use_builtin and not path and not inline_prices:
        for model, (inp, out, cache) in DEFAULT_PRICING.items():
            if model not in pricing:
                pricing[model] = {
                    "input_tokens": inp,
                    "output_tokens": out,
                    "cache_read_input_tokens": cache,
                }
    return pricing


def token_total(row: dict[str, object]) -> int:
    return sum(int(row.get(f) or 0) for f in TOKEN_FIELDS)


def row_cost(row: dict[str, object], pricing: dict[str, dict[str, float]]) -> float:
    model = str(row.get("model") or "unknown")
    rates = pricing.get(model)
    if not rates:
        return 0.0
    total = 0.0
    input_tokens = (int(row.get("input_tokens") or 0) +
                    int(row.get("cache_creation_input_tokens") or 0))
    total += input_tokens / 1_000_000 * rates.get("input_tokens", 0)
    total += int(row.get("output_tokens") or 0) / 1_000_000 * rates.get("output_tokens", 0)
    total += int(row.get("cache_read_input_tokens") or 0) / 1_000_000 * rates.get("cache_read_input_tokens", 0)
    return total


# ── Formatting ───────────────────────────────────────────────────────────────

def fmt_int(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    elif value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(value)


def fmt_int_full(value: int) -> str:
    return f"{value:,}"


def fmt_money(value: float) -> str:
    if value < 0.01:
        return f"${value:.4f}"
    return f"${value:.2f}"


def fmt_pct(value: float, total: float) -> str:
    if total <= 0:
        return "0.0%"
    return f"{value / total * 100:.1f}%"


def project_label(cwd: str) -> str:
    if not cwd or cwd == "unknown":
        return "unknown"
    path = Path(cwd)
    name = path.name
    if name:
        return name
    return cwd.strip("/").split("/")[-1] or cwd


# ── Data Aggregation ─────────────────────────────────────────────────────────

# collect() 结果内存缓存：滚动/切 tab 每帧都调用 collect（--once 会话内数据不变，
# 整会话缓存避免每帧重读磁盘缓存；live 模式 TTL=interval 每次刷新重读）。
_COLLECT_CACHE: dict[tuple, tuple[float, list, str, str]] = {}


# ── 磁盘缓存：usage 源文件数百个 JSONL，首帧/刷新全量解析约 2s。
# 按「源文件列表 + mtime」指纹把解析结果（未过滤窗口）落盘，文件没变则下次直接读。
# 首次解析后：启动、live 刷新、滚动全部毫秒级。
_DISK_CACHE_DIR = Path.home() / ".auto-goo" / "cache"
_DISK_CACHE_ROWS = _DISK_CACHE_DIR / "goo-usage-rows.jsonl"
_DISK_CACHE_META = _DISK_CACHE_DIR / "goo-usage-meta.json"
_DISK_CACHE_VERSION = 1


def _source_files(args: argparse.Namespace) -> list[Path]:
    """当前启用的全部 usage 源文件（claude/codex/pi）。"""
    files: list[Path] = []
    use_claude, codex_dir, pi_dir = source_flags(args)
    if use_claude:
        files.extend(args.input_dir.glob("**/*.jsonl"))
    if codex_dir and codex_dir.exists():
        files.extend(codex_dir.rglob("rollout-*.jsonl"))
    if pi_dir and pi_dir.exists():
        files.extend(f for d in pi_dir.iterdir() if d.is_dir() for f in d.glob("*.jsonl"))
    return files


def _fingerprint(files: list[Path]) -> str:
    h = hashlib.sha256()
    for p in sorted(files, key=lambda x: str(x)):
        try:
            st = p.stat()
            h.update(f"{p}\0{st.st_mtime_ns}\0{st.st_size}\0".encode())
        except OSError:
            pass
    return h.hexdigest()


def _load_all_rows(args: argparse.Namespace) -> list[dict[str, object]]:
    """全量行读取（不做窗口过滤），带磁盘缓存。任何缓存环节失败都退回直接解析。"""
    try:
        files = _source_files(args)
        fp = _fingerprint(files)
        if _DISK_CACHE_META.exists() and _DISK_CACHE_ROWS.exists():
            try:
                meta = json.loads(_DISK_CACHE_META.read_text(encoding="utf-8"))
                if meta.get("version") == _DISK_CACHE_VERSION and meta.get("fingerprint") == fp:
                    rows: list[dict[str, object]] = []
                    with _DISK_CACHE_ROWS.open(encoding="utf-8") as f:
                        for line in f:
                            rows.append(json.loads(line))
                    return rows
            except Exception:
                pass
        use_claude, codex_dir, pi_dir = source_flags(args)
        rows = load_records(args.input_dir, None, None, args.include_synthetic,
                            use_claude=use_claude, codex_dir=codex_dir, pi_dir=pi_dir)
        try:
            _DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            with _DISK_CACHE_ROWS.open("w", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            _DISK_CACHE_META.write_text(
                json.dumps({"version": _DISK_CACHE_VERSION, "fingerprint": fp, "count": len(rows)}),
                encoding="utf-8")
        except Exception:
            pass
        return rows
    except Exception:
        use_claude, codex_dir, pi_dir = source_flags(args)
        return load_records(args.input_dir, None, None, args.include_synthetic,
                            use_claude=use_claude, codex_dir=codex_dir, pi_dir=pi_dir)


def collect(args: argparse.Namespace, tz: timezone | ZoneInfo) -> tuple[list[dict[str, object]], str, str]:
    since_dt, until_dt = window_bounds(args, tz)
    since = iso_bound(since_dt)
    until = iso_bound(until_dt)
    use_claude, codex_dir, pi_dir = source_flags(args)
    # realtime 视图 until=now 每秒变化；key 截到分钟级避免滚动/切 tab 每帧 miss
    key = (str(args.input_dir), since[:16], until[:16], args.include_synthetic,
           use_claude, str(codex_dir), str(pi_dir))
    # --once 会话内数据不变 → 整会话缓存（滚动/切 tab 永不重扫）；
    # live 模式 TTL=interval：每次定时刷新重新采集，刷新间滚动即时。
    ttl = float("inf") if getattr(args, "once", False) else max(30.0, getattr(args, "interval", 30.0))
    now = time.monotonic()
    hit = _COLLECT_CACHE.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1], hit[2], hit[3]
    # 磁盘缓存行未过滤窗口：在内存按 since/until 过滤（行数小，毫秒级）
    rows = _load_all_rows(args)
    if since:
        rows = [r for r in rows if str(r.get("timestamp", "")) >= since]
    if until:
        rows = [r for r in rows if str(r.get("timestamp", "")) <= until]
    _COLLECT_CACHE[key] = (now, rows, since, until)
    return rows, since, until


def summarize(rows: list[dict[str, object]], pricing: dict[str, dict[str, float]]) -> dict[str, Any]:
    total_tok = sum(token_total(r) for r in rows)
    total_cost = sum(row_cost(r, p) for p in [pricing] for r in rows)
    turns: set[str] = {str(r.get("turnId") or "") for r in rows if r.get("turnId")}
    sessions: set[str] = {str(r.get("sessionId") or "") for r in rows if r.get("sessionId")}

    by_model: dict[str, dict[str, Any]] = {}
    by_project: dict[str, dict[str, Any]] = {}
    by_hour: dict[int, int] = defaultdict(int)
    token_breakdown = {f: 0 for f in TOKEN_FIELDS}
    timestamps: list[datetime] = []

    for row in rows:
        total = token_total(row)
        model = str(row.get("model") or "unknown")
        cwd = str(row.get("cwd") or "unknown")
        project = project_label(cwd)
        session = str(row.get("sessionId") or "")
        turn = str(row.get("turnId") or "")

        # Model aggregation
        md = by_model.setdefault(model, {
            "name": model, "tokens": 0, "records": 0, "cost": 0.0,
            "input_tokens": 0, "output_tokens": 0, "cache_read": 0,
            "cache_create": 0, "sessions": set(), "turns": set(),
        })
        md["tokens"] += total
        md["records"] += 1
        md["cost"] += row_cost(row, pricing)
        md["input_tokens"] += int(row.get("input_tokens") or 0)
        md["output_tokens"] += int(row.get("output_tokens") or 0)
        md["cache_read"] += int(row.get("cache_read_input_tokens") or 0)
        md["cache_create"] += int(row.get("cache_creation_input_tokens") or 0)
        if session:
            md["sessions"].add(session)
        if turn:
            md["turns"].add(turn)

        # Project aggregation
        pi = by_project.setdefault(project, {
            "name": project, "cwd": cwd, "tokens": 0, "records": 0,
            "cost": 0.0, "models": set(), "sessions": set(), "turns": set(),
            "last": "",
        })
        pi["tokens"] += total
        pi["records"] += 1
        pi["cost"] += row_cost(row, pricing)
        pi["models"].add(model)
        if session:
            pi["sessions"].add(session)
        if turn:
            pi["turns"].add(turn)
        pi["last"] = max(str(pi["last"]), str(row.get("timestamp") or ""))

        # Hourly
        parsed = parse_time(str(row.get("timestamp") or ""))
        if parsed:
            by_hour[parsed.hour] += total
            timestamps.append(parsed)

        for f in TOKEN_FIELDS:
            token_breakdown[f] += int(row.get(f) or 0)

    timestamps.sort()
    minutes = max(1.0, (timestamps[-1] - timestamps[0]).total_seconds() / 60) if len(timestamps) >= 2 else 1.0

    # Sort models
    models_list = []
    for m in by_model.values():
        m["sessions"] = len(m.pop("sessions"))
        m["messages"] = len(m.pop("turns")) or m["records"]
        models_list.append(m)
    models_list.sort(key=lambda x: (-x["tokens"], x["name"]))

    # Sort projects
    projects_list = []
    for p in by_project.values():
        p["models"] = ", ".join(sorted(p.pop("models")))
        p["sessions"] = len(p.pop("sessions"))
        p["messages"] = len(p.pop("turns")) or p["records"]
        projects_list.append(p)
    projects_list.sort(key=lambda x: (-x["tokens"], x["name"]))

    # Hourly array (0-23)
    hourly = [by_hour.get(h, 0) for h in range(24)]

    return {
        "tokens": total_tok, "cost": total_cost,
        "messages": len(turns) or len(rows), "sessions": len(sessions),
        "records": len(rows), "minutes": minutes,
        "breakdown": token_breakdown, "projects": projects_list,
        "models": models_list, "hourly": hourly,
    }


def aggregate_period(rows: list[dict[str, object]], period: str,
                     pricing: dict[str, dict[str, float]],
                     tz: timezone | ZoneInfo) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    seen_turns: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        dt = parse_time(str(row.get("timestamp") or ""))
        if not dt:
            key = "unknown"
        else:
            local = dt.astimezone(tz)
            key = local.strftime("%Y-%m" if period == "monthly" else "%Y-%m-%d")
        b = buckets.setdefault(key, {"name": key, "tokens": 0, "cost": 0.0, "records": 0})
        b["tokens"] += token_total(row)
        b["cost"] += row_cost(row, pricing)
        b["records"] += 1
        turn_id = str(row.get("turnId") or "")
        if turn_id:
            seen_turns[key].add(turn_id)
    for key, turns in seen_turns.items():
        buckets[key]["messages"] = len(turns)
    items = list(buckets.values())
    items.sort(key=lambda x: str(x["name"]))
    return items


# ── Header / Footer Rendering ────────────────────────────────────────────────

def render_header(tz: timezone | ZoneInfo, time_format: str, args=None) -> None:
    now = datetime.now(tz)
    tz_name = getattr(tz, "key", now.tzname() or "local")
    _srcs = _active_sources(args) if args is not None else ["claude"]
    _label = " + ".join(s.upper() for s in _srcs) if len(_srcs) > 1 else (_srcs[0].split()[0] if " " in _srcs[0] else _srcs[0]).upper()
    print(cbold(f"  ✦ ✧ ✦ ✧  {_label} USAGE  ✦ ✧ ✦ ✧", CYAN))
    print(c(f"  {now.strftime('%Y-%m-%d')}  │  {tz_name}  │  {format_clock(now, time_format)}", MUTED))
    print()


def render_tab_bar(current_tab: str) -> None:
    parts = []
    for tab in TABS:
        label = TAB_LABELS[tab]
        key = TAB_KEYS[tab]
        if tab == current_tab:
            parts.append(cbold(f"[{key}] {label}", WHITE))
        else:
            parts.append(c(f"[{key}] {label}", MUTED))
    print("  " + "  │  ".join(parts))
    print(c("  ←→/tab switch  │  1-4 jump  │  q quit", MUTED))


# ── Tab Renderers ────────────────────────────────────────────────────────────

def render_overview(args: argparse.Namespace, pricing: dict[str, dict[str, float]],
                    tz: timezone | ZoneInfo) -> int:
    rows, since, until = collect(args, tz)
    if not rows:
        print(c("  No usage records for today.", MUTED))
        return 0

    data = summarize(rows, pricing)
    burn_rate = data["tokens"] / data["minutes"] if data["minutes"] > 0 else 0.0

    # ── Key Metrics Row ──
    print(cbold("  ◆  Today's Activity", WHITE))
    print()
    print(f"  {fmt_col(c('Total Tokens', MUTED), 22, "<")} {cbold(fmt_int_full(data['tokens']), GREEN)}")
    print(f"  {fmt_col(c('Messages', MUTED), 22, "<")} {c(fmt_int_full(data['messages']), CYAN)}")
    print(f"  {fmt_col(c('Sessions', MUTED), 22, "<")} {c(fmt_int_full(data['sessions']), WHITE)}")
    if pricing and data["cost"] > 0:
        print(f"  {fmt_col(c('Estimated Cost', MUTED), 22, "<")} {cbold(fmt_money(data['cost']), YELLOW)}")
    print()

    # ── Token Breakdown ──
    bd = data["breakdown"]
    total_t = data["tokens"] or 1
    items = [
        ("Input", bd["input_tokens"], BLUE),
        ("Output", bd["output_tokens"], GREEN),
        ("Cache Create", bd["cache_creation_input_tokens"], ORANGE),
        ("Cache Read", bd["cache_read_input_tokens"], MAGENTA),
    ]
    print(cbold("  ◆  Token Composition", WHITE))
    max_w = max(len(name) for name, _, _ in items)
    for name, val, color in items:
        pct = val / total_t * 100 if total_t > 0 else 0
        bar_str = hbar(val, total_t, width=25)
        print(f"  {c(name, MUTED):<{max_w + 18}} {fmt_col(c(fmt_int_full(val), color), 12, ">")} {c(f'{pct:5.1f}%', MUTED)} {bar_str}")
    print()

    # ── Model Distribution ──
    models = data["models"][:5]
    if models:
        print(cbold("  ◆  Model Usage", WHITE))
        max_model = max(m["tokens"] for m in models) or 1
        for m in models:
            pct = m["tokens"] / data["tokens"] * 100 if data["tokens"] > 0 else 0
            bar_str = hbar(m["tokens"], max_model, width=22)
            cost_str = f" {c(fmt_money(m['cost']), YELLOW)}" if pricing else ""
            print(f"  {fmt_col(c(m['name'][:28], model_color(m['name'])), 44, "<")} {fmt_col(c(fmt_int_full(m['tokens']), GREEN), 12, ">")} {bar_str} {c(f'{pct:.1f}%', MUTED)}{cost_str}")
        print()

    # ── Hourly Sparkline ──
    hourly = data["hourly"]
    if any(h > 0 for h in hourly):
        print(cbold("  ◆  Hourly Activity", WHITE))
        spark = sparkline([_safe_float(h) for h in hourly], width=50)
        print(f"  {c(spark, GREEN)}")
        peak_hour = max(range(24), key=lambda h: hourly[h])
        print(f"  {c('Peak:', MUTED)} {c(f'{peak_hour:02d}:00', WHITE)}  "
              f"{c(fmt_int_full(hourly[peak_hour]), GREEN)} tokens  "
              f"{c('|', MUTED)}  {c('Burn:', MUTED)} {c(f'{burn_rate:,.0f}', ORANGE)} tok/min")
        print()

    # ── Recent Projects ──
    projects = data["projects"][:6]
    if projects:
        print(cbold("  ◆  Top Projects", WHITE))
        max_pt = max(p["tokens"] for p in projects) or 1
        for p in projects:
            bar_str = hbar(p["tokens"], max_pt, width=18)
            print(f"  {fmt_col(c(p['name'][:24], model_color(p['name'])), 40, "<")} {fmt_col(c(fmt_int_full(int(p['tokens'])), GREEN), 12, ">")} {bar_str}")
        print()

    print(f"  {DIM}Updated: {format_clock(datetime.now(tz), args.time_format)}{RESET}")
    return 0


def render_projects(args: argparse.Namespace, pricing: dict[str, dict[str, float]],
                    tz: timezone | ZoneInfo) -> int:
    rows, since, until = collect(args, tz)
    if not rows:
        print(c("  No usage records for today.", MUTED))
        return 0

    data = summarize(rows, pricing)
    print(f"  {fmt_col(c('Total Tokens', MUTED), 22, "<")} {cbold(fmt_int_full(data['tokens']), GREEN)}")
    print(f"  {fmt_col(c('Projects', MUTED), 22, "<")} {c(fmt_int_full(len(data['projects'])), WHITE)}")
    if pricing and data["cost"] > 0:
        print(f"  {fmt_col(c('Estimated Cost', MUTED), 22, "<")} {cbold(fmt_money(data['cost']), YELLOW)}")
    print()

    if not data["projects"]:
        print(c("  No project data.", MUTED))
        return 0

    print(cbold("  ◆  Project Breakdown", WHITE))
    print(f"  {fmt_col(c('Project', MUTED), 26, "<")} {fmt_col(c('Tokens', MUTED), 12, ">")} {fmt_col(c('Msgs', MUTED), 6, ">")} {fmt_col(c('Sessions', MUTED), 9, ">")}  {c('Distribution', MUTED)}")
    max_pt = max(p["tokens"] for p in data["projects"]) or 1
    for p in data["projects"][:15]:
        bar_str = gradient_bar(p["tokens"] / max_pt * 100, width=25)
        print(f"  {fmt_col(c(p['name'][:25], model_color(p['name'])), 26, "<")} "
              f"{fmt_col(c(fmt_int_full(int(p['tokens'])), GREEN), 12, ">")} "
              f"{fmt_int_full(int(p['messages'])):>6} "
              f"{fmt_int_full(int(p['sessions'])):>9}  {bar_str}")
        if pricing and p["cost"] > 0:
            print(f"  {'':26} {fmt_col(c(fmt_money(p['cost']), YELLOW), 12, ">")}")

    if len(data["projects"]) > 15:
        print(c(f"  ... and {len(data['projects']) - 15} more projects", MUTED))

    print()
    print(f"  {DIM}Updated: {format_clock(datetime.now(tz), args.time_format)}{RESET}")
    return 0


def render_token_breakdown(input_t: int, output_t: int, cache_w: int, cache_r: int,
                           indent: str = "      ") -> int:
    """Render the concrete input / output / cache-write / cache-read breakdown.
    Shared by the Models tab and the History per-model breakdown so their
    formats stay identical. Returns the model token total.
    """
    model_total = max(1, input_t + output_t + cache_w + cache_r)
    max_t = max(input_t, output_t, cache_w, cache_r, 1)
    print(f"    Usage Breakdown  (input / output / cache-write / cache-read):")
    for label, val, col in (
        ("Input",       input_t,  GREEN),
        ("Output",      output_t, CYAN),
        ("Cache Write", cache_w,  YELLOW),
        ("Cache Read",  cache_r,  MAGENTA),
    ):
        print(f"      {label:<12} {fmt_col(c(fmt_int_full(val), col), 13, '>')} tok  "
              f"{c(f'({fmt_pct(val, model_total)})', col)}  {hbar(val, max_t, width=16)}")
    return model_total


def render_models(args: argparse.Namespace, pricing: dict[str, dict[str, float]],
                  tz: timezone | ZoneInfo) -> int:
    rows, since, until = collect(args, tz)
    if not rows:
        print(c("  No usage records for today.", MUTED))
        return 0

    data = summarize(rows, pricing)
    models = data["models"]
    if not models:
        print(c("  No model data.", MUTED))
        return 0

    print(cbold("  ◆  Model Comparison", WHITE))
    print()

    total_tok = data["tokens"] or 1
    max_mt = max(m["tokens"] for m in models) or 1

    for m in models:
        name = m["name"]
        pct = m["tokens"] / total_tok * 100
        color = model_color(name)

        print(f"  {cbold(name[:36], color)}")
        print(f"    Tokens:     {fmt_col(c(fmt_int_full(m['tokens']), GREEN), 12, ">")}  ({pct:.1f}%)  {hbar(m['tokens'], max_mt, width=28)}")

        eff = m["tokens"] / max(1, m["messages"])
        print(f"    Messages:   {fmt_int_full(m['messages']):>12}  │  Efficiency: {c(f'{eff:,.0f}', CYAN)} tok/msg")

        input_t = m.get("input_tokens", 0)
        output_t = m.get("output_tokens", 0)
        cache_w = m.get("cache_create", 0)   # cache write / prompt-cache creation
        cache_r = m.get("cache_read", 0)     # cache read / cache hits
        render_token_breakdown(input_t, output_t, cache_w, cache_r)

        cache_rate = cache_r / max(1, input_t + cache_w + cache_r)
        print(f"    Cache Hit:  {c(f'{cache_rate * 100:.1f}%', MAGENTA if cache_rate > 0.3 else YELLOW)}  "
              f"of input-side tokens served from cache")

        if pricing and m["cost"] > 0:
            cost_per_msg = m["cost"] / max(1, m["messages"])
            print(f"    Cost:       {fmt_col(c(fmt_money(m['cost']), YELLOW), 12, ">")}  │  per msg: {c(fmt_money(cost_per_msg), YELLOW)}")

        print()

    print(f"  {DIM}Updated: {format_clock(datetime.now(tz), args.time_format)}{RESET}")
    return 0


def render_history(args: argparse.Namespace, pricing: dict[str, dict[str, float]],
                   tz: timezone | ZoneInfo, period: str = "7d") -> int:
    now = datetime.now(tz)
    if period == "all":
        since_dt = datetime(2024, 1, 1, tzinfo=tz)
    elif period == "30d":
        since_dt = now - timedelta(days=30)
    else:
        since_dt = now - timedelta(days=7)
    since_iso = iso_bound(since_dt)
    until_iso = iso_bound(now)

    use_claude, codex_dir, pi_dir = source_flags(args)
    all_rows = load_records(args.input_dir, since_iso, until_iso, args.include_synthetic,
                            use_claude=use_claude, codex_dir=codex_dir, pi_dir=pi_dir)
    if not all_rows:
        print(c("  No records for this period.", MUTED))
        return 0

    daily = aggregate_period(all_rows, "daily", pricing, tz)
    daily.sort(key=lambda x: str(x["name"]))

    # ── Sub-tab bar ──
    period_parts = []
    for p in HISTORY_PERIODS:
        label = HISTORY_PERIOD_LABELS[p]
        if p == period:
            period_parts.append(cbold(f"[{label}]", WHITE))
        else:
            period_parts.append(c(f"{label}", MUTED))
    print("  Period: " + "  ".join(period_parts) + c("    —  [ ] h/l switch", MUTED))
    print()

    period_label = HISTORY_PERIOD_LABELS[period]

    # ── Summary row ──
    total_tokens = sum(int(d["tokens"]) for d in daily)
    total_msgs = sum(int(d.get("messages", d["records"])) for d in daily)
    print(f"  {fmt_col(c('Total Tokens', MUTED), 22, '<')} {cbold(fmt_int_full(total_tokens), GREEN)}")
    print(f"  {fmt_col(c('Total Messages', MUTED), 22, '<')} {c(fmt_int_full(total_msgs), CYAN)}")
    if pricing:
        total_cost = sum(_safe_float(d.get("cost")) for d in daily)
        if total_cost > 0:
            print(f"  {fmt_col(c('Total Cost', MUTED), 22, '<')} {cbold(fmt_money(total_cost), YELLOW)}")
    print()

    # ── Sparkline ──
    day_values = [float(d["tokens"]) for d in daily]
    if day_values:
        print(cbold(f"  ◆  {period_label} Trend", WHITE))
        spark = sparkline(day_values, width=55)
        print(f"  {c(spark, GREEN)}")
        print()

    # ── Daily bars ──
    print(cbold("  ◆  Daily Breakdown", WHITE))
    max_tokens = max(day_values) if day_values else 1
    for item in daily:
        day = str(item["name"])
        tokens = int(item["tokens"])
        messages = int(item.get("messages", item["records"]))
        pct_val = tokens / max_tokens * 100 if max_tokens > 0 else 0
        bar_str = gradient_bar(pct_val, width=30)
        cost_str = f"  {c(fmt_money(float(item['cost'])), YELLOW)}" if pricing and item.get("cost") else ""
        print(f"  {c(day, WHITE)}  {fmt_col(c(fmt_int_full(tokens), GREEN), 12, '>')} {bar_str} {fmt_int_full(messages):>6} msgs{cost_str}")

    print()

    # ── Per-model breakdown for the period ──
    by_model: dict[str, int] = {}
    by_model_cost: dict[str, float] = {}
    by_model_msgs: dict[str, set[str]] = defaultdict(set)
    by_model_io: dict[str, dict[str, int]] = defaultdict(lambda: {
        "input": 0, "output": 0, "cache_w": 0, "cache_r": 0,
    })
    for row in all_rows:
        model = str(row.get("model") or "unknown")
        by_model[model] = by_model.get(model, 0) + token_total(row)
        by_model_cost[model] = by_model_cost.get(model, 0.0) + row_cost(row, pricing)
        tid = str(row.get("turnId") or "")
        if tid:
            by_model_msgs[model].add(tid)
        io = by_model_io[model]
        io["input"]   += int(row.get("input_tokens") or 0)
        io["output"]  += int(row.get("output_tokens") or 0)
        io["cache_w"] += int(row.get("cache_creation_input_tokens") or 0)
        io["cache_r"] += int(row.get("cache_read_input_tokens") or 0)
    if by_model:
        # Compact table: one row per model keeps many models readable. Full
        # in/out/cache detail lives in the Models tab (render_token_breakdown),
        # and overall Total Cost is shown in the summary block above.
        print(cbold("  ◆  Model Breakdown", WHITE))
        total_model_tokens = sum(by_model.values()) or 1
        model_w = max(12, min(max((len(m) for m in by_model), default=12), 17))
        cols = [
            ("Model",  model_w, "<"),
            ("Tokens", 8, ">"),
            ("%",      6, ">"),
            ("Input",  6, ">"),
            ("Output", 7, ">"),
            ("CacheW", 6, ">"),
            ("CacheR", 8, ">"),
            ("Msgs",   6, ">"),
        ]
        def fmt_row(values) -> str:
            return "  " + " ".join(fmt_col(v, w, a) for v, (_, w, a) in zip(values, cols))
        print(fmt_row([c(h, MUTED) for h, _, _ in cols]))
        for model in sorted(by_model, key=lambda x: by_model[x], reverse=True):
            tok = by_model[model]
            io = by_model_io[model]
            msgs = len(by_model_msgs[model])
            print(fmt_row([
                c(model[:model_w].ljust(model_w), model_color(model)),
                c(fmt_int(tok), GREEN),
                c(fmt_pct(tok, total_model_tokens), WHITE),
                c(fmt_int(io["input"]), CYAN),
                c(fmt_int(io["output"]), BLUE),
                c(fmt_int(io["cache_w"]), YELLOW),
                c(fmt_int(io["cache_r"]), MAGENTA),
                c(fmt_int_full(msgs), MUTED),
            ]))
        print()

    # ── Trend arrow (7d/30d only) ──
    if period != "all" and len(daily) >= 4:
        recent = sum(int(d["tokens"]) for d in daily[-3:])
        prior = sum(int(d["tokens"]) for d in daily[-6:-3]) if len(daily) >= 6 else sum(int(d["tokens"]) for d in daily[:-3])
        if prior > 0:
            change = (recent - prior) / prior * 100
            arrow = "▲" if change > 0 else "▼"
            tcolor = RED if change > 15 else (GREEN if change < -15 else YELLOW)
            print(f"  {fmt_col(c('3-Day Trend', MUTED), 22, '<')} {c(f'{arrow} {abs(change):.1f}% vs prior 3 days', tcolor)}")
            print()

    print(f"  {DIM}Updated: {format_clock(now, args.time_format)}{RESET}")
    return 0


def render_table_view(args: argparse.Namespace, pricing: dict[str, dict[str, float]],
                      tz: timezone | ZoneInfo) -> int:
    use_claude, codex_dir, pi_dir = source_flags(args)
    rows = load_records(args.input_dir, args.since, args.until, args.include_synthetic,
                        use_claude=use_claude, codex_dir=codex_dir, pi_dir=pi_dir)
    if not rows:
        print("No usage records found.")
        return 0
    items = aggregate_period(rows, args.view, pricing, tz)
    width = max([len(str(i["name"])) for i in items] + [10])
    print(f"Usage ({', '.join(_active_sources(args))}) — {args.view}")
    print("─" * 78)
    print(f"{'Period':<{width}}  {'Tokens':>14}  {'Messages':>9}  {'Records':>8}  {'Cost':>10}")
    print("─" * 78)
    for item in items:
        print(
            f"{str(item['name']):<{width}}  "
            f"{fmt_int_full(int(item['tokens'])):>14}  "
            f"{fmt_int_full(int(item.get('messages', item['records']))):>9}  "
            f"{fmt_int_full(int(item['records'])):>8}  "
            f"{fmt_money(float(item['cost'])) if pricing else 'n/a':>10}"
        )
    return 0


# ── Main Render ──

def render(args: argparse.Namespace, tab: str | None = None, pricing=None, tz=None,
           history_period: str = "7d") -> int:
    if not args.input_dir.exists():
        print(f"Input directory not found: {args.input_dir}", file=sys.stderr)
        return 1

    if pricing is None:
        try:
            pricing = load_pricing(args.pricing, args.price, not args.no_builtin_pricing)
        except (OSError, ValueError) as exc:
            print(f"Pricing error: {exc}", file=sys.stderr)
            return 1

    if tz is None:
        tz = resolve_timezone(args.timezone)

    if args.view in {"daily", "monthly"}:
        return render_table_view(args, pricing, tz)

    active_tab = tab or getattr(args, "tab", "overview")

    render_header(tz, args.time_format, args=args)
    render_tab_bar(active_tab)
    print()

    renderers = {
        "overview": render_overview,
        "projects": render_projects,
        "models": render_models,
    }
    if active_tab == "history":
        return render_history(args, pricing, tz, period=history_period)
    return renderers[active_tab](args, pricing, tz)


# ── JSON Serialization ─────────────────────────────────────────────────────────

def _json_safe(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, set):
        return list(obj)
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def _active_sources(args) -> list[str]:
    want_claude = bool(getattr(args, "claude", False))
    want_codex = bool(getattr(args, "codex", False))
    want_pi = bool(getattr(args, "pi", False))
    if not (want_claude or want_codex or want_pi):
        # Default: all sources
        want_claude = want_codex = want_pi = True
    srcs: list[str] = []
    if want_claude:
        srcs.append("claude")
    if want_codex:
        srcs.append("codex")
    if want_pi:
        srcs.append("pi")
    return srcs

def api_data(args, pricing, tz):
    rows, since, until = collect(args, tz)
    data = summarize(rows, pricing)
    data["since"] = since
    data["until"] = until
    data["updated"] = datetime.now(tz).isoformat()
    data["interval"] = args.interval
    data["sources"] = _active_sources(args)
    return data


def api_history(args, pricing, tz, period="7d"):
    now = datetime.now(tz)
    if period == "all":
        since_dt = datetime(2024, 1, 1, tzinfo=tz)
    elif period == "30d":
        since_dt = now - timedelta(days=30)
    else:
        since_dt = now - timedelta(days=7)
    since_iso = iso_bound(since_dt)
    until_iso = iso_bound(now)
    use_claude, codex_dir, pi_dir = source_flags(args)
    all_rows = load_records(args.input_dir, since_iso, until_iso, args.include_synthetic,
                            use_claude=use_claude, codex_dir=codex_dir, pi_dir=pi_dir)
    return aggregate_period(all_rows, "daily", pricing, tz)


# ── HTTP Server ───────────────────────────────────────────────────────────────

_HTML_PATH = Path(__file__).resolve().parent / "goo-usage-dashboard.html"


def _read_html():
    if _HTML_PATH.exists():
        return _HTML_PATH.read_text(encoding="utf-8")
    return "<html><body><h1>Dashboard template not found</h1></body></html>"


class _UsageHandler:

    def __init__(self, args, pricing, tz):
        self.args = args
        self.pricing = pricing
        self.tz = tz

    def handle(self, path):
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(path)
        route = parsed.path.rstrip("/") or "/"

        if route in ("/", "/index.html", "/usage.html"):
            return 200, "text/html; charset=utf-8", _read_html()

        if route == "/api/data":
            try:
                data = api_data(self.args, self.pricing, self.tz)
                body = json.dumps(data, default=_json_safe)
                return 200, "application/json", body
            except Exception as exc:
                return 500, "application/json", json.dumps({"error": str(exc)})

        if route == "/api/history":
            qs = parse_qs(parsed.query)
            period = qs.get("period", ["7d"])[0].strip()
            if period not in ("7d", "30d", "all"):
                period = "7d"
            try:
                data = api_history(self.args, self.pricing, self.tz, period)
                body = json.dumps(data, default=_json_safe)
                return 200, "application/json", body
            except Exception as exc:
                return 500, "application/json", json.dumps({"error": str(exc)})

        return 404, "text/plain", "Not Found"


def _local_ip_addresses():
    import socket

    addresses = set()
    for probe in (socket.gethostname(), socket.getfqdn()):
        try:
            for info in socket.getaddrinfo(probe, None, socket.AF_INET, socket.SOCK_STREAM):
                address = info[4][0]
                if address and not address.startswith("127."):
                    addresses.add(address)
        except OSError:
            pass
    return sorted(addresses)


def _display_urls(host, port):
    if host in ("0.0.0.0", "::"):
        urls = [f"http://127.0.0.1:{port}/index.html"]
        urls.extend(f"http://{address}:{port}/index.html" for address in _local_ip_addresses())
        return urls
    return [f"http://{host}:{port}/index.html"]

def _make_server(args, pricing, tz):
    from http.server import HTTPServer, BaseHTTPRequestHandler

    handler_obj = _UsageHandler(args, pricing, tz)

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            code, mime, body = handler_obj.handle(self.path)
            payload = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(payload)))
            if mime == "application/json":
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format, *args):
            pass

    last_error = None
    for candidate in range(args.port, args.port + 20):
        try:
            server = HTTPServer((args.host, candidate), _Handler)
            return server, candidate
        except OSError as exc:
            last_error = exc
    raise SystemExit(f"failed to start usage server near port {args.port}: {last_error}")


def run_serve(args, pricing, tz):
    import webbrowser
    server, selected_port = _make_server(args, pricing, tz)
    urls = _display_urls(args.host, selected_port)
    print(f"Usage dashboard: {urls[0]}")
    for url in urls[1:]:
        print(f"Remote URL: {url}")
    print("Press Ctrl+C to stop.")
    try:
        webbrowser.open(urls[0])
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()
    return 0


def _nav_key(key: str | None, current_tab: str, history_period: str) -> tuple[str, str]:
    """Map a pressed key to the (tab, period) to switch to. No-op keys return current."""
    if key in ("left",):
        idx = TABS.index(current_tab)
        return TABS[(idx - 1) % len(TABS)], history_period
    if key in ("right", "tab"):
        idx = TABS.index(current_tab)
        return TABS[(idx + 1) % len(TABS)], history_period
    if key in ("1", "2", "3", "4"):
        return TABS[int(key) - 1], history_period
    if key == "bracket_left":
        idx = HISTORY_PERIODS.index(history_period)
        return current_tab, HISTORY_PERIODS[(idx - 1) % len(HISTORY_PERIODS)]
    if key == "bracket_right":
        idx = HISTORY_PERIODS.index(history_period)
        return current_tab, HISTORY_PERIODS[(idx + 1) % len(HISTORY_PERIODS)]
    return current_tab, history_period


def _render_windowed(args, pricing, tz, current_tab, history_period, height: int, scroll: int, window: bool):
    """渲染当前 tab，但只输出可见视口（height 行）。非 TTY/窗口关闭时原样输出。
    返回 (rc, total_lines) 供调用方夹取滚动偏移。"""
    if not window:
        rc = render(args, tab=current_tab, pricing=pricing, tz=tz, history_period=history_period)
        return rc, 0
    import contextlib as _ctx, io as _io
    buf = _io.StringIO()
    with _ctx.redirect_stdout(buf):
        rc = render(args, tab=current_tab, pricing=pricing, tz=tz, history_period=history_period)
    lines = buf.getvalue().split("\n")
    while lines and lines[-1] == "":
        lines.pop()
    total = len(lines)
    max_scroll = max(0, total - height)
    scroll = min(scroll, max_scroll)
    if total <= height:
        print("\n".join(lines))
        return rc, total
    # 内容占 height-1 行，末行显示滚动条与提示
    print("\n".join(lines[scroll:scroll + height - 1]))
    bar_w = max(6, height - 2)
    pos = scroll / max(1, max_scroll)
    filled = max(1, round(pos * bar_w))
    bar = "█" * filled + "░" * (bar_w - filled)
    print(f"{DIM}  {scroll + 1}-{min(scroll + height - 1, total)}/{total}  [{bar}]  ↑/↓ k/j PgUp/PgDn wheel Home/End{RESET}")
    return rc, total


def run_interactive(args, pricing, tz, current_tab: str, history_period: str, live: bool, interval: float) -> int:
    """Interactive tab-selection UI. Only 'q' (or Ctrl+C) exits.

    live=True  -> default dashboard: auto-refresh on interval.
    live=False -> --once: render once, wait for keys to switch tabs, 'q' to quit
                  (no timed refresh).
    """
    is_tty = sys.stdout.isatty() and sys.stdin.isatty()
    # 每 tab 独立滚动偏移（Models 等长内容可滚动查看）
    scroll: dict[str, int] = {t: 0 for t in TABS}
    if is_tty:
        import shutil as _sh
        # 视口高度（留 1 行给滚动条），最小 10
        height = max(10, _sh.get_terminal_size(fallback=(80, 24)).lines - 1)
        # Enter alternate screen buffer (like vim/htop) — keeps shell clean.
        # 用 \033[2J 全清 + \033[H 回位：\033[J 只清光标到屏尾，在 tmux/ConPTY/
        # SSH 包装层或上一帧溢出滚动后，切到较短帧会残留上一次窗口的内容。
        # ?1000h + ?1006h 启用鼠标/SGR 滚轮上报。
        print("\033[?1049h\033[?25l\033[?1000h\033[?1006h\033[2J\033[H", end="", flush=True)
    else:
        height = 100000
    try:
        while True:
            if is_tty:
                print("\033[2J\033[H", end="", flush=True)  # 全清 + home（健壮全帧重绘）
            rc, total = _render_windowed(args, pricing, tz, current_tab, history_period,
                                         height, scroll[current_tab], is_tty)
            sys.stdout.flush()
            if rc:
                return rc
            scroll[current_tab] = min(scroll[current_tab], max(0, total - height))

            if live:
                deadline = time.monotonic() + max(1.0, interval)
                key = None
                while time.monotonic() < deadline:
                    k = read_key(timeout=0.3, keep_raw=True)
                    if k is not None:
                        key = k
                        break
                if key is None:
                    continue  # timed refresh tick: just re-render
            else:
                # --once: block until a key is pressed (no timed refresh), 'q' quits
                key = None
                while key is None:
                    key = read_key(timeout=0.3, keep_raw=True)

            if key == "quit":
                return 0
            # 滚动键（作用于当前 tab 的视口）
            max_scroll = max(0, total - height)
            if key in ("up",):
                scroll[current_tab] = max(0, scroll[current_tab] - 1)
                continue
            if key in ("down",):
                scroll[current_tab] = min(max_scroll, scroll[current_tab] + 1)
                continue
            if key in ("page_up",):
                scroll[current_tab] = max(0, scroll[current_tab] - 10)
                continue
            if key in ("page_down",):
                scroll[current_tab] = min(max_scroll, scroll[current_tab] + 10)
                continue
            if key in ("home",):
                scroll[current_tab] = 0
                continue
            if key in ("end",):
                scroll[current_tab] = max_scroll
                continue
            current_tab, history_period = _nav_key(key, current_tab, history_period)
    except KeyboardInterrupt:
        return 0
    finally:
        if is_tty:
            restore_raw()
            # 关鼠标上报，退出 alternate screen buffer，恢复光标
            print("\033[?1006l\033[?1000l\033[?25h\033[?1049l", end="", flush=True)
    return 0


def main() -> int:
    args = parse_args()

    pricing = load_pricing(args.pricing, args.price, not args.no_builtin_pricing)
    tz = resolve_timezone(args.timezone)

    if args.serve:
        return run_serve(args, pricing, tz)

    if getattr(args, "json", False):
        import json as _json
        data = api_data(args, pricing, tz)
        print(_json.dumps(data, ensure_ascii=False, indent=2, default=_json_safe))
        return 0

    if args.once:
        if sys.stdin.isatty() and sys.stdout.isatty():
            # --once also enters the interactive selection UI; only 'q' exits
            return run_interactive(args, pricing, tz, args.tab, "7d",
                                   live=False, interval=args.interval)
        # Non-interactive (e.g. extension subprocess): one-shot snapshot, exit now
        return render(args, pricing=pricing, tz=tz)

    # Default live dashboard with auto-refresh
    return run_interactive(args, pricing, tz, args.tab, "7d",
                           live=True, interval=args.interval)


if __name__ == "__main__":
    raise SystemExit(main())

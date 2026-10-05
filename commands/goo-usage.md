---
name: auto-goo:goo-usage
description: 显示 Claude Code token 和 usage 监控面板 — 多色可视化终端仪表盘，可选 --serve 启动 HTML 仪表盘
---

## 执行流程

加载此命令后，**必须优先调用 AskUserQuestion / 结构化选择 UI 询问用户**，让 Claude Code 渲染可用方向键移动、Enter 确认的选择控件；必须复用 `skills/auto-goo/references/interaction-templates.md` 中 `id=usage_view` 的 JSON 模板，不得在交互控件可用时用普通文本要求用户手打 `1/2`：

- header: Usage 视图
- id: usage_view
- question: 请选择 usage 面板打开方式。
- options:
  - label: 浏览器面板 (Recommended)
    description: 启动 HTML 仪表盘并自动刷新，适合持续观察 token 消耗。
  - label: 内联快照
    description: 在当前终端打印一次 usage 快照，不进入交互式 watch 模式。

如果结构化选择 UI / AskUserQuestion 不可用、调用失败或按钮没有渲染，使用以下纯文本 fallback：

```text
这是 fallback：结构化选择 UI 不可用。请选择 usage 面板打开方式：
1. 浏览器面板 (Recommended) - 启动 HTML 仪表盘并自动刷新
2. 内联快照 - 在当前终端打印一次 usage 快照

请回复 1/2，或直接回复“浏览器面板”/“内联快照”。
```

不要提示用户手动进入插件目录或直跑内部脚本；本命令必须优先从 Claude Code 安装记录解析 `installPath`，路径不可用时 fallback 到已启用的本地 directory marketplace，再调用脚本。

### 选项 1: 浏览器 HTML 仪表盘

启动内建 HTTP 服务器，自动打开浏览器：

```bash
auto_goo_root="$(
  python3 - <<'PY' 2>/dev/null || true
import json
from pathlib import Path

home = Path.home()
matches = []

def usable(path):
    return path.exists() and not (path / ".orphaned_at").exists()

registry = home / ".claude/plugins/installed_plugins.json"
if registry.exists():
    data = json.loads(registry.read_text(encoding="utf-8"))
    for key, entries in data.get("plugins", {}).items():
        if key.split("@", 1)[0] != "autogoo-plugin":
            continue
        for entry in entries:
            path = Path(entry.get("installPath", "")).expanduser()
            if usable(path):
                matches.append((entry.get("lastUpdated", ""), str(path)))

if not matches:
    settings = home / ".claude/settings.json"
    if settings.exists():
        data = json.loads(settings.read_text(encoding="utf-8"))
        enabled = data.get("enabledPlugins", {})
        marketplaces = data.get("extraKnownMarketplaces", {})
        for key, is_enabled in enabled.items():
            if not is_enabled or "@" not in key:
                continue
            plugin, marketplace = key.split("@", 1)
            if plugin != "autogoo-plugin":
                continue
            source = marketplaces.get(marketplace, {}).get("source", {})
            if source.get("source") != "directory":
                continue
            path_text = source.get("path")
            if not path_text:
                continue
            path = Path(path_text).expanduser()
            if usable(path):
                matches.append(("settings:" + marketplace, str(path)))

if matches:
    print(sorted(matches)[-1][1])
PY
)"
if [ -z "$auto_goo_root" ] || [ ! -f "$auto_goo_root/skills/auto-goo/scripts/goo-usage.py" ]; then
  echo "AutoGoo-Plugin root not configured; install autogoo-plugin or enable a local directory marketplace in ~/.claude/settings.json" >&2
  exit 127
fi
python3 "$auto_goo_root/skills/auto-goo/scripts/goo-usage.py" --serve --interval 30
```

然后告知用户浏览器地址 `http://localhost:9876`。

如果 `--serve` 无法自动打开浏览器，手动用以下方式打开：
- VS Code: 用 Simple Browser 或内置浏览器打开 `http://localhost:9876`
- 终端: `xdg-open http://localhost:9876` 或 `open http://localhost:9876`

关闭方式：Ctrl+C 停止服务器，或关闭浏览器后 kill 后台进程。

### 选项 2: 内联 TUI

```bash
auto_goo_root="$(
  python3 - <<'PY' 2>/dev/null || true
import json
from pathlib import Path

home = Path.home()
matches = []

def usable(path):
    return path.exists() and not (path / ".orphaned_at").exists()

registry = home / ".claude/plugins/installed_plugins.json"
if registry.exists():
    data = json.loads(registry.read_text(encoding="utf-8"))
    for key, entries in data.get("plugins", {}).items():
        if key.split("@", 1)[0] != "autogoo-plugin":
            continue
        for entry in entries:
            path = Path(entry.get("installPath", "")).expanduser()
            if usable(path):
                matches.append((entry.get("lastUpdated", ""), str(path)))

if not matches:
    settings = home / ".claude/settings.json"
    if settings.exists():
        data = json.loads(settings.read_text(encoding="utf-8"))
        enabled = data.get("enabledPlugins", {})
        marketplaces = data.get("extraKnownMarketplaces", {})
        for key, is_enabled in enabled.items():
            if not is_enabled or "@" not in key:
                continue
            plugin, marketplace = key.split("@", 1)
            if plugin != "autogoo-plugin":
                continue
            source = marketplaces.get(marketplace, {}).get("source", {})
            if source.get("source") != "directory":
                continue
            path_text = source.get("path")
            if not path_text:
                continue
            path = Path(path_text).expanduser()
            if usable(path):
                matches.append(("settings:" + marketplace, str(path)))

if matches:
    print(sorted(matches)[-1][1])
PY
)"
if [ -z "$auto_goo_root" ] || [ ! -f "$auto_goo_root/skills/auto-goo/scripts/goo-usage.py" ]; then
  echo "AutoGoo-Plugin root not configured; install autogoo-plugin or enable a local directory marketplace in ~/.claude/settings.json" >&2
  exit 127
fi
python3 "$auto_goo_root/skills/auto-goo/scripts/goo-usage.py" --once
```

先让用户 approve 此命令。
`--once` 打印一次快照后退出，避免在 Claude Code 终端内启动交互式 TUI 导致的终端冲突。

## 仪表盘

4 个 Tab，默认打开 Overview：

| Tab | 快捷键 | 内容 |
|-----|--------|------|
| **Overview** | `1` | 今日总览：token 总量、消息数、会话数、token 组成（渐变色条）、模型分布、24 小时活动 sparkline、峰值时段、燃耗率、Top 项目 |
| **Projects** | `2` | 按项目拆分：渐变色条展示各项目 token 占比，消息数、会话数、cost |
| **Models** | `3` | 模型对比：每个模型的 token 量、消息数、效率(tok/msg)、I/O 比、缓存命中率、cost per message |
| **History** | `4` | 7 天趋势：sparkline 总览、逐日渐变色条、3 日趋势箭头（▲/▼ + 变化%）、7 日汇总 |

## 操作

- `←` `→` 或 `Tab` 切换 Tab
- `1` `2` `3` `4` 直接跳转
- `q` 退出
- `--once` 打印一次后退出（不进入 watch 模式）
- `--interval N` 设置刷新间隔（默认 30s）

## 数据来源（token 消耗统计范围）

默认**同时统计 Claude Code + Codex + Pi 三个来源**的全部 token 消耗。可用以下参数过滤：

- `--claude`：只看 Claude Code（`--input-dir`，默认 `~/.claude/projects`）
- `--codex`：只看 Codex CLI（`~/.codex/sessions`）
- `--pi`：只看 Pi（`~/.pi/agent/sessions`）

多个来源参数可以组合（如 `--codex --pi` 只看这两者）。不传任何来源参数时自动包含全部三个来源。

### 跨环境 / 数据源重定向与排查

默认读取三源：Claude Code `~/.claude/projects`、Codex CLI `~/.codex/sessions`、Pi `~/.pi/agent/sessions`。**只装 pi、没装 Claude Code 的环境也能正常工作**：单个源缺失只会在 stderr 打 warning 并跳过，只有所有启用源都没有 jsonl 时才报错退出。

支持用官方环境变量重定向（解析优先级：CLI 参数 > 环境变量 > home 默认）：

- `CLAUDE_CONFIG_DIR` → claude 源 `$CLAUDE_CONFIG_DIR/projects`
- `CODEX_HOME` → codex 源 `$CODEX_HOME/sessions`
- `PI_CODING_AGENT_DIR` → pi 源 `$PI_CODING_AGENT_DIR/sessions`
- `PI_CODING_AGENT_SESSION_DIR` → pi 源目录本身（优先级高于 `PI_CODING_AGENT_DIR`）
- `PI_SESSION_FILE` → pi 源取该文件的上两级目录

也可以显式指定：`--input-dir`（claude）、`--codex-dir`（codex）、`--pi-dir`（pi）。

**排查第一入口**：`python3 <root>/skills/auto-goo/scripts/goo-usage.py --sources`。面板为空时按以下顺序排查：

1. 先跑 `--sources`，看每个源的解析路径、`exists` 与 `jsonl` 计数；
2. 路径不对就用上面的环境变量或 `--input-dir` / `--codex-dir` / `--pi-dir` 覆盖；
3. 仍不对就看 `--json` 输出里的 `resolved_sources`（含 `name` / `path` / `exists` / `jsonl_count` / `origin`）。

## 内置价格

脚本内建常见 Claude 模型的官方定价（USD/1M tokens），无需手动传 `--price`：

- claude-opus-4-7: $15/$75 input/output
- claude-sonnet-4-6: $3/$15
- claude-haiku-4-5: $0.80/$4

传 `--no-builtin-pricing` 禁用内建价格；传 `--pricing FILE` 或 `--price MODEL=X,Y,Z` 使用自定义价格。

## 用户意图映射

历史/趋势 → `--tab history`，项目分布 → `--tab projects`，模型分析 → `--tab models`，只看一次 → `--once`。

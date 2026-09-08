---
name: auto-goo:goo-observe
description: 观察 AutoGoo-Plugin 后台 subagent、shell 日志和 Agent View 使用入口
---

# /auto-goo:goo-observe — 后台观察

> **状态查看豁免**：本命令是纯观察入口，仅渲染后台 subagent/shell/step 状态，属「状态查看」主模型豁免范围，主模型可运行 `goo-observe.py`，但只做「只看不做分析」——不得在本命令内做归因、根因定位、聚类或优化决策；需要分析时走对应分析命令并派发相应 Subagent（机械采集 `collector` / 认知研究 `researcher`）。

用于执行期间快速观察三类状态：

1. Claude Code Agent View 中的后台 session / shell job。
2. AutoGoo-Plugin 当前 thread 的 running / blocked / failed step。
3. 当前 step log 和 shell 长任务日志路径。

## 交互提问

`/auto-goo:goo-observe` 是纯观察命令，无需用户输入目标，但首次使用时应确认观察范围：

- 默认只观察当前 thread（通过 `.goo/current_thread.json` 定位）
- 如存在多个 thread，可加 `--all-threads` 观察所有活跃线程

## 行为

必须优先运行插件脚本，而不是手写临时检查。先解析插件根目录，再调用脚本：

```bash
auto_gooroot="$(
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
if [ -z "$auto_goo_root" ] || [ ! -f "$auto_goo_root/skills/auto-goo/scripts/goo-observe.py" ]; then
  echo "AutoGoo-Plugin root not configured; install autogoo-plugin or enable a local directory marketplace in ~/.claude/settings.json" >&2
  exit 127
fi
python3 "$auto_goo_root/skills/auto-goo/scripts/goo-observe.py" --root .
```

如果需要给 Web 或其他工具消费，使用：

```bash
python3 "$auto_goo_root/skills/auto-goo/scripts/goo-observe.py" --root . --json
```

## 输出要求

- 顶部展示当前 root、thread、plan、logs、shell logs 和 Claude Code 版本。
- 展示 Agent View 入口：`claude agents`，并说明 `Space` peek、`Enter/Right` attach。
- 明确说明 Agent View 只能看后台 Claude session / shell job；AutoGoo-Plugin 内部 subagent 不会作为独立 session 行出现，细节看当前 thread plan 和 step logs。
- RUNNING 区展示 step id、名称、progress、heartbeat age、subagent/task_agent、log path 和最近日志尾部。
- BLOCKED / FAILED 区展示需要处理的 step 和日志路径。
- Shell Tracking 区给出推荐模板：`mkdir -p <shell-log-dir> && <command> 2>&1 | tee <shell-log-dir>/<name>-$(date +%Y%m%d-%H%M%S).log`。

## 备注

- 不启动或终止后台任务。
- 不读取 secrets。
- 不替代 `/auto-goo:goo-status`；它是观察入口，`goo-status` 是状态仪表盘。
- `goo-publish` 的 `observe.html` 必须复用同一脚本生成的数据模型。

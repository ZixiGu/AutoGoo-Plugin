---
name: auto-goo:goo-status
description: 显示当前 AutoGoo-Plugin 任务执行进度 — 优先读取当前 thread plan 渲染简洁仪表盘
---

# /auto-goo:goo-status — 执行仪表盘

以 plan.json 或 thread 为数据源，渲染简洁终端仪表盘。**少字，多看。**

> **状态查看豁免**：本命令仅渲染状态，属「状态查看」主模型豁免范围，主模型可运行 `goo-status.py`，但只做「只看不做分析」——不得在本命令内做归因、根因定位、聚类或优化决策；需要分析时走 `/auto-goo:goo-usage-analyse` 或 `/auto-goo:goo-improve` 并派发 `researcher`。

如果用户说“查看所有任务线 / threads / 多个 plan 状态”，运行：

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

```bash
python3 "$auto_goo_root/skills/auto-goo/scripts/goo-status.py" --threads
```

如果用户指定 thread id，读取 `.goo/threads/<thread_id>/plan.json`；没有指定时优先读取 `.goo/current_thread.json` 指向的 thread plan，缺失时回退 `.goo/plan.json`。

必须优先运行插件脚本，而不是手写临时渲染逻辑：

```bash
if [ -z "$auto_goo_root" ] || [ ! -f "$auto_goo_root/skills/auto-goo/scripts/goo-status.py" ]; then
  echo "AutoGoo-Plugin root not configured; install autogoo-plugin or enable a local directory marketplace in ~/.claude/settings.json" >&2
  exit 127
fi
	python3 "$auto_goo_root/skills/auto-goo/scripts/goo-status.py"
```

如果当前 thread plan 或兼容 `.goo/plan.json` 中的 running step 没有更新 `heartbeat_at` 或 `progress`，必须显示告警；不要假装仍在正常执行。脚本还会检查当前 thread 的 `logs/`（兼容 `.goo/logs/`）和 step log：running / blocked / failed 缺少对应日志是告警，completed 缺少日志只作为留痕提示。

## 信息密度原则

- 顶部先给总览：完成数、进度、running/ready/waiting/blocked/failed、槽位占用
- 第二行明确 `Next:`，直接告诉用户下一步该等、该跑还是该处理告警
- Ready 和 Blocked 分开展示，不把所有 pending 混在一起
- 执行中步骤：进度条 + output 预览 + heartbeat
- 告警：只在 active step 有问题时才出现；历史 completed 留痕缺失放到 notices
- 不展示无信息量的空面板

## 布局

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║ AutoGoo-Plugin Status  {task}                                           {done}/{total}  86% ║
╚══════════════════════════════════════════════════════════════════════════════════════╝
  ██████████████████████████░░░░  completed 12 · running 2 · ready 1 · waiting 1 · blocked 0 · failed 0 · slots 2/6
────────────────────────────────────────────────────────────────────────────────────────
Next: 等待执行中步骤完成；完成后下游步骤会解锁。

RUNNING (2)
▶  #6  gen_p6.py                       ██████░░░░░░░░░░  38% · output 150行 · hb 22s前
▶  #7  gen_p5.py                       ████░░░░░░░░░░░░  22% · output ... · hb 1min前

READY (1)
▷  #8  update_viewer.py                implementer · output docs/viewer.md

BLOCKED (1)
⏳  #9  小批量验证                      等待 gen_p6.py gen_p5.py

DONE (10)
  #1 schemas.py · #2 bbox_utils.py · #3 constraints.py · #4 annotation.py · #5 gen_p1.py
```

## 面板规则

### 顶部横幅

三行边框标题 + 一行总体状态。总体状态必须包含：

- 总进度条
- completed / running / ready / waiting / blocked / failed 数量
- slots `{running}/{max_concurrent}`

紧跟一行 `Next:`，用一句话说明下一步行动：
- 有告警 → 先处理告警
- 有 running → 等待运行中步骤完成
- 有 ready → 展示最多 3 个可立即执行步骤
- 只有 waiting → 等待依赖完成
- 只有 blocked → 等待主 Agent 前台处理权限或外部阻塞
- 全部完成 → 所有步骤已完成

### 执行中面板

只展示 status=running 的步骤，无则跳过此面板。

每行：`▶ {id} {name} {进度条} {progress}% · output {产物预览} · hb {heartbeat age}`

进度条宽 16 字符，百分比右对齐 3 字符。

产物预览：output 文件存在就显示行数，不存在显示 `...`

### Ready 面板

只展示 status=pending 且依赖全部完成的步骤，无则跳过。

每行：`▷ {id} {name} {subagent/type} · output {output}`

### Blocked 面板

只展示 status=pending 但依赖未完成的步骤，无则跳过。

每行：`⏳ {id} {name} 等待 {缺失依赖名，最多两个}`，超过两个加 `+{n}`。

### 已完成面板

status=completed 的步骤，紧凑横排，展示最近 6 个，多个用 `·` 分隔。超过 6 个时追加 `... earlier {n} completed`。

### 告警面板

只在有 failed / zombie / stuck / active step 缺日志时显示，一行一条：

```
⚠️ {name} {原因}
```

原因映射：
- zombie → `无心跳 {n}min，已死`
- stuck → `进度停滞 {n}min`
- failed → `失败，原因: {日志摘要}`
- completed 但产物缺失 → `产物 {path} 不存在`

### 留痕提示

只在当前 thread `logs/` 缺失、兼容 `.goo/logs/` 缺失或 completed step 找不到日志时显示，不改变 `Next:` 判断。

## 示例

```
/auto-goo:goo-status
```

输出：

```
══════════════════════════════════════════════════════════════
  v4 QA 生成系统重写  12/14  ████████████████░░  86%
══════════════════════════════════════════════════════════════

▶ gen_p6.py          ██████░░░░░░░░░░  38%  150行  剩余 ~3min
▶ gen_p5.py          ████░░░░░░░░░░░░  22%  100行  剩余 ~5min

⏳ update_viewer.py  就绪
⏳ 小批量验证         等待 gen_p6 gen_p5

✅ schemas.py 722行 · bbox_utils.py 304行 · constraints.py 260行
✅ annotation.py 492行 · gen_p1.py 885行 · gen_p2.py 755行
✅ gen_p3.py 722行 · gen_p4.py 1415行 · ... 等 3 步
```

# AutoGoo-Plugin

![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-blue)
![Codex](https://img.shields.io/badge/Codex-Compatible-purple)
![Version](https://img.shields.io/badge/version-0.5.1-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

AutoGoo-Plugin 是一个同时兼容 Claude Code 和 Codex 的智能体编排插件，用来把开放式任务拆成可执行计划、并行调用 subagent、记录运行状态，并把结果同步到 Goo-wiki / Obsidian。

![AutoGoo-Plugin workflow](docs/assets/autogoo-plugin-workflow.svg)

## 适合什么场景

- 复杂任务需要先规划、再执行、再验收。
- 多个独立步骤可以并行交给 subagent。
- 需要用 thread 隔离多条任务线，并在 plan 中保留清晰状态和续跑入口。
- 需要把研究、日报、周报、用量分析或 HTML 产物归档到 Goo-wiki。
- 需要固定交互模板，减少临时口头确认。

## 安装

### Claude Code

从 marketplace 安装：

```text
/plugin marketplace add ZixiGu/AutoGoo-Plugin
/plugin marketplace update
/plugin install autogoo-plugin@AutoGoo-Plugin --scope user
/reload-plugins
```

或从本地 checkout 安装：

```text
/plugin marketplace add /path/to/AutoGoo-Plugin
/plugin install autogoo-plugin@AutoGoo-Plugin --scope user
/reload-plugins
```

> `autogoo-plugin@AutoGoo-Plugin` 前半段来自 `.claude-plugin/plugin.json` 的 `name`，后半段来自 `.claude-plugin/marketplace.json` 的 `name`。更新旧版本用 `/plugin update autogoo-plugin`。

### Codex

```bash
# 1. 链接插件到标准路径
mkdir -p ~/plugins && ln -sf /path/to/AutoGoo-Plugin ~/plugins/autogoo-plugin

# 2. marketplace 条目名必须与安装 ID 一致，然后安装到 Codex
codex plugin add autogoo-plugin@personal
```

> 首次使用需确保 `~/.agents/plugins/marketplace.json` 已创建，且其中 `plugins[].name` 为 `autogoo-plugin`、source path 为 `./plugins/autogoo-plugin`。如果条目名使用 `auto-goo`，安装 ID 也必须对应使用 `auto-goo@personal`，两者不能混用。

### Pi Coding Agent

Pi Coding Agent 使用本地扩展方式安装，需要手动配置 `.pi/settings.json`。

**方法一：直接编辑配置文件**

在项目的 `.pi/settings.json` 中添加扩展路径：

```json
{
  "extensions": ["/path/to/AutoGoo-Plugin/.pi/extensions/autogoo-plugin/index.ts"]
}
```

**方法二：使用 pi CLI（如果支持）**

```bash
# 进入项目目录
cd /path/to/your/project

# 链接 AutoGoo-Plugin 扩展
pi extension add /path/to/AutoGoo-Plugin/.pi/extensions/autogoo-plugin
```

**方法三：全局配置**

在用户级 `~/.pi/settings.json` 中添加，所有项目可用：

```json
{
  "extensions": ["/path/to/AutoGoo-Plugin/.pi/extensions/autogoo-plugin/index.ts"]
}
```

> Pi 扩展版本：**v0.5.1**。使用 Pi 原生 API（`ctx.ui`、自定义工具、事件系统）。

## 在 Claude Code 中使用

通过 slash command 触发，命令前有 `/auto-goo:` 前缀。

### 快速开始

```text
/auto-goo:goo-init --user
/auto-goo:goo-init --project

/auto-goo:goo-plan "把当前项目整理成可执行发布计划"
/auto-goo:goo-start
/auto-goo:goo-status
/auto-goo:goo-continue
```

### 常用命令

| 命令 | 用途 |
| --- | --- |
| [`goo-init`](commands/goo-init.md) | 初始化 AutoGoo-Plugin 配置和目录。 |
| [`goo-brainstorm`](commands/goo-brainstorm.md) | 先发散方案，再让用户选择。 |
| [`goo-plan`](commands/goo-plan.md) | 生成 `.goo/plan.json` 执行计划。 |
| [`goo-start`](commands/goo-start.md) | 执行当前计划。 |
| [`goo-continue`](commands/goo-continue.md) | 从中断或阻塞状态继续。 |
| [`goo-status`](commands/goo-status.md) | 查看计划状态、日志和下一步。 |
| [`goo-observe`](commands/goo-observe.md) | 观察后台 subagent、shell 日志和 Agent View 入口。 |
| [`goo-publish`](commands/goo-publish.md) | 发布 HTML 工作流状态页。 |
| [`goo-research`](commands/goo-research.md) | 研究资料和论文归档。 |
| [`goo-usage`](commands/goo-usage.md) | 用量监控和降本分析。 |
| [`goo-daily-report`](commands/goo-daily-report.md) | 生成日报、周报或月报。 |
| [`goo-benchmark`](commands/goo-benchmark.md) | 记录任务质量基线。 |
| [`goo-improve`](commands/goo-improve.md) | 根据历史记录改进流程。 |

### 典型工作流

```
1. /auto-goo:goo-init --project           → 创建 .goo/config.json
2. /auto-goo:goo-plan "整理成可发布状态"    → 生成 .goo/plan.json
3. /auto-goo:goo-start                    → 按 DAG 并行/串行调度 subagent
4. /auto-goo:goo-status                   → 查看 plan 状态、日志、阻塞项
5. /auto-goo:goo-continue                 → 从中断处续跑
```

## 在 Codex 中使用

通过自然语言描述触发 AutoGoo-Plugin skill，不需要记忆命令名。

### 常用场景

| 你想做什么 | 在 Codex 中这样说 |
| --- | --- |
| 初始化配置 | `帮我初始化 AutoGoo-Plugin 用户级配置` |
| 发散方案 | `帮我对 <方向> 做 brainstorm` |
| 制定计划 | `帮我规划一下：<任务描述>` |
| 执行计划 | `开始执行当前计划` |
| 查看状态 | `当前计划进度怎么样？` |
| 继续任务 | `继续上次的任务` |
| 后台观察 | `观察一下后台 subagent 的状态` |
| 发布 HTML | `把当前工作流状态发布成 HTML 页面` |
| 研究归档 | `调研 <主题> 并归档到 Goo-wiki` |
| 用量分析 | `分析一下最近的 token 用量和成本` |
| 生成日报 | `生成今天的日报` |
| 流程改进 | `根据历史任务改进 AutoGoo-Plugin 流程` |

### 典型工作流

```
1. "帮我初始化 AutoGoo-Plugin 项目级配置"        → 创建 .goo/config.json
2. "帮我规划一下：把项目整理成可发布状态"  → 生成 .goo/plan.json
3. "开始执行"                             → 按 DAG 并行/串行调度 subagent
4. "看看进度"                             → 查看 plan 状态、日志、阻塞项
5. "继续"                                 → 从中断处续跑
```

## 在 Pi Coding Agent 中使用

通过 `/auto-goo:goo-xxx` 或 `/goo-xxx` 命令触发，由 Pi 扩展拦截并路由到对应 handler。

### 快速开始

```text
/goo-init
/goo-plan "把当前项目整理成可执行发布计划"
/goo-start
/goo-status
/goo-continue
```

### 与 Claude Code 版本的区别

Pi 扩展使用原生 API 注册 17 个自定义工具（`auto_goo_execute`、`auto_goo_dispatch`、`auto_goo_ssh_monitor`、`auto_goo_worktree_*` 等），所有平台差异封装在工具内部，model 不需要检测平台。支持 `ctx.ui.select/confirm/input` 作为用户交互，支持 `session_start`/`session_shutdown` hooks；worktree 不再在 session 退出时强制删除。

## 平台对比

| 功能 | Claude Code | Codex | Pi Coding Agent |
| --- | --- | --- | --- |
| 安装方式 | `/plugin install` | `codex plugin add` | `.pi/settings.json` |
| 命令触发 | `/auto-goo:goo-init` slash command | 自然语言，skill 自动匹配 | `/goo-xxx` 或 `/auto-goo:goo-xxx` |
| 用户交互 | `AskUserQuestion` | `request_user_input`（仅 Plan mode）或纯文本 fallback | `ctx.ui.select/confirm/input` |
| Subagent 派发 | `Agent` 工具 | `spawn_agent` + `wait_agent` | `pi.registerTool` 自定义工具 |
| Worktree 隔离 | 支持（`isolation: "worktree"`） | 不支持，自动降级 `mode="none"` | 支持（`auto_goo_worktree_*` 工具） |
| Hooks | `SessionStart` 等 | 不支持 | `session_start`/`session_shutdown` |
| 自定义工具 | 无（依赖平台工具） | 无（依赖平台工具） | 17 个注册工具 |
| 交互控件 | 方向键 + Enter | Plan mode 结构化 / Default mode 纯文本 | `ctx.ui` 原生控件 |

## 核心约定

- **Thread 状态**：每条任务线保存在 `.goo/threads/<thread_id>/`；兼容入口 `.goo/plan.json` 指向当前 thread 的 active plan。
- **计划状态**：plan 是任务执行的源头，步骤状态包括 `pending`、`running`、`completed`、`blocked`、`failed`。
- **用户确认**：涉及范围、方案、优先级或不可自动决定的选项时，优先用结构化选择 UI 的固定选项模板。
- **并行执行**：同层级且互不依赖的步骤会优先并行；串行依赖需要在计划里写明原因。
- **日志记录**：subagent 的过程信息写入当前 thread 的 `logs/`，前台只展示摘要、阻塞和下一步。
- **归档记忆**：默认写入 Goo-wiki；没有配置时回退到 `.goo/obsidian/`。
- **分析文档**：论文分析和代码分析必须生成独立 Markdown 并归档到 Goo-wiki；fallback 只作临时防丢失，不能视为归档完成。
- **安全边界**：敏感信息放在 `.goo/secrets.json` 或 `~/.auto-goo/secrets.json`，不要写入计划、日志或 HTML 发布页。
- **Web 修改请求**：`goo-publish --serve` 可在网页提交修改请求，落盘到 `.goo/change-requests/`，由 AutoGoo-Plugin 后续读取并让模型修改、审计。

## 配置

AutoGoo-Plugin 读取两级配置：

- 用户级：`~/.auto-goo/config.json`
- 项目级：`.goo/config.json`

常用配置项：

| 字段 | 用途 |
| --- | --- |
| `wiki_dir` | Goo-wiki / Obsidian 根目录。 |
| `archive` | 归档目录、回退目录和命名规则。 |
| `execution` | 并发数、超时、日志和 heartbeat 行为。 |
| `planning` | 默认执行模式、用户确认策略和计划细节级别。 |
| `publish` | HTML 状态页输出目录和可见字段。 |
| `servers` | 远程机器、角色、路径和连接策略。 |

推荐用 `goo-init` 生成默认配置，再按项目补充少量字段。完整字段说明见 [`references/setup.md`](skills/auto-goo/references/setup.md)。

## 目录

```text
AutoGoo-Plugin/
├── commands/                 # Claude Code slash command 文档
├── skills/auto-goo/           # 技能说明、脚本和 reference 文档
├── agents/                    # subagent 角色与任务模板
├── hooks/                     # 运行钩子
├── docs/                      # 架构、原型和发布说明
└── scripts/                   # 发布和校验脚本
```

运行时目录一般位于当前项目：

```text
.goo/
├── current_thread.json
├── threads/
├── change-requests/
├── locks/
├── plan.json
├── config.json
├── logs/
├── obsidian/
└── secrets.json
```

## 深入文档

| 主题 | 文档 |
| --- | --- |
| 安装和配置 | [`references/setup.md`](skills/auto-goo/references/setup.md) |
| 任务解析 | [`references/task-parsing.md`](skills/auto-goo/references/task-parsing.md) |
| 执行引擎 | [`references/execution-engine.md`](skills/auto-goo/references/execution-engine.md) |
| heartbeat 和日志 | [`references/heartbeat.md`](skills/auto-goo/references/heartbeat.md) |
| Goo-wiki 归档 | [`references/obsidian-archive.md`](skills/auto-goo/references/obsidian-archive.md) |
| 交互模板 | [`references/interaction-templates.md`](skills/auto-goo/references/interaction-templates.md) |
| subagent 架构 | [`docs/subagent-architecture.md`](docs/subagent-architecture.md) |
| 所有命令 | [`commands/`](commands/) |

## 校验

修改插件后运行：

```bash
bash skills/auto-goo/scripts/check-plugin.sh
```

发布前至少确认：

- manifest、命令、skill 文件存在。
- `.goo/plan.json` 和日志路径可正常生成。
- 版本号在 `README.md`、`pyproject.toml` 和 `.claude-plugin/plugin.json` 中一致。

## 运行要求

- Claude Code 或 Codex 环境。
- 本机可运行 `bash`、`python3`、`git`。
- 使用 Goo-wiki 时，需要配置 `wiki_dir` 或让 AutoGoo-Plugin 回退到 `.goo/obsidian/`。

## 版本

当前版本：**v0.5.1**。

## 许可证

MIT

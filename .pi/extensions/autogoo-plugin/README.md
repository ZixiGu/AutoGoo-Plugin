# AutoGoo-Plugin Pi 扩展

AutoGoo-Plugin 是一个 DAG 驱动的多智能体编排框架，已移植为 [Pi Coding Agent](https://pi.dev) 扩展。

任务自动解析为 DAG，按依赖关系并行/串行执行 Subagent，结果归档到 Goo-wiki。

## 安装

### 方式一：全局软链接

```bash
ln -sf /path/to/AutoGoo-Plugin/.pi/extensions/autogoo-plugin ~/.pi/agent/extensions/autogoo-plugin
```

### 方式二：pi install

```bash
pi install git:github.com/ZixiGu/AutoGoo-Plugin
# 或本地路径
pi install /path/to/AutoGoo-Plugin
```

### 方式三：项目自动发现

```bash
cd /path/to/AutoGoo-Plugin
pi  # 自动加载 .pi/extensions/autogoo-plugin/
```

## 快速开始

```bash
cd your-project
pi

# 在 Pi 交互环境中：
/goo-init              # 交互式初始化配置
/goo-plan 帮我重构XX   # 生成 DAG 计划
/goo-start              # 执行计划（自动调度 Subagent）
/goo-status             # 查看计划状态
/goo-publish --serve    # 发布 HTML 站点
```

## 命令（14 个）

支持 `/auto-goo:goo-xxx` 和 `/goo-xxx` 两种输入方式：

| 命令 | 用途 |
| --- | --- |
| `goo-init` | 交互式初始化 AutoGoo-Plugin 配置 |
| `goo-brainstorm` | 目标不明确时生成候选目标 |
| `goo-plan` | 生成 DAG 执行计划（含 wiki 召回） |
| `goo-start` | 执行当前 DAG 计划 |
| `goo-continue` | 恢复中断的执行 |
| `goo-status` | 查看 DAG 状态仪表盘 |
| `goo-observe` | 后台观察运行中的步骤 |
| `goo-publish` | 发布工作流为 HTML 站点 |
| `goo-research` | 启动研究任务 |
| `goo-usage` | 查看 token/usage 统计 |
| `goo-usage-analyse` | 分析 token 消耗并生成降本方案 |
| `goo-daily-report` | 生成日报/周报 |
| `goo-improve` | AutoGoo-Plugin 自改进审查 |
| `goo-benchmark` | 启动性能评测与优化迭代 |

## 自定义工具（17 个）

LLM 在执行 DAG 时可调用的工具：

| 工具 | 用途 |
| --- | --- |
| `auto_goo_execute` | DAG 自动调度引擎（6 槽位并发） |
| `auto_goo_update_step` | 更新步骤状态/进度/心跳 |
| `auto_goo_dispatch` | 派发 Subagent |
| `auto_goo_prepare_dispatch` | 派发前准备（start + 预创建 log） |
| `auto_goo_dag_status` | 查看 DAG 状态仪表盘 |
| `auto_goo_pending_steps` | 查看就绪的可执行步骤 |
| `auto_goo_shell` | 安全执行 shell 命令 |
| `auto_goo_ask_user` | 结构化用户交互（替代 AskUserQuestion） |
| `auto_goo_ssh_exec` | SSH 远程执行命令 |
| `auto_goo_ssh_monitor` | SSH 跟随监视（训练进度/日志/GPU，窗口流式） |
| `auto_goo_ssh_monitor_bg` | SSH 后台监视（不阻塞，可并行做其他任务） |
| `auto_goo_ssh_monitor_poll` | 查询后台监视状态与累积输出 |
| `auto_goo_ssh_monitor_stop` | 终止后台监视 |
| `auto_goo_ssh_status` | 检查远程服务器连通性和资源 |
| `auto_goo_worktree_create` | 创建 Git worktree 执行隔离 |
| `auto_goo_worktree_merge` | 合并 worktree 改动回主分支 |
| `auto_goo_worktree_cleanup` | 清理所有 AutoGoo-Plugin worktree |

## 状态栏说明

Pi 底部状态栏会持续显示 DAG 执行进度：

```
[████░░░░░░] 40% 2/5 ▶1 ○1 ⊘1
```

| 符号 | 含义 |
|------|------|
| `07-17 07:18` | thread 创建时间（月-日 时:分），后面跟任务名 |
| `⌛5m` | 执行用时（秒/分/小时），完成后显示总耗时 |
| `[███░]` | 进度条（█ = 完成，░ = 未完成） |
| `40%` | 完成百分比 |
| `2/5` | 已完成 / 总步骤数 |
| `▶1` | 运行中的步骤数 |
| `○1` | 待执行的步骤数 |
| `⊘1` | 阻塞的步骤数 |
| `✕1` | 失败的步骤数 |
| `⚠HB2` | 心跳过期的步骤数 |

## 与 Claude Code 版本差异

| 功能 | Claude Code | Pi |
| --- | --- | --- |
| 命令触发 | `/auto-goo:goo-xxx` | `/auto-goo:goo-xxx` 或 `/goo-xxx` |
| 用户交互 | `AskUserQuestion` | `ctx.ui.select/confirm/input`（原生 TUI 控件） |
| Subagent 派发 | `Agent` 工具 | `auto_goo_dispatch` 自定义工具 |
| 交互模板 | `references/interaction-templates.md` | 内联在 TypeScript `constants.ts` |
| 外部脚本 | 通过 bash 调用 | 通过 `execPython`/`execBash` 封装 |
| 执行引擎 | SKILL.md 人工编排 | `auto_goo_execute` 自动调度工具 |
| 远程执行 | 通过 `goo-ssh.sh` | 同上 + `auto_goo_ssh_*` 工具封装 |
| Worktree 隔离 | 手动管理 | `auto_goo_worktree_*` 工具自动管理 |

## 目录结构

```
.pi/extensions/autogoo-plugin/
├── index.ts              # 主入口
├── package.json          # Pi 包元数据
├── types.ts              # 共享类型
├── constants.ts          # 交互模板 + 角色提示
├── commands/             # 命令处理器（14 个）
│   ├── init.ts
│   ├── brainstorm.ts
│   ├── plan.ts
│   ├── start.ts
│   └── other.ts
├── tools/                # 自定义工具（3 模块）
│   ├── execute.ts        # DAG 自动调度引擎
│   ├── ssh.ts            # 远程服务器集成
│   └── worktree.ts       # Git worktree 隔离
└── utils/
    ├── exec.ts           # 统一命令执行
    ├── paths.ts          # 路径解析
    ├── plan.ts           # Plan 读写
    ├── status.ts         # 状态栏管理
    └── ui.ts             # UI 适配层
```

## 许可证

MIT

# AutoGoo-Plugin 环境设置

## Goo-wiki Obsidian Vault

Goo-wiki 是归档笔记的目标 Obsidian vault。插件在运行时通过文件存在性检测 vault 是否可用。

**非 Git 项目支持**：AutoGoo-Plugin 完全支持非 Git 项目。所有 Git 相关功能（如记录 remote 地址）都是可选的，仅在项目是 Git repo 时启用。非 Git 项目不会收到任何 Git 相关的错误或警告。

**推荐初始化命令**：

```text
/auto-goo:goo-init
```

该命令支持用户级和项目级配置：

- `/auto-goo:goo-init --user` → `~/.auto-goo/config.json`
- `/auto-goo:goo-init --project` → `.goo/config.json`；自动创建或复用 Goo-wiki 与 `wiki/projects/<project-slug>/` 项目归档根目录，并询问是否更新项目 `CLAUDE.md` 的归档原则段落

初始化采用主 Agent 交互模式：主 Agent 先通过 `AskUserQuestion` / 结构化选择 UI 确认作用域、wiki 路径、是否创建业务项目目录、创建后是否写入 `CLAUDE.md`、覆盖风险和项目 `CLAUDE.md` 更新意愿，让 Claude Code 渲染可用方向键移动、Enter 确认的选择控件，再调用脚本落盘。每个交互问题必须展示可选项；不得在 `AskUserQuestion` 可用时用普通文本要求用户手打 `1/2` 或命令参数。结构化选择 UI / AskUserQuestion 不可用、调用失败或没有渲染出按钮时，才允许降级为明确标注 fallback 的纯文本列表选项，继续收集用户选择。

业务项目目录结构也属于主 Agent 交互，不允许只依赖脚本里的 Bash prompt。项目级初始化必须复用 `references/interaction-templates.md` 中的固定模板：`id=project_workspace_create` 询问是否创建，`id=project_workspace_layout` 询问模板或自定义目录，创建后用 `id=project_workspace_claude_md` 询问是否写入项目 `CLAUDE.md`。用户未明确选择前不得创建业务目录；选择自定义目录时，主 Agent 必须复述并确认 Other 输入后再传给 `--project-dirs`。

业务目录创建后，如果项目根目录已经有内容，主 Agent 必须只读扫描并排除 `.goo/`、`.git/`、`.claude/`、已创建业务目录、secrets、锁文件和隐藏配置。发现可归类到 `src/`、`data/`、`docs/`、`scripts/`、`configs/`、`tests/` 等业务路径的现有内容时，必须先复用 `id=project_workspace_organize_existing` 模板询问是否生成整理方案；默认不整理。用户选择生成方案后，只展示移动建议，不直接移动；清单必须包含源路径、目标路径、归类理由、冲突/覆盖风险和跳过项。随后必须复用 `id=project_workspace_apply_organization` 模板二次确认，只有用户选择执行后才允许按清单移动；遇到目标已存在、敏感文件、不确定归类或批量大文件时停止并重新确认。脚本默认只创建目录，不自动整理已有内容。

底层写入仍由初始化脚本完成，但只有在用户已确认所有参数后才运行脚本。命令文档不得在交互前执行 root 解析；不得内联 heredoc / file redirection 的 Python 片段。最终落盘阶段先通过插件内置 root resolver 取得 AutoGoo-Plugin 根目录，再运行 `skills/auto-goo/scripts/goo-init.sh --user|--project --wiki-dir <已确认路径> ...`。如果用户配置远程服务器，主 Agent 把非敏感参数追加为可重复的 `--server 'name=<别名>,host=<ssh-host-or-ip>,user=<user>,port=<port>,type=<cpu|gpu>,purpose=<用途>'`；密码不得作为参数传入。

主 Agent 应优先自己提问，而不是要求用户进入 Bash 交互。必须先用 `AskUserQuestion` 问用户作用域和 wiki 路径，并在问题中展示默认路径 `~/workspace/Goo-wiki`；用户不输入路径时使用默认路径。随后显式传入 `--user/--project` 与 `--wiki-dir <路径>`；不得默认写入项目配置，也不得在未展示默认路径的情况下静默使用默认 wiki 路径。

第一个问题必须优先通过 `AskUserQuestion` 提供完整可见选项：

- 项目级 `--project` (Recommended) - 写入当前项目 `.goo/config.json`
- 用户级 `--user` - 写入 `~/.auto-goo/config.json`

如果交互控件不可用，使用以下纯文本 fallback：

```text
这是 fallback：结构化选择 UI 不可用。请选择配置作用域：
1. 项目级 --project (Recommended) - 写入当前项目 .goo/config.json
2. 用户级 --user - 写入 ~/.auto-goo/config.json

请回复 1/2，或直接回复“项目级”/“用户级”。
```

第二个问题必须优先通过 `AskUserQuestion` 提供完整可见选项：

- `~/workspace/Goo-wiki` (Recommended)
- 自定义路径（选择后在 Other 输入）

如果交互控件不可用，使用以下纯文本 fallback：

```text
这是 fallback：结构化选择 UI 不可用。请选择 Goo-wiki 路径：
1. ~/workspace/Goo-wiki (Recommended)
2. 自定义路径

请回复 1/2；如果选择自定义路径，请直接写完整路径。
```

如果用户确认或输入的 Goo-wiki 路径不存在，初始化脚本必须自动创建该目录，并补齐 `CLAUDE.md`、`log.md`、`wiki/projects/`、`wiki/concepts/`、`wiki/questions/`、`journal/daily/`、`journal/weekly/` 基础结构。路径不存在不是 fallback 条件；只有创建失败、权限不足或后续归档时 wiki 不可写，才使用 `.goo/obsidian/` fallback。

预检查只能作为交互辅助，不得打断初始化。检查现有 `.goo/config.json`、`.goo/`、git remote、wiki 文件等状态时，每个可能失败的命令都必须独立容错，例如 `ls .goo/config.json 2>/dev/null || true`、`git remote -v 2>/dev/null || true`。如果可选探测失败，只提示"未检测到/暂不可用"，继续询问用户。

**路径解析优先级**：

1. 环境变量 `AUTOGOO_PLUGIN_WIKI_DIR`
2. 当前项目 `.goo/config.json` 中的 `wiki_dir`
3. 用户级 `~/.auto-goo/config.json` 中的 `wiki_dir`
4. 默认路径 `~/workspace/Goo-wiki`
5. fallback 归档目录 `.goo/obsidian/`

**默认检测路径**：

```
~/workspace/Goo-wiki/CLAUDE.md
```

各项目通过 `/auto-goo:goo-init` 创建或检测 vault。vault 可用时归档到 `Goo-wiki/wiki/`，后续运行时如果 wiki 不可用才降级为 `.goo/obsidian/` fallback。

## 项目归档根路径

项目级初始化使用 Goo-wiki 时，AutoGoo-Plugin 会创建或复用项目归档根目录：

```text
<wiki_dir>/wiki/projects/<project-slug>/
```

`project-slug` 默认由项目根目录名生成，也可以通过 `--project-slug <slug>` 指定。项目 `.goo/config.json` 会记录：

- `archive.project_slug`
- `archive.project_dir`，例如 `wiki/projects/<project-slug>`
- `archive.fallback_project_dir`，例如 `.goo/obsidian/<project-slug>`
- `archive.git_remote_url`（仅当项目是 Git repo 且能读取 remote 时）

如果当前项目是 Git repo，初始化时还会读取 `origin` remote（没有 origin 时读取第一个 remote），并将地址写入 `<wiki_dir>/wiki/projects/<project-slug>/<project-slug>.md` 的 `AUTOGOO-PLUGIN-PROJECT-META` marker 块。该信息用于后续任务归档、迁移、复现和项目溯源；Recorder 写项目页或任务总览时也应保留该 git 地址。

Recorder 和归档步骤应优先写入 `archive.project_dir`，Goo-wiki 不可用时再写入 `archive.fallback_project_dir`。

## 项目 CLAUDE.md 归档原则

项目级初始化如果创建了业务项目目录结构，AutoGoo-Plugin 必须继续用 `AskUserQuestion` 复用 `id=project_workspace_claude_md` 模板，询问是否在项目根目录 `CLAUDE.md` 中写入目录约定。用户同意时，`AUTOGOO-PLUGIN-WIKI-ARCHIVE` marker 段会包含 `## 项目目录约定`，记录：

- `project_workspace.layout` 和目录清单
- `src/`、`data/raw/`、`data/processed/`、`references/`、`references/papers/`、`docs/`、`configs/`、`outputs/` 等目录语义
- 原始数据只读、处理数据和输出目录分离、`.goo/` 只存 AutoGoo-Plugin 状态的边界
- 后续 plan 的 `allowed_read_paths` / `allowed_write_paths` 应优先落在业务目录或明确的 `.goo/` 状态目录中

项目级初始化使用 Goo-wiki 时，AutoGoo-Plugin 还会询问用户是否在项目根目录 `CLAUDE.md` 中追加或更新由 `AUTOGOO-PLUGIN-WIKI-ARCHIVE` marker 包裹的归档原则段落。该段落要求：

- 规划前先派发 `collector`（wiki-gatherer）从 Goo-wiki 召回相关项目经验、概念页、周报和 `log.md`，并消费其 evidence packet
- `goo-plan` 的 `.goo/plan.json` 最后保留 `归档到 Goo-wiki` 步骤
- 执行后归档目标、计划、证据、产物路径、验证结果、决策、问题处理和可复用经验
- 模型摘要只作阅读入口；同时保存 `execution/record.md` 详细事实记录和 `execution/evidence-index.md` 来源覆盖表，小型安全文本证据原样保留，大型/二进制产物记录路径、大小和可取得时的校验值
- 任何产生可复用内容的命令最终都必须归档到 Goo-wiki 或 `.goo/obsidian/` fallback；不得只写 `.goo/*.json` 或只在聊天中展示。适用内容包括 usage/token 降本分析、日报/周报、改进建议、benchmark 指标和执行经验。brainstorm 候选目标与 plan 摘要必须先给用户审阅，确认后或进入执行前再归档最终版
- 日报/周报请求通过 `/auto-goo:goo-daily-report` 沉淀到 Goo-wiki `journal/daily/` 并更新 `log.md`；同日日报已存在时只追加新增内容，不整体覆盖已有人工整理
- 如果项目是 Git repo，将 git remote 地址写入 Goo-wiki 项目页或任务总览笔记
- Goo-wiki 不可用时写入 `.goo/obsidian/` fallback
- 归档完成前必须验收 Markdown 连接图谱：任务页链接项目入口、复用知识、上下文材料和关键概念/问题/指标/历史任务页；项目 `<project-slug>.md` 与 `log.md` 反向链接任务页；新增 concept/lessons/metrics 页面链接回任务页或项目入口
- 归档完成前必须验收来源覆盖：plan、每个 step log、artifacts、reports 和 context artifacts 均已收录、仅索引、标记不可用或明确脱敏，不得静默遗漏失败、重试和未验证项
- 归档内容必须服务下一次任务复用，而不是只做事后报告
- 论文分析和代码分析产生的独立 Markdown 分析文档必须实际进入 Goo-wiki，并更新项目入口与 `log.md`；fallback 只作临时防丢失，状态保持 `pending_wiki_sync`/`failed`

该更新是幂等的，只替换 AutoGoo-Plugin marker 内的内容，不覆盖项目已有指引。配置远程服务器时，项目级 init 默认更新 `CLAUDE.md` 中的服务器概要和安全约束；远程 `workdir`、`setup_commands`、数据目录和产物目录细节仍只写 `.goo/config.json`。非交互场景没有远程服务器时默认不写，需传 `--update-claude-md` 明确写入目录约定和归档原则；需要跳过所有 `CLAUDE.md` 更新时传 `--skip-claude-md`。

如果项目配置了远程服务器，AutoGoo-Plugin marker 块还会写入：

- 远程服务器表格：名称、host、端口、用户名、类型、用途、secrets 来源
- `### 何时使用`：按 `purpose` 或服务器类型说明 CPU/GPU 服务器适用场景
- 远程执行约束：AutoGoo-Plugin 工具读取 `.goo/config.json` 与 `.goo/secrets.json`，执行任务时必须显式选择目标服务器，不依赖默认第一个
- secrets 约束：不得把密码展开到命令行、日志、计划正文或 subagent prompt

## 配置文件

用户级配置适合统一 wiki 路径和默认执行偏好；项目级配置适合覆盖单个 repo 的并发、归档或 wiki 设置。两者结构相同。

`~/.auto-goo/config.json` 或 `.goo/config.json` 示例：

```json
{
  "version": 1,
  "wiki_dir": "~/workspace/Goo-wiki",
  "wiki": {
    "search_paths": [
      "wiki/projects",
      "wiki/concepts",
      "journal/weekly",
      "log.md"
    ]
  },
  "archive": {
    "enabled": true,
    "fallback_dir": ".goo/obsidian",
    "plan_history_dir": ".goo/plans/history",
    "brainstorm_history_dir": ".goo/brainstorms/history",
    "project_slug": "<project-slug>",
    "project_dir": "wiki/projects/<project-slug>",
    "fallback_project_dir": ".goo/obsidian/<project-slug>",
    "git_remote_url": "https://github.com/<owner>/<repo>.git"
  },
  "workspace": {
    "root": ".goo",
    "layout": "standard",
    "paths": {
      "threads_dir": ".goo/threads",
      "current_thread_file": ".goo/current_thread.json",
      "compat_plan_file": ".goo/plan.json",
      "compat_brainstorm_file": ".goo/brainstorm.json",
      "plans_history_dir": ".goo/plans/history",
      "brainstorms_history_dir": ".goo/brainstorms/history",
      "logs_dir": ".goo/logs",
      "artifacts_dir": ".goo/artifacts",
      "reports_dir": ".goo/reports",
      "locks_dir": ".goo/locks",
      "change_requests_dir": ".goo/change-requests",
      "obsidian_dir": ".goo/obsidian",
      "site_dir": ".goo/site"
    }
  },
  "project_workspace": {
    "layout": "ml",
    "dirs": [
      "src",
      "configs",
      "scripts",
      "notebooks",
      "data/raw",
      "data/processed",
      "models",
      "outputs",
      "reports",
      "docs",
      "tests"
    ]
  },
  "publish": {
    "enabled": true,
    "site_dir": ".goo/site",
    "index_file": ".goo/site/index.html",
    "host": "127.0.0.1",
    "port": 9877,
    "open_browser": true,
    "include_workflow_activity": true,
    "include_dag": true
  },
  "execution": {
    "max_concurrent": 6,
    "heartbeat_seconds": 30,
    "stale_after_seconds": 120,
    "subagent_model": "",
    "subagent_provider": ""
  },
  "planning": {
    "recall_wiki": true,
    "require_wiki_context": false
  },
  "init": {
    "prompt_for_scope": true,
    "prompt_for_wiki_dir": true
  },
  "servers": [
    {
      "ip": "192.168.1.100",
      "port": 22,
      "user": "ubuntu",
      "type": "cpu",
      "purpose": "数据预处理与模型评测",
      "secrets_file": ".goo/secrets.json"
    },
    {
      "ip": "192.168.1.101",
      "port": 2222,
      "user": "ubuntu",
      "type": "gpu",
      "purpose": "模型训练与推理",
      "secrets_file": ".goo/secrets.json"
    }
  ]
}
```

### 执行配置（`execution`）

| 字段 | 说明 |
|---|---|
| `max_concurrent` | 并发 Subagent 槽位数（默认 6） |
| `heartbeat_seconds` | Subagent 心跳间隔秒数（默认 30） |
| `stale_after_seconds` | 超过此秒数无心跳判定为 stale（默认 120） |
| `subagent_model` | **Subagent 子进程显式模型**（默认空=直接用主 agent 的模型，见下方实测结论）。必须与 `subagent_provider` 成对设置——模型 id 常跨多个已认证 provider（如 `deepseek-v4-flash` 同时存在于 deepseek/opencode-go/opencode/yj 等），单独传 `--model` 会报 `Model ambiguous across providers`。 |
| `subagent_provider` | **Subagent 子进程显式 provider**（默认空=直接用主 agent 的 provider）。与 `subagent_model` 配对，必须同时设置。 |

> 派发实现：`runSubagent`（`.pi/extensions/autogoo-plugin/utils/subagent.ts`）只在显式传入时才追加 `--provider` / `--model`；`auto_goo_dispatch` 与 `auto_goo_execute`（runSchedule）已读取 `config.execution.subagent_model` / `subagent_provider` 并透传。

**默认值实测结论**（2026-08-18）：空/不设时 Subagent **直接用主 agent 的模型（动态解析，不固定到某个具体型号）**——`resolveSubagentModel` 依序取 `config.execution.subagent_*` → `ctx.model`（会话真实模型，主 agent 用哪个就跟随哪个）→ `PI_*` 环境变量，把结果显式转成 `--provider`/`--model` flag 传给子进程（pi 忽略环境变量、只认 flag，不传 flag 会按 `defaultProvider`(=yj) 误解析为 `deepseek-v4-pro`，与主会话不一致）。**全缺 / 未配置时触发用户交互**：派发 encounter 到未配置的 Subagent 模型时，`auto_goo_dispatch` / `auto_goo_execute` 会用结构化 UI 询问是否配置（用主 agent 当前模型写入 config / 手动输入 provider+model / 不配置自动跟随本进程不再问 / 取消本次派发）；用户选「不配置」后本进程自动跟随主 agent 模型，不再逐 step 弹窗；用户取消则 step 保持 blocked，绝不静默回退 pi 全局默认。显式配置优先于 ctx.model 与 env。

`goo-init` 支持指定业务项目目录结构。项目级初始化必须先用 `AskUserQuestion` 复用 `id=project_workspace_create` 询问是否创建；默认不创建。用户选择创建后，再复用 `id=project_workspace_layout` 询问模板或自定义目录，才传 `--project-layout` 或 `--project-dirs`。AutoGoo-Plugin 自身状态目录固定在项目 `.goo/`，不要把它改成项目代码/数据目录。业务目录可以包含 `references/` 与 `references/papers/`，用于参考资料、论文、规范、paper PDF、arXiv/DOI 元数据和阅读材料；这些资料属于项目业务上下文，不属于 AutoGoo-Plugin 运行态 `.goo/`。

```bash
bash "$auto_goo_root/skills/auto-goo/scripts/goo-init.sh" --project \
  --wiki-dir ~/workspace/Goo-wiki \
  --project-layout ml
```

内置模板：
- `standard`: `src`, `tests`, `docs`, `references`, `references/papers`, `scripts`, `data`, `artifacts`
- `ml`: `src`, `configs`, `scripts`, `notebooks`, `references`, `references/papers`, `data/raw`, `data/processed`, `data/external`, `models`, `outputs`, `reports`, `docs`, `tests`
- `data`: `src`, `scripts`, `notebooks`, `references`, `references/papers`, `data/raw`, `data/interim`, `data/processed`, `data/external`, `reports`, `docs`, `tests`
- `docs`: `docs`, `docs/adr`, `docs/assets`, `references`, `references/papers`, `scripts`, `src`, `tests`

也可以用 `--project-dirs src,data/raw,docs,references/papers` 传入自定义目录；脚本会写入 `.goo/config.json.project_workspace` 并创建对应目录。默认 `project_workspace.layout="none"`，不创建业务目录，避免污染已有项目。业务目录创建后，如根目录已有可归类内容，必须先用 `id=project_workspace_organize_existing` 询问是否生成整理方案，再用 `id=project_workspace_apply_organization` 二次确认是否执行移动；默认不移动任何已有内容。之后必须继续复用 `id=project_workspace_claude_md` 询问是否把目录约定写入项目 `CLAUDE.md`。

### 远程服务器配置

初始化时可以配置远程服务器（算力服务器、普通服务器等）。密码存储在独立的 secrets 文件中，不在 config.json 里保存：

| 作用域 | config 路径 | secrets 路径 |
| --- | --- | --- |
| `--user` | `~/.auto-goo/config.json` | `~/.auto-goo/secrets.json` |
| `--project` | `.goo/config.json` | `.goo/secrets.json` |

secrets 文件权限为 `chmod 600`，项目级 secrets 文件自动加入 `.gitignore`。

config 中记录 `servers[].{name, host, ip?, port, user, type, purpose, defaults?, secrets_file}`，不存储密码。`name` 是给模型、plan 和 `remote_server` 使用的稳定名称；`host` 是 SSH 连接地址，可以是 DNS 名、SSH config Host 或 IP；`ip` 仅作为兼容字段可选。使用服务器时，从 `secrets_file` 读取密码。`port` 默认 22，`type` 为 `cpu` 或 `gpu`，默认 `cpu`。`purpose` 为服务器用途说明，用于 CLAUDE.md 中告知何时使用该服务器。

`servers[].defaults` 用于记录远程机器上的非敏感默认环境约定：

- `workdir`：默认进入的远程工作目录，例如 `/home/ubuntu/projects/<project-slug>`
- `setup_commands[]`：执行任务前需要运行的环境初始化命令，例如 `source ~/miniconda3/etc/profile.d/conda.sh`、`conda activate train-env`
- `paths.data_dir`：默认远程数据目录
- `paths.artifacts_dir`：默认远程产物或输出目录

这些字段会进入 plan 和 Subagent prompt，必须只写非敏感命令和路径。不要把 token、API key、私钥、密码、带凭据的 `export` 命令或私有 registry 凭据写入 `defaults`；这类信息应留在远程机器自身环境或 secrets 文件中，并且不得展开到日志、命令行、plan 或 prompt。

非交互初始化示例：

```bash
bash "$auto_goo_root/skills/auto-goo/scripts/goo-init.sh" --project --wiki-dir ~/workspace/Goo-wiki \
  --server 'name=gpu-a100,host=gpu-a100,user=ubuntu,port=22,type=gpu,purpose=模型训练与推理,workdir=/home/ubuntu/projects/demo,setup=source ~/miniconda3/etc/profile.d/conda.sh;conda activate train-env,data_dir=/mnt/data/demo,artifacts_dir=/mnt/outputs/demo'
```

该命令只写入非敏感配置，并创建 chmod 600 的 secrets 占位文件。用户需要稍后手动编辑 `.goo/secrets.json` 或 `~/.auto-goo/secrets.json` 填入密码；不得在聊天、计划、命令行或日志里展开密码。

初始化阶段如果用户配置了服务器，脚本会检查本机是否安装 `sshpass`。未安装时只提醒用户：

```bash
sudo apt install sshpass
```

不会自动安装，也不会中断初始化。`sshpass` 只在 secrets 中存在 password 且需要自动填密码时使用；如果 secrets 里没有密码，`goo-ssh.sh` 会退回普通 `ssh`，支持 SSH key 或手动认证；非交互环境会使用 `BatchMode=yes` 避免卡在密码提示。自动连接脚本支持按服务器名称、index 或 host 选择。使用时先通过插件内置 root resolver 取得 AutoGoo-Plugin 根目录，再运行 `skills/auto-goo/scripts/goo-ssh.sh`，例如传入 `--server gpu-a100`、`--server <host-or-ip>`、`--server <host-or-ip>:<port>`、`--server <user>@<host-or-ip>:<port>`，或传入 `--host <host-or-ip> --user <user> --port <port>`。

注意：setup 文档不内联 root 解析 heredoc，避免 slash command 在交互前误执行 Bash。

### 自定义路径

可以用环境变量覆盖 wiki 路径：

```bash
export AUTOGOO_PLUGIN_WIKI_DIR="$HOME/workspace/Goo-wiki"
```

也可以在项目 `.claude/settings.json` 的 SessionStart hook 中修改检测命令：

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "ls <你的路径>/CLAUDE.md >/dev/null 2>&1 && echo '✓ Goo-wiki vault ready' || echo '⚠ Goo-wiki not found'"
      }]
    }]
  }
}
```

## 推荐 SessionStart hooks

以下 hooks 在每个会话启动时执行，建议加入项目 `.claude/settings.json`：

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [
        {
          "type": "command",
          "command": "ls ~/workspace/Goo-wiki/CLAUDE.md >/dev/null 2>&1 && echo '✓ Goo-wiki vault ready' || echo '⚠ Goo-wiki not found — 使用 .goo/obsidian/ fallback'"
        },
        {
          "type": "command",
          "command": "cat .goo/plan.json 2>/dev/null && echo '⚠ 发现未完成任务，输入 /auto-goo:goo-continue 可继续执行' || true"
        }
      ]
    }]
  }
}
```

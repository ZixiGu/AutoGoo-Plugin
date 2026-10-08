---
name: auto-goo:goo-init
description: 初始化 AutoGoo-Plugin 配置 — 支持用户级 ~/.auto-goo/config.json 和项目级 .goo/config.json
---

# /auto-goo:goo-init — 初始化配置

第一次使用 AutoGoo-Plugin 时，可以初始化用户级默认配置；在具体项目里也可以初始化项目级覆盖配置。

**非 Git 项目**：完全支持。Git remote 地址记录是可选功能，仅在项目是 Git repo 时自动启用。

```text
/auto-goo:goo-init
```

## 作用域

| 命令 | 写入位置 | 产出 | 用途 |
| --- | --- | --- | --- |
| `/auto-goo:goo-init --user` | `~/.auto-goo/config.json` | `~/.auto-goo/goo.md`（总是生成，除非 `--skip-claude-md`）+ 用户级指针 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md` | 当前用户的全局默认配置，也是默认的约定单源，适合统一 wiki 路径和执行偏好 |
| `/auto-goo:goo-init --project` | `.goo/config.json` | 按需 `<项目根>/goo.md` + 项目级指针 `<项目根>/CLAUDE.md`、`<项目根>/AGENTS.md` | 当前项目的局部覆盖配置；仅有项目专属内容或显式 `--update-claude-md` 时才生成项目 `goo.md`，否则沿用用户级 |
| `/auto-goo:goo-init` | 交互提问 | 取决于所选作用域 | 先询问配置到用户级还是项目级，再继续询问 wiki 路径 |

## 用户级 goo.md 与优先级

AutoGoo-Plugin 的完整项目约定（归档原则、目录语义、服务器使用约定）统一写入 `goo.md`，正文只有一处，避免每个项目重复构建：

| 层级 | goo.md 路径 | 指针文件（`AUTOGOO-PLUGIN-POINTER` marker 段） | 生成条件 |
| --- | --- | --- | --- |
| 用户级 | `~/.auto-goo/goo.md` | `~/.claude/CLAUDE.md`（Claude Code）、`~/.codex/AGENTS.md`（Codex） | `--user` 时**总是**生成，除非显式传 `--skip-claude-md`；指针默认写，由 `--write-user-pointer` / `--skip-user-pointer` 控制 |
| 项目级 | `<项目根>/goo.md` | `<项目根>/CLAUDE.md`（Claude Code）、`<项目根>/AGENTS.md`（Codex） | 仅当有项目专属内容（`project_workspace` 业务目录约定或 `servers`）**或**显式传 `--update-claude-md` 时生成；否则沿用用户级 `~/.auto-goo/goo.md`，并提示「project goo.md not needed」 |

**优先级**：项目级 `<项目根>/goo.md` > 用户级 `~/.auto-goo/goo.md`。指针文案声明该优先级，模型读取约定时先看项目级，项目级缺失才回退用户级。

**幂等与 marker**：`goo.md` 正文用 `AUTOGOO-PLUGIN-WIKI-ARCHIVE-BEGIN/END` 包裹，指针用 `AUTOGOO-PLUGIN-POINTER-BEGIN/END` 包裹。重复初始化会先删除已存在的完整块和悬挂单边 marker，再只追加一份；只替换 marker 段，不改段外用户内容。

**相关参数**：

- `--write-user-pointer` / `--skip-user-pointer`：显式控制用户级指针（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`）是否写入；两者互斥，同时传入时脚本以 `exit 2` 拒绝。
- `--agent claude|codex|both`：选择指针目标，默认 `both`；非法值以 `exit 2` 拒绝。
- `--skip-claude-md`：同时跳过 `goo.md` 正文与指针更新，用户级和项目级都生效；`--update-claude-md` 与之互斥。
- `--update-claude-md`：显式要求写入项目级 `goo.md` 与项目指针（即使没有项目专属内容）。

**三条 CLAUDE.md 必须区分**：

1. `$wiki_dir/CLAUDE.md`：Goo-wiki vault 自身的说明文件，由 vault 初始化补齐，不是 agent 约定文件。
2. `~/.claude/CLAUDE.md`：用户级 agent 约定，只放指向 `~/.auto-goo/goo.md` 的 marker 指针。
3. `<项目根>/CLAUDE.md`：项目级 agent 约定，只放指向项目级或用户级 `goo.md` 的 marker 指针。

## 行为

该命令使用 **Agent 交互模式 + 脚本落盘**：

- 主 Agent 收到命令后必须先交互提问，不预先检查环境，不先运行 Bash，不先解析 AutoGoo-Plugin root。
- 所有缺失参数收集完成后，才进入脚本落盘阶段；脚本内部自行处理已有配置的检测和覆盖确认。
- slash command 的当前工作目录通常是用户项目，不一定是插件目录；最终落盘前必须从 Claude Code 安装记录解析 AutoGoo-Plugin 根目录，不能拼出 `/skills/...`。
- 禁止在命令正文中直接执行含 heredoc / file redirection 的 root 解析片段。需要解析 root 时，使用插件内置 `skills/auto-goo/scripts/resolve-root.sh`，或等价的无 heredoc 命令封装。

用户没有在命令里显式给出参数时，主 Agent 至少先问两个问题：

1. 配置作用域：`--user` 还是 `--project`
2. Goo-wiki 路径：向用户展示默认路径 `~/workspace/Goo-wiki`；用户不输入或选择默认时就使用该路径，也可输入自定义路径
3. 业务项目目录结构：项目级初始化时必须先问是否创建；默认不创建。用户选择创建时，再让用户选择 `--project-layout standard|ml|data|docs`，或用 `--project-dirs src,data/raw,docs,references/papers` 指定代码、数据、文档、参考资料和论文等目录。AutoGoo-Plugin 自身运行态目录固定在项目 `.goo/` 下。业务目录创建完成后，继续询问是否把目录约定写入项目级指针 `CLAUDE.md`（`<项目根>/CLAUDE.md`；用户级初始化对应 `~/.claude/CLAUDE.md`）。

项目级初始化时，还应通过 `AskUserQuestion` 确认是否更新项目级指针 `CLAUDE.md`（`<项目根>/CLAUDE.md`）；如果用户创建了业务项目目录结构，必须先单独询问是否把目录约定写入项目级 `goo.md` 与对应指针。需要远程服务器配置时，由主 Agent 通过 `AskUserQuestion` 逐字段收集，每个问题提供 2 个选项（一个推荐默认值 + 一个常用备选），用户可通过系统自动提供的 "Other" 选项输入自定义值。服务器非敏感参数（类型、名称/别名、SSH host/IP/DNS、端口、用户名、用途）全部收集完成后，再调用脚本进入密码录入。密码不得在聊天中明文输出。`--project` 初始化配置了远程服务器后，除非用户显式选择 `--skip-claude-md`，脚本必须更新项目 `CLAUDE.md` 的 AutoGoo-Plugin marker 段，写入服务器概要、何时使用和安全约束；远程路径与环境命令细节仍以 `.goo/config.json` 为准。

最终落盘阶段运行脚本时，只能在用户已确认参数后执行，形态如下：先解析 AutoGoo-Plugin root，再运行 `bash "$auto_goo_root/skills/auto-goo/scripts/goo-init.sh" --user|--project --wiki-dir <已确认路径> ...`。远程服务器非敏感参数必须通过可重复的 `--server 'name=<别名>,host=<ssh-host-or-ip>,user=<user>,port=<port>,type=<cpu|gpu>,purpose=<用途>'` 传入；密码不得作为命令参数传入。不得在交互前运行 root 解析命令。

Agent 交互流程：

1. **不要先检查环境，直接开始交互提问。** 收到 `/auto-goo:goo-init` 后，不要先跑 `ls`、`git remote`、`test -f` 等探测命令，而是直接调用 `AskUserQuestion` / 结构化选择 UI 询问用户偏好。不得在 `AskUserQuestion` 可用时用普通文本要求用户手打 `1/2` 或 `--project/--user`。
2. 读取用户已给参数，缺什么问什么；不要一次性抛出长问卷。
3. 所有交互问题必须使用 `AskUserQuestion` / 结构化选择 UI 展示可点击选项；不得只输出“请选择配置作用域”这类问题标题后等待用户，也不得要求用户手打 `1/2` 或 `--project/--user`。如果结构化选择 UI / AskUserQuestion 不可用、调用失败或没有渲染出按钮，才允许降级为明确标注 fallback 的纯文本列表选项，继续收集用户选择。
4. 第一个问题必须优先用 `AskUserQuestion` 呈现以下选项：
   - 项目级 `--project` (Recommended) — 写入当前项目 `.goo/config.json`
   - 用户级 `--user` — 写入 `~/.auto-goo/config.json`
5. 如果无法渲染结构化选项，使用以下纯文本 fallback：
   ```text
   这是 fallback：结构化选择 UI 不可用。请选择配置作用域：
   1. 项目级 --project (Recommended) - 写入当前项目 .goo/config.json
   2. 用户级 --user - 写入 ~/.auto-goo/config.json

   请回复 1/2，或直接回复“项目级”/“用户级”。
   ```
6. 第二个问题必须优先用 `AskUserQuestion` 呈现以下选项。**如果用户级 `~/.auto-goo/config.json` 已配置 `wiki_dir`（或环境变量 `AUTOGOO_PLUGIN_WIKI_DIR` 已设），必须把该已配置路径作为首个推荐选项**，避免每个项目重复输入；未配置时才用默认路径：
   - 已配置时：`<已配置路径>` (Recommended) / `~/workspace/Goo-wiki` / 自定义路径（Other 输入）
   - 未配置时：`~/workspace/Goo-wiki` (Recommended) / 自定义路径（选择后在 Other 输入）
7. 如果无法渲染结构化选项，使用以下纯文本 fallback：
   ```text
   这是 fallback：结构化选择 UI 不可用。请选择 Goo-wiki 路径：
   1. <已配置路径，若有> (Recommended)
   2. ~/workspace/Goo-wiki
   3. 自定义路径

   请回复序号；如果选择自定义路径，请直接写完整路径。
   ```
8. 后续二选一问题也必须优先用 `AskUserQuestion` 提供两个显式选项；只有交互控件不可用时，才允许使用明确标注 fallback 的纯文本列表。凡 `skills/auto-goo/references/interaction-templates.md` 已定义固定 `id` 的问题，必须复用对应模板，不要临场改写。
9. 项目级初始化时，继续询问：
   - 是否创建业务项目目录结构：必须实际调用 `AskUserQuestion` 并复用 `id=project_workspace_create` 模板；默认「不创建 (Recommended)」。用户未选择前不得静默创建目录。
   - 如果用户选择创建，继续实际调用 `AskUserQuestion` 并复用 `id=project_workspace_layout` 模板。选择 `standard`/`ml`/`data` 时分别传 `--project-layout standard|ml|data`；如果用户通过 Other 输入 `docs`，传 `--project-layout docs`；其他 Other 输入按逗号分隔目录处理，复述确认后传 `--project-dirs <用户输入>`。
   - 业务目录创建后，主 Agent 必须只读扫描项目根目录已有内容，排除 `.goo/`、`.git/`、`.claude/`、已创建业务目录、secrets、锁文件和隐藏配置。如果发现可归类到新业务目录的现有文件或目录，必须实际调用 `AskUserQuestion` 并复用 `id=project_workspace_organize_existing` 模板询问是否生成整理方案；默认暂不整理。
   - 用户选择生成整理方案时，只生成并展示移动清单，不直接移动。清单必须包含源路径、目标路径、归类理由、冲突/覆盖风险和跳过项；随后必须实际调用 `AskUserQuestion` 并复用 `id=project_workspace_apply_organization` 模板二次确认。用户选择执行后，才允许按清单移动；遇到目标已存在、路径不确定、敏感文件或批量大文件时停止并重新确认，不得覆盖或删除。
   - 业务目录创建后，必须实际调用 `AskUserQuestion` 并复用 `id=project_workspace_claude_md` 模板，询问是否把目录约定写入项目级 `goo.md` 与项目指针 `CLAUDE.md`。
   - 是否把 Goo-wiki 归档原则或服务器使用约定写入项目级 `goo.md`（并在项目指针 `CLAUDE.md` 中保留 marker 指针）（`AskUserQuestion`，选项：「是 (Recommended)」「跳过」）
   - 是否需要配置远程服务器（`AskUserQuestion`，选项：「否 (Recommended)」「是」）
   - 如果用户选择配置服务器，逐字段使用 `AskUserQuestion` 收集非敏感参数。**每个问题必须至少 2 个显式选项**（系统的自动 Other 不算在内）。用户可直接选用预设值，或通过 "Other" 输入自定义值：
     - **服务器类型**：「GPU 服务器 (Recommended)」「CPU 服务器」
     - **服务器名称/别名**：「gpu-a100」「lab-cpu」
     - **SSH host/IP/DNS**：「gpu-a100」「192.168.1.100」
     - **SSH 端口**：「22 (Recommended)」「2222」「自定义端口」
     - **用户名**：「ubuntu (Recommended)」「root」「自定义用户名」
     - **用途说明**：「模型训练与推理」「数据处理与预处理」
     - **密码**：「稍后手动填入 (Recommended)」「输入密码」— 用户可输入密码，也可选默认跳过。如果跳过，提示用户密码存储在 `<项目级 .goo/secrets.json 或用户级 ~/.auto-goo/secrets.json>`（chmod 600），可稍后编辑该文件补填 `password` 字段。
     - 每台服务器配置完后询问「是否添加另一台服务器？」
     - 所有服务器信息收集完后，汇总展示给用户确认，然后调用脚本落盘。
10. 用户回答完所有问题后，把已确认的 `--user/--project`、`--wiki-dir`、`--project-layout`、`--project-dirs`、`--project-slug`、`--update-claude-md/--skip-claude-md` 等参数传给脚本。脚本内部自行处理已存在配置的检测和覆盖确认。
11. 脚本执行后读取结果摘要，向用户说明最终生效配置和 fallback 情况。

脚本落盘行为：

1. **选择作用域** — 用户级或项目级；未传 `--user/--project` 时交互提问
2. **创建配置目录** — 用户级确保 `~/.auto-goo/`；项目级确保 `.goo/`
3. **读取已有配置** — 脚本自行检测目标配置是否已存在，存在时展示当前配置并询问是否更新
4. **配置 Wiki 路径** — 必须向用户提供默认路径 `~/workspace/Goo-wiki`；用户不输入则使用默认路径，也允许用户输入自定义路径，并按优先级解析：
   - `AUTOGOO_PLUGIN_WIKI_DIR`
   - 项目级 `.goo/config.json` 的 `wiki_dir`
   - 用户级 `~/.auto-goo/config.json` 的 `wiki_dir`
   - 默认 `~/workspace/Goo-wiki`
5. **配置业务项目目录结构** — AutoGoo-Plugin 自身状态目录固定为 `.goo/`，配置中的 `workspace.paths` 只描述 AutoGoo-Plugin 运行态路径。项目级初始化时，先询问是否创建业务目录；用户选择创建后，传 `--project-layout standard|ml|data|docs` 或 `--project-dirs <逗号分隔目录>`，脚本创建这些业务目录并写入 `project_workspace.{layout,dirs}`。内置模板包含 `references/` 和 `references/papers/`，用于存放参考资料、规范、paper PDF、arXiv/DOI 元数据和阅读材料；不要把这些外部资料混入 `.goo/` 或普通产出文档。默认 `project_workspace.layout="none"`，不创建业务目录，避免污染已有项目。业务目录创建后，如果项目根目录已有可归类内容，必须通过 `id=project_workspace_organize_existing` 和 `id=project_workspace_apply_organization` 两级 `AskUserQuestion` 流程确认后才允许整理；脚本默认不移动已有内容。随后必须继续询问是否把目录约定写入项目级 `goo.md` 与项目指针 `CLAUDE.md`。
6. **配置远程服务器** — Wiki 路径配置后，询问用户是否有远程服务器需要配置。检测到目标 config 已有服务器（`servers` 或旧字段 `compute_servers`）时，先通过结构化选择询问服务器管理方式：保持已有并新增 (Recommended) / 删除已有服务器 / 替换已有服务器 / 清空全部服务器 / 跳过不修改。删除按名称执行，配置与 secrets 同步移除；替换固定原名称重新收集参数，同名写入即为替换（upsert）。用户确认后逐个交互输入服务器类型（cpu/gpu）、名称/别名、SSH host/IP/DNS、端口（默认 22，可自定义）、用户名、用途说明、可选默认工作路径、可选环境初始化命令、可选数据目录、可选产物目录和密码处理方式。主 Agent 已通过 `AskUserQuestion` 收集到非敏感参数时，调用脚本必须传 `--server 'name=<别名>,host=<ssh-host-or-ip>,user=<user>,port=<port>,type=<cpu|gpu>,purpose=<用途>,workdir=<远程工作目录>,setup=<命令1;命令2>,data_dir=<远程数据目录>,artifacts_dir=<远程产物目录>'`，可重复传入多台服务器；后四项可省略。同名 `--server` 为替换（upsert），不产生重复条目。删除/清空分别传 `--remove-server <名称>`（可重复）和 `--clear-servers`。密码不得在聊天或命令行中明文传递；脚本会创建独立 secrets 文件占位（项目级 `.goo/secrets.json`，用户级 `~/.auto-goo/secrets.json`），文件权限设为 `chmod 600`，用户稍后手动填入密码。项目级 secrets 文件自动加入 `.gitignore`。config 中记录 `servers[].{name, host, ip?, port, user, type, purpose, defaults?, secrets_file}`，不存储密码。支持配置多个服务器。配置服务器后必须检查本机是否安装 `sshpass`；缺失时提醒用户运行 `sudo apt install sshpass`，但不中断初始化。
7. **确保 Goo-wiki 存在** — 如果用户确认或输入的 `<wiki_dir>` 不存在，自动创建该目录，并补齐 `CLAUDE.md`、`log.md`、`wiki/projects/`、`wiki/concepts/`、`wiki/questions/`、`journal/daily/`、`journal/weekly/` 基础结构；不得因为路径不存在而改用 `.goo/obsidian/` fallback
8. **确定项目归档根路径** — `--project` 时默认用项目根目录名生成 `project_slug`，也可传 `--project-slug <slug>`；创建 `<wiki_dir>/wiki/projects/<project_slug>/`
8. **记录 Git 地址** — `--project` 且当前项目是 Git repo 时，读取 `origin` remote（没有 origin 时读取第一个 remote），写入 `.goo/config.json.archive.git_remote_url`，并同步到 Goo-wiki 项目页 `wiki/projects/<project_slug>/<project_slug>.md`
9. **写入配置** — 生成目标配置文件；项目级配置写入 `archive.project_slug`、`archive.project_dir`、`archive.fallback_project_dir`、固定 `.goo` 的 `workspace.paths`、可选 `project_workspace`，以及可用时的 `archive.git_remote_url`；有远程服务器时写入 `servers[]`
10. **goo.md 与指针约定** — `--user` 时总是生成 `~/.auto-goo/goo.md`，并按 `--write-user-pointer` / `--skip-user-pointer`（默认写）更新用户级指针 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`。`--project` 且创建了业务目录时，询问是否幂等更新项目级 `goo.md`（写入 `project_workspace` 目录语义、读写边界和 `.goo/` 状态目录边界）与项目指针 `CLAUDE.md`/`AGENTS.md`；`--project` 且 Goo-wiki 可用时，另询问是否加入 Goo-wiki 召回与归档要求。`--project` 且配置了远程服务器时，默认把服务器概要、使用条件和安全约束写入项目级 `goo.md` 的 marker 段；远程 `workdir`、`setup_commands`、数据目录和产物目录只写 `.goo/config.json`。非交互场景没有服务器时默认不生成项目级 `goo.md`，需传 `--update-claude-md` 明确写入；如需明确跳过，传 `--skip-claude-md`（用户级和项目级同时跳过）
11. **提示 hooks** — 展示推荐的 `.claude/settings.json` SessionStart hooks，由用户决定是否复制/合并

## 默认配置

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
      "logs_dir": ".goo/logs",
      "artifacts_dir": ".goo/artifacts",
      "reports_dir": ".goo/reports",
      "locks_dir": ".goo/locks",
      "change_requests_dir": ".goo/change-requests",
      "site_dir": ".goo/site"
    }
  },
  "project_workspace": {
    "layout": "ml",
    "dirs": ["src", "configs", "scripts", "notebooks", "references", "references/papers", "data/raw", "data/processed", "models", "outputs", "reports", "docs", "tests"]
  },
  "execution": {
    "max_concurrent": 6,
    "heartbeat_seconds": 30,
    "stale_after_seconds": 120
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
      "defaults": {
        "workdir": "/home/ubuntu/projects/<project-slug>",
        "setup_commands": [
          "source ~/miniconda3/etc/profile.d/conda.sh",
          "conda activate data-env"
        ],
        "paths": {
          "data_dir": "/data/<project-slug>",
          "artifacts_dir": "/data/<project-slug>/outputs"
        }
      },
      "secrets_file": ".goo/secrets.json"
    },
    {
      "ip": "192.168.1.101",
      "port": 2222,
      "user": "ubuntu",
      "type": "gpu",
      "purpose": "模型训练与推理",
      "defaults": {
        "workdir": "/home/ubuntu/projects/<project-slug>",
        "setup_commands": [
          "source ~/miniconda3/etc/profile.d/conda.sh",
          "conda activate train-env"
        ],
        "paths": {
          "data_dir": "/mnt/data/<project-slug>",
          "artifacts_dir": "/mnt/outputs/<project-slug>"
        }
      },
      "secrets_file": ".goo/secrets.json"
    }
  ]
}
```

## 输出要求

### 交互超时（不卡死）

结构化提问阶段遵守以下超时约束，避免无人应答时流程挂起：

- Pi 环境下由 `interaction.timeout_seconds`（默认 **180**，`0` 禁用）控制 `ctx.ui` 对话框超时；超时后对话框自动关闭。
- 超时兜底：`select` 采用带 `(Recommended)` 的选项，无可推荐项则**视为取消**；`confirm` 为 `false`；`input` 回退默认值。
- **不可逆操作显式禁用兜底**：删除/替换服务器、清空服务器、文件整理执行、plan 确认执行、新建 thread 等，超时一律不执行，必须等待用户显式确认。
- Claude Code / Codex 环境下如平台不支持原生超时，主 Agent 应把超时视为“用户未选择”，按上述兜底规则继续，并在最终摘要中说明哪些项是默认采用的。
- 任何被兜底采用的选项都必须在结果摘要中标注“超时默认”，不得让用户误以为是自己的选择。

### goo.md 缺失时的恢复

如果发现环境里没有 goo.md（项目级与用户级都没有），可提示用户用内置备份恢复：

```bash
python3 <auto_goo_root>/skills/auto-goo/scripts/goo-md.py --check    # 确认状态
python3 <auto_goo_root>/skills/auto-goo/scripts/goo-md.py --ensure   # 从模板恢复用户级 goo.md
```

`--ensure` 幂等且不覆盖已有内容，只写 `~/.auto-goo/goo.md`；需要重新写用户级/项目级指针时仍需跑 `/auto-goo:goo-init`。

### 复用已配置的 wiki 路径

询问 Goo-wiki 路径时，若用户级 `~/.auto-goo/config.json` 已配置 `wiki_dir`（或设了 `AUTOGOO_PLUGIN_WIKI_DIR`），**必须把该路径作为首个推荐选项**，不要默认只给 `~/workspace/Goo-wiki`，否则用户每个项目都要重复输入。

- 不覆盖已有 `.goo/config.json`，除非用户明确确认；但保留 config 时仍可按 `--update-claude-md` 更新项目级 `goo.md` 与项目指针 `CLAUDE.md`/`AGENTS.md`
- 不覆盖已有 `~/.auto-goo/config.json`，除非用户明确确认；`--user` 仍会生成或幂等更新 `~/.auto-goo/goo.md`（除非 `--skip-claude-md`）
- 不删除任何已有 `.goo/` 内容
- `--project` 且 Goo-wiki 可用时，必须创建或复用 `<wiki_dir>/wiki/projects/<project_slug>/` 作为项目归档根路径
- `--project` 且项目是 Git repo 时，必须把 git remote 地址写入 `.goo/config.json.archive.git_remote_url`；Goo-wiki 可用时同步写入 `<wiki_dir>/wiki/projects/<project_slug>/<project_slug>.md`
- `--project` 且创建业务目录时，必须先用 `AskUserQuestion` 复用 `id=project_workspace_claude_md` 模板询问用户是否把目录约定写入项目级 `goo.md` 与项目指针 `CLAUDE.md`/`AGENTS.md`；Goo-wiki 可用时，再询问是否写入归档原则。配置服务器时，不需要额外确认，初始化后默认把由 AutoGoo-Plugin marker 包裹的服务器概要和安全约束追加或更新到项目级 `goo.md`；不重写其他内容，且不把远程路径和环境命令细节展开到 `goo.md`
- `--user` 时必须在 `~/.auto-goo/` 下生成 `goo.md`（除非 `--skip-claude-md`），并按 `--write-user-pointer` / `--skip-user-pointer` 决定是否写 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`；两个 flag 互斥，`--agent` 非法值以 `exit 2` 拒绝
- 初始化交互由主 Agent 负责；不得派发 Subagent 或用临时代码替代脚本写配置
- 配置完成后，脚本不得尝试连接服务器（不做 ssh、ping、端口探测等网络连接）；仅写入配置文件
- 最终落盘必须先解析 `auto_goo_root`，再运行 `bash "$auto_goo_root/skills/auto-goo/scripts/goo-init.sh"`，并传入主 Agent 已确认的参数；不得在根目录变量为空时运行 `/skills/auto-goo/scripts/goo-init.sh`
- 用户回答了 `--user` 或 `--project` 后，必须把该参数传给脚本
- 用户确认或输入 wiki 路径后，必须把 `--wiki-dir <路径>` 传给脚本
- 用户指定业务项目目录结构后，必须把 `--project-layout <standard|ml|data|docs>` 或 `--project-dirs <逗号分隔目录>` 传给脚本；未指定时不创建业务目录。该询问必须用 `id=project_workspace_create` 和 `id=project_workspace_layout` 两个固定 `AskUserQuestion` 模板完成。AutoGoo-Plugin 自身状态目录始终使用项目 `.goo/`
- 业务目录创建后，如果项目根目录已有内容，必须用 `id=project_workspace_organize_existing` 询问是否生成整理方案；默认不整理。只有用户确认生成方案并在 `id=project_workspace_apply_organization` 中二次确认执行后，才允许移动文件。不得移动 `.goo/`、`.git/`、`.claude/`、secrets、锁文件、隐藏配置或目标冲突项；不得覆盖或删除已有文件
- 如果用户输入的 Goo-wiki 路径不存在，自动创建该路径和基础 vault 文件；只有创建失败或后续归档时 wiki 不可写，才提示使用 `.goo/obsidian/` fallback
- 最终输出用户级、项目级和最终生效配置摘要
- 有远程服务器时，密码必须存储在独立 secrets 文件中（项目级 `.goo/secrets.json`，用户级 `~/.auto-goo/secrets.json`），文件权限 `chmod 600`；config 中只记录 `{name, host, ip?, port, user, type, purpose, defaults?, secrets_file}`，不存储密码。`defaults` 可记录远程默认 `workdir`、`setup_commands[]`、`paths.data_dir`、`paths.artifacts_dir` 等非敏感环境约定；不得写入 token、API key、私钥、密码或带 secret 的 export 命令。非敏感参数通过 `--server` 写入，密码由用户稍后手动填入 secrets；如果本机未安装 `sshpass`，必须提示用户安装后才能使用自动填密码的 `goo-ssh.sh`
- 项目级 secrets 文件必须自动加入 `.gitignore`，防止密码泄露到版本控制

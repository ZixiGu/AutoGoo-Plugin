/**
 * AutoGoo-Plugin constants — interaction templates, reference rules, prompt snippets.
 *
 * These replace the Claude Code interaction-templates.md and parts of
 * SKILL.md / references/*.md so Pi extensions can use them directly
 * without reading Markdown files at runtime.
 */

import type { SelectOption } from "./types.js";

// ── Interaction Templates (replaces interaction-templates.md) ───────────────

export interface InteractionTemplate {
  header: string;
  id: string;
  question: string;
  options: SelectOption[];
}

/** goo-init: config scope */
export const TEMPLATE_CONFIG_SCOPE: InteractionTemplate = {
  header: "配置作用域",
  id: "config_scope",
  question: "请选择 AutoGoo-Plugin 配置写入位置。",
  options: [
    { label: "项目级 --project (Recommended)", description: "写入当前项目 .goo/config.json，只影响当前项目；有项目专属内容时才按需生成项目级 goo.md 与指针。", value: "project" },
    { label: "用户级 --user", description: "写入 ~/.auto-goo/config.json 与约定单源 ~/.auto-goo/goo.md，作为所有项目的默认配置。", value: "user" },
  ],
};

/** goo-init: wiki path */
export const TEMPLATE_WIKI_DIR: InteractionTemplate = {
  header: "Wiki 路径",
  id: "wiki_dir",
  question: "请选择 Goo-wiki 路径。",
  options: [
    { label: "~/workspace/Goo-wiki (Recommended)", description: "使用默认 Goo-wiki 路径；不存在时初始化脚本会创建基础目录。", value: "__default__" },
    { label: "自定义路径", description: "选择后在输入框中输入路径。", value: "__custom__" },
  ],
};

/** goo-init: create project workspace dirs */
export const TEMPLATE_PROJECT_WORKSPACE_CREATE: InteractionTemplate = {
  header: "项目目录",
  id: "project_workspace_create",
  question: "是否为当前项目创建业务目录结构？",
  options: [
    { label: "不创建 (Recommended)", description: "只初始化 .goo/ AutoGoo-Plugin 状态目录，不新增 src/data/docs 等业务目录。", value: "no" },
    { label: "创建业务目录", description: "继续选择目录模板或自定义目录。", value: "yes" },
  ],
};

/** goo-init: workspace layout template */
export const TEMPLATE_PROJECT_WORKSPACE_LAYOUT: InteractionTemplate = {
  header: "目录模板",
  id: "project_workspace_layout",
  question: "请选择业务项目目录模板。",
  options: [
    { label: "standard (Recommended)", description: "src, tests, docs, scripts, data, configs, references", value: "standard" },
    { label: "ml", description: "src, configs, scripts, notebooks, references, data/raw, data/processed, data/external, models, outputs, reports, docs, tests", value: "ml" },
    { label: "data", description: "src, configs, scripts, notebooks, references, data/raw, data/processed, data/external, reports, docs, tests", value: "data" },
    { label: "docs", description: "只创建 references/ 和 references/papers/", value: "docs" },
    { label: "自定义", description: "选择后通过输入框传入逗号分隔的目录列表", value: "__custom__" },
  ],
};

/** goo-init: update project goo.md with dir conventions */
export const TEMPLATE_PROJECT_WORKSPACE_CLAUDE_MD: InteractionTemplate = {
  header: "目录约定",
  id: "project_workspace_claude_md",
  question: "是否把业务目录约定写入项目 goo.md（并通过 marker 指针同步到 CLAUDE.md / AGENTS.md）？",
  options: [
    { label: "写入 (Recommended)", description: "把目录语义、读写边界和 .goo/ 状态边界写入项目级 goo.md；项目 CLAUDE.md / AGENTS.md 只保留 AutoGoo-Plugin marker 指针。", value: "yes" },
    { label: "跳过", description: "不生成项目级 goo.md，也不修改项目 CLAUDE.md / AGENTS.md。", value: "no" },
  ],
};

/** goo-init: write user-level agent pointer (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) */
export const TEMPLATE_USER_GOO_MD_POINTER: InteractionTemplate = {
  header: "用户级指针",
  id: "user_goo_md_pointer",
  question: "是否写入用户级指针到 ~/.claude/CLAUDE.md 和 ~/.codex/AGENTS.md？",
  options: [
    { label: "写入 (Recommended)", description: "在用户级 agent 文件里插入 AutoGoo-Plugin marker 指针，指向 ~/.auto-goo/goo.md；只改 marker 段。", value: "yes" },
    { label: "只写 goo.md", description: "只生成 ~/.auto-goo/goo.md，不创建/修改 ~/.claude 或 ~/.codex 下的文件。", value: "no" },
  ],
};

/** goo-init: remote server type */
export const TEMPLATE_SERVER_TYPE: InteractionTemplate = {
  header: "服务器类型",
  id: "server_type",
  question: "请选择远程服务器类型。",
  options: [
    { label: "GPU 服务器 (Recommended)", description: "适合模型训练、推理、大规模并行计算等 GPU 负载。", value: "gpu" },
    { label: "CPU 服务器", description: "适合数据处理、预处理、评估等 CPU 负载。", value: "cpu" },
  ],
};

/** goo-init: remote server SSH port */
export const TEMPLATE_SERVER_PORT: InteractionTemplate = {
  header: "SSH 端口",
  id: "server_port",
  question: "请选择 SSH 端口。",
  options: [
    { label: "22 (Recommended)", description: "默认 SSH 端口。", value: "22" },
    { label: "2222", description: "替代 SSH 端口。", value: "2222" },
    { label: "自定义端口", description: "通过输入框输入任意端口号（1-65535）。", value: "__custom__" },
  ],
};

/** goo-init: remote server username */
export const TEMPLATE_SERVER_USER: InteractionTemplate = {
  header: "用户名",
  id: "server_user",
  question: "请选择 SSH 登录用户名。",
  options: [
    { label: "ubuntu (Recommended)", description: "Ubuntu/Debian 系统默认用户。", value: "ubuntu" },
    { label: "root", description: "root 用户。", value: "root" },
    { label: "自定义用户名", description: "通过输入框输入任意用户名（如 admin、ec2-user、azureuser）。", value: "__custom__" },
  ],
};

/** goo-init: remote server management (existing servers detected) */
export const TEMPLATE_SERVER_MANAGE: InteractionTemplate = {
  header: "服务器管理",
  id: "server_manage",
  question: "检测到已配置的远程服务器。请选择处理方式。",
  options: [
    { label: "保持已有，仅新增 (Recommended)", description: "保留现有服务器，继续收集新服务器参数。", value: "keep_add" },
    { label: "删除已有服务器", description: "按名称选择要删除的服务器，配置与 secrets 同步移除。", value: "remove" },
    { label: "替换已有服务器", description: "选择要替换的服务器，重新输入连接参数。", value: "replace" },
    { label: "清空全部服务器", description: "删除所有已配置的远程服务器。", value: "clear" },
    { label: "跳过，不修改服务器", description: "保持现有服务器配置不变，也不新增。", value: "skip" },
  ],
};

/** goo-init: server password handling */
export const TEMPLATE_SERVER_PASSWORD: InteractionTemplate = {
  header: "密码",
  id: "server_password",
  question: "请设置服务器密码。",
  options: [
    { label: "稍后手动填入 (Recommended)", description: "密码存储在 .goo/secrets.json（chmod 600），可稍后编辑该文件补填 password 字段。", value: "__skip__" },
    { label: "输入密码", description: "仅支持安全输入的环境可用；Pi 终端不支持掩码，选此项会提示稍后手动填入 secrets 文件。", value: "__input__" },
  ],
};

/** thread action: new/continue/cancel */
export const TEMPLATE_THREAD_ACTION: InteractionTemplate = {
  header: "任务线操作",
  id: "thread_action",
  question: "当前 thread 或 .goo/plan.json 还未完成。请选择处理方式：",
  options: [
    { label: "新建 thread (Recommended)", description: "为新任务创建独立 thread_id、plan、logs 和 artifacts。", value: "new" },
    { label: "继续当前 thread", description: "把新需求合并到当前计划，保留已完成步骤、日志和执行证据。", value: "continue" },
    { label: "取消", description: "保留当前 thread 和 plan 不变。", value: "cancel" },
  ],
};

/** plan review start */
export const TEMPLATE_PLAN_REVIEW_START: InteractionTemplate = {
  header: "计划审阅 — 请选择下一步",
  id: "plan_review_start",
  question: "以上是本次计划的完整 DAG。请选择下一步。",
  options: [
    { label: "确认并开始执行 (Recommended)", description: "标记 review.status=confirmed，归档最终版 brainstorm（如有），然后开始执行 plan steps。", value: "confirm" },
    { label: "修改步骤详情", description: "调整步骤的输入、输出、描述、验收方式或角色分配。", value: "modify_step" },
    { label: "拆分/合并步骤", description: "把某个步骤拆成多个子步骤，或合并多个步骤为一个。", value: "split_merge" },
    { label: "修改 DAG 依赖", description: "调整步骤间的依赖关系，改变并行/串行结构。", value: "modify_dag" },
    { label: "修改目标或约束", description: "调整 goals、验收标准或上下文约束。", value: "modify_goal" },
    { label: "停止/稍后再说", description: "保持 pending_user_review 状态，保留计划但不执行。", value: "cancel" },
  ],
};

/** context sync confirm */
export const TEMPLATE_CONTEXT_SYNC_CONFIRM: InteractionTemplate = {
  header: "上下文同步",
  id: "context_sync_confirm",
  question: "plan 生成后对话中产生了新的方案、取舍或约束，是否同步到 plan？",
  options: [
    { label: "同步 (Recommended)", description: "将新增内容合并到 context_digest 或 context_artifacts。", value: "sync" },
    { label: "跳过", description: "保持当前 plan 不变。", value: "skip" },
  ],
};

/** remote resource usage */
export const TEMPLATE_REMOTE_RESOURCE_USAGE: InteractionTemplate = {
  header: "远程资源使用",
  id: "remote_resource_usage",
  question: "检测到配置了远程服务器，是否使用远程资源执行本次任务？",
  options: [
    { label: "本地执行 (Recommended)", description: "所有步骤在本地机器执行。", value: "local" },
    { label: "使用远程服务器", description: "将匹配的步骤标记为远程执行。", value: "remote" },
  ],
};

/** post-archive HTML report */
export const TEMPLATE_POST_ARCHIVE_HTML_REPORT: InteractionTemplate = {
  header: "任务报告",
  id: "post_archive_html_report",
  question: "是否生成任务总结报告页？",
  options: [
    { label: "生成报告 (Recommended)", description: "生成包含本次任务关键产物、验证结果和归档链接的总结报告。", value: "yes" },
    { label: "跳过", description: "不生成任务总结报告。", value: "no" },
  ],
};

/** organize existing files */
export const TEMPLATE_PROJECT_WORKSPACE_ORGANIZE_EXISTING: InteractionTemplate = {
  header: "文件整理",
  id: "project_workspace_organize_existing",
  question: "在项目根目录发现可归类到新业务目录的现有文件，是否生成整理方案？",
  options: [
    { label: "暂不整理 (Recommended)", description: "保持现有文件位置不变。", value: "no" },
    { label: "生成整理方案", description: "扫描现有目录，生成包含源路径、目标路径和归类理由的移动清单。", value: "yes" },
  ],
};

/** apply organization plan */
export const TEMPLATE_PROJECT_WORKSPACE_APPLY_ORGANIZATION: InteractionTemplate = {
  header: "执行整理",
  id: "project_workspace_apply_organization",
  question: "确认执行以下文件移动方案？",
  options: [
    { label: "确认执行 (Recommended)", description: "按整理方案移动文件。", value: "yes" },
    { label: "取消", description: "不做任何移动。", value: "no" },
  ],
};

/** Worktree isolation */
export const TEMPLATE_WORKTREE: InteractionTemplate = {
  header: "Worktree",
  id: "git_init_project",
  question: "是否为本次 Subagent 执行启用 Git worktree 隔离？",
  options: [
    { label: "不启用 (Recommended)", description: "省略 Agent isolation 字段；不自动初始化 Git 或创建提交。", value: "none" },
    { label: "启用 worktree", description: "需要当前项目有 Git HEAD；若没有会先 git init 并在安全检查后创建初始提交。", value: "worktree" },
    { label: "停止执行", description: "保留当前 plan，不派发执行。", value: "abort" },
  ],
};

// ── Directory layout presets ────────────────────────────────────────────────

export const DIR_LAYOUTS: Record<string, string[]> = {
  standard: ["src", "tests", "docs", "scripts", "data", "configs", "references", "references/papers"],
  ml: [
    "src", "configs", "scripts", "notebooks", "references", "references/papers",
    "data/raw", "data/processed", "data/external", "models", "outputs", "reports", "docs", "tests",
  ],
  data: [
    "src", "configs", "scripts", "notebooks", "references", "references/papers",
    "data/raw", "data/processed", "data/external", "reports", "docs", "tests",
  ],
  docs: ["references", "references/papers"],
};

// ── Role / Task agent prompts ───────────────────────────────────────────────

export const SUBAGENT_ROLES: Record<string, string> = {
  researcher: `你是 AutoGoo-Plugin Researcher。你的任务是深入调研和资料收集。
- 搜索相关文档、论文、代码库和最佳实践
- 整理调研结果，形成结构化报告
- 标注信息来源和可信度
- 提出可行的技术方案和建议`,

  implementer: `你是 AutoGoo-Plugin Implementer。你的任务是编码实现。
- 严格按照 step 描述和验收标准实现
- 编写可读、可测试、可维护的代码
- 遵循项目已有的代码风格和架构约定
- 实现完成后运行验证命令确认正确性`,

  optimizer: `你是 AutoGoo-Plugin Optimizer。你的任务是性能优化和效率提升。
- 先建立指标和基线，再做改动
- 使用 profiler 或 benchmark 工具定位瓶颈
- 每次优化后对比基线，记录提升幅度
- 达到目标或边际收益过低时停止优化`,

  evaluator: `你是 AutoGoo-Plugin Evaluator。你的任务是评测和验证。
- 定义评测指标和数据集
- 运行评测并记录结果
- 与基线对比，生成评测报告
- 分析失败案例，提出改进建议`,

  reviewer: `你是 AutoGoo-Plugin Reviewer。你的任务是代码审查和方案评审。
- 检查代码正确性、安全性和性能
- 验证是否满足验收标准
- 指出潜在问题并给出改进建议
- 输出审查报告`,

  auditor: `你是 AutoGoo-Plugin Auditor。你的任务是证据审计和合规检查。
- 检查步骤产物是否完整
- 验证日志、产物路径和验收结果的一致性
- 检查是否遵循了项目约束和规范
- 输出审计报告`,

  recorder: `你是 AutoGoo-Plugin Recorder。你的任务是归档和知识沉淀。
- 将任务目标、计划、关键证据和产物归档到 Goo-wiki
- 补充 Wikilink/backlink 关系，防止 Obsidian 连接图谱断裂
- 记录可复用的经验、命令、路径和决策
- 更新 log.md 和项目入口页`,
};

export const TASK_AGENTS: Record<string, string> = {
  "document-analyst": `你擅长分析文档、论文、Markdown 任务包和结构化文本。
- 提取关键信息、约束和验收标准
- 识别文档中的技术方案和架构决策
- 总结核心观点和待办事项`,

  "feature-builder": `你擅长从零开始构建新功能模块。
- 先理解需求边界和输入输出
- 设计简洁的接口和数据结构
- 编写完整的实现代码
- 添加必要的测试`,

  "test-runner": `你擅长运行测试和验证功能正确性。
- 运行项目现有测试套件
- 分析测试失败原因
- 补充缺失的测试用例
- 报告测试覆盖率`,

  "code-reviewer": `你擅长审查代码质量和安全。
- 检查常见安全漏洞（注入、XSS、路径遍历等）
- 评估代码性能和可维护性
- 检查错误处理和边界情况
- 给出可操作的改进建议`,

  "evidence-auditor": `你擅长审计和验证执行证据。
- 检查产物的完整性和一致性
- 验证日志记录是否齐全
- 确认验收标准是否满足
- 生成审计报告`,

  "wiki-curator": `你擅长 Obsidian 知识库的维护和归档。
- 创建符合 Goo-wiki 规范的归档页面
- 维护 Wikilink 和 backlink 的一致性
- 更新项目入口页和 log.md
- 确保知识可追溯、可复用`,
};

// ── System prompt snippets ──────────────────────────────────────────────────

// ── Memory system rules (sync with Claude Code SKILL.md) ────────────────────

/**
 * 按需调用原则 — Subagent 不全量读 wiki;按 wiki_paths glob 按需取用;
 * 受字符预算 (< 20k) + 超时 (< 30s) 双重约束。
 * 镜像 Claude Code SKILL.md L45-54。
 */
export const ON_DEMAND_RECALL_RULE = `
## 按需调用原则(On-Demand Recall)
- Subagent 不得全量读取 wiki;按当前 step 的 wiki_paths glob 按需取用
- 单次 Read/Grep 受字符预算 (< 20k) + 超时 (< 30s) 双重约束
- 跨 step 引用用 [[Wikilink]] 按需点开,不要 Read 整篇 wiki 笔记
- 主 Agent 派发前用 wiki-graph-assist.py 生成紧凑 graph packet
`.trim();

/**
 * 记忆分层原则 — L0/L1/L2/L3 四层;Subagent 默认 L2;frontmatter 必含 memory_layer。
 * 镜像 Claude Code SKILL.md L56-71。
 */
export const MEMORY_LAYERING_RULE = `
## 记忆分层原则(Memory Layering)
- L0 原始记录 (.goo/logs/) — 不进 Subagent 默认上下文
- L1 原子事实 (step 报告关键决策段)
- L2 场景知识 (任务页/lessons/references) — Subagent 默认读取
- L3 项目画像 (项目入口/高频 lessons) — 主 Agent 启动时读取
- 归档笔记 frontmatter 必含 memory_layer: L0|L1|L2|L3
`.trim();

/**
 * 默认 wiki_paths 表 — 按 step.type 计算默认 glob 路径子集。
 * 与 Claude Code execution-engine.md L429 保持字段一致。
 */
export const DEFAULT_WIKI_PATHS_BY_STEP_TYPE: Record<string, string[]> = {
  research: [
    "wiki/projects/{slug}/lessons/**",
    "wiki/projects/{slug}/references/**",
  ],
  exec: [
    "wiki/projects/{slug}/tasks/{thread_id}/**",
    "wiki/projects/{slug}/lessons/**",
  ],
  optimize: [
    "wiki/projects/{slug}/lessons/optimization-*.md",
    "wiki/projects/{slug}/reports/optimize-*.md",
  ],
  eval: [
    "wiki/projects/{slug}/lessons/eval-*.md",
    "wiki/projects/{slug}/reports/eval-*.md",
  ],
  review: [
    "wiki/projects/{slug}/lessons/**",
    "wiki/projects/{slug}/tasks/**",
  ],
  audit: [
    "wiki/projects/{slug}/lessons/**",
    "wiki/projects/{slug}/reports/**",
    "wiki/projects/{slug}/context/**",
  ],
  archive: [
    "wiki/projects/{slug}/**",  // archive 例外需要全栈
  ],
};

/**
 * 默认 memory_layer 表 — 按 step.type 给默认层级。
 */
export const DEFAULT_MEMORY_LAYER_BY_STEP_TYPE: Record<string, string> = {
  research: "L2",
  exec: "L2",
  optimize: "L2",
  eval: "L2",
  review: "L1",
  audit: "L0",
  archive: "L2",  // archive 步骤需要全栈但默认 L2 即可
};

export const AUTOGOO_PLUGIN_SYSTEM_PROMPT = `
## AutoGoo-Plugin DAG 工作流框架

AutoGoo-Plugin 是一个 DAG 驱动的多智能体编排框架。收到复杂多步任务后：

1. **先召回** Goo-wiki 中的项目经验
2. **再计划** — 将任务拆解为 DAG，标记依赖关系
3. **再执行** — 按槽位调度 Subagent，实时更新进度和心跳
4. **必归档** — 将决策、产物和可复用经验归档到 Goo-wiki

### 关键规则
- 主 Agent 总控，Subagent 执行
- 能并行就并行，只有真实数据依赖才串行
- 步骤必留痕（heartbeat + log），失败必记录原因
- 内容输出必须归档（非查看/初始化命令）
- 用户交互优先使用结构化选择 UI

使用 /auto-goo:goo-init 初始化配置
使用 /auto-goo:goo-plan 生成执行计划
使用 /auto-goo:goo-start 执行计划
使用 /auto-goo:goo-status 查看状态
`.trim() + "\n\n" + ON_DEMAND_RECALL_RULE + "\n\n" + MEMORY_LAYERING_RULE;

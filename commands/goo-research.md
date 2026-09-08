---
name: auto-goo:goo-research
description: 研究资料归档命令，当前支持 paper 子命令，用于论文深读、代码/数据集搜索、下载检查和 Goo-wiki 归档
---

# /auto-goo:goo-research — 研究资料归档

`goo-research` 是 AutoGoo-Plugin 的研究资料入口。当前支持 `paper` 子命令，用于把论文阅读、资料抓取、代码/数据集搜索、下载可行性检查和 Goo-wiki 归档放进同一条 AutoGoo-Plugin 任务链路。

推荐用法：

```text
/auto-goo:goo-research paper <论文标题/DOI/arXiv/URL/本地 PDF>
```

兼容触发：

```text
/auto-goo:goo-research paper 读一下 https://arxiv.org/abs/...
/auto-goo:goo-research paper doi:10.xxxx/xxxxx
/auto-goo:goo-research paper ./papers/example.pdf
```

## 行为

1. **模式识别** — 如果第一个参数是 `paper`，进入论文模式；如果用户只输入论文、DOI、arXiv、OpenReview、期刊 URL 或本地 PDF，也可推断为 `paper` 模式。
2. **AutoGoo-Plugin 配置读取** — 检查 `.goo/config.json`、`.goo/plan.json` 和 `.goo/brainstorm.json`，优先复用现有 `archive.task_archive_root`。
3. **任务归档根确定** — 同一研究任务沿用同一个 `task_archive_root`；没有现成根时，创建 `wiki/projects/<project-slug>/tasks/<YYYY-MM-DDTHH-MM-SS-paper-<slug>>/`。论文分析文档必须进入 Goo-wiki；Goo-wiki 不可写时可临时写入 `.goo/obsidian/<project-slug>/tasks/<task-slug>/` 防丢失，但归档状态必须是 `pending_wiki_sync` 或 `failed`，不能视为最终归档。
4. **资料收集（researcher）** — 派发 `researcher` Subagent 抓取公开可访问的 PDF、HTML、摘要页、元数据、BibTeX、引用、附录、补充材料和项目页；不要绕过付费墙或认证。
5. **正文抽取（researcher）** — 由 `researcher` 从 PDF/HTML 抽取全文、章节结构、图表标题、关键公式、实验表格和参考文献。
6. **代码与数据搜索（researcher）** — 由 `researcher` 主动搜索论文关联代码、项目页、模型、数据集、benchmark 和补充材料，来源包括论文正文、作者主页、GitHub/GitLab、Hugging Face、Papers with Code、OpenReview、arXiv comments、Zenodo、Figshare、OSF、Kaggle 和机构数据门户。
7. **下载可行性检查（researcher）** — 由 `researcher` 对候选代码/数据集区分官方和第三方，记录匹配证据、许可证、体积、登录/审批要求、可下载性、建议命令和失败原因；返回 evidence packet（含 `download_checks[]`、`code_candidates[]`、`dataset_candidates[]`、`access_limitations[]`）。大文件默认只做可访问性检查和小文件/元数据验证；真正下载前需要确认体积、路径和风险。
8. **产物落盘** — 小型知识产物写入 `<task_archive_root>/execution/`；PDF、HTML、代码 checkout、数据集样本和大文件放入 `.goo/artifacts/papers/<paper-slug>/` 或用户指定数据目录。
9. **深度笔记（recorder）** — 派发 `recorder` Subagent 基于 researcher 的 evidence packet 写中文论文笔记，包含问题、贡献、方法机制、实验、关键数字、局限、复现风险、相关工作定位和后续问题。主模型不亲自撰写笔记正文。
10. **Wiki 归档（recorder）** — 派发 `recorder` 把 `paper-summary.md` 分析正文、`manifest.json`、`evidence-index.md`、`downloadability.md` 和关键链接归档到 Goo-wiki，并同时更新项目入口和 `log.md`。不得只留下 `.goo/artifacts/`、step log、聊天总结或 fallback；Goo-wiki 页及链接可验证后才可写 `archive.status=completed`。

## 输出文件

默认产物：

```text
<task_archive_root>/
  execution/
    paper-summary.md
    manifest.json
    evidence-index.md
    downloadability.md
    note_plan.json

.goo/artifacts/papers/<paper-slug>/
  paper.pdf
  paper.html
  extracted/
    fulltext.md
    figures.md
    tables.md
    references.bib
  code/
  datasets/
  checks/
    download-checks.json
```

`manifest.json` 至少包含：

- `task`：用户原始研究请求。
- `paper`：标题、作者、年份、venue、DOI、arXiv ID、canonical URL。
- `autogoo`：`task_archive_root`、`execution_dir`、`artifact_root`、关联 plan/step。
- `sources[]`：公开来源页面和抓取时间。
- `files[]`：本地文件、来源 URL、大小、校验信息和访问限制。
- `code_candidates[]`：候选代码仓库、官方性、匹配证据、许可证、可下载性和建议命令。
- `dataset_candidates[]`：候选数据集、官方性、匹配证据、许可证、体积、访问限制和建议命令。
- `download_checks[]`：实际验证过的 HEAD/API/git ls-remote/小型元数据下载结果。
- `access_limitations[]`：付费墙、登录、审批、许可证或失效链接说明。
- `followups[]`：需要用户确认的下载、申请、复现或后续计划。

需要用户确认的大文件下载、登录申请、受限数据集获取或复现实验，必须优先用 `AskUserQuestion` / 结构化选择 UI 呈现，并复用 `skills/auto-goo/references/interaction-templates.md` 中 `id=research_followup` 的 JSON 模板；不得只写“需要用户确认”或要求用户手打编号。其他处理要求通过 Other 输入，输入后必须先记录风险和边界。推荐结构化选项：

- 只记录下载/申请步骤，不执行
- 执行小型元数据或可访问性检查
- 进入 `/auto-goo:goo-plan` 规划下载/复现任务
- 跳过这些受限资源

如果结构化选择 UI / AskUserQuestion 不可用、调用失败或按钮没有渲染，使用以下纯文本 fallback：

```text
检测到需要确认的后续动作：
1. 只记录下载/申请步骤，不执行
2. 执行小型元数据或可访问性检查
3. 进入 /auto-goo:goo-plan 规划下载/复现任务
4. 跳过这些受限资源

这是 fallback；请回复 1/2/3/4，或直接写你的选择。
```

## 输出摘要

最终回复用户时保持简洁，但必须包含：

- 论文笔记路径。
- Goo-wiki 分析页路径和 `archive.status`；若只是 fallback，明确说明尚未完成 Goo-wiki 归档。
- Manifest 和下载检查路径。
- 已确认可下载的代码/数据。
- 需要登录、申请或用户确认的大文件下载。
- 对需要确认的 followups，优先给出结构化选择；只有交互控件不可用时才给编号 fallback。
- 证据不足或访问失败的部分。
- 后续可执行动作，例如 `/auto-goo:goo-plan <复现这篇论文>`。

## 边界

- 不把第三方复现仓库说成官方代码，除非有明确证据。
- 不绕过付费墙、登录、审批、许可证或非公开分享限制。
- 不自动下载大数据集、大模型权重或大量文件；先说明体积、路径和风险。
- 不覆盖 `.goo/plan.json`；需要转执行 DAG 时，引导用户使用 `/auto-goo:goo-plan` 或 `/auto-goo:goo-start`。
- 不删除论文资料、下载物、wiki 笔记或 `.goo` 产物。
- 不把 `.goo/obsidian/` fallback 当作论文分析的最终归档；恢复写入后必须同步到 Goo-wiki 并补齐项目入口、`log.md` 链接。

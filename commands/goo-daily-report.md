---
name: auto-goo:goo-daily-report
description: 生成 Goo-wiki 日报/周报 — 扫描 Claude Code 和 Codex 会话，写入 journal/daily/
---

# /auto-goo:goo-daily-report — 日报/周报

扫描本机 Claude Code 与 Codex 会话记录，归纳指定日期或日期范围内的工作内容，写入 Goo-wiki `journal/daily/`，并更新 `log.md`。

## 触发

推荐显式调用：

```text
/auto-goo:goo-daily-report
/auto-goo:goo-daily-report 2026-05-20
/auto-goo:goo-daily-report 本周
```

也适用于用户说"日报"、"写日报"、"生成日报"、"总结今天"、"今天干了什么"、"周报"、"周总结"、"weekly report" 或 "daily report"。

## 交互提问

收到 `/auto-goo:goo-daily-report` 后，不要直接扫描会话，必须先通过交互提问确认报告类型和日期范围。所有交互问题必须使用 `AskUserQuestion` / 结构化选择 UI 渲染可点击选项；不得只输出标题后等待用户，也不得要求用户手打编号。必须复用 `skills/auto-goo/references/interaction-templates.md` 中已定义的 `id` 模板；没有匹配 `id` 时按相同 JSON 格式构造新模板。

1. 第一个问题——报告类型（如 `references/interaction-templates.md` 中存在匹配 `id` 则复用，否则新建）：
   - header: 报告类型
   - question: 请选择报告类型。
   - options:
     - label: 日报 (Recommended)
       description: 生成单日日报，扫描指定日期的会话记录。
     - label: 周报
       description: 生成一周汇总，扫描本周一至今日的会话记录。

2. 第二个问题——日期范围（仅当日报模式时询问；周报模式默认本周一到今天）：
   - header: 日期
   - question: 请选择报告日期。
   - options:
     - label: 今天 (Recommended)
       description: 生成今天的日报。
     - label: 昨天
       description: 生成昨天的日报。
     - label: 指定日期
       description: 通过 Other 输入具体日期（YYYY-MM-DD）。

如果结构化选择 UI / AskUserQuestion 不可用、调用失败或按钮没有渲染，使用以下纯文本 fallback：

```
请选择报告类型：
1. 日报 (默认) — 生成单日日报
2. 周报       — 生成一周汇总

请选择日期：
1. 今天 (默认)
2. 昨天
3. 输入具体日期 (YYYY-MM-DD)
```

## 行为

1. 确定日期范围：已通过交互提问获得；无参数默认今天；"昨天"、"今天"、"本周"必须转成具体日期。
2. 按配置优先级解析 Goo-wiki 路径：`AUTOGOO_PLUGIN_WIKI_DIR` → `.goo/config.json` → `~/.auto-goo/config.json` → `~/workspace/Goo-wiki`。
3. **会话采集（collector/session-aggregator）** — 派发 `collector`（session-aggregator）Subagent 运行 `skills/auto-goo/scripts/daily-report-sessions.py --date YYYY-MM-DD` 提取会话摘要；主模型不得内嵌 bash 直接跑该采集脚本。
4. **会话尾部补充（collector）** — 由 `collector` 必要时读取关键会话 JSONL 尾部 20-50 行，只补最终状态、产物路径、提交信息和验证结果；不要逐条抄录对话。
5. **归类合并（collector）** — 由 `collector` 按项目/工作流归类，合并同一目标下的连续会话，返回 session/聚类 evidence packet；主模型只消费 packet 做综合。
6. **写日报（recorder）** — 派发 `recorder` Subagent 写入或续写 `journal/daily/YYYY-MM-DD.md`。如果同日日报已存在，先读取并识别已覆盖内容，只追加新增会话，不整体覆盖。
7. **更新 log（recorder）** — 由 `recorder` 更新 `log.md`，添加到同日段落；没有同日段落时追加 `## YYYY-MM-DD`。

## 日报模板

```markdown
---
title: "日报 - YYYY-MM-DD"
date: YYYY-MM-DD
type: daily-note
tags:
  - daily/YYYY-MM
  - project/<project-tag>
---

# 日报 - YYYY-MM-DD

## 今日工作概览

| 时段 | 内容 | 渠道 |
|------|------|------|
| HH:MM-HH:MM | 简述 | Claude/Codex |

---

## 工作详情

### N. <工作流标题>（`<session_id>`）

- <关键活动>
- <产出物>
- <命令/文件>

---

## Git 提交

| 仓库 | 提交 | 说明 |
|------|------|------|
| `owner/repo` | `hash` | message |

---

## 打开问题

- [ ] <待办>

---

## 明日计划

- [ ] <计划>
```

## 写作规则

- 对每个会话分组，不罗列每条用户消息。
- 保留可复现信息：仓库、路径、命令、提交、产物、验证结果。
- 对敏感信息只写"已配置/已验证"，不输出密钥、令牌、凭据。
- 文件链接使用相对 Goo-wiki 根目录的 wikilink，如 `[[journal/daily/YYYY-MM-DD]]`。
- 周报请求先生成或更新各日素材，再给出一周汇总；不要把一周内容硬塞进单日日报。

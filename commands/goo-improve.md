---
name: auto-goo:goo-improve
description: 启动 AutoGoo-Plugin 插件自改进流程 — 汇总近期执行问题，生成插件优化方案
---

# /auto-goo:goo-improve — 插件自改进

分析近期执行日志中的流程问题，汇总高频摩擦点，生成针对插件文件（SKILL.md、references、settings）的改进方案。

## 执行流程

1. **日志聚类（collector/log-analyst）+ 根因定位（主模型）** — 派发 `collector`（log-analyst）Subagent 读取 `.goo/logs/` 中近 5 个任务的 `## 流程问题` 记录，做确定性的频率统计与聚类（识别出现 >= 2 次的高频问题），返回候选线索 evidence packet。主模型基于 collector 的候选线索做根因定位并生成具体修改方案（可加 researcher 深度解读），产出含 `change_list`（每项 target/action/why/detail）的方案。主模型不亲自 Read/Grep 日志做聚类。
2. **展示与确认（主模型）** — 主模型消费 collector 的候选线索 + 根因修改方案，展示给用户，并优先用 `AskUserQuestion` / 结构化选择 UI 询问用户；用户确认前不编辑插件文件。
3. **应用修改（implementer）** — 用户确认“应用修改”后，派发 `implementer` Subagent 按确认后的 change_list 编辑插件文件（SKILL.md、references、settings）。主模型不亲自编辑插件文件。
4. **记录（recorder）** — 派发 `recorder` Subagent 记录到 `.goo/improvements.log`。

## 确认提问格式

展示改进方案后，必须优先使用 `AskUserQuestion` / 结构化选择 UI，并复用 `skills/auto-goo/references/interaction-templates.md` 中 `id=improve_confirm` 的 JSON 模板。其他修改约束通过 Other 输入，输入后先更新改进方案，不直接编辑插件文件。选项为：

- 应用修改
- 只保存建议
- 放弃本次改进

仅当交互控件不可用时，才使用纯文本 fallback：

```text
这是 fallback：结构化选择 UI 不可用。
请选择如何处理本次 AutoGoo-Plugin 改进方案：
1. 应用修改 - 按上面的方案编辑插件文件
2. 只保存建议 - 记录到 .goo/improvements.log，不改插件文件
3. 放弃本次改进 - 不写入、不修改

请回复 1/2/3，或回复“应用修改”/“只保存建议”/“放弃”。
```

用户未明确选择“应用修改”或 fallback 中的 `1` 前，不得编辑插件文件。

## 示例

```
/auto-goo:goo-improve
优化AutoGoo-Plugin
自改进
```

## 备注

- 仅建议；未通过结构化选择或 fallback 得到用户明确确认前，不改插件文件
- 详见 `skills/auto-goo/references/self-improvement.md`

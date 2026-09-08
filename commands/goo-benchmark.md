---
name: auto-goo:goo-benchmark
description: 启动性能评测与优化迭代 — 搜索指标、基线评测、瓶颈分析、优化对比
---

# /auto-goo:goo-benchmark — 启动优化迭代

对当前任务或指定功能执行性能评测与优化迭代。

## 交互提问

收到 `/auto-goo:goo-benchmark` 后，不要直接开始评测，必须先通过交互提问确认评测范围和迭代上限。所有交互问题必须使用 `AskUserQuestion` / 结构化选择 UI 渲染可点击选项；不得只输出标题后等待用户，也不得要求用户手打编号。必须复用 `skills/auto-goo/references/interaction-templates.md` 中已定义的 `id` 模板；没有匹配 `id` 时按相同 JSON 格式构造新模板。

1. 第一个问题——评测范围：
   - header: 评测目标
   - question: 请选择本次性能评测的范围。
   - options:
     - label: 当前任务 (Recommended)
       description: 对当前正在进行的工作流步骤进行基准评测和优化迭代。
     - label: 指定功能或文件
       description: 通过 Other 输入具体需要评测的功能模块或文件路径。
     - label: 全局审查
       description: 扫描整个项目，发现性能瓶颈后选择重点区域评测。

2. 第二个问题——迭代上限：
   - header: 迭代轮数
   - question: 最多允许几轮优化迭代。
   - options:
     - label: 3 轮 (Recommended)
       description: 默认 3 轮，提升不足 20% 时提前终止。
     - label: 5 轮
       description: 允许更多迭代，适合复杂场景。
     - label: 不限轮数
       description: 持续优化直到连续两轮提升 < 5%。

如果结构化选择 UI / AskUserQuestion 不可用、调用失败或按钮没有渲染，使用以下纯文本 fallback：

```
请选择评测范围：
1. 当前任务 (默认)
2. 指定功能或文件
3. 全局审查

请选择迭代上限：
1. 3 轮 (默认)
2. 5 轮
3. 不限轮数
```

## 执行流程

1. 通过交互提问确认评测范围和迭代上限（见上方）。
2. **指标搜索（researcher）** — 派发 `researcher` Subagent 用 WebSearch 搜索该领域标准评价指标，返回指标 evidence packet（含指标定义、单位、基线参考、采集方法）。
3. **基线实现（implementer）** — 派发 `implementer` Subagent 按 researcher 的指标 packet 实现基线版本。
4. **基线评测（evaluator）** — 派发 `evaluator` Subagent 评测基线（至少 3 次取平均），返回评测结果 packet。主模型不亲自跑基准做首次测量。
5. **瓶颈分析（researcher）** — 派发 `researcher` Subagent 做瓶颈分析（cProfile / py-spy / tracemalloc / 大 O 推算），返回瓶颈 evidence packet。
6. **优化与对比（implementer + evaluator）** — 派发 `implementer` 实现优化，`evaluator` 用同指标评测对比，返回对比 packet。
7. **终止判断（主模型）** — 主模型基于 evaluator 的对比 packet 做终止判断：提升 < 20% 或连续两轮 < 5% 停止。

## 示例

```
/auto-goo:goo-benchmark
优化
评测
```

## 备注

- 默认最多 3 轮优化迭代
- 计时与内存测量分开进行
- 详见 `skills/auto-goo/references/optimization-loop.md`

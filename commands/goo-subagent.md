---
name: auto-goo:goo-subagent
description: 查看 subagent 实时活动 — 状态栏下面的 widget 与可切换进去的完整时间线
---

# /auto-goo:goo-subagent — subagent 实时活动

派发 subagent 后，**它在做什么**以前只能从工具输出的滚屏里瞥一眼。现在有两层可观测：

| 层 | 形态 | 回答的问题 |
| --- | --- | --- |
| **widget** | `ctx.ui.setWidget(..., { placement: "belowEditor" })`，常驻状态栏下面 | "还在跑吗 / 刚做了什么" |
| **面板** | `ctx.ui.custom` 全屏面板 | "这个 step 到底做了什么" |

## 用法

```text
/goo-subagent      # 打开完整面板
```

或按 **`alt+a`**（`ctrl+*` 基本被 pi 内置键位占满，故用 `alt+a`）。

## widget（状态栏下面）

```
● subagent 运行中（2）
  ► #1 implementer/feature-builder
    💬 我先看一下 locks.ts
    ⚙ ⟦read: src/utils/locks.ts⟧
    ↳ ⟦result⟧ 120 lines
  ► #2 evaluator
    ⚙ ⟦grep: TODO in src/⟧
```

- 只列**运行中**的 step；全部结束后显示「最近一次」的最后状态
- 事件图标：`💬` 模型文本 · `⚙` 工具调用（**带真实参数**）· `↳` 工具结果
- 每次活动推送即重绘（`activityBus` 直接调用 `tui.requestRender()`，不轮询）

## 面板

```
 AutoGoo Subagent                    2 个 step · 2 运行中
──────────────────────────────────────────────────────────
 › ► #1   implementer/feature-builder running  0s 前开始 · ⟦bash: npm te…
   ► #2   evaluator                   running  0s 前开始 · ⟦grep: TODO in src/⟧
──────────────────────────────────────────────────────────
  💬 我先看一下 locks.ts
  ⚙ ⟦read: src/utils/locks.ts⟧
  ↳ ⟦result⟧ 120 lines
  ⚙ ⟦bash: npm test -- locks⟧
──────────────────────────────────────────────────────────
 ↑↓ 切 step  ·  c 清空记录  ·  q 退出
```

| 按键 | 动作 |
| --- | --- |
| `↑↓` / `jk` | 切换 step |
| `c` | 清空活动记录 |
| `q` / `Esc` | 退出 |

## 边界

- 活动记录**只在内存**，不落盘 —— 这是运行时可观测性，审计仍看 step log。
- 每个 step 保留最近 400 条事件、最多 20 个 step（FIFO 淘汰）。
- `session_shutdown` 时清理 widget，避免跨会话残留。
- 非 TUI 模式退化为一行文本摘要。

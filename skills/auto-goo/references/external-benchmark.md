# 外部对标：6 个编排/记忆项目的借鉴判断

> 调研日期 **2026-11-16**（star 数为当日 GitHub Search API 快照）。本文件的目的不是「别人有什么」，
> 而是**每条借鉴都绑定本仓库一个实测缺口**，每条不借鉴都给理由。
> 复现方法见 §五，10 分钟内可重跑（含匿名限流绕过）。

## 结论先行

| 外部能力 | 本仓库缺口（实测） | 结论 | 归属 |
|---|---|---|---|
| Durable execution（durable run / checkpoint / 幂等） | plan 无 `schema_version`；`--resume` 只改状态不续跑；重试无幂等保护 | **做**（最高优先） | g1 |
| 版本亲和（versioned workflows） | 0.27.0 把 memory_layer L0↔L3 语义**全量翻转**后，旧 plan 仍按新语义解释且静默 | **做**（只借「版本字段 + 迁移矩阵」这一半，不借「灰度和流量切分」） | g1 |
| Alerting（失败/卡住的主动通知） | 停滞检测是**拉取式**（只有主 Agent 再调 `auto_goo_schedule` 才检查），无人值守时零信号 | **做** | g2 |
| 执行指标体系（DAG 自身指标） | `observe` 面板只有 recall 一栏；`recall.jsonl` 有，`exec.jsonl` **不存在** | **做** | g2 |
| Knowledge Graph（图遍历召回） | 785 篇 3713 条 wikilink，但 `PageHit.links` 是**死字段**，无反向链接/无遍历 | **做**（先出图形状数据再决定） | g3 |
| 从行为提取记忆 | 有 `memory_layer` 分层与 lessons，但触发信号是「任务结束后人工总结」，非行为 | **不做**（理由见 §四.3） | — |
| Worktree / 写隔离 | `auto_goo_worktree_create` 已实现，**派发路径零引用**；写冲突只告警 | **做（接线，不新建）** | g4 |
| 生产级 DAG 编排（rill-flow） | 本仓库是单机 Agent 编排，非高吞吐数据管道 | **不借鉴**（理由见 §四.2） | — |
| Multi-CLI 跨平台 DAG | 已明确排除 | **不做**（用户已决定，不写入待办） | — |

**一句话**：与本项目的真实差距**不在功能数量，在「崩溃后能不能安全继续」和「停了有没有人知道」**。g1+g2 是同一件事的两半，g3/g4 是次优先。

---

## 一、6 个项目的定位与核心能力

只记录**与本项目决策相关**的能力，不做完整功能罗列。来源均为当日 raw README / GitHub API。

### 1. hatchet-dev/hatchet — 8,295★

- **定位**：An orchestration engine for background tasks, AI agents, and **durable workflows**。
- **核心**：queuing、automatic retries、**durability**、real-time monitoring、**alerting**、logging。
- **为什么看它**：它是「durable」这个词的第一梯队实现，而本项目的 DAG 状态机是**尽力而为**语义 —— 进程死掉后 plan 里留下一个 `running` 步骤，没有任何机制能判断它到底做了多少。
- **注意**：它是**队列 + worker + 持久事件日志**的长驻服务架构，不是 Agent 编排。所以借鉴的是**语义**（durability / idempotency / alerting 三件套），不是架构。

### 2. inferablehq/inferable — 451★

- **定位**：Build reliable AI Workflows with humans in the loop。
- **核心**：durable execution runtime、**versioned workflows（保持 version affinity，已在跑的执行不被新部署打断）**、human-in-the-loop。
- **为什么看它**：它是**同类形态**（Agent/workflow 混合 + 需要人介入）里唯一把「版本」当第一类概念的。本项目的 plan schema 完全没有版本概念。
- **注意**：它的 version affinity 解决的是「多副本部署时新代码不要抢走旧执行」，本项目是**单机单进程**，这一半不适用（见 §四.1）。

### 3. MemMachine/MemMachine — 3,088★

- **定位**：long-term memory layer for AI agents。
- **核心**：**Episodic（图）/ Profile（SQL 结构化）/ Working（会话）三层**；记忆跨重启、跨 session、跨模型变更存活。
- **为什么看它**：本项目有 L0–L3 分层，但**分层维度是「热度/粒度」，不是「类型」**。MemMachine 的 Episodic=图 这一条，正好对应本项目的 `[[wikilink]]` 网络 —— 一个天然的图，却只被当字符串列表用。
- **注意**：它的 Profile 层（SQL 存"用户是谁"）对应本项目 `CLAUDE.md` / `config.json`，已有；Episodic 对应 wiki 图，缺；Working 对应 plan/session，已有。**只有 1/3 是缺口**，所以不整体借鉴。

### 4. MemoriLabs/Memori — 17,590★

- **定位**：Memory from what agents **do**, not just what they say。
- **核心**：从**行为**中自动提取记忆，而非仅从对话中提取。
- **为什么看它**：本项目目前的记忆来源是「主 Agent 在归档阶段总结」，这是**说**（self-report），不是**做**（observed behavior）。17.6k★ 说明这个区分有共识。
- **注意**：它的输入是**高频 Agent 运行轨迹**（每次工具调用都是信号）。本项目一次 DAG 只有 5–7 步、几小时，行为信号密度低两个数量级（见 §四.3）。

### 5. catlog22/Claude-Code-Workflow — 2,113★（已归档，后继 Maestro Flow）

- **定位**：JSON-driven multi-agent development framework。
- **核心**：Skill-based workflows、**Multi-CLI Orchestration**、**Knowledge Graph**、hook system、team collaboration。
- **为什么看它**：它是**最接近的同形态项目**（Claude Code 上的多 Agent 编排框架），而且它已归档 —— 归档原因本身是有价值的信息（我们的目标不是成为它）。
- **注意**：它的两个亮点对本项目**一个适用一个不适用** —— Knowledge Graph 适用（g3），Multi-CLI 不适用（用户已明确排除跨平台 DAG）。

### 6. weibocom/rill-flow — 411★

- **定位**：high-performance scalable workflow orchestration。
- **核心**：国内生产级 DAG 编排（高吞吐、可扩展）。
- **为什么看它**：为了**确认不借鉴**。它解决的是「百万级任务吞吐」，本项目解决的是「一次复杂任务的可恢复执行」——同名 DAG，问题不同。

---

## 二、逐项差异表：「为什么需要 / 不需要」

判断标准：**这个差异会不会让本项目的某次真实执行出错或停滞？** 会 → 需要；只会让功能表更长 → 不需要。

| 维度 | 外部做法 | 本项目现状（实测） | 判断 |
|---|---|---|---|
| **状态持久化粒度** | Hatchet/Inferable：每次状态转换写**持久事件日志**，可从任意点重放 | plan.json 是**快照**，无事件流；`update-step.py` 直接改字段 | **需要**。快照无法回答「这个 running 步骤到底执行到哪了」。这是 g1 的根 |
| **恢复语义** | Hatchet：durable run 从最后一个 event 继续 | `--resume` 仅把 status 改回 `running`（`update-step.py:347`），subagent **从头重跑** | **需要**。重跑会让已产生的副作用重复（写文件、推 commit、发通知） |
| **重试安全性** | Hatchet/Inferable：retry 默认要求幂等或显式 idempotency key | `MAX_RETRIES = 1`（`execute.ts:121`）自动重试，无任何幂等约束 | **需要**。有自动重试却没有幂等保护，是「帮倒忙」的配置 |
| **schema 演进** | Inferable：workflow 有版本，执行绑定版本 | plan.json 顶层 keys 无 `schema_version`（实测：`task/goals/status/thread/created_at/.../steps/updated_at`） | **需要**。0.27.0 翻转 L0↔L3 语义（commit `c7524eb`，`refactor(memory)!`）后旧 plan 静默错误 |
| **失败通知** | Hatchet：alerting 是核心能力 | 停滞检测**存在但拉取式**（`execute.ts:670-760`，只在主 Agent 再调 schedule 时执行，结果只回一段文本） | **需要**。上一轮 7 步 DAG 跑 2h12m，中途停顿全靠人工反复调 `auto_goo_dag_status` |
| **执行指标** | Hatchet：real-time monitoring 面板 | `observe` 面板只有 recall（`status.ts:89` 读 `recall.jsonl`）；`exec.jsonl` 全局 grep **零命中** | **需要**。现在无法回答「哪些 step 最容易超时」 |
| **图的用法** | Maestro Flow / MemMachine：Knowledge Graph 参与召回 | 785 篇 / 3713 条 wikilink / 977 个唯一目标；`wiki-graph-assist.py:200` 抽 `links[:8]` 存进 `PageHit`，但 `.links` **全代码零引用**（死字段） | **需要（先量后做）**。图是现成的，一次都没当图用过 |
| **写隔离** | Maestro Flow：team collaboration 有隔离 | 写冲突检测**只告警不阻止**（`execute.ts:292` 注释原话）；`auto_goo_worktree_create` 已实现但**派发路径零引用** | **需要（接线）**。不是缺能力，是能力闲置 |
| **吞吐/分布式** | rill-flow：高吞吐可扩展 DAG | 单机、单进程、7 步 DAG、17 个 live thread | **不需要**。量级差 4 个数量级 |
| **多运行时混跑** | Maestro Flow：Multi-CLI | pi / CC / Codex 三端各自实现，行为需手工对齐 | **不需要**（用户已明确排除，理由见 §四.4） |
| **记忆提取来源** | Memori：从行为提取 | 归档靠主 Agent 自述总结 | **不需要（现阶段）**，见 §四.3 |

---

## 三、借鉴结论 → g1/g2/g3/g4

### g1 — Durable execution：版本化 + checkpoint + 幂等

**借什么**：Hatchet 的 durability 语义（状态转换可重放）+ Inferable 的**版本字段**（不含 version affinity）。

**绑定缺口（实测）**：

```bash
# ① 无 schema_version
python3 -c "import json;print(list(json.load(open('.goo/plan.json')).keys()))"
# → ['task','goals','status','thread','created_at','started_at','completed_at',
#    'max_concurrent','wiki_context','context_digest','context_artifacts','steps','updated_at']
#    没有 schema_version

# ② --resume 只改状态（update-step.py:347-355）
sed -n '347,355p' skills/auto-goo/scripts/update-step.py
# → 校验 status ∈ (interrupted, failed) 后只写 status/heartbeat_at/started_at/agent_id
#    没有任何「已做到哪一步」的依据可供跳过，所以 subagent 必然从头重跑

# ③ 无 step 级幂等键
grep -rn "idempoten\|idempotency_key" --include=*.ts .pi/extensions/autogoo-plugin | grep -v __tests__
# → 零命中（唯一的 idempotent 字样在 locks.ts 注释里是「锁获取对同一 thread 幂等」，与重试无关）
```

**真实事故链**：0.27.0 的 commit message 自己带 `!`（breaking）——`refactor(memory)!: L0-L3 编号方向反转`。
翻转后**所有旧 plan 的 `memory_layer` 注解语义全部反了**（L0 原意"原始记录"变成"项目总览"），
而加载路径没有任何版本校验，因此**静默按新语义解释**。这就是「没有 schema_version」的具体代价，不是理论风险。

**不借的部分**：Inferable 的 version affinity 解决多副本流量切分，本项目单进程无此问题。

### g2 — 执行告警 + DAG 指标

**借什么**：Hatchet 的 alerting（主动推送）+ real-time monitoring（阈值面板）。

**绑定缺口（实测）**：

```bash
# 停滞检测是拉取式：只有 schedule/heartbeat_check 被调用时才执行，
# 且结果只作为 content 文本返回，无 ctx.ui.notify、无 webhook、无落盘
sed -n '726,760p' .pi/extensions/autogoo-plugin/tools/execute.ts

# observe 面板只有 recall 一栏
grep -n "readRecallStats\|recall:" .pi/extensions/autogoo-plugin/commands/status.ts
# → status.ts:89  recall: readRecallStats(...)   —— 无 exec 指标

# exec.jsonl 不存在
grep -rn "exec.jsonl" --include=*.ts --include=*.py . | grep -v node_modules
# → 零命中（对照：recall.jsonl 在 recall-observe.ts:53 有明确路径）
```

**关键区别要写清**：停滞检测**不是没有**，是**没人问就不检查**。无人值守（用户关掉 TUI、去睡觉）时，
一个 DAG 卡在 stale 状态可以无限期挂着 —— 这跟「没有检测」在后果上等价，在修法上不同（只需把 pull 改 push，不必重写检测逻辑）。

**指标口径复用**：`recall.jsonl` 已经验证了 JSONL + 轮转 + `status.ts` 聚合这套约定，`exec.jsonl` 直接照抄，不引入新范式。

### g3 — wiki 图结构真正利用

**借什么**：Maestro Flow / MemMachine 的 Knowledge Graph —— 但只借「反向链接 + 1–2 跳遍历」，不借「社区发现」这种需要调参的复杂图算法。

**绑定缺口（实测数据，2026-11-16 在 `/home/zixigu/workspace/Goo-wiki` 量得）**：

| 指标 | 数值 | 说明 |
|---|---|---|
| wiki markdown 页面 | **785** | 图规模不大，纯 Python 足够 |
| wikilink 出现次数 | **3,713** | 边是真实存在的、密度不低 |
| 唯一链接目标 | **977** | 有相当多指向不存在/不同路径的目标 |
| 无法按 basename 解析的目标 | **111** | 链接解析歧义确实存在 |
| **零入链页面（无反向链接）** | **62（7%）** | 这些笔记被写完后从未被任何页面引用 |
| **真孤岛（无入链且无出链）** | **48** | |
| basename 冲突组 | **22**（其中 `index.md` **75 个**、`record.md` 70 个） | 按 basename 解析必然歧义 |

**代码证据**：

```bash
grep -n "\.links" skills/auto-goo/scripts/wiki-graph-assist.py
# → 无输出。PageHit.links 在 :200 被赋值（links[:8]），但全代码从未被读取
#    —— 图数据被采集了、携带了、然后丢弃了
```

所以准确的表述不是「本项目没有图」，而是**「这是一个图，但从未被当作图使用」**（brainstorm g3 的原话，此处已用数据坐实）。

**先量后做的理由**：48 个孤岛 / 62 个零入链页面意味着**反向链接索引的收益上限有限**（7% 的页面是新增信息），
但 3,713 条边的遍历扩张收益未知 —— 所以 g3 的 first_step 保持为「先出图形状数据」，不做承诺。

**只报告不删除**：孤岛检测只输出清单，不复用 `wiki-gov.py` 之外的写操作（零删除约定）。

### g4 — 写冲突从「告警」升级为「隔离」

**借什么**：不要借 Maestro Flow 的 team collaboration —— **本项目已有的 worktree 能力没有接线，这才是缺口**。

**绑定缺口（实测）**：

```bash
# ① 写冲突只告警
sed -n '292,308p' .pi/extensions/autogoo-plugin/tools/execute.ts
# → 注释原话："并行写冲突：只告警不阻止（自动串行会拖慢本就该并行的任务）"
#    detectWriteConflicts() 之后只做两件事：print + 给两个 step 各写一条 heartbeat note

# ② worktree 能力已实现但零派发引用
grep -rln "auto_goo_worktree_create" --include=*.ts --include=*.md --include=*.py .
# → tools/worktree.ts（定义）、README.md、docs/subagent-execution.md、
#    __tests__/commands-smoke.test.ts
#    execute.ts / subagent.ts / 派发路径：**零引用**
```

**为什么「有工具没接线」值得单独列为 g4**：这是本项目反复出现的同一类缺陷模式
（此前 `planning.recall_wiki`、`heartbeat_seconds` 同型）。判据不是「有没有这个函数」，而是「派发路径会不会调用它」。

**风险与降级**：worktree 需要 git repo → 非 git 项目降级为串行，不直接失败；默认关闭避免给所有任务加开销。

---

## 四、不借鉴清单（附理由）

### 1. Inferable 的 version affinity（多版本执行并存）

**不借**：它解决「新版部署上线时，已在跑的执行不能被新代码抢走」。本项目是**单机单进程、plan 文件即状态**，
不存在多副本争抢同一个执行。**借版本字段（做），不借流量切分（不做）** —— 这是 g1「只借一半」的依据。

### 2. rill-flow 的高吞吐 DAG 编排

**不借**：量级差 4 个数量级。本项目 17 个 live thread、单次 DAG 5–7 步；rill-flow 面向百万级任务吞吐。
两者共享「DAG」这个词但**不共享问题**：本项目要解决「一次复杂任务崩溃后能不能继续」，不是「怎样调度百万任务」。
借它的调度器只会引入它面对的那套复杂度（分片、队列、worker 池），而本项目一个都不需要。

### 3. Memori 的「从行为提取记忆」

**不借（现阶段）**，三条理由：

1. **信号密度差两个数量级**：Memori 的输入是高频 Agent 运行轨迹（每次工具调用都是信号）。本项目一次 DAG 只有 5–7 步、
   耗时数小时 —— 行为样本数量根本不足以训练/推断出稳定的记忆条目。
2. **已有替代路径且工作正常**：`memory_layer` 分层 + lessons + `context_digest` 已经承担这个职责，
   而且**归档阶段的显式总结**在本项目的验证闭环里（下一步能召回）比自动提取更可控。
3. **会与「精炼优先」冲突**：行为自动提取的典型产物是**大量低价值原子事件**，而本项目的 epicenter 是
   「归档不是收尾作文，要记录可复用结论」。自动提取会朝反方向走（量增、判断力降）。

**触发条件**（什么情况下改判）：如果未来单个 thread 的步骤数进入百级、或引入长驻 daemon 持续运行，
信号密度前提成立，重新评估。

### 4. Maestro Flow 的 Multi-CLI 跨平台 DAG

**不借**：用户已明确决定不考虑（跨 pi/CC/Codex 混跑）。**不写入待办**。
本条记录于此仅为避免下一轮调研重复提出同一提案 —— 写进文档的「不借」比留在记忆里的「否决」更能防止回滚。

### 5. MemMachine 的整体三层记忆架构

**不借整体，借其中一处**：三层里 Profile（`CLAUDE.md`/`config.json`）与 Working（plan/session）本项目已有；
只有 Episodic（图）是缺口，且这个缺口已归入 g3。**不引入「三层」作为新架构** —— 会与现有 L0–L3 热度分层正交冲突，
得到 4×3 的矩阵式分类，收益远小于维护成本。

---

## 五、调研方法备忘（可复现，10 分钟内重跑）

### 5.1 匿名限流：GitHub Search API 只有 60 请求/小时

本次调研**撞到限流**（403 rate limit exceeded）。下次不要重试同一个接口，用以下顺序：

```bash
# 步骤 0：先看还有多少配额（不计入 search 限额）
curl -sS https://api.github.com/rate_limit | python3 -c \
  "import json,sys; r=json.load(sys.stdin)['resources']; print({k:(v['remaining'],v['limit']) for k,v in r.items() if k in ('core','search')})"

# 步骤 1：一次 search 拿到一批候选（每个 query 只花 1 次配额，不要按项目逐个查）
curl -sS -H 'Accept: application/vnd.github+json' \
  'https://api.github.com/search/repositories?q=durable+workflow+agent+orchestration&sort=stars&order=desc&per_page=10' \
  | python3 -c "import json,sys; [print(r['full_name'], r['stargazers_count'], '|', (r['description'] or '')[:80]) for r in json.load(sys.stdin)['items']]"
```

**关键**：`search/repositories` 与 `repos/{owner}/{repo}` 是**两个独立配额池**，
但两者都会打满。所以星数/描述用 search 一次批量拿，**之后只走 raw**。

### 5.2 raw README 读法（不消耗任何 API 配额）

```bash
for r in hatchet-dev/hatchet inferablehq/inferable MemMachine/MemMachine \
         MemoriLabs/Memori catlog22/Claude-Code-Workflow weibocom/rill-flow; do
  echo "=== $r ==="
  # 默认分支名未知 → 两个候选都试；-f 让 404 直接失败便于 break
  for br in main master; do
    if curl -sfL "https://raw.githubusercontent.com/$r/$br/README.md" -o /tmp/readme.md; then
      head -60 /tmp/readme.md; break
    fi
  done
done
```

**三个坑**（本次都踩过或规避过）：

1. **默认分支不一定是 main**。不要猜，用一条不耗配额的 git 命令确认：
   `git ls-remote --symref https://github.com/OWNER/REPO HEAD | head -1` → 输出 `ref: refs/heads/<branch>`。
   这与本项目 `goo-update-check.py` 的结论一致（该脚本因 GitHub API 403 改用 `git ls-remote`）。
2. **README 可能是宣传页**。判断「定位」用 README 首段 + 一级标题即可；
   判断「核心能力」只取**作者主动列为特性的一级名词**（queuing / alerting / durability），
   不要从正文叙述里推演能力 —— 那是幻觉的主要来源。
3. **star 数只作信号强度，不作质量结论**。Memori 17.6k★ 但只贡献了 1/3 缺口；inferable 451★ 却贡献了 g1 的关键一半。

### 5.3 本项目缺口取证（比调研更重要的是这一步）

外部对标的价值完全取决于本地缺口是否真实。取证模板（换成任意 `PATTERN`）：

```bash
PATTERN="schema_version"
# ① 实现面：扩展 + 脚本（排掉 .goo 数据与 node_modules）
grep -rn "$PATTERN" --include=*.ts --include=*.py .pi skills | grep -v node_modules
# ② 调用面：能力是否真的在派发路径上被引用（"有实现"≠"会被调用"）
grep -rln "auto_goo_worktree_create" --include=*.ts .pi | grep -v __tests__
# ③ 数据面：产物是否真的存在（对照同类的既有实现，如 recall.jsonl）
grep -rn "exec.jsonl" --include=*.ts --include=*.py . | grep -v node_modules
```

**判据（写进结论前必须过）**：

- 「有定义」不算缺口，**「派发路径不调用」才算**（g4 就是这一条的产物）。
- 「文档里写了」不算实现，**要能 grep 到代码**（本项目已有 525 处 dangling 引用的历史，见 lessons）。
- 「理论上可能错误」不算缺口，**要指到具体那次事故**（g1 指到 0.27.0 的 L0↔L3 翻转）。

### 5.4 wiki 图数据复现

```bash
cd /home/zixigu/workspace/Goo-wiki
find wiki -name "*.md" | wc -l                                    # 785
grep -ro "\[\[[^]|#]*" wiki --include=*.md | wc -l                # 3713
grep -rho "\[\[[^]|#]*" wiki --include=*.md | sed 's/\[\[//' | sort -u | wc -l   # 977
find wiki -name "*.md" | sed 's|.*/||' | sort | uniq -c | sort -rn | head -5     # 75x index.md
```

> 注意：按 basename 解析会有歧义（22 组重名、`index.md` 75 个），
> 所以 §三 g3 表格里「零入链 62 篇 / 孤岛 48 篇」是**保守下界估计**，不是精确值。
> 做 g3 时需要先确定链接解析策略（`[[完整/路径]]` 优先 + basename 兜底）。

---

## 六、给下一轮的直接输入

1. **g1 的 first_step 不变**：统计现有 plan 字段差异（17 个 live thread + `plans/history/`）→ 定迁移边界。
2. **g2 可以立刻开始**：`exec.jsonl` 字段设计无外部依赖，且能与 g1 的 checkpoint 共用字段。
3. **g3 要先回答一个问题**：链接解析策略（路径优先 vs basename）决定 111 个悬空目标与 75 个 `index.md` 的处理方式，先定策略再谈遍历。
4. **g4 只需要接线验证**：跑一次单步 worktree 派发，确认 `auto_goo_worktree_create` 真能用（它目前只有 smoke test 覆盖）。

## 相关

- 目标来源：`.goo/brainstorm.json`（id `brainstorm-2026-11-16-external-benchmark`）
- 分区依据：`references/self-improvement.md`（改进触发条件与决策规则）
- 归档规范：`references/obsidian-archive.md`（wikilink 与项目 index/log 维护）

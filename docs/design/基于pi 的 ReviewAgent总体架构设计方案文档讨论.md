> **角色注记（2026-09-18）**：本文档是讨论输入，**不是 spec 真源**——基于上游 pi 仓库（npm/SDK 视角）撰写，后正式化为 v1.0 并合并旧架构文档的内核无关内容。姿态判断（agent-core + pi-ai 底座、自研 Review Runtime）与 [ADR-0009](../adr/0009-pi-kernel-from-scratch-rewrites-review-runtime.md) 相互印证；与拍板决策及实测数据相悖处以后者为准，主要有三：① §9.3 配置 E 仍标「本项目主力系统形态」——生产主线已拍板为 B（零工具 + 确定性预取，2026-09-17；E 的 Ledger 实测负收益）；② §9.5 以配置 C 为「效果上限」主锚——phase2 已实测 C 锚坍缩，锚相对结论须带警示、生产 KPI 用绝对指标；③ §3.2 称「固定骨架 + 阶段内自主检索」为 POC1 已验证形态——实测多轮/工具开销无质量增益，混合形态归 C/D/E 消融面。本文全部有效内容（含生产拓扑等增量与文首四项拍板）已折入《[基于 Pi 内核的 Review Agent 总体架构设计方案](基于 Pi 内核的 Review Agent 总体架构设计方案.md)》；pi 能力事实以本仓 fork 源码核实为准（《[Pi 内核演化缝盘点](Pi 内核演化缝盘点.md)》）。

基于我刚刚对 Pi 当前源码与 SDK 的核对，我建议这份方案不再把 Pi 当成“现成 Coding Agent”，而是明确定位为：

> **以 `pi-agent-core + pi-ai` 为运行底座，自研 Review Runtime；`pi-coding-agent` 只复用 Session / SDK / ResourceLoader / Compaction 等成熟能力，避免把通用 Coding Agent 的复杂能力带进 Review 场景。**

当前 Pi 仓库已经明确拆分为 `pi-ai`（统一多模型 API）、`pi-agent-core`（Agent Runtime、Tool Calling、State Management）和 `pi-coding-agent`（完整 Coding Agent CLI）。([GitHub][1]) Pi 的低层 Agent Loop 已提供 `beforeToolCall`、`afterToolCall`、`shouldStopAfterTurn`、并行/串行 Tool Execution、Session ID 等控制点；同时支持 `transformContext()` 在发送给 LLM 前裁剪/注入上下文。([GitHub][2]) `pi-coding-agent` 的 SDK 还提供自定义 Tool、Tool Allowlist、Session、Compaction、事件订阅、ResourceLoader 等能力。([GitHub][3])

下面是一份可以直接作为技术评审基线的总体架构设计方案。

# 基于 Pi 的 ReviewAgent 总体架构设计方案

> **修订记录（v1.0，2026-09-18）**：在讨论稿基础上正式化——合并《基于 DeepSeek Harness 的 Review Agent 总体架构设计方案》（v2.1）中**内核无关**的实验纪律与评测方法论（五配置矩阵、判定链、逆补丁数据集、S/A/B 判级、缓存语义与冷热协议、消融清单、零构建纪律等，逐项落点见各节）；DSH 内核相关内容（插件挂接、能力核对、阶段路线）不并入——分别由本文的 Pi 原语表述与《Pi 内核从零实现方案》P0–P5 路线承担。文中引用的 Pi 能力（`agentLoop` 钩子 / `transformContext` / Tool Allowlist / `Model.baseUrl` / `onPayload`）已由《Pi 内核从零实现方案》§4 逐项核实。
> **冲突决策（2026-09-18 拍板）**：① Claude Code 列入主对照列（注明模型不同源，见 §9.3）；② 单实验内锁定单模型 + 单 effort 档位（见 §9.3 实验纪律）；③ 预算口径统一（`max_output` = 1K，分层预算见 §3.4）；④ 代码智能 Java 单语言先行、语言适配留 seam（见 §4.3）。

## 1. 项目定位与总体目标

### 1.1 项目定位

ReviewAgent 是一个面向代码检视场景的专用 AI Agent。

它不是：

> “Pi Coding Agent + 一个 Review Prompt”

也不是：

> “Mini Claude Code”

而是：

> **基于 Pi Agent Runtime 能力重新构建的专用 Review Runtime。**

项目姿态：**研究先行**——先用实验验证核心命题（Benchmark 与实验协议见 §9），终局为落地到企业内部代码托管平台的 MR 检视；届时检视目标只提供**静态源码快照、无构建环境**（该约束直接决定代码智能的技术选型，见 §4.3）。

核心目标：

```text id="m3f3p9"
Git Diff
  ↓
Change Understanding
  ↓
Risk Detection
  ↓
Minimal Sufficient Context
  ↓
Review Reasoning
  ↓
Evidence Verification
  ↓
Structured Finding
```

---

### 1.2 项目核心技术命题

项目核心不是单纯追求：

> Review 准确率更高

而是同时优化：

```text id="4gclyw"
Review Quality
+
Context Efficiency
+
Cache Efficiency
+
Agent Efficiency
```

最终形成：

> **高质量 / 低 Token / 高 Cache / 低延迟**

---

### 1.3 为什么选择 Pi

当前 Pi 已经把 Agent 能力拆成：

```text id="1uiqv2"
pi-ai
     ↓
统一 LLM Provider

pi-agent-core
     ↓
Agent Loop
Tool Calling
State Management

pi-coding-agent
     ↓
Session
SDK
Extension
Compaction
CLI
RPC
```

官方仓库明确把 `pi-agent-core` 定义为 Agent runtime，把 `pi-ai` 定义为统一多 Provider API，而 `pi-coding-agent` 是更完整的 Coding Agent。

因此 ReviewAgent 建议：

> **以 `pi-agent-core + pi-ai` 为核心底座，自研 Review Runtime。**

只按需使用 `pi-coding-agent` 已有的成熟基础设施。

---

### 1.4 总体原则

整个项目遵循：

```text id="7a7kq6"
专用优于通用
Diff-first ≠ Diff-only
Minimal Context 优于 Full Context
Evidence 优于 Guess
Bounded Loop 优于无限 Loop
Stable Context 优于动态重构
Cache-aware 优于只看 Token
Read-only 优先
Benchmark 驱动
```

---

## 2. 总体系统架构

### 2.1 总体架构

```text id="drk22m"
                       GitHub / GitLab / Gerrit
                                  │
                           Webhook / CLI / CI
                                  ↓
                    ┌─────────────────────────┐
                    │   Review Gateway        │
                    │ Job / Policy / Trigger   │
                    └────────────┬────────────┘
                                 ↓
                    ┌─────────────────────────┐
                    │    ReviewAgent Core      │
                    │                         │
                    │  Review Runtime          │
                    │  Context Engine          │
                    │  Cache Engine            │
                    │  Knowledge Engine        │
                    │  Evidence Engine        │
                    └────────────┬────────────┘
                                 ↓
                    ┌─────────────────────────┐
                    │      Pi Runtime         │
                    │                         │
                    │ pi-agent-core            │
                    │ pi-ai                    │
                    │ Session / Tool / SDK     │
                    └────────────┬────────────┘
                                 ↓
                          DeepSeek / Claude /
                         Qwen / OpenAI / Local
```

---

### 2.2 分层职责

| 层次               | 主要职责                         |
| ---------------- | ---------------------------- |
| Code Platform    | PR / MR / Commit / Comment   |
| Review Gateway   | Job、鉴权、调度、去重                 |
| ReviewAgent Core | Review Intelligence          |
| Review Runtime   | Review Loop / Risk / Budget  |
| Context Engine   | Diff / Symbol / Impact       |
| Cache Engine     | Prefix / Ledger / Cache      |
| Knowledge Engine | Rule / CWD / History         |
| Evidence Engine  | Finding Verification         |
| Pi Runtime       | Agent / Session / Tool / LLM |

核心原则：

> **平台负责“什么时候 Review”，ReviewAgent 负责“怎么 Review”，Pi 负责“Agent 怎么跑”。**

---

### 2.3 Pi 源码使用边界

建议按以下方式使用：

```text id="xtc5u0"
                   ReviewAgent
                       │
              ┌────────┴────────┐
              ↓                 ↓
       自研 Review Runtime   Pi Runtime
              │                 │
         Review Loop        Agent Core
         Risk Policy        Tool Calling
         Evidence           State
         Budget             Event
              │                 │
              └────────┬────────┘
                       ↓
                      pi-ai
                       ↓
                       LLM
```

不建议：

```text id="jy2xnu"
ReviewAgent
   ↓
直接基于完整 pi-coding-agent
   ↓
关闭一堆 Coding 功能
```

这会把：

* 写文件
* Edit
* Bash
* Coding Workflow
* TUI
* 开发态命令

等不必要能力带进 Review Runtime。

---

## 3. Review Runtime 设计

### 3.1 Review Runtime 的核心

Review Runtime 是整个项目自己的核心，而不是 Pi 的默认 Coding Runtime。

通用 Coding Loop：

```text id="em7n7x"
Prompt
 ↓
Search
 ↓
Read
 ↓
Plan
 ↓
Edit
 ↓
Test
 ↓
Debug
```

Review Loop：

```text id="86d2st"
Diff
 ↓
Risk
 ↓
Context Decision
 ↓
Evidence Retrieval
 ↓
Reason
 ↓
Verify
 ↓
Finding
```

---

### 3.2 Agent Loop

建议 V0.1 采用：

```text id="d7ciih"
START
  ↓
Parse Diff
  ↓
Risk Classification
  ↓
Initial Context
  ↓
Review Reasoning
  ↓
Need Evidence?
 ├── No
 │    ↓
 │  Final Review
 │
 └── Yes
      ↓
   Evidence Request
      ↓
   Context Retrieval
      ↓
   Update Reasoning
      ↓
   Evidence Verification
      ↓
   Final Review
```

Pi 的底层 `agentLoop()` 已支持 `beforeToolCall`、`afterToolCall`、`shouldStopAfterTurn`，并支持全局及单 Tool 的并行/串行执行策略，因此可以通过这些控制点把通用 Loop 收敛成 Review Loop。

Loop 内部采用**固定阶段骨架 + 阶段内受限自主检索**的混合形态：阶段顺序固定（Parse Diff → Risk Classification → Initial Context → Review Reasoning → Evidence → Final Review），阶段内的检索由模型在工具预算内自主完成；确定性预取（Zone B，见 §4.2）不占自主检索预算。这是 POC1 已验证的形态——既避免自由探索退化成 Mini Claude Code，又保留模型在关键阶段自主取证的能力。

---

### 3.3 Review Loop 的核心思想：Evidence-driven

模型每次决定获取更多上下文时，都必须产生：

```text id="zy2h5g"
Current Hypothesis
       ↓
Missing Evidence
       ↓
Evidence Request
       ↓
Context Retrieval
       ↓
Hypothesis Update
```

而不是：

```text id="mmp5kn"
Search
→ Read
→ Search
→ Read
→ Search
→ Read
```

---

### 3.4 Agent Budget

V0.1 设置：

```text id="4i4sdr"
max_rounds       = 5
max_tool_calls   = 6
max_context      = 16~20K
max_output       = 1K
```

分层预算（具体数值最终通过 Benchmark 调优；Output 口径与上表统一）：

```text id="b8wq2n"
System / Stable Prefix      2K
Diff                        2K
Symbol Context              3K
Impact Context              5K
Reasoning                   4K
Output                      1K
────────────────────────────
Target                     ~17K
```

预算耗尽：

```text id="rqc5h6"
停止继续探索
↓
Evidence 不足
↓
不输出 Finding
```

Pi 的 `shouldStopAfterTurn` 可以用来实现“达到 Review Budget 即结束”的控制逻辑。

---

### 3.5 Pi Agent State

ReviewAgent 不直接依赖通用 Coding Agent 的全部 State。

只保留：

```text id="v1z8d1"
Review State
Diff
Risk
Current Hypothesis
Context Ledger
Evidence
Candidate Findings
Verified Findings
Budget
```

---

## 4. Context Engine 与 Minimal Sufficient Context

### 4.1 核心问题

代码检视存在两个极端：

```text id="4bqso4"
Full Repository
     ↓
深度能力强
但 Token 高


Diff-only
     ↓
Token 低
但深度问题可能漏检
```

因此采用：

> **Diff-first + On-demand Context**

---

### 4.2 Context 四层

```text id="y3cg9q"
C0 Diff
 ↓
C1 Symbol
 ↓
C2 Impact
 ↓
C3 Knowledge
```

---

### C0：Diff Context

包括：

```text id="x43f79"
Changed Files
Changed Hunk
Changed Lines
Changed Symbols
```

---

### C1：Symbol Context

包括：

```text id="8w4w71"
Changed Method
Changed Class
Local Context
Related Symbol
```

---

### C2：Impact Context

按需获取：

```text id="9ouncd"
Caller
Callee
Reference
Interface
State
Call Chain
Dependency
```

`review.get_call_chain` 在零构建约束（§4.3）下降级为 **1~2 层名字级引用链**。

---

### C3：Knowledge Context

后续逐步加入：

```text id="teqbmy"
CWD
Historical Review
Historical Defect
Business Rule
```

---

### 4.3 Repo Map

建立轻量：

```text id="krgnx8"
Repository
 ├── File Tree
 └── Symbol Tree
```

第一阶段（拍板：**Java 单语言先行，语言适配留 seam**——多语言是能力扩展项，不是首阶段实验变量）：

```text id="1jwp9t"
Java
```

后续：

```text id="4fuyf4"
Python
C/C++
Go
TypeScript
Kotlin
```

**C1/C2 实现后端：零构建静态解析**。企业落地场景只提供静态源码快照（无构建环境、不可编译），符号 / 引用 / 调用链全部采用零构建静态解析：

```text id="k3v7mx"
tree-sitter-java  →  签名级符号提取（Symbol Map / Zone B Symbol Index 生成器）
ripgrep           →  词法引用匹配（Reference Map）
文件读取          →  源码摘录（Evidence）
```

排除一切构建依赖方案（scip-java 是 javac 编译器插件、jdt-ls 需 Maven/Gradle 项目 import、Kythe 需构建捕获）。精度天花板为词法级（重载 / override 分辨不精确），但实验内各配置共享同一工具精度、配置间对比不受污染；主对照 Claude Code 同为词法工具（grep / read），跨对照对比公平。

Pi 本身允许自定义 ResourceLoader、Context Files、Skills 等资源加载机制，但 ReviewAgent 不应依赖这些机制自动把大量项目上下文灌入 Prompt，而应由自己的 Context Engine 决定真正进入模型上下文的内容。

---

### 4.4 Context Selector

核心接口：

```ts id="7x4llq"
interface ContextSelector {
  select(
    diff: DiffContext,
    risk: RiskProfile,
    hypothesis: ReviewHypothesis,
    budget: ContextBudget
  ): Promise<ContextPlan>;
}
```

输出：

```ts id="ln8p5l"
interface ContextPlan {
  requests: EvidenceRequest[];
  estimatedTokens: number;
  reason: string;
}
```

---

## 5. Cache Engine 与低成本架构

### 5.1 为什么 Cache 是一级模块

ReviewAgent 的成本不能只看：

> Total Tokens

必须同时关注：

```text id="o9w9za"
Total Tokens
Cached Tokens
Uncached Tokens
Cache Hit Rate
Prefix Stability
```

因此专门建立：

> **Cache Engine**

---

### 5.2 Cache Architecture

```text id="nfjiqa"
                    Cache Engine
                         │
       ┌─────────────────┼─────────────────┐
       ↓                 ↓                 ↓
 Prefix Manager     Context Ledger     Cache Policy
       │                 │                 │
 Stable Prompt        Loaded Range       Budget
 Tool Schema          Symbol             Routing
 Review Rules         Evidence           Snapshot
       └─────────────────┼─────────────────┘
                         ↓
                  Request Composer
```

---

### 5.3 Stable Prefix

固定：

```text id="znv6wm"
Review Role
Review Objective
Review Policy
Tool Schema
Finding Schema
Severity
Evidence Policy
```

原则：

> **Byte-stable**

避免：

```text id="jv0u99"
每轮修改 System Prompt
每轮修改 Tool Order
动态重排 Rule
动态重排 Context
```

---

### 5.4 Context Ledger

维护：

```ts id="yi4v1j"
interface ContextLedger {
  loadedFiles: LoadedFile[];
  loadedRanges: LoadedRange[];
  loadedSymbols: LoadedSymbol[];
  evidence: EvidenceRef[];

  has(range: CodeRange): boolean;
  markLoaded(range: CodeRange): void;
}
```

第一次读取：

```text id="a4yu78"
Foo.java:100-180
```

返回完整代码。

第二次读取：

```text id="f9b8x0"
AlreadyLoaded(ctx#001)
```

避免重复发送。

---

### 5.5 Append-only Context

设计成：

```text id="8fl3m4"
Turn 1
Prefix + Diff

Turn 2
Prefix + Diff + Symbol

Turn 3
Prefix + Diff + Symbol + Caller

Turn 4
Prefix + Diff + Symbol + Caller + Evidence
```

而不是不断重新构造：

```text id="2o6y6g"
Prompt + Diff
Prompt + Rule + Diff
Prompt + Caller + Diff + Rule
```

Context 变更策略（Cache 影响分级）：

| Context | Mutation | Cache |
|---|---|---|
| System Prompt | Immutable | Maximum |
| Tool Schema | Immutable | Maximum |
| Review Rules | Immutable | Maximum |
| Repo Map | Snapshot | High |
| Diff | Stable | High |
| Symbol | Append | High |
| Impact | Append | High |
| Evidence | Append | High |
| Finding | Append | High |

原则：

> **能不变就不变，能追加就不重写。**

---

### 5.6 Compaction

Pi 的 `AgentSession` 当前已经管理：

* message history；
* compaction；
* event streaming；
* session lifecycle。

SDK 也直接提供 `compact()` 和 compaction event。

因此 ReviewAgent 不需要重新造完整 Compaction 基础设施。

但需要增加：

> **Review-specific Compaction**

只保留：

```text id="3m4ujc"
Changed Symbols
Important Context
Evidence
Verified Finding
Rejected Finding
Open Question
```

同时，Compaction 不得破坏 Stable Prefix。应采用：

```text id="p9rn4d"
Stable Prefix
+
Retained Review State
+
Compaction Result
```

而不是：

```text id="w6tj8e"
New System Prompt
+
New Tool Schema
+
Summary
```

后者会从请求前部就破坏缓存复用。删除侧：无价值对话、重复工具结果、重复代码、无效探索。

---

### 5.7 Cache-aware Model Routing

模型选择不能只考虑：

```text id="v2n8cq"
Quality
Cost
```

还需要考虑 **Cache Warmth**。因此：

```text id="h5xk9m"
Model Score
=
Quality
+
Cost
+
Cache Reuse
```

例如：Model A 质量高、成本低、Cache = 90%；Model B 质量更高、成本略低、Cache = 0%——此时不一定应该切到 B。多 Provider（pi-ai）是部署资产，不是单次实验内的自由度（实验纪律见 §9.3）。

### 5.8 Cache Metrics

记录：

```text id="sq6fmc"
prefix_tokens
cached_tokens
uncached_tokens
cache_hit_rate
cache_break_count
cache_break_reason
```

Cache Policy 目标：

```text id="t7gk4w"
cache_target_hit_rate ≥ 85%
```

Cache Break 分类（每次 Cache 显著下降时记录 `CacheBreakEvent`，定位"为什么这一次 Review 的 Cache Hit 突然下降"）：

```text id="y9mqe2"
SYSTEM_PROMPT_CHANGED
TOOL_SCHEMA_CHANGED
TOOL_ORDER_CHANGED
MODEL_CHANGED
ROUTE_CHANGED
CONTEXT_REORDERED
CONTEXT_MUTATED
COMPACTION_REBUILT
```

最终指标：

```text id="ba1933"
Cache Efficiency
=
Cached Tokens
──────────────
Total Input Tokens
```

**DeepSeek 缓存语义与冷/热报告协议**：DeepSeek 官方 API 的上下文缓存为**磁盘缓存 + 持久化单元整匹**语义，与朴素的"最长公共前缀"直觉有三处关键差异：

1. **整匹而非增量**：请求 A+B 缓存后，A+C 不命中 B 的部分；但公共前缀 A 会被持久化，供后续 A+D 命中。稳定前缀的价值在"跨请求复用同一前缀"，而非任意前缀部分命中。
2. **账号级共享、best-effort**：缓存按账号（API key）共享、闲置数小时至数天清除；跨会话前缀复用需 ≥2 次共享请求才会持久化公共前缀。
3. **计量与价格**：usage 报告 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；缓存命中价格约为未命中的 1/30——缓存优先命题的收益基础。

由此 Benchmark 采用**分层报告协议**：

```text id="n4wq8v"
rep1（冷启动）          → 单列报告，不计入主口径
rep2+（热稳定）         → 均值 ± 标准差，主口径
会话内自然混合命中率     → 主口径；跨会话预热曲线 → 单列实验
```

单发配置（A / B / C）的重复运行命中率含测量伪影（同一请求重复即命中），冷成本与热均值必须分层呈现。

---

### 5.9 Incremental Review

GitHub / GitLab 场景进一步复用：

```text id="3jv1gt"
PR
├── Commit A
│    ↓
│  Review A
│
├── Commit B
│    ↓
│  Diff(B-A)
│    ↓
│  Incremental Review
│
└── Commit C
     ↓
   Diff(C-B)
```

复用：

```text id="b3jg7p"
Stable Prefix
Repo Map
Symbol Map
Previous Evidence
Previous Findings
```

这是后续降低 Token 和 Latency 的核心能力。

---

## 6. Tool、Knowledge 与 Evidence 架构

### 6.1 Tool 设计

V0.1 默认只提供：

```text id="4aw0qh"
review.get_diff
review.get_symbol
review.get_file
review.find_references
review.get_call_chain
review.search_rule
review.search_history
```

不提供：

```text id="tsybdu"
write
edit
delete
git push
git commit
```

`review.get_call_chain` 受零构建约束（§4.3）降级为 1~2 层名字级引用链。

Pi 支持在 `createAgentSession()` 中指定 Tool Allowlist，也支持注册 Custom Tool；低层 Agent 还允许对单个 Tool 设置执行模式。

---

### 6.2 Tool Policy

每一个 Tool 都受到：

```text id="x5s7z5"
Allowlist
Budget
Timeout
Context Cost
Risk Policy
```

控制。

例如：

```text id="f5rlqf"
get_symbol
→ low cost

get_call_chain
→ medium cost

search_history
→ high cost
```

Risk Engine 可以决定是否值得调用。

---

### 6.3 Knowledge Engine

长期逐步接入：

```text id="e8lo8o"
Coding Rules
CWD
Historical Review
Historical Defects
DTS
Business Rules
Git History
```

术语：**CWD** = 从历史缺陷挖掘出的本项目常见缺陷模式库（知识 L2 层）；**DTS** = 缺陷跟踪系统。

知识生产链路：

```text id="r8d3vn"
DTS / Review / Git / Production
    ↓
Defect Mining
    ↓
Pattern Extraction
    ↓
CWD
    ↓
Review Knowledge
```

知识分层：

```text id="m2jy6p"
L1 Coding Rule
L2 CWD Rule
L3 Review Case
L4 Historical Defect
L5 Business Knowledge
```

知识检索过程：

```text id="05kd03"
Diff
 ↓
Risk
 ↓
Knowledge Retrieval
 ↓
Top-K Rule / Case
```

而不是：

```text id="mpzo8v"
所有 Rule
 ↓
全部塞 Prompt
```

---

### 6.4 Evidence Engine

任何 Finding 必须经过：

```text id="xu0k3f"
Candidate
 ↓
Evidence
 ↓
Verification
 ↓
Confidence
 ↓
Accept / Reject
```

默认：

> **No Evidence, No Finding**

验证遍数的阶段语义：早期版本以**单遍自证**（Reasoning 阶段内自我核查）为底线形态；**二遍 Verifier**（独立第二遍复核 Finding）为消融开关——Verifier 使用同模型，其 token 消耗计入 CARC（§9.4）。编译 / 测试 / 运行时验证属 V0.5 的工程验证层（Compile / Test / Runtime / Quality Gate），不进早期实验。

---

### 6.5 Finding 数据结构

```ts id="jvpogk"
interface ReviewFinding {
  id: string;
  severity: "P0" | "P1" | "P2" | "P3";
  category: string;

  file: string;
  line: number;

  title: string;
  description: string;

  evidence: EvidenceRef[];

  rule?: string;

  confidence: number;
}
```

---

### 6.6 Dedup

多个 Review Path 可能得到：

```text id="l5zqft"
同一 Finding
```

需要进行：

```text id="3byd8b"
Location
+
Category
+
Semantic Similarity
+
Evidence
```

去重。

---

## 7. 企业代码平台集成与运行方式

### 7.1 核心集成架构

```text id="5scj4k"
GitHub / GitLab / Gerrit
          │
       Webhook
          ↓
   Review Gateway
          ↓
   Review Scheduler
          ↓
    Review Worker
          ↓
      ReviewAgent
          ↓
       Pi Runtime
          ↓
          LLM
          ↓
   Structured Result
          ↓
 Check / Comment / Gate
```

---

### 7.2 Platform Adapter

ReviewAgent 不直接依赖 GitHub。

定义：

```ts id="mtm29e"
interface CodePlatformAdapter {

  getChange(ref: ChangeRef): Promise<Change>;

  getDiff(ref: ChangeRef): Promise<Diff>;

  prepareWorkspace(
    ref: ChangeRef,
    workspace: string
  ): Promise<void>;

  publishCheck(
    ref: ChangeRef,
    result: ReviewResult
  ): Promise<void>;

  publishComments(
    ref: ChangeRef,
    findings: ReviewFinding[]
  ): Promise<void>;
}
```

然后：

```text id="kw2zxb"
GitHub Adapter
GitLab Adapter
Gerrit Adapter
```

分别实现。

---

### 7.3 Review Job

平台事件统一转成：

```ts id="r28k0a"
interface ReviewJob {
  jobId: string;

  repository: string;

  baseSha: string;
  headSha: string;

  profile: string;

  budget: ReviewBudget;
}
```

关键：

> **baseSha + headSha 固定 Review 输入。**

---

### 7.4 Worker

Worker 负责：

```text id="33w1eq"
创建 Workspace
 ↓
Checkout exact SHA
 ↓
启动 ReviewAgent
 ↓
收集结果
 ↓
回写平台
 ↓
清理 Workspace
```

---

### 7.5 本地 / CI 集成

本地：

```bash id="dtdf4f"
review-agent review \
  --base HEAD~1
```

CI：

```bash id="jxh0fk"
review-agent review \
  --base $BASE_SHA \
  --head $HEAD_SHA \
  --format json
```

企业平台：

```text id="t6a7s6"
Review Job
 ↓
Review Worker
 ↓
ReviewAgent
```

---

### 7.6 Review Output

建议分三层：

```text id="54n9um"
P0 / P1
→ Inline Comment

P2
→ Summary + 可选 Comment

P3
→ Summary
```

同时生成：

```text id="awx5vl"
Review Summary
+
Finding List
+
Evidence
+
Metrics
```

---

### 7.7 Developer Follow-up

未来支持：

```text id="4qye4f"
@review-agent explain F001
```

通过平台评论事件重新进入：

```text id="e3j543"
Existing Review Session
+
Finding
+
Evidence
+
User Question
```

形成：

> **Reviewer Conversation**

Pi SDK 当前支持 `steer()` / `followUp()` 等队列机制，因此这种后续交互可以复用现有 Session / Agent 控制能力。

---

## 8. 版本演进与实施计划

### 8.1 V0.1：Minimal Context Review

核心目标：

> **证明 Pi 可以承载专用 Review Runtime。**

实现：

```text id="m0iy0w"
Pi Agent Core
+
Git Diff
+
Repo Map
+
Symbol
+
Reference
+
CallChain
+
Basic Review
+
Metrics
```

重点验证：

```text id="13ssr1"
Diff-only
vs
Minimal Context
vs
Full Context
```

完整的实验配置面为 §9.3 的 **A–E 五配置矩阵**：A/B/C 回答 Context 命题（V0.1 本阶段），D/E 回答 Cache 命题（V0.2）。

回答：

> **最小充分 Context 到底是什么？**

---

### 8.2 V0.2：Cache-Efficient Review

核心目标：

> **证明 ReviewAgent 可以显著降低 Uncached Token。**

实现：

```text id="x0h8df"
Stable Prefix
+
Stable Tool Schema
+
Context Ledger
+
Append-only Context
+
Snapshot
+
Review Compaction
+
Cache Metrics
```

重点指标：

```text id="crtnxg"
Cache Hit Rate
Cached Tokens
Uncached Tokens
Latency
Cost
```

---

### 8.3 V0.3：Git Platform Native Review

核心目标：

> **从 CLI Tool 进入真实代码平台。**

实现：

```text id="xjmm8d"
GitHub App
Webhook
Review Gateway
Review Worker
Check
Inline Comment
```

形成：

```text id="60b2cb"
PR
 ↓
AI Review
 ↓
Check
 ↓
Finding
```

---

### 8.4 V0.4：Domain Intelligence

核心目标：

> **让 AI 从“懂代码”升级为“懂组织”。**

加入：

```text id="bdl5m1"
CWD
Historical Review
Historical Defect
DTS
Business Rule
Git History
```

核心验证：

> **企业历史知识对 Review Recall / Precision 的增益。**

---

### 8.5 V0.5：Evidence + Quality Gate

核心目标：

> **让 Review 从 AI 判断升级为 AI 判断 + 工程验证。**

增加：

```text id="5g22zw"
Evidence
CodeCheck
Compile
Unit Test
Runtime Validation
Quality Gate
```

形成：

```text id="c7c0yw"
Candidate
 ↓
Evidence
 ↓
Validation
 ↓
Confirmed Finding
```

---

### 8.6 V1.0：Enterprise AI Review Engine

实现：

```text id="f2o5s8"
GitHub
GitLab
Gerrit

Java
C/C++
Python
Go
TypeScript
Kotlin

DeepSeek
Claude
Qwen
OpenAI
Local Model
```

最终成为：

> **企业级 AI Reviewer。**

---

## 9. 项目实施原则、关键风险与 Benchmark

### 9.1 第一阶段开发重点

不是先做平台 UI。

也不是先做知识库。

而是先打通：

```text id="ql5a4i"
Git Diff
 ↓
Pi Agent
 ↓
Minimal Context
 ↓
Review
 ↓
Finding
 ↓
Metrics
```

然后：

```text id="23yldo"
Cache
 ↓
Evidence
 ↓
GitHub
 ↓
Knowledge
```

逐步增加。

---

### 9.2 关键风险

#### 风险一：Context 太少

表现：

```text id="m7rkj2"
Deep Review Recall ↓
```

解决：

```text id="u8v1de"
C0 → C1 → C2 → C3
```

逐级增加 Context。

---

#### 风险二：Context 太多

表现：

```text id="2n9j3a"
Token ↑
Latency ↑
```

解决：

```text id="g0a2ml"
Context Budget
+
Context Ranking
+
Ledger
```

---

#### 风险三：Cache Hit 高但质量下降

必须同时看：

```text id="vfepq7"
Recall
Precision
Cache
Token
```

不能只追求 Cache Hit。

---

#### 风险四：Agent 退化成 Mini Claude Code

通过：

```text id="b8v0ob"
Tool Allowlist
Round Budget
Context Budget
Review-specific Loop
```

强制约束。

---

#### 风险五：Pi 权限模型

Pi 当前官方明确说明，它本身不提供内置的 filesystem / process / network / credential 权限系统，默认使用启动进程的权限；更强边界依赖 Docker、Gondolin 或 OpenShell 等隔离方式。

因此：

```text id="q4k6xf"
V0.1
Read-only Tools

V0.3+
Sandbox / Container

V0.5
Compile / Test / Runtime
```

逐步扩大权限。

---

### 9.3 Benchmark 与实验协议

**数据集：逆补丁法（Inverse-Patch）+ 多源组合**。MR 构造方法：以修复补丁的逆 diff 构造"引入缺陷的 MR"——base 为修复后版本，MR 即"撤销该次修复"的变更，合入后代码状态为历史真实 buggy 版本（非合成篡改）；真值为最小修复补丁的精确行位与性质 + issue 描述。确定性、零挖掘噪声、可从任何缺陷历史数据集机械生成。（替代路径 SZZ 挖掘真实缺陷引入提交因 blame 噪声被否。）

建立 ReviewBench，多源组合：

| 数据集 | 条数 | 角色 |
|---|---|---|
| Defects4J（分层抽样，过滤 MR 边界 ≤10 文件 / diff ≤2K 行） | ~100 | 主集：五配置全跑，S/A/B 判定主真值（最小化修复补丁、真值最干净） |
| Vul4J 安全子集 | ~30 | 高险集：驱动 Risk Class=High 的 C2/C3 深加载验证（CVE/CWE 标签） |
| Multi-SWE-bench Java 抽样 | ~30 | 真实 PR 上下文的外部效度检查，只跑 C / E |
| 自建 clean MR（挖 merged、无 issue 关联且未被 revert 的 PR） | ~50 | **阴性对照**：测 False Positive，含"主动检索是否推高无中生有率"的 A vs C 对比 |
| MCR-Bench Java | 556 全量参照 | 不进主判定，用于 LLM-as-judge 校准与检视类别分布参照（license 核查后用） |

现行执行口径（phase2 已落地）：30 案 VUL4J × A–E × 3 reps = 450 单元。

**实验配置矩阵（A–E）**：

| 配置 | Context | Cache | 工具 | 核心目的 |
|---|---|---|---|---|
| A | Diff-only | 无特殊设计 | 零工具 | 最低成本基线（纯 diff 注入，模拟朴素基线） |
| B | Minimal | 普通 | 零工具（Zone B + 固定管线确定性预取） | 验证精准 Context；与 C / E 对照"预取 vs 主动检索" |
| C | Full Repo | 普通 | 7 工具 | 效果上限 = 质量主锚 |
| D | Minimal | Stable Prefix | 7 工具 | 验证 Prefix 稳定性对缓存的影响 |
| E | Minimal | Prefix + Ledger + Append-only | 7 工具 | 验证完整 Cache 策略；本项目主力系统形态 |

A/B/C 回答 Context 命题（V0.1），D/E 回答 Cache 命题（V0.2）；C/D/E 挂同一套 7 个 `review.*` 工具、schema 字节一致。

**核心研究问题**：

```text id="q1w5e9"
Q1  Diff-only 会漏掉多少深度问题？
Q2  Symbol Context 能恢复多少？
Q3  Impact Context 能恢复多少？
Q4  达到 Full Repo 90% 效果需要多少 Context？
Q5  Context Ledger 能减少多少重复 Token？
Q6  Stable Prefix 能提高多少 Cache Hit？
Q7  Cache 优化能否在不改变 Review Quality 的情况下进一步降低成本？
```

**对照**（拍板：Claude Code 列入主对照列）：

```text id="2dm02w"
Diff-only
Minimal Context
Full Context
ReviewAgent
Claude Code（原生 Claude 系模型，与本项目被测模型不同源，对照时注明）
```

**实验纪律**：

```text id="d7r3kt"
模型锁定     单实验锁定单模型——多 Provider（pi-ai）是部署资产，不是实验自由度
Effort 锁定  全实验锁定单一 effort 档位，禁止档位漂移
重复         ≥3 次报均值 ± 标准差；rep1 冷单列、rep2+ 热均值为主（§5.8）
```

**判定链**：

```text id="f4n8jw"
原生真值（逆补丁行位 + 性质）
    ↓
规则粗筛
    ↓
LLM-as-judge（异构校准；现行实例：glm-5-3-260814 走 review-llm，与被测 deepseek-v4-flash 异构）
    ↓
10% 人工抽检
```

**消融实验**：

```text id="a2s9vx"
1  去掉 Repo Map
2  去掉 Context Ledger
3  去掉 Stable Prefix
4  去掉 Evidence Checker
5  固定 Loop vs 自由 Loop
6  普通 Model Routing vs Cache-aware Routing
7  二遍 Verifier vs 单遍自证（Verifier token 计入 CARC）
8  主力模型 vs 高能力模型（如 deepseek-v4-flash vs deepseek-v4-pro，高险升级增益）
```

目的：

> **证明每个架构组件到底产生了什么价值。**

**核心指标**：

```text id="9y6aq7"
Quality
├── Recall
├── Precision
├── F1
└── Acceptance

Context Efficiency
├── Context Tokens
├── Context / Finding
└── Deep Recall / Context Token

Efficiency
├── Token
├── Tool Calls
├── Rounds
└── Latency

Cache
├── Cache Hit
├── Cached Token
├── Uncached Token
└── Cache Break

Cost
└── Effective Review Cost
```

---

### 9.4 核心效率指标

定义：

```text id="ov31n7"
Review Intelligence Efficiency

=
Recall × Precision
───────────────────
Total Tokens / 1K
```

以及：

```text id="yv8n5m"
Cache Efficiency

=
Cached Input Tokens
────────────────────
Total Input Tokens
```

以及：

```text id="c6t4rb"
Review Cost Efficiency

=
Review Quality
────────────────────────
Uncached Tokens + Tool Cost
```

以及：

```text id="9a8es7"
Cache-adjusted Review Cost

=
Uncached Input Tokens
+
Output Tokens
+
Tool Cost
```

RIE 与 CARC 这两个指标同时作为最终优化方向。

---

### 9.5 V0.1 成功标准

判级采用 **S/A/B 三级标准**，主锚 = **配置 C（Full Repository 效果上限）**：

**S 级**：

```text id="g5w2qm"
Recall ≥ 配置 C × 90%
Precision ≥ 配置 C
Token ≤ 配置 C × 30%
Tool Calls ≤ 配置 C × 30%
Cache Hit ≥ 85%（rep2+ 热口径）
```

**A 级**：

```text id="j8n3vd"
Recall ≥ 配置 C × 80%
Token ≤ 配置 C × 30%
Cache Hit ≥ 80%
```

**B 级**：

```text id="k2p9wx"
Recall ≥ 配置 C × 70%
Token ≤ 配置 C × 50%
```

同时验证：

> **Minimal Context 是否能覆盖深度 Review 场景。**

---

### 9.6 最终技术架构

```text id="f4ao2s"
                         Code Platform
                   GitHub / GitLab / Gerrit
                                │
                           Webhook / CLI
                                ↓
                     ┌───────────────────┐
                     │ Review Gateway    │
                     └─────────┬─────────┘
                               ↓
                     ┌───────────────────┐
                     │ Review Worker     │
                     └─────────┬─────────┘
                               ↓
                     ┌───────────────────┐
                     │    ReviewAgent    │
                     │                   │
                     │ Review Runtime    │
                     │ Context Engine    │
                     │ Cache Engine      │
                     │ Knowledge Engine  │
                     │ Evidence Engine   │
                     └─────────┬─────────┘
                               ↓
                     ┌───────────────────┐
                     │   pi-agent-core   │
                     │                   │
                     │ Agent Loop        │
                     │ Tool Calling      │
                     │ State             │
                     │ Events            │
                     └─────────┬─────────┘
                               ↓
                            pi-ai
                               ↓
               DeepSeek / Claude / Qwen / OpenAI
                               ↓
                        Review Finding
                               ↓
                ┌──────────────┼──────────────┐
                ↓              ↓              ↓
              Check         Comment         Summary
                │              │              │
                └──────────────┼──────────────┘
                               ↓
                           Developer
                               ↓
                            Feedback
                               ↓
                          Knowledge/CWD
                               ↺
```

---

## 10. 最终架构结论

基于当前 Pi 源码和你的 ReviewAgent 目标，我建议正式确定：

> ### **`pi-agent-core + pi-ai` 作为内核，自研 Review Runtime。**

不要直接把 `pi-coding-agent` 当成 ReviewAgent 主体。

原因在于当前 Pi 已经提供了实现这个方案所需的关键基础设施：

* Agent Loop；
* Tool Calling；
* State；
* Tool Execution Policy；
* Context Transform；
* Session；
* Compaction；
* Event Stream；
* Custom Tool；
* Tool Allowlist；
* SDK；
* RPC；
* 多 Provider LLM。

因此，你真正需要自研的部分应该集中在：

```text id="a65u9v"
Review Strategy
Context Engine
Cache Engine
Knowledge Engine
Evidence Engine
Review Benchmark
Git Platform Adapter
```

而不是重新造 Agent Runtime。

最终形成：

> ### **Pi 负责“Agent 怎么跑”；ReviewAgent 负责“Review 怎么做”；Context Engine 决定“看什么”；Cache Engine 决定“怎么便宜地看”；Evidence Engine 决定“问题是否真的成立”。**

而整个项目最重要的技术命题仍然是：

> ### **Minimal Sufficient Context + Cache-Stable Review Loop**
>
> 用最少的有效上下文、最少的 Agent Loop 和最少的 Uncached Token，获得接近 Full-Context Coding Agent 的深度 Review 效果。

**这条路线比“Pi Coding Agent + Review Prompt”更适合你，也更容易真正形成一个有技术壁垒的专用 ReviewAgent。**

[1]: https://github.com/earendil-works/pi "GitHub - earendil-works/pi: AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI · GitHub"
[2]: https://github.com/earendil-works/pi/blob/main/packages/agent/README.md "pi/packages/agent/README.md at main · earendil-works/pi · GitHub"
[3]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md "pi/packages/coding-agent/docs/sdk.md at main · earendil-works/pi · GitHub"

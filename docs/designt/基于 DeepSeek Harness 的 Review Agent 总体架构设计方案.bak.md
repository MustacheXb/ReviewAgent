重新核对了当前 DeepSeek Harness 的官方架构：它确实将 `session`、`system-prompt`、`tools`、`agent`、`agent-loop`、`llm` 等作为可替换插件能力；`agent/pre-step` 可以决定模型实际看到的消息；Session 是 append-only event log；这些都非常适合实现我们的“**Cache-Stable Review Loop**”。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md "deepseek-harness/docs/architecture.md at master · deepseek-ai/deepseek-harness · GitHub"))

# 基于 DeepSeek Harness 的 Review Agent 总体架构设计方案

## 1. 项目概述

### 1.1 项目名称

**Review Agent —— 基于 DeepSeek Harness 的低 Token、高质量代码检视 Agent**

### 1.2 项目定位

面向 AI Coding 时代的代码质量保障场景，基于 DeepSeek Harness 构建专用 Review Runtime，通过：

> **专用 Review Loop + Minimal Sufficient Context + Cache Optimization + Domain Knowledge + Evidence Verification**

降低通用 Coding Agent 在代码检视场景中的上下文、工具调用和模型推理成本，在显著降低 Token / 算力消耗的情况下，达到接近甚至部分场景优于 Claude Code / OpenCode 的代码检视效果。

---

# 2. 背景与问题定义

## 2.1 AI Coding 带来的新矛盾

Claude Code、OpenCode 等 Coding Agent 已经能够显著提升代码生成效率，但同时带来新的质量挑战：

```text
AI代码生成速度 ↑
        ↓
代码变更数量 ↑
        ↓
MR / Commit 数量 ↑
        ↓
Code Review 压力 ↑
        ↓
传统人工 Review 成为瓶颈
```

因此需要进一步发展：

> **AI Review → 专用化 → 工程化 → 规模化**

---

## 2.2 为什么直接使用 Claude Code / OpenCode 做 Review 成本高

通用 Coding Agent 通常围绕完整软件开发任务设计：

```text
需求理解
 ↓
Repository Exploration
 ↓
Plan
 ↓
Search
 ↓
Read
 ↓
Edit
 ↓
Test
 ↓
Debug
 ↓
Repair
```

而 Review 实际只需要：

```text
Change Understanding
 ↓
Risk Detection
 ↓
Context Retrieval
 ↓
Reasoning
 ↓
Evidence Verification
 ↓
Finding
```

因此：

> **Review 并不需要通用 Coding Agent 的全部能力。**

---

# 3. 核心问题

整个项目围绕五个关键技术问题展开。

## 问题一：只给 Diff 会不会漏掉深度问题？

会。

很多高价值问题需要：

- Caller；
    
- Callee；
    
- Call Chain；
    
- Interface；
    
- State；
    
- Transaction；
    
- Resource Lifecycle；
    
- Cross-module Dependency。
    

因此：

> **不能采用 Diff-only。**

---

## 问题二：如果给完整 Repository，Token 又会失控

Full Repository Context 虽然能提升理解能力，但带来：

```text
Context ↑
Prompt ↑
Tool Calls ↑
Reasoning ↑
Token ↑
Cost ↑
```

因此需要寻找：

> **Minimal Sufficient Context**

即：

> **能够支撑正确 Review 判断的最小充分上下文。**

---

## 问题三：重复 Context 导致缓存和 Token 浪费

Review Agent 多轮推理过程中，经常反复访问：

```text
FooService.update()
FooService.update()
FooService.update()
```

如果每次重新返回代码：

> Context 重复 + Cache 破坏 + Token 浪费。

---

## 问题四：Agent Loop 容易重新退化成 Mini Claude Code

如果提供过多 Tool：

```text
search
read
grep
bash
ls
find
edit
...
```

Agent 很容易：

> 大量探索 → 大量 Tool Call → 大量 Token。

---

## 问题五：模型判断容易产生误报

Review 不应该只是：

> “模型觉得这里有问题。”

而应该：

> **Finding + Evidence + Rule + Confidence**

因此必须建立 Evidence Gate。

---

# 4. 核心设计目标

## 4.1 总体目标

构建：

```text
Git Diff
 ↓
Change Understanding
 ↓
Risk Classification
 ↓
Minimal Sufficient Context Retrieval
 ↓
Review Reasoning
 ↓
Evidence Verification
 ↓
Structured Finding
```

---

## 4.2 成本目标

从：

> **Total Token Optimization**

升级为：

> **Uncached Token Optimization + Cache Hit Optimization**

即同时优化：

```text
① 少发 Token
② 少发 Uncached Token
③ 提高 Prefix Cache Hit
④ 减少 Tool Calls
⑤ 控制 Reasoning Loop
```

---

## 4.3 质量目标

目标不是单纯超越 Claude Code，而是：

```text
Recall ≈ Claude Code
Precision ≥ Claude Code
Token << Claude Code
```

建议：

```text
Recall ≥ Claude Code × 80~90%
Token ≤ Claude Code × 30%
Tool Calls ≤ Claude Code × 30%
```

---

# 5. 核心设计思想

整个项目采用：

# “三优化、一闭环”

```text
                     Review Agent
                          │
          ┌───────────────┼────────────────┐
          ↓               ↓                ↓
    Context Optimization  Loop Optimization Cache Optimization
          │               │                │
     看得少但够用      想得少但深入       发得少且命中高
          │               │                │
          └───────────────┼────────────────┘
                          ↓
                   Evidence Verification
                          ↓
                    High-quality Review
```

并通过：

> **Review Feedback → Knowledge → Rule → Agent**

形成持续进化闭环。

---

# 6. 总体架构

```text
                         ┌──────────────────────┐
                         │      Git / MR         │
                         └──────────┬───────────┘
                                    ↓
                         ┌──────────────────────┐
                         │      Diff Engine     │
                         │ File/Hunk/Symbol     │
                         └──────────┬───────────┘
                                    ↓
          ┌─────────────────────────┼─────────────────────────┐
          ↓                         ↓                         ↓
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Context Engine   │      │ Knowledge Engine │      │ Check Engine     │
│                  │      │                  │      │                  │
│ Repo Map         │      │ CWD              │      │ CodeCheck        │
│ Symbol Map       │      │ Historical       │      │ Compiler         │
│ Call Graph       │      │ Defects          │      │ Test             │
│ Impact Map       │      │ Review Cases     │      │ Runtime          │
│ Context Ledger   │      │ Business Rules   │      │                  │
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         └─────────────────────────┼─────────────────────────┘
                                   ↓
                       ┌─────────────────────────┐
                       │   Review Strategy       │
                       │                         │
                       │ Risk / Context / Model  │
                       │ Tool / Budget Decision  │
                       └────────────┬────────────┘
                                    ↓
                       ┌─────────────────────────┐
                       │ Cache Optimization      │
                       │ Engine                  │
                       │                         │
                       │ Stable Prefix           │
                       │ Context Ledger           │
                       │ Append-only Context     │
                       │ Cache Policy             │
                       │ Snapshot / Compaction    │
                       └────────────┬────────────┘
                                    ↓
                       ┌─────────────────────────┐
                       │ Review Agent Driver     │
                       │                         │
                       │ Detect / Reason         │
                       │ Retrieve / Verify       │
                       └────────────┬────────────┘
                                    ↓
                         ┌──────────────────────┐
                         │ DeepSeek Harness     │
                         │                      │
                         │ Cordis               │
                         │ Session              │
                         │ System Prompt        │
                         │ Tools                │
                         │ Agent                │
                         │ Agent Loop           │
                         │ LLM                  │
                         └──────────┬───────────┘
                                    ↓
                              Review Finding
```

---

# 7. DSH 内核定位

DeepSeek Harness 当前的架构非常适合作为底层 Runtime。

官方架构明确说明：

> 每个产品能力都以插件形式存在，包括模型适配器、Tool Registry、Session Log、Agent Loop；扩展通常通过挂载新的插件完成，而不是修改一个特权 Core。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md "deepseek-harness/docs/architecture.md at master · deepseek-ai/deepseek-harness · GitHub"))

因此：

> **DSH 负责 Agent 如何运行；Review Agent 负责 Review 如何完成。**

---

# 8. DSH 与 Review Agent 的职责边界

|DSH|Review Agent|
|---|---|
|Plugin Runtime|Review Strategy|
|Agent|Review Agent|
|Agent Loop|Review Loop|
|Session|Review State|
|System Prompt|Review Prompt|
|Tool Registry|Review Tool Policy|
|LLM|Model Routing|
|Event|Review Event|
|Tool Execution|Evidence Retrieval|

原则：

> **Review Intelligence 不侵入 DSH Core。**

---

# 9. Review Runtime

不能简单复用默认 Coding Runtime。

## Coding Runtime

```text
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
 ↓
Repair
```

## Review Runtime

```text
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

因此：

# Review Runtime ≠ Coding Runtime

---

# 10. Review Agent Loop

```text
                    START
                      ↓
              Change Understanding
                      ↓
              Risk Classification
                      ↓
              Context Decision
                      ↓
              Context Retrieval
                      ↓
               Deep Reasoning
                      ↓
             Evidence Verification
                      ↓
                Final Finding
```

最大：

```text
max_rounds = 5
max_tool_calls = 6
```

---

# 11. Evidence-driven Loop

核心 Loop 不是：

```text
Search
→ Read
→ Search
→ Read
```

而是：

```text
Hypothesis
    ↓
What evidence is missing?
    ↓
Evidence Request
    ↓
Evidence
    ↓
Hypothesis Update
    ↓
Verify
```

因此：

> **Agent 的每一次 Tool Call 都必须回答“我为什么需要这个信息”。**

---

# 12. Context Engine

Context Engine 是第一核心模块。

```text
Context Engine
│
├── Diff Engine
├── Repo Map
├── Symbol Map
├── Reference Map
├── Call Graph
├── Impact Map
├── Context Ledger
├── Context Selector
└── Context Compressor
```

---

# 13. Minimal Sufficient Context

Context 按四级加载。

```text
C0 Diff
 ↓
C1 Symbol
 ↓
C2 Impact
 ↓
C3 Knowledge
```

---

## C0：Diff

必须加载：

```text
Changed Files
Changed Hunks
Changed Lines
Changed Symbols
```

---

## C1：Symbol

按需加载：

```text
Changed Method
Changed Class
Local Context
Related Symbol
```

---

## C2：Impact

按需加载：

```text
Caller
Callee
Reference
Interface
State
Call Chain
Dependency
```

---

## C3：Knowledge

按需加载：

```text
CWD
Historical Review
Historical Defect
Business Rule
```

---

# 14. Cache Optimization Engine

这是项目新增的一级核心模块。

目标：

> **让必要 Context 尽可能少，并让不可避免的 Context 尽可能命中 Cache。**

整体模型：

```text
               Cache Optimization
                       │
       ┌───────────────┼────────────────┐
       ↓               ↓                ↓
 Prefix Manager   Context Ledger   Cache Policy
       │               │                │
 Stable Prompt      Loaded Range      Budget
 Tool Schema        Symbol            Hit Target
 Rules              Evidence          Routing
       │               │                │
       └───────────────┼────────────────┘
                       ↓
                 Request Composer
                       ↓
                  DSH / LLM
```

---

# 15. Cache 三层结构

## Zone A：Immutable Prefix

整个 Review Session 基本不变化：

```text
Review Role
Review Objective
Review Policy
Finding Schema
Severity Definition
Evidence Policy
Tool Policy
```

目标：

> **Byte Stable**

---

## Zone B：Session Stable Context

一个 Repository / Review Session 内基本稳定：

```text
Repo Identity
Repo Map
Symbol Index
Project Rules
```

---

## Zone C：Append-only Review Context

动态增长：

```text
Diff
Symbol Context
Impact Context
Evidence
Finding
Verification
```

原则：

> **新增信息尽量追加，不重新排序、不重复插入。**

DSH 的 Session 本身就是 append-only `SessionEvent` log；官方架构说明也明确指出模型可见上下文由这个日志推导，因此非常适合实现 Cache-Stable Context。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md "deepseek-harness/docs/architecture.md at master · deepseek-ai/deepseek-harness · GitHub"))

---

# 16. Stable Prefix 设计

建议一次模型请求设计成：

```text
┌─────────────────────────────────┐
│         STABLE PREFIX           │
│                                 │
│ Review Prompt                   │
│ Review Policy                   │
│ Tool Schema                     │
│ Severity                        │
│ Evidence Policy                 │
│ Output Schema                   │
└─────────────────────────────────┘
                 ↓
┌─────────────────────────────────┐
│       SEMI-STABLE CONTEXT       │
│                                 │
│ Repo Map                        │
│ Symbol Map                      │
│ Project Rules                   │
└─────────────────────────────────┘
                 ↓
┌─────────────────────────────────┐
│        DYNAMIC CONTEXT          │
│                                 │
│ Diff                            │
│ Retrieved Context               │
│ Evidence                        │
│ Findings                        │
└─────────────────────────────────┘
```

越靠前：

> **越应该稳定。**

---

# 17. Tool Schema Cache Optimization

Tool Schema 本身属于模型输入。

DSH 的 System Prompt subsystem 会负责 Prompt Sections 与 Tool Schema Assembly，因此 Tool 定义本身会影响模型请求的稳定前缀。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/system-prompt.md "deepseek-harness/docs/subsystems/system-prompt.md at master · deepseek-ai/deepseek-harness · GitHub"))

因此：

> **Review Agent 必须对 Tool 做裁剪。**

默认只挂：

```text
review.get_diff
review.get_symbol
review.get_file
review.find_references
review.get_call_chain
review.search_rule
review.search_history
```

保持：

```text
Tool 数量固定
Tool 顺序固定
Tool Schema 固定
```

---

# 18. Context Ledger

维护：

```text
ContextLedger
```

示例：

```json
{
  "loaded_files": [
    "FooService.java"
  ],
  "loaded_ranges": [
    "FooService.java:100-180"
  ],
  "loaded_symbols": [
    "FooService.update"
  ],
  "loaded_evidence": [
    "caller-outside-transaction"
  ]
}
```

重复读取：

```text
get_file(FooService.java, 100, 180)
```

不再返回原代码，而返回：

```text
Already loaded: ctx#001
```

---

# 19. Context Ledger 的双重价值

它不仅减少 Token，还有两个额外作用。

### 作用一：避免重复 Context

减少：

```text
Input Tokens
```

### 作用二：保持 Context 稳定

避免：

```text
Context Reorder
```

从而保持：

> **Prefix Stable**

所以：

> **Context Ledger = Token Optimization + Cache Optimization**

---

# 20. Append-only Context

推荐严格设计：

```text
Turn 1
[System][Tools][RepoMap][Diff]

Turn 2
[System][Tools][RepoMap][Diff][Symbol]

Turn 3
[System][Tools][RepoMap][Diff][Symbol][Caller]

Turn 4
[System][Tools][RepoMap][Diff][Symbol][Caller][Evidence]
```

而避免：

```text
Turn 1
System + Diff

Turn 2
System + Rule + Diff

Turn 3
System + Caller + Diff + Rule
```

因为后者会不断破坏 Prefix。

---

# 21. Context Mutation Policy

建议：

|Context|Mutation|Cache|
|---|---|---|
|System Prompt|Immutable|Maximum|
|Tool Schema|Immutable|Maximum|
|Review Rules|Immutable|Maximum|
|Repo Map|Snapshot|High|
|Diff|Stable|High|
|Symbol|Append|High|
|Impact|Append|High|
|Evidence|Append|High|
|Finding|Append|High|

原则：

> **能不变就不变，能追加就不重写。**

---

# 22. Review Snapshot

每个 Review Session 可以维护：

```text
ReviewSnapshot
```

包括：

```json
{
  "diff_hash": "...",
  "repo_commit": "...",
  "symbols": [],
  "context": [],
  "evidence": [],
  "findings": []
}
```

这样恢复 Session 时：

```text
Snapshot
+
New Context
```

不需要重新从头构造。

---

# 23. Compaction 设计

Compaction 不允许直接：

> Summary everything

而应该做：

# Review Evidence Compaction

保留：

```text
Changed Symbols
Loaded Context
Applied Rules
Verified Findings
Rejected Findings
Evidence
Unresolved Questions
```

删除：

```text
无价值对话
重复工具结果
重复代码
无效探索
```

DSH 已经将 Compaction 作为独立 capability，并提供与 Session / Prefix 相关的设计基础，因此可以在其基础上实现 Review-specific Compaction。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.md "deepseek-harness/docs/subsystems/compaction.md at master · deepseek-ai/deepseek-harness · GitHub"))

---

# 24. Cache-aware Compaction

Compaction 不能破坏 Stable Prefix。

应采用：

```text
Stable Prefix
+
Retained Review State
+
Compaction Result
```

而不是：

```text
New System Prompt
+
New Tool Schema
+
Summary
```

否则可能从请求前部就破坏缓存复用。

---

# 25. Cache-aware Model Routing

模型选择不能只考虑：

```text
Quality
Cost
```

还需要考虑：

```text
Cache Warmth
```

因此：

```text
Model Score
=
Quality
+
Cost
+
Cache Reuse
```

例如：

```text
Model A
质量高
成本低
Cache = 90%

Model B
质量更高
成本略低
Cache = 0%
```

此时不一定应该切到 B。

---

# 26. Cache Policy

建议设置：

```text
cache_target_hit_rate ≥ 85%
```

并记录：

```text
prefix_length
cache_hit_rate
cached_tokens
uncached_tokens
cache_break_reason
```

---

# 27. Cache Break Detection

这是后续非常值得做的一项能力。

每次发现 Cache 显著下降时记录：

```text
CacheBreakEvent
```

原因分类：

```text
SYSTEM_PROMPT_CHANGED
TOOL_SCHEMA_CHANGED
TOOL_ORDER_CHANGED
MODEL_CHANGED
ROUTE_CHANGED
CONTEXT_REORDERED
CONTEXT_MUTATED
COMPACTION_REBUILT
```

这样能够定位：

> **为什么这一次 Review 的 Cache Hit 突然下降。**

---

# 28. Review Strategy Engine

Strategy Engine 决定：

```text
Review Depth
Context Depth
Tool Budget
Token Budget
Model
Evidence Level
```

输入：

```text
Diff
Language
Changed Symbol
Risk
History
```

---

# 29. Risk-based Review

### Low Risk

```text
Comment
Rename
Formatting
Mechanical Change
```

只：

```text
C0 + C1
```

---

### Medium Risk

```text
Business Logic
API
State
Data Structure
```

：

```text
C0 + C1 + C2
```

---

### High Risk

```text
Concurrency
Transaction
Security
Resource
Distributed
Performance
Lifecycle
```

：

```text
C0 + C1 + C2 + C3
+
Evidence Verification
```

---

# 30. Knowledge Engine

最终：

```text
DTS
Review
Git
Production
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

```text
L1 Coding Rule
L2 CWD Rule
L3 Review Case
L4 Historical Defect
L5 Business Knowledge
```

---

# 31. Evidence Engine

Finding 必须经历：

```text
Candidate
 ↓
Evidence Retrieval
 ↓
Evidence Validation
 ↓
Confidence
 ↓
Accept / Reject
```

默认：

> **No Evidence, No Finding**

---

# 32. Review Finding

统一结构：

```json
{
  "id": "F001",
  "severity": "P1",
  "category": "RESOURCE",
  "file": "FooService.java",
  "line": 128,
  "title": "Resource may not be released",
  "description": "...",
  "evidence": [
    "Foo.update",
    "ResourceManager.open"
  ],
  "rule": "RESOURCE-023",
  "confidence": 0.92
}
```

---

# 33. Prompt Architecture

### Stable Prefix

```text
Role
Objective
Policy
Tool Schema
Finding Schema
Severity
Evidence Policy
```

### Semi-stable

```text
Repo Map
Rules
Project Context
```

### Dynamic

```text
Diff
Symbol
Impact
Evidence
Finding
```

最终实现：

> **Stable Prefix 最大化 Cache，Dynamic Context 最小化 Token。**

---

# 34. DSH Plugin Architecture

建议：

```text
review-policy
review-runtime
review-context
review-knowledge
review-evidence
review-cache
review-metrics
```

其中：

### `review-cache`

正式成为一级 Plugin：

```text
Stable Prefix
Context Ledger
Append-only Policy
Snapshot
Compaction
Cache Metrics
Cache Break Detection
```

---

# 35. Review Agent 与 DSH 的挂接方式

DSH 当前提供：

```text
ctx.sessions
ctx.systemPrompt
ctx.tools
ctx.agents
ctx.agentLoop
ctx.llm
```

等能力入口。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md "deepseek-harness/docs/architecture.md at master · deepseek-ai/deepseek-harness · GitHub"))

因此：

```text
review-runtime
        ↓
Custom Review Agent
        ↓
Custom Review Loop

review-context
        ↓
Context Service

review-cache
        ↓
Cache Policy / Ledger

review-knowledge
        ↓
CWD / History

review-evidence
        ↓
Finding Verification
```

尽可能采用：

> **Plugin / Profile / Patch**

而不是修改 DSH Core。

---

# 36. POC1 重新定义

## POC1：Minimal Sufficient Context + Cache-Stable Review

不再定义为：

> Git Diff + LLM

而定义为：

> **Diff-first + On-demand Context + Cache-aware Review**

---

# 37. POC1 三个基线

### A：Diff-only

```text
Diff
 ↓
LLM
 ↓
Review
```

---

### B：Minimal Context

```text
Diff
 ↓
Symbol
 ↓
Reference
 ↓
Call Chain
 ↓
Review
```

---

### C：Full Repository

```text
Diff
+
Large Repository Context
 ↓
LLM
 ↓
Review
```

---

# 38. POC1 再增加两个缓存实验

### D：Minimal Context + Stable Prefix

验证：

> Prefix 稳定性对缓存的影响。

### E：Minimal Context + Ledger + Append-only

验证：

> Context Ledger 是否同时降低 Token 并提高 Cache Hit。

---

# 39. POC1 实验矩阵

|模式|Context|Cache|核心目的|
|---|---|---|---|
|A|Diff|无特殊设计|最低成本基线|
|B|Minimal|普通|验证精准 Context|
|C|Full Repo|普通|效果上限|
|D|Minimal|Stable Prefix|验证 Prefix Cache|
|E|Minimal|Prefix + Ledger|验证完整 Cache Strategy|

---

# 40. POC1 核心研究问题

### Q1

Diff-only 会漏掉多少深度问题？

### Q2

Symbol Context 能恢复多少？

### Q3

Impact Context 能恢复多少？

### Q4

达到 Full Repo 90% 效果需要多少 Context？

### Q5

Context Ledger 能减少多少重复 Token？

### Q6

Stable Prefix 能提高多少 Cache Hit？

### Q7

Cache 优化是否能在不改变 Review Quality 的情况下进一步降低成本？

---

# 41. POC1 核心指标

## Review Quality

```text
Recall
Precision
F1
False Positive
Acceptance
```

## Context Efficiency

```text
Context Tokens
Context / Finding
Deep Recall / Context Token
```

## Agent Efficiency

```text
Tool Calls
Rounds
Latency
```

## Cache Efficiency

```text
Cache Hit Rate
Cached Tokens
Uncached Tokens
Prefix Length
Cache Break Count
```

---

# 42. 新增两个核心指标

## 42.1 Cache Efficiency

```text
CE =
Cached Input Tokens
────────────────────
Total Input Tokens
```

---

## 42.2 Review Cost Efficiency

```text
RCE =
Review Quality
────────────────────────
Uncached Tokens + Tool Cost
```

---

# 43. 最终核心指标

建议定义：

# Review Intelligence Efficiency

```text
RIE =
Recall × Precision
──────────────────
Total Tokens / 1K
```

以及：

# Cache-adjusted Review Cost

```text
CARC =
Uncached Input Tokens
+
Output Tokens
+
Tool Cost
```

这两个指标同时作为最终优化方向。

---

# 44. Context / Cache 双优化模型

整个成本模型可以定义为：

```text
Review Cost
=
Context Cost
+
Reasoning Cost
+
Tool Cost
```

其中：

```text
Context Cost
=
Cached Context Cost
+
Uncached Context Cost
```

优化方向：

```text
Context Engine
    ↓
减少 Context 总量

Cache Engine
    ↓
提高 Cache Hit

Review Loop
    ↓
减少 Reasoning / Tool Calls
```

---

# 45. Benchmark 数据集

建议使用真实历史数据。

### Dataset A：Historical Defect

```text
Bug 前代码
+
修复 Diff
+
真实 Defect
```

验证：

> Review Agent 能否提前发现。

---

### Dataset B：Historical Review

```text
MR
+
Review Comment
+
Acceptance
```

验证：

> 能否复现真实 Review。

---

### Dataset C：Negative

```text
正常 MR
+
正常 Review
```

控制：

> False Positive。

---

### Dataset D：Hard Case

重点：

```text
Concurrency
Transaction
Resource
Security
Performance
Cross-module
Lifecycle
```

---

# 46. Claude Code Benchmark

保证：

```text
Same Repository
Same Diff
Same Objective
Same Model where possible
```

比较：

```text
Claude Code
Review Agent
Baseline LLM
```

---

# 47. Benchmark Dashboard

```text
Quality
├── Recall
├── Precision
├── F1
└── Acceptance

Efficiency
├── Input Tokens
├── Output Tokens
├── Cached Tokens
├── Uncached Tokens
├── Tool Calls
├── Rounds
└── Latency

Cache
├── Cache Hit Rate
├── Prefix Length
├── Cache Break
└── Cache Reuse

Cost
└── Effective Review Cost
```

---

# 48. 消融实验

### Experiment 1

去掉 Repo Map。

### Experiment 2

去掉 Context Ledger。

### Experiment 3

去掉 Stable Prefix。

### Experiment 4

去掉 Evidence Checker。

### Experiment 5

固定 Loop vs 自由 Loop。

### Experiment 6

普通 Model Routing vs Cache-aware Routing。

目的：

> **证明每个架构组件到底产生了什么价值。**

---

# 49. POC1 推荐 Budget

建议第一阶段：

```text
System / Stable Prefix      2K
Diff                        2K
Symbol Context              3K
Impact Context              5K
Reasoning                   4K
Output                      1K
────────────────────────────
Target                     ~17K
```

最大：

```text
Context Budget = 16~20K
Tool Calls ≤ 6
Rounds ≤ 5
```

具体数值最终通过 Benchmark 调优。

---

# 50. POC 成功标准

## S级

```text
Recall ≥ Claude Code × 90%
Precision ≥ Claude Code
Token ≤ Claude Code × 30%
Tool Calls ≤ Claude Code × 30%
Cache Hit ≥ 85%
```

## A级

```text
Recall ≥ Claude Code × 80%
Token ≤ Claude Code × 30%
Cache Hit ≥ 80%
```

## B级

```text
Recall ≥ Claude Code × 70%
Token ≤ Claude Code × 50%
```

---

# 51. 推荐开发阶段

## Phase 1：DSH Review Runtime

```text
DSH
 ↓
Review Agent
 ↓
Custom Review Loop
```

验证：

> DSH 是否可以承载 Review Runtime。

---

## Phase 2：Minimal Context

```text
Diff
 ↓
Repo Map
 ↓
Symbol
 ↓
Reference
 ↓
Call Chain
```

验证：

> Minimal Sufficient Context。

---

## Phase 3：Cache Engine

```text
Stable Prefix
+
Context Ledger
+
Append-only
+
Snapshot
+
Compaction
```

验证：

> Cache Hit / Token。

---

## Phase 4：Knowledge

```text
CWD
+
History
+
DTS
```

验证：

> Domain Intelligence。

---

## Phase 5：Evidence

```text
Finding
 ↓
Evidence
 ↓
Verification
```

验证：

> Precision / False Positive。

---

## Phase 6：Feedback

```text
Review
 ↓
Human Accept / Reject
 ↓
Knowledge
 ↓
Rule
 ↓
Review
```

形成：

> Review Data Flywheel。

---

# 52. 风险与应对

## 风险一：Context 太少

表现：

```text
Recall ↓
深度问题 ↓
```

应对：

> C1 → C2 → C3 按风险升级。

---

## 风险二：Context 太多

表现：

```text
Token ↑
Latency ↑
```

应对：

> Context Budget + Ranking。

---

## 风险三：Cache 很高但 Context 不够

不能单纯追求：

> Cache Hit Rate。

必须同时看：

```text
Recall
Precision
Cache
Token
```

---

## 风险四：Context 动态变化导致 Cache Break

应对：

```text
Stable Prefix
+
Append-only
+
Cache Break Detection
```

---

## 风险五：DSH API 快速变化

当前 DSH 官方仍定位为 Developer Preview，因此必须控制依赖风险。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md "deepseek-harness/README.md at master · deepseek-ai/deepseek-harness · GitHub"))

建议：

```text
Pin Commit
+
Plugin-first
+
Adapter Layer
+
No Core Patch
```

---

# 53. 最终架构原则

整个系统坚持：

```text
01  Diff-first，而不是 Diff-only
02  Minimal Context，而不是 Full Context
03  Evidence-driven，而不是 Guess-driven
04  Stable Prefix，而不是 Dynamic Prefix
05  Append-only，而不是 Context Rebuild
06  Cache-aware，而不是只看 Token
07  Bounded Loop，而不是无限探索
08  Rule + AI，而不是纯 LLM
09  Benchmark，而不是主观评价
10  Quality / Cost，而不是单一 Accuracy
```

---

# 54. 最终技术模型

整个 Review Agent 可以归纳为：

```text
                    Review Agent
                         │
      ┌──────────────────┼──────────────────┐
      ↓                  ↓                  ↓
Context Engine      Review Engine      Cache Engine
      │                  │                  │
   看什么             怎么判断           怎么低成本判断
      │                  │                  │
      └──────────────────┼──────────────────┘
                         ↓
                  Evidence Engine
                         ↓
                   Review Finding
                         ↓
                    Feedback Loop
```

底层统一由：

```text
DeepSeek Harness
```

提供：

```text
Agent
Session
Tool
Prompt
Event
LLM
Plugin
```

---

# 55. 核心架构价值

最终不再是：

> **“做一个更小的 Claude Code。”**

而是：

> ### **构建一个 Cache-Stable、Evidence-Driven、Context-Efficient 的专用 AI Review Runtime。**

核心差异：

```text
Claude Code

更多 Context
      +
更长 Loop
      +
通用 Tool
      ↓
强通用能力


Review Agent

最小充分 Context
      +
专用 Review Loop
      +
稳定 Prefix
      +
Context Ledger
      +
Evidence
      +
领域知识
      ↓
高 Review Intelligence / Token
```

---

# 56. 最终项目核心命题

建议在技术方案首页直接定义：

>  **Minimal Sufficient Context + Cache-Stable Agent Loop**
> 
> 不追求让 AI 看到更多代码，而追求让 AI 用最少的有效 Context 获得足够的证据；不追求减少所有 Token，而追求减少无效 Token、Uncached Token，并最大化稳定 Prefix 的缓存复用。

---

# 57. 最终一句话方案

> **基于 DeepSeek Harness 构建专用 Review Runtime，以 Diff-first 驱动精准上下文获取，以 Minimal Sufficient Context 保证深度检视，以 Stable Prefix + Context Ledger + Append-only Context + Cache-aware Routing 实现高缓存命中，以 CWD/历史缺陷提供领域 Intelligence，以 Evidence Engine 控制误报，最终通过 Quality / Token / Cache 三维 Benchmark 持续优化。**

这一架构最终希望达到的理想状态是：

```text
                    Full Repository Agent
                           │
                       100% Context
                           │
                           ↓
                      高 Review 能力
                           │
                           │
                           ╲
                            ╲
                             ╲
                        Review Agent
                             │
                    20~30% Context / Token
                             │
                    80~90%+ Review Quality
                             │
                      85%+ Cache Hit
                             │
                             ↓
                   更高的 Review 性价比
```

这才是这个项目最值得证明的工程价值。

这一版里，我建议把 **Cache Optimization Engine** 正式视为和 `Context Engine / Review Engine / Knowledge Engine / Evidence Engine` 同级的核心模块，而不是性能优化附录。这样以后你做 PoC、技术汇报和 Benchmark 时，技术主线会非常清晰：**Context 决定看什么，Review Loop 决定怎么想，Cache Engine 决定怎么低成本地想。**

DSH 当前的 Session append-only、Prompt/Tool Schema 组装、Agent pre-step、Agent Loop 可替换等机制，也确实为这套设计提供了比较合适的底层扩展点。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md "deepseek-harness/docs/architecture.md at master · deepseek-ai/deepseek-harness · GitHub"))
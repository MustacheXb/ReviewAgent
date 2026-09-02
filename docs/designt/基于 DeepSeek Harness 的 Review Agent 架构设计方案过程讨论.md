可以。基于前面的讨论，以及我对 **DeepSeek Harness（DSH）当前架构文档**的进一步核对，我建议把这份文档定位成一份真正可以进入技术评审和 PoC 开发的《架构设计方案》，而不是简单的功能说明。

有一个重要架构结论我会放在最前面：

> **Review Agent 不应是“在 DSH 上增加一个 Review Prompt”，而应是“基于 DSH 可插拔 Agent Runtime，重新构建一个面向 Code Review 的专用 Runtime + Context Engine + Knowledge Engine + Evidence Engine”。**

DSH 当前的核心包已经明确将 `session`、`system-prompt`、`tools`、`agent`、`agent-loop`、`llm` 做成独立的服务/扩展点，并且官方明确说明默认 `agent-loop` 是 Agent 接口的一个可替换实现。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md?utm_source=chatgpt.com))
同时，DSH 当前仍处于 Developer Preview，官方明确提示会存在兼容性破坏性变更，这一点需要在工程策略里单独控制。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md?utm_source=chatgpt.com))

下面给你一版完整的架构设计文档。

------

# 基于 DeepSeek Harness 的 Review Agent 架构设计方案

## 1. 文档概述

### 1.1 项目名称

**Review Agent —— 基于 DeepSeek Harness 的专用 AI 代码检视 Agent**

### 1.2 项目定位

构建一个面向 Code Review 场景的专用 Agent，通过：

> **专用 Review Loop + 精准 Context + 领域知识 + 证据验证 + 成本控制**

在显著低于 Claude Code / OpenCode 等通用 Coding Agent 的 Token、Tool Call 和算力消耗下，实现接近甚至特定场景优于通用 Agent 的代码检视质量。

### 1.3 核心理念

> **不是让 AI 看更多代码，而是让 AI 为每一个 Review 判断获取“最小充分证据”。**

对应的核心公式：

```text
Review Quality
=
Change Understanding
+
Minimal Sufficient Context
+
Domain Knowledge
+
Reasoning
+
Evidence Verification
```

------

# 2. 项目背景

## 2.1 AI Coding 带来的质量挑战

Claude Code、OpenCode 等通用 Coding Agent 已经能够在较高程度上完成：

```text
需求理解
 ↓
代码搜索
 ↓
上下文构建
 ↓
代码修改
 ↓
编译
 ↓
测试
 ↓
Debug
 ↓
再次修改
```

这种完整的 Agent Loop 适合“软件开发”任务，但代码检视实际上是一个更加收敛的任务：

```text
理解 Change
 ↓
识别风险
 ↓
获取必要 Context
 ↓
形成假设
 ↓
验证证据
 ↓
输出 Finding
```

因此将通用 Coding Agent 直接用于 Code Review，会产生大量与 Review 无关的成本。

------

# 3. 核心问题定义

需要重点解决四个问题。

## 问题一：通用 Agent 的 Context 成本高

为了判断一个局部变更，通用 Agent 可能：

```text
搜索文件
 → Read
 → Search
 → Read
 → Search
 → Read
```

大量 Token 花费在：

> “寻找上下文”

而不是：

> “判断问题”。

------

## 问题二：Diff-only 又可能造成深度问题漏检

简单地将：

> Full Repository

缩减为：

> Git Diff

又会导致以下问题无法可靠判断：

- Caller / Callee；
- 跨模块影响；
- 状态变化；
- 生命周期；
- 事务；
- 并发；
- API Contract；
- 资源释放；
- 历史缺陷模式。

因此项目不能走：

> **Full Context → Diff-only**

而应走：

> **Full Context → Minimal Sufficient Context**

------

## 问题三：通用 Agent 不具备足够的组织领域知识

企业级 Review 往往需要结合：

```text
编程规范
CWD
历史 Review
历史缺陷
DTS
业务规则
现网问题
```

因此仅靠通用模型不够。

------

## 问题四：Review 缺少强约束

如果 Agent 可以无限：

- 搜索；
- 读取；
- 推理；
- 调用工具；

最终又会重新变成：

> Mini Claude Code

因此需要：

```text
Context Budget
Tool Budget
Round Budget
Evidence Budget
```

------

# 4. 核心设计目标

## 4.1 功能目标

实现：

```text
Git Diff
 ↓
Change Understanding
 ↓
Risk Classification
 ↓
Context Decision
 ↓
Context Retrieval
 ↓
Review Reasoning
 ↓
Evidence Verification
 ↓
Review Finding
```

------

## 4.2 性能目标

重点优化：

```text
Token / Review
Tool Calls / Review
Latency / Review
Cost / Review
```

------

## 4.3 质量目标

目标不是一开始就超过 Claude Code，而是：

```text
Recall ≈ Claude Code
Precision ≥ Claude Code
Token << Claude Code
```

推荐第一阶段目标：

```text
Review Recall ≥ Claude Code × 80~90%

Token ≤ Claude Code × 30%

Tool Calls ≤ Claude Code × 30%
```

------

# 5. 架构设计原则

## 原则一：专用优于通用

Review Agent 不复用完整 Coding Agent Loop。

------

## 原则二：Diff-first，但不是 Diff-only

Diff 是 Context Root。

但 Agent 可以按需获取：

```text
Symbol
Caller
Callee
Reference
Call Chain
State
Rule
History
```

------

## 原则三：Evidence-driven

任何 Finding 都需要有证据支撑。

> **No Evidence, No Finding**

------

## 原则四：Read-only 优先

V0.1 默认不允许：

```text
write_file
edit_file
delete_file
git_commit
git_push
```

------

## 原则五：预算驱动

所有 Agent 行为受：

```text
Token Budget
Tool Budget
Round Budget
Context Budget
```

约束。

------

## 原则六：Harness 与 Review Intelligence 解耦

DSH 负责：

> Agent 如何运行

Review Agent 负责：

> Review 应该如何完成

------

# 6. 为什么选择 DeepSeek Harness

DSH 当前采用 **Everything is a Plugin** 架构，由 Cordis 驱动。官方架构明确将 Session、System Prompt、Tool Registry、Agent、Agent Loop、LLM Adapter 等拆成独立扩展点。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md?utm_source=chatgpt.com))

这与 Review Agent 的需求高度匹配。

------

## 6.1 可以替换 Agent Loop

DSH：

```text
Agent Interface
       ↓
Default Agent Loop
```

但官方架构明确说明：

> `agent-loop` 是 Agent 接口的默认具体驱动，可以被扩展替换。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md?utm_source=chatgpt.com))

因此可以：

```text
                    DSH Agent
                        │
             ┌──────────┴──────────┐
             ↓                     ↓
       Coding Agent          Review Agent
             │                     │
       Coding Loop            Review Loop
```

------

## 6.2 Prompt 可组合

DSH 的 `system-prompt` 负责 Prompt Section 和 Tool Schema Assembly。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md?utm_source=chatgpt.com))

因此 Review Prompt 可以分成：

```text
Stable Prefix
├── Review Role
├── Review Policy
├── Finding Schema
├── Evidence Policy
└── Review Rules
```

动态 Context：

```text
Diff
Symbol
Impact
Rule
History
Evidence
```

------

## 6.3 Session 天然适合 Review 数据闭环

DSH Session 采用 append-only typed event log，LLM message history 是从 Session log 派生，而不是单独存储。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md?utm_source=chatgpt.com))

因此可以把 Review 生命周期结构化成：

```text
review/start
diff/analyzed
risk/classified
context/requested
context/loaded
finding/candidate
finding/verified
finding/rejected
review/completed
```

这为后续：

> Review 数据分析 / Feedback / Harness 自进化

提供结构化基础。

------

## 6.4 Tool Runtime 具备成熟的执行管线

DSH Tools 具备：

```text
pre-execute
guards
execute
post-execute
result
```

的执行链路，可以对 Tool 做统一管控、超时、重试、指标统计和结果处理。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md?utm_source=chatgpt.com))

因此适合实施：

```text
Tool Allowlist
Tool Budget
Timeout
Metrics
Evidence Attachment
```

------

# 7. 总体架构

```text
                         ┌──────────────────────┐
                         │      Git / MR         │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │      Diff Engine      │
                         │ File / Hunk / Symbol  │
                         └──────────┬───────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                │                   │                   │
                ▼                   ▼                   ▼
       ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
       │ Context Engine │  │ Knowledge      │  │ Check Engine   │
       │                │  │ Engine         │  │                │
       │ Repo Map       │  │ CWD            │  │ CodeCheck      │
       │ Symbol Map     │  │ Review History │  │ Compiler       │
       │ Call Graph     │  │ DTS            │  │ Test           │
       │ Context Ledger │  │ Business Rules │  │ Runtime        │
       └────────┬───────┘  └────────┬───────┘  └───────┬────────┘
                └───────────────────┼───────────────────┘
                                    ▼
                         ┌──────────────────────┐
                         │   Review Strategy    │
                         │ Risk / Context /     │
                         │ Budget / Policy      │
                         └──────────┬───────────┘
                                    ▼
                         ┌──────────────────────┐
                         │  Review Agent Driver │
                         │                      │
                         │ Detect               │
                         │ Reason               │
                         │ Verify               │
                         │ Decide               │
                         └──────────┬───────────┘
                                    ▼
                         ┌──────────────────────┐
                         │   Evidence Engine    │
                         └──────────┬───────────┘
                                    ▼
                         ┌──────────────────────┐
                         │ Structured Findings  │
                         └──────────────────────┘
```

底层：

```text
                 DeepSeek Harness
                        │
       ┌────────────────┼──────────────────┐
       ▼                ▼                  ▼
    Cordis            Session           System Prompt
       │                │                  │
       ▼                ▼                  ▼
   Plugins            Events           Context Assembly
       │
       ├── Agent
       ├── Agent Loop
       ├── Tools
       └── LLM
```

------

# 8. 架构分层

整体建议分为五层。

## L1：Harness Runtime

基于：

> DeepSeek Harness / Cordis

负责：

- Plugin；
- Session；
- Event；
- Tool；
- Agent；
- LLM；
- Lifecycle。

------

## L2：Review Runtime

这是你的核心。

负责：

- Review Agent；
- Review Loop；
- Review Policy；
- Risk Strategy；
- Budget；
- Finding Lifecycle。

------

## L3：Context Engine

负责：

- Diff；
- Repo Map；
- Symbol；
- Reference；
- Call Chain；
- Impact；
- Context Ledger；
- Context Compression。

------

## L4：Knowledge Engine

负责：

- CWD；
- Review History；
- DTS；
- Business Rule；
- Defect Pattern。

------

## L5：Verification & Evaluation

负责：

- Evidence；
- Static Check；
- Compile；
- Test；
- Benchmark；
- Metrics。

------

# 9. Review Runtime 设计

这是整个项目与通用 Coding Agent 最核心的差异。

## 9.1 Coding Runtime

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
Edit
```

------

## 9.2 Review Runtime

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

Review Runtime 不承担代码修改。

------

# 10. Review Agent Loop

## 10.1 总体 Loop

```text
START
  │
  ▼
Change Understanding
  │
  ▼
Risk Classification
  │
  ▼
Context Decision
  │
  ▼
Context Retrieval
  │
  ▼
Deep Review
  │
  ▼
Evidence Verification
  │
  ▼
Final Findings
```

------

## 10.2 核心循环

真正的智能 Loop 是：

```text
Hypothesis
    ↓
What evidence is missing?
    ↓
Evidence Request
    ↓
Evidence
    ↓
Update hypothesis
    ↓
Verify
```

即：

> **Evidence-driven Agent Loop**

而不是：

```text
Search → Search → Read → Search → Read
```

------

# 11. Context Engine 设计

## 11.1 Context 四层模型

```text
C0：Diff
       ↓
C1：Symbol
       ↓
C2：Impact
       ↓
C3：Knowledge
```

------

## C0：Diff Context

包括：

```text
Changed Files
Changed Hunk
Changed Lines
Changed Symbols
Change Type
```

100% 加载。

------

## C1：Symbol Context

优先获取：

```text
Changed Class
Changed Method
Local Dependencies
Nearby Related Code
```

------

## C2：Impact Context

按需获取：

```text
Caller
Callee
Reference
Interface
Base Class
State
Dependency
```

------

## C3：Knowledge Context

按需获取：

```text
CWD
Historical Review
Historical Defect
Business Rule
```

------

# 12. “Minimal Sufficient Context” 核心算法

Agent 不问：

> “还有哪些代码可以看？”

而问：

> “为了验证当前 Finding，我还缺什么证据？”

例如：

```text
Finding：
可能出现资源泄漏

缺失证据：
Resource.close() 是否由 Callee 负责？

Context Request：
get_symbol(process)
```

返回：

```text
process() does not close Resource
```

Finding 从：

```text
Possible Resource Leak
```

变成：

```text
Confirmed Resource Leak
```

这就是：

> **Context Decision → Evidence Retrieval → Finding Verification**

------

# 13. Repo Map 设计

建立轻量级：

```text
File Tree
+
Symbol Tree
```

推荐优先支持：

```text
Java
Python
```

后续：

```text
C/C++
Go
TypeScript
Kotlin
```

Repo Map 示例：

```text
FooService.java
 ├── class FooService
 │   ├── update()
 │   ├── delete()
 │   └── validate()
```

------

# 14. Context Ledger

维护：

```text
ContextLedger
```

核心数据：

```json
{
  "files": [],
  "ranges": [],
  "symbols": [],
  "references": [],
  "rules": [],
  "evidence": [],
  "rejected_context": []
}
```

作用：

### 防止重复读取

第一次：

```text
get_file(Foo.java, 100-180)
```

返回代码。

第二次：

```text
get_file(Foo.java, 100-180)
```

返回：

```text
Already loaded: ctx#001
```

避免重复 Context。

------

# 15. Context Compression

不是简单对话 Summary。

而是：

```text
Context Compaction
├── Loaded Symbols
├── Key Evidence
├── Applied Rules
├── Verified Findings
├── Rejected Findings
└── Unresolved Questions
```

只保留：

> 事实 + 证据 + 结论 + 未决问题

------

# 16. Knowledge Engine

长期形成：

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

知识分级：

```text
L1 Coding Rule
L2 CWD
L3 Historical Review
L4 Historical Defect
L5 Business Knowledge
```

------

# 17. Review Strategy Engine

Strategy Engine 决定：

> **当前 Change 应该用多少成本进行 Review。**

输入：

```text
Diff
Language
Changed Symbols
History
Risk
```

输出：

```text
Review Depth
Context Budget
Tool Budget
Model
```

------

# 18. 风险分级

### Low Risk

```text
注释
格式
机械重命名
简单字段修改
```

策略：

```text
Diff + Symbol
```

------

### Medium Risk

```text
业务逻辑
API
数据结构
状态修改
```

策略：

```text
Diff + Symbol + Impact
```

------

### High Risk

```text
并发
事务
资源
安全
分布式
性能
核心状态
```

策略：

```text
Diff
+
Symbol
+
Impact
+
Knowledge
+
Evidence
```

------

# 19. Tool 设计

V0.1 建议控制在 7 个左右。

```text
review.get_diff
review.get_symbol
review.get_file
review.find_references
review.get_call_chain
review.search_rule
review.search_history
```

V0.2 再加入：

```text
review.run_check
review.compile
review.test
```

------

# 20. Tool Policy

所有 Tool 都受到：

```text
Allowlist
Budget
Timeout
Scope
```

约束。

例如：

```text
max_tool_calls = 6
```

避免：

```text
无限 grep
无限 read
```

------

# 21. Review Evidence Engine

任何 Finding：

```text
Candidate Finding
       ↓
Evidence Retrieval
       ↓
Evidence Validation
       ↓
Decision
```

结果：

```text
Verified
Rejected
Uncertain
```

最终只允许：

```text
Verified
```

进入默认 Review Output。

------

# 22. Finding 模型

建议统一：

```json
{
  "id": "F001",
  "severity": "P1",
  "category": "RESOURCE",
  "file": "Foo.java",
  "line": 128,
  "title": "Resource may not be released",
  "description": "...",
  "evidence": [
    "Foo.update()",
    "ResourceManager.open()"
  ],
  "rule": "RESOURCE-023",
  "confidence": 0.92
}
```

------

# 23. Prompt Architecture

## Stable Prefix

```text
Review Role
Review Objective
Finding Schema
Severity Definition
Evidence Policy
Review Rules
Tool Policy
```

## Dynamic Context

```text
Git Diff
Symbol
Impact
Rules
History
Evidence
```

原则：

> **Stable Prefix 最大化缓存；Dynamic Context 最小化变化。**

------

# 24. Model Routing

后续支持：

```text
                  Risk
                   │
         ┌─────────┼─────────┐
         ▼         ▼         ▼
        Low      Medium     High
         │         │         │
       Cheap     Medium     Strong
       Model      Model      Model
```

目标：

> **不是所有 Change 都值得调用 Strong Model。**

------

# 25. DSH Plugin 设计

建议至少设计以下插件：

```text
review-policy
review-runtime
review-context
review-knowledge
review-evidence
review-metrics
```

------

## 25.1 review-policy

负责：

```text
Review Objective
Severity
Budget
Finding Schema
Evidence Policy
```

------

## 25.2 review-runtime

负责：

```text
Review Agent
Review Loop
Risk Strategy
Agent Lifecycle
```

------

## 25.3 review-context

负责：

```text
Diff
Repo Map
Symbol
Reference
Call Graph
Ledger
```

------

## 25.4 review-knowledge

负责：

```text
CWD
History
DTS
Business Rule
```

------

## 25.5 review-evidence

负责：

```text
Candidate
Evidence
Validation
Scoring
```

------

## 25.6 review-metrics

负责：

```text
Token
Tool Calls
Latency
Cache
Review Quality
```

------

# 26. DSH 中的核心挂载关系

建议采用：

```text
Cordis
 │
 ├── ctx.sessions
 ├── ctx.systemPrompt
 ├── ctx.tools
 ├── ctx.agents
 ├── ctx.agentLoop
 └── ctx.llm
```

Review Plugin：

```text
review-runtime
     │
     ├── Agent
     ├── Review Driver
     └── Review Policy

review-context
     │
     ├── Context Service
     └── Context Tools

review-knowledge
     │
     └── Knowledge Service

review-evidence
     │
     └── Evidence Service
```

这样避免直接侵入 DSH Core。

------

# 27. POC1 重新定义

正式名称：

# Review Agent POC1：Minimal Sufficient Context Review

核心目标：

> **验证只获取最小充分 Context，能否达到 Full Repository Agent 接近的深度 Review 能力。**

------

# 28. POC1 三组对照实验

## Experiment A：Diff-only

```text
Diff
 ↓
LLM
 ↓
Review
```

作为最低成本 Baseline。

------

## Experiment B：Minimal Context

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

这是 Review Agent。

------

## Experiment C：Full Context

```text
Diff
+
Large Repository Context
 ↓
LLM
 ↓
Review
```

作为效果上限。

------

# 29. POC1 最重要的科学问题

回答：

### Q1

Diff-only 会漏掉多少深度问题？

### Q2

Symbol Context 能恢复多少？

### Q3

Impact Context 能恢复多少？

### Q4

达到 Full Context 90% 效果需要多少 Context？

最终寻找：

> **Minimal Sufficient Context**

------

# 30. POC1 Agent Loop

```text
START
 ↓
Parse Diff
 ↓
Risk Classification
 ↓
Load Symbol
 ↓
Need More Evidence?
 ├── NO → Review
 └── YES
       ↓
   Request Caller/Callee
       ↓
   Call Chain
       ↓
   Review
       ↓
   Evidence Check
       ↓
   Final Finding
```

------

# 31. POC1 Token Budget

建议硬限制：

```text
Diff                 2K
Symbol               3K
Impact               5K
Reasoning            4K
Output               1K
────────────────────────
Target              ~15K
```

最大：

```text
16K / Review
```

超出后：

```text
budget_exceeded = true
```

记录到 Benchmark。

------

# 32. POC1 Tool Budget

```text
max_rounds = 5
max_tool_calls = 6
max_context_tokens = 16K
```

重点实验：

> Tool Call 数量与 Review Quality 的关系。

------

# 33. Benchmark 数据集

建议使用真实历史数据。

## Dataset A：Historical Defects

```text
Bug 前代码
+
修复 Diff
+
真实 Defect
```

------

## Dataset B：Historical Review

```text
MR
+
Review Comment
+
Acceptance
```

------

## Dataset C：Negative Samples

正常代码。

用于控制 False Positive。

------

## Dataset D：Hard Cases

重点：

```text
并发
事务
资源
安全
性能
跨模块
生命周期
```

------

# 34. Benchmark 指标

## Quality

```text
Recall
Precision
F1
False Positive
Acceptance
```

## Efficiency

```text
Input Tokens
Output Tokens
Cached Tokens
Total Tokens
Tool Calls
Rounds
Latency
Cost
```

------

# 35. 核心指标

建议建立：

## Review Intelligence Efficiency

```text
RIE =
Recall × Precision
──────────────────
Total Tokens / 1K
```

用于衡量：

> **单位 Token 产生多少有效 Review Intelligence。**

------

# 36. Benchmark 目标

### S 级

```text
Recall ≥ Claude Code × 90%
Precision ≥ Claude Code
Token ≤ Claude Code × 30%
Tool Calls ≤ Claude Code × 30%
```

### A 级

```text
Recall ≥ Claude Code × 80%
Token ≤ Claude Code × 30%
```

### B 级

```text
Recall ≥ Claude Code × 70%
Token ≤ Claude Code × 50%
```

------

# 37. 消融实验

POC 必须增加消融实验。

## Experiment 1

去掉 Repo Map。

观察：

```text
Recall
Token
```

------

## Experiment 2

去掉 Context Ledger。

观察：

```text
重复 Context
Token
```

------

## Experiment 3

去掉 Evidence Checker。

观察：

```text
False Positive
Precision
```

------

## Experiment 4

固定 Loop vs 无限 Loop。

观察：

```text
Tool Calls
Token
Recall
```

------

# 38. 关键问题与解决方案

| 关键问题                  | 分析                   | 解决方案                   |
| ------------------------- | ---------------------- | -------------------------- |
| Diff 太少导致深度问题漏检 | 缺 Caller/Callee/State | 按需 Context Retrieval     |
| Context 太多导致成本高    | 通用 Agent 全库探索    | Repo Map + Symbol + Impact |
| Agent 无限探索            | Tool Loop 失控         | Tool Budget / Round Budget |
| AI 误报                   | 缺乏证据约束           | Evidence Gate              |
| Rule 太多导致 Prompt 膨胀 | 全量注入 CWD           | Rule Retrieval             |
| 每轮重复读取代码          | Context 重复           | Context Ledger             |
| 长 Session 膨胀           | 历史消息堆积           | Evidence Compaction        |
| 所有场景都用强模型        | 成本高                 | Risk-based Model Routing   |
| DSH 快速演进              | API 可能变化           | Plugin-first / Pin Version |

------

# 39. DSH 使用策略

由于 DSH 当前官方仍标注为 Developer Preview，并明确提示存在 compatibility-breaking changes，因此项目不建议直接修改其 Core。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md?utm_source=chatgpt.com))

推荐：

```text
DeepSeek Harness
       │
       │ 固定版本 / Commit
       ↓
Review Plugin Layer
       ↓
Review Intelligence
```

原则：

> **尽可能不修改 DSH Core。**

重点使用：

```text
Agent seam
Tool seam
Prompt seam
Session/Event seam
LLM seam
```

这些官方已经明确提供的扩展边界。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md?utm_source=chatgpt.com))

------

# 40. V0.1 代码目录建议

```text
review-agent/
│
├── packages/
│   ├── review-runtime/
│   │   ├── review-agent.ts
│   │   ├── review-loop.ts
│   │   ├── risk-policy.ts
│   │   └── review-events.ts
│   │
│   ├── review-context/
│   │   ├── diff-engine.ts
│   │   ├── repo-map.ts
│   │   ├── symbol-map.ts
│   │   ├── impact-map.ts
│   │   └── context-ledger.ts
│   │
│   ├── review-knowledge/
│   │   ├── rule-store.ts
│   │   ├── cwd.ts
│   │   └── history.ts
│   │
│   ├── review-evidence/
│   │   ├── evidence-checker.ts
│   │   └── finding-scorer.ts
│   │
│   └── review-metrics/
│       ├── token.ts
│       ├── latency.ts
│       └── benchmark.ts
│
├── prompts/
├── rules/
├── benchmark/
├── cli/
└── tests/
```

------

# 41. 技术实现建议

## Agent Runtime

```text
TypeScript
+
DeepSeek Harness
+
Cordis
```

------

## AST / Symbol

优先：

```text
Tree-sitter
```

后续可以结合：

```text
LSP
Language Server
Compiler AST
```

------

## Context Storage

V0.1 不需要数据库。

直接：

```text
In-memory Context Ledger
+
Local JSON
```

------

## Knowledge

V0.1：

```text
YAML / JSON
```

V0.2：

```text
Vector Search
+
Keyword Search
+
Structured Retrieval
```

------

# 42. POC 开发顺序

## Phase 1：Runtime

```text
DSH
 ↓
Review Agent
 ↓
Review Loop
```

------

## Phase 2：Diff

```text
Git Diff
 ↓
Changed Symbols
```

------

## Phase 3：Context

```text
Symbol
 ↓
Reference
 ↓
Call Chain
 ↓
Ledger
```

------

## Phase 4：Evidence

```text
Finding
 ↓
Evidence
 ↓
Verification
```

------

## Phase 5：Benchmark

```text
50~100 MR
 ↓
A/B/C
 ↓
Claude Code
 ↓
分析结果
```

------

# 43. POC 第一阶段验收标准

## 功能验收

必须可以：

```bash
review-agent review --base HEAD~1
```

完成：

```text
Git Diff
 ↓
Risk
 ↓
Context
 ↓
Review
 ↓
Finding
```

------

## 技术验收

必须输出：

```text
Total Tokens
Input Tokens
Output Tokens
Cached Tokens
Tool Calls
Rounds
Latency
```

------

## 质量验收

至少有：

```text
50+ Real MR
```

可重复运行。

------

# 44. 后续 V0.2 演进

加入：

```text
CWD
Historical Review
Historical Defects
Git History
Business Rule
```

形成：

```text
Context Engine
+
Knowledge Engine
```

------

# 45. V0.3 演进

加入：

```text
CodeCheck
Compile
Unit Test
Runtime Validation
```

形成：

```text
Review
 ↓
Evidence
 ↓
Validation
```

------

# 46. V0.4 演进

加入：

```text
Human Accept
Human Reject
False Positive
New Defect
```

形成：

```text
Review
 ↓
Feedback
 ↓
Knowledge
 ↓
New Rule
 ↓
Review
```

------

# 47. 最终 V1.0

最终形成：

```text
                     AI Review Engine
                           │
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
   Context Engine     Knowledge Engine   Evidence Engine
        │                  │                  │
     Repo Map             CWD              Static Check
     Symbol               DTS              Compile
     Call Graph           History          Test
     Ledger               Business         Runtime
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ↓
                    Review Agent Runtime
                           │
                      DSH Harness
                           │
                       LLM Router
```

------

# 48. 长期技术护城河

项目真正的壁垒不在 DeepSeek Harness，也不在 Prompt。

核心壁垒应该是：

## 1. Context Engine

> 如何用最少 Context 获得足够证据。

## 2. Review Knowledge

> 如何把历史缺陷转化为 Review Intelligence。

## 3. Evidence Engine

> 如何把“模型判断”变成“证据证明”。

## 4. Benchmark

> 如何持续衡量 Quality / Token。

## 5. Feedback Loop

> 如何让 Review Agent 越用越懂业务。

------

# 49. 项目的核心技术命题

整个项目最终应该围绕一句话展开：

> ### **Minimal Sufficient Context for Code Review**

即：

> **对一个代码变更，找到能够支撑正确 Review 判断的最小充分上下文。**

这比：

> “把整个 Repo 给 AI”

更有工程价值。

------

# 50. 最终架构判断

基于当前 DSH 的架构设计，我对这个方案的判断是：

### 技术可行性：★★★★★

DSH 的：

```text
Plugin
Agent
Agent Loop
Tool
Prompt
Session
Event
LLM
```

都具有清晰的扩展边界，非常适合承载专用 Review Runtime。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md?utm_source=chatgpt.com))

### Review 场景匹配度：★★★★★

Review 本身是非常适合做专用 Agent 的场景，因为：

> 目标单一、Loop 可收敛、Tool 可裁剪、Context 可精准检索、结果可量化。

### 最大风险：★★★★

不是算法风险，而是：

> DSH 当前处于 Developer Preview，存在兼容性破坏变化。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md?utm_source=chatgpt.com))

因此需要：

```text
Pin Commit
+
Plugin-first
+
No Core Patch
+
Adapter Layer
```

------

# 51. 最终方案一句话

> **以 DeepSeek Harness 作为可插拔 Agent Runtime，以 Review Agent Driver 重构通用 Coding Loop，以 Context Engine 实现“Diff-first + 按需取证”，以 CWD/历史缺陷构建 Review Intelligence，以 Evidence Engine 控制误报，最终通过 Benchmark 持续优化“Review Quality / Token”。**

最终形成：

```text
                  Claude Code
                      │
                 全能力通用
                      │
          ┌───────────┴───────────┐
          │                       │
       高 Context              高 Tool Loop
          │                       │
          └───────────┬───────────┘
                      ↓
                   高成本


                 Review Agent
                      │
             ┌────────┼────────┐
             ↓        ↓        ↓
           Diff     Context   Knowledge
             │      on-demand    │
             │        │          │
             └────────┼──────────┘
                      ↓
                  Evidence
                      ↓
                 Review Finding
                      ↓
               低 Token / 高质量
```

**核心不是“做一个更小的 Claude Code”，而是重新定义一个面向 Code Review 的 Agent Runtime。**

------

## 53. 建议作为技术方案首页的核心判断

> ### **AI Coding 时代，代码检视不应继续依赖通用 Coding Agent。**
>
> 通用 Agent 依赖“更多上下文 + 更长 Loop”获得能力；专用 Review Agent 应通过“更精准的上下文 + 更短的 Review Loop + 更强的领域知识 + 更严格的证据验证”获得能力。
>
> **DeepSeek Harness 提供可插拔内核，Review Agent 构建专用 Runtime，最终以 Quality / Token 作为核心优化目标。**



进一步形成一份可以直接交给开发人员执行的 **《Review Agent on DeepSeek Harness V0.1 技术设计 + 代码目录 + Plugin API + Agent Loop 时序图 + POC 任务分解》**  
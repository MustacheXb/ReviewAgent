# Review Agent 项目分阶段实现计划书

## 1. 项目定位

### 1.1 项目名称

**Review Agent —— 基于 DeepSeek Harness 的低成本高质量 AI Code Review Agent**

### 1.2 项目愿景

构建一个面向代码检视场景的专用 Agent，通过：

> **专用 Review Runtime + Minimal Sufficient Context + Cache Optimization + Domain Knowledge + Evidence Verification + Feedback Evolution**

在显著低于 Claude Code / OpenCode 等通用 Coding Agent 的 Token、Tool Call 和算力消耗下，获得接近甚至特定场景优于通用 Agent 的代码检视能力。

---

# 2. 项目核心技术路线

整个项目围绕六个核心能力逐步建设：

```text
                   Review Agent
                        │
        ┌───────────────┼────────────────┐
        ↓               ↓                ↓
   Review Runtime    Context Engine   Cache Engine
        │               │                │
     怎么检视          看什么代码       怎么低成本
        │               │                │
        └───────────────┼────────────────┘
                        ↓
                 Knowledge Engine
                        │
                  AI知道什么
                        ↓
                 Evidence Engine
                        │
                  问题是否成立
                        ↓
                 Feedback Engine
                        │
                  如何持续进化
```

底层统一基于：

> **DeepSeek Harness**

其核心职责：

```text
Plugin Runtime
Session
Agent
Agent Loop
Tools
System Prompt
LLM
Event
```

项目原则：

> **尽可能使用 DSH 官方扩展点，不修改 DSH Core。**

---

# 3. 为什么采用分阶段演进

这个项目存在四个不应该一次性解决的问题：

```text
问题1：
怎么做到“少看代码”但不损失深度 Review？

问题2：
怎么做到“少 Token”同时保持高 Cache Hit？

问题3：
怎么让 AI 真正懂企业历史缺陷与 Review 经验？

问题4：
怎么让 Review Agent 越用越好？
```

因此版本必须按照：

```text
Context
   ↓
Efficiency
   ↓
Knowledge
   ↓
Verification
   ↓
Enterprise
   ↓
Self-Evolution
```

逐步演进。

---

# 4. 版本规划总览

建议正式规划：

|版本|核心定位|主要解决的问题|
|---|---|---|
|**V0.1**|Minimal Context Review PoC|专用 Review Agent 是否可行|
|**V0.2**|Cache-Efficient Review|如何降低 Token / 提高 Cache|
|**V0.3**|Domain Intelligence Review|如何让 AI 懂企业历史缺陷|
|**V0.4**|Evidence-Driven Review|如何降低误报、提升可信度|
|**V0.5**|Quality Gate Review|如何进入真实研发流程|
|**V1.0**|Enterprise AI Review Engine|企业级规模化、平台化|
|后续|Self-Evolving Review Agent|自反馈、自进化、自优化|

其中最关键的几个版本是：

> **V0.1：验证 Context 假设**  
> **V0.2：验证 Cost 假设**  
> **V0.3：验证 Knowledge 假设**  
> **V0.4：验证 Quality 假设**  
> **V0.5：验证落地假设**  
> **V1.0：完成平台化**

---

# 5. V0.1 —— Minimal Context Review

## 5.1 版本定位

> **专用 Review Runtime 技术验证版本**

核心命题：

> **不依赖完整 Repository Context，仅通过 Diff-first + On-demand Context，能否获得接近 Full Context 的深度 Review 能力？**

---

## 5.2 解决问题

主要解决：

> **“专用 Review Agent 是否比通用 Coding Agent 更适合代码检视？”**

以及：

> **“到底需要多少 Context 才能做好深度 Review？”**

---

## 5.3 主要功能

### ① DSH Runtime

基于 DSH：

```text
Review Agent
Review Loop
Session
Tool
Prompt
LLM
```

---

### ② Git Diff

支持：

```text
HEAD~1
commit range
staged
working tree
```

---

### ③ Repo Map

建立：

```text
File Tree
Symbol Map
```

第一阶段重点：

> Java / Python

---

### ④ Minimal Context

按需获取：

```text
Changed Symbol
Caller
Callee
Reference
Call Chain
```

---

### ⑤ Review Loop

```text
Diff
 ↓
Risk
 ↓
Symbol
 ↓
Need Evidence?
 ↓
Reference / Call Chain
 ↓
Review
 ↓
Finding
```

限制：

```text
≤ 5 Rounds
≤ 6 Tool Calls
≤ 16~20K Context
```

---

### ⑥ Structured Finding

```text
Severity
File
Line
Category
Description
Evidence
Confidence
```

---

## 5.4 实验设计

必须同时做：

```text
A Diff-only

B Minimal Context

C Full Repository
```

最终回答：

> Minimal Context 是否可以达到 Full Context 的接近效果？

---

## 5.5 V0.1 核心指标

```text
Recall
Precision
F1
Deep Review Recall
Context Tokens
Tool Calls
Latency
```

---

## 5.6 V0.1 成功标准

建议：

```text
Recall ≥ Full Context × 80~90%

Context Token ≤ Full Context × 30%

Tool Calls ≤ Full Context × 30%
```

---

# 6. V0.2 —— Cache-Efficient Review

## 6.1 版本定位

> **低成本 Review Engine**

V0.1 已证明：

> 精准 Context 可行。

V0.2 进一步解决：

> **“如何让这些 Context 尽可能复用，降低真实推理成本？”**

---

# 6.2 解决问题

核心问题：

> **Token 降低后，如何进一步减少 Uncached Token 和重复 Context？**

---

# 6.3 主要能力

## ① Stable Prefix

构建：

```text
Review Role
Review Policy
Tool Schema
Finding Schema
Evidence Policy
```

保持稳定。

---

## ② Stable Tool Schema

固定：

```text
Tool 数量
Tool 顺序
Tool Schema
```

避免 Tool Schema 变化导致 Prefix Break。

---

## ③ Context Ledger

记录：

```text
Loaded File
Loaded Range
Loaded Symbol
Evidence
```

重复读取：

> 返回 Reference，而非再次返回代码。

---

## ④ Append-only Context

采用：

```text
Stable Prefix
+
Stable Context
+
Append-only Dynamic Context
```

---

## ⑤ Cache Break Detection

监控：

```text
System Change
Tool Change
Context Reorder
Model Change
Compaction
```

---

## ⑥ Snapshot

建立：

```text
Review Snapshot
```

支持 Session Resume。

---

## ⑦ Compaction

做：

> Review Evidence Compaction

保留：

```text
Evidence
Finding
Rule
Context
Open Question
```

---

# 6.4 V0.2 核心指标

新增：

```text
Cache Hit Rate
Cached Tokens
Uncached Tokens
Prefix Length
Cache Break Count
```

同时关注：

```text
Review Quality
Token
Cost
```

---

# 6.5 V0.2 成功标准

目标：

```text
Cache Hit ≥ 80%
```

挑战目标：

```text
Cache Hit ≥ 90%
```

同时：

```text
Review Quality ≈ V0.1

Uncached Token ↓ 20~40%
```

---

# 7. V0.3 —— Domain Intelligence Review

## 7.1 版本定位

> **让 Review Agent 从“懂代码”升级为“懂组织”。**

---

# 7.2 解决问题

通用模型可能知道：

> Java 应该怎么写。

但未必知道：

> **我们的产品过去在哪里犯过错误。**

因此引入：

```text
CWD
历史 Review
历史 DTS
Git History
业务规则
```

---

# 7.3 Knowledge Engine

整体：

```text
历史数据
   ↓
缺陷挖掘
   ↓
Pattern Extraction
   ↓
CWD
   ↓
Review Knowledge
```

---

# 7.4 Rule Retrieval

不能：

> 全量加载规则。

必须：

```text
Diff
 ↓
Risk
 ↓
Rule Retrieval
 ↓
Top-K Rules
```

---

# 7.5 历史 Review Retrieval

例如：

```text
当前变更：
资源生命周期

↓

历史 Review：
“异常路径没有释放资源”

↓

向 Agent 提供：
历史 Case + Rule
```

---

# 7.6 历史缺陷 Retrieval

实现：

```text
search_history()
```

搜索：

```text
相似模块
相似 Symbol
相似缺陷
相似 Review
```

---

# 7.7 V0.3 核心指标

重点增加：

```text
Knowledge Hit Rate
Rule Hit Rate
Historical Defect Recall
CWD Contribution
```

重点回答：

> **企业历史知识到底能带来多少 Review 增益？**

---

# 7.8 V0.3 成功标准

例如：

```text
整体 Recall +10~20%

高频历史问题召回率显著提升

Rule 命中后 Review Precision 提升
```

具体数值最终以 Benchmark 为准。

---

# 8. V0.4 —— Evidence-Driven Review

## 8.1 版本定位

> **让 Review 从“AI 判断”升级成“AI 证明”。**

---

# 8.2 解决问题

当前 AI Review 最大风险之一：

> **误报 / 猜测 / 无依据问题。**

例如：

```text
“这里可能存在资源泄漏”
```

这种意见不应该直接进入 Review。

---

# 8.3 Evidence Engine

引入：

```text
Candidate Finding
 ↓
Evidence Retrieval
 ↓
Evidence Check
 ↓
Confidence
 ↓
Accept / Reject
```

---

# 8.4 Evidence 类型

包括：

```text
Code Evidence
Call Evidence
State Evidence
Rule Evidence
Historical Evidence
Static Evidence
```

---

# 8.5 Evidence Gate

核心原则：

> **No Evidence, No Finding**

---

# 8.6 Finding Confidence

例如：

```json
{
  "finding": "Resource leak",
  "confidence": 0.93,
  "evidence": [
    "Resource.open",
    "process",
    "exception path"
  ]
}
```

---

# 8.7 Finding Deduplication

解决：

```text
多个 Agent Step
        ↓
同一个问题被重复发现
```

统一合并。

---

# 8.8 V0.4 核心指标

重点：

```text
Precision
False Positive Rate
Verified Finding Rate
Acceptance Rate
```

---

# 8.9 V0.4 成功标准

目标：

```text
Precision ≥ Claude Code
False Positive 明显下降
Review Acceptance 提升
```

---

# 9. V0.5 —— Quality Gate Review

## 9.1 版本定位

> **从“Review 工具”进入“研发质量基础设施”。**

---

# 9.2 解决问题

前四个版本解决：

> “Review 好不好？”

V0.5 要解决：

> **“Review 能不能真正进入研发流程？”**

---

# 9.3 接入研发流程

支持：

```text
Git
 ↓
Commit
 ↓
MR / PR
 ↓
Review Agent
 ↓
Finding
 ↓
Evidence
 ↓
Quality Gate
```

---

# 9.4 支持场景

第一阶段：

```text
CLI
```

进一步：

```text
GitLab
GitHub
Code Review Platform
CI/CD
```

---

# 9.5 Quality Gate

例如：

```text
P0 Finding → Block
P1 Finding → Block
P2 Finding → Warning
P3 Finding → Info
```

进一步增加：

```text
Confidence
Rule Severity
Historical Risk
```

---

# 9.6 本地 Review

支持：

```text
Developer
 ↓
Local Review Agent
 ↓
Fix
 ↓
Push
```

实现：

> **反馈左移**

---

# 9.7 CI Review

```text
MR
 ↓
CI
 ↓
Review Agent
 ↓
Quality Gate
```

---

# 9.8 V0.5 核心指标

新增：

```text
覆盖率
Review Adoption
阻断缺陷数
误报率
Review Latency
MR Throughput
```

---

# 9.9 V0.5 成功标准

例如：

```text
核心仓库接入
MR 自动 Review
能够阻断 P0/P1 缺陷
Review 延迟控制在工程可接受范围
```

---

# 10. V1.0 —— Enterprise AI Review Engine

## 10.1 版本定位

> **企业级 AI Review 基础设施**

此时不再是一个 CLI Tool。

而是：

> **企业 AI Code Review Platform**

---

# 10.2 总体架构

```text
                  AI Review Platform
                         │
       ┌─────────────────┼─────────────────┐
       ↓                 ↓                 ↓
 Context Engine     Knowledge Engine   Evidence Engine
       │                 │                 │
       ↓                 ↓                 ↓
     Repo Map            CWD                Check
     Symbol              DTS                Compile
     CallGraph            History           Test
     Ledger               Rules             Runtime
       │                 │                 │
       └─────────────────┼─────────────────┘
                         ↓
                  Review Runtime
                         ↓
                  DeepSeek Harness
                         ↓
                  Model Router
```

---

# 10.3 V1.0 平台能力

## 多语言

```text
Java
C/C++
Python
Go
TypeScript
Kotlin
```

---

## 多入口

```text
CLI
IDE
GitLab
GitHub
CI/CD
MR
```

---

## 多模型

```text
DeepSeek
Claude
Qwen
OpenAI
Local Model
```

---

## 多知识源

```text
CWD
DTS
Git
Review
Wiki
Business Rules
```

---

## 多级 Review

```text
L0 静态规则
L1 轻量模型
L2 Review Agent
L3 Strong Model
L4 Verification
```

形成：

> **分层 AI Review Architecture**

---

# 11. V1.0 核心能力：Review Intelligence Platform

最终平台不是单纯：

> AI Review

而是：

```text
Code
 ↓
Static Detection
 ↓
AI Review
 ↓
Evidence
 ↓
Test
 ↓
Human Feedback
 ↓
Knowledge
 ↓
Rule
 ↓
AI Review
```

形成完整闭环。

---

# 12. 后续 —— Self-Evolving Review Agent

V1.0 之后进入真正的长期方向。

## 12.1 核心问题

> **Review Agent 能否自己发现哪些 Review 策略有效？哪些 Context 不必要？哪些 Tool 经常浪费 Token？哪些 Rule 经常误报？**

---

# 12.2 Harness 自进化

收集：

```text
Review Result
+
Human Feedback
+
Token
+
Tool Calls
+
Cache
+
Finding Acceptance
```

然后：

```text
Observation
 ↓
Evaluation
 ↓
Strategy Update
 ↓
Prompt Update
 ↓
Context Policy Update
 ↓
Tool Policy Update
```

---

# 12.3 自进化对象

可以逐步做到：

### Prompt Evolution

优化：

```text
Review Prompt
```

### Context Evolution

优化：

```text
什么情况下需要 Caller
什么情况下需要 CallChain
```

### Tool Evolution

优化：

```text
Tool 是否真的值得调用
```

### Model Routing Evolution

优化：

```text
什么问题使用什么模型
```

### Rule Evolution

优化：

```text
哪些 Rule 值得保留
哪些 Rule 应删除
```

---

# 13. 整体版本演进关系

整个项目最终可以形成：

```text
V0.1
Minimal Context
   │
   │ 解决“看什么”
   ↓
V0.2
Cache Efficiency
   │
   │ 解决“怎么低成本看”
   ↓
V0.3
Domain Intelligence
   │
   │ 解决“知道什么”
   ↓
V0.4
Evidence-driven
   │
   │ 解决“怎么证明”
   ↓
V0.5
Quality Gate
   │
   │ 解决“怎么进入研发流程”
   ↓
V1.0
Enterprise Platform
   │
   │ 解决“怎么规模化”
   ↓
Self-Evolving
   │
   │ 解决“怎么越用越强”
   ↓
Autonomous Review Engine
```

---

# 14. 各版本问题与答案总览

| 版本   | 核心问题         | 核心答案                       |
| ---- | ------------ | -------------------------- |
| V0.1 | 能不能少看代码？     | Minimal Sufficient Context |
| V0.2 | 能不能少付 Token？ | Cache-Stable Context       |
| V0.3 | 能不能懂组织？      | Domain Knowledge           |
| V0.4 | 能不能减少误报？     | Evidence Verification      |
| V0.5 | 能不能进入研发？     | Quality Gate               |
| V1.0 | 能不能规模化？      | Enterprise Platform        |
| 后续   | 能不能自己进化？     | Feedback-driven Evolution  |

---

# 15. 推荐研发里程碑

## Milestone 1

```text
DSH
+
Review Agent
+
Git Diff
```

---

## Milestone 2

```text
Repo Map
+
Symbol
+
Reference
+
CallChain
```

---

## Milestone 3

```text
Stable Prefix
+
Ledger
+
Append-only
+
Cache Metrics
```

---

## Milestone 4

```text
CWD
+
History
+
DTS
```

---

## Milestone 5

```text
Evidence
+
Finding Verification
```

---

## Milestone 6

```text
MR
+
CI
+
Quality Gate
```

---

## Milestone 7

```text
Enterprise Platform
```

---

# 16. 推荐研发任务组织方式

不要按“前后端 / Agent / RAG”简单拆团队，而建议按核心技术域：

```text
Team / Module A
Review Runtime
        │
Team / Module B
Context Engine
        │
Team / Module C
Cache Engine
        │
Team / Module D
Knowledge Engine
        │
Team / Module E
Evidence Engine
        │
Team / Module F
Benchmark / Evaluation
```

其中：

> **Benchmark / Evaluation 必须从 V0.1 就开始建设。**

不能等 V1.0 才考虑效果评测。

---

# 17. Benchmark 要伴随所有版本演进

每个版本都必须回答：

```text
Quality ↑ ?
Token ↓ ?
Cache ↑ ?
Tool ↓ ?
Latency ↓ ?
```

版本演进表：

|版本|重点指标|
|---|---|
|V0.1|Recall / Precision / Context|
|V0.2|Token / Cache|
|V0.3|Knowledge Recall|
|V0.4|Precision / False Positive|
|V0.5|Adoption / Gate|
|V1.0|Quality / Cost / Scale|
|后续|Improvement Rate|

---

# 18. 版本之间不能只“增加功能”

每一个版本必须有：

> **一个核心技术命题。**

例如：

```text
V0.1
证明 Context Efficiency

V0.2
证明 Cache Efficiency

V0.3
证明 Knowledge Efficiency

V0.4
证明 Evidence Reliability

V0.5
证明 Engineering Applicability

V1.0
证明 Enterprise Scalability
```

这样项目就不会变成：

> “不断增加功能的 Agent”。

而是：

> **不断验证技术假设并逐步演进的 Review Engine。**

---

# 19. 推荐版本发布节奏

在不强行绑定具体日历日期的情况下，建议按研发工作量设置：

```text
V0.1
短周期
快速验证 Runtime + Context

V0.2
短周期
重点验证 Cache

V0.3
中周期
建设知识体系

V0.4
中周期
建设 Evidence

V0.5
中周期
接入研发流程

V1.0
长周期
平台化
```

原则：

> **V0.x 快速迭代，V1.0 再做规模化。**

---

# 20. 项目最终核心架构

最终形成：

```text
                         Enterprise Review Engine
                                   │
       ┌───────────────────────────┼──────────────────────────┐
       ↓                           ↓                          ↓
 Context Intelligence       Review Intelligence       Cost Intelligence
       │                           │                          │
    Repo Map                    CWD / DTS                 Cache
    Symbol                      Historical                 Ledger
    CallGraph                   Review                     Prefix
    Impact                      Business                   Routing
       │                           │                          │
       └───────────────────────────┼──────────────────────────┘
                                   ↓
                            Evidence Engine
                                   │
                              Validation
                                   ↓
                              Review Result
                                   ↓
                             Human Feedback
                                   ↓
                          Self-Evolution Engine
                                   │
                                   └───────────────↺
```

---

# 21. 最终产品形态

未来用户看到的可能只有：

```bash
review-agent review
```

但是背后运行的是：

```text
Git Diff
 ↓
Risk
 ↓
Minimal Context
 ↓
Cache Optimization
 ↓
Knowledge Retrieval
 ↓
Agent Reasoning
 ↓
Evidence Verification
 ↓
Static / Test Validation
 ↓
Finding
 ↓
Quality Gate
 ↓
Feedback
```

即：

> **一个复杂的 AI Review Engine，被收敛成一个简单的 Review 命令。**

---

# 22. 最终项目成功定义

项目不是以：

> “Agent 能不能发现 Bug”

作为最终成功标准。

而是：

### 第一层：质量

```text
Review Quality
≈ Claude Code
```

### 第二层：效率

```text
Token
↓ 50~70%
```

### 第三层：缓存

```text
Cache Hit
↑
```

### 第四层：规模

```text
MR / Day
↑
```

### 第五层：组织能力

```text
Historical Defect
→ CWD
→ Review Intelligence
```

### 第六层：自进化

```text
Review Feedback
→ Strategy
→ Prompt
→ Context
→ Tool
→ Rule
```

---

# 23. 项目最终愿景

最终希望把传统：

```text
AI Coding
    ↓
代码大量生成
    ↓
人工 Review
    ↓
Review 成为瓶颈
```

升级为：

```text
AI Coding
    ↓
高效代码生成
    ↓
专用 Review Agent
    ↓
Evidence Verification
    ↓
自动质量 Gate
    ↓
Human Focus on High-value Issues
```

形成：

> **AI 负责规模化检视，人负责最终判断。**

---

# 24. 项目最终一句话

> ### **以 DeepSeek Harness 为 Agent 内核，以 Minimal Sufficient Context 降低上下文成本，以 Cache-Stable Architecture 降低实际 Token 成本，以 CWD/历史缺陷构建领域 Intelligence，以 Evidence Verification 提升可信度，以 Quality Gate 进入研发流程，以 Feedback Loop 最终实现 Review Agent 自进化。**

最终演进路径：

```text
专用 Agent
   ↓
高效 Agent
   ↓
懂业务 Agent
   ↓
可信 Agent
   ↓
工程化 Agent
   ↓
企业级 Review Engine
   ↓
自进化 Review Engine
```

这就是整个项目建议采用的 **V0.1 → V1.0 分阶段实施路线**。

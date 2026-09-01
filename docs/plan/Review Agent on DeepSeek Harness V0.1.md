# Review Agent on DeepSeek Harness V0.1

## 技术设计、代码目录、Plugin API、Agent Loop 时序与 POC 执行计划

---

# 1. 文档目的

本文用于指导 **Review Agent V0.1 PoC** 的直接开发，实现一个基于 DeepSeek Harness（以下简称 DSH）的专用代码检视 Agent。

V0.1 不追求企业级完整能力，而聚焦验证一个核心技术命题：

> **是否能够通过“Diff-first + Minimal Sufficient Context + Cache-Stable Context + Bounded Review Loop”，在显著降低 Token / Tool Call 的情况下，获得接近 Full-Context Coding Agent 的 Review 效果。**

---

# 2. V0.1 核心目标

## 2.1 必须回答的四个问题

### Q1：Diff-only 是否真的会漏掉深度问题？

例如：

- Caller / Callee；
    
- 跨模块依赖；
    
- 生命周期；
    
- 状态传播；
    
- 事务；
    
- 并发；
    
- 资源管理。
    

---

### Q2：增加多少 Context 才足够？

寻找：

> **Minimal Sufficient Context**

即：

> 能够支撑正确 Review 判断的最小充分上下文。

---

### Q3：Minimal Context 是否可以达到 Full Context 的接近效果？

目标：

```text
Minimal Context Review Quality
≈
Full Context Review Quality
```

---

### Q4：能否通过 Cache-Stable Context 进一步降低实际成本？

目标：

```text
Cached Input ↑
Uncached Input ↓
Total Token ↓
Review Quality 不下降
```

---

# 3. V0.1 不解决的问题

V0.1 明确暂不做：

```text
自动修改代码
自动修复
Git Push
MR 自动提交
IDE Plugin
Web UI
多 Agent 协同
大规模向量数据库
复杂 RAG
自动 Rule Mining
全链路 Runtime Test
```

原则：

> **先证明 Review Runtime 的核心价值，再逐步产品化。**

---

# 4. V0.1 总体设计原则

## 原则 1：Diff-first，不是 Diff-only

Diff 是 Review 的入口。

但 Agent 可以按需获得：

```text
Symbol
Caller
Callee
Reference
Call Chain
State
```

---

## 原则 2：Minimal Sufficient Context

不是：

> 看完整 Repository。

也不是：

> 只看 Diff。

而是：

> **只获取证明当前判断所必需的 Context。**

---

## 原则 3：Evidence-driven

任何 Finding 都必须能够回答：

> “你为什么认为这是问题？”

默认策略：

> **No Evidence, No Finding**

---

## 原则 4：Bounded Agent Loop

Agent 必须受到：

```text
Round Budget
Tool Budget
Context Budget
Token Budget
```

约束。

---

## 原则 5：Cache-stable

模型请求上下文尽可能保持：

```text
Stable Prefix
+
Stable Context
+
Append-only Dynamic Context
```

---

## 原则 6：DSH Core 不修改

DSH 当前明确采用插件化架构，Agent、Agent Loop、Tools、Session、System Prompt 等均属于可替换扩展边界，因此 Review Agent 原则上通过 Plugin / Profile / Adapter 实现，而不修改 DSH Core。

---

# 5. 技术架构总览

```text
                         Git / MR
                            │
                            ▼
                    ┌──────────────┐
                    │ Diff Engine  │
                    └──────┬───────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │ Risk Classifier  │
                  └────────┬─────────┘
                           │
           ┌───────────────┴───────────────┐
           │                               │
           ▼                               ▼
      Low / Medium                      High Risk
           │                               │
           └───────────────┬───────────────┘
                           ▼
                ┌──────────────────────┐
                │ Context Decision     │
                │                      │
                │ Need what evidence?  │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ Context Engine       │
                │                      │
                │ Repo Map             │
                │ Symbol               │
                │ Reference            │
                │ Call Chain           │
                │ Ledger               │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ Knowledge Engine     │
                │                      │
                │ CWD / Rules          │
                │ History              │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ Cache Engine         │
                │                      │
                │ Stable Prefix        │
                │ Ledger               │
                │ Append-only          │
                │ Snapshot             │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ Review Agent Driver  │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ Evidence Engine      │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ Structured Findings  │
                └──────────────────────┘
```

底层：

```text
                DeepSeek Harness
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       Session      Tools        Prompt
          │            │            │
          └────────────┼────────────┘
                       ▼
                     Agent
                       │
                  Review Loop
                       │
                      LLM
```

DSH 的官方架构明确将 `ctx.sessions`、`ctx.systemPrompt`、`ctx.tools`、`ctx.agents`、`ctx.agentLoop`、`ctx.llm` 作为对应子系统的能力入口，并通过配置层 / Profile / Bundle 进行组合。

---

# 6. 运行时架构

V0.1 建议定义：

## Review Runtime

```text
review-runtime
│
├── ReviewAgent
├── ReviewLoop
├── ReviewPolicy
├── RiskPolicy
├── BudgetPolicy
└── ReviewEvents
```

它替代的是默认 Coding Agent 的运行方式，而不是替代 DSH。

---

# 7. DSH 中的挂载方式

建议采用：

```text
DSH Base
   │
   ├── Core Session
   ├── Core Tools
   ├── Core Prompt
   ├── Core LLM
   └── Core Agent
          │
          ▼
     Review Plugin Layer
          │
   ┌──────┼──────────┐
   ▼      ▼          ▼
Context  Cache     Evidence
Plugin   Plugin      Plugin
          │
          ▼
     Review Agent
```

DSH 当前支持通过 Profile / Bundle / patch 进行运行时组合，并明确建议将新增行为挂在 documented extension point 上，而不是 patch 一个 privileged core。

---

# 8. Plugin 划分

V0.1 建议控制在 6 个核心 Plugin：

```text
1. review-runtime
2. review-context
3. review-cache
4. review-knowledge
5. review-evidence
6. review-metrics
```

---

# 9. Plugin 1：review-runtime

## 职责

负责：

- Review Agent；
    
- Review Loop；
    
- Risk Policy；
    
- Budget Policy；
    
- Review State；
    
- Agent Lifecycle。
    

---

## 核心接口

以下以“目标 API / 伪 TypeScript”定义，实际实现以 DSH 当前发布的类型签名为准。

```ts
export interface ReviewAgent {
  id: string;

  review(input: ReviewRequest): Promise<ReviewResult>;

  cancel(): void;

  status(): ReviewStatus;
}
```

---

## ReviewRequest

```ts
export interface ReviewRequest {
  repoRoot: string;

  base?: string;

  head?: string;

  diff?: string;

  profile?: ReviewProfile;

  budgets?: ReviewBudget;
}
```

---

## ReviewBudget

```ts
export interface ReviewBudget {
  maxRounds: number;

  maxToolCalls: number;

  maxContextTokens: number;

  maxOutputTokens: number;

  maxLatencyMs?: number;
}
```

推荐默认：

```text
maxRounds = 5
maxToolCalls = 6
maxContextTokens = 16000
maxOutputTokens = 2000
```

---

# 10. Plugin 2：review-context

## 职责

负责：

```text
Diff
Repo Map
Symbol
Reference
Call Chain
Impact
Context Ledger
```

---

## Context Service

```ts
export interface ReviewContextService {

  getDiff(request: DiffRequest): Promise<DiffContext>;

  getSymbol(request: SymbolRequest): Promise<SymbolContext>;

  findReferences(request: ReferenceRequest): Promise<ReferenceContext>;

  getCallChain(request: CallChainRequest): Promise<CallChainContext>;

  snapshot(): ContextSnapshot;

  ledger(): ContextLedger;
}
```

---

# 11. Diff 数据结构

```ts
interface DiffContext {
  commitBase: string;

  commitHead: string;

  files: ChangedFile[];

  symbols: ChangedSymbol[];

  hunks: DiffHunk[];
}
```

---

# 12. Symbol 数据结构

```ts
interface SymbolContext {
  file: string;

  symbol: string;

  kind: "class" | "method" | "function" | "field";

  startLine: number;

  endLine: number;

  content: string;
}
```

---

# 13. Context Ledger

```ts
interface ContextLedger {

  loadedFiles: LoadedFile[];

  loadedSymbols: LoadedSymbol[];

  loadedRanges: LoadedRange[];

  evidence: EvidenceRef[];

  has(file: string, start: number, end: number): boolean;

  markLoaded(range: LoadedRange): void;
}
```

核心规则：

```text
第一次读取
    ↓
返回内容
    ↓
Ledger Mark

再次读取
    ↓
Already Loaded
    ↓
不重复发送
```

---

# 14. Context Decision

这是 Review Agent 的核心智能模块。

输入：

```text
Current Finding
+
Current Context
```

输出：

```text
Evidence Requirement
```

例如：

```json
{
  "reason": "Need caller transaction boundary",
  "request": "find_references",
  "target": "FooService.update"
}
```

---

# 15. Evidence Request

统一定义：

```ts
type EvidenceRequest =
  | {
      type: "symbol";
      symbol: string;
    }
  | {
      type: "reference";
      symbol: string;
    }
  | {
      type: "call_chain";
      symbol: string;
      depth: number;
    }
  | {
      type: "file_range";
      file: string;
      startLine: number;
      endLine: number;
    };
```

核心原则：

> 每一次 Context Request 都必须能够对应到一个明确的 Review 假设。

---

# 16. Plugin 3：review-cache

这是 V0.1 的一级核心模块。

## 职责

负责：

```text
Stable Prefix
Context Ordering
Context Ledger
Append-only
Snapshot
Compaction
Cache Metrics
Cache Break Detection
```

---

# 17. CacheContextComposer

核心接口：

```ts
export interface CacheContextComposer {

  buildStablePrefix(): string;

  buildStableContext(): string;

  appendDynamicContext(
    context: DynamicContext
  ): string;

  composeRequest(
    state: ReviewState
  ): LlmRequestContext;
}
```

---

# 18. Cache 三层结构

```text
┌──────────────────────────────┐
│ Zone A：Immutable Prefix     │
│                              │
│ Review Role                  │
│ Review Policy                │
│ Tool Schema                  │
│ Finding Schema               │
│ Evidence Policy              │
└──────────────────────────────┘

┌──────────────────────────────┐
│ Zone B：Stable Context       │
│                              │
│ Repo Map                     │
│ Symbol Map                   │
│ Project Rule                 │
└──────────────────────────────┘

┌──────────────────────────────┐
│ Zone C：Append-only Context  │
│                              │
│ Diff                         │
│ Symbol                       │
│ Call Chain                   │
│ Evidence                     │
│ Finding                      │
└──────────────────────────────┘
```

---

# 19. Stable Prefix 设计要求

必须保证：

```text
Prompt 顺序固定
Tool 顺序固定
Tool Schema 固定
Review Policy 固定
Finding Schema 固定
```

禁止：

```text
每轮重写 System Prompt
每轮重排 Tool
动态插入 Rule 到 Prefix
随机调整 Tool 顺序
```

DSH 当前 System Prompt 子系统负责 Prompt Section 与 Tool Schema 组装；而 Request Header 又记录当次请求的配置、系统 Prompt 与 Tool Schema，因此这一层正是实现 Cache-Stable Request 的关键边界。

---

# 20. Tool Schema Optimization

V0.1 只开放：

```text
review.get_diff
review.get_symbol
review.get_file
review.find_references
review.get_call_chain
review.search_rule
review.search_history
```

Tool 顺序固定。

Tool Schema 固定。

DSH 的 Tool Runtime 支持 scoped registration 和 restriction，因此可以对 Review Agent 做专属 Tool Set，而不是暴露整个 Harness 的工具全集。

---

# 21. Append-only Context

每一轮只追加：

```text
Turn 1
Stable Prefix + Diff

Turn 2
Stable Prefix + Diff + Symbol

Turn 3
Stable Prefix + Diff + Symbol + Caller

Turn 4
Stable Prefix + Diff + Symbol + Caller + Evidence
```

避免：

```text
重新构建整个 Prompt
重新排序 Context
重复发送相同代码
```

---

# 22. Cache Break Detection

每次检测到 Prefix / Cache 异常变化，记录：

```ts
interface CacheBreakEvent {
  reason:
    | "SYSTEM_CHANGED"
    | "TOOL_SCHEMA_CHANGED"
    | "TOOL_ORDER_CHANGED"
    | "MODEL_CHANGED"
    | "CONTEXT_REORDERED"
    | "COMPACTION"
    | "ROUTE_CHANGED";

  previousPrefixHash: string;

  currentPrefixHash: string;
}
```

---

# 23. Plugin 4：review-knowledge

V0.1 不要求大型知识库。

先提供：

```text
rules/*.yaml
```

---

## Rule

```ts
interface ReviewRule {
  id: string;

  category: string;

  severity: "P0" | "P1" | "P2" | "P3";

  title: string;

  description: string;

  triggers: string[];

  examples?: string[];
}
```

---

# 24. Plugin 5：review-evidence

职责：

```text
Finding Candidate
 ↓
Evidence
 ↓
Verification
 ↓
Confidence
 ↓
Accept / Reject
```

---

## Finding

```ts
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

# 25. Evidence Checker

核心：

```ts
export interface EvidenceChecker {

  verify(
    finding: CandidateFinding,
    context: ReviewContext
  ): Promise<VerificationResult>;
}
```

结果：

```ts
type VerificationResult =
  | {
      status: "verified";
      confidence: number;
    }
  | {
      status: "rejected";
      reason: string;
    }
  | {
      status: "uncertain";
      reason: string;
    };
```

V0.1 默认：

```text
verified → 输出
uncertain → 默认不输出
rejected → 丢弃
```

---

# 26. Plugin 6：review-metrics

记录：

```text
Review Start
Diff Size
Context Size
Tool Calls
Rounds
Input Tokens
Output Tokens
Cached Tokens
Uncached Tokens
Latency
Finding Count
Verified Finding
Rejected Finding
```

---

# 27. DSH Session 集成

DSH 当前 Session 是 append-only typed `SessionEvent` log，并从该日志派生模型可见消息；文档明确要求新的 model-visible input 应通过可重建的 Session Event 表达。

因此 Review Agent 应增加 Review-specific Event：

```text
review/start
review/diff-analyzed
review/risk-classified
review/context-requested
review/context-loaded
review/finding-candidate
review/finding-verified
review/finding-rejected
review/completed
```

---

# 28. Review Event 数据模型

```ts
interface ReviewEventMap {

  "review/start": {
    reviewId: string;
    repo: string;
  };

  "review/diff-analyzed": {
    files: number;
    symbols: number;
  };

  "review/context-requested": {
    type: string;
    target: string;
  };

  "review/context-loaded": {
    tokenCount: number;
    source: string;
  };

  "review/finding-candidate": {
    findingId: string;
  };

  "review/finding-verified": {
    findingId: string;
    confidence: number;
  };

  "review/finding-rejected": {
    findingId: string;
    reason: string;
  };

  "review/completed": {
    findings: number;
    tokens: number;
    cacheHitRate: number;
  };
}
```

DSH 当前 `SessionEventMap` 本身支持通过 declaration merging 扩展事件类型，这正适合把 Review 生命周期作为 durable domain event 加入，而不修改 Session Core。

---

# 29. Agent Loop

这是 V0.1 最关键的执行逻辑。

```text
START
  │
  ▼
┌─────────────────┐
│ Parse Git Diff  │
└────────┬────────┘
         ▼
┌─────────────────┐
│ Risk Classify   │
└────────┬────────┘
         ▼
┌──────────────────────┐
│ Build Initial Context│
│ Diff + Symbols       │
└────────┬─────────────┘
         ▼
┌──────────────────────┐
│ Review Reasoning     │
└────────┬─────────────┘
         ▼
    Need Evidence?
      │       │
     NO      YES
      │       │
      │       ▼
      │   Evidence Request
      │       │
      │       ▼
      │   Context Retrieval
      │       │
      │       ▼
      └───────┘
         │
         ▼
┌──────────────────────┐
│ Evidence Verification│
└────────┬─────────────┘
         ▼
┌──────────────────────┐
│ Final Findings       │
└──────────────────────┘
```

---

# 30. Agent Loop 关键原则

每次 Loop 必须满足：

```text
Input
   ↓
Current Hypothesis
   ↓
Missing Evidence
   ↓
Tool Request
   ↓
Evidence
   ↓
Hypothesis Update
```

禁止：

```text
无目的 Search
无目的 Read
重复 Tool Call
超过 Budget 后继续探索
```

---

# 31. DSH Agent Hook 的利用方式

DSH 当前提供 `agent/pre-step` waterfall，可以在每个 step 进入模型之前决定或重写本次进入的消息；`agent/request` 则可以替换本次模型调用配置。

建议：

### `agent/pre-step`

负责：

```text
Review Context Injection
Cache Context Composition
Budget Check
```

---

### `agent/request`

负责：

```text
Model Route
Max Output Tokens
Reasoning Effort
```

---

# 32. 推荐 Agent Loop 与 DSH 的关系

不要：

```text
修改 DSH 默认 Loop
```

而应该：

```text
Review Agent Driver
       │
       ├── 使用 DSH Agent
       ├── 使用 DSH Session
       ├── 使用 DSH Tool Runtime
       ├── 使用 DSH Prompt Assembly
       └── 使用 DSH LLM
```

必要时通过：

```text
agent/pre-step
agent/request
agent/turn-stopping
```

进行拦截和调度。DSH 官方将这些事件定义为 live extension points。

---

# 33. 一次 Review 时序图

```text
User
 │
 │ review HEAD~1
 ▼
Review CLI
 │
 ▼
Review Agent
 │
 │ review/start
 ▼
DSH Session
 │
 ▼
Diff Engine
 │
 │ diff context
 ▼
Review Loop
 │
 │ Risk Classification
 │
 ▼
Context Engine
 │
 │ Symbol
 ▼
Cache Engine
 │
 │ compose stable + dynamic
 ▼
DSH agent/pre-step
 │
 ▼
LLM
 │
 │ Candidate Finding
 ▼
Review Loop
 │
 │ Evidence Request
 ▼
Context Engine
 │
 │ Caller / Callee
 ▼
Cache Engine
 │
 │ append context
 ▼
LLM
 │
 │ Final Finding
 ▼
Evidence Engine
 │
 ├──── verified
 │
 └──── rejected
 │
 ▼
Review Result
 │
 ▼
Metrics / Session
```

---

# 34. 更完整的多轮时序

```text
Agent       Context       Cache        DSH        LLM
  │            │            │           │          │
  │──Diff─────►│            │           │          │
  │            │            │           │          │
  │──Risk─────────────────────────────────────────►│
  │            │            │           │          │
  │──Symbol───►│            │           │          │
  │            │──Symbol───►│           │          │
  │            │            │──Compose─►│          │
  │            │            │           │──Request►│
  │            │            │           │          │
  │            │            │           │◄─Finding─│
  │            │            │           │          │
  │◄─Evidence Request───────────────     │          │
  │            │            │           │          │
  │──Caller───►│            │           │          │
  │            │──Caller───►│           │          │
  │            │            │──Append──►│          │
  │            │            │           │──Request►│
  │            │            │           │          │
  │            │            │           │◄─Finding─│
  │                                                  │
  │──Verify────────────────────────────────────────►│
  │                                                  │
  │◄──────────────Final Review──────────────────────│
```

---

# 35. V0.1 Context Budget

建议：

```text
Stable Prefix             2K
Diff                      2K
Symbol Context            3K
Impact Context            5K
Reasoning                 4K
Output                    1K
────────────────────────────
Target                    17K
```

硬限制：

```text
16~20K / Review
```

---

# 36. V0.1 Agent Budget

```text
maxRounds       = 5
maxToolCalls    = 6
maxContextToken = 16K
maxOutputToken  = 2K
```

预算耗尽：

```text
Budget Exhausted
      ↓
停止进一步探索
      ↓
Evidence 不足则放弃 Finding
```

---

# 37. Cache 目标

第一阶段不把：

> Cache Hit 85%

当作绝对验收条件，而作为实验目标。

建议：

```text
Target Cache Hit ≥ 80%
Stretch Goal ≥ 90%
```

因为具体命中率最终取决于 provider 的缓存机制、模型路由和 API 行为。

因此 V0.1 **必须测量实际缓存数据，而不是假设缓存生效**。

---

# 38. Cache 指标

```text
cache_hit_rate
cached_input_tokens
uncached_input_tokens
prefix_tokens
stable_prefix_hash
cache_break_count
cache_break_reason
```

---

# 39. Cost 指标

建议：

```text
Total Token
+
Cached Token
+
Uncached Token
+
Tool Calls
+
Latency
```

建立：

### Cache-adjusted Review Cost

```text
CARC =
Uncached Input Tokens
+
Output Tokens
+
Tool Cost
```

---

# 40. CLI 设计

V0.1 提供：

```bash
review-agent review
```

---

## 参数

```bash
review-agent review \
  --repo ./project \
  --base HEAD~1
```

可选：

```bash
--head HEAD
--model deepseek-chat
--budget 16000
--max-rounds 5
--max-tools 6
--format text|json
--metrics
```

---

# 41. CLI 输出

```text
Review Agent V0.1

Repository:
  project-a

Changes:
  8 files
  16 symbols
  +231 / -120

Review:
  P0 0
  P1 2
  P2 3
  P3 1

Evidence:
  Verified 5
  Rejected 3

Cost:
  Input Tokens      14.8K
  Output Tokens      1.1K
  Cached Tokens      9.7K
  Uncached Tokens    5.1K

Agent:
  Rounds             4
  Tool Calls         5
  Latency            38s

Cache:
  Hit Rate           87.0%
```

---

# 42. 代码目录

建议不要把 Review Agent 直接塞进 DSH 源码目录。

采用独立 Workspace：

```text
review-agent/
│
├── apps/
│   └── review-cli/
│       └── src/
│           └── main.ts
│
├── packages/
│
│   ├── review-runtime/
│   │   └── src/
│   │       ├── review-agent.ts
│   │       ├── review-loop.ts
│   │       ├── review-policy.ts
│   │       ├── risk-policy.ts
│   │       ├── budget-policy.ts
│   │       └── review-events.ts
│   │
│   ├── review-context/
│   │   └── src/
│   │       ├── diff-engine.ts
│   │       ├── repo-map.ts
│   │       ├── symbol-index.ts
│   │       ├── reference-index.ts
│   │       ├── call-graph.ts
│   │       ├── context-selector.ts
│   │       └── context-ledger.ts
│   │
│   ├── review-cache/
│   │   └── src/
│   │       ├── prefix-manager.ts
│   │       ├── request-composer.ts
│   │       ├── cache-policy.ts
│   │       ├── snapshot.ts
│   │       ├── compaction.ts
│   │       └── cache-metrics.ts
│   │
│   ├── review-knowledge/
│   │   └── src/
│   │       ├── rule-store.ts
│   │       ├── history-store.ts
│   │       └── retriever.ts
│   │
│   ├── review-evidence/
│   │   └── src/
│   │       ├── evidence-checker.ts
│   │       ├── finding-scorer.ts
│   │       └── finding-dedup.ts
│   │
│   └── review-metrics/
│       └── src/
│           ├── token-metrics.ts
│           ├── latency-metrics.ts
│           ├── cache-metrics.ts
│           └── benchmark.ts
│
├── plugins/
│   ├── review-runtime-plugin/
│   ├── review-context-plugin/
│   ├── review-cache-plugin/
│   ├── review-knowledge-plugin/
│   ├── review-evidence-plugin/
│   └── review-metrics-plugin/
│
├── prompts/
│   ├── review-system.md
│   ├── review-methodology.md
│   └── finding-schema.md
│
├── rules/
│   ├── security/
│   ├── concurrency/
│   ├── resource/
│   ├── performance/
│   └── logic/
│
├── benchmark/
│   ├── cases/
│   ├── ground-truth/
│   ├── runners/
│   └── reports/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── benchmark/
│   └── cache/
│
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

---

# 43. 为什么不直接修改 DSH 源码目录

DSH 当前明确建议：

> 新行为应该挂载到 documented extension point，而不是修改 privileged core。

并且目前项目仍处于 Developer Preview，兼容性可能变化。

因此：

```text
DSH
 ↓
固定 Commit
 ↓
Adapter
 ↓
Review Plugin
```

推荐，而不是：

```text
Fork
 ↓
修改 Core
 ↓
长期维护 Patch
```

---

# 44. POC 开发任务总览

整个 POC 拆成：

```text
P0-01 DSH Runtime Spike
P0-02 Diff Engine
P0-03 Repo/Symbol Map
P0-04 Context Retrieval
P0-05 Review Loop
P0-06 Cache Engine
P0-07 Evidence Engine
P0-08 Metrics
P0-09 Benchmark
P0-10 Claude Code Baseline
P0-11 Optimization
```

---

# 45. P0-01：DSH Runtime Spike

## 目标

证明：

> 能够通过 DSH Plugin / Profile 启动一个 Review Agent。

---

## 工作项

```text
1. 固定 DSH Commit
2. 建立独立 review-agent workspace
3. 接入 DSH SDK / Runtime
4. 注册 Review Agent
5. 实现最小 Review Loop
6. CLI 调通
```

---

## 验收

```bash
review-agent review
```

能够：

```text
读取 Diff
调用 LLM
输出 Review
```

---

# 46. P0-02：Diff Engine

## 工作项

实现：

```text
git diff
git merge-base
changed files
changed hunks
changed symbols
```

---

## 验收

输出：

```json
{
  "files": 3,
  "symbols": 7,
  "additions": 120,
  "deletions": 70
}
```

---

# 47. P0-03：Repo / Symbol Map

## 第一阶段

支持：

```text
Java
Python
```

优先：

```text
Tree-sitter
```

---

## 输出

```text
FooService.java
 ├── class FooService
 │    ├── update()
 │    ├── delete()
 │    └── validate()
```

---

# 48. P0-04：Context Retrieval

实现：

```text
get_symbol
get_file
find_references
get_call_chain
```

---

## 验收

对于：

```text
FooService.update()
```

能够获得：

```text
Method
Caller
Callee
Call Chain
```

---

# 49. P0-05：Review Loop

实现：

```text
Diff
↓
Risk
↓
Symbol
↓
Evidence Need
↓
Reference / CallChain
↓
Reason
↓
Finding
```

限制：

```text
≤ 5 rounds
≤ 6 tools
```

---

# 50. P0-06：Cache Engine

实现：

```text
Stable Prefix
Stable Tool Schema
Context Ledger
Append-only Context
Prefix Hash
Cache Metrics
```

---

## 验收

重复读取：

```text
Foo.java:100-180
```

第二次：

```text
AlreadyLoaded(ctx#001)
```

而非重新发送完整代码。

---

# 51. P0-07：Evidence Engine

实现：

```text
Candidate
↓
Evidence
↓
Verification
↓
Finding
```

---

## 验收

不能证明的 Finding：

```text
默认不输出
```

---

# 52. P0-08：Metrics

每次 Review 记录：

```text
review_id
model
files
symbols
rounds
tool_calls
input_tokens
output_tokens
cached_tokens
uncached_tokens
latency
findings
verified_findings
rejected_findings
cache_hit_rate
```

---

# 53. P0-09：ReviewBench

第一版：

```text
30 Real Defect
30 Historical Review
30 Negative Case
10 Hard Case
```

总计：

> **100 Cases**

---

# 54. Ground Truth

每个 Case：

```json
{
  "caseId": "MR-001",
  "findings": [
    {
      "file": "Foo.java",
      "line": 128,
      "severity": "P1",
      "category": "RESOURCE",
      "description": "..."
    }
  ]
}
```

---

# 55. P0-10：Claude Code Baseline

对于同一 Case：

```text
Case
 ├── Claude Code
 ├── Review Agent
 └── Baseline LLM
```

统一：

```text
Repository
Diff
Review Objective
尽可能统一模型
```

---

# 56. P0-11：Optimization

根据 Benchmark：

```text
Context
↓
Cache
↓
Loop
↓
Prompt
↓
Model
```

逐层优化。

---

# 57. 第一阶段实验设计

必须至少跑：

```text
A Diff-only
B Minimal Context
C Full Repo
D Minimal + Stable Prefix
E Minimal + Ledger + Append-only
```

---

# 58. 实验 A：Diff-only

```text
Diff
 ↓
LLM
 ↓
Review
```

目的：

> 最低成本 Baseline。

---

# 59. 实验 B：Minimal Context

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

目的：

> 验证精准 Context。

---

# 60. 实验 C：Full Repo

```text
Diff
+
Repository Context
 ↓
LLM
 ↓
Review
```

目的：

> 效果上限。

---

# 61. 实验 D：Minimal + Stable Prefix

验证：

> Cache / Prefix Stability。

---

# 62. 实验 E：Minimal + Ledger

验证：

> Context Ledger 是否降低重复 Context 与 Uncached Token。

---

# 63. 核心指标

## Quality

```text
Recall
Precision
F1
False Positive Rate
Acceptance
```

## Context

```text
Context Tokens
Deep Recall / Context Token
```

## Agent

```text
Rounds
Tool Calls
Latency
```

## Cache

```text
Cache Hit Rate
Cached Tokens
Uncached Tokens
Prefix Tokens
Cache Break Count
```

---

# 64. 核心效率指标

## Review Intelligence Efficiency

```text
RIE =
Recall × Precision
───────────────────
Total Tokens / 1K
```

---

## Cache Efficiency

```text
CE =
Cached Input Tokens
───────────────────
Total Input Tokens
```

---

## Cache-adjusted Review Cost

```text
CARC =
Uncached Input Tokens
+
Output Tokens
+
Tool Cost
```

---

# 65. POC 验收标准

## S 级

```text
Recall ≥ Claude Code × 90%
Precision ≥ Claude Code
Token ≤ Claude Code × 30%
Tool Calls ≤ Claude Code × 30%
```

---

## A 级

```text
Recall ≥ Claude Code × 80%
Token ≤ Claude Code × 30%
```

---

## B 级

```text
Recall ≥ Claude Code × 70%
Token ≤ Claude Code × 50%
```

---

# 66. 深度问题专项指标

POC 不能只看总体 Recall。

必须单独统计：

```text
Local Logic
Cross-function
Cross-module
Concurrency
Transaction
Resource Lifecycle
Security
Performance
State Management
```

因为：

> Diff-only 很可能在 Local Logic 上表现很好，但在 Cross-function / Cross-module / Lifecycle 上明显退化。

---

# 67. Context Sufficiency Matrix

最终形成：

|Case|Diff|Symbol|Reference|CallChain|Full Repo|是否发现|
|---|--:|--:|--:|--:|--:|---|
|Local Logic|✓||||||
|Caller Issue|✓|✓|✓||||
|Transaction|✓|✓|✓|✓|||
|Resource|✓|✓|✓|✓|||
|Cross-module|✓|✓|✓|✓|✓||

最终寻找：

> **最小充分 Context。**

---

# 68. POC 里最值得做的两个自动实验

## Experiment 1：Context Ablation

自动逐步减少 Context：

```text
Full
 ↓
File
 ↓
Symbol
 ↓
Caller
 ↓
CallChain
 ↓
Diff
```

得到质量曲线。

---

## Experiment 2：Cache Ablation

逐步关闭：

```text
Stable Prefix
Ledger
Append-only
Snapshot
```

得到：

```text
Token
Cache
Latency
```

变化曲线。

---

# 69. 推荐开发节奏

## Stage 1：Runtime

```text
DSH
 ↓
Review Agent
 ↓
Basic Loop
```

---

## Stage 2：Context

```text
Diff
 ↓
Symbol
 ↓
Reference
 ↓
Call Chain
```

---

## Stage 3：Cache

```text
Stable Prefix
+
Ledger
+
Append-only
```

---

## Stage 4：Evidence

```text
Candidate
 ↓
Evidence
 ↓
Verification
```

---

## Stage 5：Benchmark

```text
100 Cases
 ↓
A/B/C/D/E
 ↓
Claude Code Baseline
```

---

# 70. 开发任务依赖关系

```text
P0-01 DSH Runtime
       │
       ├──────────────┐
       ▼              ▼
P0-02 Diff        P0-08 Metrics
       │
       ▼
P0-03 Symbol
       │
       ▼
P0-04 Context
       │
       ├──────────────┐
       ▼              ▼
P0-05 Review Loop   P0-06 Cache
       │              │
       └──────┬───────┘
              ▼
         P0-07 Evidence
              │
              ▼
         P0-09 Benchmark
              │
              ▼
         P0-10 Compare
              │
              ▼
         P0-11 Optimize
```

---

# 71. 推荐代码提交顺序

### Commit 01

```text
chore: bootstrap review-agent workspace
```

### Commit 02

```text
feat: integrate deepseek harness runtime
```

### Commit 03

```text
feat: add git diff engine
```

### Commit 04

```text
feat: add repo symbol map
```

### Commit 05

```text
feat: add review context tools
```

### Commit 06

```text
feat: add review agent loop
```

### Commit 07

```text
feat: add cache-aware context ledger
```

### Commit 08

```text
feat: add evidence verification
```

### Commit 09

```text
feat: add review metrics
```

### Commit 10

```text
feat: add review benchmark
```

---

# 72. 第一阶段工程验收 Checklist

## Runtime

```text
□ DSH 正常启动
□ Review Plugin 正常加载
□ Review Agent 可以创建
□ Session 正常记录
□ Tool 正常注册
```

## Context

```text
□ Git Diff 正常解析
□ Symbol 正常解析
□ Reference 正常查询
□ Call Chain 正常查询
□ Ledger 正常记录
```

## Review

```text
□ Agent Loop 正常
□ Tool Budget 生效
□ Round Budget 生效
□ Context Budget 生效
□ Finding 可输出
```

## Cache

```text
□ Stable Prefix Hash
□ Tool Schema Stable
□ Append-only Context
□ Duplicate Context Detection
□ Cached Token Metrics
```

## Evidence

```text
□ Candidate Finding
□ Evidence Retrieval
□ Verification
□ Reject / Accept
```

## Benchmark

```text
□ Case Dataset
□ Ground Truth
□ Claude Baseline
□ Review Agent
□ 自动评分
```

---

# 73. 最终 POC 交付物

第一阶段不要超过以下 7 项：

```text
1. review-agent CLI

2. DSH Review Runtime Plugin

3. Context Engine

4. Cache Engine

5. Evidence Engine

6. ReviewBench 100 Cases

7. Benchmark Report
```

---

# 74. POC 最终输出报告

必须给出如下结果：

```text
             Claude Code
                   │
                   │
          ┌────────┼────────┐
          ▼        ▼        ▼
        Quality   Token    Latency
          │        │        │
          └────────┼────────┘
                   │
                   │
             Review Agent
                   │
          ┌────────┼────────┐
          ▼        ▼        ▼
        Quality   Token    Cache
```

最终重点不是：

> “我们的 Agent 也可以 Review。”

而是：

> **“在保持接近的 Review Quality 前提下，我们究竟减少了多少 Context、Tool Call、Uncached Token 和模型成本？”**

---

# 75. V0.1 成功之后的演进路径

```text
V0.1
Minimal Sufficient Context
        │
        ▼
V0.2
CWD + Historical Review + DTS
        │
        ▼
V0.3
Static Check + Compile + Test
        │
        ▼
V0.4
Human Feedback + Acceptance
        │
        ▼
V0.5
Review Knowledge Flywheel
        │
        ▼
V1.0
Enterprise AI Review Engine
```

---

# 76. V0.2：领域 Intelligence

加入：

```text
CWD
历史 Review
历史缺陷
Git History
业务规则
```

形成：

```text
Code Context
+
Organization Knowledge
        ↓
Review Intelligence
```

---

# 77. V0.3：Verification

增加：

```text
CodeCheck
Compiler
Unit Test
Integration Test
Runtime Validation
```

形成：

```text
Finding
 ↓
Evidence
 ↓
Validation
 ↓
Confirmed Finding
```

---

# 78. V0.4：Feedback

记录：

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
Rule
 ↓
Review
```

---

# 79. 长期架构

```text
                        AI Review Engine
                                │
        ┌───────────────────────┼────────────────────────┐
        ↓                       ↓                        ↓
 Context Engine          Knowledge Engine         Evidence Engine
        │                       │                        │
     Repo Map                  CWD                   Check
     Symbol                    DTS                   Compile
     Call Graph                Review                Test
     Ledger                    History               Runtime
        │                       │                        │
        └───────────────────────┼────────────────────────┘
                                ↓
                         Review Runtime
                                │
                         DeepSeek Harness
                                │
                            Model Router
```

---

# 80. 最终技术定位

这个项目不是：

> **Mini Claude Code**

而是：

> ### **Cache-Stable + Evidence-Driven + Context-Efficient 的专用 Review Runtime**

核心技术模型：

```text
              ┌────────────────────┐
              │     Review Agent    │
              └─────────┬──────────┘
                        │
           ┌────────────┼────────────┐
           ↓            ↓            ↓
     Context Engine  Review Loop  Cache Engine
           │            │            │
       看什么         怎么判断       怎么低成本
           │            │            │
           └────────────┼────────────┘
                        ↓
                 Evidence Engine
                        ↓
                  Final Finding
```

---

# 81. 方案核心价值

最终希望达到：

```text
Claude Code

Full Context
+
Long Loop
+
Many Tools
+
High Uncached Token


                VS


Review Agent

Minimal Sufficient Context
+
Bounded Review Loop
+
Slim Tool Set
+
Stable Prefix
+
Context Ledger
+
Evidence Verification
```

最终评价标准：

> **不是谁“更聪明”，而是谁能以更低的有效成本完成同样的高质量 Review。**

---

# 82. V0.1 最终核心技术命题

> ### **Minimal Sufficient Context + Cache-Stable Review Loop**
> 
> 以 Diff 为入口，通过风险驱动的按需上下文检索获得深度 Review 所需的最小充分证据；同时通过 Stable Prefix、稳定 Tool Schema、Context Ledger、Append-only Context 和 Cache-aware Policy，最大化已有 Context 的复用；在 DSH 提供的 Agent / Session / Tool / Prompt / LLM 可插拔运行时上，构建一个低 Token、低 Tool Call、可验证的专用 Review Agent。

---

# 83. 开发团队拿到后的第一条任务

建议第一个开发 Issue 直接命名：

> **[POC1] Bootstrap Review Agent on DeepSeek Harness**

验收标准只有一个：

```text
给定一个真实 Git Repository：

review-agent review --base HEAD~1

能够：

1. 获取 Diff
2. 创建 Review Agent
3. 调用 LLM
4. 至少读取一个 Changed Symbol
5. 输出一个结构化 Review Result
6. 输出 Token / Tool Call / Latency Metrics
```

先把这条链打通：

```text
Git
 ↓
Diff
 ↓
DSH
 ↓
Review Agent
 ↓
LLM
 ↓
Review
```

然后再逐层增加：

```text
Context
 ↓
Cache
 ↓
Evidence
 ↓
Benchmark
```

这样最稳妥。

---

# 84. 研发负责人视角的最终执行要求

为了避免 PoC 在实施过程中重新变成“Mini Claude Code”，开发过程中增加五条硬约束：

```text
① 不允许无边界增加 Tool

② 不允许默认读取整个 Repository

③ 不允许 Review Loop 无限运行

④ 不允许未经 Evidence 验证直接输出 Finding

⑤ 不允许以“效果更好”为理由无上限增加 Token
```

所有能力增加，都必须回答：

> **质量提升多少？增加多少 Token？增加多少 Tool Call？Cache 是否受损？**

---

# 85. 项目最终 Definition of Done

当以下条件同时满足时，V0.1 才算完成：

```text
[Runtime]
✓ DSH Plugin 化运行

[Review]
✓ Review Loop 可运行

[Context]
✓ Diff-first
✓ On-demand Symbol / Reference / CallChain

[Cache]
✓ Stable Prefix
✓ Context Ledger
✓ Append-only
✓ Cache Metrics

[Evidence]
✓ Finding Verification

[Measurement]
✓ Token
✓ Cache
✓ Tool
✓ Latency

[Benchmark]
✓ ≥100 Cases
✓ Claude Code Baseline
✓ Quality / Cost 对比

[Conclusion]
✓ 得出 Minimal Sufficient Context
✓ 得出 Quality / Token 结论
```

---

# 86. 最终建议的 PoC 优先级

```text
P0：必须先做

DSH Runtime
Diff
Symbol
Context
Review Loop
Metrics


P1：紧接着做

Cache
Ledger
Evidence
Benchmark


P2：V0.2 再做

CWD
History
DTS
Compile
Test
```

因此真正的第一开发路径应该严格控制成：

```text
                   POC1
                     │
          ┌──────────┴──────────┐
          ↓                     ↓
       Context                Cache
          │                     │
     Minimal Context       Stable Prefix
          │                Context Ledger
          │                Append-only
          └──────────┬──────────┘
                     ↓
              Review Agent
                     ↓
               Evidence
                     ↓
                Benchmark
                     ↓
          Claude Code Comparison
                     ↓
        Quality / Token / Cache
```

**这条链打通后，再引入 CWD / 历史缺陷。**

这样就能把“DeepSeek Harness 是否适合做 Review Agent”和“Review Agent 是否真的能做到低成本高质量”两个问题分开验证，PoC 的结论会更可信。
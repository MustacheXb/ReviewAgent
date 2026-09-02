# 基于 DeepSeek Harness 的 Review Agent 总体架构设计方案

> **文首说明（原文首注）**：重新核对了当前 DeepSeek Harness 的官方架构：它将 `session`、`system-prompt`、`tools`、`agent`、`agent-loop`、`llm` 等声明为可替换插件能力（代码层核对：仅 `ctx.llm` 有多实现 seam，其余为 core 单实现，详见第 2 章"DSH 能力核对"）；`agent/pre-step` 可以决定模型实际看到的消息；Session 是 append-only event log；这些都非常适合实现我们的"**Cache-Stable Review Loop**"。（[GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）

> **修订记录（v2.0，2026-09-02）**：本版为设计共识评审（28 项设计决策 + 四轮事实核查：DSH 代码仓、DeepSeek API、Java 代码智能工具链、Java 公开数据集）后的写回版。主要修订：
> 1. **POC1 先行、DSH 后置**：POC1 在零 DSH 依赖的独立薄 harness（TypeScript）上运行，DSH 仅作并行技术 spike；原"Phase 1 = DSH Review Runtime"调整为 POC1 之后的迁移阶段（ADR-0001，见第 8 章阶段 0）。
> 2. **DSH 能力表述修正**：六个能力入口中仅 `ctx.llm` 具备多实现 seam，`sessions` / `systemPrompt` / `tools` / `agents` / `tokenMeter` 均为 core 零替代实现；自定义 Agent Loop 经 `setFactory` 可替换但零生产示例。Loop 采用"标准 loop + 策略监听器"起步（见第 3 章）。
> 3. **模型层锁定**：`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役；POC1 锁定 DeepSeek 官方 API，主力 `deepseek-v4-flash`、`deepseek-v4-pro` 用于高险升级与消融（ADR-0002），全实验锁定单一 effort 档位。
> 4. **S/A/B 主锚切换**：成功标准由"Claude Code × N%"改为"配置 C（Full Repo 效果上限）× N%"；Claude Code 模型不可同源，降为跨模型外部参照，不进主判定。
> 5. **代码智能零构建**：企业落地只提供静态源码快照，C1/C2 后端锁定 tree-sitter-java + ripgrep 词法级静态解析，排除一切构建依赖；数据集随之不要求可构建（ADR-0003，见第 4 章）。
> 6. **Benchmark 落地**：逆补丁法构造缺陷引入 MR + 五源数据集组合（Defects4J 主集 / Vul4J 高险 / Multi-SWE-bench Java MR 形态 / 自建阴性对照 / MCR-Bench 参照，见第 7 章）。
> 7. **实验协议补全**：判定链（原生真值 + 规则粗筛 + GPT 系 LLM-as-judge + 10% 人工抽检）、≥3 重复报均值±标准差、缓存分层报告（rep1 冷单列、rep2+ 热均值为主）、DeepSeek 缓存整匹语义与冷/热协议（见第 5、6 章）。
> 8. **术语与决策存档**：术语表见 `CONTEXT.md`；不可逆决策见 `docs/adr/0001–0003`；详版过程记录见《基于 DeepSeek Harness 的 Review Agent 架构设计方案过程讨论》。

## 1. 项目概述与问题定义

### 项目定位

**项目名称**：**Review Agent —— 基于 DeepSeek Harness 的低 Token、高质量代码检视 Agent**

**项目定位**：研究先行——先用 POC1 实验验证核心命题，终局为落地到企业内部代码托管平台的 MR 检视（届时检视目标只提供静态源码快照、无构建环境）。面向 AI Coding 时代的代码质量保障场景，基于 DeepSeek Harness 构建专用 Review Runtime，通过：

> **专用 Review Loop + Minimal Sufficient Context + Cache Optimization + Domain Knowledge + Evidence Verification**

降低通用 Coding Agent 在代码检视场景中的上下文、工具调用和模型推理成本，在显著降低 Token / 算力消耗的情况下，达到接近甚至部分场景优于 Claude Code / OpenCode 的代码检视效果。

### 背景与核心矛盾

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

**为什么直接使用 Claude Code / OpenCode 做 Review 成本高**：通用 Coding Agent 通常围绕完整软件开发任务设计：

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

### 五大核心问题

整个项目围绕五个关键技术问题展开。

**问题一：只给 Diff 会不会漏掉深度问题？** 会。很多高价值问题需要：Caller、Callee、Call Chain、Interface、State、Transaction、Resource Lifecycle、Cross-module Dependency。因此：

> **不能采用 Diff-only。**

**问题二：如果给完整 Repository，Token 又会失控。** Full Repository Context 虽然能提升理解能力，但带来：

```text
Context ↑
Prompt ↑
Tool Calls ↑
Reasoning ↑
Token ↑
Cost ↑
```

因此需要寻找 **Minimal Sufficient Context**，即：

> **能够支撑正确 Review 判断的最小充分上下文。**

**问题三：重复 Context 导致缓存和 Token 浪费。** Review Agent 多轮推理过程中，经常反复访问：

```text
FooService.update()
FooService.update()
FooService.update()
```

如果每次重新返回代码：

> **Context 重复 + Cache 破坏 + Token 浪费。**

**问题四：Agent Loop 容易重新退化成 Mini Claude Code。** 如果提供过多 Tool：

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

> **大量探索 → 大量 Tool Call → 大量 Token。**

**问题五：模型判断容易产生误报。** Review 不应该只是"模型觉得这里有问题"，而应该是：

> **Finding + Evidence + Rule + Confidence**

因此必须建立 Evidence Gate。

### 设计目标

**总体目标** —— 构建：

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

**成本目标** —— 从 **Total Token Optimization** 升级为：

> **Uncached Token Optimization + Cache Hit Optimization**

即同时优化：

```text
① 少发 Token
② 少发 Uncached Token
③ 提高 Prefix Cache Hit
④ 减少 Tool Calls
⑤ 控制 Reasoning Loop
```

**质量目标** —— 目标不是单纯超越通用 Coding Agent，而是逼近效果上限：

```text
Recall ≈ 配置 C（Full Repository 效果上限）
Precision ≥ 配置 C
Token << 配置 C
```

建议（v2.0 修正：主锚为配置 C / Full Repo 效果上限；Claude Code 为跨模型外部参照，单列报告）：

```text
Recall ≥ 配置 C × 80~90%
Token ≤ 配置 C × 30%
Tool Calls ≤ 配置 C × 30%
```

### 核心设计思想："三优化、一闭环"

整个项目采用：

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

## 2. 总体架构与 DSH 内核

### 总体架构

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

### DSH 内核定位与职责边界

DeepSeek Harness 当前的架构非常适合作为底层 Runtime。官方架构明确说明：

> 每个产品能力都以插件形式存在，包括模型适配器、Tool Registry、Session Log、Agent Loop；扩展通常通过挂载新的插件完成，而不是修改一个特权 Core。（[GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）

因此：

> **DSH 负责 Agent 如何运行；Review Agent 负责 Review 如何完成。**

两者职责边界如下：

| DSH | Review Agent |
|---|---|
| Plugin Runtime | Review Strategy |
| Agent | Review Agent |
| Agent Loop | Review Loop |
| Session | Review State |
| System Prompt | Review Prompt |
| Tool Registry | Review Tool Policy |
| LLM | Model Routing |
| Event | Review Event |
| Tool Execution | Evidence Retrieval |

原则：

> **Review Intelligence 不侵入 DSH Core。**

### Review Runtime ≠ Coding Runtime

不能简单复用默认 Coding Runtime。Coding Runtime 的形态是：

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

Review Runtime 的形态是：

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

> **Review Runtime ≠ Coding Runtime**

### DSH 插件划分与挂接方式

建议将 Review Agent 划分为以下 DSH 插件：

```text
review-policy
review-runtime
review-context
review-knowledge
review-evidence
review-cache
review-metrics
```

其中 **`review-cache` 正式成为一级 Plugin**，承担：

```text
Stable Prefix
Context Ledger
Append-only Policy
Snapshot
Compaction
Cache Metrics
Cache Break Detection
```

挂接方式上，DSH 当前提供以下能力入口（[GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）：

```text
ctx.sessions
ctx.systemPrompt
ctx.tools
ctx.agents
ctx.agentLoop
ctx.llm
```

因此各插件按如下方式挂接：

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

### DSH 能力核对与补充（基于 参考项目/deepseek-harness 代码仓分析）

对照本地代码仓 `参考项目/deepseek-harness` 的 `docs/architecture.md`、`docs/subsystems/session.md`、`docs/subsystems/system-prompt.md`、`docs/subsystems/compaction.md` 与 `README.md`，本方案对 DSH 的六处关键引用**全部属实**：

| #   | 方案引用                                                                                                                  | 代码仓核对结果                                                                                                                                                                                           | 出处                                 |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | `session` / `system-prompt` / `tools` / `agent` / `agent-loop` / `llm` 均为可替换插件能力，扩展通过挂载插件而非修改特权 Core（见"DSH 内核定位"）     | 属实。Cordis 框架下"产品的每一部分都是插件，包括模型适配器、工具注册表、会话日志，以及 agent loop 本身，因此每个都可以从配置替换"；"不存在需要打补丁的特权内核"                                                                                                       | `docs/architecture.md`（Cordis 一节）  |
| 2   | `ctx.sessions` / `ctx.systemPrompt` / `ctx.tools` / `ctx.agents` / `ctx.agentLoop` / `ctx.llm` 能力入口（见"DSH 插件划分与挂接方式"） | 属实。核心包表逐一对应：core/session→`ctx.sessions`、core/system-prompt→`ctx.systemPrompt`、core/tools→`ctx.tools`、core/agent→`ctx.agents`、core/agent-loop（实现 Agent 接口的默认驱动器）→`ctx.agentLoop`、llm/llm→`ctx.llm` | `docs/architecture.md`（核心包表）       |
| 3   | Session 是 append-only event log，模型可见上下文由日志推导（见第 5 章 Cache 三层结构）                                                       | 属实。`Session` 是由类型化 `SessionEvent` 组成的仅追加日志；"模型可见即已记录"是运行时不变量，`deriveMessages()` 从日志投影模型历史                                                                                                         | `docs/subsystems/session.md`       |
| 4   | Tool Schema 由 system-prompt subsystem 组装，属于模型输入、影响请求稳定前缀（见第 5 章 Tool Schema Cache Optimization）                       | 属实。`ctx.systemPrompt.tools(provider)` 注册工具 schema 提供方，`assemble()` 统一组装 Prompt Sections 与 Tool Schema                                                                                             | `docs/subsystems/system-prompt.md` |
| 5   | Compaction 是独立 capability，提供与 Session / Prefix 相关的设计基础（见第 5 章 Compaction）                                             | 属实。压缩是可选能力 seam（`ctx.compaction`），不属于 agent loop 主干；提供 `compactIfNeeded` / `compactNow` / `compactRegion` 三个入口                                                                                    | `docs/subsystems/compaction.md`    |
| 6   | DSH 官方仍定位为 Developer Preview，需控制依赖风险（见第 8 章风险五）                                                                       | 属实。README："DeepSeek Harness is in developer preview and iterating rapidly. THERE WILL BE COMPATIBILITY-BREAKING CHANGES."                                                                         | `README.md`                        |

**实现现状的必要修正（v2.0，代码层核对）**：上表第 1 条核实的是官方文档的声明；进一步对照源码注册表发现，六个能力入口中**仅 `ctx.llm` 存在多实现 seam**（DeepSeek / OpenAI 兼容适配器），`sessions` / `systemPrompt` / `tools` / `agents` / `tokenMeter` 在注册表中均分类为 `core` 且**零替代实现**；自定义 Agent Loop 可经 `ctx.agents.setFactory` 替换，但官方示例与 cookbook 中**零生产用例**。因此"声明可替换"≠"存在被验证的替换路径"：本方案不把任何关键机制押注在替换 DSH 内核组件上（POC1 零 DSH 依赖，见 ADR-0001 与第 8 章阶段 0），Loop 层采用"标准 loop + 策略监听器"起步（见第 3 章）。

代码仓中还有一批方案未直接引用、但对本设计有直接支撑价值的机制，建议在 Phase 1（DSH Review Runtime）落地时优先评估：

1. **`request/header` 事件（原生缓存断点信号）**：请求信封（调用配置 + 渲染后系统提示词 + 组装后工具 schema）作为会话状态写入日志；信封变化时追加 reason 为 `change` / `series` 的快照并开启新的模型消息序列。第 5 章 Cache Break Detection 中的 `SYSTEM_PROMPT_CHANGED` / `TOOL_SCHEMA_CHANGED` / `MODEL_CHANGED` 等原因分类，在 DSH 内核层已有事件级信号可直接消费，不必从零埋点。
2. **`request/context` 事件（路由变化记录）**：provider / model / 容量变化时追加路由元数据。切换模型在 DSH 中是显式记录、且请求信封变化会开启新消息序列（直接影响前缀缓存复用），从内核层面印证了 Cache-aware Model Routing 中 "Cache Warmth 必须纳入 Model Score" 的必要性。
3. **`agent/pre-step` waterfall**：监听器可改写或拒绝已领取的消息（"`agent/pre-step` 决定模型看到什么"）。Context Ledger 的"重复读取返回 Already loaded"去重可在 pre-step 层拦截 / 改写实现，无需修改 loop 内核。
4. **`agent.inject()`**：添加模型可见上下文的规范入口，注入内容作为 `user/message` 落在下一次获准的请求中 —— Append-only Context 的天然追加通道。
5. **Agent preset + `isolate` realm**："让某个会话拥有不同的能力集合"的官方机制（另有"将注册项限定到单个 agent：使用该 agent 的 `agent.ctx`"）。Review 工具裁剪（只挂 7 个 `review.*` 工具）应通过组装专用 agent preset 实现，而不是改动全局工具注册表。
6. **Profile / Bundle / Patch 分层组装**：运行中的 dsh 是一棵插件树，扩展通过挂载插件 + 有序 patch 完成。"Plugin / Profile / Patch"的挂接方式与 DSH 官方组装机制一一对应。
7. **`ctx.toolResultPruner`**：对超预算工具结果做确定性头 / 中 / 尾剪枝，并以 shadow 记录替换 —— Compaction"删除重复工具结果"一项，内核已有可复用的兄弟能力。
8. **`ctx.tokenMeter`（token-meter 子系统）**：token 估算与回放由单例服务统一持有，`assistant/message` 事件携带 usage 记账 —— Cache Policy 需要记录的 cached / uncached tokens 等指标有现成记账挂点。
9. **Session seed / fork**：`ctx.sessions.create(id, { seed })` 支持以既有事件日志为种子回放 / fork 会话 —— ReviewSnapshot 的"Snapshot + New Context"恢复模式可映射到 session seed / fork 机制，不必自建恢复协议。
10. **事件三域与 waterfall / serial 分派**：拦截请求、工具或轮次使用 `agent/*`、`tools/*` 事件，`agent/turn-stopping` 可停止轮次 —— Bounded Loop（`max_rounds = 5` / `max_tool_calls = 6`）可在事件层实施；同时 `core/agent-loop` 本身是"实现该接口的默认驱动器"，自定义 Review Loop 仍是官方支持的替换点。

**结论（v2.0 修正）**：本方案引用的 DSH 机制在文档层全部属实、挂点存在；但"可替换"的成色需分层看待——凡涉及替换内核组件的路径（自定义 Loop、替换 sessions / tools 等）均降级为 spike 评估项，POC1 与关键机制不依赖任何替换路径（ADR-0001）。Cache Break Detection、Append-only 注入、工具裁剪、Snapshot 恢复等机制在监听器与组装层（pre-step / inject / preset / seed）均有现成挂点，"Plugin / Profile / Patch、No Core Patch"在这条保守路径上可行。

## 3. Review Engine：Loop、策略与证据

### Review Agent Loop

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

Loop 上界：

```text
max_rounds = 5
max_tool_calls = 6
```

Loop 实现形态（v2.0 已定）：

> **标准 Agent Loop + 策略监听器（pre-step / inject / turn-stopping / preset）起步；自定义 Loop 仅作 spike 评估项。**

理由：自定义 Loop 在 DSH 中虽是官方支持的替换点（`ctx.agents.setFactory`），但零生产示例；策略监听器路径有内核挂点且不触碰 loop 本体。POC1 阶段则完全不依赖 DSH（ADR-0001）。

Loop 内部采用**固定阶段骨架 + 阶段内受限自主检索**的混合形态：Change Understanding → Risk Classification → Context Decision → Context Retrieval → Deep Reasoning → Evidence Verification 阶段顺序固定，阶段内检索由模型在工具预算内自主完成；确定性预取（Zone B）不占自主检索预算。

### Evidence-driven Loop

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

> **Agent 的每一次 Tool Call 都必须回答"我为什么需要这个信息"。**

### Review Strategy Engine 与 Risk-based Review

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

基于风险的 Review 深度分级：

- **Low Risk**（Comment / Rename / Formatting / Mechanical Change）：只加载 **C0 + C1**；
- **Medium Risk**（Business Logic / API / State / Data Structure）：加载 **C0 + C1 + C2**；
- **High Risk**（Concurrency / Transaction / Security / Resource / Distributed / Performance / Lifecycle）：加载 **C0 + C1 + C2 + C3 + Evidence Verification**。

### Knowledge Engine

（术语：CWD = 从历史缺陷挖掘出的本项目常见缺陷模式库（知识 L2 层）；DTS = 缺陷跟踪系统。完整术语表见 `CONTEXT.md`。）

知识生产链路：

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

### Evidence Engine 与 Review Finding

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

验证遍数（v2.0 已定）：POC1 以**单遍自证**（Reasoning 阶段内自我核查）为底线形态；**二遍 Verifier**（独立第二遍复核 Finding）为消融开关——Verifier 使用同模型 `deepseek-v4-flash`，其 token 消耗计入 CARC。编译 / 测试执行不进 POC1（Check Engine 的 Compiler / Test / Runtime 属 Phase 2+）。

统一 Finding 结构：

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

## 4. Context Engine：Minimal Sufficient Context

### Context Engine 组成

Context Engine 是第一核心模块：

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

**C1/C2 实现后端（v2.0 已定：零构建静态解析）**：企业落地场景中检视目标只提供静态源码快照（无构建环境、不可编译），符号 / 引用 / 调用链全部采用零构建静态解析（ADR-0003）：

```text
tree-sitter-java  →  签名级符号提取（Symbol Map / Zone B Symbol Index 生成器）
ripgrep           →  词法引用匹配（Reference Map）
文件读取          →  源码摘录（Evidence）
```

排除一切构建依赖方案（scip-java 是 javac 编译器插件、jdt-ls 需 Maven/Gradle 项目 import、Kythe 需构建捕获）。精度天花板为词法级（重载 / override 分辨不精确），但实验内各配置共享同一工具精度、配置间对比不受污染；外部参照 Claude Code 同为词法工具（grep / read），跨参照对比公平。`review.get_call_chain` 在 POC1 降级为 1~2 层名字级引用链。

### 四级上下文加载（C0–C3）

Context 按四级加载，逐级按需：

```text
C0 Diff
 ↓
C1 Symbol
 ↓
C2 Impact
 ↓
C3 Knowledge
```

**C0：Diff** —— 必须加载：

```text
Changed Files
Changed Hunks
Changed Lines
Changed Symbols
```

**C1：Symbol** —— 按需加载：

```text
Changed Method
Changed Class
Local Context
Related Symbol
```

**C2：Impact** —— 按需加载：

```text
Caller
Callee
Reference
Interface
State
Call Chain
Dependency
```

**C3：Knowledge** —— 按需加载：

```text
CWD
Historical Review
Historical Defect
Business Rule
```

## 5. Cache Optimization Engine

### 定位与整体模型

Cache Optimization Engine 是项目新增的一级核心模块（与 Context / Review / Knowledge / Evidence Engine 同级，而非性能优化附录）。目标：

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

### Cache 三层结构与 Stable Prefix 设计

一次模型请求建议设计成三层结构，**越靠前越应该稳定**：

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

对应 Cache 三层结构（Zone），各层内容细目（合并原文 Prompt Architecture 三处表述）：

**Zone A：Immutable Prefix（STABLE PREFIX）** —— 整个 Review Session 基本不变化，目标是 **Byte Stable**：

```text
Review Role / Review Objective / Review Policy
Finding Schema（Output Schema）
Severity（Severity Definition）
Evidence Policy
Tool Policy（Tool Schema）
```

**Zone B：Session Stable Context（SEMI-STABLE）** —— 一个 Repository / Review Session 内基本稳定：

```text
Repo Identity
Repo Map
Symbol Index（Symbol Map）
Project Rules（Rules / Project Context）
```

Zone B 构造方式（v2.0 已定）：

> **纯静态确定性构造：目录树 + 包/模块结构 + 签名级符号索引（按变更文件所在包/模块圈定范围）。不经过 LLM、不依赖构建。**

LLM 生成的仓库摘要推迟至 Phase 2+ 作为消融项评估。

**Zone C：Append-only Review Context（DYNAMIC）** —— 动态增长：

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

DSH 的 Session 本身就是 append-only `SessionEvent` log；官方架构说明也明确指出模型可见上下文由这个日志推导，因此非常适合实现 Cache-Stable Context（[GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）。

Prompt 架构的最终目标：

> **Stable Prefix 最大化 Cache，Dynamic Context 最小化 Token。**

### Tool Schema Cache Optimization

Tool Schema 本身属于模型输入。DSH 的 System Prompt subsystem 会负责 Prompt Sections 与 Tool Schema Assembly，因此 Tool 定义本身会影响模型请求的稳定前缀（[GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/system-prompt.md)）。

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

并保持：

```text
Tool 数量固定
Tool 顺序固定
Tool Schema 固定
```

> **DSH 对照**：DSH 的 agent preset（`isolate` realm）是"让某个会话拥有不同的能力集合"的官方机制，Review 工具裁剪应通过组装专用 preset 实现，而不是改动全局工具注册表；`ctx.tools` 注册也支持按 agent 作用域限定。

### Context Ledger

维护 `ContextLedger`，示例：

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

Context Ledger 的双重价值（不仅减少 Token，还有两个额外作用）：

- **避免重复 Context** —— 减少 Input Tokens；
- **保持 Context 稳定** —— 避免 Context Reorder，从而保持 Prefix Stable。

所以：

> **Context Ledger = Token Optimization + Cache Optimization**

> **DSH 对照**：`agent/pre-step` waterfall 允许监听器改写或拒绝已领取的消息，Ledger 的"Already loaded: ctx#001"去重可在 pre-step 层拦截实现，无需修改 loop 内核。

### Append-only Context 与 Context Mutation Policy

推荐严格设计成追加式：

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

Context 变更策略：

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

> **DSH 对照**：`agent.inject()` 是添加模型可见上下文的规范入口，注入内容作为 `user/message` 落在下一次获准的请求中，是 Append-only Context 的天然追加通道。

### Review Snapshot

每个 Review Session 可以维护 `ReviewSnapshot`：

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

这样恢复 Session 时只需：

```text
Snapshot
+
New Context
```

不需要重新从头构造。

> **DSH 对照**：`ctx.sessions.create(id, { seed })` 支持以既有事件日志为种子回放 / fork 会话，Snapshot 的"Snapshot + New Context"恢复模式可映射到 session seed / fork 机制。

### Compaction：Review Evidence Compaction 与 Cache-aware 约束

Compaction 不允许直接 Summary everything，而应该做 **Review Evidence Compaction**。

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

DSH 已经将 Compaction 作为独立 capability，并提供与 Session / Prefix 相关的设计基础，因此可以在其基础上实现 Review-specific Compaction（[GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.md)）。

同时，Compaction 不能破坏 Stable Prefix。应采用：

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

> **DSH 对照**：DSH compaction seam 提供 `compactIfNeeded` / `compactNow` / `compactRegion` 三个入口，摘要通过 `surfaceOp: replace` 的 `user/message` 落在 surface 中部、不重写请求前部 —— 与"Compaction 不破坏 Stable Prefix"的约束天然兼容；`ctx.toolResultPruner` 还提供对超预算工具结果的确定性剪枝，可复用于"删除重复工具结果"。

### Cache-aware Model Routing

模型选择不能只考虑：

```text
Quality
Cost
```

还需要考虑 **Cache Warmth**。因此：

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

> **DSH 对照**：DSH 中 provider / model 变化会作为 `request/context` 事件记录，且请求信封变化会开启新的模型消息序列 —— 切换模型对前缀缓存复用的影响在内核层是显式的，印证了将 Cache Warmth 纳入 Model Score 的必要性。

### Cache Policy 与 Cache Break Detection

Cache Policy 建议设置：

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

Cache Break Detection 是后续非常值得做的一项能力。每次发现 Cache 显著下降时记录 `CacheBreakEvent`，原因分类：

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

> **DSH 对照**：`request/header` 事件将请求信封（调用配置 + 渲染后系统提示词 + 组装后工具 schema）作为会话状态写入日志，信封变化时追加 `change` / `series` 快照 —— 上述分类中的 `SYSTEM_PROMPT_CHANGED` / `TOOL_SCHEMA_CHANGED` / `MODEL_CHANGED` 等在内核层已有事件级信号可直接消费；cached / uncached token 用量可挂接 `ctx.tokenMeter` 与 `assistant/message` 携带的 usage 记账。

### DeepSeek 缓存语义与冷/热报告协议（v2.0 补）

DeepSeek 官方 API 的上下文缓存为**磁盘缓存 + 持久化单元整匹**语义，与朴素的"最长公共前缀"直觉有三处关键差异：

1. **整匹而非增量**：请求 A+B 缓存后，A+C 不命中 B 的部分；但公共前缀 A 会被持久化，供后续 A+D 命中。稳定前缀的价值在"跨请求复用同一前缀"，而非任意前缀部分命中。
2. **账号级共享、best-effort**：缓存按账号（API key）共享、闲置数小时至数天清除；跨会话前缀复用需 ≥2 次共享请求才会持久化公共前缀。
3. **计量与价格**：usage 报告 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；缓存命中价格约为未命中的 1/30 —— 缓存优先命题的收益基础。

由此 Benchmark 采用**分层报告协议**：

```text
rep1（冷启动）          → 单列报告，不计入主口径
rep2+（热稳定）         → 均值 ± 标准差，主口径
会话内自然混合命中率     → 主口径；跨会话预热曲线 → 单列实验
```

单发配置（A / B / C）的重复运行命中率含测量伪影（同一请求重复即命中），冷成本与热均值必须分层呈现。

## 6. POC1 实验设计

### POC1 重新定义

**POC1：Minimal Sufficient Context + Cache-Stable Review**

不再定义为 "Git Diff + LLM"，而定义为：

> **Diff-first + On-demand Context + Cache-aware Review**

**POC1 运行底座与边界（v2.0 已定）**：

```text
Harness        独立薄 harness（TypeScript，零 DSH 依赖；DSH 仅并行 spike）→ ADR-0001
模型           DeepSeek 官方 API：deepseek-v4-flash 主力；deepseek-v4-pro 高险升级与消融
               （deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役）→ ADR-0002
Effort         全实验锁定单一 effort 档位，禁止档位漂移
检视目标       Java 单语言（语言适配留 seam）；POC1 全英文，输出语言为产品配置项
输入形态       本地 git 仓库 + MR diff；中小 MR：≤10 文件、diff ≤2K 行（大 MR 切分非目标）
代码智能       零构建静态解析（tree-sitter-java + ripgrep）→ ADR-0003
工具挂载       A / B 零工具；C / D / E 挂同一套 7 个 review.* 工具、schema 字节一致
判定链         原生真值 + 规则粗筛 + LLM-as-judge（GPT 系，异构校准）+ 10% 人工抽检
重复           ≥3 次报均值 ± 标准差；rep1 冷单列、rep2+ 热均值为主
划出范围       编译 / 测试执行不进 POC1；单遍自证为底线，二遍 Verifier（同模型 v4-flash）
               为消融开关、token 计入 CARC
```

### 五个实验配置（A–E）

**A：Diff-only**（三个基线之一；零工具：纯 diff 注入，模拟朴素基线）

```text
Diff
 ↓
LLM
 ↓
Review
```

**B：Minimal Context**（三个基线之一；零工具：Zone B + 固定管线确定性预取，与 C / E 对照"预取 vs 主动检索"）

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

**C：Full Repository**（三个基线之一；挂 7 工具、schema 与 D / E 字节一致；效果上限 = 质量主锚）

```text
Diff
+
Large Repository Context
 ↓
LLM
 ↓
Review
```

**D：Minimal Context + Stable Prefix**（新增缓存实验；挂 7 工具）—— 验证：Prefix 稳定性对缓存的影响。

**E：Minimal Context + Ledger + Append-only**（新增缓存实验；挂 7 工具；本项目主力系统形态）—— 验证：Context Ledger 是否同时降低 Token 并提高 Cache Hit。

### 实验矩阵

| 模式 | Context | Cache | 核心目的 |
|---|---|---|---|
| A | Diff | 无特殊设计 | 最低成本基线 |
| B | Minimal | 普通 | 验证精准 Context |
| C | Full Repo | 普通 | 效果上限（S/A/B 质量主锚） |
| D | Minimal | Stable Prefix | 验证 Prefix Cache |
| E | Minimal | Prefix + Ledger | 验证完整 Cache Strategy |

### 核心研究问题

- **Q1**：Diff-only 会漏掉多少深度问题？
- **Q2**：Symbol Context 能恢复多少？
- **Q3**：Impact Context 能恢复多少？
- **Q4**：达到 Full Repo 90% 效果需要多少 Context？
- **Q5**：Context Ledger 能减少多少重复 Token？
- **Q6**：Stable Prefix 能提高多少 Cache Hit？
- **Q7**：Cache 优化是否能在不改变 Review Quality 的情况下进一步降低成本？

### 推荐 Budget

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

## 7. 指标体系与 Benchmark

### 四组核心指标

**Review Quality**：Recall、Precision、F1、False Positive、Acceptance。

**Context Efficiency**：Context Tokens、Context / Finding、Deep Recall / Context Token。

**Agent Efficiency**：Tool Calls、Rounds、Latency。

**Cache Efficiency**：Cache Hit Rate、Cached Tokens、Uncached Tokens、Prefix Length、Cache Break Count。

### 派生效率指标：CE / RCE / RIE / CARC

**Cache Efficiency（CE）**：

```text
CE =
Cached Input Tokens
────────────────────
Total Input Tokens
```

**Review Cost Efficiency（RCE）**：

```text
RCE =
Review Quality
────────────────────────
Uncached Tokens + Tool Cost
```

**Review Intelligence Efficiency（RIE）** —— 建议作为最终核心指标：

```text
RIE =
Recall × Precision
──────────────────
Total Tokens / 1K
```

**Cache-adjusted Review Cost（CARC）**：

```text
CARC =
Uncached Input Tokens
+
Output Tokens
+
Tool Cost
```

RIE 与 CARC 这两个指标同时作为最终优化方向。

### Context / Cache 双优化成本模型

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

### Benchmark 数据集（v2.0 已定：逆补丁法 + 五源组合）

**MR 构造方法 —— 逆补丁法（Inverse-Patch）**：以修复补丁的逆 diff 构造"引入缺陷的 MR"——base 为修复后版本，MR 即"撤销该次修复"的变更，合入后代码状态为历史真实 buggy 版本（非合成篡改）；真值为最小修复补丁的精确行位与性质 + issue 描述。确定性、零挖掘噪声、可从任何缺陷历史数据集机械生成。（替代路径 SZZ 挖掘真实缺陷引入提交因 blame 噪声被否。）

**五源组合**：

| 数据集 | 条数 | 角色 |
|---|---|---|
| Defects4J（17 项目分层抽样，过滤 MR 边界 ≤10 文件 / diff ≤2K 行） | ~100 | Dataset A 主集：五配置全跑，S/A/B 判定主真值（最小化修复补丁、真值最干净；MIT） |
| Vul4J 安全子集 | ~30 | Dataset D：驱动 Risk Class=High 的 C2/C3 深加载验证（CVE/CWE 标签） |
| Multi-SWE-bench Java 抽样 | ~30 | Dataset A（MR 形态）：真实 PR 上下文的外部效度检查，只跑 C / E |
| 自建 clean MR（Multi-SWE-bench 9 仓挖 merged、无 issue 关联且未被 revert 的 PR） | ~50 | Dataset C 阴性对照：测 FP，含"主动检索是否推高无中生有率"的 A vs C 对比 |
| MCR-Bench Java（ISSTA 2026） | 556 全量参照 | Dataset B：不进主判定，用于 LLM-as-judge 校准与检视类别分布参照（license 核查后用） |

规模：约 (100+30)×5 + 30×2 + 50×5 ≈ 960 条 MR × 3 重复 ≈ 2,900 次检视运行 + judge 运行，v4-flash 价格下在预算内。

（数据集现状核查：GHTorrent、bugs-dot-jar、Bears 已死 / 不可用；SWE-bench-java-verified 与 Multi-SWE-bench Java 重叠且冻结；SWE-PRBench Java 仅 15 条过小；Java 7/8 时代项目因零构建约束重新可用。）

### Claude Code Benchmark

保证：

```text
Same Repository
Same Diff
Same Objective
```

模型不可同源（Claude Code 锁定 Claude 系模型，本项目锁定 DeepSeek 系），原"Same Model where possible"不成立（v2.0 修正）。因此 Claude Code 为**跨模型外部参照**：单列报告、不进 S/A/B 主判定。比较：

```text
Claude Code（跨模型外部参照）
Review Agent
Baseline LLM
```

主判定锚为配置 C（Full Repo 效果上限），见"POC 成功标准"。

### Benchmark Dashboard

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

### 消融实验

1. 去掉 Repo Map；
2. 去掉 Context Ledger；
3. 去掉 Stable Prefix；
4. 去掉 Evidence Checker；
5. 固定 Loop vs 自由 Loop；
6. 普通 Model Routing vs Cache-aware Routing；
7. 二遍 Verifier vs 单遍自证（v2.0 新增，Verifier token 计入 CARC）；
8. deepseek-v4-flash vs deepseek-v4-pro（高险升级增益，v2.0 新增）。

目的：

> **证明每个架构组件到底产生了什么价值。**

### POC 成功标准

主锚 = **配置 C（Full Repository 效果上限）**；Claude Code 为跨模型外部参照，单列报告、不进主判定（v2.0 修正）。

**S 级**：

```text
Recall ≥ 配置 C × 90%
Precision ≥ 配置 C
Token ≤ 配置 C × 30%
Tool Calls ≤ 配置 C × 30%
Cache Hit ≥ 85%（rep2+ 热口径）
```

**A 级**：

```text
Recall ≥ 配置 C × 80%
Token ≤ 配置 C × 30%
Cache Hit ≥ 80%
```

**B 级**：

```text
Recall ≥ 配置 C × 70%
Token ≤ 配置 C × 50%
```

## 8. 实施路线与风险应对

### 推荐开发阶段

**阶段 0：POC1 —— 独立薄 harness 实验（v2.0 已定，先行）**

```text
TypeScript 薄 harness（零 DSH 依赖）
 ↓
Context Engine / Context Ledger / 消息构造 / usage 记账（自实现）
 ↓
A–E 五配置 Benchmark（逆补丁法数据集，见第 7 章）
```

验证：Minimal Sufficient Context + Cache-Stable 命题本身（S/A/B 标准，主锚配置 C）。实验结论反过来决定 DSH Runtime 的实现深度；TS 代码在 Phase 1 直接复用（ADR-0001）。并行开展 DSH 技术 spike：`setFactory` 自定义 loop、pre-step / inject 挂点、preset 组装的实际成色（见第 2 章修正）。

**Phase 1：DSH Review Runtime（POC1 之后，迁移薄 harness 的 TS 代码）**

```text
DSH
 ↓
Review Agent
 ↓
Custom Review Loop
```

验证：DSH 是否可以承载 Review Runtime。

**Phase 2：Minimal Context**

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

验证：Minimal Sufficient Context。

**Phase 3：Cache Engine**

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

验证：Cache Hit / Token。

**Phase 4：Knowledge**

```text
CWD
+
History
+
DTS
```

验证：Domain Intelligence。

**Phase 5：Evidence**

```text
Finding
 ↓
Evidence
 ↓
Verification
```

验证：Precision / False Positive。

**Phase 6：Feedback**

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

> **Review Data Flywheel**

### 风险与应对

**风险一：Context 太少** —— 表现：Recall ↓、深度问题 ↓。应对：C1 → C2 → C3 按风险升级。

**风险二：Context 太多** —— 表现：Token ↑、Latency ↑。应对：Context Budget + Ranking。

**风险三：Cache 很高但 Context 不够** —— 不能单纯追求 Cache Hit Rate，必须同时看：Recall、Precision、Cache、Token。

**风险四：Context 动态变化导致 Cache Break** —— 应对：Stable Prefix + Append-only + Cache Break Detection。

**风险五：DSH API 快速变化** —— 当前 DSH 官方仍定位为 Developer Preview，因此必须控制依赖风险（[GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)）。建议：

```text
Pin Commit
+
Plugin-first
+
Adapter Layer
+
No Core Patch
```

## 9. 总结：架构原则与价值主张

### 十条最终架构原则

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

### 最终技术模型

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

底层统一由 **DeepSeek Harness** 提供：

```text
Agent
Session
Tool
Prompt
Event
LLM
Plugin
```

### 核心架构价值

最终不再是：

> **"做一个更小的 Claude Code。"**

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

### 核心命题与一句话方案

建议在技术方案首页直接定义核心命题：

> ### **Minimal Sufficient Context + Cache-Stable Agent Loop**
>
> 不追求让 AI 看到更多代码，而追求让 AI 用最少的有效 Context 获得足够的证据；不追求减少所有 Token，而追求减少无效 Token、Uncached Token，并最大化稳定 Prefix 的缓存复用。

最终一句话方案：

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

### 落地建议（原文末注）

建议把 **Cache Optimization Engine** 正式视为和 `Context Engine / Review Engine / Knowledge Engine / Evidence Engine` 同级的核心模块，而不是性能优化附录。这样以后做 PoC、技术汇报和 Benchmark 时，技术主线会非常清晰：**Context 决定看什么，Review Loop 决定怎么想，Cache Engine 决定怎么低成本地想。**

DSH 当前的 Session append-only、Prompt/Tool Schema 组装、Agent pre-step、Agent Loop 可替换等机制，也确实为这套设计提供了比较合适的底层扩展点（[GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）。

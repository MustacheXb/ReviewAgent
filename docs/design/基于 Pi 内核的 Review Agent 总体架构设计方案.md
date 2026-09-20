# 基于 Pi 内核的 Review Agent 总体架构设计方案

> **修订记录（v1.0，2026-09-18）**：本文是 ReviewAgent 的**spec 真源**，接替《[基于 DeepSeek Harness 的 Review Agent 总体架构设计方案](基于 DeepSeek Harness 的 Review Agent 总体架构设计方案.md)》（v2.1，已完成 DSH 线历史使命）——其内核无关内容（实验纪律、评测方法论、S/A/B 判级、五源数据集、缓存冷/热协议、零构建代码智能）由本文承接，DSH 内核专属内容随内核移除转为历史记录（[ADR-0009](../adr/0009-pi-kernel-from-scratch-rewrites-review-runtime.md)）。
> 本文的内核实现基线是《[Pi 内核从零实现方案](Pi 内核从零实现方案.md)》（Review Runtime 在 pi fork 上从 0 重写，P0–P5 路线）；pi 能力事实以本仓 fork 源码核实为准（《[Pi 内核演化缝盘点](Pi 内核演化缝盘点.md)》）。讨论输入《[基于pi 的 ReviewAgent总体架构设计方案文档讨论](基于pi 的 ReviewAgent总体架构设计方案文档讨论.md)》（v1.0）的有效内容与四项拍板已折入本文；与其相悖处以本文为准。
> **四项拍板（2026-09-18）**：① Claude Code 列入主对照列（注明模型不同源，§9.4）；② 单实验锁定单模型 + 单 effort 档位（§9.5）；③ 预算口径统一 `max_output` = 1K（§3.4）；④ 代码智能 Java 单语言先行、语言适配留 seam（§4.5）。
>
> **一句话结论**：以 `pi-agent-core + pi-ai` 为运行底座、自研 Review Runtime（Config B 生产形态：零工具 + 确定性预取、单轮）；测量常量面（提示词 / 上下文组装 / 判定链 / 指标 / 数据集）byte / 行为一致地平移冻结，内核变量面（Agent 状态 / 工具协议 / wire 序列化 / 会话投影）在 pi 原语上从 0 重写——Phase 2 实测 B 形态以全仓配置 7% 的 token 取得最高精度（0.7835）与稳定最高 F1（0.5763），本方案是该结论的生产化与重写落地路线。

---

## 1. 项目定位与总体目标

### 1.1 项目定位

ReviewAgent 是一个面向代码检视场景的**专用** AI Agent。

它不是：

> “Pi Coding Agent + 一个 Review Prompt”

也不是：

> “Mini Claude Code”

而是：

> **基于 Pi Agent Runtime 能力重新构建的专用 Review Runtime。**

项目姿态：**研究先行**——先用实验验证核心命题（Benchmark 与实验协议见 §9；Phase 1/2 已完成两轮），终局为落地到企业内部代码托管平台的 MR 检视；届时检视目标只提供**静态源码快照、无构建环境**（该约束直接决定代码智能的技术选型，见 §4.5）。

核心目标流水线：

```text
Git Diff
  ↓
Change Understanding（变更理解）
  ↓
Risk Classification（风险分级）
  ↓
Context Decision（上下文决策 → Minimal Sufficient Context）
  ↓
Context Retrieval（上下文获取）
  ↓
Deep Reasoning（深度推理）
  ↓
Evidence Verification（证据核验）
  ↓
Structured Finding（结构化结论）
```

### 1.2 项目核心技术命题

项目核心不是单纯追求：

> Review 准确率更高

而是同时优化四个维度：

```text
Review Quality（质量）
+
Context Efficiency（上下文效率）
+
Cache Efficiency（缓存效率）
+
Agent Efficiency（轮次/工具效率）
```

最终形成：

> **高质量 / 低 Token / 高 Cache / 低延迟**

这四个维度不是并列偏好，而是**同一命题的四个面**：Minimal Sufficient Context 同时决定质量（看得对）与 token（看得少）；确定性预取同时决定缓存命中（顺序稳定）与精度（Phase 2 实测 B 的 cacheHit 0.8114 与 precision 0.7835 同源于固定管线，[Phase 2 主数据分析报告](../report/Phase 2 主数据分析报告.md) §7）；单轮零工具决定轮次效率（实测多轮无质量增益，§1.5）。

### 1.3 为什么选择 Pi

pi 上游把 Agent 能力拆成三层：

```text
pi-ai          → 统一多 Provider LLM API（40+ provider）
pi-agent-core  → Agent Loop、Tool Calling、State、Events
pi-coding-agent→ 完整 Coding Agent CLI（Session/SDK/Compaction/TUI/RPC）
```

本项目的消费形态（[《Pi 内核定制基线方案》](Pi 内核定制基线方案.md)，2026-09-17 拍板）：**全源码 vendor fork，只保留四个包**——`pi-ai`、`pi-agent-core`（独立、无 coding-agent 依赖）、`chord`（服务组合运行时）、`pi-telemetry`（契约层），锚定上游 `6671c604`（v0.85.1 之后 11 天），约 5.6 万行，构建链全绿。coding-agent / tui / protocol / client / server 与检视内核无关，**不 vendor**——连“复用 Session/SDK 再关掉一堆 Coding 功能”的路径也不走（§2.3）。

因此 ReviewAgent 的姿态是：

> **以 `pi-agent-core + pi-ai` 为核心底座，自研 Review Runtime；fork 源码默认零改动，定制只经既有演化缝（§2.5）。**

### 1.4 总体原则

```text
专用优于通用          （Review Runtime ≠ Coding Runtime 换皮）
Diff-first ≠ Diff-only （以 Diff 为入口，按需向符号/影响层扩展）
Minimal Context 优于 Full Context （Phase 2 实测：全仓注入边际信息收益为负）
Evidence 优于 Guess    （No Evidence, No Finding）
Bounded Loop 优于无限 Loop （实测：多轮无质量增益，只转 token）
Stable Context 优于动态重构 （字节稳定前缀是缓存复用的根基）
Cache-aware 优于只看 Token （命中价 ≈ 未命中价 1/30）
Read-only 优先         （检视是只读行为；写类工具一律不进核内）
Benchmark 驱动         （每个架构组件的价值须由消融/对照证明）
```

### 1.5 已确立事实基线

本节是全文档的事实锚点：后续各章的设计决定要么由这些事实支撑，要么显式声明为未验证假设。主源：[Phase 2 主数据分析报告](../report/Phase 2 主数据分析报告.md)（30 案 VUL4J × A–E × 3 reps = 450 单元 × 三侧）、[ADR-0009](../adr/0009-pi-kernel-from-scratch-rewrites-review-runtime.md)、[《Config B 生产化方案》](Config B 生产化方案——差距分析、推荐路线与修改建议.md)。

| # | 事实 / 拍板 | 数据 / 主源 |
|---|---|---|
| F1 | **内核**：Review Runtime 在 pi fork 上从 0 重写；DSH 内核移除，其评测数据保留为对照基线（`runs/phase2-dsh`，450 单元） | ADR-0009 |
| F2 | **生产形态**：Config B 拍板（2026-09-17）——零工具 + 确定性预取（Diff→Symbol→Reference→Call Chain），`rounds=1`，无风险升级门 | 《Config B 生产化方案》 |
| F3 | **B 全面占优（质量面）**：precision 0.7835 全场最高、judge F1 0.5763 稳定最高（D 名义 0.6257 但跨侧不稳定、不作对照结论）；token 49.9k/单元仅为 C（全仓）706.5k 的 **7%** | Phase 2 §5.1 |
| F4 | **A 是效率双冠**：零工具纯 MR 上下文，judge recall 0.5008 最高、RIE 0.0242 最高（B 的 2.3 倍、C 的 17.3 倍）、token 22.6k 最低 | Phase 2 §5.1/§7 |
| F5 | **C（全仓注入）实证塌缩**：recall 0.1341 最低、token 最贵（A 的 31 倍）、77% 单元零 finding、跨侧 recall 极差 0.1487 最大——「全仓注入的边际信息收益为负」 | Phase 2 §5.4 |
| F6 | **S/A/B 判定**：B=S / C=BELOW_B / A·D·E=B，三侧逐字一致——但**锚坍缩**（C 热召回 0.0097，rep 曲线衰减到 0）：B=S 的实证内核是「B 热召回超 C 锚 2.2–10.8 倍且 token 为其 1/14」，语义是**显著超越一个塌缩的锚**，不是达到高质量水位；生产 KPI 须用绝对指标（人工接受率） | Phase 2 §3 |
| F7 | **多轮/工具无质量增益**：C/D/E 平均 2.3–3.3 轮、每单元 6 次工具调用——在该基准未转化为 recall/precision 优势，只转化为 token | Phase 2 §7 |
| F8 | **E 账本负方向**：E = D + 账本，recall 三侧一致低于 D（0.2355<0.2916 / 0.2325<0.2364 / 0.2893<0.3403）——账本机制在本基准无正向收益（方向性结论） | Phase 2 §5.1 |
| F9 | **B 的注意带**：rule 口径召回 rep 间单调衰减（0.1737→0.1495→0.0594），属「上下文重组 × 跨日部署漂移」敏感族（B/C/D 敏感，A/E 稳定）——生产 KPI 须跟踪该衰减带 | Phase 2 §5.3/§5.5 |
| F10 | **缓存命中机制验证**：B 总口径 cacheHit 0.8114 vs A 0.3678——确定性预取（固定管线顺序）拉高 44 个百分点；热口径 0.8782；C 0.9249 全场最高但属「贵上下文的重复读」而非效率 | Phase 2 §5.1/§5.2/§7 |
| F11 | **验收协议**：双门（确定性纪律门——字节/审计断言、零网络；指标对齐门——ADR-0007 对称 max σ 带 + 配对检验），内核无关，pi 线第三轮应用 | ADR-0007/0009 |
| F12 | **DSH 线教训**（→ADR-0009 的动因）：双客户端包袱、内核原生机制（inject/pre-step 等）对检视零贡献、SDK 协议冲突、文档与现实漂移等 12 课 | 《[POC1、Phase1、Phase2 阶段事实与教训摘要](../report/POC1、Phase1、Phase2 阶段事实与教训摘要.md)》§2 |

---

## 2. 总体系统架构与 Pi 内核

### 2.1 总体架构

```text
              企业内部代码托管平台（静态源码快照）
                          │
                    Webhook / CLI / CI
                          ↓
              ┌─────────────────────────┐
              │   Review Gateway        │
              │   Job / 鉴权 / 调度 / 去重 │
              └────────────┬────────────┘
                           ↓
              ┌─────────────────────────┐
              │    ReviewAgent Core     │
              │                         │
              │   Review Runtime  ←─────┼── 六阶段检视循环（从 0 重写）
              │   Context Engine        │    Zone A/B/C 组装、预取管线
              │   Cache Engine          │    前缀纪律、命中率治理
              │   Knowledge Engine      │    L1–L5 知识分层（未启动）
              │   Evidence Engine       │    判定链（核外，冻结平移）
              └────────────┬────────────┘
                           ↓
              ┌─────────────────────────┐
              │      Pi Runtime（fork）  │
              │   pi-agent-core         │    Agent/loop/工具/事件
              │   pi-ai                 │    统一 LLM Provider
              │   chord / telemetry     │    服务组合 / 遥测契约
              └────────────┬────────────┘
                           ↓
                企业网关（REVIEWER_URL）→ LLM
                （自由模型 id，#45 语义）
                           ↓
              Structured Finding → Check / Comment / Summary
```

### 2.2 分层职责

| 层次 | 主要职责 |
|---|---|
| Code Platform | MR / Commit / Comment 事件源 |
| Review Gateway | Job 化、鉴权、调度、去重 |
| ReviewAgent Core | Review Intelligence（怎么 Review） |
| Review Runtime | 检视循环、风险策略、预算 |
| Context Engine | C0–C3 上下文、Zone A/B/C 组装 |
| Cache Engine | 前缀纪律、命中率治理、冷热口径 |
| Knowledge Engine | 规则 / CWD / 历史知识（未启动） |
| Evidence Engine（核外） | 判定链、指标、对齐门（冻结仪器） |
| Pi Runtime | Agent 怎么跑：loop、工具执行、状态、事件、LLM 接入 |

核心分工三句话：

> **平台负责“什么时候 Review”，ReviewAgent 负责“怎么 Review”，Pi 负责“Agent 怎么跑”。**

再加两维：**Context Engine 决定“看什么”；Cache Engine 决定“怎么便宜地看”；Evidence Engine（核外）决定“问题是否真的成立”。**

### 2.3 Pi 源码使用边界

```text
                   ReviewAgent
                       │
              ┌────────┴────────┐
              ↓                 ↓
       自研 Review Runtime   Pi Runtime（fork）
              │                 │
         六阶段检视循环      Agent Core（loop/工具/事件）
         风险与预算策略      State / Events
         Evidence 纪律      —— fork 源码默认零改动
              │                 │
              └────────┬────────┘
                       ↓
                     pi-ai
                       ↓
                    LLM（企业网关）
```

**不建议**的形态（讨论稿 §2.3 的框架，本仓更彻底——coding-agent 根本不进树）：

```text
ReviewAgent → 直接基于完整 pi-coding-agent → 关掉一堆 Coding 功能
```

这会把写文件 / Edit / Bash / Coding Workflow / TUI / 开发态命令等不必要能力带进 Review Runtime，且引入与检视无关的升级面。fork 的四个包里，`chord` 是服务组合运行时（`FacetHost` 装配 + 复制状态）、`telemetry` 是契约层——二者当前无核内消费者，保留是为未来分布式/遥测需求预留的底座（[《Pi 内核演化缝盘点》](Pi 内核演化缝盘点.md) S7/S8）。

### 2.4 测量常量面与内核变量面

内核重写之所以是一次**有效的对照实验**而非简单换底座，前提是把系统切成两半（ADR-0009 §2）：

| 测量常量面（byte / 行为一致，不许漂移） | 内核变量面（被比较量，从 0 重写） |
|---|---|
| Zone A 系统提示词 / Zone B 仓库结构图 | Agent 状态与事件模型 |
| MR 呈现 / 预取管线输出（config B） | 工具调用协议与 wire 序列化 |
| 六阶段 Review Loop 语义 | LLM 客户端（pi-ai 取代 DSH 双客户端） |
| Finding / Evidence 契约与各纪律门 | 会话 / 审计投影机制 |
| 判定链（四层 + glm-5-3-260814 + S/A/B） | 前缀组装与缓存命中的实现路径 |
| 指标公式（CE/RCE/RIE/CARC）与 RunRecord | |
| 数据集（30 案 VUL4J + 物化仓） | |

- 「从 0」作用于右列：用 pi 原语重写为 `packages/review-pi`（约 6k 行内核 + 1k 集成）。
- 左列是**测量契约**：A/B 配置下要求请求字节一致（与 DSH 审计 `requests[].wireBody` 逐字节对照，§9.10）；判定链与指标要求行为一致（仪器冻结平移，约 10k 行，[《Pi 内核从零实现方案》](Pi 内核从零实现方案.md) §3）。
- 术语定义见 `CONTEXT.md`（测量常量面 / 内核变量面）。

### 2.5 内核定制边界：分层默认 + 显式越缝判据

核内在 fork 上**能改哪里、不能改哪里**，事实底座是《[Pi 内核演化缝盘点](Pi 内核演化缝盘点.md)》（全部条目 file:line 复核）。结论摘要：

**既有缝足以支撑核内全部运行时形态**——

| 缝 | 事实 | 核内用途 |
|---|---|---|
| 低层 loop 可整体替换 | `runAgentLoop` 是导出函数（`agent/src/agent-loop.ts:96`）；`Agent.streamFunction` 公有可变（`agent/src/agent.ts:181`） | A/B 配置自研 controller 直驱 pi-ai stream |
| 工具面运行时可变 | `AgentState.tools` setter（`agent.ts:81`）；harness `setTools`/`setActiveTools`；工具结果可动态增工具（`addedToolNames`） | C/D/E 工具注册与策略 |
| `transformContext` 只改消息 | 签名 `(messages, signal) => messages`（`agent.ts:101`），**不含 systemPrompt 与 tools** | C/D/E 消息序控制 |
| `steer`/`followUp` 队列 | `agent.ts:283/:288`（无 DSH inject 等价物，语义覆盖） | Developer Follow-up（§7.8） |
| 会话 append-only + fork | `harness/session/fork.ts`（fork 是复制派生，非重放） | 与 Zone C append-only 纪律同向 |

**五个内核缺口（越缝候选，无一个阻塞 P1–P5）**：按请求工具过滤钩子（G1）、harness 驱动不可插拔（G2，核内不依赖 harness 驱动）、条目不可变（G3，与纪律同向）、无重放派生会话 API（G4，自研审计投影承担）、无内置 telemetry exporter（G5，同前）。

**定制姿态（拍板 2026-09-18）**：默认全部经既有缝实现，**不动 fork 源码**。越缝（改 fork 源码）须三条判据全满足：

1. 缝内确实不可达（是「做不到」而非「不顺手」，须给出缝内尝试的失败证据）；
2. 离线、版本化、过对齐门后才上线——**不做会话中自由改写内核**；
3. 改动处带 fork 注释 + 回写《Pi 内核定制基线方案》§4 分歧清单。

**自进化（激进形态：运行时改写 loop / 工具集 / 提示词）的落点**：改工具集与改 loop 都在缝内可达（上表前两行）；改提示词受 Zone A 字节稳定纪律约束（自约束，非内核约束）——演进以 checkpoint 形态离线发生、版本化、经对齐门验证后切换；**改内核本身不在演进面内**。深层原则：演进层之下必须有稳定基底——基底随会话漂移，对照实验与缓存复用同时失真（§5.2 的衰减带就是基底漂移的实测表征，F9）。

---

## 3. Review Runtime 设计

### 3.1 专用 Runtime，不是 Coding Runtime 换皮

通用 Coding Loop 与检视 Loop 的结构差异：

```text
通用 Coding Loop                    Review Loop
Prompt                              Diff（变更即输入）
 ↓ Search                            ↓ Risk（先分级再决定看什么）
 ↓ Read                             ↓ Context Decision（最小充分上下文）
 ↓ Plan                             ↓ Context Retrieval（确定性预取/受限检索）
 ↓ Edit                             ↓ Deep Reasoning
 ↓ Test                             ↓ Evidence Verification
 ↓ Debug                            ↓ Structured Finding
```

差异不止于提示词：**状态模型、工具面、循环预算、输出契约**全部不同——这就是「从 0 重写 Review Runtime」而非「给 Coding Agent 换提示词」的理由，也是 ADR-0009 边界划分的语义依据。

### 3.2 六阶段骨架与两种驱动形态

六阶段骨架（测量常量面，语义冻结）：

```text
Change Understanding → Risk Classification → Context Decision
→ Context Retrieval → Deep Reasoning → Evidence Verification
```

骨架由**策略驱动器（Review Driver）**在代码层强制推进（一阶段 = 一回合，回合边界执行 Evidence Gate 与轮次调度；CONTEXT.md 术语）。pi 线的实现按配置分两种驱动形态：

| 形态 | 配置 | 驱动机制 | 依据 |
|---|---|---|---|
| **直驱** | A / B（零工具） | 自研 controller 直驱 pi-ai stream（`runAgentLoop` 整体绕开，缝盘点 S1）——单轮请求，消息序完全自持，请求字节可钉 | B 生产形态 `rounds=1`（F2）；字节门要求（§9.10） |
| **钩子驱动** | C / D / E（七工具） | `pi-agent-core` Agent + agentLoop 钩子：`shouldStopAfterTurn` 控轮次、`transformContext` 控消息序、`state.tools` 控工具面 | 消融面需要工具循环 |

六阶段的语义（测量常量面）与两种形态下的实现落点：

| 阶段 | 语义职责 | B 形态实现（单轮） | C/D/E 形态实现 |
|---|---|---|---|
| 1 Change Understanding | 解析变更面（文件 / hunk / 行 / 符号） | 确定性解析，请求前完成 | 阶段回合（提示词 + 工具） |
| 2 Risk Classification | 风险分级，决定加载深度与证据等级 | 提示词语义承载（单轮内） | 阶段回合 |
| 3 Context Decision | 决定取哪些上下文（最小充分） | 固定预取管线，无模型决策 | 模型决策（工具预算内） |
| 4 Context Retrieval | 取上下文进 Zone C | 静态预取，请求前完成 | `review.*` 工具调用 |
| 5 Deep Reasoning | 假设—证据推理，产出候选 | 单轮请求内 | 阶段回合 |
| 6 Evidence Verification | 核验证据链 | 请求内自证 + 请求后确定性契约校验 | 回合边界 Evidence Gate |

B 形态把阶段 1/3/4 的职能移出模型（确定性管线承担），阶段 2/5/6 压入单轮提示词语义与确定性后处理——这是「零工具」与「请求字节可钉」能同时成立的结构原因。

C/D/E 面采用**固定阶段骨架 + 阶段内受限自主检索**的混合形态：阶段顺序固定，阶段内的检索由模型在工具预算内自主完成；确定性预取（Zone B）不占自主检索预算。

> **实测注记（修正讨论稿 §3.2 的「已验证」表述）**：六阶段骨架本身经 POC1/Phase 1/2 验证；但「阶段内自主检索」的增益**未获 Phase 2 支持**——C/D/E 的多轮与工具调用没有转化为质量优势（F7），生产主线因此拍板为 B 的零工具单轮（F2）。混合形态保留在 C/D/E 消融面，其价值命题（自主取证 vs 确定性预取）仍由对照实验回答（§9.3 Q4）。

### 3.3 Evidence-driven 检索纪律

模型每次决定获取更多上下文时，必须产生假设—证据链：

```text
Current Hypothesis → Missing Evidence → Evidence Request
→ Context Retrieval → Hypothesis Update
```

而不是自由探索（Search→Read→Search→Read…）。在 B 形态下该纪律被**确定性化**：预取管线固定（§4.4），「该看什么」由静态分析决定而非模型决定——这是 B 兼得精度与缓存命中的机制根源（F3/F10）。Evidence Gate（"No Evidence, No Finding"）在回合边界由驱动器强制执行。

### 3.4 Agent Budget

预算口径统一（拍板 2026-09-18）：`max_output` = 1K。分层预算（C/D/E 面的规划基线，数值最终由 Benchmark 调优；**实验级预算以冻结的实验计划为准**，§9.5）：

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

B 形态的实际预算由 Zone 结构决定（§4.3）：Zone B ≤16K 字符 + 原生 diff + Zone A，单轮。

预算耗尽的处置：

```text
停止继续探索 → Evidence 不足 → 不输出 Finding（宁缺毋滥）
```

### 3.5 Review State

核内状态模型自持（内核变量面），只保留检视所需：

```text
Review State = { Diff, Risk, Zone A/B/C 上下文账目, Evidence,
                 Candidate Findings, Verified Findings, Budget }
```

不继承通用 Coding Agent 的状态面（工作区、文件编辑、终端等）。

### 3.6 Knowledge Engine（未启动，P0–P5 范围外）

知识是检视质量的长期增益项，当前状态：**未启动**；在架构中的挂接点已经确定——C3 上下文层（§4.2）与第 4 预取层（§4.4）。

知识分层：

```text
L1 Coding Rule      （通用编码规范）
L2 CWD Rule         （本项目历史缺陷模式库——Context.md 术语：项目私有版缺陷模式规则）
L3 Review Case      （历史检视案例）
L4 Historical Defect（历史缺陷记录，DTS 来源）
L5 Business Knowledge（业务规则）
```

知识生产链路：

```text
DTS / Review / Git / Production → Defect Mining → Pattern Extraction → CWD → Review Knowledge
```

知识检索纪律：**Top-K 按需检索**（Diff → Risk → Knowledge Retrieval → Top-K Rule/Case），不是全量规则塞 Prompt——与 Minimal Sufficient Context 同构。

### 3.7 Check Engine（质量验证引擎，未启动，环境门控）

让检视从「AI 判断」升级为「AI 判断 + 工程验证」：

```text
Candidate → Evidence → Validation（Compile / Unit Test / Runtime）→ Confirmed Finding
```

**环境门控（硬约束）**：企业落地只提供静态源码快照、无构建环境——编译 / 单测 / 运行时验证在主产线**不可用**；该引擎只在具备构建环境的部署形态（私有化 CI 集成、V0.5+，§8.3）下启用，且不进早期实验。当前 Evidence Verification 的底线形态是单遍自证 + 二遍 Verifier 消融开关（§6.3）。

---

## 4. Context Engine 与 Minimal Sufficient Context

### 4.1 核心问题

```text
Full Repository ── 深度能力强，但 Token 高（实测：边际信息收益为负，F5）
Diff-only       ── Token 低，但深度问题可能漏检
```

因此采用：

> **Diff-first + On-demand Context**（以 Diff 为入口，按需向符号层与影响层扩展）

**Minimal Sufficient Context**：能支撑正确 Review 判断的最小上下文集——介于 Diff-only 与全仓之间，其存在性与构成由 A–E 对照实验回答（§9.2/§9.9）。

### 4.2 上下文四层（C0–C3）

```text
C0 Diff Context      Changed Files / Hunk / Lines / Changed Symbols
C1 Symbol Context    Changed Method / Class / Local Context / Related Symbol
C2 Impact Context    Caller / Callee / Reference / Interface / Call Chain（按需）
C3 Knowledge Context CWD / Historical Review / Historical Defect / Business Rule（未启动）
```

C2 的零构建现实（§4.5）：`get_call_chain` 降级为 **1~2 层名字级引用链**。

### 4.3 Zone 结构与字节契约

请求上下文按缓存稳定性分三个 Zone（测量常量面，A/B 字节门的对象）：

| Zone | 稳定性 | 内容 | 缓存语义 |
|---|---|---|---|
| **Zone A（Stable Prefix）** | 跨 MR 字节稳定 | 检视角色、目标、政策、Finding Schema、Evidence 政策（零工具配置下无 Tool Schema） | 最大复用 |
| **Zone B** | 同仓跨 MR 稳定 | Repo Map（~40%）+ 包/模块结构（~20%）+ Symbol Index（~40%），≤16K 字符；前两节跨 MR 字节一致，**分歧点在 Symbol Index 内部**（变更文件所在包圈定） | 高复用 |
| **Zone C（Append-only）** | 会话内只追加 | MR 呈现、预取管线输出、动态上下文 | 追加不重排 |

构造纪律：**能不变就不变，能追加就不重写**（CONTEXT.md：Append-only Context / Cache-Stable Review Loop）。

### 4.4 确定性预取管线（B 形态核心机制）

```text
Diff → Symbol → Reference → Call Chain（固定顺序，静态生成，不经过 LLM）
                └─ C3 Knowledge（第 4 预取层，预留，未启动）
```

- 管线输出进 Zone C；顺序固定是缓存命中的直接来源（F10：B 0.8114 vs A 0.3678，+44pp）。
- 预取不占模型自主检索预算（C/D/E 面同理）。
- 该管线的实现（`src/zoneb` + `src/codeintel`，≈1.8k 行）属测量常量面，P0–P5 中在 pi 侧从 0 重写但**行为与字节完全对齐**（§9.10 字节门）。

B 形态单轮请求布局（逻辑注入序；最终字节序由 P2 门钉死）：

```text
Zone A（系统提示）—— 检视角色 / 政策 / Finding Schema / Evidence 政策（跨 MR 字节稳定）
Zone B —— Repo Map + 包/模块结构（同仓跨 MR 字节稳定）
      └─ Symbol Index（按变更文件所在包圈定——跨 MR 分歧点）
MR 呈现 —— 原生 diff（+ issue 描述；评测口径为原生英文 issue）
预取管线输出 —— Symbol → Reference → Call Chain（固定顺序）
输出指令 —— Finding 序列化格式与预算（max_output = 1K）
```

### 4.5 零构建代码智能（Java 单语言先行）

企业落地只提供静态源码快照（不可编译、无构建环境），C1/C2 实现后端锁定零构建静态解析（ADR-0003 纪律延续）：

```text
tree-sitter-java → 签名级符号提取（Symbol Map / Zone B Symbol Index 生成器）
ripgrep          → 词法引用匹配（Reference Map）
文件读取         → 源码摘录（Evidence）
```

排除一切构建依赖方案（scip-java 是 javac 插件、jdt-ls 需 Maven/Gradle import、Kythe 需构建捕获）。精度天花板为词法级（重载 / override 分辨不精确），但实验内各配置共享同一工具精度、配置间对比不受污染；主对照 Claude Code 同为词法工具（grep / read），跨对照公平。

语言路线（拍板 2026-09-18）：**Java 单语言先行，语言适配留 seam**——多语言是能力扩展项，不是首阶段实验变量。后续：Python → C/C++ → Go → TypeScript → Kotlin（tree-sitter 语法面同族，适配点在符号/引用提取器）。

### 4.6 Context Selector（C/D/E 面接口）

工具配置下的上下文决策接口（B 形态下退化为确定性管线，无此组件）：

```ts
interface ContextSelector {
  select(diff: DiffContext, risk: RiskProfile,
         hypothesis: ReviewHypothesis, budget: ContextBudget): Promise<ContextPlan>;
}
interface ContextPlan { requests: EvidenceRequest[]; estimatedTokens: number; reason: string; }
```

### 4.7 上下文准入原则

pi 允许自定义资源加载机制。事实修正（2026-09-18 核实 fork 源码）：**Skills 的机制面在 vendor 的 agent 包 harness 层，不在 coding-agent 面**——`Skill` 类型（`harness/types.ts:49`）、`loadSkills` 加载器（`harness/skills.ts:51`，实现 agentskills.io 标准，可直接读取 Claude Code / Codex / pi 的技能目录）、`formatSkillsForSystemPrompt` 系统提示块（`harness/system-prompt.ts:3`）、显式调用 `harness.skill()`（`lane.ts:1147`）；coding-agent 面仅是装配与发现策略（技能目录约定、`/skill:name` 命令、settings 接线），该面未 vendor。关键性质：harness 层 skills 是**应用供给资源**——无自动发现、无自动注入，`resources.skills` 由宿主提供、系统提示块由宿主调用生成、调用由宿主显式触发（`disable-model-invocation` 可对模型隐藏单个技能）。ResourceLoader / Context Files 仍属 coding-agent 面，未 vendor。

核内纪律不变且被上述机制性质强化：**Context Engine 独占上下文准入**——任何进入模型上下文的内容都由 Context Engine 显式决定，不依赖任何框架机制自动灌入项目上下文。skill 生态的接入姿势由此确定：**内容面**——`loadSkills` 读取的 SKILL.md 内容作为 Knowledge Engine（§3.6）C3 层（§4.2）的输入源之一，经 Top-K 检索由 Context Engine 决定准入；**机制面**——`formatSkillsForSystemPrompt` 列表注入与模型自主加载（progressive disclosure）限 C/D/E 消融面实验，生产面（B）不启用。这是测量常量面成立的前提（上下文组装必须完全自持，请求字节才可钉）。

---

## 5. Cache Engine 与低成本架构

### 5.1 为什么 Cache 是一级模块

检视成本不能只看 Total Tokens，必须同时看：

```text
Total Tokens / Cached Tokens / Uncached Tokens / Cache Hit Rate / Prefix Stability
```

依据：DeepSeek 系缓存命中价约为未命中的 **1/30**（§5.8）——命中率是成本的一阶变量，不是锦上添花。

### 5.2 B 形态的缓存故事：跨 MR 前缀复用（生产主线）

B 的缓存收益来自**跨 MR 的前缀复用**，不是会话内机制：

- **机制**：Zone A 跨 MR 字节稳定 + Zone B 前两节（Repo Map + 包结构）同仓跨 MR 字节稳定——同一仓库的连续 MR 检视共享越来越长的前缀；分歧点被压到 Symbol Index 内部（§4.3）。
- **实测**：B 总口径 cacheHit 0.8114、热口径 0.8782（F10）；Phase 2 的 3-rep 会话内自然混合口径。
- **部署杠杆**：**同仓 MR 批次调度**——把同一仓库的待检 MR 排在一起执行，最大化前缀复用窗口（生产调度策略，§7.1）。
- **注意带（如实携带）**：F9 的衰减现象说明重上下文配置对「上下文重组 × 跨日部署漂移」敏感——跨日前缀陈旧化（缓存淘汰 + Zone B 内容演化）会侵蚀复用，生产 KPI 须按冷热分层跟踪（§5.8 协议）。

### 5.3 Stable Prefix（Zone A）

固定：检视角色 / 目标 / 政策 / Finding Schema / 严重级定义 / Evidence 政策。原则：**Byte-stable**。禁则：

```text
每轮修改 System Prompt / 每轮修改 Tool Order / 动态重排 Rule / 动态重排 Context
```

### 5.4 Context Ledger 与 Append-only（C/D/E 消融面）

Ledger（已加载上下文登记账：文件/区间/符号/证据，重复请求返回引用而非原文）与 Append-only 构造属**消融面机制**，不是生产主线：

- **实测结论（F8）**：E = D + 账本，方向性负收益（recall 三侧一致低于 D）——账本机制在本基准无正向收益。讨论稿把 Ledger/Append-only 放在 Cache Engine 主线的叙事**不成立**，本文按实测修正。
- 该机制的价值命题（减少重复发送）在「跨请求复用」语义下由 Zone A/B 前缀复用承担（§5.2）；会话内去重语义保留在消融清单（§9.7 第 2 项）继续检验。

### 5.5 Compaction

- **B 形态**：单轮请求，无 compaction 需求；pi 线显式 `compaction: {enabled: false}` 保字节纪律（[《Pi 内核从零实现方案》](Pi 内核从零实现方案.md) §4）。
- **C/D/E 多轮面（未来项）**：Review-specific Compaction——只保留变更符号 / 关键上下文 / Evidence / 已验证与已否决 Finding / 开放问题；且 compaction 不得破坏 Stable Prefix：

```text
Stable Prefix + Retained Review State + Compaction Result
（而不是 New System Prompt + New Tool Schema + Summary——那会从请求前部就摧毁缓存复用）
```

删除侧：无价值对话、重复工具结果、重复代码、无效探索。

### 5.6 Cache-aware Model Routing（部署面）

模型选择不能只看 Quality + Cost，还要看 **Cache Warmth**：

```text
Model Score = Quality + Cost + Cache Reuse
```

例：Model A 质量高、成本低、Cache 90%；Model B 质量更高、成本略低、Cache 0%——不一定该切到 B。多 Provider（pi-ai 的 40+ provider 面）是**部署资产**，不是实验自由度（实验纪律 §9.5）。

### 5.7 Cache Metrics 与 CacheBreakEvent

记录：`prefix_tokens / cached_tokens / uncached_tokens / cache_hit_rate / cache_break_count / cache_break_reason`。

Cache 显著下降时记录 `CacheBreakEvent`，分类定位「为什么这一次 Review 的 Cache Hit 突然下降」：

```text
SYSTEM_PROMPT_CHANGED / TOOL_SCHEMA_CHANGED / TOOL_ORDER_CHANGED / MODEL_CHANGED
ROUTE_CHANGED / CONTEXT_REORDERED / CONTEXT_MUTATED / COMPACTION_REBUILT
```

Cache Policy 目标：`cache_target_hit_rate ≥ 85%`（rep2+ 热口径；B 实测 0.8782 已达标）。

最终指标：

```text
Cache Efficiency = Cached Input Tokens / Total Input Tokens
```

### 5.8 DeepSeek 缓存语义与冷/热报告协议

DeepSeek 官方 API 的上下文缓存为**磁盘缓存 + 持久化单元整匹**语义，与朴素的「最长公共前缀」直觉有三处关键差异：

1. **整匹而非增量**：请求 A+B 缓存后，A+C 不命中 B 的部分；但公共前缀 A 会被持久化，供后续 A+D 命中。稳定前缀的价值在「跨请求复用同一前缀」，而非任意前缀部分命中。
2. **账号级共享、best-effort**：缓存按账号（API key）共享、闲置数小时至数天清除；跨会话前缀复用需 ≥2 次共享请求才会持久化公共前缀。
3. **计量与价格**：usage 报告 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；命中价约为未命中的 1/30。

由此 Benchmark 采用**分层报告协议**：

```text
rep1（冷启动）          → 单列报告，不计入主口径
rep2+（热稳定）         → 均值 ± 标准差，主口径
会话内自然混合命中率     → 主口径；跨会话预热曲线 → 单列实验
```

单发配置（A/B/C）的重复运行命中率含测量伪影（同一请求重复即命中），冷成本与热均值必须分层呈现。

### 5.9 Incremental Review（未来项，未验证）

MR/PR 多 commit 场景的进一步复用（与跨 MR 复用同族，属部署杠杆的延伸）：

```text
Commit A → Review A
Commit B → Diff(B-A) → Incremental Review（复用 Stable Prefix / Repo Map /
Commit C → Diff(C-B)   Symbol Map / Previous Evidence / Previous Findings）
```

状态：**未验证**——机制上依赖平台提供逐 commit 事件与中间产物缓存；价值命题（增量检视的 token/延迟收益）列为后续实验，不进当前承诺。

---

## 6. 工具、Evidence 与 Finding 架构

### 6.1 review.* 七工具（C/D/E 面）

```text
review.get_diff / review.get_symbol / review.get_file
review.find_references / review.get_call_chain（零构建降级：1~2 层名字级引用链）
review.search_rule / review.search_history
```

不提供：write / edit / delete / git push / git commit——**核内无写类工具，只读是构造性保证**（§10 风险五的缓解根基）。

| 工具 | 语义 | 零构建实现后端 |
|---|---|---|
| `review.get_diff` | 取变更 diff | 原生 diff |
| `review.get_symbol` | 符号签名级信息 | tree-sitter-java 符号索引 |
| `review.get_file` | 读文件 / 区间 | 文件读取（Evidence 摘录） |
| `review.find_references` | 词法引用查找 | ripgrep Reference Map |
| `review.get_call_chain` | 调用链 | **降级：1~2 层名字级引用链** |
| `review.search_rule` | 规则检索 | L1/L2 规则库（知识层未启动，§3.6） |
| `review.search_history` | 历史检视 / 缺陷检索 | L3/L4（同上） |

工具注册走 pi-agent-core 工具面（zod schema；`AgentState.tools` setter / harness `setTools`，缝盘点 S2）；C/D/E 挂同一套七工具、schema 字节一致（§9.2）。

### 6.2 Tool Policy

每个工具受五维控制：Allowlist / Budget / Timeout / Context Cost / Risk Policy。成本分级示例：

```text
get_symbol → low    get_call_chain → medium    search_history → high
```

Risk 策略决定是否值得调用（高险 MR 才放开高成本工具）。

### 6.3 Evidence Engine 与验证遍数

任何 Finding 必须经过：

```text
Candidate → Evidence → Verification → Confidence → Accept / Reject
```

默认纪律：**No Evidence, No Finding**（Evidence Gate，回合边界强制）。

验证遍数的阶段语义（phase2 执行口径延续）：

- **单遍自证**（Reasoning 阶段内自我核查）= 底线形态，生产默认；
- **二遍 Verifier**（独立第二遍复核 Finding）= **消融开关**，Verifier 使用同模型、其 token 消耗计入 CARC（§9.7 第 7 项）；
- 编译 / 测试 / 运行时验证属 Check Engine（§3.7），环境门控，不进早期实验。

### 6.4 Finding 契约与后处理

Finding 契约（severity / category / file:line / title / description / evidence refs / rule / confidence）是**测量常量面**——以现行冻结契约（`src/contracts` + `src/finding`，pi 侧语义平移）为 spec 真源，本文不复刻简化版。产出侧两个后处理：

- **去重**（确定性后处理）：多检视路径产出同一 Finding 时，按 Location + Category（+可选语义相似度 + Evidence）合并；
- **输出分级发布**：见 §7.6。

---

## 7. 生产线与企业平台集成

> 本章是旧 DSH 架构文档没有的增量（其生产内容散在《Config B 生产化方案》）；拓扑四件套（Gateway/Scheduler/Worker/Adapter）与 ReviewJob 契约来自讨论稿 v1.0 的有效增量，按本仓约束（企业内部平台、静态源码快照）适配。

### 7.1 集成拓扑

```text
企业内部代码托管平台
        │ Webhook（MR 事件）
        ↓
Review Gateway（Job 化 / 鉴权 / 去重）
        ↓
Review Scheduler（调度；同仓 MR 批次调度——前缀复用部署杠杆，§5.2）
        ↓
Review Worker（工作区生命周期）
        ↓
ReviewAgent（B 形态，单轮）
        ↓
Pi Runtime → 企业网关（REVIEWER_URL）→ LLM
        ↓
Structured Result
        ↓
Check / Inline Comment / Summary（§7.6）
```

### 7.2 Platform Adapter

不直接依赖任何具体平台，定义适配接口：

```ts
interface CodePlatformAdapter {
  getChange(ref: ChangeRef): Promise<Change>;
  getDiff(ref: ChangeRef): Promise<Diff>;
  prepareWorkspace(ref: ChangeRef, workspace: string): Promise<void>;  // 静态快照落盘
  publishCheck(ref: ChangeRef, result: ReviewResult): Promise<void>;
  publishComments(ref: ChangeRef, findings: ReviewFinding[]): Promise<void>;
}
```

企业内部平台 Adapter 先行；GitHub / GitLab / Gerrit 形态为开源部署预留（V0.3+，§8.3）。

### 7.3 ReviewJob 契约

平台事件统一转成：

```ts
interface ReviewJob {
  jobId: string;
  repository: string;
  baseSha: string;   // ┐ 固定检视输入——可复现性的根基，
  headSha: string;   // ┘ 与评测侧「物化仓 + 原生 diff」同一纪律
  profile: string;   // 检视档位（B 生产形态 / 消融档）
  budget: ReviewBudget;
}
```

> **baseSha + headSha 固定 Review 输入**——生产侧的可复现性与实验侧的 RunRecord / 审计留痕是同一纪律的两个面。

### 7.4 Worker 与静态源码快照约束

```text
创建 Workspace → 落盘源码快照（exact base/head 状态，无构建）
→ 启动 ReviewAgent → 收集结果（Finding + Metrics + 审计）
→ 回写平台 → 清理 Workspace
```

约束：企业平台只给静态源码快照、无构建环境——Worker 不做任何编译/测试动作（Check Engine 的门控根源，§3.7）。

### 7.5 本地 / CI 集成

```bash
# 本地
review-agent review --base HEAD~1

# CI
review-agent review --base $BASE_SHA --head $HEAD_SHA --format json

# 企业平台
Review Job → Review Worker → ReviewAgent
```

CLI 形态对齐原 `review-agent`（pi 侧 `review-pi` CLI，P3 票，[《Pi 内核从零实现方案》](Pi 内核从零实现方案.md) §7）。

### 7.6 输出分级发布

```text
P0 / P1 → Inline Comment（行级评论）
P2      → Summary + 可选 Comment
P3      → Summary only
```

同时生成：Review Summary + Finding List + Evidence + Metrics（审计留痕，`AuditFileContent` 投影含 `requests[].wireBody`）。

### 7.7 Config B 生产化四必做项（上线前硬票）

《Config B 生产化方案》拍板的生产化差距项（骨架不动——保守路线，B 形态已实测占优，不在上线前改骨架）：

| # | 必做项 | 内容 | 验收 |
|---|---|---|---|
| 1 | **MR 边界护栏** | 文件数 / diff 行数上限（与数据集过滤口径同构：≤10 文件 / diff ≤2K 行量级）；超界 MR 降级处置或拒检——防 Zone B 预算击穿 | 超界 MR 走显式降级路径，零静默超预算 |
| 2 | **输出语言配置** | 检视输出语言可配置（企业场景中文检视） | 语言设置进审计留痕，Finding / Summary 文案随配 |
| 3 | **模型迁移门** | 换模型 / 换网关先冒烟自证（双探针 + 人话诊断）；高险升级（flash→pro）作为消融验证项（§9.7 第 8 项），不是默认行为 | 冒烟通过才可切流；探针形态随 pi 线回归 |
| 4 | **质量反馈落库 v1** | Finding 处置结果落库（接受/拒绝/误报）+ 接受率 KPI——绝对指标口径（F6：锚相对结论不可作生产 KPI） | 处置与接受率可按 MR / 周期聚合出数 |

实现锚点说明：四必做项的实现锚点当前在 `src/*`（评测装置侧），P4 runner 接缝切换后随 `src/` runtime 模块退役一并迁至 pi 侧（§8.2）。

### 7.8 反馈闭环与 Developer Follow-up

反馈飞轮的两半：

- **落库侧**（v1，四必做第 4 项）：处置结果 + 接受率 → 知识生产链路入口（§3.6）。
- **交互侧**（未来项）：平台评论事件重入既有检视会话——

```text
@review-agent explain F001
→ Existing Review Session + Finding + Evidence + User Question → Reviewer Conversation
```

pi 侧实现缝已核实（`steer()` / `followUp()` 队列，缝盘点 S5；无 DSH inject 等价物但语义覆盖）。约束：重入会话仍受 Zone A 字节纪律约束（追加不重排）。

---

## 8. 实施路线

### 8.1 P0–P5 重写路线（内核侧，主线）

[《Pi 内核从零实现方案》](Pi 内核从零实现方案.md) §7 的票面（spec 细节以该文档为准）：

| # | 票 | 内容 | 验收 | 状态 |
|---|---|---|---|---|
| P0 | 基线处置 | DSH 移除 + phase2 数据迁入本仓 | 树绿、analyze:phase2 消费三侧数据 | ✅ 2026-09-18 |
| P1 | pi walking skeleton | 单案 × config B 全链：自研组装 → pi-ai（网关）→ findings → 审计投影 → RunRecord；wire 捕获；usage 映射 | RunRecord 被 analyze 原样消费；R2/R4/R6 关闭 | |
| P2 | 字节纪律门 | A/B `wireBody` vs DSH 审计真源逐字节对照 | 零差异或差异逐条登记为显式决策 | |
| P3 | 全配置面 + CLI | C/D/E 七工具上 agentLoop；`review-pi` CLI | 工具语义等价 + 前缀稳定 | |
| P4 | 实验 runner 接入 | kernel 执行缝 + 450 单元矩阵 | 全矩阵可跑；`src/` runtime 模块退役 | |
| P5 | 评测与对照 | judge + 指标复算 + DSH↔pi 对称 σ 带对齐门 + 对照报告 | 报告入 `docs/report/` | |

### 8.2 生产化前置票

四必做项（§7.7）+ 部署项（同仓批次调度、输出分级）在 P4/P5 窗口并行推进；**上线门 = 四必做全绿 + P5 对照报告通过双门**。`src/` 评测装置侧的运行时模块在 P2 字节门绿、P4 接缝切换后退役（ADR-0009 退役时点表）——四必做项锚点随之迁移。

### 8.3 P5 之后的产品演化阶梯

（讨论稿 V0.x 阶梯按实测校正后采用：其 V0.1「验证 Diff-only vs Minimal vs Full」与 V0.2「验证 Cache 收益」**已由 POC1/Phase 1/2 回答**——A/B/C 对照与 cacheHit 双口径故事都是既成事实；阶梯从 P5 之后起算。）

| 阶段 | 主题 | 内容 | 增益验证命题 |
|---|---|---|---|
| V0.3 | 平台原生检视 | Adapter 完整化、Webhook、Check / Inline Comment、同仓批次调度 | 部署杠杆的前缀复用收益（§5.2） |
| V0.4 | 领域智能 | Knowledge Engine 启动：CWD / 历史检视 / 历史缺陷 / DTS / 业务规则（L1–L5） | 企业历史知识对 Recall / Precision 的增益 |
| V0.5 | 工程 + Quality Gate | Check Engine（编译/单测/运行时，**环境门控**，§3.7）；Incremental Review（§5.9） | 工程验证对误报率的削减 |
| V1.0 | 企业级 AI Reviewer | 多平台（企业内部 + GitHub/GitLab/Gerrit 形态）、多语言（§4.5 语言路线）、多模型（cache-aware routing，§5.6） | —— |

---

## 9. 评测体系与 Benchmark

> 评测装置是**核外冻结仪器**（ADR-0009：判定链 / 指标 / 数据集 / 双门协议平移复用，重写仪器会引入判定漂移）。本章给出协议全貌 + Phase 2 已测结果 + pi 线对照实验设计。

### 9.1 数据集：逆补丁法 + 多源组合

**逆补丁法（Inverse-Patch）**：以修复补丁的逆 diff 构造「引入缺陷的 MR」——base 为修复后版本，合入后即历史真实 buggy 版本（非合成篡改）；真值 = 最小修复补丁的精确行位与性质 + issue 描述。确定性、零挖掘噪声、可从任何缺陷历史数据集机械生成。（替代路径 SZZ 挖掘真实缺陷引入提交因 blame 噪声被否。）

ReviewBench 多源组合（设计全貌；license 核查后逐源启用）：

| 数据源 | 条数 | 角色 |
|---|---|---|
| Defects4J（分层抽样，过滤 MR 边界 ≤10 文件 / diff ≤2K 行） | ~100 | 主集：五配置全跑，S/A/B 判定主真值 |
| Vul4J 安全子集 | ~30 | 高险集：Risk Class=High 的 C2/C3 深加载验证（CVE/CWE 标签） |
| Multi-SWE-bench Java 抽样 | ~30 | 真实 PR 上下文外部效度检查（只跑 C/E） |
| 自建 clean MR（merged、无 issue 关联、未被 revert） | ~50 | **阴性对照**：测 False Positive（含「主动检索是否推高无中生有率」的 A vs C 对比） |
| MCR-Bench Java | 556 全量参照 | 不进主判定；LLM-as-judge 校准与检视类别分布参照 |

**现行执行口径（phase2 已落地）**：30 案 VUL4J × A–E × 3 reps = 450 单元 × 三侧（main / noise / dsh）。

### 9.2 实验配置矩阵（A–E）

| 配置 | Context | Cache | 工具 | 定位（按实测修正） |
|---|---|---|---|---|
| A | Diff-only（纯 MR） | 无特殊设计 | 零工具 | 最低成本基线；**实测召回与效率双冠（F4）** |
| B | Minimal | 普通 | **零工具**（Zone B + 固定管线确定性预取） | **生产主线（拍板）**；实测精度/F1 冠（F3） |
| C | Full Repo | 普通 | 7 工具 | 协议判级锚（ADR-0004）；实测塌缩（F5） |
| D | Minimal | Stable Prefix | 7 工具 | 自主拉取 + 稳定前缀消融；跨侧不稳定、不作对照结论（Phase 2 §5.5） |
| E | Minimal | Prefix + Ledger + Append-only | 7 工具 | 完整 Cache 策略消融；**账本方向性负收益（F8）**——讨论稿「本项目主力系统形态」的定位已被实测推翻，生产主线归 B |

A/B/C 回答 Context 命题，D/E 回答 Cache 命题；C/D/E 挂同一套 7 个 `review.*` 工具、schema 字节一致；A/B 零工具。

### 9.3 核心研究问题与已有答案

```text
Q1  Diff-only 会漏掉多少深度问题？        [phase2 初答：未漏——A 召回最高 0.5008；边界：VUL4J 单缺陷 MR 场景]
Q2  Symbol Context 能恢复多少？           [B 预取含符号层；归因待消融 1（去 Repo Map）分离]
Q3  Impact Context 能恢复多少？           [同上，待消融分离]
Q4  达到 Full Repo 90% 效果需要多少 Context？ [phase2 初答：命题反转——极小上下文反超全仓（B>A>C），F3/F5]
Q5  Context Ledger 能减少多少重复 Token？  [phase2 初答：负方向（F8）]
Q6  Stable Prefix 能提高多少 Cache Hit？   [phase2 初答：确定性预取 +44pp（0.3678→0.8114，A→B）]
Q7  Cache 优化能否不降质量而降成本？       [phase2 初答：B 为存在性证明——最高精度 + C 的 7% token]
```

### 9.4 对照列（Claude Code 主对照，拍板）

```text
Diff-only（A） / Minimal Context（B） / Full Context（C）
ReviewAgent（生产形态=B）
Claude Code（src/reference，ADR-0009 拍板保留；原生 Claude 系模型，
与本项目被测模型不同源——对照呈现时注明）
```

拍板说明：2026-09-18 将 Claude Code 列入主对照列（修正旧文档 v2.1「不进主判定」的姿态）——判级锚仍为配置 C（S/A/B 判据以 C 为参照原点），Claude Code 作为跨模型外部参照与主判定并列呈现，引用时注明模型不同源。

### 9.5 实验纪律

```text
模型锁定    单实验锁定单模型——多 Provider（pi-ai）是部署资产，不是实验自由度（拍板）
Effort 锁定 全实验锁定单一 effort 档位，禁止档位漂移（拍板）
Verifier    off（phase2 口径；二遍 Verifier 是消融开关，§6.3）
重复        ≥3 reps 报均值 ± 标准差；rep1 冷单列、rep2+ 热均值为主（§5.8）
预算        实验级预算以冻结的实验计划（plan.json）为准，不随架构文档调整
```

### 9.6 判定链（仪器冻结）

```text
原生真值（逆补丁行位 + 性质）
    ↓
规则粗筛（严格偏保守——phase2 实测 FP_RESCUED 269 vs TP_OVERTURNED 1，单向救回）
    ↓
LLM-as-judge（现行实例：glm-5-3-260814 走 review-llm，与被测 deepseek-v4-flash 异构）
    ↓
10% 人工抽检
```

判级：S/A/B 三级（ADR-0004，判据以配置 C 热口径为参照原点）。judge 继续走 review-llm——**变量隔离在内核侧**，pi-ai 只承担被测侧。

### 9.7 消融清单

```text
1  去掉 Repo Map              [待跑——Q2/Q3 归因分离的关键]
2  去掉 Context Ledger        [phase2 已答：负方向（F8），保留复验席位]
3  去掉 Stable Prefix         [待跑]
4  去掉 Evidence Checker      [待跑]
5  固定 Loop vs 自由 Loop     [phase2 已部分回答（F7），正式消融待跑]
6  普通 Routing vs Cache-aware Routing [待跑，部署面命题]
7  二遍 Verifier vs 单遍自证   [待跑；Verifier token 计入 CARC]
8  主力模型 vs 高能力模型（flash vs pro，高险升级增益）[待跑；生产化「模型迁移门」的增益侧]
```

目的：**证明每个架构组件到底产生了什么价值**（Benchmark 驱动原则的落点）。

### 9.8 指标体系（分口径）

```text
Quality        Recall / Precision / F1 / Acceptance（人工接受率——生产 KPI 绝对口径）
Context Eff.   Context Tokens / Context per Finding / Deep Recall per Context Token（CE/RCE 口径，ADR-0008）
Efficiency     Token / Tool Calls / Rounds / Latency
Cache          Cache Hit / Cached Token / Uncached Token / Cache Break
Cost           CARC（保守上界口径，ADR-0008）
```

核心公式：

```text
RIE  = Recall × Precision / (Total Tokens / 1K)
CARC = Uncached Input Tokens + Output Tokens + Tool Cost
      （provider 无缓存计量字段时按全输入未命中计价的保守上界）
Cache Efficiency = Cached Input Tokens / Total Input Tokens
```

分口径纪律（ADR-0008）：指标按画像 usage 能力声明分派——无缓存计量的 provider 记 Cache-Hit-Rate 为 N/A、CARC 为保守上界；**N/A ≠ 0**。RIE 与 CARC 同时作为最终优化方向。

### 9.9 Phase 2 已测结果（判级事实与警示）

主表（main 侧，judge 口径，每配置 90 单元均值；[Phase 2 主数据分析报告](../report/Phase 2 主数据分析报告.md) §5.1）：

| config | lineRecall | linePrecision | lineF1 | totalTokens | cacheHit | RIE | CaRC | rounds |
|---|---|---|---|---|---|---|---|---|
| A（零工具） | **0.5008** | 0.7232 | 0.5524 | **22.6k** | 0.3678 | **0.0242** | 18.4k | 1.01 |
| B（+确定性预取） | 0.4671 | **0.7835** | **0.5763** | 49.9k | 0.8114 | 0.0105 | 19.8k | 1 |
| C（+全仓注入） | 0.1341 | 0.6349 | 0.5712 | 706.5k | 0.9249 | 0.0014 | 105.1k | 3.3 |
| D（+自主拉取+稳定前缀） | 0.2916 | 0.7226 | 0.6257* | 178.0k | 0.7769 | 0.0055 | 60.5k | 2.32 |
| E（D+账本） | 0.2355 | 0.569 | 0.5196 | 204.6k | 0.7981 | 0.0049 | 63.1k | 2.57 |

*D 名义 F1 最高但跨侧不稳定（极差 0.1039），不作对照结论。

S/A/B 判定（三侧逐字一致）：**B=S / C=BELOW_B / A·D·E=B**。

**锚坍缩警示（引用 B=S 时的必带注记，F6）**：C 热 recall（rule 口径）main 侧仅 0.0097（rep 曲线 0.0500→0.0194→0.0000）；三侧 0.0097/0.0761/0.0515（极差 7.8 倍）。S 级 recall 门槛 = C×90% = 0.0087，任何能产出少量有效命中的配置都轻松跨过。B=S 的实证内核：**B 热召回超 C 锚 2.2–10.8 倍且 token 为其 1/14**——显著优于 C 是数据事实；但 S 档语义是「显著超越一个塌缩的锚」。C 的 BELOW_B 是协议机械判定，非工程价值贬断；其独立成立的实证面：77% 零 finding、recall 最低、成本最高。

方差引用纪律：跨 rep σ（误差棒，#36 口径）与跨侧极差（环境敏感性）分开引用；σ 小 ≠ 稳定优（C 的 σ 最小恰因产出贴地），引用须带均值。

### 9.10 双门验收协议（pi 线对照实验）

pi 重写的验收 = 双门（方法论内核无关，ADR-0007 第三轮应用）：

| 门 | 内容 | 真源 |
|---|---|---|
| **确定性纪律门** | A/B 配置请求体 vs DSH 审计 `requests[].wireBody` **逐字节一致**（字节真源已实测在位：`runs/phase2-dsh-t{1..5}/audit/**`，每条含 `model/effort/messages/tools/wireBody`）；零网络 | DSH 审计 |
| **指标对齐门** | pi 侧 450 单元重跑（同协议：30 案 × A–E × 3 reps × `deepseek-v4-flash` × verifier off × judge `glm-5-3-260814`）vs DSH 侧既有数据，按 #30 对称 max σ 带 + 配对符号检验 | `runs/phase2-dsh` |

分层纪律：A/B 字节一致（零工具配置下请求体全部由自研组装层产出，应逐字节相同）；C/D/E **语义一致而非字节一致**——工具 schema 的 wire 序列化由客户端 SDK 完成（DSH 线 = dsh-sdk-protocol，pi 线 = pi-ai），构造上不可能字节相同，这不是缺陷而是**内核效应本身**（phase2 main↔dsh 对照已确立先例）；处置：工具语义等价 + 稳定前缀纪律 + 对齐门兜底。

token 口径归一（P1 硬票）：DSH usage `{inputTokens, outputTokens, cacheReadTokens}` ↔ pi-ai usage 字段映射 + 已知记录断言。cache 命中率差异属内核效应：`cacheReadTokens` 单列口径呈现，不与质量结论混排。

**换内核与换模型同理：DSH 侧的 S/A/B 结论不自动迁移到 pi 侧，须独立跑出对照。**

---

## 10. 关键风险

| # | 风险 | 表现 | 缓解 |
|---|---|---|---|
| R1 | **Context 太少** | 深度问题漏检（recall ↓） | C0→C1→C2→C3 逐级加载；A/B 对照持续监测；消融 1 归因 |
| R2 | **Context 太多** | token ↑、延迟 ↑；极端即 C 塌缩（F5） | Zone B 预算上限 + MR 边界护栏（§7.7-1）+ 上下文重组敏感带跟踪（F9） |
| R3 | **Cache 高但质量降** | 只追命中率掩盖质量劣化 | 四效同看（Quality/Context/Cache/Efficiency）；冷热分层报告（§5.8） |
| R4 | **退化成 Mini Claude Code** | 自由探索、工具滥用、轮次失控 | 工具白名单 + 轮次预算 + 六阶段骨架代码级强制 + B 形态零工具（构造性免疫） |
| R5 | **pi 权限模型** | pi 无内置 fs/process/network/credential 权限系统，默认继承启动进程权限 | 核内只读工具（构造性保证，§6.1）+ 静态源码快照（无执行面，§7.4）；V0.3+ 部署侧容器隔离 |
| R6 | **重写引入行为漂移** | pi 侧与 DSH 数据失去可比性 | 双门验收（§9.10）：A/B 字节门 + σ 带对齐门；仪器冻结（判定链不重写） |
| R7 | **锚相对结论被误读** | B=S 被当成「达到高质量水位」 | 锚坍缩注记强制携带（F6）；生产 KPI = 绝对指标（人工接受率） |
| R8 | **fork 与上游漂移** | 越缝改动累积，同步成本失控 | 越缝三判据（§2.5）+ 分歧清单回写纪律（定制基线方案 §9） |

内核重写专属风险（R1–R7 详解、P1 冒烟项）见《Pi 内核从零实现方案》§6，不在此复述。

---

## 11. 总结

### 11.1 最终技术架构

```text
              企业内部代码托管平台（静态源码快照 / Webhook）
                                ↓
                    Review Gateway（Job / 调度 / 去重）
                                ↓
                    Review Scheduler（同仓批次调度）
                                ↓
                    Review Worker（快照落盘 / 回写）
                                ↓
        ┌───────────────────────────────────────────┐
        │ ReviewAgent（packages/review-pi，从 0 重写） │
        │  Review Runtime（六阶段 / 策略驱动器 / 预算）  │
        │  Context Engine（Zone A/B/C / 预取管线）     │
        │  Cache Engine（前缀纪律 / 命中率治理）        │
        │  Knowledge Engine（L1–L5，未启动）           │
        └───────────────────┬───────────────────────┘
                            ↓
        ┌───────────────────────────────────────────┐
        │ Pi Runtime（fork 四包，源码默认零改动）       │
        │  pi-agent-core（loop / 工具 / 状态 / 事件）  │
        │  pi-ai（统一 Provider → 企业网关）           │
        └───────────────────┬───────────────────────┘
                            ↓
                    Structured Finding
                ┌───────┼───────┐
              Check  Comment  Summary
                └───────┼───────┘
                     Developer
                        ↓  Feedback（处置落库 + 接受率 KPI）
                  Knowledge / CWD ↺
```

### 11.2 架构结论

> **`pi-agent-core + pi-ai` 作为内核，自研 Review Runtime；fork 源码默认零改动，定制只经演化缝。**

- **Pi 负责「Agent 怎么跑」**；**ReviewAgent 负责「Review 怎么做」**；**Context Engine 决定「看什么」**；**Cache Engine 决定「怎么便宜地看」**；**Evidence 纪律决定「问题是否真的成立」**。
- 生产形态是**实测拍板**的 Config B：零工具 + 确定性预取、单轮——以全仓配置 7% 的 token 取得最高精度与稳定最高 F1，缓存命中 0.81/0.88。
- 重写不是推倒重来：测量常量面（提示词 / 上下文组装 / 判定链 / 指标 / 数据集）byte / 行为一致地冻结平移；内核变量面在 pi 原语上从 0 重写；验收走双门（A/B 字节门 + σ 带对齐门）。
- 整个项目最重要的技术命题仍然是：

> ### **Minimal Sufficient Context + Cache-Stable Review Loop**
>
> 用最少的有效上下文、最少的 Agent Loop 和最少的 Uncached Token，获得接近（并在此基准上反超）Full-Context Coding Agent 的深度 Review 效果——且该效果已由 Phase 2 三侧 450 单元数据支撑，正由 P0–P5 在 pi 内核上重建同一份证据。

---

## 附：与旧文档 / 讨论稿的概念对照

| 旧（DSH 版 v2.1 / 讨论稿） | 新（本文） | 说明 |
|---|---|---|
| DSH 内核（session/system-prompt/tools/agent/agent-loop/llm 插件面） | pi fork 四包 + 演化缝 | DSH 插件挂接形态随内核移除（ADR-0009） |
| 自定义 Loop 经 `setFactory` | 策略驱动器经 pi 缝（直驱 / 钩子） | DSH 线「setFactory 无人区」教训不继承 |
| E = 主力系统形态 | **B = 生产形态**，E 归消融面 | Phase 2 实测账本负方向（F8） |
| C = 效果上限 / 质量主锚 | C = 协议判级锚（带坍缩警示） | Phase 2 §3.3/§5.4 |
| Claude Code 不进主判定 | Claude Code 列入主对照列 | 2026-09-18 拍板（判级锚仍为 C） |
| Cache Engine 主线 = Prefix + Ledger + Append-only | B 缓存主线 = **跨 MR 前缀复用**；Ledger 归消融面 | 实测修正（F8/F10） |
| V0.1 验证 Minimal Context、V0.2 验证 Cache | 已由 POC1/Phase 1/2 回答；阶梯从 P5 后起算 | §8.3 |
| （缺） | 生产集成章（Gateway/Worker/Adapter/ReviewJob）、双门验收、常量/变量面、越缝判据 | 本文新增 |

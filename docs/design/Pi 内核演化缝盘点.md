# Pi 内核演化缝盘点

> **文首说明**：本文是《[基于 Pi 内核的 Review Agent 总体架构设计方案](基于 Pi 内核的 Review Agent 总体架构设计方案.md)》§2.5「内核定制边界」的事实底座——回答「核内在 pi fork 上能改哪里、不能改哪里、什么条件下才动 fork 源码」。
> 核实方式：对 vendored 四包（锚定 `6671c604`，接线事实见《[Pi 内核定制基线方案](Pi 内核定制基线方案.md)》）的源码缝盘点，全部条目带 file:line（相对 `packages/`），2026-09-18 复核。
> 一句话结论：**核内所需的全部运行时形态（直驱流 / 钩子驱动 / 工具动态面 / 运行中插话）都能在既有缝内实现；五处缺口确认为「越缝候选」，动 fork 源码须过三条判据。**

---

## 1. 已核实的缝（file:line）

### S1 低层 agentLoop 可整体替换

- `runAgentLoop` 是导出函数（`agent/src/agent-loop.ts:96`，续跑变体 `runAgentLoopContinue:121`）——自研控制器可以不经过 `Agent` 类直接组装 loop。
- `Agent.streamFunction` 是公有可变字段（`agent/src/agent.ts:181`；构造器赋值 `:222`，消费点 `:420/:432`）——替换流函数即替换 LLM 调用路径，不动内核源码。

**核内落点**：A/B 配置（零工具）自研 controller 直驱 pi-ai stream；C/D/E 用 `Agent` + `runAgentLoop` 钩子（ADR-0009 §4）。

### S2 工具面运行时可变

- 低层：`AgentState.tools` 带 setter（`agent/src/agent.ts:81-82`，赋值拷贝顶层数组；`:258` 注释确认 `state.tools` / `state.messages` 同语义）。
- harness 层：`setTools`（`agent/src/harness/agent-harness.ts:595`、实现 `runtime/harness.ts:225`）、`setActiveTools`（`agent-harness.ts:578`、实现 `runtime/lane.ts:1692`）。
- 运行中动态增工具：`AgentToolResult.addedToolNames`（`agent/src/types.ts:370`；loop 消费 `agent-loop.ts:794`，harness 消费 `execution/tools.ts:192/:206`）——工具结果可以声明「本回合新增了哪些工具」。

### S3 transformContext 只改消息

- 低层签名：`(messages, signal) => Promise<AgentMessage[]>`（`agent/src/agent.ts:101`，公有字段 `:180`，应用点 `agent-loop.ts:288-289`）——**不含 systemPrompt、不含 tools**。
- harness 层 `transform_context` 钩子作用面更宽（请求上下文级，`harness/hooks.ts:188`、`harness/execution/assistant.ts:142-143`）。

**含义**：想按请求改工具集/系统提示词，`transformContext` 不够用——要么用 S2 的 setter，要么走 harness 钩子。

### S4 prepareNextTurn 回合间接缝

- `prepareNextTurn` / `prepareNextTurnWithContext`（`agent/src/agent.ts:109/:197`，应用点 `agent-loop.ts:177`）——回合边界注入上下文、改写下回合输入。

### S5 steer / followUp 队列（无 inject 等价物）

- 低层：`steer()` / `followUp()`（`agent/src/agent.ts:283/:288`；`:353` 明确「处理中用 steer/followUp 排队」）。
- harness 层：`agent-harness.ts:562-563`、实现 `runtime/lane.ts:1418/:1422`；驱动边界有全量/截断策略（`runtime/drive/boundary.ts:89/:111`）。

**与 DSH 对照**：pi 没有 DSH 的 inject API，但 steer/followUp 语义覆盖「运行中插话 / 接续追问」——Developer Follow-up（Reviewer Conversation）经此缝可达。

### S6 会话模型：append-only + fork 派生

- 会话条目 append-only；fork 按 branch/tree scope 从既有条目复制派生（`agent/src/harness/session/fork.ts` 全文件；策略 `fork-policy.ts`，branch tip 机制 `fork.ts:31/:76`）。
- **fork 是复制，不是重放**——没有「从事件流重放出新会话」的 API。

### S7 chord = 服务组合运行时（勘误《Pi 内核定制基线方案》§1 表述）

- chord 的实际面目：`FacetHost`（`chord/src/types.ts:247`、`chord/src/facets/host.ts`，含热重载）、`MutableReplicatedState`（`chord/src/types.ts:50`、`chord/src/services/state.ts`）、工厂 `createFacetHost` / `replicatedState`（`chord/src/api.ts:19/:88`）——**服务组合运行时（facet 装配 + 复制状态），不是「agent 的会话/状态底座」**；会话模型在 `packages/agent/src/harness/session/`（S6）。

### S8 telemetry：契约面，宿主自带实现

- 包内只有契约 + 内存实现 + 空实现 + 一致性测试（`telemetry/src/`：`index.ts` / `memory.ts` / `noop.ts` / `testing/`）——无 exporter 落盘实现，导出侧由宿主（核内审计投影）承担。

---

## 2. 五个内核缺口（越缝候选）

| # | 缺口 | 事实依据 | 核内现实处置 |
|---|---|---|---|
| G1 | 无按请求工具过滤钩子 | S3：`transformContext` 不及 tools | 变通已在缝内：`state.tools` setter（S2）；真需要 per-request 过滤时再评估 |
| G2 | harness 驱动状态机不可插拔 | `runtime/drive/` 是 harness 内部模块，无替换 API | 从 0 线不依赖 harness 驱动（A/B 直驱、C/D/E 低层 loop），风险不落在核内 |
| G3 | 条目不可变（append-only） | S6 | 与 Zone C append-only 纪律**同向**——是纪律的天然强制器，非缺陷 |
| G4 | 无重放派生会话 API | S6：fork 是复制 | 审计重放/对照需求由自研审计投影（`AuditFileContent`，含 `wireBody`）承担 |
| G5 | 无内置 telemetry exporter | S8 | 自研审计投影天然承担；不引第三方 exporter |

结论：**五个缺口没有一个阻塞 P1–P5**；G3 甚至是有利事实。它们是「越缝候选」清单——未来哪个需求撞上缺口，按 §3 判据决定是否动 fork 源码。

---

## 3. 定制姿态：分层默认 + 显式越缝判据

**默认（拍板 2026-09-18）**：核内全部经既有缝实现，不动 fork 源码——

- A/B（零工具）：自研 controller 直驱 pi-ai stream（`runAgentLoop` 可整体绕开）；
- C/D/E（七工具）：`Agent` + agentLoop 钩子（`shouldStopAfterTurn` 控轮次、`transformContext` 控消息序、`state.tools` 控工具面）。

**越缝判据**（三条全满足才改 fork 源码）：

1. **缝内确实不可达**——是「做不到」而非「不顺手」（G1–G5 之外的新需求须先给出缝内尝试的失败证据）；
2. **离线、版本化、过门**——改动在会话外完成、进版本控制、经对齐门（ADR-0007 σ 带）验证后才上线；**不做会话中自由改写内核**；
3. **分歧回写**——改动处带 fork 注释 + 回写《Pi 内核定制基线方案》§4 分歧清单（其 §9 同步约定）。

**激进自进化的落点分析**（运行时改写 loop / 工具集 / 提示词）：

- 改工具集：缝内可达（S2，运行时可变）；
- 改 loop：缝内可达（S1，`streamFunction` 可变 / `runAgentLoop` 可绕开）；
- 改提示词：受 **Zone A 字节稳定纪律**约束（测量常量面，自约束而非内核约束）——演进以 checkpoint 形态离线发生、版本化、过对齐门后切换；
- 改内核本身：**不在演进面内**。深层原则：演进层之下必须有稳定基底——基底随会话漂移，对照实验与缓存复用同时失真。

**与上游同步的关系**：缝内实现 = fork 源码零改动 = diff 面最小（定制基线方案 §4/§9）；每一次越缝都在缩小未来同步上游的自由度——这是把越缝判据定严的成本侧理由。

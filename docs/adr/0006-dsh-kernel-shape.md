# DSH 内核形态：标准 agent-loop + 策略驱动器，显式最小树

Phase 1 的内核组装方式（Round 3 定）：六阶段骨架**不**通过 `ctx.agents.setFactory` 替换 DSH 的 agent-loop，而是由核内 review-runtime 插件作为**策略驱动器**（`/goal` 模式先例）代码级强制——驱动器独占阶段指令推进权（一阶段 = 一 turn，阶段内工具循环 = turn 内 steps），`MAX_ROUNDS` 由驱动器状态控制，`MAX_TOOL_CALLS` 由 `tools/execute` 包裹层强制，Evidence Gate 在 phase-6 的 turn/end 执行 join + 跨轮去重；verdict `complete=false` 时 followup 开启下一轮。profile 采用 **sdk-minimal 式显式最小树**（不继承 dsh-base）。术语见 `CONTEXT.md`「运行时边界」。

## Considered Options

- Loop 姿态：`setFactory` 自定义 loop / **标准 agent-loop + 策略驱动器**——被选。自定义 loop 须实现整个 `Agent` 驱动面（inbox 管理、turn/step 事件、session 维护），等于重写 dsh-agent-loop 且零生产示例；驱动器路径让骨架保持代码级强制（模型无法自行推进阶段）。`setFactory` 降级为逃生门：walking skeleton 证明硬阻塞才启用。
- 组装基座：骑 dsh-base 再裁剪 / **显式最小树**——被选。dsh-base 携带 session-title-llm（额外 LLM 调用）、typert 三件套、user-questions、jobs、遥测等（`--dump-config` 实测）；Zone A 字节纪律要求组装进 prompt 的每一行都可知。行集：llm、session、session-projection、system-prompt、tools、agent、agent-loop、session-persistence-jsonl、cmdline + 核内插件（`session-projection` 为票 #18 勘误补记：dsh-agent-loop 硬注入 `sessionProjections`，两版同构，缺行则 agent-loop 不加载）。
- LLM 适配器：直接用 `dsh-llm-deepseek` / **移植 POC1 客户端为 LlmAdapter**——被选。ADR-0002 锁定语义（effort default→thinking enabled + reasoning_effort high、不发 temperature/top_p、模型白名单、usage 含 cached tokens、`review.*`→`review_*` 工具名映射）是实验契约；且**审计的可重放字节只能从持有 wire 序列化的一方采集**——adapter 捕获每次请求的精确 body，POC1 审计契约原样存活。
- A–E 参数化：插件 config 字段 / 每单元 spawn 进程 / **五 agent preset + 长驻内核进程（SDK JSON-RPC，agent-per-unit）**——被选。工具开/关是改变 Zone A 字节的组装级差异，config 字段表达不了；spawn-per-unit 在五源 × 五配置 × ≥3 重复规模下进程开销不可接受。
- 仓库结构：每插件一包 / **单包新增 `packages/review-dsh/`**（五插件 + bundle 声明 + 薄 CLI wrapper）——被选。Cordis 单包多插件是官方形态（dsh-base 即是）；wrapper 按 Python-SDK 模式 spawn 锁定版 `dsh --profile review`。

## Consequences

- Zone B 注入顺序（session-start `agent.inject()` 与首条 followup 在 claim 批内的先后）文档层无明确答案：walking skeleton 首票以捕获字节断言顺序；不可控时退路为 Zone B 并入首条 followup 消息内容（字节布局仍确定）。
- 本地 reference_project（0.1.5-alpha.1）与 npm 消费线（0.1.2-rc.1）存在文档/代码偏差，walking skeleton 负责对消费版本校验关键机制。
- `stablePrefix` 保持纯声明字段（POC1 实测无行为读取它）；DSH 原生机制（compaction seam、`ctx.toolResultPruner`、session seed/fork、`request/header` 事件）仍按 ADR-0005 后置为独立消融票。
- fake LLM 以 FakeLlmAdapter 形态注册在同一 `ctx.llm` seam；插件测试按 DSH 包测试先例进程内组装真实 Loader 树。

### 实现注记（#20 工具接线落地后补记，2026-09-10）

- **A–E 参数化的实际形态修正**：Considered Options 否决「插件 config 字段」的理由（"工具开/关是改变 Zone A 字节的组装级差异，config 字段表达不了"）已被 #20 实现修正——工具 schema 挂在请求的 `tools` 字段（Zone A 外），开关经 `ReviewPolicyConfig.toolsEnabled/ledger` 表达即可；agent-preset 的实质（每 agent 独立工具世界）由 `createAgent` 的 per-agent scoped setup + run 私有 toolkit/Ledger 保住。五 agent preset 仍是评测单元的编排形态，内核开关面收敛到政策字段。
- **MAX_TOOL_CALLS 的强制点**：正文「由 `tools/execute` 包裹层强制」在实现中为预分发 `ToolGuard`（`agentCtx.tools.guard`）——同步守卫在 JS 单线程下计数原子，语义等价（放行数 = 实际执行数，≤ 上界），且天然覆盖并行组。
- **预算拒绝的物化形态（对 ADR-0005 1:1 姿态的登记偏离）**：POC1 把超预算调用记为 `SKIPPED: <reason>` 普通消息并强制收尾该阶段；DSH 注册面把守卫拒绝物化为 `Error: <reason>` 工具错误结果（isError），阶段收尾交给模型。审计侧已对齐 POC1 契约：`toolCalls` = 实际发生数（执行 + 失败，被拒不计）、被拒调用全量留痕 `toolCallLog`、耗尽记 `truncationReasons=["TOOL_BUDGET_EXHAUSTED"]` 与发生阶段 phaseLog note；剩余不可消除的差异仅为控制流（模型自愿收尾 vs 强制收尾，可能多一次 LLM 往返）。

### 实现注记（#22 缓存纪律落地后补记，2026-09-11）

- **Consequences 首条的落锤（Zone B 注入顺序）**：多连 inject（Zone B → MR intro → 三层预取）在 0.1.2-rc.1 上按调用序进入首条 followup 的 claim 批，请求 1 布局与 POC1 逐字节对齐——正文预留的退路（Zone B 并入首条 followup）确认不需要启用（inject 机制细节与 #22 多连扩展实证见《DSH 内核机制偏差清单》§4）。注入材料由冻结 `buildPrefetchContext` 1:1 供给（`ReviewPolicyConfig.prefetch` 开关，与 `toolsEnabled` 组装期互斥：杂交形态不在 A–E 矩阵、无法诚实标注 configId）。
- **Cache Break 观测点**：run 末纯观测分类（冻结 `classifyCacheBreaks` 桥接，绝不改请求字节）；审计请求 → POC1 LlmRequest 的桥接经 `JSON.stringify(parameters)` 还原 `parametersJson`（round-trip 等价由 #20 测试锁定）。
- **usage 聚合的在场语义**：事件流 usage → `audit.usage` 直接经冻结 `addUsage` 聚合（reduce + `ZERO_USAGE`，不设 >0 门）——可选字段任一事件定义即在，含 0：「网关回报 cached_tokens: 0」是有信息量的记账，不应在内核侧被吞掉；冒烟「存在即必为正」断言由适配器 `mapUsage`（命中为 0 时不臆造零值条目）继续兜底。工具成本的计价留在核外（`audit.toolCallLog` 即账本，冻结 `computeToolCostTokens` 直接消费）。
- **configId 最小诚实化**：`deriveConfigId`（既有开关 → B/C/E/A）先行落位，#25 preset 注册表落地时收敛——审计与 runId 携带的形态标签必须与实际装配一致，D（stablePrefix）随其开关票补位。

### 实现注记（#23 Zone A 对照落地后补记，2026-09-11）

- **迁移审计的落位形态**：对照面 = DSH 审计请求（POC1 形态投影）× 冻结薄 harness 自有装配函数——Zone A 字节（`buildSystemMessage`；工具面 `buildReviewToolkit().tools`，canonical parameters 字节经 round-trip）+ 同配置路由（`DEFAULT_MODEL` / `DEFAULT_EFFORT`；路由非 Zone A 组成部分，作同配置对照的旁证位）。`zone-a-parity.test.ts` 覆盖 config A / C / E 三形态（E 的 Ledger 不入请求字节，工具 schema 与 C 同源）；`diffZoneA` 的字段敏感性由负面对照用例自动化锁定。
- **差异集登记契约**：允许类别两类（`ASSEMBLY_WRAPPING` / `TOOL_NAME_WIRE_MAPPING`），但本对照面只有组装包裹物化为键（`SYSTEM_PROMPT_BYTES[*]`），wire 映射只出现在 wire 序列化点（#19 适配器测试持有）——可登记键形态经模板字面量类型收口：工具名 / 路由 / schema 字段的漂移无键可登记，唯一出路是修实现。实际差异集当前为空；计算差异与登记差异由 `expectParity` 强制相等，出现漂移必须同变更登记（key + reason）。

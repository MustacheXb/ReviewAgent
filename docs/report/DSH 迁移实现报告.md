# DSH 迁移实现报告（Phase 1）

> **范围**：spec #17「Phase 1 DSH 迁移——以 DSH 为内核的 ReviewAgent CLI（Review Agent 阶段 1）」全部 12 张工单（#18–#29）
> **交付形态**：main 分支 15 提交（e3ef5c4…504e4d7）逐票合入——每票「提交 → 推送 → AC-by-AC 验收关单」；伞票 #17 已验收关闭
> **报告日期**：2026-09-12 · **实现周期**：2026-09-10 – 2026-09-11（2 天）

## 1. 概述

Phase 1 的目标是把 POC1 冻结薄 harness（spec #1，13 票收官）里验证过的 Review Runtime 迁到 DeepSeek Harness（DSH）内核上：核内五插件（review-policy / review-runtime / review-context / review-cache / review-evidence）挂在 sdk-minimal 式显式最小组装树，六阶段骨架由策略驱动器代码级强制，LLM 走移植的 DeepSeek 适配器（wire 请求字节即审计源），核外研究工具链（dataset / judge / metrics 聚合 / experiment runner）零改动复用；对外两张脸——`review-agent review` 单 MR 检视 CLI 与实验 runner（SDK JSON-RPC 长驻内核进程，agent-per-unit）。验收 = 确定性纪律门（fake LLM、零网络、进 CI）+ 指标对齐门（gateway 45 单元，±1σ 波动带）。

一句话结论：**迁移按 spec 全量交付**——12/12 工单关闭，双门验收一层全绿、一层门不过但归因干净：确定性纪律门 44/44 绿进 CI；指标对齐门池化 ±1σ 口径 18/20 格落带（2 OUT），七项归因证据一致指向协议固有响应非确定性（POC1 自身重跑同模式且摆幅更大）而非 DSH 运行时系统偏差——检验力问题的处置是诊断票 #30（POC1 自身重跑噪声底校准，已批准执行）。

## 2. 需求与任务结构

- **Spec**：GitHub issue #17——Problem/Solution/30 条 user stories（US1–US30）/实现与测试决策/Out of Scope；决策出处 ADR-0005（迁移姿态）、ADR-0006（内核形态）、CONTEXT.md「运行时边界」词条（核内 / 策略驱动器 / 核外）。
- **工单链**：12 张 tracer-bullet 垂直切片，按 frontier 依赖序实现：

| 工单 | 标题 | 提交 |
|---|---|---|
| #18 | DSH 内核 walking skeleton——config A 六阶段检视会话进程内跑通 | `e3ef5c4` |
| #19 | DeepSeek 适配器移植 + wire 字节捕获 | `8c4a422` / `ef7cb69` |
| #20 | 核内工具层——7 个 review.* 工具 + Context Ledger + 预算守卫 | `1b8dc3e` / `681c5d6` / `12cfaad` |
| #21 | 多轮驱动 + Evidence Gate 跨轮去重 | `70a48a4` |
| #22 | 缓存纪律层——Zone B 注入 + usage/工具成本记账 + Cache Break 归因 | `971522c` |
| #23 | Zone A 迁移审计——DSH 组装 × 冻结 harness 同配置对照，差异集显式登记 | `5dab590` |
| #24 | 审计导出适配器完整化——POC1 全字段 + wire 合并 + 重放校验 + 读取端回归 | `c02760b` |
| #25 | A–E 五 preset——配置语义复刻 | `3dff977` |
| #26 | CLI wrapper——review-agent review 单 MR 检视 | `d3417af` |
| #27 | 实验 runner 接 DSH 内核——SDK JSON-RPC 长驻进程 + agent-per-unit | `1aa9c6e` |
| #28 | 确定性纪律门进 CI——具名 gate 套件 + 零网络强制 | `74c9f22` |
| #29 | 指标对齐门——真实网关 45 单元重跑 + 对照报告 + 进程边界修复 | `504e4d7` |

- **实现模式**：逐票「探索 → 设计 → TDD（RED→GREEN）→ 双套件验证（包级 + 根级 + typecheck）→ ADR 实现注记 → 两轴 code-review（Standards + Spec 并行子代理）→ 修复批 → 再验证 → 合入 main → AC 验收关单」。

## 3. 架构决策（ADR）

| ADR | 决策 | 一句话理由 |
|---|---|---|
| [0005](../adr/0005-dsh-migration-stance.md) | 迁移姿态：核内插件化、薄 harness 冻结、1:1 迁移、npm 版本锁定、两层验收门 | 产品 CLI 与实验平台若各自为政必然双运行时分叉；同时换运行时与机制则指标变化无法归因；正式 benchmark 继续跑冻结 harness 保可复现 |
| [0006](../adr/0006-dsh-kernel-shape.md) | 内核形态：标准 agent-loop + 策略驱动器，显式最小树 | `setFactory` 等于重写 agent-loop 且零生产示例；dsh-base 携带 session-title-llm / 遥测等组装件，与 Zone A 字节纪律冲突 |

**实现注记驱动的形态修正**（正文结论 vs 实测落点，详见 ADR-0006 各票注记）：

- npm 消费线（0.1.2-rc.1）无 `dsh` 二进制 → CLI 为 node 进程直跑锁定版 review profile（「spawn 锁定版」的字面形态被实测修正，版本锁定语义不变）；
- SDK jsonrpc-server 的 session/prompt 脸与策略驱动器正面冲突 → kernel-host 改为**协议层桥接**（`JsonRpcLineTransport` 直暴露 `review/run` + `shutdown`，wire 层 100% SDK 件）；
- 「工具开/关是组装级差异、config 字段表达不了」被实测推翻——工具 schema 挂请求 `tools` 字段（Zone A 外），开关收敛到 `ReviewPolicyConfig` 政策字段，五 agent preset 仍是评测单元编排形态；
- `MAX_TOOL_CALLS` 强制点 = 预分发 `ToolGuard`（同步守卫，语义等价）；
- 预算拒绝物化为 `Error:` 工具错误结果（POC1 为 `SKIPPED:` 消息 + 强制收尾）——对 ADR-0005 1:1 姿态的**登记偏离**，审计侧已对齐 POC1 契约（被拒不计 `toolCalls`、全量留痕 `toolCallLog`、耗尽记 `truncationReasons`）。

## 4. 核心交付

### 4.1 内核形态：五插件 + 显式最小树 + 策略驱动器（#18 / #21）

显式最小树（不继承 dsh-base）挂五插件；review-runtime 作为策略驱动器**代码级强制**六阶段骨架——驱动器独占阶段指令推进权（一阶段 = 一 turn，阶段内工具循环 = turn 内 steps），模型无法自行推进阶段。轮循环 `1..MAX_ROUNDS`（冻结常量硬上界），每轮第六阶段 turn/end 边界执行 Evidence Gate（join + `emittedIds` 跨轮去重，`DUPLICATE_ID` 拒绝）；verdict `complete=false` → 下一轮，耗尽 → `truncated=true` + `TRUNCATION_MAX_ROUNDS`，与 POC1 `runReviewLoop` 语义 1:1。`Finding` / `CandidateRejection` / `RejectionStage` 经 type-only import 冻结 POC1 contracts——契约复用从形状巧合升级为编译期保证。

### 4.2 DeepSeek 适配器移植 + wire 字节捕获（#19）

POC1 DeepSeek 客户端移植为 DSH `LlmAdapter`，ADR-0002 语义逐项保留（effort 映射、不发 temperature/top_p、模型白名单、usage 含 cached tokens、`review.*`→`review_*` 工具名 wire 映射）。适配器在 wire 序列化处捕获每次请求的精确 body——**审计的可重放字节只能来自持有序列化的一方**。`FakeLlmAdapter` 注册同一 `ctx.llm` seam（可脚本化回复 + 请求捕获），纪律门进程内零网络。网关 usage 双读（`prompt_tokens_details.cached_tokens` 回退）随移植保留，冒烟断言按网关侧环境行为修正（「存在即必为正」）。

### 4.3 核内工具层：7 工具 + Context Ledger + 预算守卫（#20）

7 个 `review.*` 工具（get_diff / get_file / get_symbol / find_references / get_call_chain / search_rule / search_history）经 DSH 工具注册面 1:1 移植，内部复用既有零构建 codeintel 库（ADR-0003）；Context Ledger 已取上下文账本（`Already loaded: ctx#NNN` 去重前缀，喂核外 dedup 统计）；预算守卫预分发 `ToolGuard` 强制 `MAX_TOOL_CALLS`，拒绝物化 + 审计留痕（见 §3 末条）。评审修复批对齐 POC1 `toolCalls` = 实际发生数语义。

### 4.4 缓存纪律与 Zone A 对照（#22 / #23）

Zone B + 三层预取消息由冻结 `buildPrefetchContext` 1:1 供给，多连 inject 按调用序进入首条 followup claim 批——请求 1 布局与 POC1 逐字节对齐（ADR-0006 Consequences 预留的退路确认不需要）；无变更重跑零 Cache Break（两次独立运行全部请求 JSON 序列化逐字节相等）；usage 聚合经冻结 `addUsage`（可选字段「定义即在」，含 0）；Cache Break 观测经冻结 `classifyCacheBreaks` 纯观测桥接。Zone A 对照面 = DSH 组装 × 冻结 harness 自有装配函数，`diffZoneA` 差异集登记契约（允许类别 `ASSEMBLY_WRAPPING` / `TOOL_NAME_WIRE_MAPPING`，键形态经模板字面量类型收口）——**实际差异集为空**，计算差异与登记差异由 `expectParity` 强制相等。

### 4.5 A–E 参数化与审计导出（#25 / #24）

A–E 真源 = 冻结 `CONFIGS`（spec #1）：`REVIEW_PRESETS` 注册表逐字段对照测试锁定，`deriveConfigId` 逐字段遍历回环；组装期 pairwise 互斥（工具×全仓×预取杂交形态 fail fast）。config C 全仓注入复用冻结 `buildFullRepoInjection`（注入位次 = MR intro 之后，RepoContext 与 `get_file` 同源）；D/E 的 `stablePrefix` 纯声明开关诚实标注。审计导出 1:1 经冻结件（`buildAuditFileContent` + `toPoc1RunResult`），请求级 `wireBody` 扩展为 DSH 侧唯一增量（POC1 读取端按结构化消费、扩展被忽略）；wire 反解命名约定（单点号 + snake_case，只还原首个下划线）由重放校验 fail fast 兜底——「核外工具链零改动」升级为类型即契约。

### 4.6 两张脸：CLI wrapper + 实验 runner（#26 / #27）

- **CLI**：`review-agent review --repo --mr [--config]`——node 直跑锁定版 review profile，薄 wrapper（解析 → env 凭据 → 装配 → run → 导出 → stdout 单 JSON 文档 → 退出码：完成含诚实截断 0 / 中止错误 1）；烟测以 `DEEPSEEK_URL` 指本地 stub 端点驱动真实适配器代码路径，外网零依赖，凭据哨兵断言不落日志。
- **实验 runner**：kernel-host 长驻进程（SDK JSON-RPC wire，协议层桥接），每 `review/run` = 全新 Context + preset 切换，agent-per-unit；失败单元 -32603 错误帧隔离、进程存活；runner 侧 `executeUnit` 单分支接入（`deps.dshKernel`），composeRecord / RunStore / metrics / dashboard 全链零改动；模型门启动即校验 `plan.model === DEFAULT_MODEL`。根 e2e 以 6 单元经单一 host 进程跑通 `runExperiment` → 报告/dashboard，FakeLlmClient 注入作隐式变异护栏。

### 4.7 双门验收（#28 / #29）

- **确定性纪律门**：`vitest.gate.config.ts` 按「五族断言 → 入选文件」收口 9 件测试（Zone A 字节稳定 / 零 Cache Break / 审计可重放 / 六阶段骨架与两上界 / Evidence Gate，presets 覆盖 A–E），全部从主缝观测；零网络强制落 `Socket#connect` + `globalThis.fetch` 双点（不放行 loopback）；CI 具名 job `discipline-gate` 直跑 44/44 绿，RED/GREEN 对即变异证据。
- **指标对齐门**：单单元冒烟（VUL4J-38/D，与 POC1 同单元结构同构）→ 45 单元全量真实网关重跑 → 池化 ±1σ 判定 + 七项归因链。真实网关冒烟揭出三个进程边界缺陷（bin 上溯定位 / EPIPE 容错 / 真实 API 级 turn 预算 900s）并全数修复；Windows libuv teardown 竞争以优雅退出（`exitGracefully`：排干 + 自毁 stdin + 8s 兜底）收口，复现循环验证 54/54。

## 5. 实现规模

- **`packages/review-dsh/`**：25 src 文件（3,502 行）+ 24 测试文件（4,365 行）；域目录 plugins / loop / llm / context / presets / profile / audit / cli / kernel-host / process；两个 bin（`review-agent` / `review-kernel-host`，各自独立编译树）。
- **根 harness 增量**：3 文件 +327/−12 行——`--kernel` 旗标（缺省 `poc1`）+ runner `dshKernel` 可选依赖分支，POC1 执行路径零行为变更（#30 重跑以此 diff 佐证冻结态）。
- **冻结复用件**：POC1 contracts（finding / run / llm-client）、零构建 codeintel、prefetch / fullRepo 消息构造、SYSTEM_PROMPT、metrics 管线（`evaluateRun` / `flattenRunMetrics` / `summarizeDefined`）、判定链与 dashboard——1:1 迁移纪律下核外件全部直接复用。

## 6. 质量保障

- **主缝纪律**：全部验收断言从内核公共脸观测（fake 适配器捕获的请求字节 / 导出审计与结果对象），不窥探 DSH 内部状态、插件私有结构或驱动器内部变量。
- **两轴 code-review**（Standards + Spec 并行子代理）逐票执行，发现全部修复（如 #20 `toolCalls` 语义、#22 注入布局断言、#29 冒烟 cached 断言）。
- **测试边界硬化**：满套件并行负载下重测试显式超时（30s/60s，repo 既有第三参惯例）——#29 满套件复现默认 5s testTimeout / 10s hookTimeout 掐死双运行全仓扫描与完整实验夹具。
- **竞争类缺陷的验证边界**（如实声明）：EPIPE 容错与优雅退出无确定性单测（按 ~2/54 失败率设计的竞争写「稳定红」不可得）——行为契约由进程级测试锁定，竞争本身以复现循环验证（修复前 2/54 崩 → 修复后 54/54 干净）。

## 7. 交付与验证状态

- **最终验证**：包级 146 passed + 1 skipped（typecheck 干净）；根级 1029/1029（typecheck 干净）。
- **CI**：`discipline-gate`（具名纪律门 44/44，零网络强制）+ `suites`（两包 typecheck + 全量测试）并行 job；进程级烟测留 suites 轴；真实 API 路径（test:e2e / 冒烟 / 对齐门）不进 CI。
- **票面状态**：#18–#29 全部 AC-by-AC 验收关闭；伞票 #17 spec 完成关闭（12/12 交付 + 双门结果 + 开放后续登记）。

## 8. 指标对齐门结论摘要（#29）

- **判定：门不过**（池化 per-config ±1σ，n=9 per config）：18/20 格落带，2 OUT——C/linePrecision（基线 n=2 统计无效）、C/cacheHitRate（0.9312±0.0142 → 0.8766±0.0803）。
- **归因链（七项证据）**：① 请求 1 逐字节一致（8,280B），分歧始于模型响应；② POC1 自身 38 对同单元双审计（同 harness 同日）呈同模式；③ 14 对结构匹配完整对摆幅 findings 0↔3、输出 token 至 5.9×；④ 自门检验：POC1 自身 28 次完整重试过自身 ±1σ 带，totalTokens 11/28 出带——带宽窄于协议固有重跑方差；⑤ rounds 混合比位移（多轮单元 17→6）驱动 token/cache 双向偏移；⑥ DSH toolCalls 分布与 POC1 结构一致（工具层忠实）；⑦ turn 超时单点失败另行归因（网关 stall，防御性护栏，非运行时偏差）。
- **token 总账**：DSH 8,749,984 = POC1 11,287,939 的 **0.78×**（逐单元对账校验一致）。
- 完整对照表、稳健性参照口径与环境锁定见《[DSH 指标对齐门报告](./DSH%20指标对齐门报告.md)》。

## 9. 遗留事项与下一步

- **#30（已批准执行中）**：±1σ 门检验力校准——冻结 POC1 harness 以全新实验 id `poc1-vul4j-gateway-r2` 重跑同 45 单元（2026-09-12 启动，网关与 key 沿用），产出 run2-vs-run1 池化自门 OUT 率，对照 #29 的 DSH-vs-POC1 OUT 率（18/20 IN），给出门协议修订建议（样本量 / 判定口径 / 噪声底扣除）。
- **后置消融票**（spec Out of Scope 登记）：DSH 原生机制采用——compaction seam / `ctx.toolResultPruner` / session seed-fork / request-header 事件，每票带 before/after 指标。
- **Phase 2+**：策略改进的受控对比自此可在 DSH 内核上进行（实验面 runner 已接内核）；对齐门结论落定后另议冻结薄 harness 删除。
- review-knowledge 插件（知识引擎）属 Phase 4；AACR-Bench 公开评测接入为独立线程。

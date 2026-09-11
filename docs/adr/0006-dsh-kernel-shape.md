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

### 实现注记（#21 多轮驱动 + Evidence Gate 跨轮去重落地后补记，2026-09-11）

- **轮次驱动的实现形态**：驱动器轮循环 `1..MAX_ROUNDS`（冻结常量直引，硬上界不可配置——「单次检视成本有界」是骨架约束），轮 = 一次完整六阶段推进；turn 序号按轮基推导（轮基 + 阶段偏移，session 计数器跨轮连续），phaseLog 条目携带实际轮号（轮循环变量）。每轮第六阶段 `turn/end` + `whenIdle` 边界（serial）执行本轮 Evidence Gate——join 用本轮候选 × 本轮裁决，`emittedIds` 经 Gate 输出跨轮携带（后续轮重提已发出的 id → `DUPLICATE_ID` 拒绝）；verdict `complete=false` → 下一轮，耗尽 → `truncated=true` + `TRUNCATION_MAX_ROUNDS`（"MAX_ROUNDS_REACHED"），与 POC1 `runReviewLoop` 语义 1:1（`truncated = !complete`；预算耗尽只追加 reason 不翻转 truncated）。
- **契约的编译期收口**：`Finding` / `CandidateRejection` / `RejectionStage` 不再在核内重声明，type-only import 冻结 contracts（`src/contracts/finding.ts` / `run.ts`）——「直接复用现有 contracts」从形状巧合升级为编译期保证，漂移即报错。
- **事件流可验证性的落位**：Gate 不注册新内核事件——边界行为经既有可观测面验证（turn/end 序列恰好 2 轮 × 6 turn 全 completed、round-2 首请求携带 round-1 全部历史、审计 rounds / phaseLog / rejections），测试不窥探内核内部状态。
- **phaseLog note 落位的 POC1 对齐**：candidates 解析 note 落 Deep Reasoning 条目、verification note 落 Evidence Verification 条目（先前单轮形态把两者合并落 verification 条目——随按轮解析修正为逐条目同位）。上界截断测试用 fake 适配器的 `fallback` 步（脚本耗尽后持续供给「永不完成」回复）驱动 5 轮耗尽路径。

### 实现注记（#25 A–E 五 preset 落地后补记，2026-09-11）

- **矩阵真源与收口点**：A–E 配置表的真源 = 冻结 `CONFIGS`（spec #1）；`REVIEW_PRESETS` 注册表逐字段对照它测试锁定，`deriveConfigId` 逐字段遍历它回环 configId。收口点在 review-policy 组装期（pairwise 互斥规则保留原消息，矩阵检查兜住其余组合：裸工具、无工具全仓、无工具前缀、C/D 杂交）——`deriveConfigId` 在 review-runtime 的审计侧只做推导不再自带分支逻辑（#22 的最小诚实化实现退役）。
- **config C 的全仓注入形态**：`buildFullRepoInjection` 冻结复用（80k 预算不可覆盖），注入位次 = MR intro 之后（POC1 `buildInitialMessages` 布局）；RepoContext 经 toolkit `options.repo` 共享（一次加载，注入字节与 `get_file` 读取同源——POC1 run-review 同构）。`RunAudit.fullRepo` 记账字段随票补齐。
- **stablePrefix 的诚实标注**：D/E 的 `stablePrefix` 是纯声明开关（服务面与审计 configId 可标注，行为零读取）——#22 注记预告的「D 随其开关票补位」落位；DSH 原生前缀机制仍按 ADR-0005 后置。

### 实现注记（#24 审计导出适配器落地后补记，2026-09-11）

- **导出零漂移的形态**：`AuditFileContent` / `RunResult` 的组装 1:1 经冻结件（`buildAuditFileContent`；`toPoc1RunResult` 只重排 DSH 审计字段，不新造语义）；请求投影复用 review-runtime 的 `toPoc1Request`（单一来源，#22 注记预告的 parametersJson 桥接随之收敛到该函数）。DSH 侧唯一增量 = 请求级 `wireBody` 扩展（真实适配器序列化点原文），POC1 读取端按结构化字段消费、扩展被忽略——「核外工具链零改动」从形状巧合升级为类型即契约（DSH 导出可直接装填 POC1 `AuditFileContent`）。
- **wire 反解的命名约定**：wire.ts 的正映射 `toWireToolName`（点号→下划线）是不可逆折叠；反解按内核工具名约定（单点号命名空间 + snake_case 后缀，如 `review.get_diff`）只还原**首个**下划线。约定被破坏（多级点号名）时往返不等，由 `replayAuditRequest` 的 wire↔结构化逐字段对照 fail fast 兜底——重放的「重建」半边（从 wire 字节独立重建）与「校验」半边（强制等价）互为锚点。
- **phaseLog 阶段名与 configId 的收窄**：DSH `PhaseLogEntry.phase` 为 string，导出时收窄为 POC1 `ReviewPhase` 六名之一（未知名 fail fast）；configId 收窄为 A–E（`"claude-code"` 核外参照标签出现在内核审计即装配事故）——内核矩阵收口（#25）在导出边界再守一道。

### 实现注记（#26 CLI wrapper 落地后补记，2026-09-11）

- **「spawn 锁定版」的落地形态**：Considered Options 末行「wrapper 按 Python-SDK 模式 spawn 锁定版 `dsh --profile review`」已被 #26 实现修正——npm 消费线无 `dsh` 二进制，CLI 是 node 进程直跑锁定版 review profile（`assembleReviewProfile` 复用，版本锁定 = 包依赖 pin），进程先例 = repo 既有「tsc → .tmp-gen → node」脚本模式。编译产物必须落**包内** `.tmp-gen`（镜像 repo 根相对结构）：node_modules 解析自产物位置上溯，落根级目录会找不到 `@deepseek-ai/*`（pnpm workspace 的包级依赖隔离）。
- **产品面命令的成真形态**：`bin/review-agent.js`——在位检查（缺席则按 `tsconfig.cli.json` 编译，编译旗标单一来源）+ argv 透传 + 退出码透传，零行为逻辑；调用形态 = `pnpm --filter review-dsh cli review …`（script 落 bin）或 bin 直跑。用法文案宣告的 `review-agent review` 由此成为可敲出的命令（非仅 npm script 别名）。
- **退出码契约的边界**：「完成」= 产出结果与审计——**含诚实截断**（`truncated` 是 POC1 record 语义的收敛标注，进入指标管线而非失败；完整性信号在 stdout 顶层 `truncated` 字段）→ 0；中止或错误（进程异常、用法、凭据缺失）→ 1。截断路径（verdict 永不 complete，脚本耗尽后 stub 持续供给 fallback 回复——镜像 fake 适配器为上界截断预留的形态）由烟测锁定：退出码 0 + `truncated=true` + `rounds=5` + 审计 30 请求（5 轮 × 6 阶段）。
- **烟测的零网络真路径**：spawn 产品面 bin（编译与运行都是真路径），不注入 fetchFn（wrapper 无测试钩子，AC4 薄度），以 `DEEPSEEK_URL` 指向本地 127.0.0.1 stub 端点驱动**真实适配器代码路径**（wire 序列化、重试、usage 映射全真），外网零依赖；凭据不落日志以哨兵 key 断言（stdout/stderr 全文不含）。
- **薄度的落位**：main.ts 只胶水（解析 → env 凭据适配器 → 装配 → run → 导出 → stdout 呈现 → 退出码），参数/呈现契约在 args.ts / render.ts 进程内锁定，检视行为本体全部在内核（已测）。caseId 派生（--mr 文件名去扩展名）落位 args.ts 解析缝（契约测试锁定，wrapper 不自带身份政策）；重复旗标与「值吞旗标」在解析层 fail fast；cmdline 行的 `requestedExitCode`（若曾请求）由 wrapper 消费。stdout 单 JSON 文档形状（`ReviewOutcome` 经 `Pick<AuditFileContent, …>` 锚定字段名，审计字段漂移即编译错）由进程级烟测锁定。

### 实现注记（#27 实验 runner 接内核落地后补记，2026-09-11）

- **长驻进程的进程边界取舍**：SDK jsonrpc-server 的 session/prompt 脸为每个 sessionId 另建走自由 agent-loop 的 agent，与策略驱动器（代码级强制六阶段）正面冲突——host 改为**协议层桥接**：直接在 sdk-protocol 的 `JsonRpcLineTransport` 上暴露 `review/run` + `shutdown`。sdk-client 的通用进程构造器（`dshBin` 走包清单版本门）不在公开导出面，进程管理自持（spawn + 「协议 shutdown（有界）→ stdin EOF → SIGTERM → SIGKILL」阶梯），wire 层仍 100% SDK 件。
- **agent-per-unit 的兑现形态**：不新增 agent 管理——review-runtime 驱动器 per-run `createAgent` 即天然 agent-per-unit；host 每 review/run 请求 = 全新 `Context` + `assembleReviewProfile`（profile-per-run，与 CLI wrapper 同款），reviewCache / 工具预算 / Ledger 均请求私有；失败单元经 -32603 错误帧回报、进程存活（与实验运行器的失败隔离对齐）。config 经请求参数逐单元切 preset（`REVIEW_PRESETS` 真源）。
- **同构的接缝**：host 返回 `{...toPoc1RunResult(result), auditPath}`（#24 导出件的直接消费），runner 侧 `executeUnit` 以 `deps.dshKernel` 分支接入后 composeRecord / RunStore / metrics / dashboard 全链零改动；审计由 host 落盘、auditPath 随响应回传（驱动器进程边界校验字段形状与 configId ∈ 已知集合）。核外工具链（dataset / judge / sampling / calibration / Verifier）零改动——Verifier 仍走 POC1 `llmClient`。
- **模型门**：内核策略路由锁死 deepseek-v4-flash（ReviewPolicyService），请求不携带模型——runner 在 `dshKernel` 在场时启动即校验 `plan.model === DEFAULT_MODEL`（先过 v4-pro 既有 highRiskOnly 护栏，再由本门接住），防「计划以为跑 pro、内核实际跑 flash」的口径漂移。
- **测试轴的三层**：裸 wire 测试手写 JSON-RPC 行直打 host bin（协议契约独立于任何 SDK 消费端件）；驱动器测试覆盖 config A 全链路（审计 wireBody + sessions 树）、同进程 preset 切换 A→B（B 带预取留痕）、错误帧隔离、凭据缺失 fail fast；根 e2e 以 3 case × A,B × rep1 = 6 单元经单一 host 进程跑 `runExperiment` → 报告 / dashboard，`llmClient` 注入空脚本 FakeLlmClient 作**隐式变异护栏**（DSH 分支若翻回 runReview 即烧穿）。共享夹具（六阶段剧本 + stub HTTP 端点）提升 root `tests/helpers/`，包测试按既有 4 级方向引用。
- **bin 形态与编译树隔离**：`bin/review-kernel-host.js` 与 review-agent 同款（在位检查 + 按需编译 + 透传），但编译树独立 `.tmp-gen-host`（`tsconfig.kernel-host.json` 单源）——vitest 并行 worker 下 cli-smoke 的 beforeAll `rm .tmp-gen` 不会与 host 的按需编译竞争。

### 实现注记（#28 确定性纪律门进 CI 落地后补记，2026-09-11）

- **门的形态：具名 vitest 配置而非新测试**：Ticket 1–8 途中积累的迁移验收断言不新造——`vitest.gate.config.ts` 按「五族断言 → 入选文件」映射收口 9 件测试（8 件既有 + 1 件本票新增的零网络自检 net-guard；Zone A 字节稳定 / 无变更零 Cache Break / 审计可重放 / 六阶段骨架与两上界 / Evidence Gate 生效，presets 件覆盖 A–E 全配置），全部断言从主缝观测（fake 适配器捕获的请求字节 / 导出审计与结果对象（Finding、phaseLog）），与既有「不窥探内核内部状态」纪律同源。门经 `pnpm --filter review-dsh gate:discipline` 运行，CI 具名 job `discipline-gate` 直跑。
- **零网络强制的收口点**：进程内出站拦截落在 `Socket#connect`（net.connect / createConnection / http(s).request / undici 建连的共同咽喉）+ `globalThis.fetch` 双点——不放行 loopback（门内断言全 fake LLM，连产品面烟测的 127.0.0.1 stub 形态都不需要）。收口范围如实声明：TCP 建连 + fetch 两条主出站路径，dgram（UDP）等非 TCP 通道不在内（门内测试形态不涉及）。拦截同时是「断网模拟」与「断言放大器」：入选测试若意外依赖网络，会以 net-guard 锁定的错误形态当场变红。`http.request` 对 IP 字面量在 Node 24 上于调用内**同步**建连（拦截错误同步冒出而非 error 事件）——自检断言兼容两种表现，跨 CI Node 22 / 本地 24 成立。
- **gate 自检与常规套件的分轴**：`tests/gate/net-guard.test.ts` 断言的是门环境不变量（出站被拦截），只在 gate 配置的 setupFiles 之上有意义——包常规 vitest 配置显式排除 `tests/gate/**`（无拦截环境必然红，非坏测试）。RED/GREEN 对即变异证据：无拦截跑门 → 3 项自检以真实网络错误（ECONNREFUSED）变红；挂拦截 → 44/44 绿（41 项纪律断言在拦截下照常绿 = 其天然零网络的运行时证明）。
- **CI 两层门**：`discipline-gate`（具名纪律门，拦截下 9 件套）+ `suites`（全量回归：两包 typecheck + 两包测试）并行 job；进程级烟测（cli-smoke / kernel-host 的 loopback stub）留在 suites 轴——既定零网络形态，不属进程内拦截之列。真实 API 路径（test:e2e / deepseek-smoke env 门控冒烟、#29 指标对齐门）不进 CI。

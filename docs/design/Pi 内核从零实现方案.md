# Pi 内核从零实现方案——Review Runtime 重写与 DSH 口径对齐评测

> **文首说明**：2026-09-18 拍板——**Review Runtime 在 pi fork 上从 0 重写（现有实现代码不导入，仅作行为参照与期望生成器）；评测装置（判定链 / 指标 / 数据集 / 双门协议）冻结平移复用；最终评测与 DSH 内核数据（`runs/phase2-dsh`，450 单元）按同口径对照**。决策记录见 [ADR-0009](../adr/0009-pi-kernel-from-scratch-rewrites-review-runtime.md)；决策背景（用户自存外部分析）见同目录《[pi 内核可行性分析](pi 内核可行性分析.md)》（结论 Pi-first：`pi-agent-core` + `pi-ai` 为内核、自研 Review Runtime，DSH 降级为 Runtime Benchmark 对照——本方案即该结论的落地）。
> 文档链：《[ReviewAgent以DSH内核和PI内核的方案对比分析](ReviewAgent以DSH内核和PI内核的方案对比分析.md)》→《[Pi 内核定制基线方案](Pi 内核定制基线方案.md)》（fork 接线事实，仍有效）→ 本文（从 0 实现方案与对照实验设计）→《[Pi 内核演化缝盘点](Pi 内核演化缝盘点.md)》（内核可改面 file:line 事实）→《[基于 Pi 内核的 Review Agent 总体架构设计方案](基于 Pi 内核的 Review Agent 总体架构设计方案.md)》（spec 真源，承接本文 §4 的原语映射并给出全系统架构）。
> DSH 内核（`packages/review-dsh`）已按本方案移除；全部评测数据、报告、ADR 与偏差清单保留。
>
> **一句话结论**：从 0 面 ≈ 6k 行内核（在 pi 原语上重写为 `packages/review-pi`），仪器面 ≈ 10k 行平移冻结；可行性判定为**高**——pi 原语面（agent-loop 钩子 / `Model.baseUrl` / `onPayload` wire 捕获）与字节真源（DSH 审计 `requests[].wireBody`）均已逐项实测确认。

---

## 1. 拍板结论（2026-09-18）

| 决策点 | 结论 |
|---|---|
| 实现基座 | pi fork 四包（`packages/{ai,agent,chord,telemetry}`，锚定 `6671c604`，接线与验证事实见《Pi 内核定制基线方案》） |
| 从 0 边界 | **Review Runtime 从 0 重写**（loop 组装 / 上下文组装 / `review.*` 工具 / 审计投影 / CLI）；**评测装置冻结平移**（判定链 / 指标 / 人工抽检 / 校准 / 数据集物化 / 实验 runner / 对齐门） |
| 现有代码 | 不导入，仅作行为参照与期望生成器；runtime 模块在 P2 字节门绿、P4 runner 接缝切换后退役（§3.3） |
| Claude Code 外部参照 | **保留**（`src/reference`，测量装置一部分） |
| DSH 内核 | 移除（`packages/review-dsh` + `--kernel` 缝 + SDK 依赖 + CI discipline-gate）；评测数据 / 报告 / ADR / 偏差清单全部保留 |
| 评测口径 | 与 `runs/phase2-dsh` 逐字段一致（§5）；对照实验 = pi 侧 450 单元重跑 + DSH↔pi 指标对齐门（#30 对称 max σ 带） |
| 仪器栈 | judge 链继续走 review-llm（仪器冻结，把变量隔离在内核侧）；被测侧 LLM 客户端 = pi-ai |
| 决策背景文档 | 《pi 内核可行性分析.md》入库（本文档链的一环） |

## 2. 从 0 的边界：测量常量面与内核变量面

对照实验「Harness 影响效果还是 Review 枪构影响效果」成立的前提，是把系统切成两半（外部分析 §20 的原话：「相同 Review Strategy / Context / Model 条件下，比较 Quality / Token / Cache / Latency」）：

```text
测量常量面（byte/行为一致，不许漂移）        内核变量面（被比较量，从 0 重写）
─────────────────────────────────────  ─────────────────────────────────────
Zone A 系统提示词 / Zone B 仓库结构图        Agent 状态与事件模型
MR 呈现 / 预取管线输出（config B）           工具调用协议与 wire 序列化
六阶段 Review Loop 语义                     LLM 客户端（pi-ai 取代双客户端）
Finding/Evidence 契约与各纪律门              会话 / 审计投影机制
判定链（四层 + glm-5.3 + S/A/B）            前缀组装与缓存命中的实现路径
指标公式（CE/RCE/RIE/CARC）与 RunRecord
数据集（30 案 VUL4J + 物化仓）
```

「从 0」作用于右列：用 pi 原语重写。左列是测量契约：**A/B 配置下要求字节一致（§5.2），判定链与指标要求行为一致（仪器冻结）**。左列的实现源码（`src/` 运行时模块）在新实现稳定前同时充当期望生成器，P2 门绿后退役。

## 3. 资产盘点与退役计划

### 3.1 复用（零改动或纯迁移）

| 资产 | 现状 | 动作 |
|---|---|---|
| pi 四包 fork | 本分支已接线、构建链全绿（基线提交 `e91616e`） | 零动作（内核基座） |
| `reference_project/pi` | 已拉取，锚定 `6671c604`（2026-09-16） | 零动作（只读参照） |
| `data/`（30 案 VUL4J 清单 + 物化脚本） | 本仓在位 | 零动作；`.cache/datasets` 物化仓从主工作仓拷入（§9） |
| 设计文档 / ADR / 报告 / CONTEXT.md | 本仓在位 | = 从 0 实现的 spec 真源 |
| phase2 评测数据（main / noise / dsh 三侧 + audit 真源） | ✅ 已迁入本仓（2026-09-18，§9 执行注记） | 原在主工作仓 `D:\xubao\code\AI4SE\ReviewAgent\runs\phase2-*` |

### 3.2 冻结平移（仪器面，约 10k 行）

| 模块 | 非测试行数 | 角色 |
|---|---:|---|
| `src/judge` | 2077 | 判定链 LLM judge（走 review-llm） |
| `src/metrics` | 2351 | 指标 / 对齐门复算 |
| `src/dataset` | 4471 | 数据集装载与物化 |
| `src/experiment` | 3376 | runner / plan / report / CLI（P4 加 pi 执行缝） |
| `src/sampling` + `src/calibration` + `src/gate` | 1447 | 人工抽检 / 校准 / 门 |
| `src/reference` | 2457 | Claude Code 外部参照（拍板保留） |
| `packages/review-llm` | 763 | judge 仪器客户端 + 画像 / 退役清单单源 |

重写仪器的科学增益为零、判定漂移风险为正——这是「仪器冻结」的理由。

### 3.3 从 0 重写（内核变量面，约 6k 行 + 1k 集成）

| 现模块（参照） | 非测试行数 | 重写落点 |
|---|---:|---|
| `src/loop` + `src/run` | 1279 | `packages/review-pi`：Review Runtime 控制器（六阶段骨架） |
| `src/zoneb` + `src/codeintel` | 1842 | 确定性上下文组装（Zone A/B、预取管线、零构建符号索引） |
| `src/tools` | 1114 | `review.*` 七工具（pi-agent-core 工具注册） |
| `src/contracts` + `src/finding` + `src/audit` + `src/shared` | 1241 | 契约平移语义、审计投影（装 POC1 `AuditFileContent`） |
| `src/deepseek` | 791 | **不重写**——由 pi-ai 取代（退役计划见下行） |
| CLI wrapper | — | `review-pi` CLI（形态对齐原 `review-agent`，P3 票） |

### 3.4 退役时点表

| 代码面 | 处置 | 时点 |
|---|---|---|
| `packages/review-dsh` + `--kernel` 缝 + SDK 依赖 + CI discipline-gate | 移除 | ✅ 已完成（本提交） |
| `src/deepseek`（791） | 随 runtime 退役——它是实验 CLI 的缺省客户端（`cli.ts` 活依赖），**不可先弃**（修正可行性分析中「可即弃」的判断） | P4 runner 接缝切换时 |
| `src/{loop,run,tools,zoneb,codeintel,contracts,finding,audit,shared,fake}`（≈5.5k） | P2 字节门的期望生成器与行为参照，门绿后退役 | P4 同批 |
| `tests/` 对应测试（全量 ≈20k 行） | 随宿主模块同进退 | 同批 |
| `packages/review-llm`、`src/{experiment,judge,metrics,sampling,calibration,gate,dataset,reference}` | 长期保留 | — |

## 4. pi 原语映射（设计文档要求 → pi 落点）

| 《总体架构设计方案》要求 | pi 落点（从 0） | 判定 |
|---|---|---|
| §3 Review Agent Loop（六阶段：Change Understanding → Risk Classification → Context Decision → Context Retrieval → …；阶段结构见 DSH 审计 `phaseLog`） | A/B（零工具）：自研 controller 直驱 pi-ai stream（无需 agent-loop）；C/D/E：pi-agent-core `Agent` + `agentLoop` 钩子（`shouldStopAfterTurn` 控轮次、`transformContext` 控上下文——`packages/agent/src/agent-loop.ts`/`hooks.ts` 已核实） | 高 |
| §4 Context Engine C0–C3 / Zone A–C | 确定性组装层自研——message 序列完全自持，请求字节可钉 | 高 |
| §5 Cache Engine（Stable Prefix / Ledger / cacheBreaks） | 消息序自控 + pi-ai 序列化 + `compaction: {enabled:false}` + `onPayload`/`onResponse` wire 捕获 | 中高（机制在己；序列化方言差异属内核效应，报告单列） |
| `review.*` 七工具（C/D/E） | pi-agent-core 工具注册（zod schema） | 高 |
| Session append-only / 审计 | pi 事件流 → `AuditFileContent` 投影（字段对齐 DSH 审计：`requests[].{model,effort,messages,tools,wireBody}`） | 高 |
| 企业网关接入（`REVIEWER_URL` + 自由模型 id，#45 语义） | `Model.baseUrl` 是数据字段（`openai-completions.ts:785` 直接吃 `model.baseUrl`）；spread 内建 `deepseek-v4-flash` 条目改 baseUrl 指向网关（模型在 v0.85.1 目录快照内，已核实）；fork 在手，最坏打小补丁 | 高，P1 冒烟验证 |

Config B 生产形态（2026-09-17 拍板：零工具 + 确定性预取）不因重写改变。

## 5. 评测可比性契约（对照实验的立身之本）

### 5.1 Tier 1 协议一致（字段级，必须）

对齐对象 = `runs/phase2-dsh/plan.json`（实测）：

| 维度 | 值 |
|---|---|
| 数据集 | 30 案 VUL4J（`data/vul4j/target-cases.json`；物化仓 base 态 + 原生 diff + 原生英文 issue） |
| 矩阵 | A–E × 3 reps = 450 单元 |
| 被测模型 | `deepseek-v4-flash` |
| Verifier | off |
| 判定链 | 四层（逆补丁真值 → 规则粗筛 → LLM judge `glm-5-3-260814` → 人工抽检）+ S/A/B 判级（ADR-0004） |
| 指标 | CE / RCE / RIE / CARC（ADR-0008 分口径） |
| 记录 | RunRecord schema 原样（analyze / gate 脚本须能原样消费两侧数据） |
| token 口径 | DSH 实测 usage 形状 `{inputTokens, outputTokens, cacheReadTokens}`——pi-ai usage 字段映射归一（P1 硬票，见 R2） |

### 5.2 Tier 2 字节纪律（分层）

- **A/B 必须字节一致**：零工具配置下请求体全部由自研组装层产出，应与 DSH 审计逐字节相同。**字节真源已实测确认**：主工作仓 `runs/phase2-dsh-t{1..5}/audit/**` 的审计 JSON 含 `requests[]`，每条带 `model / effort / messages / tools / wireBody` 全量序列化请求体——不需要复用任何旧代码即持有测量契约。
- **C/D/E 语义一致而非字节一致**：工具 schema 的 wire 序列化由客户端 SDK 完成（DSH 线 = dsh-sdk-protocol，pi 线 = pi-ai），构造上不可能字节相同。这不是缺陷而是内核效应本身——phase2 main↔dsh 对照时 C/D/E 同样不字节一致（POC1 走 review-llm 序列化）。处置沿用先例：工具语义等价 + 稳定前缀纪律 + 对齐门兜底。

### 5.3 验收方法论复用（双门，第三轮应用）

确定性纪律门（字节 / 审计断言，零网络）+ 指标对齐门（#30 对称 max σ 带，ADR-0007）——POC1↔DSH 对照锻造的迁移验收协议，内核无关；pi 是同一协议换被测对象。**换内核与换模型同理：DSH 侧的 S/A/B 结论不自动迁移到 pi 侧，须独立跑出对照。** pi 侧跑 450 单元 + judge；DSH 侧数据已存在，不重跑。

## 6. 风险清单

| # | 风险 | 等级 | 依据（实测） | 处置 |
|---|---|---|---|---|
| R1 | phase2 数据不在本仓 | **确定** | 本仓 `runs/` 仅 REPORT 壳；450 记录 + audit 真源在主工作仓 | §9 迁移步骤 |
| R2 | token 口径归一 | 中 | DSH usage `{inputTokens, outputTokens, cacheReadTokens}`（样本 3830/17038/5376）vs pi-ai usage 对象 | P1 定义字段映射 + 已知记录断言 |
| R3 | cache 命中差异被误读 | 中 | 序列化方言不同 → prefix cache 命中率不同 | 属被测内核效应：`cacheReadTokens` 单列口径呈现，不与质量结论混排 |
| R4 | 网关 + 自由模型 id | 中低 | baseUrl 机制在、模型在目录内，但未真跑过 | P1 冒烟（`review-agent smoke` 的 pi 版，双探针 + 人话诊断形态平移） |
| R5 | 判定链漂移 | 低（已按拍板处置） | judge 走 review-llm，仪器冻结 | 变量隔离在内核侧 |
| R6 | Windows / POSIX | 低 | pi 上游 45 个失败全在测试面，非运行时路径 | P1 在 Windows 直跑即验证 |
| R7 | 模型非确定性 | 已被协议解决 | phase2 既有经验 | 3 reps + 配对检验 + σ 带 |

## 7. 路线（P0–P5）

| # | 票 | 内容 | 验收 |
|---|---|---|---|
| P0 | 基线处置 | ✅ 已完成（2026-09-18）：DSH 移除 + phase2 数据迁入（§9 执行注记） | 树绿 ✅、analyze:phase2 消费三侧 450×3 + smoke ✅ |
| P1 | pi walking skeleton | 单案 × config B 全链：自研组装 → pi-ai（网关）→ findings 解析 → 审计投影 → RunRecord；`onPayload` wire 捕获；usage 映射 | RunRecord 被 analyze 脚本原样消费；网关冒烟过；R2/R4/R6 就地关闭 |
| P2 | 字节纪律门 | A/B `wireBody` vs DSH 审计真源逐字节对照（gate 复用 #22/#23 方法论，比较对象换 DSH 审计） | 零差异，或差异逐条登记为显式决策 |
| P3 | 全配置面 + CLI | C/D/E 七工具上 agentLoop；`review-pi` CLI（形态对齐原 `review-agent`，含 smoke） | 工具语义等价 + 前缀稳定 |
| P4 | 实验 runner 接入 | kernel 执行缝（runner `executeUnit` 的可替换执行点已预留注释）+ 450 单元矩阵 | 全矩阵可跑（断点续跑协议复用）；`src/` runtime 模块退役 |
| P5 | 评测与对照 | judge + 指标复算 + DSH↔pi 对称 σ 带对齐门 + 对照报告 | 报告入 `docs/report/` |

工作量感觉：从 0 面 ≈ 6k 行内核 + 1k 集成与测试；仪器 ≈ 10k 行平移基本不动。比 DSH 线整体省（装置 / 方法论 / 文档 / 数据全在）；**净成本集中在 P2 纪律工作与 P5 真跑**（pi 侧 450 单元 + judge 网关成本，量级与 phase2-dsh 一轮相当）。

## 8. 与既有架构决策的关系

| 既有决策 | 本方案关系 |
|---|---|
| ADR-0005（DSH 迁移姿态）/ ADR-0006（DSH 内核形态） | **转为历史记录**（DSH 线已按其完成使命：迁移、对齐、phase2 附录数据）；被 ADR-0009 取代 |
| ADR-0007（对齐门协议 v2） | 复用，第三轮应用（POC1↔DSH 之后的首个新对照） |
| ADR-0008（被测模型可换 + 分口径指标） | 接入面语义继续有效；被测侧 wire 序列化在 pi 线由 pi-ai 承担（画像语义等价）；judge 侧不变 |
| ADR-0003（零构建静态代码情报） | 纪律不变——codeintel 从 0 重写但保持零构建 / tree-sitter 静态生成 |
| ADR-0004（S 级判据）/ ADR-0002（模型钉扎语义，已被 0008 收窄） | 不变 |
| Config B 生产形态（2026-09-17 拍板） | 不变（内核无关层） |
| 《Pi 内核定制基线方案》 | §1–§6（fork 接线、分歧清单、验证结果、已知限制）继续有效；其 §8 后续票面（增量适配姿态）由本文 P0–P5 取代 |

## 9. 数据迁移与操作约定

```bash
# 在主工作仓执行（评测数据 + 物化仓迁入本仓；runs/ 与 .cache/ 均 gitignored，零 git 影响）
cp -r runs/phase2-main runs/phase2-noise runs/phase2-dsh runs/phase2-dsh-t{1..5} runs/phase2-smoke <本仓>/runs/
cp -r .cache/datasets <本仓>/.cache/            # 或在本仓重跑 pnpm materialize:vul4j（确定性再生成）

# 迁入后自检：analyze 脚本可读两侧
pnpm analyze:phase2
```

- audit 真源（`phase2-dsh-t*/audit/**`）随 `runs/phase2-dsh-t*` 一并迁入——它是 P2 字节门的对照物，**不可只拷 `runs/` 记录不拷 audit**。
- phase2-dsh 的记录 `auditPath` 字段是**绝对路径**（指向主工作仓），迁入后 P2 门工具应以「实验根相对路径」重定位，不改写记录本体。
- 主工作仓保持只读参照地位（pi 参考仓 `reference_project/pi` 同理）；本仓此后是唯一活跃工作仓。

**P0 执行注记（2026-09-18）**：迁移已执行（robocopy /E /MT，时间戳保留）。实际范围 = 上列四族 + `phase2-dsh-t{1..5}` + `phase2-smoke`（2.1M，analyze T5 消费它）+ `.cache/datasets`（516M / 71,478 文件；`/XJ` 跳过 VUL4J-41 物化仓内上游符号链接测试夹具 5 文件 83 字节，无实质影响），合计 ≈1.8G。**s\* 系列（`phase2-main-s1..5` / `phase2-noise-s1..8`，≈720M）不迁**——analyze 不消费，属 #30 噪声底证据数据，留主工作仓只读参照，需要时可补拷。验收实测：三侧 rep 记录各 450 + smoke 5；t 系 audit 恰 450 份（每单元一份，`requests[].{model,effort,messages,tools,wireBody}` 在位）；`plan.json` 三侧同构（`deepseek-v4-flash` / verifier off / 5 configs / 3 reps / judge `glm-5-3-260814`）；`pnpm analyze:phase2` exit 0，T1 三侧判定逐字一致（B=S / C=BELOW_B / A·D·E=B）、T5 三侧 EXEC 合计 72.46M 落 #32 估算窗；`auditPath` 实测指向主工作仓绝对路径（上述重定位约定生效）。git 零影响（runs/** 与 .cache/ 均 gitignored）。

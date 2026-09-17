# Config B 生产化方案——差距分析、推荐路线与修改建议

> **文首说明**：2026-09-17 拍板：**后续直接采用 Config B 作为生产检视形态**（零工具 + 确定性预取，不做风险升级门）。本文整理该决策的分析依据、决策直接激活的修改方案、生产化缺口与护栏、骨架修改的协议决策（推荐保守路线）与实施票面拆分。数据底盘为 Phase 2 主数据（`docs/report/Phase 2 主数据分析报告.md`，30 案 × A–E × 3 rep × 三侧 = 1350 单元）；Token 优化机制全貌见同目录《ReviewAgent Token 优化方案——以 20~30% Token 成本达到通用 Agent 检视效果.md》。术语遵循 `CONTEXT.md`。
>
> **一句话结论**：B 是数据站得住的生产形态（三侧 S 级、precision/F1 双冠、成本有界、FP 天然安全）；上线前必须补四件事——MR 边界护栏、输出语言决策、模型迁移门（若换模型）、质量回流日志；骨架裁剪（阶段 4 空转）与风险自适应预取**等第一批生产数据后再动**，动前须过对齐验证。

---

## 1. 决策背景与数据依据

### 1.1 决策内容

- 生产检视形态 = **Config B**：零工具 + Zone B 与固定管线确定性预取（Diff → Symbol → Reference → Call Chain），无 ledger、无全仓注入、无自主检索；
- **不设风险升级门**：高风险 MR 同样走 B 平推，不切换到 D/E 形态（升级门作为后续可选杠杆保留，见 §2.2 与 §5）。

### 1.2 Config B 的运行时形态

```text
CONFIGS.B = { configId: "B", toolsEnabled: false, prefetch: true,
              fullRepo: false, stablePrefix: false, ledger: false }
```

请求布局（`src/loop/messages.ts` buildInitialMessages）：

```text
[system（Zone A：角色/方法论/Finding Schema/Evidence Policy/英文输出）]
[Zone B（Repo Map 40% + 包结构 20% + 签名级 Symbol Index 40%，≤16K chars）]
[user（MR：caseId + issue 描述 + unified diff）]
[预取 Symbol 层（≤8K）] [预取 Reference 层（≤6K）] [预取 Call Chain 层（≤6K）]
→ 六阶段骨架逐阶段推进（模型无工具可用，纯推理）
```

### 1.3 数据依据（Phase 2 主数据，judge 口径，main 侧 90 单元均值）

| 指标 | B 实测 | 对照 | 判读 |
|---|---|---|---|
| linePrecision | **0.7835** | 五配置最高（A 0.7232 / C 0.6349 / D 0.7226 / E 0.569） | 精度冠 |
| lineF1 | **0.5763** | 稳定口径最高（D 名义 0.6257 但跨侧不可复现，不作对照） | F1 冠 |
| lineRecall | 0.4671 | 仅次于 A（0.5008）；为 C（0.1341）的 3.5 倍 | 检出充足 |
| totalTokens | 49.9k/单元 | 全仓配置 C（706.5k）的 **7.1%**；CARC 19.8k 为 C（105.1k）的 18.8% | 成本有界 |
| cacheHitRate | 0.8114（热口径 **0.8782**） | ≥ S 级 85% 门槛（热口径） | 缓存兑现 |
| rounds / toolCalls | 1 / 0 | 单轮零工具 | 延迟与成本可预算 |
| S/A/B 判定 | **S**（三侧逐字一致） | 四判据全过且余量巨大 | 协议判定 |

### 1.4 为什么 B 适合生产

1. **成本与延迟可预算**：单轮、零工具调用、预取预算封顶——单次检视的 token/延迟分布窄，适合企业 MR 流的容量规划；
2. **确定性**：预取字节 = f(仓库状态, diff)，可复现、可审计、可回放（审计契约齐全）；
3. **FP 天然安全**：无自主检索，阴性对照所测的「主动检索推高无中生有率」路径在 B 上不存在；
4. **避开不稳定族**：Phase 2 归因的上下文重组不稳定族为 C/D（全仓注入/自主拉取，跨侧 recall 极差 0.1487/0.1039）；B 极差 0.0469 居中偏稳，且无网关激进行为放大路径；
5. **高危场景已验证**：VUL4J 本身是 CVE/CWE 标签的单缺陷高危数据集——B 在高危场景同样拿 S，「不做升级门」在该证据范围内成立。

### 1.5 随决策而来的两个 caveat（须随文档携带）

- **热召回逐 rep 衰减**：B 的 rule 口径 recall 逐 rep 递减（0.1737 → 0.1495 → 0.0594），与 #30「上下文重组 × 跨日部署漂移」不稳定族同向；judge 口径三侧尚稳（极差 0.0469）。生产监控须跟踪质量漂移（§3.4）。
- **S 级语义**：S = 「显著超越一个塌缩的 C 锚」（锚热 recall 仅 0.0097）。对外/对内引用须连同锚塌缩注记；生产 KPI 应采用绝对口径（人工接受率等），不用相对 C 的比例（§3.4）。

---

## 2. 决策激活的修改方案

B 定为生产形态后，以下四项从「可选优化」升级为「直接相关」。前两项动 harness 代码，后两项分别是部署侧与路线图形态改写。

### 2.1 阶段 4 确定性空转的裁剪

**问题**：六阶段骨架中 Context Retrieval 的指令是「If tools are available you may call them…otherwise state that no further context can be retrieved in this configuration」（`src/loop/phases.ts`）。B 零工具——该阶段的回复内容协议已定，**每单元白烧一个完整 LLM 请求**（约 1/6 请求量）。

**修改方案**（产品面；协议影响见 §4）：

- `toolsEnabled=false` 时跳过阶段 4 的 LLM 调用，由 harness 注入**确定性合成助手消息**（如 `"No context retrieval is available in this configuration (zero-tool preset)."` + 阶段契约的 notes JSON），消息字节恒定——比模型生成的等价回复更稳；
- `PhaseRecord.requestCount=0` + note 留痕（`phase skipped: no tools in configuration`），审计可见「跳过」而非「零请求异常」；
- 阶段 3（Context Decision）**暂不动**：其输出虽无动作价值（B 无法再取数），但对阶段 5 的推理可能有组织价值——是否裁剪交给消融数据，不预设。

**预期收益（估算）**：每单元省 1 次请求的未命中输入 + 输出 ≈ CARC 的 5~10%，外加 1/6 延迟。属确定收益但量级中等——这是它排在风险自适应预取之后、且推荐等生产数据的原因之一。

### 2.2 风险自适应预取深度（确定性 proxy）

**问题**：B 的三层预取（8K/6K/6K）对 50 行 diff 与 2K 行 diff 一视同仁。设计文档的「Risk-based Review 深度分级」目前只在概念层，预取是无条件全量。

**修改方案**：

- 预取发生在循环开始前，不能用阶段 2 的模型判级——采用**确定性 proxy**（零 LLM）：以 `analyzeDiff`（`src/zoneb/diff-analysis.ts`）的静态特征映射 Risk Class，特征维度建议：触达文件数、hunk 数与规模、变更文件类型（路径特征：并发/事务/安全敏感目录）、新增行关键词命中（`synchronized` / `transaction` / `Executor` / `Connection` / 加解密 API 等）。映射关系镜像 SYSTEM_PROMPT 的 Risk Class 定义（Low=注释/改名/格式化/机械变更；Medium=业务逻辑/API/状态/数据结构；High=并发/事务/安全/资源/分布式/性能/生命周期）；
- **分级门控**：Low → Zone B + Symbol 层；Medium → + Reference 层；High → 全三层。判级不确定时**向深失败**（fail-safe：多取上下文，B 成本本就有界）；
- proxy 判级结果落审计（新 PrefetchLayerRecord 伴生字段或独立 record），与阶段 2 模型判级并存可比——生产数据可直接量化 proxy 与模型判级的一致率，作为后续校准依据。

**备选形态（记录不推荐）**：把预取挪到阶段 2 之后按模型判级注入（`agent.inject()` 追加、append-only 兼容），但会改变请求 1 布局、且注入位置落在模型可变输出之后增加前缀分析复杂度——确定性 proxy 更简单且零成本。

**预期收益（估算）**：低风险单元省 Reference + Call Chain 两层（12K chars ≈ 3K tokens × 6 请求 × 未命中份额）≈ CARC 的 15~20%。真实企业 MR 流中低风险机械变更占比通常远高于 VUL4J（全高危），实际收益取决于分布——**这正是要等第一批生产数据标定阈值的原因**。

### 2.3 同仓 MR 批量调度（部署侧）

**问题与方案**：企业 MR 流天然按仓库聚集。Zone B 的 Repo Map + 包结构两节（占 Zone B 预算 60%）**跨 MR 字节相同**（不随变更文件圈定范围变化），Symbol Index 节按包圈定随 MR 变化——前缀分歧点在 Symbol Index 节内部，其前的全部字节（Zone A + Zone B 前两节）跨 MR 命中。部署侧动作：

- MR 队列按仓库分桶、同仓 MR 相邻执行（账号级缓存闲置数小时至数天清除，批处理窗内复用）；
- 避免大量不同仓库的 MR 并发交错（挤掉账号级磁盘缓存的复用窗）。

**预期收益**：B 总口径命中率 0.8114 → 同仓聚集下趋近热口径 0.878+；跨 MR 前缀复用的增量部分按约 1/30 计价，直接压 CARC。零模型侧改动。

### 2.4 C3 知识的第 4 预取层形态

B 无工具意味着 `review.search_rule` / `review.search_history` 在生产形态下**永远用不上**。CWD 缺陷模式库（知识 L2，Phase 4 路线图）进入 B 的正确形态是**预取第 4 层**：

```text
Prefetched context (4 of 4) - Knowledge layer.
CWD patterns gated by the deterministic risk proxy (High/Medium only).
```

- 注入内容 = 与 Risk Class 匹配的缺陷模式条目（静态语料），预算建议 ~4K chars 起步；
- 语料为空时该层缺省（与 POC1 现状字节兼容：无第 4 层注入）；
- 依赖：先有知识语料生产链路（DTS 挖掘 → 模式抽取，Phase 4），本项是其消费端——排在路线图后期，但**形态决策现在锁定**，避免 Phase 4 设计时再绕工具形态。

---

## 3. 生产化缺口与护栏

### 3.1 MR 边界护栏（上线前必须）

POC1 验证域为 **≤10 文件、diff ≤2K 行**。超界时预取预算会截断留痕（行为优雅），但**质量未在该域验证过**。修改方案分两版：

- **v1（护栏 + 标注）**：run 前从 MRCase 计算（文件数、diff 行数）；超界时 `ReviewOutcome` 顶层加 `domainWarning: "out-of-validated-domain (files>10 or diff>2K)"` 字段并照常执行（截断纪律兜底），消费端（MR 平台展示）可据此降级呈现（如标注「AI 检视受限」）；
- **v2（切分）**：按文件组切分 MR → 分别检视 → Finding 合并与去重。POC1 明确「大 MR 切分非目标」，v2 属新特性，单独立项。

### 3.2 输出语言配置化（上线前决策）

Zone A 的 SYSTEM_PROMPT 锁英文（`All review output must be in English`）。企业场景大概率需要中文输出。修改方案：

- `outputLanguage` 成为产品配置项（`"en" | "zh"`，缺省 `en` 保持与冻结实验字节兼容）；
- SYSTEM_PROMPT 的 Output language 节按配置渲染——**Zone A 字节按语言分序列**（每语言一条稳定前缀，各自命中，互不干扰）；
- Zone A 字节稳定测试与 golden bytes 期望值按语言参数化；
- **换语言后须做一次抽样质量验证**：输出语言影响模型行为，S 级结论不自动迁移到中文输出。

### 3.3 模型迁移门（若生产换模型）

B 的质量结论锚定 `deepseek-v4-flash`。#45 后模型可换（自由 id + 画像表），但结论不自动迁移。迁移流程建议固化为 runbook：

1. `review-agent smoke` 冒烟自证（双探针 + 人话诊断，#46）——网关连通性与 wire 序列化先过关；
2. 抽样验证跑：30 案子集 × B × 1 rep，与 v4-flash 基线在噪声带内对比（复用 #30 对称 max σ 带方法）；
3. 指标分口径（ADR-0008）：无缓存计量画像 → cacheHitRate 记 N/A（不是 0）、CARC 为保守上界；wire 序列化纪律由双包 parity fixtures 锁定，换模型不松动。

### 3.4 生产侧质量监控：Review Data Flywheel v1（上线前必须）

判定链（rule 粗筛 + LLM-as-judge + 人工抽检）是研究侧设施，**生产没有 judge**。B 上线后质量的唯一持续信号源是检视结果的处置回流：

- **v1 落库**：每条 Finding 的处置结果（accept / reject / defer + 评论者 + 时间）落库，runId 关联审计（审计已有全量请求字节与 Finding 结构）；
- **KPI**：生产质量主指标 = **人工接受率**（绝对口径，替代相对 C 锚的 S/A/B）；辅以按 Risk Class / 目录 / 时间的切片，监控 §1.5 的热召回衰减类漂移；
- **flywheel 起点**：处置数据是 Phase 6（CWD 知识生产链路）与 §2.4 知识层的原料——v1 只需把数据存下来，聚合与挖掘后续迭代。

### 3.5 复现性：temperature 候选（低置信，先验证再动）

现状不传 `temperature`/`top_p`（字节最小纪律，ADR-0002 旁系），采样为 provider 缺省档——同一 MR 复检结论可能不同。生产若需复现性，候选方案是 `temperature=0`，但须先验证两点：

1. 采样参数是否参与 DeepSeek 前缀缓存键（文档语义是 prompt 前缀匹配，理论上不参与——**须实证**，方法：同前缀两请求仅采样参数不同，比对 `prompt_cache_hit_tokens`）；
2. wire 字节变化的影响面：golden bytes / Zone A parity 期望值更新（temperature 在请求体但不在 messages/tools 段，cache-break 分类器不受影响）。

验证通过前不动；不通过则保持现状并在产品文档中如实标注复现性边界。

---

## 4. 骨架修改的协议决策：推荐保守路线

**分叉问题**：§2.1（裁阶段 4）与任何骨架改动都会改变 Zone C 字节——生产形态从此与实验冻结形态分叉，生产指标不再与 A–E 数据直接可比，且六阶段骨架是 ADR-0006 定义的内核形态（改动建议随附新 ADR）。

| 路线 | 内容 | 得失 |
|---|---|---|
| **保守（推荐）** | 生产先原样上冻结形态（6 阶段全跑）；跑完第一批真实 MR 后再裁阶段 4 + 标定风险自适应阈值；裁剪后做一次对齐验证 | 第一批生产数据的价值（真实 MR 分布下的质量/成本画像）≥ 先省的 ~1/6 请求；且生产分布正是 §2.2 阈值标定的依据 |
| 激进 | 现在就裁阶段 4 | 换一次对齐验证成本，立即省 5~10% CARC；生产首批数据失去与冻结形态的可比性 |

**对齐验证协议**（裁剪后执行，复用既有方法论）：修改形态 × B × 30 案 × 3 rep，与冻结 B 在对称 max σ 带内对比（#30 噪声底方法）；差异归因纪律同 #29/#30（响应非确定性与运行时效应分开归因）。

---

## 5. 实施路线与票面拆分

### 上线前必须（第一批生产 MR 之前）

| # | 票 | 验收口径建议 |
|---|---|---|
| 1 | MR 边界护栏 v1 | 超界 MR 的 `ReviewOutcome` 携带 domainWarning 且照常出结果；边界内行为与现状字节一致（回归锁定） |
| 2 | 输出语言决策 + 配置化 | 语言配置项落地；Zone A 字节测试参数化；目标语言抽样验证跑通过 |
| 3 | 模型迁移 runbook（若换模型） | smoke + 抽样验证流程文档化；指标分口径按画像生效 |
| 4 | 质量回流 v1 | Finding 处置落库 + 接受率聚合报表；数据结构为 Phase 6 预留 |

### 第一批生产数据之后

| # | 票 | 验收口径建议 |
|---|---|---|
| 5 | 阶段 4 裁剪（含新 ADR） | 合成消息字节恒定；审计留痕「跳过」；对齐验证落在噪声带内 |
| 6 | 风险自适应预取深度 | proxy 判级落审计；与模型判级一致率报告；低风险单元 token 下降且质量指标不劣化（消融门） |
| 7 | 同仓批量调度 | 部署侧文档 + 命中率前后对比（总口径 cacheHit 提升） |
| 8 | C3 知识第 4 层（依赖 Phase 4 语料） | 注入形态锁定；空语料时字节与现状兼容 |

### 持续观察项（不立票，进生产监控）

- B 热召回衰减类漂移（按 §3.4 切片监控）；
- temperature=0 的缓存键验证（§3.5）；
- 风险升级门（B → D/E 形态切换）保留为后续可选杠杆：生产分布若显示高风险切片的检出不足，再以消融票评估。

---

## 6. 与既有决策和文档的关系

| 既有决策/文档 | 关系 |
|---|---|
| 《ReviewAgent Token 优化方案》（同目录） | 机制层总纲；本文是其「生产定型」后续 |
| ADR-0004（S 级判据） | S 级语义随锚塌缩注记引用（§1.5），生产 KPI 改绝对口径 |
| ADR-0006（内核形态：六阶段骨架） | §2.1/§4 的骨架裁剪若执行，须随附新 ADR |
| ADR-0008（被测模型可换 + 分口径） | §3.3 模型迁移门的口径基础 |
| Phase 2 主数据分析报告 | 全部数据来源；「多轮机制未转化为质量优势」是 B 定型的直接依据 |
| Phase 4/6 路线图（Knowledge / Feedback） | §2.4 知识层与 §3.4 flywheel 分别是其生产端形态 |

## 附：修改点 → 实现锚点对照

| 修改点 | 实现锚点 |
|---|---|
| 阶段 4 裁剪 | `src/loop/phases.ts`（PHASE_INSTRUCTIONS）、`src/loop/review-loop.ts`（runPhase 的 LLM 调用门）、DSH 侧策略驱动器（`packages/review-dsh`，ADR-0006） |
| 风险自适应预取 | `src/zoneb/prefetch.ts`（管线门控）、`src/zoneb/diff-analysis.ts`（proxy 特征源）、`src/contracts/prefetch.ts`（预算/层级配置） |
| MR 边界护栏 | `src/run/validate-inputs.ts` / `src/run/run-review.ts`（入口校验与 outcome 字段）、DSH 侧对应导出面 |
| 输出语言 | `src/loop/messages.ts`（SYSTEM_PROMPT 渲染）、Zone A 字节测试（`tests/` golden / parity） |
| 模型迁移门 | `review-agent smoke`（#46）、`review-llm` profileOf（分口径）、抽样验证协议（#30 方法复用） |
| 质量回流 | 新模块（处置落库 + 聚合），消费 `RunAudit` 既有 Finding 契约（`src/contracts/finding.ts`） |
| 同仓调度 | 部署侧（MR 队列策略文档），无代码改动 |

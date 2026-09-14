# AACR-Bench 公开评测接入方案

- 状态：Draft
- 日期：2026-09-04
- 适用阶段：POC1 Benchmark / 后续公开基线
- 相关概念：C0–C3、Context Ledger、Stable Prefix、Evidence Gate、RIE、CARC

---

## 1. 决策摘要

将 **AACR-Bench** 引入为 ReviewAgent 的公开外部 benchmark，但不让它替代现有内部基准。

核心决策：

1. **公开质量指标以 AACR-Bench 官方 evaluator 为准**，避免自建匹配规则导致口径不可比。
2. **ReviewAgent 自有 harness 负责过程指标**，补充 token、cache、tool call、Context Ledger、Evidence Gate 等官方 benchmark 不覆盖的能力。
3. **通过 AACR 官方标准数据格式接入**，即 `ReviewInstance` JSONL，而不是直接耦合原始数据文件。
4. **按项目切分 dev / report 集**，避免同一仓库的多个 PR 造成评测泄漏。
5. **分语言分阶段推进**：先 Java 子集打通链路，再扩展到 10 语言全量。

结论：

> AACR-Bench 用于回答“ReviewAgent 在公开真实 PR 上与 OCR / Claude Code / Codex 相比质量如何”；
> ReviewAgent 自有指标用于回答“最小充分上下文、缓存稳定、证据约束是否真的降低了成本”。

---

## 2. 目标与非目标

### 2.1 目标

1. 建立可对外比较的公开 benchmark 结果。
2. 验证 ReviewAgent 在真实仓库、真实 PR、跨文件上下文上的泛化能力。
3. 量化 C0–C3 上下文加载策略对质量与成本的影响。
4. 量化 Stable Prefix、Context Ledger、Append-only Context 对缓存命中和真实成本的影响。
5. 输出可复现的评测报告，包括数据快照、模型、配置、审计轨迹与指标。

### 2.2 非目标

1. 不替代逆补丁法基准：逆补丁法提供因果明确的缺陷引入场景，AACR 提供真实 review 场景，两者互补。
2. 不把 AACR-Bench 当作调参集：报告集不得用于提示词迭代。
3. 不用 mock judge 产出对外结论：mock 仅用于链路自检。
4. 不在仓库中提交完整数据集和外部仓库快照。
5. 不把 AACR 结果直接等同于企业 MR 检视效果：企业场景还需接入私有仓库、团队规则与内部历史缺陷。

---

## 3. Benchmark 事实与来源

| 项目 | 内容 |
| --- | --- |
| 名称 | AACR-Bench |
| 发布方 | Alibaba Aone |
| GitHub | https://github.com/alibaba/aacr-bench |
| Hugging Face | https://huggingface.co/datasets/Alibaba-Aone/aacr-bench |
| License | Apache-2.0 |
| 规模 | 200 个真实 PR、50 个开源项目、10 种语言 |
| 真值 | 2,145 条 review comments（当前 GitHub 页面口径） |
| 类别 | Security / Defect / Maintainability / Performance |
| 上下文层级 | diff / file / repo |

OCR 本地 README 使用的是另一个历史口径：1,505 个 ground-truth issues。因此所有报告必须显式记录数据快照与统计口径，不能混用。

### 3.1 AACR 官方评测框架

官方 `evaluation/` 提供：

```text
data loading → review execution → evaluation
```

已支持 reviewer：OpenCodeReview、Claude Code、Codex。

官方标准格式为 JSONL，一条记录代表一个 `ReviewInstance`：

```json
{
  "instance_id": "owner__repo-pr@head_commit",
  "repo": "owner/repo",
  "base_commit": "base_sha",
  "head_commit": "head_sha",
  "clone_url": "https://github.com/owner/repo.git",
  "reference_comments": [
    {
      "path": "setup.py",
      "start_line": 46,
      "end_line": 46,
      "side": "right",
      "text": "reference review comment"
    }
  ]
}
```

其中 `reference_comments` 是评测真值，**不得进入 ReviewAgent 的可见输入**。

---

## 4. 在 ReviewAgent 基准体系中的定位

| 基准 | 主要问题 | 真值来源 | 定位 |
| --- | --- | --- | --- |
| 逆补丁法 | 能否发现引入缺陷的 MR | 最小修复补丁 | 内部因果验证 |
| Defects4J / Vul4J / MSB-Java | 特定缺陷类型与 Java 深度 | 缺陷修复数据 | 内部专项验证 |
| Clean MR | 能否控制误报 | 人工确认的无缺陷 MR | 阴性对照 |
| AACR-Bench | 公开真实 review 场景下的质量与泛化 | 专家交叉标注评论 | 公开外部基线 |

注意：

1. AACR 的 truth 是“人类 review comment”，不总是“可复现失败测试定义的缺陷”。
2. AACR 包含 Maintainability 类评论，而逆补丁法主要衡量缺陷发现。
3. 两类 benchmark 的 Precision / Recall 不能直接合并平均，只能分别报告。

---

## 5. 总体架构

```text
AACR-Bench raw data
        │
        ▼
AACR official converter
        │
        ▼
ReviewInstance JSONL
        │
        ├──► ReviewAgent AACR adapter ──► ReviewAgent runner
        │                                    │
        │                                    ├── Finding[]
        │                                    ├── LlmUsage
        │                                    ├── ToolCallLog
        │                                    ├── ContextLedger
        │                                    └── EvidenceGate audit
        │                                    │
        │                                    ▼
        │                              AACR result exporter
        │                                    │
        ▼                                    ▼
AACR official judge ◄────────────────── ReviewAgent result
        │
        ├── Precision
        ├── Recall
        ├── Line Precision
        └── Noise Rate
        │
        ▼
ReviewAgent extended report
        ├── RIE / CARC
        ├── cached / uncached tokens
        ├── tool calls / rounds / latency
        ├── C0–C3 usage
        ├── cache prefix stability
        └── Evidence Gate statistics
```

职责划分：

| 模块 | 职责 |
| --- | --- |
| AACR adapter | 读取标准 JSONL，构造运行输入，隔离真值 |
| ReviewAgent runner | 执行 A–E 配置，输出 Finding 与审计轨迹 |
| Result exporter | 把 Finding 转成 AACR evaluator 可消费的结果格式 |
| Official evaluator | 计算公开质量指标，作为对外口径 |
| Extended metrics | 计算效率、缓存、上下文与证据指标 |
| Report builder | 生成 JSON 明细与 Markdown 汇总 |

---

## 6. 数据快照管理

### 6.1 目录建议

```text
data/aacr-bench/
  manifest.json
  raw/
    aacr-bench.json
    aacr-bench.sha256
  standard/
    aacr_bench.jsonl
  repos/
    owner__repo/
  runs/
    <snapshot>/<config>/<run_id>/
```

`raw/`、`repos/`、`runs/` 不进入 git；`manifest.json` 与转换脚本进入 git。

### 6.2 manifest 字段

```json
{
  "benchmark": "aacr-bench",
  "datasetUrl": "https://huggingface.co/datasets/Alibaba-Aone/aacr-bench",
  "datasetSha256": "...",
  "frameworkGitCommit": "...",
  "converterVersion": "...",
  "generatedAt": "...",
  "caseCount": 200,
  "commentCount": 2145,
  "languageDistribution": {},
  "categoryDistribution": {},
  "contextDistribution": {},
  "excludedCases": []
}
```

要求：

1. 下载后校验 SHA-256。
2. 固定 AACR evaluation framework 的 git commit。
3. 转换器版本变化必须生成新 snapshot，不覆盖旧报告。
4. 排除任何 case 都必须记录原因，不允许静默丢弃。
5. 报告中必须显示 snapshot ID，而不是笼统写 “AACR-Bench latest”。

---

## 7. 数据契约映射

### 7.1 输入映射

| AACR / ReviewInstance | ReviewAgent 字段 | 说明 |
| --- | --- | --- |
| `instance_id` | `caseId` | 前缀规范化为 `aacr:<instance_id>` |
| `repo` + `base_commit` + `head_commit` | `repoPath` + `diff` | 本地 checkout 后生成 unified diff |
| `clone_url` | `extensions.cloneUrl` | 用于离线预取与溯源 |
| `base_commit` | `extensions.baseCommit` | 保留原始 SHA |
| `head_commit` | `extensions.headCommit` | 保留原始 SHA |
| PR 标题 / 描述 / 普通评论 | `issueDescription` | 仅允许进入可见输入的 PR metadata |
| `reference_comments` | 独立 truth 存储 | 严禁进入模型输入 |

可见输入白名单：

```text
repo snapshot
base..head unified diff
PR title
PR description
普通 PR 讨论文本（如数据提供）
```

禁止进入可见输入：

```text
reference_comments
ground-truth comment body
ground-truth file / line / side
ground-truth category
ground-truth context level
```

### 7.2 标准格式与原始元数据合并

AACR 官方 `ReviewInstance` 只保留评测所需的最小真值字段，不携带 `category`、`context`、`project_main_language` 等分层字段。

处理规则：

1. `standard/aacr_bench.jsonl` 作为运行输入与官方评测输入。
2. 原始 AACR 数据单独解析为 metadata 表，仅用于报告分层，不进入模型输入。
3. 通过 `instance_id` + `path` + line interval + `text` 建立一对一关联。
4. 无法唯一关联时，该 case 标记为 `METADATA_UNMATCHED`，分层报告中排除，但官方 full 指标仍按标准格式参与。
5. `project_main_language` 用于语言分层，不能作为模型可见输入。

### 7.3 类别映射

AACR 类别到 ReviewAgent `DEFECT_NATURES` 的诊断映射：

| AACR category | ReviewAgent nature |
| --- | --- |
| Security | `SECURITY` |
| Defect | `CORRECTNESS` |
| Performance | `PERFORMANCE` |
| Maintainability | `OTHER` |

约束：

1. 未知 category 必须让 manifest 生成失败，不允许默认映射到 `OTHER`。
2. 该映射只用于 ReviewAgent 内部分析。
3. 公开 Precision / Recall / Noise Rate 仍以官方 semantic judge 为准。

### 7.4 行位与 side 处理

AACR 参考评论包含：

```text
path
start_line
end_line
side = left | right
```

处理规则：

1. `right`：直接映射到 head 侧行号。
2. `left`：需要通过 diff hunk 映射到 head 侧对应位置。
3. 无法可靠映射时，保留 `left` 真值并交给官方 evaluator；不得伪造 right 行号。
4. ReviewAgent 自研 line screener 只做诊断，不作为 AACR 公开指标来源。

### 7.5 truth 类型设计

不要把 AACR truth 强行塞进 `MRTruth` 后再复用逆补丁法假设。建议新增独立契约：

```ts
interface AacrEvaluationCase {
  readonly input: ReviewRunInput;
  readonly referenceComments: readonly AacrReferenceComment[];
  readonly metadata: AacrCaseMetadata;
}

interface AacrReferenceComment {
  readonly commentId: string;
  readonly path: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly side: "left" | "right" | null;
  readonly text: string;
  readonly category: string;
  readonly contextLevel: "diff" | "file" | "repo";
}
```

如果短期必须复用 `MRCase`，需要满足：

1. `labels.source = "aacr-bench"`。
2. 不把 `truth = null` 解释为 clean MR。
3. AACR 质量指标不得走 `screenFindings` 主链路。

---

## 8. 运行配置

### 8.1 实验配置

沿用现有 A–E：

| 配置 | 上下文形态 | AACR 阶段用途 |
| --- | --- | --- |
| A | Diff-only，零工具 | 低成本基线 |
| B | 固定预取 | 预取策略消融 |
| C | 全仓注入 | 质量上限与成本上限 |
| D | Stable Prefix + 工具 | 缓存稳定性消融 |
| E | Stable Prefix + Context Ledger | ReviewAgent 完整形态 |

建议优先组合：

1. 链路验证：`A` + `E`，Java 子集。
2. 消融验证：`A` / `B` / `D` / `E`。
3. 上限观察：`C` 只跑分层抽样，不直接全量，避免成本失控。

### 8.2 运行参数

```text
model: deepseek-v4-flash
temperature: 0
max_rounds: 5
max_tool_calls: 6
repeat_count: 3
timeout: per case 显式配置
retry: 最多 1 次，仅限基础设施错误
```

重复运行口径：

1. `rep1` 为冷启动，单列报告。
2. `rep2+` 为主口径，用于热缓存统计。
3. 不得用 `rep2+` 平均值掩盖 `rep1` 成本。
4. 重试必须记录原因；模型输出不满意不属于可重试错误。

---

## 9. dev / report 集切分

AACR-Bench 未提供官方 train/test split。ReviewAgent 必须自行建立防泄漏切分。

原则：

1. **按 project 切分，不按 PR 切分**，避免同一仓库的项目规则泄漏。
2. dev 集用于适配器、提示词、阈值和 judge 校准。
3. report 集只在冻结后运行，用于对外报告。
4. 报告集结果不得反向驱动提示词修改；若必须修改，进入下一轮快照并重新运行。

建议切分：

```text
dev:    约 20% projects
report: 约 80% projects
```

同时保留两个口径：

| 口径 | 用途 |
| --- | --- |
| AACR full 200 | 与 OCR / Claude Code / Codex 公开结果对齐 |
| ReviewAgent held-out | 内部迭代与模型选择 |

若要修改提示词或上下文策略，只能看 dev / held-out；对外报告同时披露 full 与 held-out，避免选择性汇报。

---

## 10. 指标体系

### 10.1 官方公开指标

以 AACR 官方定义为准：

| 指标 | 公式 |
| --- | --- |
| Precision | valid matches / total generated |
| Recall | valid matches / dataset valid count |
| Line Precision | line matches / total generated |
| Noise Rate | unmatched / total generated |

这些指标由官方 evaluator 计算，ReviewAgent 不改写定义。

### 10.2 ReviewAgent 扩展指标

#### Token 与成本

```text
uncachedInputTokens
cachedInputTokens
cacheWriteTokens
outputTokens
totalInputTokens
totalTokens
cacheHitRate
```

RIE：

```text
RIE =
Recall × Precision
──────────────────
Total Tokens / 1K
```

AACR 接入时，`Recall` 与 `Precision` 取官方 evaluator 输出，`Total Tokens` 取 ReviewAgent usage 审计。

CARC：

```text
CARC =
uncachedInputTokens
+ cacheWriteTokens
+ outputTokens
+ toolCostTokens
```

缓存命中的 `cachedInputTokens` 不计入 CARC。

#### 上下文与工具

```text
toolCalls
rounds
latencyMs
toolCostTokens
retries
truncatedCount
```

按上下文层级统计：

```text
C0 usage
C1 usage
C2 usage
C3 usage
context chars loaded
context entries loaded
duplicate context requests avoided by ledger
```

#### Evidence Gate

```text
candidateCount
findingCount
noEvidenceRejectedCount
verificationFailedCount
evidenceGatePassRate
findingsWithValidEvidenceRate
```

#### 缓存稳定性

```text
stablePrefixBytes
stablePrefixSha256
prefixStableRate
cacheHitRate
rep1ToRep2CacheDelta
```

要求：

1. `stablePrefixSha256` 必须按请求记录，不能只记录配置名。
2. D/E 配置需要证明同一 case 的多轮请求前缀稳定。
3. rep2+ 的 cache hit rate 不得与 rep1 混合平均，必须分层报告。

---

## 11. 输出报告

### 11.1 文件结构

```text
reports/aacr/<snapshot>/<reviewer>/<config>/<run_id>/
  summary.json
  summary.md
  cases.jsonl
  runs/
    <case_id>.json
  audits/
    <case_id>.json
  judge/
    <case_id>.json
  errors.jsonl
```

### 11.2 summary.json 必填字段

```json
{
  "benchmark": "aacr-bench",
  "snapshotId": "...",
  "split": "full | held-out | dev",
  "caseCount": 200,
  "completedCount": 200,
  "errorCount": 0,
  "reviewer": "review-agent",
  "configId": "E",
  "model": "deepseek-v4-flash",
  "repeatCount": 3,
  "officialMetrics": {},
  "extendedMetrics": {},
  "perLanguage": {},
  "perCategory": {},
  "perContextLevel": {},
  "coldRun": {},
  "hotRuns": {}
}
```

### 11.3 Markdown 汇总必须包含

1. 数据快照与 license。
2. case 完成率与失败原因。
3. 官方质量指标。
4. RIE / CARC / token / cache / tool 指标。
5. 按语言、类别、context level 的分层结果。
6. 与 OCR / Claude Code / Codex 的可比性说明。
7. 已知限制与不参与比较的原因。

---

## 12. 分阶段落地计划

### M1：链路打通

交付：

1. 数据下载与 SHA-256 校验。
2. AACR 标准格式解析。
3. `manifest.json` 生成。
4. Java 子集 case 列表确定性排序。
5. mock judge 端到端运行。

验收：

```text
输入 case 数 = 输出 run 数 + 记录在 errors.jsonl 的失败数
reference_comments 未出现在任何模型请求
manifest 可复现生成
```

### M2：ReviewAgent adapter

交付：

1. `AacrEvaluationCase` 契约。
2. base/head checkout 与 unified diff 生成。
3. Finding → AACR result exporter。
4. A/E 配置接入现有 runner。
5. usage / tool / ledger / gate 审计透传。

验收：

1. Java 子集 A/E 完整跑通。
2. 官方 evaluator 能消费 ReviewAgent 输出。
3. 每个 case 都有审计文件。
4. 真值泄漏检查通过。

### M3：真实 judge 与消融

交付：

1. 真实 LLM judge 配置。
2. A / B / D / E 消融运行。
3. C 配置分层抽样运行。
4. RIE / CARC 报告。

验收：

1. judge 输出可复现率或一致性达到预设阈值。
2. 每个配置的 case 完成率不低于 98%。
3. 冷启动与热缓存指标分层输出。

### M4：全量公开基线

交付：

1. AACR full 200 PR 运行。
2. 10 语言分层报告。
3. ReviewAgent 与 OCR / Claude Code / Codex 对比。
4. 冻结版本报告。

验收：

1. 数据快照、模型、配置、代码 commit 完整记录。
2. 无选择性删除失败 case。
3. 对外结论同时给出质量与真实成本。

---

## 13. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| truth 是 review comment 而非严格缺陷 | 指标语义与内部基准不同 | 使用官方 semantic judge；不与逆补丁法直接合并 |
| 数据版本变化 | 结果不可比 | manifest 固定 SHA-256 与 framework commit |
| 多语言代码智能不足 | C1/C2 能力不均 | 分语言报告；先 Java，再扩展 parser |
| dev/report 泄漏 | 指标虚高 | 按项目切分；report 集冻结 |
| 真值泄漏 | 结果无效 | 输入构造白名单 + 自动扫描审计请求 |
| 全量运行成本高 | 预算失控 | 分层抽样先行；C 配置限量 |
| judge 不稳定 | 公开指标波动 | 固定 judge 模型与参数；抽样人工复核 |
| 缓存指标缺失 | 无法证明核心优势 | 所有 run 必须记录 request-level usage |
| AACR 无企业私有上下文 | 不能证明企业落地 | 保留内部 clean MR 与企业数据基准 |

---

## 14. 建议的后续 ADR

实施前建议补充两个 ADR：

1. **AACR-Bench 作为公开外部基线，而非唯一 benchmark**
   - 记录为什么不直接替代逆补丁法。
   - 记录公开指标与内部指标的关系。

2. **AACR 质量判定采用官方 evaluator**
   - 记录为什么不以 `screenFindings` 作为公开口径。
   - 记录 ReviewAgent 扩展指标的计算边界。

---

## 15. 最终判断

AACR-Bench 可以作为 ReviewAgent 的首个公开外部 baseline，而且与 ReviewAgent 的仓库级上下文假设高度匹配。

但它只能证明“公开真实 PR 上的 review 质量与泛化”，不能单独证明 ReviewAgent 的完整技术主张。

最终报告必须同时回答：

```text
Quality:
  Precision / Recall / F1 / Line Precision / Noise Rate

Efficiency:
  RIE / CARC / uncached tokens / output tokens / tool calls / latency

Architecture:
  C0–C3 usage / Context Ledger effect / cache stability / Evidence Gate effect
```

只有这三类指标同时成立，才能说明 ReviewAgent 相比 OCR 和通用 Agent 具备结构性优势，而不仅是单点质量提升。

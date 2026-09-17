# ReviewAgent Token 优化方案——以 20~30% Token 成本达到通用 Agent 检视效果

> **文首说明**：本文系统阐述 ReviewAgent 的 Token 优化方案：成本模型、四大机制（Context 优化 / Loop 优化 / Cache 优化 / Evidence Gate）、工程纪律与实证数据，回答核心问题——**如何让一次代码检视只花通用 Agent 20~30% 的 Token 成本，而检视质量不降**。机制描述以当前代码为准（POC1 冻结薄 harness 与 DSH 内核双运行时同一套纪律），实证数据取自 Phase 2 主数据（`docs/report/Phase 2 主数据分析报告.md`，2026-09-15）。术语遵循 `CONTEXT.md`。
>
> **一句话答案**：通用 Agent 的 Token 消耗 = 大上下文基数 × 多轮重发 × 全额计价；ReviewAgent 把三个乘子分别钉死——**Minimal Sufficient Context 压基数、Bounded Review Loop 钉轮数、Cache-Stable Loop 把重发部分按约 1/30 的缓存价计费**，再用 Evidence Gate 保证"省 Token 不是靠少报"。三个乘子相乘，20~30% 不是省出来的折扣，而是结构性结果。

---

## 1. 问题定义：通用 Agent 在检视场景的 Token 去向

代码检视任务的真实信息需求很窄：**看懂一次变更 → 判断风险 → 取证 → 给结论**。但通用 Coding Agent（Claude Code / OpenCode 类）围绕完整开发任务设计，其形态是"探索驱动"：

```text
通用 Coding Agent（检视任务实测姿势）
Search → Read → Search → Read → Plan → …（自由循环，轮数无上界）
工具面：search / read / grep / bash / ls / find / edit …（通用工具全集）
上下文：探索到哪读到哪（动态、无界、每次读取全文注入）
```

拆开它的 Token 账单，成本由四个乘性因子构成：

| 成本因子 | 通用 Agent 的行为 | 后果 |
|---|---|---|
| **① 上下文基数** | 为"理解仓库"自由探索，read 整文件、grep 全仓 | 单轮输入即达全仓量级 |
| **② 轮数放大器** | 每轮 LLM 调用都要**重发全部历史上下文**，N 轮 ≈ N × 基数 | 成本随轮数线性放大，而轮数本身无界 |
| **③ 计价全额** | 动态上下文不断插入/改写消息，前缀缓存反复失效 | 重复发送的上下文按未命中价全额计费 |
| **④ 输出与探索浪费** | 自由推理 + 无效探索路径全部计入输出 | 输出 Token 与思考过程一样无界 |

**关键洞察**：四个因子里没有一个是检视任务必需的。检视只需要 Diff + 少量符号/影响面上下文；推理路径可以被骨架化；重发的上下文可以字节稳定以命中缓存。ReviewAgent 的全部设计就是把这四个乘子逐一变成**有界、可预算、可审计**的量。

### 优化目标的双重定义（v2.0 起）

项目把成本目标从"Total Token Optimization"升级为：

> **Uncached Token Optimization + Cache Hit Optimization**

即同时做三件事：

```text
① 少发 Token          —— 压上下文基数（Context Engine）
② 少发 Uncached Token —— 钉死轮数与工具调用（Review Loop）
③ 提高 Prefix Cache Hit —— 让不可避免的重发按缓存价计费（Cache Engine）
```

质量侧的护栏是**配置 C（Full Repository 效果上限）**：让模型"看到一切"的姿势等价于通用 Agent 无限读上下文的效果上限，以它为质量主锚（S 级判据含 Precision ≥ C×100%，防止"省 Token 靠少报"，ADR-0004）。Claude Code 为跨模型外部参照，单列报告、不进主判定。

---

## 2. 总体框架：三优化、一闭环

```text
                     Review Agent
                          │
          ┌───────────────┼────────────────┐
          ↓               ↓                ↓
    Context Optimization  Loop Optimization Cache Optimization
     （压基数：看得少但够用） （钉轮数：想得少但深入） （降单价：发得少且命中高）
          │               │                │
          └───────────────┼────────────────┘
                          ↓
                   Evidence Verification
                   （质量地板：No Evidence, No Finding）
                          ↓
                    High-quality Review
```

三大优化与成本四因子一一对应：

| 成本因子 | 对抗机制 | 落点 |
|---|---|---|
| ① 上下文基数 | Minimal Sufficient Context（C0–C3 分级 + 确定性预取 + 四级预算） | 第 3 章 |
| ② 轮数放大器 | 六阶段骨架 + 双硬上界（MAX_ROUNDS=5 / MAX_TOOL_CALLS=6） | 第 4 章 |
| ③ 计价全额 | Zone A/B/C 字节纪律 + Context Ledger + Cache Break 观测 | 第 5 章 |
| ④ 输出浪费 | 阶段化 JSON 回复契约 + Evidence Gate（候选不过闸不产出） | 第 4、6 章 |

---

## 3. 机制一：Context 优化——看得少但够用

### 3.1 Diff-first，而不是 Diff-only

检视入口永远是 Diff（C0 层，必加载）。但只给 Diff 会漏掉深度问题（Caller / Callee / Call Chain / 事务边界 / 资源生命周期……），所以按需向符号层与影响面扩展，形成四级上下文分级：

```text
C0 Diff        —— 必加载：变更文件 / hunks / 行 / 变更符号
C1 Symbol      —— 按需：变更方法与类的签名级上下文
C2 Impact      —— 按需：Caller / Callee / 引用点 / 调用链
C3 Knowledge   —— 按需：CWD 缺陷模式库 / 历史检视 / 业务规则
```

加载深度由 Risk Class 决定（Low → C0+C1；Medium → +C2；High → +C3 + 强制证据核验）。**扩展是按需的，不是默认的**——这是与"全仓注入"（配置 C 把整个仓库塞进上下文）和"自由探索"（通用 Agent 自己决定读什么）的根本区别。

### 3.2 确定性构造：零 LLM、零构建、字节可复现

上下文生产本身不花 Token。Zone B（Repo Map + 签名级 Symbol Index）与预取管线全部是**静态确定性构造**（`src/zoneb/`）：

```text
tree-sitter-java → 签名级符号提取（不含方法体）
ripgrep          → 词法级引用匹配
文件读取         → 源码摘录（CRLF→LF 归一化）
```

三条纪律：

1. **零 LLM**：构造过程不经过任何模型调用——上下文本身没有 Token 生产成本，只有注入成本；
2. **零构建**：只依赖静态源码快照（ADR-0003，企业落地只有快照、无构建环境）；
3. **字节可复现**：排序遍历 + 仓库相对 POSIX 路径 + 无时间戳/绝对路径/环境信息；同一仓库状态 + 同一变更文件集合 → **字节级相同**的注入内容（有测试锁定）。

字节可复现不只是工程洁癖，它是第 5 章缓存命中的前提条件。

### 3.3 预算体系：四级预算 + 截断留痕纪律

所有上下文注入都受字符预算约束（POC1 无 tokenizer，以字符数为跨平台确定性代理，~4 chars/token）：

| 预算层 | 默认值 | 实现锚点 |
|---|---|---|
| Zone B（Repo Map 40% / 包结构 20% / Symbol Index 40%） | 16,000 chars（≈4K tokens） | `src/contracts/prefetch.ts`、`src/zoneb/zone-b-builder.ts` |
| 预取 Symbol 层 | 8,000 chars（≈2K） | `src/zoneb/prefetch.ts` |
| 预取 Reference 层 | 6,000 chars（≈1.5K） | 同上 |
| 预取 Call Chain 层 | 6,000 chars（≈1.5K） | 同上 |
| 单次工具结果 | 8,000 chars（≈2K） | `src/tools/result-budget.ts` |
| 全仓注入（仅配置 C 的对照组预算） | 80,000 chars（≈20K） | `src/zoneb/full-repo-injection.ts` |

对比之下：轻上下文主力形态（配置 B）的全部预取 ≈ 36K chars ≈ 9K tokens，而配置 C 的全仓注入预算 80K chars 只是**截断上界**（30 案实测均值 706.5k billed tokens/单元，见第 7 章——多轮重发放大后远超注入本身）。

**截断留痕纪律**（杜绝静默丢弃，`src/zoneb/budget.ts` / `src/tools/result-budget.ts`）：

- 截断只发生在条目（block）或行边界，不切断条目内部；
- 截断时在内容末尾追加确定性提示行（携带预算与截断规模），**可见于请求字节与审计**；
- 每层产出结构化 `PrefetchLayerRecord` 进审计（预算 / 实际字符数 / 截断与否 / 条目数）。

### 3.4 与通用 Agent 的本质差异

通用 Agent 的上下文获取是**模型自主的、事前无界的**：read 一个文件全文注入、grep 结果整段注入，直到模型自己觉得"够了"。ReviewAgent 把上下文获取拆成两半：

- **确定性预取**（循环开始前一次性注入）：Diff → Symbol → Reference → Call Chain 固定管线，不占工具预算、不占轮次；
- **受限自主检索**（循环内）：只能通过 7 个 `review.*` 工具按预算取数（见第 4 章），单次结果 8K chars 封顶。

---

## 4. 机制二：Loop 优化——想得少但深入

### 4.1 六阶段固定骨架：把自由循环变成受控管线

Review Loop 不是"Search → Read → Search → Read"的自由探索，而是**代码级强制的六阶段骨架**（`src/loop/phases.ts`，DSH 内核侧由策略驱动器强制，ADR-0006）：

```text
Change Understanding → Risk Classification → Context Decision
→ Context Retrieval → Deep Reasoning → Evidence Verification
```

- 阶段顺序固定、不可跳过、不可乱序；每个阶段一条字节稳定的阶段指令（"Phase N of 6 - …"），模型无法自行推进阶段；
- 每阶段回复契约是**单一 JSON 对象**（`{"summary": …}` / `{"riskClass": …}` / `{"candidates": […]}` …），杜绝自由长文本输出；
- 阶段内检索是 Evidence-driven 的：每次工具调用必须回答"我缺什么证据"（假设 → 缺证据 → 取证 → 更新假设 → 验证）。

这条骨架对 Token 的意义：**推理路径有界**。通用 Agent 的循环长度由模型当场决定（10 轮 20 轮都常见），ReviewAgent 的循环形状是常数级——一轮六阶段，`complete=false` 才开下一轮。

### 4.2 双硬上界：轮数与工具调用是骨架约束，不是配置项

```typescript
// src/loop/constants.ts
export const MAX_ROUNDS = 5;      // 轮 = 一次完整六阶段推进
export const MAX_TOOL_CALLS = 6;  // 整个 run 的工具调用总数上界
```

两条上界**不可通过 options 覆盖**——"单次检视成本有界"是骨架约束，不是调参项。执行语义（`src/loop/review-loop.ts`）：

- 工具预算耗尽：超预算调用不执行，物化为 `SKIPPED: tool call budget exhausted` 应答消息并强制收尾该阶段，`truncationReasons` 记 `TOOL_BUDGET_EXHAUSTED`；
- 轮数耗尽：`truncated=true` + `TRUNCATION_MAX_ROUNDS`，诚实截断进指标管线而非静默失败。

回顾成本公式：**轮数是线性放大器**（每轮重发全部上下文）。把轮数钉在 ≤5、工具调用钉在 ≤6，等于给"② 轮数放大器"上了硬顶。Phase 2 实测：多轮配置（C/D/E）平均 2.3–3.3 轮 × 6 次工具调用，轻上下文配置（A/B）平均 1.0–1.01 轮、0 次工具调用。

### 4.3 工具裁剪：7 个工具，数量/顺序/Schema 三固定

通用 Agent 挂载全量通用工具（每个工具的 schema 都是请求输入的一部分），Agent 容易"大量探索 → 大量 Tool Call → 大量 Token"。ReviewAgent 只挂 7 个专用工具（`src/tools/registry.ts`）：

```text
review.get_diff · review.get_symbol · review.get_file
review.find_references · review.get_call_chain
review.search_rule · review.search_history
```

注册表三重纪律：

- **数量固定**：工具名必须属于 `REVIEW_TOOL_ORDER` 固定清单，注册表之外的工具直接 fail fast；
- **顺序固定**：按固定顺序排序，杜绝工具顺序漂移破坏前缀；
- **Schema 字节固定**：parametersJson 由注册表统一经 `toCanonicalJson` 序列化（固定字段顺序），同一 schema 结构永远产出同一字节串。

工具面没有 bash / edit / write——检视是只读任务，写与执行类能力既无必要，又徒增 schema 字节与误用空间。

### 4.4 请求字节最小化：序列化纪律

wire 层（`src/deepseek/request-mapper.ts`）把请求字节压到最小且逐字节稳定：

- `temperature` / `top_p` / penalties **一律不传**（保持字节最小，也根除采样参数漂移）；
- effort 锁定单一档位（ADR-0002：DeepSeek 画像 = thinking enabled + reasoning_effort high），序列化按 provider 画像表分派，实验不可漂移；
- 无工具时请求不带 `tools` 字段（A/B 零工具配置字节最省）；
- 默认路径字节逐字节不变由 golden bytes 测试钉死。

### 4.5 Evidence Gate：质量地板

省 Token 最大的诱惑是"少报"——降 Recall 换成本。Evidence Gate 封死这条路（`src/gate/candidate-gate.ts`）：

```text
Candidate（阶段 5 产出，必须带证据：符号/行号/摘录）
 ↓
Evidence Verification（阶段 6 逐条核验：证据是否真的支撑结论）
 ↓
Candidate Gate（join 候选 × 裁决；无证据候选拒绝；跨轮去重：重提已发出的 id → DUPLICATE_ID）
 ↓
Finding（结构化输出：severity / category / file:line / evidence / rule / confidence）
```

**No Evidence, No Finding**。S 级判据同时含 Recall ≥ C×90% 与 Precision ≥ C×100%（ADR-0004），检出与精确双侧都不能塌——Token 压缩必须在完整质量面上成立。

---

## 5. 机制三：Cache 优化——发得少且命中高

前两章压的是"发多少"；本章压的是"发的部分按什么价计费"。

### 5.1 计价基础：DeepSeek 缓存语义

DeepSeek 官方 API 的上下文缓存（磁盘缓存 + 持久化单元**整匹**）与朴素直觉有三处关键差异，直接决定设计：

1. **整匹而非增量**：请求 A+B 缓存后，A+C 不命中 B 的部分；但公共前缀 A 会被持久化，供后续 A+D 命中。**稳定前缀的价值在"跨请求复用同一前缀"**；
2. **账号级共享、best-effort**：闲置数小时至数天清除；跨会话前缀复用需 ≥2 次共享请求才会持久化公共前缀；
3. **计量与价格**：usage 报告 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；**缓存命中价格约为未命中的 1/30**——这是"缓存优先"命题的收益基础。

推论：在多轮 Loop 里，第 N+1 轮的输入 = 第 N 轮输入 + 新增后缀。只要前缀字节不变，重发的部分几乎全部按 1/30 计价。**Cache 命中率就是把成本公式的乘数从 1 换成约 (hit + miss/30)**。

### 5.2 Zone A/B/C：把请求组织成"越靠前越稳定"的三层

一次模型请求的字节布局（`src/loop/messages.ts`）：

```text
┌────────────────────────────────────────────────┐
│ Zone A  STABLE PREFIX（同 harness 版本内字节恒定）│
│  system：检视角色 / 六阶段方法论 / Finding Schema │
│  / Severity 定义 / Evidence Policy / 回复纪律    │
│  + 工具 schema（7 个 review.*，canonical 序列化） │
├────────────────────────────────────────────────┤
│ Zone B  SEMI-STABLE（同仓多次检视间字节稳定）     │
│  Repo Identity / Repo Map（目录树+包结构）       │
│  / Symbol Index（按变更文件所在包圈定）          │
├────────────────────────────────────────────────┤
│ Zone C  DYNAMIC（run 内 append-only）            │
│  初始 user（MR：caseId + issue 描述 + diff）     │
│  → 预取层（Symbol/Reference/Call Chain，若有）   │
│  → 阶段指令 / 工具调用与结果 / 助手回复（只追加） │
└────────────────────────────────────────────────┘
```

三层各自的稳定纪律：

**Zone A——字节稳定**。system prompt 不含任何 run 特定数据（caseId / diff 都在 Zone C），同一 harness 版本内所有请求共享同一字节；工具 schema 数量/顺序/序列化三固定。Zone A 稳定由纪律门测试锁定（CI 内 9 件套断言，`vitest.gate.config.ts`）。

**Zone B——快照稳定**。纯静态确定性构造（§3.2）；同仓状态 + 同圈定范围 → 字节相同。同一仓库的连续多次检视共享 Zone B 前缀，跨检视复用缓存。

**Zone C——append-only**。消息构造严格只追加、不重排、不改写：

```text
Turn 1  [Zone A][Zone B?][Diff]
Turn 2  [Zone A][Zone B?][Diff][阶段1…][阶段2…]
Turn 3  [Zone A][Zone B?][Diff][阶段1…][阶段2…][阶段3…]   ← 只在尾部增长
```

循环状态全部用不可变数据结构传递（`readonly` 数组 + spread 追加），代码形态上就不存在"改写历史消息"的路径。

### 5.3 Context Ledger：重复读取返回引用，不返回原文

多轮推理中模型经常反复请求同一内容（`FooService.java:100-180` 读三遍）。Context Ledger（`src/tools/ledger.ts`，配置 E）在工具结果层去重：

```text
第 1 次 review.get_file("FooService.java", 100, 180)
→ 返回原文（带行号），登记 ctx#001
第 2 次同一规范化请求
→ 返回 "Already loaded: ctx#001 (review.get_file src/…/FooService.java:100-180)"
```

双重价值：

- **减输入**：重复读取不再注入原文，直接省 Token；
- **保稳定**：不引入新的动态内容，前缀结构不被扰动。

读取失败不登记（错误不是上下文，重试仍走真实读取）；惰性态账本（A/B/C/D）永不命中、行为与无账本完全一致——保证 A–E 配置对比不受实现渗透污染。

*实证注记（诚实声明）：Phase 2 主数据上账本机制方向性为负（E 的 recall 三侧一致低于 D），本基准无正向收益；机制保留为形态开关，收益与否由消融数据说话，不预设结论。*

### 5.4 Cache Break Detection：命中率波动可归因

run 结束时对相邻请求做**纯观测**的字节前缀分歧检测（`src/loop/cache-break.ts`，绝不改请求字节）：

```text
model 段分歧        → MODEL_CHANGED
messages[0] 分歧    → SYSTEM_PROMPT_CHANGED（Zone A）
messages 中段分歧   → CONTEXT_REORDERED（Zone B/C）
tools 段分歧        → TOOL_SCHEMA_CHANGED（Zone A）
```

前缀语义：下一请求是前一请求的前缀（append-only 增长或收缩）**不构成 break**——前缀缓存对"新请求 ⊂ 旧请求"仍全额命中，命中率波动只能来自稳定前缀被破坏。分类随审计留痕（`RunAudit.cacheBreaks`），供报告/dashboard 归因"为什么这一次检视的 Cache Hit 突然下降"。

### 5.5 冷/热分层报告协议

缓存是 best-effort 的，报告必须分层（否则测量伪影污染结论）：

```text
rep1（冷启动）   → 单列报告，不计入主口径
rep2+（热稳定）  → 均值 ± 标准差，主口径
```

单发配置重复运行的命中率含"同一请求重复即命中"伪影，冷成本与热均值必须分开呈现。S/A/B 判定全部取 rep2+ 热口径。

---

## 6. 成本-收益的量化账本

### 6.1 Token 记账口径（全显式）

`src/metrics/tokens.ts`：

```text
uncachedInputTokens = usage.inputTokens        （prompt_cache_miss_tokens）
cachedInputTokens   = usage.cacheReadTokens    （prompt_cache_hit_tokens）
cacheWriteTokens    = usage.cacheWriteTokens   （DeepSeek 通常 0，计入总输入）
totalInputTokens    = 三者之和
totalTokens         = totalInputTokens + outputTokens
cacheHitRate        = cachedInputTokens / totalInputTokens
```

指标按 provider 画像分口径（ADR-0008）：无缓存计量的模型 cacheHitRate 记 **N/A 而非 0**（未知 ≠ 无命中），CARC 记保守上界。

### 6.2 两个派生效率指标

```text
RIE = Recall × Precision / (Total Tokens / 1K)     ← 单位 token 的检视智能
CARC = Uncached Input + Cache Write + Output + Tool Cost   ← 真实计费成本
```

- **RIE**（Review Intelligence Efficiency）：核心质量-成本效率指标，防"高 recall 高 token"与"低 token 零产出"两种伪优；
- **CARC**（Cache-adjusted Review Cost）：缓存命中不计价、工具成本（`fixedCostPerCall × 次数 + costPerResultChar × 结果字符数`，从 `toolCallLog` 账本直接消费）计入——**优化对象是真实账单，不是名义 token 数**。

### 6.3 成本公式与三大杠杆的合流

```text
检视计费成本
≈ 首请求输入（全未命中）
+ Σ后续轮次（仅新增后缀未命中）      ← Cache Engine 把这里压到 1/30 价
+ Σ输出                             ← Loop Engine 钉死轮数与回复契约
+ 工具成本                          ← 工具裁剪 + 结果预算封顶
```

三大机制分别作用于不同项：Context Engine 压每一项的基数，Loop Engine 压 Σ 的项数，Cache Engine 压重发部分的单价。**乘性叠加**——这就是 20~30% 是结构性结果而非优化折扣的原因。

---

## 7. 实证数据：Phase 2 主数据（30 案 × A–E × 3 rep = 450 单元/侧）

### 7.1 五配置实验矩阵（每个机制单独归因）

| 配置 | 形态 | 验证什么 |
|---|---|---|
| A | 零工具，纯 MR（Diff）上下文 | 最低成本基线：diff-only 到底够不够 |
| B | A + 确定性预取（Zone B + 固定管线） | 精准上下文的增量价值 + 预取的缓存红利 |
| C | 全仓注入 + 7 工具 | **效果上限/质量主锚**（"让模型看到一切"的姿势） |
| D | B 思路 + 自主检索 + 稳定前缀 | Prefix 稳定性对缓存的影响 |
| E | D + Context Ledger + Append-only | 完整 Cache 策略 |

### 7.2 主表（judge 口径，每配置 90 单元均值，main 侧）

| config | lineRecall | linePrecision | lineF1 | totalTokens | cacheHitRate | RIE | CARC |
|---|---|---|---|---|---|---|---|
| A（零工具） | **0.5008** | 0.7232 | 0.5524 | **22.6k** | 0.3678 | **0.0242** | 18.4k |
| B（+确定性预取） | 0.4671 | **0.7835** | **0.5763** | 49.9k | 0.8114 | 0.0105 | 19.8k |
| C（+全仓注入） | 0.1341 | 0.6349 | 0.5712 | 706.5k | **0.9249** | 0.0014 | 105.1k |
| D（+自主拉取+稳定前缀） | 0.2916 | 0.7226 | 0.6257 | 178.0k | 0.7769 | 0.0055 | 60.5k |
| E（D+账本） | 0.2355 | 0.569 | 0.5196 | 204.6k | 0.7981 | 0.0049 | 63.1k |

### 7.3 对照目标的达成度

**Token 侧——远超 20~30% 目标**：

- 设计目标：S 级 Token ≤ 配置 C × 30%；
- 实测：B = 49.9k / C = 706.5k = **C 的 7.1%（约 1/14）**；A = 22.6k = **C 的 3.2%**；CARC 口径 B（19.8k）仅为 C（105.1k）的 18.8%；
- 通用 Agent 姿势的对照：配置 C 就是"上下文无界给足"的姿势（706.5k/单元），通用 Agent 在检视任务上再加自由探索与多轮重发，成本只高不低。

**质量侧——不是"不掉"，是反超**：

- B 的 judge F1（0.5763）> C（0.5712），precision（0.7835）> C（0.6349）；A 的 recall（0.5008）是 C（0.1341）的 3.7 倍；
- B 在三侧（main/noise/dsh）判 **S 级**（四判据全过且余量巨大：热口径 recall 0.1044 vs 门槛 0.0087、token 49.6k vs 上限 207.2k、cacheHit 0.8782 vs 门槛 0.85）。

**缓存侧——命中目标兑现**：

- B 热口径 cacheHit **0.8782** ≥ 85% 门槛：确定性预取（固定管线顺序、字节稳定注入）把命中率拉高 44 个百分点（A 0.3678 → B 0.8114 总口径），命中部分按约 1/30 计价——这是 B 的 CARC（19.8k）远低于其 totalTokens（49.9k）的原因。

### 7.4 必须如实呈现的 caveat

1. **锚塌缩**：C（全仓注入）在本基准（VUL4J 单缺陷 MR）上实证塌缩——recall 最低、token 最贵（A 的 31 倍）、77% 单元零 finding。S 级判据以 C 为比例锚，门槛随之失真；"B=S"的实证内核是 **B 热召回超 C 锚 2.2–10.8 倍（三侧）且 token 仅为 C 的 1/14**，论文引用须连同本注记。
2. **全仓注入的边际信息收益为负**：在本基准场景，把仓库塞满上下文把模型淹没——上下文重组成噪声源而非证据源。这反过来支撑了 Minimal Sufficient Context 命题，但结论的作用域是"单缺陷中小 MR"。
3. **账本机制方向性为负**（E vs D，三侧一致），自主拉取配置（D）跨侧不稳定（recall 极差 0.1039）——机制保留、结论由消融数据说话，不预设叙事。
4. **场景边界**：POC1 锁定 Java 单语言、中小 MR（≤10 文件、diff ≤2K 行）、单遍自证为底线；大 MR 切分、多语言适配、二遍 Verifier 均为后续阶段/消融项。

---

## 8. 与通用 Agent 的结构性对照

| 维度 | 通用 Coding Agent | ReviewAgent |
|---|---|---|
| 上下文策略 | 自由探索，事前无界 | Diff-first + C0–C3 按需分级，四级预算封顶 |
| 循环形态 | 自由循环，轮数由模型决定 | 六阶段骨架代码级强制，轮 = 常数级（≤5） |
| 工具面 | 通用工具全集（含写/执行） | 7 个只读 `review.*`，数量/顺序/Schema 三固定 |
| 消息历史 | 动态构造，探索路径随意插入 | Zone A/B/C 三层字节纪律，Zone C 严格 append-only |
| 重复读取 | 每次返回原文 | Context Ledger 返回 `Already loaded: ctx#001` 引用 |
| 计价意识 | 命中率被动接受 | CARC 口径主动优化；命中率 85%+ 为设计判据 |
| 成本可预算性 | 事前不可预算（无界） | 单次检视成本有界（硬上界不可配置）+ 审计全留痕 |
| 质量地板 | 无显式证据约束 | Evidence Gate：No Evidence, No Finding |

一句话：通用 Agent 用"更多 Context + 更长 Loop + 通用 Tool"买强通用能力；ReviewAgent 用"最小充分 Context + 专用骨架 + 稳定前缀 + 账本 + 证据闸"买**单位 Token 的检视智能（RIE）**——实测 A 的 RIE 是 C 的 17.3 倍。

Claude Code 作为**跨模型外部参照**单列（`pnpm reference`，同仓同 diff 同目标、只读工具白名单 Read/Grep/Glob、归一化后走同一 metrics 管线），不进 S/A/B 主判定（模型不同源，跨配置比较无意义）。

---

## 9. 工程纪律：方案不靠自觉，靠强制

Token 优化方案最脆弱的环节是"纪律随时间漂移"。本方案的可维护性来自**纪律的代码级与 CI 级强制**：

1. **硬上界不可配置**：`MAX_ROUNDS` / `MAX_TOOL_CALLS` 是冻结常量，无 options 覆盖路径；
2. **Zone A 字节稳定进 CI**：确定性纪律门（`vitest.gate.config.ts`，具名 job `discipline-gate`）在**零网络拦截环境**下断言——Zone A 字节稳定、无变更零 Cache Break、审计可重放（wire 字节反解重建请求逐字段等价）、六阶段骨架与两上界在事件流中可验证、Evidence Gate 生效；
3. **截断必留痕**：所有预算层超限截断在条目/行边界 + 确定性提示行 + 结构化审计记录，静默丢弃无实现路径；
4. **双运行时同纪律**：POC1 冻结薄 harness 与 DSH 内核（`packages/review-dsh/`）的 Zone A 字节由 parity 测试锁定逐字节一致（`zone-a-parity.test.ts`），wire 序列化由双包 parity fixtures 锁定——换运行时不换口径；
5. **审计可重放**：每次 run 落全量请求字节（`parametersJson` / `wireBody`）+ usage 记账 + 工具调用账本 + 预取层记录 + Cache Break 分类，指标可从审计独立复算（复算脚本一键重放，报告无手抽数字）；
6. **不可变状态**：循环状态全部 `readonly` + spread 追加，"改写历史消息"在类型层就不存在。

---

## 10. 方案的适用边界与后续演进

**适用域**（当前实证支持的边界）：单语言（Java）、中小 MR（≤10 文件 / diff ≤2K 行）、静态源码快照（零构建）、单缺陷引入类变更。在此域内，轻上下文配置以 3~7% 于全仓注入的 token 取得更高的 F1/Recall。

**后续演进**（按既定阶段）：

- **Cache-aware Model Routing**：模型分数 = Quality + Cost + Cache Warmth，切换模型对前缀复用的杀伤（新消息序列）纳入路由决策；
- **Review Evidence Compaction**：长会话压缩只保留已验证 Finding/证据/未决问题，且摘要落在消息流中部、不重写请求前部（DSH compaction seam）；
- **C3 Knowledge（CWD 缺陷模式库）**：领域知识按 Risk Class 注入，Knowledge Engine 反哺检视质量；
- **大 MR 切分、二遍 Verifier（消融开关）、多语言适配**：均带独立指标门后再进主线。

**结论**：ReviewAgent 的 Token 优化不是单点技巧，而是一条从成本模型出发、由三大机制乘性叠加、被工程纪律锁死、经 450 单元 × 三侧实证的完整方案——**以 20~30% 的 Token 成本达到通用 Agent 的检视效果是设计目标，实测（B 配置：C 的 7% token、更高 F1、87.8% 热缓存命中）已经超过这一目标；其成立条件是检视任务的真实信息需求远小于通用开发任务，而专用 Runtime 把这一需求差转化为结构性成本差。**

---

## 附：机制 → 实现 → 指标 对照索引

| 机制 | 实现锚点 | 观测指标 |
|---|---|---|
| Zone A 稳定前缀 | `src/loop/messages.ts`（SYSTEM_PROMPT / buildInitialMessages）、`src/tools/registry.ts`（canonical schema） | Cache Break 计数（SYSTEM_PROMPT_CHANGED / TOOL_SCHEMA_CHANGED = 0） |
| Zone B 确定性构造 | `src/zoneb/zone-b-builder.ts`、`src/zoneb/repo-context.ts` | PrefetchLayerRecord（zone-b 层） |
| 确定性预取管线 | `src/zoneb/prefetch.ts`、`src/contracts/prefetch.ts`（16K/8K/6K/6K） | cacheHitRate（B 热口径 0.8782） |
| 全仓注入对照 | `src/zoneb/full-repo-injection.ts`（80K 上界） | FullRepoRecord、C 配置 token 总账 |
| 六阶段骨架 + 双上界 | `src/loop/phases.ts`、`src/loop/constants.ts`、`src/loop/review-loop.ts` | rounds / toolCalls / truncationReasons |
| 工具裁剪 | `src/tools/registry.ts`（REVIEW_TOOL_ORDER）、`src/tools/toolkit.ts` | toolCalls（≤6） |
| 工具结果预算 | `src/tools/result-budget.ts`（8K chars） | toolCallLog（截断留痕） |
| Context Ledger | `src/tools/ledger.ts`（"Already loaded: ctx#NNN"） | Ledger 快照、E vs D 消融 |
| Append-only 纪律 | `src/loop/review-loop.ts`（不可变状态）、`src/loop/messages.ts` | Cache Break（CONTEXT_REORDERED = 0） |
| Cache Break 观测 | `src/loop/cache-break.ts` | RunAudit.cacheBreaks 四分类计数 |
| Evidence Gate | `src/gate/candidate-gate.ts`、`src/loop/phases.ts`（阶段 5/6 契约） | rejections（含 DUPLICATE_ID）、precision |
| Token 记账 | `src/metrics/tokens.ts`、`src/loop/usage.ts` | TokenMetrics 全字段 |
| RIE / CARC | `src/metrics/efficiency.ts` | RIE、CARC（含工具成本计价） |
| 序列化纪律 | `src/deepseek/request-mapper.ts`（锁定档、不传采样参数） | golden bytes 测试、wire parity fixtures |
| 判定协议 | ADR-0004（S 级四判据）、`src/metrics/verdict.ts` | S/A/B 判定（rep2+ 热口径） |

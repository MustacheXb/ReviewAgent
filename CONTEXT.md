# Review Agent

基于 DeepSeek Harness 的低 Token、高质量代码检视 Agent：用最小充分上下文与缓存稳定循环，以 20~30% 的 Token 成本获得接近全量上下文的检视质量。终点是落地到企业内部代码托管平台的 MR 检视。

## Language

### 上下文

**Minimal Sufficient Context**:
能支撑正确 Review 判断的最小上下文集，介于 Diff-only 与全仓之间。
_Avoid_: 精简上下文、恰好够用的上下文

**Diff-first**:
以 Diff 为检视入口、按需向符号层与影响层扩展的取上下文方式；明确区别于只看 Diff。
_Avoid_: Diff-only

**C0–C3**:
四级上下文分级：C0 Diff、C1 Symbol、C2 Impact、C3 Knowledge；按风险逐级加载。

**Context Ledger**:
本次检视会话已加载上下文（文件/区间/符号/证据）的登记账；重复请求返回引用而非原文。
_Avoid_: 上下文缓存（与前缀缓存混淆）

**Stable Prefix（Zone A）**:
一次模型请求中字节级稳定不变的头部：检视角色、政策、工具与输出 Schema。
_Avoid_: 系统提示词（过窄，仅指角色描述）、Immutable Prefix

**Zone B**:
同一仓库的多次检视之间字节稳定的中层上下文：repo 身份、Repo Map、Symbol Index、项目规则。
_Avoid_: 半稳定上下文（语义模糊）

**Repo Map**:
Zone B 中的仓库结构视图（目录树与包/模块结构），静态确定性生成，不经过 LLM。
_Avoid_: 仓库摘要（暗示 LLM 生成）

**Symbol Index**:
签名级符号索引（不含函数体），按变更文件所在包/模块圈定范围，静态确定性生成。

**Append-only Context（Zone C）**:
动态上下文只追加、不重排、不改写的构造纪律。

**Cache-Stable Review Loop**:
消息构造始终维持前缀稳定的检视循环。

### 检视

**Review Runtime**:
运行检视循环的专用执行环境（检视提示词、工具策略、状态、事件），区别于通用 Coding Runtime。
_Avoid_: Coding Runtime 复用

**Finding**:
一条结构化检视结论，含严重级、类别、文件/行位置、描述、证据、规则与置信度。
_Avoid_: 评论、告警、issue（泛化）

**Evidence**:
支撑一条 Finding 的可验证材料：具体符号、行号与代码摘录。

**Evidence Gate**:
"No Evidence, No Finding"——没有证据的候选结论不得作为 Finding 产出。

**Risk Class**:
变更的风险分级（Low / Medium / High），决定 C 级上下文加载深度与证据等级。

**分片（Shard）**:
超界 MR 经切分产出的子 MR：同仓同 base 的子 diff，规模须落回验证域；每片独立走标准检视管线，片间不共享会话状态。
_Avoid_: 子任务（不是任务分解）、chunk（与上下文分块混淆）

**合并层（Merge Layer）**:
把多片 Finding 合并去重为单份检视结果的骨架外编排组件。
_Avoid_: 聚合（未含去重语义）

**输出语言（Output Language）**:
检视输出自然语言的配置（"en" | "zh"）：只切换 Finding 的自然语言字段与人读文本；代码摘录、路径、标识符与枚举值不随语言变化。
_Avoid_: 中文化（暗示全字段翻译）、本地化（含日期/格式化语义）

### 运行时边界

**核内（Review Runtime）**:
检视会话运行时的全部行为：loop 策略、`review.*` 工具、C0–C3 上下文决策、缓存纪律、检视政策与 Evidence Gate；以 DSH 插件形态挂在 DSH 插件树。
_Avoid_: DSH 组件（粒度混淆）、全部组件插件化（核外不入树）

**策略驱动器（Review Driver）**:
核内 review-runtime 插件中代码级强制六阶段骨架的组件：只有它能推进阶段（一阶段 = 一回合），回合边界执行 Evidence Gate 与轮次调度。
_Avoid_: 自定义 Loop（指 setFactory 替换内核 loop，已否）、提示词纪律（骨架不是提示词约定）

**核外（研究工具链）**:
服务于实验而非检视会话的层：数据集构造、判定链、指标聚合、实验运行器、外部参照；普通库被 CLI 调用，不进 DSH 插件树。
_Avoid_: 实验插件

### 知识

**CWD**:
从历史缺陷挖掘出的本项目常见缺陷模式库（项目私有版缺陷模式规则，知识 L2 层）。
_Avoid_: CWE（那是通用公共分类）

**DTS**:
缺陷跟踪系统（Jira/Bugzilla 类），Knowledge Engine 的缺陷数据源之一。

### 度量

**RIE**:
Review Intelligence Efficiency：Recall × Precision / Total Tokens，核心质量-成本效率指标。

**CARC**:
Cache-adjusted Review Cost：非缓存输入 Token + 输出 Token + 工具成本的真实成本口径；provider 无缓存计量字段时按全输入未命中计价的**保守上界**（真命中率越高，真实成本只会更低，ADR-0008）。
_Avoid_: 把上界当真实成本混比（无计量侧方向已知偏高）

### 模型接入

**被测模型（reviewer）**:
实验的自变量侧 LLM：model id 走请求参数双路径（POC1/实验 CLI `--model`（`flash`/`pro` 别名保留）；DSH 内核经 JSON-RPC `review/run` 参数 / `review-agent` CLI `--model` 旗标，#45），无 model 环境变量；url / key 经角色命名环境变量（`REVIEWER_*` > 旧 `DEEPSEEK_*`，`.env.local` 自动装载且双 CLI 同语义——已有环境变量优先，#46）；进 manifest / 审计留痕（model + baseUrl，绝不记 key，ADR-0008）。自定义网关换端点/模型先用 `review-agent smoke` 冒烟自证（双探针 + 人话诊断，#46）。
_Avoid_: 检视模型（与 judge 混淆）、白名单模型（准入白名单已由画像表取代）、model 走环境变量（实验数据走请求，秘密才走环境）

**参数画像（Provider Profile）**:
模型 id pattern → wire 序列化策略（thinking 字段 / completion 信封）+ usage 能力声明（有无缓存计量）的单源查表（review-llm）；未知模型回落保守默认档（ADR-0008）。
_Avoid_: 画像当 endpoint 配置（「怎么说话」与「连到哪」两轴正交）

**指标分口径（capability-scoped metrics）**:
指标按画像 usage 能力声明分派：无缓存计量的 provider 记 Cache-Hit-Rate 为 N/A、CARC 为保守上界（ADR-0008）。
_Avoid_: N/A 当 0（未知 ≠ 无命中）

**异构（Heterogeneity）**:
判定链要求 judge 与被测模型不同源：精确同 id 或同已知 provider 家族即视为同源；同源 + 双侧官方端点拒绝，任一侧自定义接入点在场降级 warning（实验者自证责任）。
_Avoid_: 只看 provider 名是否相同（家族按 id 前缀判定）

### 基准

**逆补丁法（Inverse-Patch）**:
以修复补丁的逆 diff 构造"引入缺陷的 MR"的基准构造方法：base 为修复后版本，合入后即历史真实 buggy 版本，真值为最小修复补丁的行位与性质。
_Avoid_: 缺陷注入（暗示合成篡改）、SZZ 挖掘（是被否的替代路径）

**合成组合（Synthetic Composition）**:
把同一仓库多个案例的 diff 合并为一枚超界 MR 的验证数据构造方法：真值为各案例真值的并集，规模不足时以良性填充补足。
_Avoid_: 数据增强（ML 泛术语，未含真值语义）、跨仓组合（不可行——MR 必须落单仓快照）

**良性填充（Benign Padding）**:
合成组合中用于把规模撑过验证域边界的确定性良性变更：对快照内与案例文件不相交的文件做机械编辑（注释、javadoc、局部重命名、日志语句），不含真值。
_Avoid_: 缺陷注入、复制放大（真值密度虚高，被否）

**验证域（Validated Domain）**:
质量结论所锚定的输入域：≤10 文件、diff ≤2K 行（与数据集边界过滤同源）；超界输入不在已验证范围内。
_Avoid_: 边界（未指明验证语义）、支持范围（是证据边界，不是产品能力上限——超界由切分处理）

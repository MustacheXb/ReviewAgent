# 被测模型可换：OpenAI-compatible 契约、参数画像表与按 provider 能力分口径的指标（部分取代 ADR-0002）

两个真实诉求推动被测模型脱离代码钉扎（spec #40）：部署侧要把 ReviewAgent 接到企业内部 OpenAI-compatible 网关（自有 url/key/model），研究侧要让被测模型成为实验变量（Qwen、MiniMax 与 DeepSeek 对比 RIE/CARC）——此前模型白名单逻辑复制在五处以上，DSH 路径甚至硬编码单一模型。落地序列：#41（共享包 review-llm 立缝）→ #42（judge 链自定义 endpoint，画像表首个消费者）→ #43（reviewer 自由 id + 指标分口径 + golden bytes 硬门槛），本 ADR 成文记录已验证的设计。ADR-0002 保留为 DeepSeek 基线实验的依据（缓存计量的选择理由、实验内锁定同一模型的可比性主张、账号级缓存特性），本 ADR 取代其「代码层模型准入白名单」部分。

## 决策

- **契约边界**：只承诺 OpenAI-compatible（`/chat/completions` + Bearer）。不做多协议适配层——企业网关均为 OpenAI 兼容形态，适配层是无真实消费者的投机泛化。
- **配置面**：model 经 CLI flag 传任意 id（`flash` / `pro` 别名保留，退役 id 拒绝）；url / key 只经环境变量，角色命名（`REVIEWER_URL` / `REVIEWER_API_KEY` 与 `JUDGE_URL` / `JUDGE_API_KEY`），旧 provider 命名（`DEEPSEEK_*` / `OPENAI_*`）保留为兼容别名，新名优先；优先级 显式参数 > env > 默认。run manifest（plan.json）记 model id + base URL 留痕（「连到哪」），**绝不记 key**；分析层按 model 分组、不跨模型混比。
- **参数画像表**（review-llm `profileOf`，单源查表）：模型 id pattern → 画像三维度——① thinking 字段序列化（`deepseek-*` → enabled + reasoning_effort high；其余不发）；② completion 信封（`glm-*` → 32768，默认 8192，`deepseek-*` 不序列化 max_tokens）；③ usage 能力声明（`deepseek-*` / `glm-*` 有缓存计量，默认无）。未知模型回落保守默认画像：不发 thinking 字段、标准信封、不假设缓存计量——新模型至少不 400、不静默截断。画像只描述「怎么和这个 provider 说话」，与 endpoint / key 解析（resolver，#41）两轴正交；先不做显式 `--profile` override。
- **指标按 provider 能力分口径**（画像 `usage.cacheMetering` 驱动）：
  - **Cache-Hit-Rate**：画像声明有缓存计量 → 照常计算（cached / 总输入，分母 0 → null）；声明无缓存计量 → **记 N/A（null）**——未知 ≠ 0，provider 不上报缓存字段时误报 0 会污染跨模型对比；model 缺省（旧记录 / 无模型信息的调用方）→ 旧口径不变。
  - **CARC**：恒可算。无缓存计量时 cached 记 0 → CARC = 全输入按未命中计价的**保守上界**——真命中率越高，真实成本只会更低、不会更高；方向性安全使其可与其他模型并列呈现而无需 N/A。
  - RIE / Recall / Precision 走标准 usage 字段，不受画像影响。
- **DeepSeek 默认路径请求字节逐字节不变（发布硬门槛）**：golden bytes 回归测试（`tests/deepseek/golden-bytes.test.ts`）锁定缺省模型的请求字节；画像分派只作用于已知非 DeepSeek 前缀与显式自定义 id，缺省路径序列化与白名单时代完全一致——本次改造对既有实验可比性零影响。

## Considered Options

- **白名单继续扩展**（每加一个模型改五处代码） / **自由 id + 画像表**——被选后者：模型怪癖集中一处登记，加模型 = 加表条目 + 测试（spec #40 用户故事 21）。
- **多协议适配层** / **只承诺 OpenAI-compatible**——被选后者：无真实消费者的投机泛化。
- **未知模型报错** / **保守默认画像**——被选后者：接入即用，不 400、不静默截断（spec #40 用户故事 9）。
- **无缓存计量记 0** / **记 N/A + CARC 保守上界**——被选后者：0 是误导性数字（污染跨模型对比），N/A 如实声明能力缺失；CARC 保守上界方向性安全，无需 N/A。
- **wire 序列化器也进共享包** / **留在各自包内 + parity 测试钉字节一致**——被选后者：尊重 ADR-0006 的字节审计主张（spec #40 实现决策；双包 parity 落 #45）。
- **字节不变靠人工 review** / **golden bytes 回归测试**——被选后者：可发布的硬门槛必须是机器可判定的（spec #40 用户故事 16/17）。

## Consequences

- **跨模型对比的口径前提**：Cache-Hit-Rate 只在画像声明缓存计量的模型间可比，N/A 与数值不混比；CARC 跨模型恒可比，但无计量侧按保守上界偏高（方向已知，读者可解释）。
- **画像表成为 provider 怪癖的唯一登记处**：新 provider 的 thinking 字段 / 信封 / 缓存计量差异改一处生效双路径（POC1 直连 + DSH 内核通道，#45 接入）。
- **异构判定的对照系升级**：judge 与被测同源判定以被测模型为对照系（精确同 id 或同已知 provider 家族）；同源 + 双侧官方端点启动即拒（exit 2，不烧检视预算），任一侧自定义接入点在场降级 warning（异构性转为实验者责任）——判定链「与被测不同源」的既有要求（spec #1 用户故事 25）在模型自由度下的维持方式。
- **ADR-0002 的角色收窄**：「主力锁定 deepseek-v4-flash」语义收窄为实验对比的缺省主力与别名锚；模型准入由画像表的保守回落兜底，不再需要代码层白名单。
- **能力底线不变**：function calling 为核内硬依赖（`review.*` 工具），自定义模型必须支持，不做无工具降级模式；400 类错误映射为可诊断信息（「该模型 / 网关可能不支持 function calling 或画像不匹配」）。
- DSH 内核通道（#45：JSON-RPC model 下传 + 双包 parity）、收尾（#46：`.env.local` 扩展 + 冒烟命令）与真网关验收（#47：火山 Qwen / MiniMax）随后落地；Claude Code 外部参照的模型配置仍 out of scope。

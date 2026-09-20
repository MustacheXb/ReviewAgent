在你增加了一个很重要的前提——**未来不考虑把 ReviewAgent 的 Runtime 复用到其他 Agent、其他产品或其他 Harness**——之后，我的推荐会发生变化：

> ## **我更建议选 Pi，而不是 DSH。**
>
> 如果按你的具体场景做权衡，我会给出大约 **Pi 70% / DSH 30%** 的倾向。

核心原因不是 Pi “更强”，而是：

> **当“长期复用 Harness 能力”不再是目标时，DSH 最大的优势——极强的插件化、可组合 Runtime、可替换 Harness Spine——价值会明显下降；这时更应该优先考虑“用最少的工程成本，把一个专用 ReviewAgent 做深、做稳、做出来”。**

下面我重新从你的真实目标出发，做一次完整比较。

---

# 1. 先重新定义选择问题

你的项目现在其实不是在选：

> “哪个 Agent Framework 更先进？”

而是在选：

> **“哪个内核最适合做一个封闭、专用、面向代码检视的 Agent 产品？”**

你的 ReviewAgent 目标已经非常明确：

```text
GitHub / GitLab PR
        ↓
Git Diff
        ↓
Minimal Sufficient Context
        ↓
Review Reasoning
        ↓
Evidence Verification
        ↓
Inline Finding / Quality Gate
```

同时要求：

```text
低 Token
低 Tool Call
高 Cache Hit
低延迟
支持多模型
支持企业集成
长期稳定维护
```

而你现在又明确：

> **不考虑未来把 ReviewAgent Runtime 再抽象给其他 Agent 使用。**

那么选择逻辑就变成：

> **谁能用最少的额外工程，把这套闭环做成一个稳定产品？**

在这个问题上，我会倾向 Pi。

---

# 2. 为什么“取消复用”会改变选择结果？

之前我偏向 DSH，很大原因是它有非常漂亮的：

```text
Plugin
Agent
Agent Loop
Session
Prompt
Tool
LLM
```

可替换架构。

DSH 当前官方就是 **everything is a plugin**，而且 `agent` 与 `agent-loop` 明确分离，默认 Loop 可以替换；Session、Prompt、Tools 等也都是独立的系统能力。([GitHub][1])

如果你的目标是：

> “以后还要基于这个 Runtime 做很多不同 Agent”

那么这些能力非常值钱。

但你现在说：

> **“ReviewAgent 就是一个专用产品，不考虑 Runtime 扩展复用。”**

那么这些优势就会从：

> 核心战略价值

变成：

> **架构上的优雅性。**

而你真正关心的：

```text
开发速度
工程稳定性
Review 能力
Context 控制
Cache
GitHub 集成
模型兼容
维护成本
```

Pi 开始变得更有吸引力。

---

# 3. Pi 其实已经足够做你的 ReviewAgent

这一点很重要。

Pi 当前并不是一个只能做 CLI Coding 的小工具。

当前 Pi 已经拆成：

```text
pi-ai
pi-agent-core
pi-coding-agent
```

其中 `pi-agent-core` 本身就是：

> Stateful Agent + Tool Calling + Event Streaming + State Management

而 `pi-coding-agent` 提供更完整的：

* Session
* Extension
* Tool
* SDK
* RPC
* Compaction
* CLI

能力。([GitHub][2])

更重要的是，Pi 的底层 `agentLoop()` 提供了：

* `beforeToolCall`
* `afterToolCall`
* `shouldStopAfterTurn`
* `transformContext`
* 自定义 `convertToLlm`
* 自定义 `streamFn`

等控制点。也就是说，你**完全可以把它限制成一个专用 Review Loop**，并不意味着只能使用它默认的 Coding Agent 行为。([GitHub][3])

所以：

> **Pi 的能力其实已经超过了“你做一个 Review Agent 所需要的最小集合”。**

---

# 4. 最关键的差异：Review Loop 谁更适合？

这里我会给 DSH 一点优势，但优势没有以前那么大。

## DSH

DSH 的设计非常适合：

```text
Custom Agent
+
Custom Agent Loop
```

官方甚至明确建议：

> 只有当标准 “call model → run tools → repeat” 生命周期不足以满足需求时，才实现 Custom Agent。([GitHub][4])

你的 Review Loop 确实可能属于这种情况：

```text
Diff
 ↓
Risk
 ↓
Hypothesis
 ↓
Evidence Request
 ↓
Context
 ↓
Verify
 ↓
Finding
```

因此 DSH 在“**重新定义 Agent 执行范式**”方面更漂亮。

---

## Pi

但 Pi 现在已经提供：

```text
agentLoop()
agentLoopContinue()
beforeToolCall
afterToolCall
shouldStopAfterTurn
transformContext
```

同时 Agent 自身也是状态化的。([GitHub][3])

所以你完全可以：

```text
Pi Agent
      ↓
Review Controller
      ↓
控制：
- 是否继续
- 是否取 Context
- 是否触发 Evidence
- 是否停止
- 是否压缩 Context
```

换句话说：

> **DSH 是更“原生”地支持改 Loop；Pi 是“已经给你足够多 Hook”，让你改造成 Review Loop。**

对于一个不需要未来复用的单一产品，我认为后者已经够了。

---

# 5. 第二个核心差异：Context / Cache

这个问题其实比 Agent Loop 更重要。

你的核心技术目标是：

> **Minimal Sufficient Context + Cache-Stable Agent Loop**

---

## DSH

DSH 在这一块的架构确实非常漂亮。

官方把：

```text
Session
System Prompt
Tool Schema
Agent Loop
```

拆开，而且 Session 是 append-oriented event log；模型请求从 Session 派生。([GitHub][1])

因此天然适合：

```text
Stable Prefix
+
Stable Context
+
Append-only Dynamic Context
```

所以：

> **如果“Context / Session / Prefix”本身就是你的核心研究方向，DSH 更优雅。**

---

## Pi

但是 Pi 现在也已经具备：

* `transformContext`
* Compaction
* Session persistence
* System Prompt customization
* Tool customization
* Agent state

而且官方还提供自定义 compaction、触发 compaction、修改 system prompt、注册自定义工具等扩展。([GitHub][5])

也就是说，你完全可以自己实现：

```text
review-cache/
├── stable-prefix.ts
├── context-ledger.ts
├── request-composer.ts
├── cache-metrics.ts
└── compaction.ts
```

因此：

> **Cache 能不能做好，不应该成为 DSH 与 Pi 的决定性因素。**

真正决定 Cache 效率的还是你自己的：

```text
Prompt Stability
Tool Schema Stability
Context Ordering
Ledger
Append-only
Model Route
Provider Cache
```

而不是“用了 DSH 还是 Pi”。

---

# 6. 第三个核心差异：工程成熟度

这里我会明显倾向 Pi。

当前 DSH 官方仓库仍明确标注：

> **Developer Preview**

并且明确写：

> **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.** ([GitHub][6])

这意味着：

```text
DSH
 ↓
你的 Plugin
 ↓
未来 DSH API 改变
 ↓
你的代码需要跟着迁移
```

而你的 ReviewAgent 本身已经是一个很复杂的工程：

```text
Context
Cache
Knowledge
Evidence
GitHub
Benchmark
Quality Gate
```

如果再同时承受：

> Harness 本身快速演进

维护成本会越来越大。

---

## Pi

Pi 当前已经有比较完整且持续演进的：

```text
Agent Core
Coding Agent
SDK
RPC
Session
Compaction
Extension
Provider
```

同时项目生态和 API 已经有大量现成实践。比如当前 README 就将 `pi-agent-core` 定义为 Agent Runtime，将 `pi-ai` 定义为统一多 Provider LLM API。([GitHub][2])

而且其 CHANGELOG 可以看到 Agent、Tool、Transport、Compaction 等核心 API 已经经过持续演进和修正。([GitHub][7])

所以从：

> **“我要维护这个产品 1～3 年”**

这个视角看：

**Pi 的工程风险更低。**

---

# 7. 第四个差异：多模型能力

这一项 Pi 明显占优。

Pi 的 `pi-ai` 本身就是：

> **Unified Multi-provider LLM API**

支持 OpenAI、Anthropic、Google 等多类 Provider。([GitHub][2])

这非常适合你的 ReviewAgent。

因为你的企业环境未来很可能不是：

```text
只有 DeepSeek
```

而是：

```text
DeepSeek
+
Claude
+
Qwen
+
OpenAI
+
企业内部模型
```

你前面又已经考虑：

> “哪个模型做轻量 Review、哪个模型做深度 Review”。

那 Pi 的 Provider abstraction 会非常舒服。

---

# 8. 第五个差异：企业平台集成

这一项两者其实都能做。

### Pi

当前明确支持：

* SDK
* RPC
* CLI

官方文档甚至明确写：

> 如果是跨语言集成或想要进程隔离，推荐 RPC；如果同进程则 SDK 更合适。([GitHub][8])

所以你的企业架构可以：

```text
GitHub Webhook
 ↓
Review Worker
 ↓
Pi RPC / SDK
 ↓
ReviewAgent
```

---

### DSH

同样支持：

```text
headless
SDK
ACP
```

并且 headless 模式就是：

```text
Task
 ↓
Fresh Session
 ↓
Run
 ↓
Final Result
 ↓
Exit
```

对于 CI / Worker 也非常适合。([GitHub][9])

所以这一项：

> **基本平手。**

---

# 9. 第六个差异：安全能力

这里反而需要注意 Pi 的弱项。

Pi 当前官方明确说明：

> **不内置 filesystem / process / network / credential permissions。**

如果需要更强边界，需要外部 sandbox/container。([GitHub][2])

但你的 V0.1 ReviewAgent 是：

> **Read-only**

而 Pi 当前 SDK 又直接提供：

```text
createReadOnlyTools()
```

所以可以很自然地构造：

```text
Pi
+
ReadOnly Tools
+
Container
```

对第一版并不是问题。([GitHub][8])

而 V0.3 以后如果加入：

```text
compile
test
runtime validation
```

再补充：

```text
Docker
Gondolin
Sandbox
```

即可。

因此这不是“不能用 Pi”，而是：

> **需要把安全边界放在 Pi 外部。**

---

# 10. 第七个差异：你到底要不要“极致 Hack Review Loop”？

这是我认为选择 DSH 的唯一一个非常强的理由。

假设你未来发现：

```text
标准 Agent Loop
```

根本不适合你的 Review Agent，需要：

```text
Review State Machine

Diff
 ↓
Risk
 ↓
Candidate Generation
 ↓
Evidence Planner
 ↓
Evidence Retrieval
 ↓
Verification
 ↓
Decision
```

甚至需要：

```text
非 LLM State Transition
+
Conditional Loop
+
Evidence Graph
+
Parallel Retrieval
+
Multiple Verification Pass
```

那么：

> **DSH 会更漂亮。**

因为 DSH 本身就是为了：

> “重新组合 Agent Runtime”

而设计的。([GitHub][1])

但是你需要问一个很现实的问题：

> **你的 ReviewAgent V0.1～V1.0，真的需要把 Agent Runtime 改到这种程度吗？**

我目前判断：

> **大概率不需要。**

你可以先用 Pi 的低层 `agentLoop` + `Agent` + hooks 实现 80%～90% 的需求。([GitHub][3])

---

# 11. 一个很重要的选择：不要把 Pi 当“完整 Coding Agent”用

如果最终选 Pi，我反而不建议：

```text
ReviewAgent
   ↓
pi-coding-agent
   ↓
删除一堆功能
```

这样是在“拆 Pi”。

应该直接：

```text
ReviewAgent
   │
   ├── pi-ai
   │
   └── pi-agent-core
```

需要时才拿：

```text
pi-coding-agent
```

中的：

* SDK
* Session
* Extension
* Compaction

等成熟能力。

也就是说：

> **以 `pi-agent-core + pi-ai` 为真正内核，自己构建 Review Runtime。**

这一点非常关键。

---

# 12. 如果选 DSH，我也不会建议你直接用 dsh-base

如果最终坚持 DSH，那么也不建议：

```text
dsh-base
 ↓
删工具
 ↓
改 Prompt
 ↓
改 Loop
```

而应该：

```text
dsh-sdk-minimal
       ↓
Review Composition
       ↓
Review Agent
```

DSH 官方当前本身就提供了 `dsh-sdk-minimal` 这样的更小组合树。([GitHub][10])

---

# 13. 两套方案放进你的项目，我会这样评分

这是**针对你的具体项目**，不是通用 Framework 排名。

| 维度              |    DSH |     Pi |
| --------------- | -----: | -----: |
| V0.1 开发速度       |      7 |  **9** |
| Review Loop 自定义 | **10** |      8 |
| Context 控制      |  **9** |      8 |
| Cache 设计        |  **9** |      8 |
| Multi-model     |      8 | **10** |
| CLI / RPC / SDK |      9 |  **9** |
| GitHub 集成       |      9 |      9 |
| 企业工程成熟度         |      7 |  **9** |
| 安全基础            |  **9** |      6 |
| 学习成本            |      6 |  **9** |
| 后续维护成本          |      6 |  **9** |
| Demo → PoC 速度   |      7 | **10** |
| **适合“专用单一产品”**  |  **8** |  **9** |

这里不是说 DSH 不强，而是：

> **DSH 有不少能力是“架构收益”，而你现在不再需要支付它们来换取长期复用。**

---

# 14. 如果让我今天拍板，我会选 Pi

在你现在的新前提下，我会把架构定成：

```text
                     ReviewAgent
                         │
                ┌────────┴────────┐
                ↓                 ↓
         Review Runtime      Context Engine
                │                 │
                ↓                 ↓
           pi-agent-core       Repo Map
                │              Symbol Map
                │              Call Graph
                │              Ledger
                │
                └────────┬────────┘
                         ↓
                    pi-ai
                         ↓
                DeepSeek / Claude /
                Qwen / OpenAI
```

然后：

```text
Review Runtime
├── Review Loop
├── Risk Strategy
├── Evidence Policy
├── Budget Policy
└── Review State
```

这全部归你自己控制。

Pi 只负责：

```text
Agent State
Tool Calling
LLM Streaming
Session
Event
Provider
```

---

# 15. 你前面提出的 Cache Engine 在 Pi 上仍然可以完整保留

这是我希望你特别放心的一点。

可以直接：

```text
ReviewAgent
   │
   ├── Review Loop
   │
   ├── Context Engine
   │
   ├── Cache Engine
   │     ├── Stable Prefix
   │     ├── Context Ledger
   │     ├── Append-only
   │     ├── Snapshot
   │     ├── Compaction
   │     └── Cache Metrics
   │
   └── Evidence Engine
```

Pi 当前已经支持 `transformContext` 和自定义 compaction，因此这些能力并不与 Pi 冲突。([GitHub][3])

所以：

> **不要因为“我们要做 Cache”就认为必须 DSH。**

---

# 16. 反而我认为 Pi 更适合你“快速找到最优 Review Algorithm”

这是一个非常重要的研究层判断。

你当前真正未知的其实不是：

> “Agent Runtime 怎么实现？”

而是：

> **“Review Agent 到底应该怎么 Review 才最省 Token？”**

你真正要实验的是：

```text
Review Loop A
Review Loop B
Review Loop C

Context Strategy A
Context Strategy B
Context Strategy C

Cache Strategy A
Cache Strategy B
Cache Strategy C
```

因此你需要的是：

> **一个轻、稳定、方便快速实验的底座。**

Pi 更合适。

---

# 17. DSH 更适合什么情况？

如果你出现下面这些需求，我会重新把票投给 DSH：

```text
需要大量 Agent Runtime 动态组合
需要多个自定义 Agent Loop
需要复杂 Event-driven Agent
需要复杂 Capability / Scope
需要强权限 / Sandbox 编排
需要把 Agent 本身做成 Harness
研究 Harness 自进化
```

尤其最后一个：

> **如果你的目标变成“研究 Harness 如何自进化”**

那 DSH 的价值会明显上升。

因为它的核心架构本身就在研究：

```text
Plugin
Scope
Event
Agent
Loop
Session
Composition
```

这与你之前研究的 Harness 自进化方向非常一致。([GitHub][1])

但你现在问的是：

> **“一个专用 ReviewAgent，未来不考虑复用。”**

那我不会为了这个可能性承担 DSH 当前 Developer Preview 的工程风险。

---

# 18. 我最终建议的技术方案

## 推荐：Pi-first

但不是：

> `Pi Coding Agent + Review Prompt`

而是：

> **`pi-agent-core + pi-ai + 自研 Review Runtime`**

架构：

```text
                     ReviewAgent
                          │
      ┌───────────────────┼───────────────────┐
      ↓                   ↓                   ↓
Review Runtime      Context Engine       Cache Engine
      │                   │                   │
  Review Loop         Repo Map             Prefix
  Risk Policy         Symbol Map           Ledger
  Budget              Impact Map            Snapshot
  Evidence            Call Graph            Compaction
      │                   │                   │
      └───────────────────┼───────────────────┘
                          ↓
                    Evidence Engine
                          ↓
                      pi-agent-core
                          ↓
                        pi-ai
                          ↓
                         LLM
```

---

# 19. 我建议你不要再做“DSH vs Pi”的长期架构争论，而是做一次极小的 Spike

如果你准备真正开始开发，我建议用：

> **同一个 Review Core，分别跑一次 DSH 和 Pi。**

但不需要做两个完整版本。

只实现：

```text
Git Diff
 ↓
Changed Symbol
 ↓
LLM
 ↓
1次 Tool Call
 ↓
Review
```

然后比较：

```text
代码量
开发时间
Token
Tool Calls
Latency
Context Control
API 可控性
```

我预计会出现这样的情况：

```text
                   DSH        Pi
Runtime能力        强          强
实现复杂度         高          低
Review适配         高          高
PoC开发成本        高          低
成熟度             中          高
长期维护           中          高
```

一旦验证 Pi 足够承载你的 Review Loop，就没有必要为了 DSH 的“架构优雅”承担额外复杂度。

---

# 20. 最终结论

所以，在你最新的前提：

> **“未来不考虑 ReviewAgent Runtime 的扩展复用，只做一个专用代码检视 Agent。”**

我的推荐从之前的：

> **DSH-first**

调整为：

# **Pi-first**

具体是：

> **`pi-agent-core + pi-ai` 作为基础内核，自研 Review Runtime / Context Engine / Cache Engine / Evidence Engine。**

理由可以浓缩为四句话：

> **第一，DSH 最大的优势是可组合 Harness，这在“不考虑复用”的前提下价值下降。**

> **第二，Pi 已经提供了足够的 Agent Loop、Tool、Session、Compaction、Extension、SDK、RPC 能力，可以支撑你的专用 Review Runtime。** ([GitHub][3])

> **第三，Pi 的成熟度、多模型生态和快速 PoC 能力更适合你当前最重要的工作——快速验证 Minimal Context、Cache 和 Review Strategy。** ([GitHub][2])

> **第四，DSH 当前仍是 Developer Preview，并明确存在兼容性破坏变化；如果它的 Harness 复用价值又不是你的目标，那么这个风险没有必要主动承担。** ([GitHub][6])

### 我会这样定最终架构：

```text
                 GitHub / GitLab / Gerrit
                           ↓
                    Review Gateway
                           ↓
                    Review Worker
                           ↓
                    ReviewAgent
                           ↓
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
  Review Runtime     Context Engine      Cache Engine
        │                  │                  │
   专用Review Loop      最小充分Context       高Cache
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ↓
                     Evidence Engine
                           ↓
                    pi-agent-core
                           ↓
                         pi-ai
                           ↓
               DeepSeek / Claude / Qwen / ...
```

**唯一需要保留的 DSH 价值，是把它作为技术对照组。**

也就是说，我会把实验设计成：

> **Pi 负责把 ReviewAgent 做出来；DSH 负责作为 Runtime Benchmark。**

这样你就不会陷入“选框架”的讨论，而是直接用真实数据回答：

> **哪一个内核能够让 ReviewAgent 在相同 Review Strategy / Context / Model 条件下，以最低工程成本获得最好的 Quality / Token / Cache / Latency。**

这对你当前项目来说，是更务实的决策路径。

[1]: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/README.md?utm_source=chatgpt.com "deepseek-harness/packages/core/README.md at master · deepseek-ai/deepseek-harness · GitHub"
[2]: https://github.com/earendil-works/pi/blob/main/README.md?utm_source=chatgpt.com "pi/README.md at main · earendil-works/pi · GitHub"
[3]: https://github.com/earendil-works/pi/blob/main/packages/agent/README.md?utm_source=chatgpt.com "pi/packages/agent/README.md at main · earendil-works/pi · GitHub"
[4]: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md?utm_source=chatgpt.com "deepseek-harness/packages/core/agent-loop/README.md at master · deepseek-ai/deepseek-harness · GitHub"
[5]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md?utm_source=chatgpt.com "pi/packages/coding-agent/examples/extensions/README.md at main · earendil-works/pi · GitHub"
[6]: https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md?utm_source=chatgpt.com "deepseek-harness/README.md at master · deepseek-ai/deepseek-harness · GitHub"
[7]: https://github.com/earendil-works/pi/blob/main/packages/agent/CHANGELOG.md?utm_source=chatgpt.com "pi/packages/agent/CHANGELOG.md at main · earendil-works/pi · GitHub"
[8]: https://github.com/pi-packages/earendil-works-pi/blob/main/packages/coding-agent/docs/sdk.md?utm_source=chatgpt.com "earendil-works-pi/packages/coding-agent/docs/sdk.md at main · pi-packages/earendil-works-pi · GitHub"
[9]: https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/headless-agent/README.md?utm_source=chatgpt.com "deepseek-harness/examples/headless-agent/README.md at master · deepseek-ai/deepseek-harness · GitHub"
[10]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.zh.md?utm_source=chatgpt.com "deepseek-harness/docs/subsystems/core.zh.md at master · deepseek-ai/deepseek-harness · GitHub"

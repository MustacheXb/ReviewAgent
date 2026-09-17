我认真对比了当前 **DeepSeek Harness（DSH）** 和 **Pi** 的最新仓库与官方文档。结合你这个项目的真实目标——**专用 Code Review、低 Token、Cache、企业代码平台集成、CWD/历史缺陷、后续 Harness 自进化**——我的结论是：

> **如果目标只是快速做出一个轻量 Review CLI，Pi 更简单；如果目标是做成你前面规划的“企业级 AI Review Engine”，我更推荐 DSH 作为长期内核。**
> 
> 更具体地说：**PoC 可以同时做一层 Runtime Adapter，但主路线优先 DSH；Pi 作为重要 Benchmark / Baseline Runtime 保留。**

这个判断不是因为 DSH 是 DeepSeek 的项目，而是因为从当前架构看，DSH 对“**可替换 Agent Loop + Event-sourced Session + Plugin Composition + Tool Policy + Profile + Headless/SDK**”的支持，与 ReviewAgent 的长期演进路线匹配度更高。([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [Pi](https://github.com/earendil-works/pi))

---

# 1. 先给你一个总判断

如果把两个内核放到你的目标下比较：

|维度|DSH|Pi|判断|
|---|---|---|---|
|Review 专用 Agent Loop|**强**|强|DSH略优|
|快速做 PoC|中|**强**|Pi优|
|Context 精细控制|**强**|中强|DSH优|
|Cache-Stable 架构|**强**|中强|DSH优|
|Session / Event|**强**|强|DSH更贴合 Review|
|Plugin / Composition|**非常强**|强|DSH优|
|Tool 裁剪与策略|**强**|强|DSH略优|
|CLI / Headless|**强**|**强**|接近|
|SDK / 程序化集成|**强**|**强**|接近|
|多模型覆盖|中强|**非常强**|Pi优|
|Coding Agent 现成能力|强|**非常强**|Pi优|
|企业级安全控制|**强**|弱~中|DSH明显优|
|企业平台集成|**强**|强|DSH略优|
|长期 Harness 自进化|**非常强**|强|DSH优|
|当前工程成熟度|Developer Preview|**更成熟**|Pi优|
|对你项目的长期匹配|**★★★★★**|★★★★☆|**DSH优先**|

这里有一个很重要的细节：

**Pi 并不弱。**

当前 Pi 已经明确拆成 `pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui` 等多个包，其中 `pi-agent-core` 提供 Agent Runtime、Tool Calling、State Management，`pi-coding-agent` 已经有完整 SDK、Session、Tool、Extension、Compaction、RPC 等能力。([Pi README](https://github.com/earendil-works/pi), [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md))

所以这其实不是：

> “强框架 vs 弱框架”

而是：

> **“更适合构建通用 Coding Agent 的内核” vs “更适合构建可组合专用 Runtime 的内核”。**

---

# 2. 两者最根本的架构差异

这个维度是我认为最值得你关注的。

## DSH 的核心思想

DSH 现在的官方定义非常明确：

> **Everything is a Plugin.**

Cordis 负责一个共享上下文，插件贡献：

- services
    
- typed events
    
- reversible effects
    

而模型适配器、Tool Registry、Session Log、Agent、Agent Loop 本身也都是插件。官方明确说，没有需要打补丁的 privileged core，扩展应该通过挂载插件完成。([DSH Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md))

这意味着：

```text
DSH
│
├── Session
├── Prompt
├── Tool
├── Agent
├── Agent Loop
├── LLM
└── Policy
```

都可以被重新组合。

---

## Pi 的核心思想

Pi 更像：

```text
pi-ai
   ↓
pi-agent-core
   ↓
pi-coding-agent
   ↓
Extensions / Tools / UI
```

它底层 Agent Core 非常干净，Coding Agent 层提供完整产品能力。

而 Pi 目前的 Extension 系统也已经能：

- 注册 Tool；
    
- 监听 Agent lifecycle events；
    
- 添加 commands；
    
- 增加 CLI flags；
    
- 修改 system prompt；
    
- 自定义 session；
    
- 通过 SDK 程序化运行。([Pi Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md))
    

所以 Pi 是：

> **“一个很好用的 Agent Toolkit”**

DSH 更偏：

> **“一个可以把 Agent Runtime 自己重新组合出来的 Harness”**

对你的项目，这个差异非常关键。

---

# 3. 对 ReviewAgent 最重要的比较：谁更适合做“专用 Agent Loop”？

这是我认为 **DSH 明显占优** 的地方。

你的 Review Loop 不是普通 Coding Loop：

```text
Diff
 ↓
Risk
 ↓
Context Decision
 ↓
Evidence Retrieval
 ↓
Reason
 ↓
Verify
 ↓
Finding
```

你需要的是：

> **Review Agent Driver**

DSH 当前 Core 明确把：

- `agent`
    
- `agent-loop`
    

分开，`agent-loop` 是默认具体驱动，而 Agent 是公共接口，因此可以替换 Loop。([DSH Core](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md))

这非常适合：

```text
Default Coding Loop
        │
        ├── Search
        ├── Read
        ├── Edit
        ├── Test
        └── Debug

                ↓ 替换

Review Loop
        │
        ├── Diff
        ├── Risk
        ├── Context
        ├── Evidence
        ├── Verify
        └── Finding
```

这不是简单“改 Prompt”。

而是：

> **改 Agent 的执行模型。**

---

## Pi 怎么做？

Pi 也能做。

`pi-agent-core` 的 Agent Loop 是独立包，而且 `AgentSession` 之上可以通过 SDK、Extensions、hooks 和工具选择来控制行为。Pi 的 `AgentSession` 本身已经负责状态、Session、Compaction、Tool 等生命周期。([Pi AgentSession](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts))

但在你的项目里，我会认为：

> **Pi 更适合“在一个成熟 Agent Loop 上做改造”，DSH 更适合“重新定义一个新的 Runtime/Loop”。**

这就是两者真正的差距。

---

# 4. 第二个决定性问题：谁更适合你的 Cache / Context Economy？

这一项也是我偏向 DSH 的核心原因。

你的真正目标不是：

> 少 Prompt

而是：

> **Minimal Sufficient Context + Cache-Stable Agent Loop**

---

## DSH 对这个架构非常友好

DSH 当前 Core 的一轮请求路径是：

```text
Agent Loop
 ↓
Session
 ↓
System Prompt
 ↓
History
 ↓
LLM
 ↓
Tools
 ↓
Session append
```

官方文档明确写到：

- Session 是 append-only log；
    
- System Prompt 独立组装；
    
- Tool Schema 属于模型请求构造；
    
- 每一步都把模型可见事实追加回 Session。([DSH Core](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md))
    

这跟你的设计：

```text
Stable Prefix
+
Stable Context
+
Append-only Dynamic Context
```

几乎是天然一致的。

而且 DSH 还有独立的 `compaction`、`session-query`、`session-projection` 等能力边界，说明它不是把 Context 生命周期简单当作 Message Array 来处理。([DSH Module Graph](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/module-graph.md))

---

## Pi 也能做 Cache

Pi 已经有：

- Session；
    
- Compaction；
    
- Agent state；
    
- Tool selection；
    
- 自定义 Prompt；
    
- Model runtime；
    
- Event Stream。
    

而且 `AgentSession` 中已经专门处理 compaction、branch summary、session persistence、tool state 等。([Pi AgentSession](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts))

所以 Pi 完全能够做：

```text
Context Ledger
Stable Prefix
Append-only
Compaction
```

但是问题是：

> 这些更像是“你在 Pi 上继续搭建一层”。

在 DSH 里：

> **Session + Prompt + Agent Loop + Plugin + Event 都是第一类扩展对象。**

因此，如果你把 Cache Engine 做成一级能力，我认为 DSH 的架构边界更干净。

---

# 5. 第三个比较：企业安全和代码执行

这里 **DSH 优势比较明显**。

Pi 官方 README 当前明确说明：

> Pi **不提供内建权限系统**来限制 filesystem、process、network、credential access。

官方建议通过：

- Gondolin
    
- Docker
    
- OpenShell
    

进行隔离。([Pi README](https://github.com/earendil-works/pi))

对于一个真正进入企业研发流程的 Review Agent，这个问题很现实。

因为你未来一定会从：

```text
Read-only Review
```

走到：

```text
Review
 ↓
Compile
 ↓
Run Unit Test
 ↓
Run Static Check
 ↓
Runtime Validation
```

那时候就涉及：

```text
Command Execution
File Access
Network
Secrets
Sandbox
Approval
```

DSH 当前已经有：

- Tool guards；
    
- permission / policy；
    
- sandbox；
    
- approval；
    
- scoped tool registry；
    
- tool timeout / execution policy
    

等能力，并且这些也处于独立 capability seams。([DSH Capability Seams](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md))

所以：

> **如果从企业生产化考虑，DSH 比 Pi 少走一段路。**

---

# 6. 第四个比较：代码平台 / CLI / SDK 集成

这里两者都可以，但形态不同。

## DSH

当前官方已经提供：

```bash
dsh --profile headless "..."
```

headless 模式：

- 一个任务一个 Session；
    
- 完成后退出；
    
- stdout 输出最终答案；
    
- stderr 可输出 reasoning；
    
- exit code 表示完成/失败；
    
- 不启动 Web Server。([DSH CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md), [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md))
    

而且现在已经有：

```text
headless
sdk
sdk-minimal
acp
```

等 Profile。SDK 是 stdio JSON-RPC，ACP 也是独立入口。([DSH CLI Reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md))

所以企业系统可以：

```text
GitHub Webhook
 ↓
Review Worker
 ↓
DSH SDK / Headless
 ↓
ReviewAgent
```

---

## Pi

Pi 同样非常强。

Pi 当前：

```text
AgentSession SDK
+
RPC
+
CLI
```

而官方 SDK 文档明确把：

- SDK；
    
- RPC；
    
- Extension；
    

作为程序化集成路径。

尤其是：

> **如果跨语言 / 要独立进程隔离，RPC 是推荐方式。**

([Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md))

所以单纯回答：

> “谁更适合集成企业系统？”

我的答案是：

> **两者都足够。**

但如果你考虑：

```text
Plugin
Profile
Policy
Agent Runtime
Session/Event
```

一起做企业级编排：

> **DSH 更符合你的长期架构。**

---

# 7. 第五个比较：模型生态和供应商解耦

这里：

> **Pi 明显更强。**

Pi 的 `pi-ai` 是一个统一多 Provider API，目前支持 OpenAI、Anthropic、Google 等众多提供方；官方文档还包含多种订阅和 API Key Provider。([Pi README](https://github.com/earendil-works/pi), [Pi Providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md))

对于你的企业 Review：

```text
DeepSeek
Claude
Qwen
OpenAI
本地模型
```

快速切换非常方便。

DSH 也有 `llm` seam 和模型适配器，并且其架构明确把 model adapter 当作 plugin；但从当前公开生态和 Provider 覆盖度看，**Pi 在“立即使用大量模型”方面更成熟。** ([DSH Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md))

因此：

> **如果你的第一优先级是“尽快支持大量模型”，Pi 占优。**

---

# 8. 第六个比较：开发复杂度与项目风险

这是 DSH 最大的短板。

当前 DSH 官方仓库仍定位为：

> **Developer Preview**

并明确提示 compatibility-breaking changes。([DSH README](https://github.com/deepseek-ai/deepseek-harness))

而 Pi 的工程形态已经比较成熟，SDK、Coding Agent、Extension、RPC 等路径都比较完整。

这意味着：

### DSH

优势：

> 架构先进、可组合性强。

代价：

> 你需要更懂 Harness。

---

### Pi

优势：

> 更容易开工、资料和现成代码更多。

代价：

> 深度改造成一个专用 Review Runtime 时，很多东西最终仍需要自己构建。

所以：

> **DSH 的风险在“升级兼容”；Pi 的风险在“长期架构演进”。**

这是两个完全不同的风险。

---

# 9. 放到你的真实项目里，我建议这样选择

你的项目不是普通 AI Code Review。

你前面已经明确了几个长期目标：

```text
1. 专用 Review Loop
2. Minimal Sufficient Context
3. Context Ledger
4. Prefix Cache
5. CWD
6. Historical Defects
7. Evidence Verification
8. GitHub/GitLab 集成
9. Incremental Review
10. Harness 自进化
```

把这十件事情拿出来看：

### Pi 最强的地方

```text
LLM
Agent Core
Coding Agent
SDK
Extensions
Provider
RPC
```

### DSH 最强的地方

```text
Plugin Composition
Agent / Agent Loop seam
Event-sourced Session
Tool Policy
Profile
Capability Seams
Headless / SDK / ACP
```

因此：

> **你要做的是“专用 Harness”，不是“Coding Agent 的一个 Extension”。**

所以我更推荐 DSH。

---

# 10. 我的最终建议：DSH 主内核，Pi 做对照，不要二选一地“锁死”

我不建议：

> “DSH vs Pi 选一个，另一个以后完全不管。”

我建议你的项目从第一天就做一层：

# Review Runtime Adapter

```text
                  Review Engine
                       │
                Review Runtime API
                       │
          ┌────────────┴────────────┐
          ↓                         ↓
     DSH Adapter               Pi Adapter
          │                         │
    DeepSeek Harness               Pi
          │                         │
          └────────────┬────────────┘
                       ↓
                       LLM
```

上层只依赖统一接口：

```ts
interface ReviewRuntime {
  createSession(request: ReviewRequest): Promise<ReviewSession>;

  run(session: ReviewSession): Promise<ReviewResult>;

  cancel(session: ReviewSession): Promise<void>;

  metrics(session: ReviewSession): ReviewMetrics;
}
```

然后：

```text
DSH Review Runtime
Pi Review Runtime
```

都实现它。

---

## 为什么我强烈建议保留 Pi Adapter？

因为这会让你的 Benchmark 有一个非常有价值的维度：

```text
Same Review Engine
      │
      ├── DSH Runtime
      │
      └── Pi Runtime
```

于是可以真正实验：

> **到底是 Harness 影响效果，还是 Review Architecture 影响效果？**

这对于技术方案非常有说服力。

---

# 我给你的推荐路线

我最终推荐：

```text
                    Review Agent
                         │
                 Review Core API
                         │
       ┌─────────────────┼─────────────────┐
       ↓                 ↓                 ↓
 Review Strategy     Context Engine    Cache Engine
       │                 │                 │
       └─────────────────┼─────────────────┘
                         ↓
                  Runtime Adapter
                     /        \
                    /          \
                   ↓            ↓
              DSH Runtime    Pi Runtime
                   │            │
                   ↓            ↓
               Harness       Agent Core
                   │            │
                   └─────┬──────┘
                         ↓
                        LLM
```

### 主路线

> **DSH**

### 对照路线

> **Pi**

### 共享层

> Review Core / Context / Cache / Evidence / Benchmark

---

# 为什么最终我选择 DSH

因为你最终真正要做的是：

> **“一个新的 Review Agent Runtime”**

而不是：

> **“在 Coding Agent 上加一个 Review Prompt”。**

DSH 当前把 `Agent / Agent Loop / Session / Tool / System Prompt / LLM` 做成清晰的可替换能力边界，这与这个目标高度一致。([DSH Core](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md))

同时，DSH 当前还有一个非常适合你长期方向的特征：

> **Session 是 Event-sourced 的。**

这意味着未来可以天然沉淀：

```text
Review
 ↓
Candidate
 ↓
Evidence
 ↓
Accept / Reject
 ↓
Human Feedback
 ↓
Strategy Evolution
```

对于你一直在研究的 **Harness 自进化**，这条基础设施路线比“简单的 AgentSession + Extension”更有潜力。([GitHub](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md?utm_source=chatgpt.com "deepseek-harness/docs/subsystems/core.md at master · deepseek-ai/deepseek-harness · GitHub"))

---

# 最后我会给两个不同阶段的选择

### 如果目标是“2～3 天快速证明 Review Agent 能不能跑”

> **Pi 更合适。**

原因是 SDK 简单、工具控制直接、Provider 丰富、现成 Coding Agent 能力成熟。([Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md))

### 如果目标是“未来 6～12 个月形成企业级 AI Review Engine”

> **DSH 更合适。**

原因不是“它功能更多”，而是它的架构更适合你最终想构建的：

> **专用 Review Runtime + Context Engine + Cache Engine + Evidence Engine + Domain Knowledge + 企业 Workflow + Self-Evolution。**

---

## 最终架构建议

我建议你正式确定为：

> ### **DSH-first，Pi-compatible**
> 
> **DSH 作为主生产 Runtime；Pi 作为独立 Benchmark Runtime / 备用 Runtime；Review Core 与 Runtime 解耦。**

这样既能吃到 DSH 在 **Plugin、Agent Loop、Session/Event、Policy、Composition** 上的优势，又保留 Pi 在 **多模型、SDK、快速实验、成熟 Coding Agent 能力**上的优势。

而且这对你的第一个 PoC 特别有价值：

```text
POC1
              Review Core
                   │
          ┌────────┴────────┐
          ↓                 ↓
       DSH Runtime       Pi Runtime
          │                 │
          └────────┬────────┘
                   ↓
          同一批 ReviewBench
                   ↓
        Quality / Token / Cache
                   ↓
            Harness 对比
```

这样你最终不是“凭感觉选 DSH”，而是可以用真实数据证明：

> **哪个 Runtime 在相同 Review Strategy / Context / Model 条件下，能够提供更好的 Quality / Token / Cache / Latency Trade-off。**

**这是我认为目前最稳、也最有技术含量的落地方式。**
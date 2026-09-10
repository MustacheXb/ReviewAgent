# DSH 内核机制偏差清单：npm 0.1.2-rc.1 × reference 0.1.5-alpha.1

> 票 #18（spec #17）Spike 1 落锤。核对口径：npm 消费线 `@deepseek-ai/dsh@0.1.2-rc.1`
> （`packages/review-dsh`，lockfile 锁定）× 本地 `reference_project/deepseek-harness`
> （0.1.5-alpha.1 源码，只读参考）。处置选项按 ADR-0005：**fork 过渡 / 适配 / 不采用**。
> 全部条目为本工作流实测（进程内真实树组装 + FakeLlmAdapter 脚本驱动），非文档推断。

## 结论速览

| # | 机制 | 判定 | 处置 |
|---|------|------|------|
| 1 | 行集名称（dsh-* 包拆分） | 无实质偏差 | 无需处置 |
| 2 | session-projection 行缺失（ADR-0006 勘误） | 非版本偏差，是设计勘误 | ADR-0006 行集补记 |
| 3 | agentPresets（0.1.5 有 / 0.1.2-rc.1 无） | 偏差：宿主层机制，核内不需要 | 不采用 |
| 4 | followup / inject 语义 | 无偏差（逐行同构） | 无需处置；Zone B 顺序确定（见 §4） |
| 5 | 唤醒窗口竞态（followup 落 kick 收尾微任务窗口被吞） | 非版本偏差（两版同在） | 适配：驱动器以 `whenIdle()` 为节拍 |

**总判定：无需 fork。** 0.1.2-rc.1 满足检视内核（票 #18 范围）全部机制需求；唯一发现的
竞态窗口在 0.1.5-alpha.1 中逐字同在，属内核契约而非回归，以标准节拍规避。

## 1. 行集名称

npm 线（`node_modules/@deepseek-ai/`）可用行：`cordis`、`dsh-llm`、`dsh-session`、
`dsh-session-persistence-jsonl`、`dsh-session-projection`、`dsh-system-prompt`、
`dsh-tools`、`dsh-agent`、`dsh-agent-loop`、`dsh-cmdline`（另有 `dsh-base`，显式最小树不继承）。

reference 0.1.5-alpha.1 为 monorepo 目录树，对应关系：

| npm 行 | reference 路径 | 说明 |
|--------|----------------|------|
| dsh-llm | `packages/llm` | 同名机制 |
| dsh-session | `packages/core/session` | 同 |
| dsh-session-persistence-jsonl | `packages/session/session-persistence-jsonl` | 同 |
| dsh-session-projection | `packages/session/session-projection` | 独立包，两版一致 |
| dsh-system-prompt | `packages/core/system-prompt` | 同 |
| dsh-tools | `packages/core/tools` | 同 |
| dsh-agent | `packages/core/agent` | 同 |
| dsh-agent-loop | `packages/core/agent-loop` | 同 |
| dsh-cmdline | （并入宿主/boot 层） | 见 §6 附注 |

reference 另有大量前沿包（goal / plan / todo / preset / boot / bundle / host / api / …），
npm 线未发布——**不在检视内核需求内**，不构成偏差，只构成「前沿特性不可用」的既知约束
（ADR-0005 选定 npm 锁定线时已接受）。

## 2. session-projection 行（ADR-0006 勘误）

**事实**：`AgentLoop` 在两版中均硬注入 `sessionProjections`
（`inject = ['agents','sessions','llm','tools','systemPrompt','sessionProjections']`，
构造器内 `ctx.sessionProjections.register(turnBoundaryProjectionDefinition)`）。
不挂 `dsh-session-projection` 行则 agent-loop 不加载。

**判定**：这不是 0.1.2-rc.1 对 0.1.5 的偏差（两版同构），而是 ADR-0006 原行集的遗漏。
**处置**：ADR-0006 行集补记第 9 行（`session-projection`，kind: dsh）；
`packages/review-dsh/src/profile/rows.ts` 已按 10 行（9 dsh + 内核行）落地并留注释。

## 3. agentPresets

**事实**：0.1.5-alpha.1 存在 `ctx.get('agentPresets')` 服务——宿主/API 层
（`api/session-controller` 的 `composeAgent`）按 preset id 解析并挂载 Agent 预设。
npm 0.1.2-rc.1 无此机制。

**判定**：这是交互式宿主栈（客户端选择预设、动态挂载）的机制；检视内核以
`agentLoop.create(sessionId, { provider, model, reasoningEffort })` 显式构造 Agent，
配置由 review-policy 插件独占供给，无需预设解析层。

**处置**：**不采用**（无 fork、无适配）。Phase 2+ 若引入 preset 驱动的多 Agent 配置再评估。

## 4. followup / inject 语义（含 Spike 2：Zone B 注入顺序）

**事实**（两版逐行同构，`agent.ts` `send`/`followup`/`inject`）：

- `followup(msg)` → `send(msg, 'next-turn', wakeup=true)`：唯一普通消息，唤醒驱动器，独占一 turn；
- `inject(msg)` → `send(msg, 'next-step', wakeup=false)`：排入下步模型可见上下文，**不唤醒**；
  idle 驱动器上 inject 挂起，直到 followup 唤醒后同批入请求。

**Spike 2 结论（票 #18 落锤，供缓存纪律票消费）**：会话启动注入（MR intro，`inject`）+
首条驱动指令（Phase 1，`followup`）在请求 1 批内的字节顺序**确定**：

```
messages[0] = MR intro（inject，先入）
messages[1] = Phase 1 指令（followup，后入）
system（Zone A）独立成 GenerateOptions.system 字段
```

字节断言见 `packages/review-dsh/tests/loop/walking-skeleton.test.ts`（请求 1 布局
逐字节对齐冻结 harness 的 `SYSTEM_PROMPT` + `buildInitialUserMessage` + Phase 1 指令）。
**退路（Zone B 并入首条驱动指令）不需要启用。**

## 5. 唤醒窗口竞态（实测新发现）

**现象**：turn/end 事件的监听者（驱动器）在同一微任务队列中先于 agent-loop 的
kick 收尾（`setPhase(idle)`）恢复执行。此窗口内发出的下一条 `followup` 看到
`phase.kind === 'running'`，`wakeDriver` 对 live driver **不锁存**唤醒
（仅 maintenance / aborted 锁存）——消息入 inbox 但无驱动器认领，kick 收尾时
`wakeRequested === false`，Agent 落 idle 且 inbox 悬挂。**唤醒被吞，会话死锁。**

**版本核对**：0.1.5-alpha.1 的 `wakeDriver`/`kick` 与 0.1.2-rc.1 逐行同构
（`if (!this.inbox.hasPending) return false` + 非锁存 live wake），
竞态两版同在——是「驱动者应从 idle 发起 followup」的契约边沿，非版本回归。

**处置**：**适配**。review-runtime 驱动器在每个 turn/end 之后、下一条 followup 之前
`await agent.whenIdle()`（DSH 驱动器标准节拍），代码内已注释窗口事实。
后续票若升级 DSH 版本，需重跑 Zone A / Zone B 纪律门确认该窗口行为未变。

## 6. 附：实测内核事实（npm 0.1.2-rc.1）

- **dsh-cmdline 是宿主侧库**，非可挂载插件：`provideCmdline(ctx, { args, exit })` 需在
  树挂载前供给 `cmdlineArgs` / `appExit`；loader peer-dep 在进程内不生效。
- **LlmAdapter.resolveModel 必须申报 reasoning efforts**：默认实现无 effort 元数据，
  任何请求 effort（含 `"default"`）都会以 `UNSUPPORTED_REASONING_EFFORT` 失败。
  FakeLlmAdapter 覆写 `resolveModel` 申报 `[{ id: "default" }]`。
- **SystemPrompt 字节控制**：`complete: true` 段替换全部段；配
  `includeHarnessIdentity: false` + `includeRuntimeContext: false` 后
  `renderPrompt(assembly)` 输出与冻结 harness `SYSTEM_PROMPT` 逐字节相等。
- **turn 计数从 1 起**；config A（零工具）下一 turn 恰一次模型调用、
  `GenerateOptions.tools` 整体缺省（非空数组）。
- **session 事件**：`ctx.on("session/event", (session, event))`，`event` 为
  `type` 判别联合（`turn/end` 的 `data = { turn, reason }`，`assistant/message`
  的 `data = { turn, step, message, usage? }`）；按 session 对象身份过滤即可。

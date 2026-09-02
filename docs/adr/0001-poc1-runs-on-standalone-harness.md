# POC1 实验运行在独立薄 harness 上，DSH 仅作并行技术 spike

方案标题是"基于 DeepSeek Harness"，但 POC1 的 A–E 实验不在 DSH 上构建：配置 A–C 不需要 DSH；D/E 要验证的稳定前缀 + Context Ledger + Append-only 本质是消息构造纪律，不依赖 runtime。DSH 处于 developer preview（本地仓 v0.1.2-alpha.4），自定义 agent loop 更是零生产示例的无人区——先建 runtime 再跑实验会把架构风险传染给实验本身，失败时沉没成本过高。实验结论反过来决定 DSH Runtime 的实现深度。

## Considered Options

- 在 DSH 上以五个 profile 实现 A–E：被否，理由见上。
- A–C 用薄 harness、D/E 直接在 DSH 上做：被否——两套实验代码路径造成对比不纯。

## Consequences

- 薄 harness 零 DSH 依赖（纯 OpenAI 兼容 HTTP 客户端，自写消息构造与 usage 记账）。
- Phase 1 迁移 DSH 时，harness 的 Context Engine / Ledger / 消息构造代码按 TypeScript 直接复用（harness 语言已定为 TS）。

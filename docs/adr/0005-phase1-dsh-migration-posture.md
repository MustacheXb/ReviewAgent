# Phase 1 DSH 迁移：核内插件化、薄 harness 冻结、1:1 对齐验收

POC1 收官后进入 Phase 1（ADR-0001 预留的迁移阶段）：ReviewAgent 的检视会话运行时（**核内**：loop 策略、`review.*` 工具、C0–C3 上下文决策、缓存纪律、检视政策、Evidence Gate）全部经 DSH 扩展面以插件形态实现，形成以 DSH 为内核的 `review-agent` CLI；研究工具链（**核外**：dataset / judge / calibration / sampling / reference / metrics 聚合 / experiment runner）不进 DSH 插件树，作为普通库被 CLI 调用。术语见 `CONTEXT.md`「运行时边界」。核内插件集为 policy / runtime / context / cache / evidence 五个（review-knowledge 缺位，属 Phase 4；review-metrics 拆为核内记账 + 核外聚合）。

## Considered Options

- 交付物：仅实验平台迁移 / 仅产品 CLI / **两者**（CLI 单 MR 检视 + 实验面 runner 驱动同一内核跑 A–E）——被选。仅产品则 Phase 2+ 策略改进失去受控对比能力，双运行时必然分叉。
- 薄 harness 去留：长期双轨 / 迁移后删除 / **冻结存档**——被选。正式 benchmark（论文主数据）在冻结薄 harness 上跑，迁移并行推进：研究不被 developer preview 迁移阻塞，POC1 已产数据保持可复现；对齐门通过后再谈删除。
- 机制替换：迁移时顺手采用 DSH 原生机制（compaction seam / `ctx.toolResultPruner` / session seed-fork）/ **1:1 迁移先行**——被选。同时换运行时与机制会让指标变化无法归因；DSH 原生机制全部后置为独立消融票，每票带 before/after 指标。
- DSH 版本：跟随上游 / 本地源码 link（0.1.5-alpha.1 前沿）/ **npm 锁定 `@deepseek-ai/dsh@0.1.2-rc.1` 线**——被选（Round 3 修订；原文误记本地副本为 v0.1.2-alpha.4，实际已更新至 0.1.5-alpha.1）。lockfile 可复现压倒前沿特性；`reference_project/` 重钉到同版本 tag 作只读参考；缺机制时走 fork 过渡策略。
- core 缝隙处置：硬性 No Core Patch / 长期 fork / **fork 仅作过渡**（最小补丁验证 + 向上游提 issue/PR）——被选。developer preview 阶段硬约束可能把迁移逼进死胡同，长期维护 fork 积累债务。

## Consequences

- 迁移验收门分两层：**确定性纪律门**（fake LLM、零网络、进 CI：Zone A 字节稳定、无变更零 Cache Break、审计可重放、六阶段骨架与 `max_rounds`/`max_tool_calls` 上界可在事件流中验证）+ **指标对齐门**（gateway 口径 45 单元取子集，DSH 内核真实重跑同配置同判定链，Recall / Precision / Token / CacheHit 落在 ±1 std 波动带）。门通过即认定运行时互换无系统偏差。
- fake LLM 以 DSH `ctx.llm` 适配器形态注册（与生产同 seam，不包在 DSH 外）；实验 runner 与 CLI 共享同一内核库入口（纪律门要求进程内 fake）。
- POC1 审计格式与 Finding 契约保持不变：DSH session 事件日志经适配器导出为既有格式，metrics / experiment 读取端不重写。
- loop 姿态（标准 loop + 策略监听器 vs `setFactory` 自定义 agent）不在本 ADR 范围，单独决策——v2.1 保守路线为默认，待 DSH 源码事实到位后拍板。

# S 级判定纳入 Precision ≥ 锚 C，不设 Tool Calls 档位门槛

spec #1（user story 29）与《总体架构设计方案》v2.0（第 7 章 POC 成功标准）对 S/A/B 三档判据的表述存在分歧：两文档 A/B 档一致（A：Recall ≥ C×80% / Token ≤ C×30% / Cache Hit ≥ 80%；B：Recall ≥ C×70% / Token ≤ C×50%），仅 S 级不同——spec 为三判据（Recall / Token / Cache Hit），主文档另含 **Precision ≥ C** 与 **Tool Calls ≤ C×30%** 两条。实现（`src/metrics/verdict.ts`）原按 spec 三判据实现。Benchmark 试跑（论文第一批实验数据）前必须收敛到单一口径，经裁决：

- **S 级纳入 Precision ≥ C×100%**：Token 压缩若以"少报"实现，Recall 判据可见，但 Precision 暴跌（滥报换检出）不会被三判据拦截——Precision ≥ 锚保证 S 级的"质量不掉"是完整的（检出与精确双侧），防档位被策略性降 Recall/降报数冲线。
- **不设 Tool Calls ≤ C×30% 档位门槛**：Token 判据为总 token 口径，工具结果注入成本已在其中；且锚 C 为全仓注入，自主检索需求天然最低、工具调用基数低，×30% 阈值存在结构性不可达风险（会把 S 级变成与策略无关的空档）。工具调用数仍保留在 Agent Efficiency 指标组中报告，供事后归因。

## Considered Options

- 维持 spec #1 三判据：被否——与主文档（论文口径）不一致，且缺质量侧完整性（上述 Precision 漏洞）。
- 按主文档五判据全量（Precision + Tool Calls）：被否——Tool Calls 判据的锚基数问题会令 S 级结构性不可达，判据失效需返工。
- 折中（本 ADR）：Precision 入 S、Tool Calls 不入——补全质量侧完整性，规避结构性不可达。

## Consequences

- S 级判据为四条：Recall ≥ C×90% ∧ Precision ≥ C×100% ∧ Token ≤ C×30% ∧ Cache Hit ≥ 85%（均取 rep2+ 热口径均值）；A/B 维持不变。
- 锚可用性（NOT_EVALUABLE 判定）仍以 Recall / Total Tokens 为准；锚 Precision 缺失时 S 级 Precision 判据按未通过处理（保守判定，降至 A 级判定），不升级为 NOT_EVALUABLE——A/B 档不受影响。
- `VerdictMetrics` 增加 `precision`（line-level，热口径均值），`VerdictThresholds` 增加 `precisionRatio`（null = 该档无 Precision 判据）；阈值仍可经 options 覆盖。
- 工具调用数不作为档位门槛，但作为 Agent Efficiency 指标继续报告；若 Benchmark 数据显示工具成本在 Token 总账中占比异常，可在 Phase 1 重议。
- spec #1（已关闭的 user story 29）与主文档的口径差异以本 ADR 为准收敛，论文写作采用 ADR-0004 口径。

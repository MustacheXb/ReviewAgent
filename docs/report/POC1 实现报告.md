# POC1 实现报告

> **范围**：spec #1「POC1 薄 harness 实验平台（Review Agent 阶段 0）」全部 13 张工单（#2–#14）
> **交付形态**：分支 `spec/poc1-thin-harness`（83 提交，tip `5490e68`）→ PR #15（ready for review，Closes #1–#14）
> **报告日期**：2026-09-07 · **实现周期**：2026-08 下旬 – 2026-09 上旬

## 1. 概述

POC1 的目标是为「低 Token、高质量代码检视 Agent」论文搭建**实验平台**：以 20~30% 的 Context/Token 成本获得 80~90% 的检视质量、Cache Hit ≥ 85%，需要一套能对同一批 MR 在不同上下文/缓存策略下做受控对比的 harness。

本报告对应的交付是**实验平台本身**（阶段 0），不是实验结论——五配置 A–E 的对比数据属下一阶段的小样本 Benchmark 试跑（见 §8）。

一句话结论：**平台按 spec 全量交付**——32 条 user stories 对应的 13 张 tracer-bullet 工单全部实现并合入，987/987 测试全绿，typecheck 0 错误，覆盖率 90.7% lines（阈值 80%），经两轴 code-review（Standards + Spec）10 项发现全部修复后 PR 转入 ready。

## 2. 需求与任务结构

- **Spec**：GitHub issue #1——Problem/Solution/32 条 user stories（US1–US32）/实现与测试决策/Out of Scope
- **工单**：`/to-tickets` 拆解为 13 张 tracer-bullet 垂直切片（#2–#14，T01–T13），每张声明阻塞边，按 frontier 依赖序实现；实现过程逐工单分支 → 合入 spec 分支 → 关单留验收评论
- **实现模式**：`/implement-spec` 驱动——实现者子代理按工单并行（各自 worktree/分支），merger 逐个合入；收尾经 `/code-review` 两轴审查 + 单轮修复

## 3. 架构决策（ADR）

| ADR                                                             | 决策                                             | 一句话理由                                                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [0001](../adr/0001-poc1-runs-on-standalone-harness.md)          | POC1 跑在**独立薄 harness**，零 DSH 依赖，DSH 仅作并行 spike | A–C 不需要 DSH；D/E 验证的本质是消息构造纪律而非 runtime 能力；避免把 developer preview 的架构风险传染给实验。Phase 1 迁移时 Context Engine / Ledger / 消息构造 TS 代码直接复用 |
| [0002](../adr/0002-poc1-model-pinned-to-deepseek-api.md)        | 模型锁定 DeepSeek API（deepseek-v4-flash，effort 单档） | 消除模型变量，五配置对比只剩上下文/缓存策略差异                                                                                                        |
| [0003](../adr/0003-poc1-zero-build-static-code-intelligence.md) | 零构建静态代码智能（tree-sitter-java + ripgrep）          | 生产约束是「只有静态源码快照」，不依赖构建与运行时                                                                                                       |
|                                                                 |                                                |                                                                                                                                 |

## 4. 核心交付

### 4.1 薄 harness（六阶段骨架循环）

TypeScript ESM、Node 24 / pnpm 10.30.3 / vitest，依赖仅 3 个（ripgrep、tree-sitter 双件）——**零 DSH 依赖**，LLM 调用为自写的纯 OpenAI 兼容 HTTP 客户端（这是字节级控制的前提）。

- 六阶段固定骨架：Change Understanding → Risk Classification → Context Decision → Context Retrieval → Deep Reasoning → Evidence Verification；阶段内检索由模型在预算内自主完成
- 硬上界：`max_rounds = 5` / `max_tool_calls = 6`，单次检视成本有界
- Evidence Gate：Finding 必须带证据链方可输出
- 审计落盘：每次请求的可重放字节、工具调用日志、阶段日志、拒绝留痕

### 4.2 五实验配置 A–E（同一 harness，消息构造策略不同）

| 配置 | 策略 | 角色 |
|---|---|---|
| A | Diff-only | 下限对照 |
| B | Zone B + 固定管线确定性预取 | 预取 vs 主动检索对照 |
| C | 全仓上下文注入 | **质量主锚**（S/A/B 判定基准） |
| D | Minimal + Stable Prefix | 稳定前缀最小上下文 |
| E | Ledger + Append-only | 追加式账本复用 |

工具纪律：A/B 零工具；C/D/E 挂**同一套 7 个零构建 `review.*` 工具**（get_diff / get_file / get_symbol / find_references / get_call_chain / search_rule / search_history），工具 schema 字节一致（属 Zone A 稳定前缀，C/D/E 对比不被前缀差异污染）。

### 4.3 Zone A/B/C 分区纪律 + Cache 观测

- **Zone A**（角色、政策、工具 schema、输出 Schema、Severity、Evidence Policy）session 内字节稳定
- **Zone B**（Repo Identity / Map / Symbol Index / Project Rules）静态确定性构造，不经过 LLM、不依赖构建
- **Zone C**（会话内追加内容）append-only
- **Cache Break 原因分类**（US13）：相邻请求字节前缀分歧检测 → SYSTEM_PROMPT_CHANGED / TOOL_SCHEMA_CHANGED / MODEL_CHANGED / CONTEXT_REORDERED 四分类留痕，纯观测零字节改动
- **跨会话预热曲线**（US27）：metrics 聚合层逐 repIndex 分层均值（rep1..repN），ConfigSummary.warmupCurve + Dashboard 一节

### 4.4 逆补丁法五源数据集

| 源 | 规模 | 用途 |
|---|---|---|
| Defects4J（逆补丁构造） | ~100 | 主集 |
| Vul4J | ~30 | 高险子集（US15：v4-pro 模型消融） |
| Multi-SWE-bench Java | ~30 | 仅 C/E 对照 |
| clean MR | ~50 | 阴性对照（每 Finding 计 1 FP） |
| MCR-Bench | — | 判定校准参照 |

### 4.5 判定链与指标

- **判定链**：原生真值 → 规则粗筛 → GPT judge（异构 gpt-5.2-pro，API key 脱敏纪律）→ 10% 人工抽检（种子确定性，`docs/human-review-sampling-protocol.md`）
- **指标口径**：≥3 重复 mean±std；rep1 冷 / rep2+ 热分层缓存报告；RIE（上下文效率）与 CARC（含工具成本的检视成本）；**S/A/B 主判定锚配置 C**
- **Verifier 消融**：二遍 Verifier on/off 对照（token 计入 CARC）

### 4.6 实验运行器与双 CLI

- `pnpm experiment`：五配置 × 数据集 × 重复跑批，单元级 `(source, caseId, configId, rep)` 断点续跑 + 损坏记录上报（corruptRecordFiles，不静默丢弃）+ `--report-only` 零调用重建 + Dashboard
- `pnpm reference`：Claude Code 外部参照单列——同仓同 diff 同目标在 Claude Code 上跑检视，归一化后经同一 metrics 管线以伪配置位 `claude-code` 单列评分；**verdicts 恒 null、显式排除在 S/A/B 之外**（模型不可同源，跨配置比较无意义）；`--model` 校验 Claude 系模型族（claude-* 或 sonnet/opus/haiku 别名），实际模型由 CLI 回报照实归档

## 5. 实现规模

`git diff main...spec/poc1-thin-harness`：**298 个文件，+53,950 行**（83 提交）。

| 目录 | 文件数 | 行数 | 内容 |
|---|---|---|---|
| `src/` | 131 | +20,888 | 产品代码（harness / loop / zoneb / tools / codeintel / metrics / judge / experiment / reference / deepseek / shared …） |
| `tests/` | 97 | +17,209 | 987 个测试（77 文件常规门 + e2e 门控冒烟） |
| `data/` | 55 | +13,416 | 五源数据集材料 |
| 根配置等 | 14 | +2,437 | package.json / tsconfig / vitest / lockfile 等 |

code-review 修复轮（收尾质量门）另计：11 提交，41 文件，+2,959 / −1,015——含上述部分。

## 6. 质量保障

- **常规门**：`pnpm test` 零网络、零真实 LLM（主 seam = LLM client 边界的可编程 fake；数据集构造与指标计算走纯函数旁路）；**987/987 全绿**；`pnpm typecheck` **0 错误**
- **覆盖率门**：`pnpm test:coverage`（@vitest/coverage-v8，src/ 全局 80% 阈值）——基线 **90.7% lines / 88.5% branches / 95.4% functions**
- **两轴 code-review**（Standards：文档化标准 + Fowler smell 基线 / Spec：issue 对照）：10 项发现（A–J）**全部修复**，代表性修复：
  - 请求映射白名单补 deepseek-v4-pro（US15 高险消融真实路径断裂）
  - DeepSeek 客户端四处错误路径 API key 脱敏（`[REDACTED]` 断言锚定）
  - Cache Break 分类（US13）与预热曲线（US27）补齐
  - 表驱动 CLI 解析骨架 + 双 report/CLI 共享原语去重（行为零变化、特征测试先行）
  - OpenAI 兼容 HTTP 共享内核（deepseek/gpt 双客户端去重）
  - run-store 损坏记录不静默丢弃（ReadAllResult 上报 + 报告留痕）
  - reference `--model` Claude 系模型族校验
- **e2e 冒烟**（环境变量门控，不计入常规门）：真实 DeepSeek 客户端单 MR 单配置；Claude Code 参照单 case

## 7. 交付与验证状态

| 项                    | 状态                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------- |
| 分支                   | `spec/poc1-thin-harness` @ `5490e68`，已推送远端（git 传输被网络阻断，经 git database API 复刻推送，SHA 级校验一致） |
| PR                   | **#15 ready for review**，body 含完整实现总结与修复轮明细                                               |
| 工单                   | #2–#14 全部 close（逐工单验收评论留痕）；#1（spec）随 PR 合入关闭                                              |
| `pnpm typecheck`     | ✅ 0 错误                                                                                    |
| `pnpm test`          | ✅ 987/987                                                                                 |
| `pnpm test:coverage` | ✅ 90.7% lines（阈值 80%）                                                                     |
| `/code-review`       | ✅ 10 项发现全部修复                                                                              |
| 冒烟 e2e               | ✅ DeepSeek config A + Claude Code 参照（见 §8 注记）                                             |
|                      |                                                                                           |

## 8. 遗留事项与下一步

1. **小样本 Benchmark 试跑**（未执行，PR Test Plan 未勾项）——产出分层缓存报告 + S/A/B 判定 + 预热曲线，即论文的第一批实验数据。属下一阶段执行项，不阻塞平台代码验收。
2. **S/A/B 判据分歧已裁决**（ADR-0004）：S 级纳入 **Precision ≥ C**（补全质量侧完整性，防靠少报降本冲线）、不设 Tool Calls 档位门槛（Token 总账已含工具成本，锚 C 全仓注入下工具调用基数低、×30% 有结构性不可达风险）；A/B 两档维持不变。已落地 `verdict.ts` 判据表（S 级四判据），判定测试同步扩展。
3. **T13 e2e 实测注记**——本机 claude CLI 经代理后端，actualModel 回报 MiniMax-M3（与 DeepSeek 异源，满足「外部参照不进主判定」的隔离要求，但非工单预期的 Claude 系模型）；已在外部参照报告的 runtime 留档中如实记录。
4. **Phase 1：DSH 迁移**——实验结论（A–E 胜出配置）决定 DSH Runtime 实现深度；harness 的 Context Engine / Ledger / 消息构造 TypeScript 代码届时直接复用（ADR-0001）。

---

*本文档由 PR #15 交付记录、修复轮提交链（`755a15e..5490e68`）与验收评论整理而成；需求原文见 GitHub issue #1，工单见 #2–#14。*

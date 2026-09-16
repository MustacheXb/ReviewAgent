# ReviewAgent

基于 DeepSeek Harness 的低 Token、高质量代码检视 Agent：用**最小充分上下文**（Minimal Sufficient Context）与**缓存稳定循环**（Cache-Stable Review Loop），以 20~30% 的 Token 成本获得接近全量上下文的检视质量。终点是落地到企业内部代码托管平台的 MR 检视。

本项目同时是一个 AI4SE 研究项目：以 VUL4J 单缺陷 MR 为基准，对五种上下文策略配置做受控实验（真实网关、三侧数据、四层判定链），论文主数据与分析报告见 [`docs/report/`](docs/report/)。

## 研究设计一览

**受测配置**（A–E，同一模型同一判定链，只变上下文策略）：

| 配置 | 上下文策略 |
|---|---|
| A | 零工具，纯 MR 上下文 |
| B | A + 确定性预取（Diff → Symbol → Reference → Call Chain 固定管线） |
| C | 全仓注入（+ `review.*` 工具 7 个） |
| D | 自主拉取 + 稳定前缀 |
| E | D + Context Ledger（上下文登记账） |

**判定链四层**：原生真值（逆补丁法）→ 规则粗筛 → LLM-as-judge（异构 glm-5.3 @ 火山网关）→ 人工抽检（calibration）。
**判级**：S/A/B（ADR-0004）；**验收**：指标对齐门 v2——配对符号检验 + 对称带 + 时点 advisory（ADR-0007）。
**Phase 2 主数据**：30 case × 5 配置 × 3 rep = 450 单元 × 三侧（main / 噪声对照 / DSH 附录），结论见《[Phase 2 主数据分析报告](docs/report/Phase 2 主数据分析报告.md)》。

## 仓库结构

```
src/                    POC1 薄 harness 主链（experiment / judge / metrics / sampling /
                        codeintel / zoneb / tools / gate / dataset / …）
packages/review-dsh/    DSH 内核侧（阶段 1 迁移；独立包 + 确定性纪律门）
scripts/                实验 / 门 / 分析 / 物化脚本入口（tsc 即编即跑，产物落 .tmp-gen/）
data/                   数据集清单与 MR 物化（vul4j / defects4j / msb-java / clean-mr）
runs/                   实验产物（不入库；*/REPORT.md 作为结论文档例外入库）
docs/                   ADR / 设计方案 / 评测方案 / 报告 / 计划书 / agent 协作约定
CONTEXT.md              领域词汇表（术语唯一权威，单一上下文）
reference_project/      外部参考项目（不入库，见下节）
```

## 快速开始

```bash
# 前置：Node >= 22，pnpm 10.30.3（corepack enable 即可）
pnpm install
pnpm test          # 全量回归（约 1080 项）
pnpm typecheck     # 根包类型检查
```

CI（push / PR）跑两层门：`discipline-gate`（确定性纪律门 · 零网络）+ `suites`（两包 typecheck + 全量测试）。**真实网关调用不进 CI**（零网络纪律，#28），只走本地脚本按需执行。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm test` / `pnpm test:e2e` / `pnpm test:coverage` | 回归 / E2E / 覆盖率 |
| `pnpm typecheck` | 根包类型检查 |
| `pnpm experiment -- --id <id> --cases-file <file> --configs A,B,C,D,E --reps 3 --judge --judge-model <model>` | 实验运行器（真实网关；产物落 `runs/<id>/`） |
| `pnpm alignment-gate` | 指标对齐门 v2 复算（gate JSON 留痕） |
| `pnpm analyze:phase2` | Phase 2 六面分析一键复算（读 `runs/phase2-*`） |
| `pnpm materialize:vul4j` | VUL4J 数据集物化（case → 本地仓库 + MR） |
| `pnpm reference -- --id <id> --cases-file <file>` | Claude Code 外部参照运行器（单列报告，不进 S/A/B 主判定） |
| `pnpm --filter review-dsh gate:discipline` | DSH 侧纪律门（本地同 CI） |

## 凭据配置（.env.local，绝不入库）

实验运行器从仓库根 `.env.local`（gitignored）自动装载凭据，缺失即启动报错并给清单，绝不回显 key 值：

```ini
DEEPSEEK_API_KEY=...    # 被测模型（恒需）
DEEPSEEK_URL=...        # 可选：中转/代理端点覆盖
JUDGE_API_KEY=...       # judge 环节（--judge 时需要，任选一名；火山网关 glm 走此通道）
JUDGE_URL=...           # 可选：自定义 OpenAI 兼容网关端点
OPENAI_API_KEY=...      # 兼容别名（旧名；与 JUDGE_API_KEY 同设时新名优先，#42）
OPENAI_URL=...          # 兼容别名（旧名）
```

## 目录与入库约定

| 路径 | 入库 | 说明 |
|---|---|---|
| 源码 / 文档 / 数据集清单 | ✅ | |
| `runs/**/REPORT.md` | ✅ | 实验结论文档（唯一例外） |
| `.env.local` | ❌ | 凭据 |
| `reference_project/` | ❌ | 外部参考仓（见下节） |
| `runs/**`（除 REPORT.md） | ❌ | 实验记录与数据 |
| `.cache/` | ❌ | 数据集缓存 / 留痕 / 分析产物 |
| `.tmp-gen/` | ❌ | 脚本编译产物 |

## 参考项目（reference_project/，不入库）

协同开发时需要的机制参照源。本地目录已被 gitignore——在新机器上按下表 clone 并 checkout 到锚定 commit 即可复现当时的参照状态：

| 本地目录 | 上游 | 锚定 commit | 参照角色 |
|---|---|---|---|
| `deepseek-harness` | <https://github.com/deepseek-ai/deepseek-harness> | `5dda764`（2026-09-08，0.1.5-alpha.1） | 内核机制参照：Everything-is-a-Plugin 架构、Session append-only log、Agent Loop 可替换（ADR-0005/0006 的决策依据；本项目名即「基于 DeepSeek Harness」） |
| `open-code-review` | <https://github.com/alibaba/open-code-review> | `82af2fb`（2026-09-02） | 同域开源检视 Agent：产品形态与公开评测对齐对象（AACR-Bench 已支持 reviewer 之一） |
| `prime-agent` | <https://github.com/PrimeIntellect-ai/prime-agent> | `c718bf3`（2026-08-31） | Agent harness 设计参照（self-improving RLM harness） |
| `whale-pod` | <https://github.com/Timothyhay/whale-pod> | `d76f522`（2026-08-13） | 轻上下文 + 前缀缓存设计参照：known world + 懒拉取 + 前缀稳定，与本项目 Minimal Sufficient Context / Stable Prefix 命题同源；其实测化 bench 方法论亦为本项目纪律参照 |

```bash
# 恢复参考项目（在仓库根执行）
git clone https://github.com/deepseek-ai/deepseek-harness.git reference_project/deepseek-harness
git clone https://github.com/alibaba/open-code-review.git   reference_project/open-code-review
git clone https://github.com/PrimeIntellect-ai/prime-agent.git reference_project/prime-agent
git clone https://github.com/Timothyhay/whale-pod.git       reference_project/whale-pod
cd reference_project/deepseek-harness  && git checkout 5dda764   # 其余同理
```

**DSH 依赖口径注意**：本项目的运行时依赖是 npm 包 `@deepseek-ai/dsh-sdk-protocol@0.1.2-rc.1`（lockfile 锁定，见 `packages/review-dsh`），本地参考仓（0.1.5-alpha.1）仅作机制阅读对照，**不是实际链接的依赖**；两者版本偏差逐项登记在《[DSH 内核机制偏差清单](docs/design/DSH 内核机制偏差清单（npm 0.1.2-rc.1 × reference 0.1.5-alpha.1）.md)》。

## 文档地图

| 文档 | 内容 |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | 领域词汇表（Minimal Sufficient Context / Zone A–C / Finding 等术语唯一权威） |
| [`docs/adr/`](docs/adr/) | 架构决策记录 0001–0007（POC1 独立 harness / 模型钉扎 / 零构建静态代码情报 / S 级判据 / DSH 迁移姿态 / DSH 内核形态 / 对齐门协议 v2） |
| [`docs/design/`](docs/design/) | 总体架构设计方案 / VUL4J 评测方案与数据复制指南 / AACR-Bench 公开评测接入方案 / DSH 偏差清单 |
| [`docs/report/`](docs/report/) | POC1 实现报告 / DSH 迁移实现报告 / DSH 指标对齐门报告（含噪声底）/ Phase 2 主数据分析报告 |
| [`docs/plan/`](docs/plan/) | 项目分阶段实现计划书 |
| [`docs/agents/`](docs/agents/) | agent 协作约定（issue tracker / triage labels / domain docs） |
| [`docs/human-review-sampling-protocol.md`](docs/human-review-sampling-protocol.md) | 人工抽检协议（判定链第四级） |

## 协作约定

- **Issue 即 spec**：需求与验收标准在 GitHub Issues（`MustacheXb/ReviewAgent`）管理，经 `gh` CLI 读写；约定见 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。
- **Triage 标签**：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。
- **提交信息**：Conventional Commits（`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`）。
- **零网络纪律**：真实网关实验只在本地脚本执行，CI 恒离线（#28）；验收复算产物（gate JSON / 分析输出）留 `.cache/` 或 `runs/`，结论入 `docs/report/`。

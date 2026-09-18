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
| `pnpm --filter review-dsh cli review --repo <path> --mr <diff> [--config A-E] [--model <id>] [--language en|zh]` | 单 MR 检视（DSH 内核 CLI；凭据经 `.env.local` / `REVIEWER_*`） |
| `pnpm --filter review-dsh cli smoke [--model <id>]` | 网关冒烟自检（#46）：双探针 + 人话诊断，通过 0 / 失败 1 |

## 单次检视执行（review-agent CLI）

单案检视入口是 `review-agent` CLI：薄 wrapper（解析 → `.env.local` 装载 → 装配 → run → 导出 → 呈现），**内核为 DSH**（cordis Context + 核内五插件，进程内直挂，见 `packages/review-dsh/src/cli/main.ts`；区别于根 `src/` 的 POC1 薄 harness——后者是冻结参照与共享模块源，不再被执行）。stdout 输出单个 JSON 文档（findings / rounds / toolCalls / truncated / auditPath）；审计与会话落 `--out` 目录；退出码：完成（含诚实截断）0 / 中止 1。被测模型缺省 `deepseek-v4-flash`，换模型加 `--model <id>`；输出语言缺省 `en`，切中文加 `--language zh`（只切 findings 自然语言字段，代码摘录 / 路径 / 枚举不翻译，#58）。以下命令均从**仓库根**以 `node packages/review-dsh/bin/review-agent.js` 直跑，以复用仓根 `.env.local`（`pnpm --filter` 形式的 cwd 在包目录，见下节凭据说明）。

### 评测场景（VUL4J 单案）

评测口径三要素：**物化仓（base 态）+ 数据集原生 diff + 数据集原生英文 issue**。issue 改用自编文本会引入口径污染；自编中文还会被模型引用进 evidence、触发 NON_ENGLISH 门整条拒绝。前置：数据集已物化（`pnpm materialize:vul4j`，仓落在 `.cache/datasets/vul4j-repos/`）。换案只改 `CASE`（30 案清单见 `data/vul4j/target-cases.json`）：

```bash
cd <本仓根目录>
CASE=VUL4J-6

REPO=$(node -p "require('./data/vul4j/target-cases.json').find(x=>x.caseId==='$CASE').repoPath")
ISSUE=$(node -p "require('./data/vul4j/target-cases.json').find(x=>x.caseId==='$CASE').issueDescription")
node -e "require('fs').writeFileSync('$CASE.diff',require('./data/vul4j/target-cases.json').find(x=>x.caseId==='$CASE').diff)"

node packages/review-dsh/bin/review-agent.js review \
  --repo "$REPO" --mr "$CASE.diff" --config B \
  --issue "$ISSUE" --out "runs/local-review-$CASE"
```

配置语义见顶部 A–E 表（B = 零工具 + 确定性预取，生产拍板形态）。可选：跑前查该案基线（`runs/phase2-dsh/runs/vul4j/<案>/B/rep-*.json` 的 `baseline.findings`）——被测模型非确定，单次结果落在基线 rep 波动族内即属正常复现。

### 检视本地任意代码仓

命令与具体目标仓解耦，参数抽象为 `<目标仓>`、`<MR diff 文件>`、`<变更描述>`：

```bash
cd <本仓根目录>    # .env.local 与 CLI 路径均按 cwd 解析

# 1) 在目标仓生成 MR diff（四选一，diff 描述待检视的变更）
git -C <目标仓> diff <base>...<head> > <MR diff 文件>      # 分支相对 base 的全部变更
git -C <目标仓> diff HEAD~<N> > <MR diff 文件>             # 最近 N 次提交
git -C <目标仓> diff <commit>~1 <commit> > <MR diff 文件>  # 指定某次提交
git -C <目标仓> diff HEAD > <MR diff 文件>                 # 未提交的工作区变更

# 2) 检视
node packages/review-dsh/bin/review-agent.js review \
  --repo <目标仓> --mr <MR diff 文件> --config B \
  --issue "<变更描述>" \
  --out runs/local-review-<名目>
```

三个使用注意：

1. **中文 MR 描述：`--language zh` 已打通，质量验证待跑**：缺省（`en`）档下，检视产出（title / description / evidence）被 NON_ENGLISH 门要求不含中文，而模型会把 `--issue` 中的中文描述自然引用进 evidence，导致整条 finding 被拒——评测场景用数据集原生英文 issue 属测量契约。日常单次检视遇中文 MR 描述，加 `--language zh`（#58）：Zone A 切中文分序列、语言门换 NON_CHINESE 判据（title / description 至少其一含中文即可，evidence 是代码引用面不设语言门——中文引用不再触发拒绝）、findings 自然语言字段中文产出（代码摘录 / 路径 / 枚举不翻译）。zh 档的抽样质量验证列入 #59 验证跑，未跑前不对 zh 产出质量背书。
2. **内核面向 Java**：角色提示词为 senior Java code reviewer、符号索引基于 tree-sitter-java。检视非 Java 仓可运行（diff 与 Zone B 仓库结构图仍工作），但符号预取层为空、角色错配，质量不保证。
3. **基线态语义**：检视读的上下文以仓内现状为准（CLI 不 apply diff）；评测约定仓停在 diff 的 base 侧。日常检视「仓在 head、diff 描述该段变更」亦可，上下文有轻微漂移。

## 凭据配置（.env.local，绝不入库）

实验运行器（仓库根执行）与 `review-agent` CLI（其所在 cwd 执行，#46）都会自动装载 `.env.local`（gitignored）：已有非空环境变量优先、不被覆盖；装载摘要只报键名与行号，key 值绝不回显。key 缺失即启动报错并给清单。注意 `.env.local` 按调用进程的 cwd 解析——`pnpm --filter review-dsh cli …` 的 cwd 是包目录（读 `packages/review-dsh/.env.local`）；要复用仓库根的 `.env.local`，从仓库根直接 `node packages/review-dsh/bin/review-agent.js …`：

```ini
# reviewer（被测模型）——恒需
REVIEWER_API_KEY=...     # 推荐名（#43）
DEEPSEEK_API_KEY=...     # 兼容别名（旧名；与 REVIEWER_API_KEY 同设时新名优先）
REVIEWER_URL=...         # 可选：自定义 OpenAI 兼容网关端点（推荐名；进 plan.json 留痕）
DEEPSEEK_URL=...         # 兼容别名（旧名）

# judge（判定链，--judge 时需要）
JUDGE_API_KEY=...        # 火山网关 glm 走此通道
JUDGE_URL=...            # 可选：自定义 OpenAI 兼容网关端点
OPENAI_API_KEY=...       # 兼容别名（旧名；与 JUDGE_API_KEY 同设时新名优先，#42）
OPENAI_URL=...           # 兼容别名（旧名）
```

被测模型经 `--model <id>` 自由指定（实验 CLI 的 `flash`/`pro` 别名保留）；wire 序列化与指标口径按 provider 画像表分派（`deepseek-*`/`glm-*` 内建，未知模型走保守默认）。judge 模型与被测可能同源时默认拒绝——任一侧自定义接入点设定则降级为 warning 放行（异构性转为实验者责任，#43）。

自定义网关（`REVIEWER_URL` 指向中转/自建端点）的可用性与兼容性由实验者自证：换端点或换模型后先跑冒烟自检——

```bash
pnpm --filter review-dsh cli smoke [--model <id>]
```

对目标端点发 1 次最小补全 + 1 次最小工具调用探针，输出人话诊断（通过 / 鉴权失败 / 模型不存在 / 不支持 function calling / 画像不匹配 / 限流 / 网络不通 / ……）与处置建议；通过退出码 0，任何失败诊断退出码 1。探针请求体走生产画像序列化（与检视路径同一单源）——冒烟通过即代表该模型在该网关上的 wire 方言与工具调用面可用。

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
| [`docs/adr/`](docs/adr/) | 架构决策记录 0001–0008（POC1 独立 harness / 模型钉扎 / 零构建静态代码情报 / S 级判据 / DSH 迁移姿态 / DSH 内核形态 / 对齐门协议 v2 / 被测模型可换 + 指标按 provider 能力分口径） |
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

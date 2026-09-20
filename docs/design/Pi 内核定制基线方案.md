# Pi 内核定制基线方案

> **文首说明**：2026-09-17 拍板——**以 Pi 代码仓为基础做全源码定制（vendor fork），不以 Pi 的 npm 包为基础消费**；
> 本文档记录 `pi-kernel` 分支的基线决策、包映射、接线改造、与上游的分歧清单、验证结果与后续票面。
> 前置分析见同目录《[ReviewAgent以DSH内核和PI内核的方案对比分析.md](ReviewAgent以DSH内核和PI内核的方案对比分析.md)》
> （该文的 DSH-first 结论以「可扩展性」为前置——本决策按「不考虑可扩展性」的前提重排，Pi 路线胜出）。
>
> **一句话结论**：`pi-kernel` 分支已把 pi 四个包（ai / agent / chord / telemetry，约 5.6 万行源码）
> 以源码形态 vendor 进本仓 pnpm workspace，构建链（`pnpm build:pi`）与既有全部测试门全绿；
> DSH 内核（`packages/review-dsh`）与全部评测数据/报告原样保留，本分支后续 Pi 适配以此为基座展开。
>
> **2026-09-18 更新（[ADR-0009](../adr/0009-pi-kernel-from-scratch-rewrites-review-runtime.md)）**：
> 「DSH 原样保留」已被《[Pi 内核从零实现方案](Pi 内核从零实现方案.md)》取代——DSH 内核已移除
> （评测数据/报告保留），本文 §8 后续票面（增量适配姿态）由从零实现方案的 P0–P5 取代；
> 本文 §1–§6 的 fork 接线、分歧清单与验证事实继续有效。
> 另勘误 §1 保留范围行「`chord`（agent 的会话/状态底座）」的表述：chord 实为**服务组合运行时**
> （`FacetHost` 装配 + `MutableReplicatedState` 复制状态，支持热重载）；agent 的会话模型在
> `packages/agent/src/harness/session/`（append-only + fork）。逐项事实见《[Pi 内核演化缝盘点](Pi 内核演化缝盘点.md)》S6/S7。

---

## 1. 决策背景

| 决策点 | 结论 | 依据 |
|---|---|---|
| 消费形态 | **全源码 vendor fork**，非 npm 包依赖 | 用户拍板（2026-09-17）：「不以 Pi 的 npm 包为基础新建，而是全新基于 pi 的代码仓定制化修改」。npm 消费线对内核形态的约束（版本节奏、发布物缺口、机制偏差）在 DSH 线已付过一次学费（《DSH 内核机制偏差清单》）；源码在手则机制即事实 |
| 保留范围 | 只保留 ReviewAgent 内核需要的 4 个包 | `pi-agent-core`（Agent/agent-loop，独立无 coding-agent 依赖）+ `pi-ai`（40+ provider 统一 API）+ `chord`（agent 的会话/状态底座）+ `pi-telemetry`（契约层）；coding-agent / tui / protocol / client / server / evals / session-backends 与检视内核无关，不复制 |
| DSH 遗产 | **原样保留** | 用户拍板「保留 DSH 内核版本的评测数据等内容」；`packages/review-dsh`、`runs/**/REPORT.md`、全部报告与 ADR 不动——后续以 `deps.piKernel` 之类的分支共存（见 §7） |
| 包名/目录 | **保留上游 `@earendil-works/*` 原名与原目录名** | 同步上游时 `git diff` 可直接对照原树；改名留给真正需要时（目前无消费者冲突） |

## 2. 上游锚定

- **仓库**：`earendil-works/pi`（MIT，Mario Zechner / Earendil Works；本地只读参考在主工作仓 `reference_project/pi`）
- **锚定 commit**：`6671c604766b3670ed95f405aa7856835d0ca702`（2026-09-16；发布版 **v0.85.1** 之后 11 天的 main 修复）
- **版本语义注意**：pi 的 `v0.9.x` tag 是 2025 年的旧线，`0.85.x` 才是 2026 年当前线——**不要**按语义化版本直觉排序
- **构建工具替换**：上游用 `tsgo`（@typescript/native-preview 7.0.0-dev）构建；本仓统一换 **tsc 5.9.3**（与 review-dsh/review-llm 同版本）。锚定源码满足 tsc 所需全部语法特性（`erasableSyntaxOnly` / `rewriteRelativeImportExtensions` / import attributes 均为 5.9 已稳定特性），四包全量编译零错误
- **License 履约**：`THIRD-PARTY-NOTICES.md`（仓根）携带 MIT 原文 + vendored 清单 + 数据出处

## 3. 包映射与体积

| 上游路径 | 本仓路径 | 包名 | dist 产物 | 测试文件 |
|---|---|---|---|---|
| `packages/telemetry` | `packages/telemetry` | `@earendil-works/pi-telemetry` | 6 js | 2 |
| `packages/chord` | `packages/chord` | `@earendil-works/chord` | 24 js | 9 |
| `packages/ai` | `packages/ai` | `@earendil-works/pi-ai` | 178 js + 39 data | 147 |
| `packages/agent` | `packages/agent` | `@earendil-works/pi-agent-core` | 92 js | 55 |
| `tsconfig.base.json`（仓根） | 仓根 `tsconfig.base.json` | — | — | — |

包内 `tsconfig.build.json` 均 `extends "../../tsconfig.base.json"`——原路径指向即本仓根副本，**零改动**。

## 4. 接线决策（对上游树的全部改动）

### 4.1 package.json（四包共性）

| 项 | 改动 | 理由 |
|---|---|---|
| 内部依赖 | `^0.85.1` → `workspace:*` | workspace 内链接，版本随树 |
| `exports` | 每条目补 `"types"`/`"source"` → `src/*.ts`，保留 `"import"` → `dist/*.js` | 镜像 review-llm 形态（`packages/review-llm/package.json` 的先例）：消费者 typecheck/测试吃源码，编译产物路径运行时兜底 |
| `scripts.build` | `tsgo` → `tsc` | 见 §2 构建工具替换 |
| `scripts.typecheck` | 新增 `tsc -p tsconfig.build.json --noEmit` | 与两既有包对齐 |
| devDeps | 补 `typescript 5.9.3`；ai/agent 另补 `shx 0.4.0`（build/clean 用，上游 npm 扁平结构下未声明也能跑） | pnpm 严格隔离：脚本用到的工具必须显式声明 |
| devDeps | 四包补 `vite 8.0.16`（对齐上游 package-lock 解析值） | **peer 隔离**：pi 的 vitest 4.1.9 要求 vite ≥6，根工作区 vitest 2.1.9 携带 vite 5.4.21，pnpm 会把不满足的 peer 链给 pi 包 → 运行时 `vite/module-runner` 缺失崩溃；显式声明 vite 8 后两代 vitest 各自隔离 |

### 4.2 依赖补声明（上游 npm 扁平结构的传递依赖显性化）

- `packages/ai` 新增 `@smithy/types 4.18.0`：`src/api/bedrock-converse-stream.ts` 直接 import，上游靠 npm 扁平 node_modules 的传递提升解析；pnpm 严格隔离下必须声明（版本取 lockfile 已解析值，不引第二份）
- pnpm `onlyBuiltDependencies` **不加** canvas / @google/genai / protobufjs（安装时构建脚本被阻塞，属预期）：图像测试与相应 provider 运行时不在基线范围，保持安装确定性

### 4.3 ai 包构建脚本 fork

```
上游 build = generate-models（联网拉 models.dev/OpenRouter 再生成数据）→ build:offline
本仓 build = build:offline（check:model-data → tsc → shx 复制 data 到 dist）
```

**committed data 即真源**：不再联网再生成，`check:model-data` 在每次构建时守数据与源码一致性。

### 4.4 新增文件（fork 增量）

| 文件 | 性质 | 理由 |
|---|---|---|
| `packages/telemetry/vitest.config.ts`、`packages/chord/vitest.config.ts` | 新增 | 上游这两包零 vitest 配置（靠默认 include 覆盖 `test/**`）；本仓**根** `vitest.config.ts` 携带自定义 include（`src/**`, `tests/**`）且会被 vitest 向上查找应用 → 本地空壳配置切断继承、恢复默认 include |
| `packages/chord/test/boundary.test.ts`（`sep` 修复） | 改动 1 行 | 上游潜伏 bug：`resolve()` 在 Windows 产反斜杠路径，判定却用正斜杠拼接 `${sourceDirectory}/`，全部包内相对导入被误判越界（上游 POSIX CI 未暴露）；改 `path.sep`，posix 语义不变 |
| `THIRD-PARTY-NOTICES.md` | 新增 | License 履约 + 数据出处（§5） |
| `.gitignore` 增 `.artifacts/` | 改动 | ai 的 `generate-model-catalog` 输出目标 `../../.artifacts/` |
| 根 `package.json` 增 `build:pi` | 改动 | 拓扑序构建：`telemetry → chord → ai → agent`（agent 的 `tsconfig.build.json` paths 指向 `../ai/dist/*.d.ts`，构建顺序是硬依赖） |

**数据文件提交**：`packages/ai/src/providers/data/*.json`（39 个 provider，688K）——上游 gitignore 不入库，本仓作为 fork 决策**入库**（见 §5）。

### 4.5 明确不做的事

- **不 vendor** `vitest.base.ts`：那是未保留包（protocol/client/server/coding-agent/tui）的共享配置；ai/agent 的 vitest.config.ts 自含（别名内联），无 extends 依赖
- **不加** pi 包测试进 CI 门：上游测试含 POSIX 路径假设（§6），Linux CI 才是其设计运行环境；本仓 CI 门保持「根 + 两既有包」不变
- **不 prepare**：四包无 prepare 脚本（review-llm 的 prepare 先例是「有运行时消费者」时的形态；当前无消费者，避免 pnpm 安装期构建顺序脆弱性）

## 5. 模型数据出处与一致性验证

`pi-ai` 的 `src/providers/data/*.json`（模型目录，被 39 个 `*.models.ts` 静态 import）上游不入库、由 `scripts/generate-models.ts` 联网生成——git 单独 clone 无法编译。处置：

1. 从 npm 发布物 `@earendil-works/pi-ai@0.85.1` tarball 提取 `dist/providers/data` → `src/providers/data` 并提交；
2. 一致性双证据：**v0.85.1..锚定 commit 的 diff 不含任何 `*.models.ts` 变更**（数据消费面未动）+ 上游 `check:model-data` 校验通过（「Generated model data is valid.」，锚定源码 × 提取数据逐 model id 断言）；
3. `check:model-data` 进 ai 包构建链（§4.3），此后任何数据漂移构建即红。

**与上游「每日再生成」路线的刻意分歧**：上游 CI 的 build 先联网 `generate-models`（吃 models.dev/OpenRouter 当日目录）再跑测试——锚定源码的部分测试按「发布后新增的目录条目」书写（如 `deepseek-flash`、`accounts/fireworks/models/*` 新条目的 `defer_loading` 能力位、Baseten session affinity 目录位）。本仓**锁定发布快照**而非跟随再生成：确定性优先（数据字节不随抓取日期漂移）、出处可考（npm 发布物）；代价是 ai 包 27 个上游测试红（§6.2，逐条核实全部为目录期望类，非序列化逻辑破损——序列化逻辑源码与上游逐字一致，同族测试 1037/1064 过，openai-completions 家族 46/47 过，deepseek-v4-flash 在快照内在位）。未来需要新目录时按 §9 的同步流程显式升级，不做隐性联网再生成。

## 6. 验证结果与已知限制

### 6.1 基线验证门（全绿）

| 门 | 结果 |
|---|---|
| `pnpm build:pi`（四包拓扑构建） | ✅ 4/4（telemetry 6 / chord 24 / ai 178+39 data / agent 92 js） |
| `pnpm typecheck`（根） | ✅ 零错误 |
| `pnpm test`（根，全量回归） | ✅ 86 文件 / 1177 用例 |
| `pnpm --filter review-llm test` | ✅ 34/34 |
| `pnpm --filter review-dsh test` | ✅ 208 过 + 1 skip |
| `pnpm --filter review-dsh gate:discipline`（纪律门） | ✅ 55/55 |

### 6.2 上游包测试（信号采集，不进门）

| 包 | 结果 | 说明 |
|---|---|---|
| telemetry | ✅ 15/15 | 加本地 vitest 配置后直接绿 |
| chord | ✅ 162/162 | 含 boundary 测试的 `sep` 修复（§4.4） |
| agent | 665 过 / 45 败 / 2 skip（712） | 45 个失败**全部**为上游 POSIX 路径假设（41 jsonl-v3-migration + 2 jsonl-session-repo：测试用 `/workspace` 字面 cwd，`path.resolve` 在 Windows 解析为 `D:\workspace`；1 nodejs-env + 1 tools：pi `canonicalPath` 产 `/tmp/...` posix 形态 vs 测试期望 Windows `realpath`）。上游 Linux CI 应全绿；本分支不追修上游可移植性（如需在 Windows 全绿，独立票评估） |
| ai | 1037 过 / 27 败 / 841 skip（1905；skip 多为环境门控） | 27 个失败逐条核实**全部为目录数据期望类**（§5：测试引用 v0.85.1 发布后新增的模型条目/能力位，`getModel` 查无 → undefined）；序列化逻辑无破损证据——执行面 1037/1064 过，openai-completions 家族 46/47（唯一失败是目录枚举循环），canvas 类用例在 skip/预期内 |

### 6.3 已知限制（如实携带）

- **Windows 本机**跑 agent 包测试会有 45 个 POSIX 路径假设失败、ai 包有 27 个目录快照期望失败（§6.2，两类成因都根在上游，非本仓接线破损）；本仓自身门（根 + review-dsh + review-llm）在 Windows 全绿，不受影响。两包测试若要全绿：agent 需 POSIX 环境（上游 Linux CI 形态），ai 需按 §9 显式升级数据快照
- 安装时有三个被阻塞的构建脚本警告（@google/genai / canvas / protobufjs）——预期行为，`pnpm approve-builds` 不需要执行
- pi 包 `engines: node >=22.19.0`；本仓根 `engines: >=22`——本机 v24 与 CI node 22 均满足

## 7. 与既有架构决策的关系

| 既有决策 | 本分支关系 |
|---|---|
| ADR-0005（DSH 迁移姿态）/ ADR-0006（DSH 内核形态） | **DSH 线有效、本分支不受其约束**；pi 内核的形态决策（agent-loop 驱动方式、字节纪律落点、审计导出）由后续 pi 适配票随新 ADR 记录 |
| Config B 生产形态（2026-09-17 拍板） | **不因换内核改变**——Zone A/B/C 组装、预取管线、Finding/Evidence 契约全部内核无关（~88% 复用层）；pi 内核的工作是把同一形态的执行/审计/字节捕获搬到 pi 原语上（`StreamOptions.onPayload`/`onResponse`、`compaction: {enabled:false}`、单 turn 驱动） |
| 《DSH 内核机制偏差清单》 | DSH 线事实记录，保留；pi 线的等价机制事实（inject/FIFO 语义、唤醒竞态有无）由 pi walking skeleton 票建立 |
| review-dsh / 评测数据 / 报告 | 原样保留（决策 §1）；两内核在分支上共存，评测对照（「Harness 影响效果还是 Review 架构影响效果」）仍是潜在实验维度 |

## 8. 后续票面（建议，未立项）

| # | 票 | 内容 | 对应 DSH 线先例 |
|---|---|---|---|
| P1 | pi 内核 walking skeleton | `pi-agent-core` Agent 直驱六阶段骨架（单轮 config B 形态）：`onPayload` 捕获 wire 字节、`compaction` 关闭、请求 1 布局（Zone A 系统提示 + Zone B/MR/预取注入序）逐字节断言 | #18 |
| P2 | Zone A/B 字节纪律门镜像 | POC1 冻结件 × pi 审计投影的逐字节对照（复用 `buildSystemMessage`/`buildPrefetchContext` 真源） | #22/#23 |
| P3 | review-pi 包骨架 | `packages/review-pi`：内核驱动 + 审计导出（装填 POC1 `AuditFileContent`）+ CLI wrapper 形态 | #20/#24/#26 |
| P4 | 实验 runner 接入 | kernel-host 桥接形态决策（进程边界 vs 进程内）+ `deps` 分支 | #27 |
| P5 | 指标对齐门 | 45 单元重跑 × #30 对称 max σ 带方法（换内核与换模型同理：结论不自动迁移） | #29/#30 |

**验收方法论直接复用**：确定性纪律门（字节/审计断言）+ 指标对齐门（噪声带）双门结构——这是 DSH 线 12 票沉淀的迁移验收协议，内核无关。

## 9. 同步上游的操作约定

- 上游更新时以锚定 commit 为基线 `git diff` 上游树 → 人工挑拣 cherry-pick 到本仓对应包目录；本基线的分歧全部落在 §4 清单内（package.json / 2 个 vitest 配置 / 1 处测试修复 / data 入库），源码本体零改动——diff 面越小同步越容易
- 源码级修改（未来必然发生：内核定制点）必须在改动处带 fork 注释并回写本文档 §4 分歧清单
- 版本锚定信息变更（升级 pi）时：更新 §2、`THIRD-PARTY-NOTICES.md`、重跑 §6.1 全门

# VUL4J 评测方案与数据复制指南

> 目的：完整记录 Review Agent（基于 DeepSeek Harness）的评测方案，供其他项目参考与复制。
> 本文覆盖：数据来源与确定性构建、实验矩阵、判定链协议、指标体系、质量门、运行纪律、跨项目适配接口。
> 状态：Phase 2 主数据（#35）已按本方案执行；方案本身自 Issue #1/#32 演化而来，关键决策见 `docs/adr/`。

---

## 1. 方案总览

- **被测系统**：代码评审 Agent（DSH 内核驱动，被测主模型 deepseek 系）。
- **评测问题**：给定一个「引入缺陷的 MR」，Agent 能否以可接受的 token 成本发现缺陷（真值位置）？
- **实验矩阵**：30 案 × 5 配置（A–E）× 3 重复 = **450 单元**（单元 = (case, config, rep)）。
- **判定**：rule 筛查（行级 P/R/F1）+ LLM-as-judge 链（异构模型裁定 finding↔truth 匹配）。
- **数据可复制性**：上游公开数据集 + 全程确定性（种子化抽样、可重跑脚本、留痕审计）——同种子同输入重跑得到相同 30 案。

## 2. 评测数据集：来源与复制

### 2.1 来源链（全程留痕于 `data/vul4j/target-manifest.json`）

```
VUL4J 数据集 CSV（github.com/tuhh-softsec/Vul4J，129 条）
  → 取带 CWE 标注条目（66 条，全部带 CVE 编号）
  → 逐条取回修复 commit diff（65 条可达；1 条 404 剔除，rejectReason=patch-unreachable）
  → 剥离测试/二进制文件节 → 纯源码补丁 → parseUnifiedDiff 校验 → 边界指标（files/changedLines）
  → CWE 分层确定性抽样 → 30 案（target-manifest.json）
  → 物化（materialize-vul4j）→ data/vul4j/target-cases.json
```

### 2.2 抽样协议（确定性）

- **分层**：按 CWE id 比例分配（最大余数法），每层至少 1 条、不超过层容量。
- **层内抽样**：mulberry32，种子 = `poc1-vul4j-2026`（层内种子 = hash(`"poc1-vul4j-2026:<cwe>"`)）。
- **结果**：30 案覆盖数据集内全部主要 CWE，同种子重跑逐字节一致。

### 2.3 物化（`scripts/materialize-vul4j.ts`）

每个 case 的语义（注意方向）：

- `repoPath` — **修复版本（fix commit）仓库快照**。经 `api.github.com repos/{owner}/{repo}/tarball/{fixSha}` 下载解压（GITHUB_TOKEN 可选，缺省匿名），落在 `.cache/datasets/vul4j-repos/`（gitignored）。
- `diff` — **逆补丁 MR diff**（修复 → 漏洞方向）：应用该 MR 等价于撤销修复、重新引入缺陷。**评审任务 = 发现该 MR 引入的缺陷**。
- `truth` — 真值缺陷位置/描述（从修复补丁触碰文件与行推导），rule 筛查与 judge 链的对照基准。
- `issueDescription` — CVE/CWE 叙述（如 VUL4J-1 = alibaba/fastjson CVE-2017-18349，CWE-20）。
- `labels` / `extensions` — CWE、风险级别、allowedConfigs 等标注与扩展元数据。

### 2.4 复制命令

```bash
# ① 生成目标清单（确定性，缓存目录存在即离线可重跑）
pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
  --strict --skipLibCheck --outDir .tmp-gen scripts/generate-vul4j-manifest.ts
node .tmp-gen/scripts/generate-vul4j-manifest.js && rm -rf .tmp-gen

# ② 物化 30 案（清单里 status=eligible 的池条目）
pnpm materialize:vul4j -- --vul-ids <逗号分隔的30个vulId> \
  [--diffs-dir .cache/datasets/vul4j-diffs] [--repos-dir .cache/datasets/vul4j-repos]

# ③（可选）冒烟切片：单案 15 单元先验证链路
#    data/vul4j/smoke-cases.json 即此产物（VUL4J-38）
```

**复制核对**：`target-manifest.json` 的 `seed/targetTotal/poolTotal/eligibleCount/rejectedByReason` 字段 + 30 个 vulId 列表一致，即数据集等价。

## 3. 评测对象：五个实验配置（A–E）

定义在 `src/contracts/config.ts`（CONFIGS，字节级固定）：

| 配置 | 工具 | 预取 | 全仓注入 | 稳定前缀 | Ledger | 语义 |
|---|---|---|---|---|---|---|
| A | ✗ | ✗ | ✗ | ✗ | ✗ | 零工具基线（只给 MR 上下文） |
| B | ✗ | ✓ | ✗ | ✗ | ✗ | 固定管线确定性预取（Diff → Symbol → Reference → Call Chain） |
| C | ✓ | ✗ | ✓ | ✗ | ✗ | 工具 + 全仓注入（效果上限参照，带预算守卫） |
| D | ✓ | ✗ | ✗ | ✓ | ✗ | 工具 + Zone A 稳定前缀纪律 |
| E | ✓ | ✗ | ✗ | ✓ | ✓ | D + Context Ledger / Append-only（完整形态） |

- A/B 为零工具对照组；C/D/E 共用同一套 7 个 `review.*` 工具（schema 字节一致），差异只在上下文组装纪律。
- 每案可经 `labels.allowedConfigs` 限制适用配置（与计划配置求交）。

## 4. 实验矩阵与执行协议

- **单元**：(source, caseId, configId, rep)，本方案 = vul4j × 30 案 × A–E × 3 rep = 450。
- **重复语义**：主模型 thinking 模式不传采样参数（`src/deepseek/request-mapper.ts`：temperature/top_p/penalties/max_tokens 一律不传，保持字节最小），rep 间差异来自模型自身采样；**rep1 冷 / rep2+ 热**（指标层冷热分层：rep1 冷单列，rep2+ 热为主口径）。
- **执行顺序**：case → config → rep 顺序冷热分层执行。
- **留痕与续跑**：每单元完成即持久化 record（`runs/<id>/runs/vul4j/<case>/<config>/rep-N.json`）+ 审计文件；启动时快照已有记录恢复（同模型/校验器兼容才复用）；数据集一致性守卫（persisted cases.json ≠ 输入案集即拒绝续跑）。
- **失败隔离**：单单元失败留痕（failures.json）不拖垮整批；judge 阶段 error 留痕不自动重试——删除留痕文件后重跑即重判。
- **运行命令**：

```bash
pnpm experiment -- --id <experiment-id> \
  --cases-file data/vul4j/target-cases.json \
  --configs A,B,C,D,E --reps 3 \
  --judge --judge-model glm-5-3-260814
```

产物：`runs/<id>/report.json`（canonical 指标）+ `dashboard.md` + 每单元 record/judge/audit 留痕。

## 5. 判定链（LLM-as-judge）协议

两级：rule 筛查（确定性）→ judge 链（语义裁定）。judge 协议参数**锁定 MCR-Bench 论文值，不随模型漂移**：

- **模型异构约束**：judge 必须与被测模型不同源（客户端层拒绝 deepseek 系 id）；本方案用 `glm-5-3-260814`（经 OpenAI 兼容网关，key 经 `JUDGE_API_KEY`/`JUDGE_URL` 环境变量注入（#42 角色名；旧名 `OPENAI_API_KEY`/`OPENAI_URL` 兼容），不落代码与日志）。
- **校准参数**：temperature 0.2 / top_p 0.95（论文协议值，全模型锁定）。
- **max_tokens = 画像表驱动容量上界**（#39 定值、#42 起查共享包 provider 画像表）：gpt 系/未知模型 8192（论文锚）；glm 等推理模型 32768——推理模型 completion 含 reasoning tokens，8192 会被吃满导致 content=0 截断（探针实测）。**容量随模型族，校准参数不随**。
- **裁定语义**：finding↔truth 卡片匹配（model_defect_i ↔ ground_truth_j + match_confidence + 理由），置信度门槛缺省 `low`（`MATCH_CONFIDENCE_RANK` 排序）。
- **有界重试**：仅 429/500/503/网络/超时重试（3 次指数退避）；响应格式错误与 finish_reason=length 截断**不自动重试**（显式失败留痕）。
- **指标回落**：judge 失败时该单元 judge 指标回落 rule 筛查值，单元数据本体完整（重判可恢复）。

## 6. 指标体系

每个单元产出行级 + 语义两层指标（`src/metrics/`）：

- **rule 筛查**（确定性）：line-level Recall / Precision / F1（finding 行 vs truth 行）。
- **judge 链**：经裁定的 finding↔truth 匹配后的 P/R/F1（双口径：rule 与 judge 各自成列，disagreement 单列）。
- **效率指标**（`src/metrics/efficiency.ts`）：
  - **RIE** = line-level Recall × Precision ÷ (Total Tokens / 1K)
  - **CaRC** = uncachedInputTokens + cacheWriteTokens + outputTokens + toolCostTokens（缓存命中不计，缓存写计入）
- **token 双口径**（预算与报告必须并列）：
  - 计费口径 = uncachedInput + output
  - 含缓存读口径 = totalInput + output
- **冷热分层**：rep1（冷）单列，rep2+（热）为主口径。

## 7. 质量门

| 门 | 内容 | 位置 |
|---|---|---|
| 确定性纪律门 | 具名 gate 套件、零网络强制进 CI（#28） | CI |
| 指标对齐门 | 真实网关 45 单元重跑 vs 参照实现对照（#29） | CI / 手动 |
| 噪声底校准 | 冻结 harness 自身重跑判不过 ±1σ 门；DSH 出带定性为检验力问题（#30） | 手动 |
| 完成预算门 | judge completion 容量随模型族（#39，见 §5） | 实现层 |
| 噪声控制门 | 数据采集窗约束（≤48h 窗口内完成主数据，#36） | 运行期 |

## 8. 运行纪律与实操经验（长跑必读）

- **进程纪律（Windows）**：后台跑停机**绝不用 TaskStop**（只杀包装层、node 孤儿继续写盘）——用 `wmic process where "name='node.exe'" get ProcessId,CommandLine` 找 PID + `taskkill //F //T //PID <pid>`；Git Bash `ps aux` 看不到 Windows 原生 node。
- **分片并行**：runner 单进程串行；并行 = 案级不相交分片 + **新 experiment id**（数据集守卫拒绝同 id 不同案集）+ 终跑合并（案集不相交 → 纯目录复制，无覆盖）。经验：5 并发有网关争用（D/E 单元 2.5–3h），2–3 并发性价比最高。
- **判活证据链**：CPU/IO 静止 ≠ 挂死（socket 流量不计入进程 I/O 计数器）——看 TCP 连接 CreationTime 轮转 + 30 分钟内新 record。
- **待机冻结**：Modern Standby 会冻结 runner；长跑配 keep-awake guard（`SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)`）。
- **judge error 处置**：删除 error 留痕 → 重跑即重判（格式错误按设计不自动重试）。
- **预算锚点**：单案 15 单元冒烟（VUL4J-38）实测 ~18 万计费 / ~47 万含缓存读 token；全量预算以双口径从 record 汇总（`tokens` 字段逐单元留痕）。

## 9. 复制到其他项目

### 9.1 管线形状（数据集无关）

```
数据集源 → [manifest 生成器] → target-manifest.json（池 + 抽样留痕）
        → [物化器] → target-cases.json（repoPath/diff/truth/labels 三件套）
        → pnpm experiment（矩阵执行 + judge + 指标 + 报告）
```

仓库内已有三个 manifest 生成器先例：`generate-vul4j-manifest.ts`（VUL4J）、`generate-d4j-manifest.ts`（Defects4J）、`generate-msb-manifest.ts`（MSB）——换数据集 = 新写一个「CSV/元数据 → eligible 池 + 确定性抽样」生成器 + 一个「池条目 → MRCase[]」物化器，下游全部复用。

### 9.2 MRCase 契约（适配接口）

新数据集只需产出满足契约的 case 数组（`src/contracts/`）：

- `caseId` 唯一；`repoPath` 本地仓库快照根；`diff` 统一 diff（评审对象 MR）；`truth` 缺陷真值（位置+描述卡片化供 judge）；`issueDescription` 叙述；`labels`（source/riskClass/allowedConfigs）。

### 9.3 评审语义建议

- 推荐「逆补丁 MR」语义（基线 = 已修复版本，MR = 撤销修复）：真值可从修复补丁机械推导，无需人工标注；上游须提供可达的 fix commit diff。
- 抽样必须种子化 + 分层（避免 cherry-pick 质疑）；manifest 留痕 rejectedByReason。

### 9.4 复制检查清单

- [ ] 数据来源公开可达，manifest 记录 seed / pool / eligible / rejected
- [ ] 物化脚本离线可重跑（diff/repo 缓存目录）
- [ ] 30 案 × 5 配置 × 3 rep 矩阵明确，冷热分层口径写进报告
- [ ] judge 与被测模型异构；temperature/top_p 锁定；max_tokens 按模型族给容量
- [ ] 指标含 rule/judge 双层 + RIE/CaRC + token 双口径
- [ ] 质量门（确定性/对齐/噪声）齐备再出结论
- [ ] 长跑纪律（进程/分片/判活/防休眠）按 §8 执行

---

*相关文档：`docs/design/基于 DeepSeek Harness 的 Review Agent 总体架构设计方案.md`（总体架构）、`docs/adr/`（关键决策）、`CONTEXT.md`（领域上下文）。*

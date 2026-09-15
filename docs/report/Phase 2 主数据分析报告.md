# Phase 2 主数据分析报告（#38）

> **范围**：#38「Phase 2 主数据分析报告」全部验收项——六面（判定分布 / 五配置对比 / 方差面 / 效率面 / 时点面 / 预算总账）+ 人工抽检校准 + dashboard 引用 + 口径衔接说明
> **交付形态**：本报告 + 复算脚本 `scripts/analyze-phase2.ts`（`pnpm analyze:phase2`）+ 人工抽检工具 `.cache/human-review-sheet.md`（本机留痕）
> **数据底盘**：`runs/phase2-main`（主数据 450 单元，canonical）+ `runs/phase2-noise`（噪声对照 450）+ `runs/phase2-dsh`（DSH 附录侧 450）+ `runs/phase2-smoke`（5 单元预检）；gate JSON 锚点 3 份（§13）
> **报告日期**：2026-09-15

## 1. 概述与一句话结论

Phase 2 主数据（30 案 × A–E × 3 rep = 450 单元）三侧齐备：主数据判定链全通（judge 450/450 零 error），#36 噪声对照自洽门 20/20 IN（PASS），#37 DSH 附录三侧门格面 20/20 IN 但配对符号检验 totalTokens FAIL（计费口径持平 +0.6%、含缓存读口径 +5.7%）——三侧数据均达到分析级质量，本报告为论文主表与消融叙事的单一数据源。

**一句话结论**：轻上下文双配置全面占优——A（零工具纯 MR 上下文）以 22.6k token/单元取得最高 judge recall（0.5008）与最高效率（RIE 0.0242），B（确定性预取）以 49.9k token/单元取得最高 precision（0.7835）与最高 judge F1（0.5763，D 名义 0.6257 更高但不稳定、不作对照结论）；**协议主锚 C（全仓注入）实证为效果最差且跨侧最不稳定配置**（judge recall 0.1341 最低、706.5k token/单元最贵、77% 单元零 finding、三侧 recall 极差 0.1487 最大），S/A/B 判定（B=S、A/D/E=B）三侧逐字一致，但门槛随锚塌缩严重失真——判定按协议机械呈现并全程注记（§3.3）。判定链 judge 环节是精度的主要来源（rule→judge recall 提升 2.6–5.8 倍，FP_RESCUED 269 vs TP_OVERTURNED 1）；人工抽检表单已生成、裁定未回收，一致性量化如实标注未完成（§10）。

## 2. 复算路径（无手抽数字声明）

- 本报告全部表格 T1–T8 由复算脚本一键重放：`pnpm analyze:phase2`（输出 markdown 至 stdout；复算留痕 `.cache/analyze-phase2-out.md` 为该命令输出的重定向产物），报告表格与其逐项对应；脚本读 `runs/phase2-{main,noise,dsh}/report.json` + judge record 留痕 + `runs/phase2-main/human-review/forms.json`。
- 数字来源仅三类：canonical `report.json`（执行/判定/metrics 汇总）、判定留痕（judge record 逐单元）、gate JSON（门锚点）。冷热分层与预热曲线取自 `report.json` 的 `metrics.perConfig[].cold/hot` 与 `warmupCurve` 字段。
- `runs/phase2-*` 与 `.cache/` 均为本机留痕不入仓（.gitignore 约定，与 #35/#36/#37 关票口径一致）；复算需本机数据在位。
- dashboard 产出（既有能力，未新造）：`runs/phase2-{main,noise,dsh}/dashboard.md`。

各表口径标注约定：**rule 口径** = 规则匹配（T10）直接产出的行级指标；**judge 口径** = 判定链（T11 judge 裁定 TP/FP）后的行级指标；S/A/B 判定使用 rule 口径热数据（ADR-0004 协议）；五配置对比主表使用 judge 口径每配置 90 单元均值。

## 3. 判定分布面（S/A/B）

### 3.1 三侧判定（T1，锚 = C rep2+ 热口径）

| config | main | noise | dsh |
|---|---|---|---|
| A | B | B | B |
| B | **S** | **S** | **S** |
| C | BELOW_B | BELOW_B | BELOW_B |
| D | B | B | B |
| E | B | B | B |

锚可用性：main 侧 anchor=C available=true；**三侧 outcome 逐字一致**（判定面对内核/重跑噪声稳健）。

### 3.2 B 配置判据明细（T1b，main 侧，rule 热口径）

| grade | metric | value | threshold | pass |
|---|---|---|---|---|
| S | RECALL | 0.1044 | 0.0087 | ✅ |
| S | PRECISION | 0.1506 | 0.0556 | ✅ |
| S | TOTAL_TOKENS | 49.6k | 207.2k | ✅ |
| S | CACHE_HIT_RATE | 0.8782 | 0.85 | ✅ |
| A | RECALL | 0.1044 | 0.0078 | ✅ |
| A | TOTAL_TOKENS | 49.6k | 207.2k | ✅ |
| A | CACHE_HIT_RATE | 0.8782 | 0.8 | ✅ |
| B | RECALL | 0.1044 | 0.0068 | ✅ |
| B | TOTAL_TOKENS | 49.6k | 345.3k | ✅ |
| B | CACHE_HIT_RATE | 0.8782 | — | ✅ |

四条 S 级判据全部通过且余量巨大——但余量来自锚塌缩，见 3.3。

### 3.3 锚塌缩与判定语义注记（本报告最重要的 caveat）

S/A/B 判据以 C（全仓注入）热口径为参照原点（ADR-0004）。主数据上该锚实测塌缩：

- **C 热 recall（rule 口径）main 侧仅 0.0097**；逐 rep 预热曲线单调衰减 0.0500 → 0.0194 → 0.0000（rep3 完全无有效命中）。
- 锚塌缩跨侧复现且幅度大：C 热召回 main/noise/dsh = 0.0097 / 0.0761 / 0.0515（极差 0.0664，7.8 倍）。
- 直接后果：S 级 recall 门槛 = C×90% = 0.0087——任何能产出少量有效命中的配置都轻松跨过；B 的 0.1044 是门槛的 12 倍。

**判读纪律**：B=S 成立的实证内核是「B 热召回超过 C 锚 2.2–10.8 倍（三侧：main 10.8×、noise 2.2×、dsh 2.5×）且 token 仅为 C 的 1/14」——B 显著优于 C 是数据事实；但 S 档的语义是「显著超越一个塌缩的锚」，不是「达到高质量水位」。论文引用 B=S 时必须连同本注记。C 的 BELOW_B 同理：对 C 自身的机械判定（token 判据永不过），非对其工程价值的贬断——但 §5.4 的实证面（77% 零 finding、recall 最低、成本最高）独立于判定语义成立。

## 4. 判定链面（rule 粗筛 → judge 链 → 人工抽检）

### 4.1 rule vs judge（T2，main 侧每配置 90 单元均值）

| config | rule Recall | judge Recall | rule Prec | judge Prec | rule F1 | judge F1 | disagreement 单元 | matchConf (H/M/L) |
|---|---|---|---|---|---|---|---|---|
| A | 0.1953 | 0.5008 | 0.268 | 0.7232 | 0.2003 | 0.5524 | 52/90 | 76/29/4 |
| B | 0.1275 | 0.4671 | 0.2192 | 0.7835 | 0.1582 | 0.5763 | 54/90 | 69/32/1 |
| C | 0.0231 | 0.1341 | 0.131 | 0.6349 | 0.105 | 0.5712 | 15/90 | 22/10/1 |
| D | 0.0702 | 0.2916 | 0.1516 | 0.7226 | 0.1442 | 0.6257 | 35/90 | 51/19/3 |
| E | 0.0702 | 0.2355 | 0.1619 | 0.569 | 0.1534 | 0.5196 | 23/90 | 37/14/1 |

- **judge 救回效应是判定链的主要价值来源**：recall 提升 A 2.6× / B 3.7× / C 5.8× / D 4.2× / E 3.4×；precision 提升 2.7–4.8×。disagreement 种类合计 FP_RESCUED=269（rule 判 FP、judge 改判 TP）vs TP_OVERTURNED=1（反向推翻）——规则粗筛严格偏保守，judge 环节单向救回。
- matchConf 为 judgeVerdicts 中 TP 匹配的逐条置信分布（条目级非单元级，A 侧 109 条）：高置信占比 67–71%（A 69.7%、B 67.6%、C 66.7%、D 69.9%、E 71.2%），低置信 ≤5%。
- skipped-no-findings（0 finding 单元，judge 零调用）：**A=5/90、B=10/90、C=69/90、D=48/90、E=55/90**——C 的 77% 零 finding 率是其实证塌缩的最直接表征（§5.4）。
- 人工抽检（第四级）状态见 §10：表单就绪、裁定未回收。

## 5. 五配置对比面

### 5.1 主表（T3，main 侧 judge 口径每配置 90 单元均值）

| config | lineRecall | linePrecision | lineF1 | totalTokens | cacheHitRate | RIE | CaRC | toolCalls | rounds |
|---|---|---|---|---|---|---|---|---|---|
| A（零工具） | **0.5008** | 0.7232 | 0.5524 | **22.6k** | 0.3678 | **0.0242** | 18.4k | 0 | 1.01 |
| B（+确定性预取） | 0.4671 | **0.7835** | 0.5763 | 49.9k | 0.8114 | 0.0105 | 19.8k | 0 | 1 |
| C（+全仓注入） | 0.1341 | 0.6349 | 0.5712 | 706.5k | **0.9249** | 0.0014 | 105.1k | 6 | 3.3 |
| D（+自主拉取+稳定前缀） | 0.2916 | 0.7226 | 0.6257 | 178.0k | 0.7769 | 0.0055 | 60.5k | 6 | 2.32 |
| E（D+账本） | 0.2355 | 0.569 | 0.5196 | 204.6k | 0.7981 | 0.0049 | 63.1k | 6 | 2.57 |

（配置定义：A/B 零工具（B = A + Diff→Symbol→Reference→Call Chain 固定管线预取）；C/D/E 同一套 7 个 review.* 工具（C 全仓注入 / D 自主拉取+稳定前缀 / E = D + 账本）。）

读法：**A 是效率与召回双冠**（recall 最高、token 最低、RIE 0.0242 为 B 的 2.3 倍、C 的 17.3 倍）；**B 是精度与 F1 冠**（precision 0.7835、F1 0.5763，cacheHit 0.8114 证明预取的缓存命中红利）；D 名义 F1 最高（0.6257）但**不作为稳定对照引用**（§5.5）；E 的账本增量（E = D + 账本）方向性为负——recall 三侧一致低于 D（0.2355<0.2916 / 0.2325<0.2364 / 0.2893<0.3403），precision 与 F1 同向，方向判断跨侧稳定可引用；幅度（recall 约 −19% 等）因 D 自身跨侧不稳定（极差 0.1039，§5.5）不可靠，不作精确对照结论。账本机制在本基准无正向收益（方向性结论）。

### 5.2 冷热分层（rule 口径，与判定锚同源；main 侧）

| config | 层 | lineRecall | linePrecision | totalTokens | cacheHitRate |
|---|---|---|---|---|---|
| A | cold | 0.1725 | 0.1994 (29/30) | 24,449 | 0.3563 |
| A | hot | 0.2067 | 0.3083 (30/30) | 21,720 | 0.3736 |
| B | cold | 0.1737 | 0.3462 (26/30) | 50,515 | 0.6779 |
| B | hot | 0.1044 | 0.1506 (30/30) | 49,573 | 0.8782 |
| C | cold | 0.0500 | 0.3194 (6/30) | 738,018 | 0.8908 |
| C | hot | 0.0097 | 0.0556 (12/30) | 690,678 | 0.9420 |
| D | cold | 0.1111 | 0.1944 (15/30) | 180,390 | 0.7889 |
| D | hot | 0.0497 | 0.1333 (24/30) | 176,855 | 0.7708 |
| E | cold | 0.0567 | 0.0909 (11/30) | 189,037 | 0.8030 |
| E | hot | 0.0770 | 0.1875 (18/30) | 212,431 | 0.7957 |

（口径：cold = 每案 rep1 首执行单元（30 案）；hot = 每案 rep2/rep3 均值（案级 30）；precision 括号 = 非空 precision 案数——空值即该案零 finding。该计数本身即 C 塌缩表征：C 冷层 30 案中仅 6 案产出过任何 finding。）

### 5.3 逐 rep 预热曲线（rule 口径，main 侧 lineRecall / linePrecision）

| config | rep1 R | rep2 R | rep3 R | rep1 P | rep2 P | rep3 P |
|---|---|---|---|---|---|---|
| A | 0.1725 | 0.1716 | **0.2418** | 0.1994 | 0.1964 | **0.4107** |
| B | 0.1737 | 0.1495 | 0.0594 | 0.3462 | 0.2011 | 0.1080 |
| C | 0.0500 | 0.0194 | **0.0000** | 0.3194 (n6) | 0.1042 (n8) | 0.0000 (n7) |
| D | 0.1111 | 0.0455 | 0.0539 | 0.1944 | 0.1095 | 0.1474 |
| E | 0.0567 | 0.0611 | 0.0929 | 0.0909 | 0.1439 | 0.2372 |

- **A/E 越跑越好**（A rep3 双指标显著抬升、E 温和上行）；**B/C 带内单调衰减**（C 衰减到零）。逐 rep skipped 数（main，每 rep 30 单元中）：A 1/2/2、B 4/1/5、C 24/22/23、D 15/16/17、E 19/19/17——C 的零 finding 率逐 rep 恒定，衰减不是偶发。
- 该现象与 #30 的「上下文重组 × 跨日部署漂移」不稳定族一致：B/C/D（重上下文配置）的 rule 侧产出对 rep 与运行环境双敏感；A/E（轻上下文/纯文本前缀）稳定。

### 5.4 C 配置实证注记（协议主锚 ≠ 实证最优）

C 是 S/A/B 判定的协议主锚（判据以 C 的比例定义，ADR-0004）——锚的语义是「参照原点」，不是「质量最优」。实证面 C 在本基准全线垫底：judge recall 0.1341 最低（A 的 27%）、706.5k token/单元最贵（A 的 31 倍）、77% 单元零 finding（69/90）、RIE 0.0014 最低、跨侧 recall 极差 0.1487 最大（§5.5）。全仓注入在该基准（VUL4J 单缺陷 MR 场景）上把模型淹没：上下文重组成主要噪声源，而非有效证据源。论文消融叙事可直接引用：**全仓注入的边际信息收益为负**。

### 5.5 D 配置不稳定归因（#30 结论引用 + 30 案推广）

**呈现纪律（#38 AC）**：D 的不稳定是配置固有属性（#30 定性：网关激进行为 × 自主拉取，双侧重跑均复现；单元耗时方差 30min–3h15m，#35 留痕）——本报告不以 D 为稳定对照做任何对比结论。D 名义 F1 最高（0.6257）即属此列：该名次跨侧不可复现为稳定结论。

跨侧对照（T3b，judge 口径 lineRecall / totalTokens 均值）：

| config | main R / T | noise R / T | dsh R / T | R 三侧极差 |
|---|---|---|---|---|
| A | 0.5008 / 22.6k | 0.4776 / 20.5k | 0.4786 / 21.4k | 0.0232 |
| B | 0.4671 / 49.9k | 0.4202 / 50.6k | 0.4217 / 49.4k | 0.0469 |
| C | 0.1341 / 706.5k | 0.2162 / 618.3k | 0.2828 / 675.6k | **0.1487** |
| D | 0.2916 / 178.0k | 0.2364 / 223.4k | 0.3403 / 226.1k | 0.1039 |
| E | 0.2355 / 204.6k | 0.2325 / 213.8k | 0.2893 / 255.7k | 0.0568 |

30 案推广：#30 在 9 单元 per-config 上观察到的 D 塌缩（r2 D recall 0.0），在 30 案上未再现为全塌缩（D=B 三侧判定一致），但 D 的跨侧 recall 极差 0.1039（相对差 35%）保留；且**不稳定族推广为 C/D（全仓注入/自主拉取的上下文重组族），C 极差 0.1487 比 D 更大**。A/E 极差 ≤0.057 最稳，B 居中。结论：上下文重组类配置（B/C/D）的 rule 侧产出对运行环境敏感，A/E 稳定——与 §5.3 逐 rep 衰减现象同族。

## 6. 方差面（误差棒，#36 σ 面引用）

跨 rep σ（**rule 口径**，#36 误差棒口径原样重放，T4 与 `.cache/error-bars-phase2.md` 逐值一致）：

| config/metric | main σ | noise σ |
|---|---|---|
| A/lineRecall | 0.1842 | 0.1354 |
| A/linePrecision | 0.2824 | 0.2176 |
| A/totalTokens | 6.2k | 5.0k |
| A/cacheHitRate | 0.13 | 0.1451 |
| B/lineRecall | 0.1034 | 0.165 |
| B/linePrecision | 0.2156 | 0.2341 |
| B/totalTokens | 7.7k | 7.2k |
| B/cacheHitRate | 0.1283 | 0.1403 |
| C/lineRecall | 0.0337 | 0.0847 |
| C/linePrecision | 0.0776 | 0.1309 |
| C/totalTokens | 287.4k | 302.1k |
| C/cacheHitRate | 0.0381 | 0.049 |
| D/lineRecall | 0.1055 | 0.1081 |
| D/linePrecision | 0.1964 | 0.1419 |
| D/totalTokens | 110.8k | 132.1k |
| D/cacheHitRate | 0.0781 | 0.0763 |
| E/lineRecall | 0.0889 | 0.1344 |
| E/linePrecision | 0.1218 | 0.1673 |
| E/totalTokens | 124.2k | 136.8k |
| E/cacheHitRate | 0.068 | 0.0656 |

**口径注记**：本面为 rule 口径 σ（#36 原口径，误差棒面沿 #36 重放）。论文主表（§5.1）以 judge 口径均值呈现——引用本表作误差棒时须注明口径差，或另行计算 judge 口径逐 rep σ（未在本报告产出）。

方差解读：**两类方差须分开引用**——跨 rep σ（本表，#36 误差棒，供论文主表误差棒）与跨侧极差（§5.5 T3b，环境敏感性）。C 的跨 rep σ 反而最小（recall 0.0337）恰因其产出贴地（σ 小但均值也小）——σ 小不等于稳定优，引用时须带均值。跨单元方差（gate 带口径）在 gate JSON `cells[].band`。

## 7. 效率面（token / cacheHit 双口径）

- **RIE（recall per 1k billed token）**：A 0.0242 >> B 0.0105 > D 0.0055 > E 0.0049 > C 0.0014——A 的效率是 C 的 17.3 倍。轻上下文在单缺陷 MR 场景下信息密度碾压全仓注入。
- **CaRC（每正确检出 token 成本）**：A 18.4k ≈ B 19.8k << D 60.5k < E 63.1k << C 105.1k。
- **cacheHit 双口径故事**：B 0.8114 vs A 0.3678——B 的确定性预取（固定管线顺序）把缓存命中率拉高 44 个百分点，是其 precision 优势的机制来源；C 0.9249 全场最高但属「贵上下文的重复读」而非效率（token 基数 14–31 倍）。D/E 0.78/0.80 受自主拉取的动态顺序拖累。
- **多轮/工具开销**：A/B 单轮零工具（rounds ≈1）；C/D/E 平均 2.3–3.3 轮、每单元 6 次工具调用——多轮机制在该基准没有转化为 recall/precision 优势，只转化为 token。
- token 口径注：totalTokens 为含缓存读口径（input + cacheRead + output）；计费口径见 §9 总账（billed = input + output）。

## 8. 时点面（执行窗 + 间隔记录，T6）

| 侧 | 首 record（UTC） | 末 record（UTC） | 时长 |
|---|---|---|---|
| main | 2026-09-12T11:14:53Z | 2026-09-14T01:55:21Z | 38.7h |
| noise | 2026-09-14T02:53:38Z | 2026-09-14T17:18:04Z | 14.4h |
| dsh | 2026-09-14T18:04:46Z | 2026-09-15T02:02:57Z | 8.0h |

窗间隔：main→noise **0.97h**、noise→dsh 0.78h、main→dsh 16.16h（#37 三侧门 gapHours 锚点）。噪声对照在 48h 时点纪律窗内启动（#36 AC 达成）。

运行事件账（如实，三侧累计）：

1. **外部杀进程 4 次**（main 期 2 次 + noise 1 次 + dsh 1 次）：全部同 id 重启无损续跑（resumed 精确衔接、零重复执行；dsh 第三次外杀后 executed=26/resumed=424，收口跑 executed=0/resumed=450）。
2. **main 并发事故**（09-13）：136 次重复执行（586 审计 − 450 留痕，全部在事故窗口前置跑），≈7.3M 计费 token 单列（§9），canonical 数据零污染。
3. **main 待机冻结**（09-14 00:13–08:05，Modern Standby 3 次）：keep-awake guard 根治。
4. **judge 格式 error**：main 7 / noise 17 / dsh 10 条（glm 偶发非法 JSON，格式错按设计不自动重试）——全部删留痕重跑恢复，三侧最终 0 error。
5. **max-tokens 截断 2 次**（dsh，VUL4J-1/C/rep-3、VUL4J-29/E/rep-1，占执行尝试 ≈0.4%）：瞬态——两单元重跑均成功，失败不留 record 不污染数据面（#37 附录登记为 DSH 内核 envelope 观察项）。
6. **noise 覆盖缺口**（规划疏漏，已拦截）：分片复刻漏 7 案 105 单元，收口前核对发现补齐，零数据损失。

## 9. 预算总账（全 Phase 2，T5）

| 侧 | 单元 | 计费口径 | 含缓存读口径 | judge 调用 | judge 信封上界 |
|---|---|---|---|---|---|
| main | 450 | 24.03M | 104.55M | 263 | ≤8.62M |
| noise | 450 | 24.25M | 101.39M | 252 | ≤8.26M |
| dsh | 450 | 24.18M | 110.54M | 291 | ≤9.54M |
| smoke | 5 | 180.4k | 469.7k | — | — |
| **三侧 EXEC 合计** | 1350 | **72.46M** | **316.48M** | | |

- **预估 vs 实测对照（#32 立项窗为矩阵级预估；noise/dsh 为同矩阵重跑，沿用同窗）**：计费 19–27M / 含缓存读 84–113M——main 24.03M / 104.55M **IN**、noise 24.25M / 101.39M **IN**、dsh 24.18M / 110.54M **IN**，**三侧双口径均落窗内**（无 >30% 偏差，无归因项）。judge 预估：main ≤9.6M（含 prompt 估算口径）< 12M 上限（#35 记录）**IN**；noise/dsh 无独立预估（矩阵重跑），实测信封 8.26M / 9.54M 与 main 同量级；三侧信封合计 ≤26.4M（可复算下界口径 8.62+8.26+9.54）。smoke 180.4k / 469.7k（#32 释能冒烟，无独立预估窗）。
- judge 信封口径说明（双口径并列，引用时注明）：本表为可复算下界 = judged 调用数 × 32768（#39 模型族感知容量）；#35 关票采用了更宽的含 prompt 估算（263 × ~3.6k + ≤32.8k ≈ ≤9.6M）；#37 附录含重试全口径为 302 次调用 ≤9.9M（291 一次判过 + 11 次失败重试）。判定协议：glm-5-3-260814，temperature 0.2 / top_p 0.95 锁定。
- **事故损耗单列（不在 canonical 预算内）**：main 并发事故 ≈7.3M（§8.2）；noise 外杀重跑 ≈0.16M（3 在飞单元）；dsh 事故 + judge 重试 ≈0.2M。合计 ≈7.7M。
- DSH 侧对照（#37 三侧门）：计费口径持平（+0.6%）、含缓存读 +5.7%（110.54M vs main 104.55M）——DSH 内核指标对齐、with-cache 口径更重；配对符号检验 totalTokens FAIL（p=0.0266），格面 20/20 IN。详见 `.cache/dsh-appendix-phase2.md` 与 DSH 指标对齐门报告。

## 10. 人工抽检（calibration）

**样本构成（T8，协议 docs/human-review-sampling-protocol.md v1）**：seed `poc1-human-review-2026`，rate 0.1，450 单元分层（disagreement/agreement/no-judge 各 ceil(n×0.1)，FNV-1a32 确定性）→ **46 表单 / 214 条目**（disagreement 层 18 / agreement 层 28 / no-judge 层 0；FINDING 66 + MISSED_TRUTH 148）。分层口径 = 协议 `stratumOf`（src/sampling/review-plan.ts）：单元完全无 judge 行才归 no-judge 层（本侧 0 份）；agreement 层 28 份 = 13 份 judged 一致单元 + 15 份 skipped-no-findings 单元（零分歧的 skipped 单元按协议归入 agreement 层，其表单仅含 MISSED_TRUTH 条目——零 finding 单元全量漏检的直接校准材料）。

**状态：裁定未回收——如实标注**。抽样与表单生成已完成（`runs/phase2-main/human-review/forms.json` 为协议产物，`.cache/human-review-sheet.md` 为可填写裁定表：每表单含 issue、真值位置、MR diff、rule/judge 双口径、逐条目裁定列）；**人工逐条裁定（214 条目，估计数小时量级）未在本票内执行**，judge vs 人工一致性量化随之为空。原因：本票为分析报告票，裁定依赖人工投入，未获执行窗口；不以自动化替代（协议第四级的存在意义即打破 judge 单点）。

**回收后量化路径（已备，零新代码）**：裁定誊入 `.cache/human-review-submissions.tsv`（unitKey/itemId/verdict/comment）后，一致性量化 = ① FINDING 条目：人工 TP ∩ judge TP 占比（judge 精度校准）；② MISSED_TRUTH 条目：人工 FN 确认率（链路漏检下界校准）；③ 分层对比（disagreement 层的 judge 翻案正确率 vs agreement 层的稳定性）。

## 11. 口径衔接说明（3-case → 30-case）

| 面 | POC1 / #29 / #30 口径（3–9 单元级） | 30 案主数据升级后 | 性质 |
|---|---|---|---|
| 工程结论（管线/判定链/协议设计） | POC1 实现报告 | 不变（复用同一管线） | 保持 |
| S/A/B 判定 | POC1 3 案（每配置 n=9 池化） | 三侧 450 单元逐字一致（§3.1） | 数字升级、结论稳定 |
| DSH 指标对齐门 | #29 45 单元：对称带 19 IN/1 INSUFFICIENT、配对 4 PASS | #37 450 单元：格面 20/20 IN、配对 totalTokens FAIL（p=0.0266） | **结论翻转（检验力升级）**：45 单元配对 23/22 p=0.5 零检验力 → 450 单元检出 with-cache +5.7% |
| 门带口径 | #29 单侧 ±1σ 带（2 OUT） | #30 修订对称 max σ 带 → #36 复算 20/20 IN 沿用 | 口径升级（#30 定稿） |
| #29 n=9 advisory（4 条） | 小样本警示 | 450 单元全消失 | 升级消解 |
| D 不稳定 | #30 9 单元 r2 塌缩（D recall 0.0），归因网关 × 自主拉取 | D=B 判定稳定但跨侧极差 0.1039 保留；**推广为 C/D 上下文重组族**（C 极差 0.1487 更大，§5.5） | 归因保持、现象推广 |
| 噪声底 | #30 冻结 harness 自身重跑（±1σ 门 OUT 1–3 格） | #36 全矩阵噪声对照 20/20 IN + σ 面 | 升级（30 案级噪声底） |
| 预算 | POC1 估算窗 19–27M / 84–113M | 三侧双口径均 IN（§9） | 预估兑现 |
| 人工抽检 | POC1 协议设计 + 表单生成 | 表单构成 T8 量化；裁定仍未回收（与 POC1 同状态） | 保持（未推进） |

## 12. ADR 按需评估

本票无新架构决策：复算脚本 `scripts/analyze-phase2.ts` 为一次性分析工具（不进 src/ 主链）；S/A/B 判定语义沿用 ADR-0004 未改；锚塌缩的呈现纪律（机械判定 + 全程注记）是 ADR-0004 协议内的呈现层约定，不构成判定语义变更，无需新 ADR。若后续论文阶段决定改锚（如以 A 为参照重定义判据），届时另立 ADR。

## 13. 来源与产物索引

| 类别 | 路径（本机留痕，不入仓） |
|---|---|
| 主数据 | `runs/phase2-main/`（450 record + 450 judge + report.json + dashboard.md + human-review/forms.json） |
| 噪声对照 | `runs/phase2-noise/`（同构 450；分片 `phase2-noise-s{1..8}`） |
| DSH 附录侧 | `runs/phase2-dsh/`（同构 450；分片 `phase2-dsh-t{1..5}`） |
| 预检 | `runs/phase2-smoke/`（5 单元） |
| gate 锚点 | `.cache/gate-phase2-selfconsistency.json`（#36，PASS 20/20）· `.cache/gate-phase2-dsh.json`（#37 三侧门）· `.cache/gate-v2-dsh.json`（#29 45 单元） |
| 误差棒 | `.cache/error-bars-phase2.md`（#36 σ 面） |
| DSH 附录 | `.cache/dsh-appendix-phase2.md`（#37） |
| 复算 | `pnpm analyze:phase2`（stdout；留痕 `.cache/analyze-phase2-out.md` 为重定向产物，本报告 T1–T8 与其逐项对应） |
| 抽检 | `.cache/human-review-sheet.md`（46 表单/214 条目可填写裁定表） |
| 协议/设计 | `docs/human-review-sampling-protocol.md` · `docs/adr/0004-s-grade-includes-precision-not-tool-calls.md`（S/A/B 判据）· `docs/design/VUL4J 评测方案与数据复制指南.md` |

（`scripts/analyze-phase2.ts` 与本报告入仓；`package.json` 增加 `analyze:phase2` 脚本入口。）

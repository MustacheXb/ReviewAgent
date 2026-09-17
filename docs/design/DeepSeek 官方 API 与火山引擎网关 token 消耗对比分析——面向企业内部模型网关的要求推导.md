# DeepSeek 官方 API 与火山引擎网关 token 消耗对比分析——面向企业内部模型网关的要求推导

> 研究日期：2026-09-17。数据全部来自仓库既有落盘运行与代码/文档（未发起新的 API 调用）。
> 视角：**DeepSeek 官方 API = 基准行为（理想直连）；火山引擎网关 = 一个真实网关实现样例**。两者间的一切差异（消耗数字、usage 字段口径、缓存计法、模型 id 语义）都从「网关层做了什么 / 没做什么 / 做错了什么」角度归因，最终推导**企业内部模型网关的要求与优化清单**（§6）。

---

## 1. 结论先行

1. **数据存在且可复算**：官方端点 45 单元（`runs/poc1-vul4j-smoke`，总账 **6,512,767 token**，45 份 audit 逐份求和复算一致）与火山网关 45 单元（`runs/poc1-vul4j-gateway`，报告口径 **11,287,939**；本机按「每单元最终 audit」复算 10,931,575，差异 3.2% 来自目录中 38/45 单元留有的中断重跑残留 audit，见 §3.3）构成同模型 id、同 3 case × A–E × 3 rep 的受控对照。**网关总量为官方 1.68~1.73 倍**，且方向因配置而异：单轮无工具配置更省（A/B 0.67~0.72×）、多轮工具配置更贵（D 2.72×）（`runs/poc1-vul4j-gateway/REPORT.md` §5.3）。
2. **差异主体不是计量口径，而是网关侧部署行为与缓存基础设施**：同名 `deepseek-v4-flash` 在网关上是另一部署版本（`deepseek-v4-flash-ga-260731`，REPORT §1），多轮工具配置下 rounds 拉满（D：官方 1 轮 vs 网关 4 轮）、输出膨胀（D CARC +122%）；缓存为异步预热（45~90s）+ 块对齐部分前缀，轻前缀快速循环配置 cacheHit 崩塌（A：官方 84.8% vs 网关 40.4%，−44pt）（REPORT §5.1/§5.2）。
3. **网关 usage 字段口径不同但已被客户端双读适配**：官方报 `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`；火山网关只报 OpenAI 形态 `prompt_tokens_details.cached_tokens`。不适配则 cacheHit 静默归零（REPORT §2 工程结论；适配提交 `27b9400`；双读链见 §3.2）。qwen3.8-flash 实测网关按 **1024-token 块对齐**上报命中（§4.4）。
4. **请求字节通道是干净的**：#45 双包 wire parity 测试钉死「同一逻辑请求 → 相同 JSON 字节」；volcano47-dsh 实测网关不改写请求体（`model` 原样透传、`stream:false`、画像字段按序序列化）。token 差异不能归因于请求被网关改写。
5. **缺口**：官方侧只有 3-case 小样本（45 单元），Phase 2 30-case 大规模数据只跑过网关；judge 链（glm-5.3）逐调用 usage 未落盘（只有信封上界）；响应侧原始 usage JSON 不落盘（通道归因靠回退链推断）；reasoning token 有 wire 字段定义但未进采集契约（§5）。

---

## 2. 两条通道是什么、怎么配置

### 2.1 配置面（代码事实）

| 维度 | DeepSeek 官方 API | 火山引擎网关 |
|---|---|---|
| 默认 base URL | `https://api.deepseek.com`（`packages/review-llm/src/deepseek.ts:6`） | 无默认，必经 env/参数注入；当前 `.env.local` 配 `https://st8tp3ajl0df3n8b8l8qu.apigateway-cn-beijing.volceapi.com/v1` |
| 解析优先级 | 显式参数 > `REVIEWER_URL` > `DEEPSEEK_URL` > 缺省（`packages/review-llm/src/resolver.ts:64-77`；`packages/review-dsh/src/llm/deepseek-adapter.ts:98-100`） | 同左（角色名优先，provider 旧名为兼容别名，ADR-0008） |
| URL 拼接 | base 去尾斜杠 + `/chat/completions`（`resolver.ts:50,79-85`） | 同左（base 配到 `/v1`，`packages/review-dsh/tests/cli/smoke.test.ts:111`） |
| 模型 id | `deepseek-v4-flash` 主力 / `deepseek-v4-pro`；`deepseek-chat`/`deepseek-reasoner` 已退役本地拒绝（`packages/review-llm/src/profile.ts:115`） | 同一 id 空间由 CLI `--model` 自由传入（#43/#45）；实测接受 `deepseek-v4-flash`（网关部署版本 ga-260731）、`qwen3.8-flash`、`minimax-m3`（#47） |
| usage 字段族 | `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`（`src/deepseek/wire-types.ts:82-89`） | `prompt_tokens_details.cached_tokens`（OpenAI 形态；REPORT §5.2；`.cache/glm-probe.json` 实证同族字段） |
| 协议 | OpenAI 兼容 chat/completions，**非流式** `stream:false`（`src/deepseek/wire-types.ts:48`；`packages/review-dsh/src/llm/deepseek-adapter.ts:5`） | 同左（volcano47-dsh audit wireBody 全部 `stream:false`） |

判断通道的唯一硬证据：`plan.json` 的 `reviewerBaseUrl` 字段（#43 起 manifest 记 model + baseUrl、绝不记 key——ADR-0008「配置面」）。历史运行里只有 `runs/volcano47-dsh/plan.json:24` 记了网关 URL；更早的运行靠目录名（`*-gateway*`）、报告自述（poc1-vul4j-smoke REPORT §6「官方 prompt_cache_miss_tokens 口径」+ 执行史 HTTP 402）与 issue 语境（#29「gateway 45 单元真实重跑」、#30「需网关预算」）归因——Phase 2 三侧（main/noise/dsh）reviewer 均为网关口径（`docs/report/Phase 2 主数据分析报告.md` §11「网关激进行为」定性、§9 预算总账）。

### 2.2 模型 id 语义与 JSON-RPC 下传（#45）

- **model 是实验数据**（走请求、进 audit），**key 是秘密**（走环境）（#45 票面；`packages/review-dsh/src/kernel-host/main.ts:16-19`）。
- DSH 内核通道：实验 CLI `--model` → JSON-RPC `review/run` 的 `params.model`（可选，缺省回落 `DEFAULT_MODEL`，空串 fail fast——`kernel-host/main.ts:48-49,75-77`）→ `realApiReviewPolicy(configId, model)` 推导 policy（`main.ts:105`）→ DSH agent → wire 请求体 `model` 首键。
- 双包 parity：`packages/review-dsh/tests/llm/wire-parity.test.ts` 钉死 POC1 request-mapper 与 DSH wire serializer 对同一逻辑请求产出**相同 JSON 字节**，7 用例覆盖 flash/pro/glm/my-gateway-model/qwen3.8-flash，冻结字段序 `model → messages → [thinking → reasoning_effort] → [max_tokens] → [tools → tool_choice] → stream`（该文件头注释与 CASES 表）。
- 画像表单源（`packages/review-llm/src/profile.ts`）：`deepseek-*` → thinking enabled + reasoning_effort high、不序列化 max_tokens、cacheMetering true；`glm-*` → 不发 thinking、32768 信封、cacheMetering true；未知模型 → 不发 thinking、8192 信封、cacheMetering false（Cache-Hit-Rate 记 N/A，`src/metrics/tokens.ts:17-21,34-36`）。

---

## 3. token 用量数据的落点与口径

### 3.1 采集链（代码事实）

```
API 响应 usage（wire 字段）
  → response-mapper 双读（POC1：src/deepseek/response-mapper.ts:80-109；DSH：packages/review-dsh/src/llm/response.ts:30-61）
      链 1：prompt_cache_miss_tokens / prompt_cache_hit_tokens（DeepSeek 官方）
      链 2：prompt_tokens_details.cached_tokens（OpenAI 兼容网关；miss = prompt_tokens − cached）
      链 3：两族全缺 → 全零（上游容忍，不臆造记账）
  → LlmUsage/TokenUsage：inputTokens（只计未命中）/ cacheReadTokens（命中）/ outputTokens（completion_tokens，含思考 token）
  → 聚合 addUsage（src/loop/usage.ts；失败尝试已消耗 usage 并账——insufficient_system_resource 重试场景，deepseek-adapter.ts:202-224）
  → 落盘：
      · 每单元 audit JSON 的 usage 字段（runs/<id>/audit/<source>/<case>/<cfg>/rep-N/…json；ReviewAudit 契约 packages/review-dsh/src/plugins/review-runtime.ts:98-99,367）
      · 每请求 wireBody 原文（可重放字节契约，review-runtime.ts:76-81）
      · DSH 侧另有 session.jsonl 的逐请求 usage chunk（runs/volcano47-dsh/…/session.jsonl）
      · report.json metrics.perConfig[].cold/hot（均值/方差）
      · judge record（runs/phase2-main/judge/…）：**只有 reviewer 侧 tokens 快照 + 判定，无 judge 自身 usage**
```

要点：`total_tokens`/`completion_tokens_details.reasoning_tokens` 在 wire 类型里有定义（`wire-types.ts:82-89`）但**不进采集契约**——DeepSeek 把思考计入 completion_tokens（`response-mapper.ts:11`），glm 网关的 `reasoning_tokens`（`.cache/glm-probe.json`：39/44）被丢弃。totalTokens 指标一律由 miss + hit + out 重构，不信任服务端 total（网关 402/400 拒绝发生在计费前，POC1 smoke REPORT §6）。

### 3.2 指标口径（provider 能力分口径，ADR-0008）

- cacheHitRate = cached / 总输入（分母 0 → null）；**画像声明无缓存计量 → 记 N/A**（未知 ≠ 0，`src/metrics/tokens.ts:15-21,34-36`）。
- CARC 恒可算：无计量时 cached 记 0 → 保守上界（`src/metrics/efficiency.ts:10`）。
- 计费口径（billed = miss + output）与含缓存读口径（+ cacheRead）双列（Phase 2 报告 §9）。

### 3.3 运行数据清单与复算验证

| 运行目录 | 通道 / 模型 | 规模 | 总 token（本机复算口径） | 复算说明 |
|---|---|---|---|---|
| `runs/poc1-vul4j-smoke` | **官方** / deepseek-v4-flash | 3 case × A–E × 3 rep = 45 | **6,512,767**（45 audit 全量和） | 与该目录 REPORT §6 逐 config 精确一致 |
| `runs/poc1-vul4j-gateway` | **网关** / deepseek-v4-flash（ga-260731） | 45 | 报告 11,287,939；latest-per-unit 复算 **10,931,575** | 目录含 83 份 audit：38/45 单元有中断重跑残留（两段执行，REPORT §2 事件 3）；A/B/E 三 config latest 复算与报告精确一致，C 差 0.9%、D 差 11.7%（残留并账口径差） |
| `runs/poc1-vul4j-gateway-r2` | 网关 / deepseek-v4-flash | 45 | **8,405,766**（45 audit，干净） | #29 指标对齐门的 POC1 侧重跑 |
| `runs/dsh-vul4j-gateway` | 网关（DSH 内核）/ deepseek-v4-flash | 45 | **8,749,984** | 同网关同矩阵的 DSH 内核侧；vs r2 总量 +4.1%、计费口径 +8.4%（E/D 配置 run-to-run 方差大） |
| `runs/phase2-main` / `-noise` / `-dsh` | 网关 / deepseek-v4-flash + glm-5.3 judge | 30 case × A–E × 3 rep × 3 侧 = 1350 | 计费 24.03M / 24.25M / 24.18M；含缓存读 104.55M / 101.39M / 110.54M | Phase 2 报告 §9（judged 调用另计信封上界 ≤8.62M/≤8.26M/≤9.54M） |
| `runs/volcano47-dsh` | 网关 / **qwen3.8-flash**（#47 验收） | 1 单元（A/rep1） | **20,634**（miss 5,127 / hit 5,120 / out 10,387） | 6 请求；与 issue #47 验收 comment 数字一致 |
| `runs/dsh-gateway-smoke*`（4 个） | 网关 / deepseek-v4-flash | 1 单元（D） | 首个 428,406（REPORT §2 事件 2） | 网关端到端 usage 读数冒烟 |

复算方法：对 `runs/<id>/audit/**` 下含 usage 的 JSON 逐份求和（`inputTokens` + `cacheReadTokens` + `outputTokens`）；多 audit 单元另按「文件名时间戳最新」取终态。

---

## 4. 对比数据（官方 vs 网关，同 45 单元矩阵）

### 4.1 总账（来源：两份 REPORT §6/§7；网关为报告口径）

| 配置 | 官方合计 | 网关合计 | 倍率 | 方向（REPORT §5.3 归因） |
|---|---|---|---|---|
| A（裸 diff 无工具） | 270,345 | 195,121 | 0.72× | 更省：单轮输出收敛 |
| B（prefetch 预取） | 579,813 | 386,035 | 0.67× | 更省：同上 |
| C（全量上下文+工具） | 3,307,877 | 5,500,500 | 1.66× | 更贵：多轮重复注入 |
| D（工具+stablePrefix） | 958,331 | 2,603,830 | **2.72×** | 更贵：工具循环激进化 |
| E（D+Ledger） | 1,396,401 | 2,602,453 | 1.86× | 更贵：同上（Ledger 止损） |
| **合计** | **6,512,767** | **11,287,939** | **1.73×**（latest 复算口径 1.68×） | — |

结构对照：官方 miss 392,634 / hit 4,650,880 / out 1,469,253（命中 71.4% / 输出 22.6% / 未命中 6.0%）；网关 miss 1,043,183 / hit 8,642,816 / out 1,601,940（命中 76.6% / 输出 14.2% / 未命中 9.2%）。

### 4.2 热口径（rep2+）单元均值与缓存（两份 REPORT §4）

| 指标 | A 官方→网关 | B 官方→网关 | C 官方→网关 | D 官方→网关 | E 官方→网关 |
|---|---|---|---|---|---|
| totalTokens | 29,279→19,698 | 66,104→43,458 | 391,700→424,005 | 116,840→**384,908** | 137,098→200,425 |
| cacheHitRate | 84.8%→**40.4%** | 93.5%→83.5% | 95.7%→94.0% | 84.1%→86.8% | 84.7%→84.4% |
| CARC（输出 token） | 19,956→15,346 | 35,235→16,920（−52%） | 47,231→71,280 | 45,630→**101,388**（+122%） | 48,735→62,270 |
| rounds | 1→1 | 1→1 | 2→2 | **1→4** | 2→3 |

### 4.3 大样本网关侧参照（Phase 2，30 case × 450 单元 × 3 侧，均为网关）

A 22.6k / B 49.9k / C 706.5k token 每单元（judge 口径，Phase 2 报告 §1）；三侧计费口径 24.03~24.25M 相互差 <1%，说明网关口径下大盘消耗可复现（§9）。**官方端点没有对应规模的对照数据**。

### 4.4 qwen3.8-flash 网关微观样本（volcano47-dsh，1 单元 6 请求）

逐请求 usage（`runs/volcano47-dsh/audit/…/session.jsonl`）：turn1 冷 miss 1,186 / out 1,140（无命中）；turn2~6 每次 cacheRead 恒 **1,024**（如 turn2 miss 367 / hit 1,024 / out 275），合计 hit 5,120 = 5×1,024。**网关按 1024-token 块对齐上报缓存命中**——config A 短前缀（system + diff + 阶段指令逐轮追加）下大量前缀字节落在未满块内不计命中，是该配置 cacheHit 偏低的微观机制（与 REPORT §5.2「块对齐部分前缀（实测 768/938）」同族现象，不同模型块粒度可能不同）。#47 冒烟探针另给出网关最小计费样本：qwen3.8-flash 补全 74/30、工具 357/60；minimax-m3 补全 34/28、工具 205/44（issue #47 验收 comment）。

---

## 5. 差异原因分析（网关层归因）

按影响量级排序：

1. **网关部署版本 ≠ 官方版本（行为差异，最大项）**：请求字节逐字节一致（§2.2 parity 钉死）而消耗差 3.3 倍（D 配置），只能是服务端行为不同——网关部署 `deepseek-v4-flash-ga-260731` 在多轮工具场景 rounds 拉满、单轮场景输出收敛（REPORT §5.1）。这是「同名 id 不同部署」的网关固有风险：**企业网关若聚合第三方模型，必须披露实际部署版本**，否则跨通道对比不可归因。
2. **缓存基础设施差异（第二项）**：官方即时建立、全前缀命中；网关异步预热 45~90s + 块对齐部分前缀。轻前缀快速循环配置（A：单轮秒级，rep 间隔小于预热窗）cacheHit 崩塌 44pt；长稳定前缀配置（C）不受影响（REPORT §5.2、§4.4 微观证据）。harness 层的 Zone A 稳定前缀纪律效果上限**由网关缓存实现封顶**。
3. **usage 字段族差异（已被客户端吸收，但对网关是硬要求）**：网关不报官方 `prompt_cache_hit/miss_tokens`，只报 `prompt_tokens_details.cached_tokens`；且 `cached_tokens: 0` 也显式回报（review-runtime.ts:366 注释：这是有信息量的记账）。双读适配是**客户端侧的补救**——若企业网关能直接透传 provider 原生字段族（或补齐 miss/hit 拆分），计量口径即可单源。
4. **计量噪声**：网关同内容请求 `prompt_tokens` 计数有 ±8% 抖动（官方稳定；REPORT §8）——网关侧 token 计数器实现（可能含路由/重试/内部截断）引入指标噪声。
5. **不是差异的项（排除）**：请求被网关改写（无证据且与 parity/audit wireBody 矛盾）；工具名 wire 适配（点号→下划线转换对官方与网关同样生效，`712d67f`，REPORT §2）；Cache Break（五配置 45 run 相邻请求前缀分歧两侧均为 0——字节稳定纪律与通道无关，两份 REPORT §7）。

---

## 6. 企业内部模型网关的要求 / 优化清单

> 依据：官方 API 基准行为 × 火山网关实测差异 × 本仓客户端契约。每条标注证据。清单分「必须做到」（不做则功能/计量受损）与「强烈建议」（影响指标质量与成本）。
> **本清单已整理为可对外转发的正式需求文档**：《ReviewAgent 企业内部模型网关接入需求规格》（同目录），含逐条验收标准与验收工具说明。

### 6.1 必须做到（功能性）

| # | 要求 | 证据来源 |
|---|---|---|
| M1 | **OpenAI 兼容 `/chat/completions` + Bearer 鉴权，非流式（`stream:false`）可用**——本系统全线非流式，请求字节可审计是立身之本 | ADR-0008「契约边界」；`src/deepseek/wire-types.ts:48`；smoke 诊断 `malformed-response`（`packages/review-dsh/src/cli/smoke.ts:123,151`） |
| M2 | **usage 字段完整上报**：`prompt_tokens`、`completion_tokens` 必报；缓存计量至少二选一字段族（官方 `prompt_cache_hit/miss_tokens` **或** `prompt_tokens_details.cached_tokens`）。缺缓存字段 → 客户端 cacheHit 静默归零/记 N/A，CARC 只剩保守上界 | `src/deepseek/response-mapper.ts:13-18` 回退链；REPORT §2「唯一必需的代码适配是 usage 字段族回退——不适配则 cacheHit 指标静默归零」；`src/metrics/tokens.ts:17-21` |
| M3 | **请求体原样透传，不改写字节**：`model` 首键原样到达后端；`thinking`/`reasoning_effort`/`max_tokens` 等画像字段不被剥离或重排。改写会破坏「可重放字节」契约与 golden bytes 硬门槛 | volcano47-dsh audit wireBody（model=qwen3.8-flash 原样）；ADR-0008「wire 序列化器留在各自包内 + parity 钉字节一致」；`tests/deepseek/golden-bytes.test.ts` |
| M4 | **function calling 完整 round-trip**：tools 数组 → 模型 tool_calls → 工具结果消息回传（`role:"tool"` + `tool_call_id`）；工具名校验规则需兼容（本系统 wire 侧已下划线化，服务端须接受 `^[a-zA-Z0-9_-]+$`） | POC1 官方侧 400 教训（`712d67f`，smoke REPORT §2 事件 2）；smoke 工具探针 + `function-calling-unsupported`/`no-tool-call` 诊断（smoke.ts:99-100,116-117） |
| M5 | **模型 id 清单明确、错误可诊断**：未知 id 回 404 或含 "model not found" 语义的 400；不静默路由到别的模型 | smoke `model-not-found` 文案族匹配（smoke.ts:136-137,157）；RETIRED 本地拒绝语义（profile.ts:115；`src/experiment/runner.ts:104`） |
| M6 | **错误语义稳定可分类**：402/429/5xx/超时/形状异常映射稳定 code；`insufficient_system_resource` 类软错误若发生，**已消耗的 usage 须随错误体回报**（客户端重试并账，否则重试成本不可见） | LlmFailure code 族（smoke.ts:140-155）；重试 usage 并账（`packages/review-dsh/src/llm/deepseek-adapter.ts:202-224`；`response.ts` addUsage extraUsage） |
| M7 | **凭据与计量分离**：客户端只从环境读 key、绝不落盘；网关侧提供调用级账单/usage 日志作为对账面（客户端只拿得到响应 usage；judge 链这类未逐调用落盘的消费者必须有网关侧账单兜底） | `.env.local` key 不入库纪律（.gitignore + #46 README 段）；judge record 无 usage 字段（`runs/phase2-main/judge/…` 实测）→ Phase 2 §9 只能信封上界估算 |

### 6.2 强烈建议（计量质量与成本）

| # | 要求 | 证据来源 |
|---|---|---|
| S1 | **缓存同步建立（或预热窗口可配置/可查询）**：异步预热 45~90s 使轻前缀快速循环配置 cacheHit 崩塌 44pt，直接改写 S/A/B 判定（B 差 1.5pt 落 A 级） | REPORT §5.2、§3；网关缓存行为探测（REPORT §2 事件 1） |
| S2 | **缓存命中粒度披露（块大小、对齐规则）**：1024 块对齐使短前缀场景近半输入不计命中；全前缀命中（官方行为）才能让 harness 的稳定前缀纪律全额兑现 | §4.4 微观证据；REPORT §5.2「块对齐部分前缀（768/938）」 |
| S3 | **token 计数确定性**：同内容请求 `prompt_tokens` 计数稳定（火山 ±8% 抖动直接进指标噪声） | REPORT §8「网关 usage 抖动」 |
| S4 | **reasoning token 单列计量**：`completion_tokens_details.reasoning_tokens` 透传（glm 网关已报、被客户端丢弃；DeepSeek 官方并入 completion_tokens）。单列后跨推理/非推理模型的输出成本才可解释（#39：glm reasoning 吃满 8192 信封截断的教训） | `src/deepseek/wire-types.ts:88`（有定义未消费）；`.cache/glm-probe.json`（39/44 被丢）；issue #39 |
| S5 | **部署版本披露 + 同 id 不换权重**：同名 `deepseek-v4-flash` 官方 vs ga-260731 消耗差 1.68~1.73×、行为方向不一致——企业网关必须把「id → 实际部署版本」作为可查询元数据，换版要有变更通告 | REPORT §5.1/§5.3；§5 归因第 1 条 |
| S6 | **usage 原文（原始 JSON）随调用可取**：客户端只落请求 wireBody 不落响应；若网关提供调用级响应留痕（或至少 usage 原文日志），通道归因（官方字段族 vs OpenAI 字段族）不再依赖客户端回退链推断 | audit 契约只有 wireBody（review-runtime.ts:76-81）；本报告 §3.1 |
| S7 | **一网关多模型族路由**（reviewer 与 judge 同网关不同模型；qwen/minimax/glm/deepseek 并存），模型间 usage 口径一致 | `.env.local`（DEEPSEEK_URL 与 OPENAI_URL 同网关）；#47 异构组合验收；#43 judgeHeterogeneityOf |

### 6.3 若未来启用流式（当前未用）

本系统全线非流式（M1）。若企业网关只提供流式接口，需补：SSE chunk 聚合 + usage chunk 语义（DSH 适配器协议已有 `{type:"usage", usage}` 块位，`packages/review-dsh/src/llm/response.ts:231-234`）+ 流式下 usage 只在末 chunk 出现的容错。此为**未验证能力**，列为实验项而非要求。

---

## 7. 缺口与后续动作

数据缺口（如实）与「要验证它，企业网关/实验需要什么」：

1. **官方 vs 网关的大样本对照缺失**：官方侧只有 3-case 45 单元（POC1 期）；Phase 2 30-case 只跑过网关。→ 官方侧补一轮同矩阵运行即可闭合（REPORT §9 建议 2 亦提「网关与官方各跑一轮以固化 provider 对照」）；若官方端点不适用（如企业只走内网），该对照转为**企业网关 vs 其上游 provider 原生 API** 的同型实验。
2. **judge 链 token 无精确计量**：Phase 2 judge 只信封上界（≤8.62M 等）。→ 客户端侧把 judge usage 逐调用落盘（`src/judge/` 链改造），或依赖网关侧账单（M7）。
3. **响应侧原始 usage 不落盘**：通道字段族归因靠双读回退链推断。→ audit 增加响应 usage 原文快照（小改动），或网关提供 S6。
4. **reasoning token 未进采集契约**：S4。→ 采集契约加 `reasoningTokens` 可选字段 + 指标层分口径（同 ADR-0008 的 cacheMetering 先例）。
5. **网关缓存粒度/预热窗口只有间接测量**：§4.4 的 1024 块对齐来自 1 单元 6 请求微观样本 + REPORT 的探测描述。→ 用 `pnpm --filter review-dsh cli smoke` 式最小探针（或专门 cache probe）对目标网关做块大小/预热窗测定，作为企业网关接入验收的一部分。

---

## 附：本报告的复算路径

- 全部总量数字可由 `runs/<id>/audit/**` 下 JSON 的 `usage` 字段（`inputTokens` + `cacheReadTokens` + `outputTokens`）逐份求和复算；两份 POC1 REPORT 的官方侧总账与复算精确一致，网关侧报告口径与 latest-per-unit 复算差 3.2%（残留 audit 口径，§3.3）。
- 热口径均值/cacheHit/CARC 引自两份 REPORT §4（其底层为 `report.json` 的 `metrics.perConfig[].cold/hot`）。
- Phase 2 数字引自 `docs/report/Phase 2 主数据分析报告.md` §1/§9（其复算脚本 `pnpm analyze:phase2`）。
- 相关 issue：#43（reviewer 自由 id + 指标分口径）、#45（JSON-RPC model 下传 + 双包 parity）、#46（.env.local + 网关冒烟命令）、#47（火山网关 Qwen/MiniMax 验收）；相关 ADR：0002（DeepSeek 基线与缓存计量理由）、0008（被测模型可换 + 指标分口径）。

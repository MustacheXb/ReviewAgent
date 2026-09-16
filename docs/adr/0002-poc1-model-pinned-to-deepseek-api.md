# POC1 模型调用锁定 DeepSeek 官方 API，主力 deepseek-v4-flash

核心指标 Cache Hit Rate 需要 per-request 的 cached/uncached 计量，DeepSeek 官方 API 原生在 usage 报告 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；且缓存命中价格约为未命中的 1/30，缓存优先命题的收益极大。`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役，主力锁定 `deepseek-v4-flash`，`deepseek-v4-pro` 作为高险升级与消融项。企业落地的 provider 差异由 OpenAI 兼容 adapter 层吸收，不反向影响本决策。

## Consequences

- 实验内对比（A–E、baseline LLM）全部锁定同一模型，保证可比性；Claude Code 作为跨模型外部参照单独一列，不进主判定（主锚为配置 C，见 benchmark 判定协议）。
- DeepSeek 缓存为账号级共享、best-effort、闲置数小时至数天清除；跨会话前缀复用需 ≥2 次共享请求才持久化公共前缀——benchmark 必须定义预热与冷/热报告协议。

### 实现注记（#43 reviewer 自定义模型落地后补记，2026-09-16）

- **模型白名单 → 自由 id + provider 画像表**：`--model` 不再是代码层准入白名单——任意模型 id 直传（`flash` / `pro` 别名保留），wire 序列化（thinking 字段 / max_tokens 信封）与指标口径（usage 缓存计量能力声明）按 review-llm 画像表分派（`deepseek-*` / `glm-*` 内建前缀；未知模型回落保守默认档：不发 thinking 字段、8192 信封、不假设缓存计量——Cache-Hit-Rate 记 N/A）。本 ADR 的「主力锁定 deepseek-v4-flash」语义收窄为：实验对比的缺省主力与别名锚，准入由画像表的保守回落兜底。
- **DeepSeek 默认路径字节逐字节不变（#43 发布硬门槛）**：golden bytes 回归测试（`tests/deepseek/golden-bytes.test.ts`）锁定缺省模型的请求字节；画像表只对已知非 DeepSeek 场景分派，缺省路径序列化与白名单时代完全一致。
- **judge 侧异构约束不受影响**：judge 链同源判定改为以被测模型为对照系（精确同 id 或同已知 provider 家族，`src/judge/gpt-request-mapper.ts`）；被测为 DeepSeek 系时的既有拒绝行为原样保留，自定义接入点部署降级为 warning。

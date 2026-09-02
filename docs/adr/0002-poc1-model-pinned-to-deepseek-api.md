# POC1 模型调用锁定 DeepSeek 官方 API，主力 deepseek-v4-flash

核心指标 Cache Hit Rate 需要 per-request 的 cached/uncached 计量，DeepSeek 官方 API 原生在 usage 报告 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；且缓存命中价格约为未命中的 1/30，缓存优先命题的收益极大。`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役，主力锁定 `deepseek-v4-flash`，`deepseek-v4-pro` 作为高险升级与消融项。企业落地的 provider 差异由 OpenAI 兼容 adapter 层吸收，不反向影响本决策。

## Consequences

- 实验内对比（A–E、baseline LLM）全部锁定同一模型，保证可比性；Claude Code 作为跨模型外部参照单独一列，不进主判定（主锚为配置 C，见 benchmark 判定协议）。
- DeepSeek 缓存为账号级共享、best-effort、闲置数小时至数天清除；跨会话前缀复用需 ≥2 次共享请求才持久化公共前缀——benchmark 必须定义预热与冷/热报告协议。

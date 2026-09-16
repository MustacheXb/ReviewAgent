/**
 * provider 参数画像表（#42 落地）：模型 id pattern → 画像。
 *
 * 已知 provider 的 wire 差异单源集中于此——thinking 字段序列化策略、
 * completion 信封、usage 字段能力；未知模型回落保守默认画像
 * （不发 thinking 字段、8192 标准信封），新模型至少不 400、不静默截断。
 *
 * 消费者：judge 链 completion 信封（gpt-request-mapper，#42 首个消费者）；
 * #43 的 reviewer wire 序列化器（thinking 策略 + 信封）与指标分口径
 * （usage 能力声明——无缓存计量字段时 Cache-Hit-Rate 记 N/A）。
 *
 * 画像只描述「怎么和这个 provider 说话」，不含任何 endpoint/key——
 * 那些经 resolver（#41）与角色环境变量解析，两轴正交。
 */

/** thinking 字段序列化策略 */
export type ThinkingSerialization =
  /** 不发 thinking 字段（保守默认；glm 等推理默认开的模型亦无需显式开启） */
  | { readonly kind: "omit" }
  /** 发 thinking {type:"enabled"} + reasoning_effort（DeepSeek 锁定档，ADR-0002） */
  | { readonly kind: "enabled"; readonly reasoningEffort: "high" };

/** usage 字段能力声明（指标层分口径查询面：无缓存计量 → Cache-Hit-Rate 记 N/A） */
export interface UsageCapabilities {
  /**
   * provider 是否在 usage 中报告缓存计量字段。
   * true 的实测依据：DeepSeek 官方 prompt_cache_hit/miss_tokens；
   * glm 网关 prompt_tokens_details.cached_tokens（.cache/glm-probe.json）。
   */
  readonly cacheMetering: boolean;
}

/** provider 参数画像（纯数据，无 endpoint/key） */
export interface ProviderProfile {
  readonly thinking: ThinkingSerialization;
  /**
   * completion 信封（max_tokens 容量上界）。
   * undefined = 该模型族 wire 不序列化 max_tokens（DeepSeek thinking 模式现状，
   * #43 序列化器消费；judge wire 恒发 max_tokens，故信封缺失对 judge 是 fail fast）。
   */
  readonly completionMaxTokens: number | undefined;
  readonly usage: UsageCapabilities;
}

/**
 * 保守默认 completion 信封：未知模型的标准容量上界，也是 #43 异构降级下
 * 无信封家族（DeepSeek thinking wire）judge 侧的回落值（单源常量）。
 */
export const DEFAULT_COMPLETION_MAX_TOKENS = 8_192;

/** 已知 provider 家族规范名（画像表 pattern 的公共判定面，#43 异构校验消费） */
export type ProviderFamily = "deepseek" | "glm";

/** 保守默认画像：未知模型——不发 thinking 字段、8192 标准信封、不假设缓存计量 */
const DEFAULT_PROFILE: ProviderProfile = {
  thinking: { kind: "omit" },
  completionMaxTokens: DEFAULT_COMPLETION_MAX_TOKENS,
  usage: { cacheMetering: false },
};

/** DeepSeek 画像：ADR-0002 锁定档（thinking enabled + reasoning_effort high），不传 max_tokens */
const DEEPSEEK_PROFILE: ProviderProfile = {
  thinking: { kind: "enabled", reasoningEffort: "high" },
  completionMaxTokens: undefined,
  usage: { cacheMetering: true },
};

/** glm 画像：推理模型（reasoning 计入 completion 预算，#39 实测），32768 信封 */
const GLM_PROFILE: ProviderProfile = {
  thinking: { kind: "omit" },
  completionMaxTokens: 32_768,
  usage: { cacheMetering: true },
};

/** 查表条目（按序首匹；pattern 为模型家族 id 前缀，大小写不敏感） */
const PROFILE_TABLE: readonly {
  readonly family: ProviderFamily;
  readonly pattern: RegExp;
  readonly profile: ProviderProfile;
}[] = [
  { family: "deepseek", pattern: /^deepseek-/i, profile: DEEPSEEK_PROFILE },
  { family: "glm", pattern: /^glm-/i, profile: GLM_PROFILE },
];

/** 画像查表（纯函数）：已知家族前缀命中，未知模型回落保守默认画像 */
export function profileOf(model: string): ProviderProfile {
  for (const entry of PROFILE_TABLE) {
    if (entry.pattern.test(model)) {
      return entry.profile;
    }
  }
  return DEFAULT_PROFILE;
}

/**
 * 家族判定（纯函数，与画像查表同 pattern 单源）：已知家族返回规范名，
 * 未知返回 null。消费者是 judge 链异构校验（#43）——同已知家族即视为
 * 可能同源；未知 id 不做家族联想，同源归属由实验者自证。
 */
export function providerFamilyOf(model: string): ProviderFamily | null {
  for (const entry of PROFILE_TABLE) {
    if (entry.pattern.test(model)) {
      return entry.family;
    }
  }
  return null;
}

/**
 * 已退役模型 id（2026-07-24 下线，ADR-0002）：自由 id 接受之下仍直接拒绝
 * ——静默放行只会换来模糊的线上 400，不如本地报错说清楚。单源清单
 * （#45 起 root request-mapper、DSH 适配器与实验 runner 门共用），
 * 恰好命中 deepseek 画像前缀——拒绝是本清单的显式行为，不是 pattern 副作用。
 */
export const RETIRED_MODEL_IDS: readonly string[] = ["deepseek-chat", "deepseek-reasoner"];

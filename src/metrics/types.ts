import type { MetricsConfigId } from "../contracts/config.js";
import type { MRCase } from "../contracts/mr-case.js";
import type { RunResult } from "../contracts/run.js";

/**
 * 指标计算 + 规则粗筛 + S/A/B 判定的类型契约（Ticket 10 / issue #11）。
 * 本模块全部为纯函数：无网络、无 LLM、无文件系统副作用，输入输出全显式。
 *
 * 判定链位置：原生真值 → 【本模块：规则粗筛】→ GPT 系 LLM-as-judge（Ticket 11）→ 人工抽检。
 * 本模块是判定链第一级，其输出（FindingVerdict / TruthMiss）供 judge 校准复用。
 *
 * 配置键口径（T13 起）：分组键为 MetricsConfigId（A–E 主矩阵 + "claude-code"
 * 外部参照单列）。S/A/B 判定（verdict.ts）与 judge 链仍只消费 A–E；
 * 参照列仅经 evaluateRun / buildMetricsReport 进入同一指标计算路径。
 */

// ===== 规则粗筛（判定链第一级） =====

/** 规则粗筛匹配口径（默认值显式、被测试锁定） */
export interface ScreeningOptions {
  /**
   * 行位容差（行数）：finding.line 允许落在 [lineStart - tol, lineEnd + tol]。
   * 0 = 必须落在真值区间 [lineStart, lineEnd] 内（默认）。
   */
  readonly lineTolerance: number;
  /**
   * 性质等价词表：把 defectNature / category 归一到规范名后再比较。
   * 键与值均按 trim + 大写归一后查表（未命中恒等）；缺省 {} = 恒等映射。
   * 基准词表为 DEFECT_NATURES（src/dataset/defect-nature.ts，T02 权威定义），
   * 真值侧必须落在该词表内；本表用于把 Finding.category 的词表外写法
   * （如 LLM 自发的 "NULL_POINTER"）映射到词表成员（如 "NULL_SAFETY"）。
   */
  readonly natureAliases: Readonly<Record<string, string>>;
}

/** 规则粗筛默认口径：行位零容差、性质恒等（大小写与首尾空白不敏感） */
export const DEFAULT_SCREENING_OPTIONS: ScreeningOptions = {
  lineTolerance: 0,
  natureAliases: {},
};

/** 单条 Finding 的 FP 归因 */
export type FpReason =
  /** 文件不匹配：无任何真值位置与 finding.file 归一后同文件 */
  | "NO_FILE_MATCH"
  /** 文件匹配但行位超出容差 */
  | "NO_LINE_MATCH"
  /** 文件匹配、但无同文件真值位置与其性质等价 */
  | "NO_NATURE_MATCH"
  /** 命中点已被更早的 Finding 占用（冗余检出） */
  | "DUPLICATE"
  /** clean MR（truth = null）阴性对照口径：每个 Finding 记为 FP */
  | "CLEAN_MR";

/** 规则粗筛对单条 Finding 的判定 */
export interface FindingVerdict {
  readonly findingId: string;
  readonly outcome: "TP" | "FP";
  /** TP：占用的真值位置下标（truth.locations 中的索引）；FP 为 null */
  readonly matchedTruthIndex: number | null;
  /**
   * TP：行位偏差（0 = 落在真值区间内；n > 0 = 靠容差带命中，偏移 n 行）。
   * FP 为 null。位置偏差标记：> 0 说明检出了问题但定位有偏移。
   */
  readonly lineOffset: number | null;
  /** FP 归因；TP 为 null */
  readonly fpReason: FpReason | null;
  /** 是否靠容差带命中（lineOffset > 0） */
  readonly withinTolerance: boolean;
}

/** 漏检（FN）：未被任何 Finding 命中的真值位置 */
export interface TruthMiss {
  readonly truthIndex: number;
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly defectNature: string;
}

/** 一个匹配级别的 TP / FP / FN 计数 */
export interface ScreeningCounts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
}

/**
 * 规则粗筛结果。
 * line-level：文件 ∧ 行区间（含容差）∧ 性质等价；
 * file-level：文件 ∧ 性质等价（仅去掉行位约束，其余口径与 line-level 一致）。
 */
export interface ScreeningResult {
  /** 是否 clean MR（truth = null，阴性对照） */
  readonly cleanMr: boolean;
  /** 每个 Finding 的 line-level 判定（顺序与输入 findings 一致） */
  readonly verdicts: readonly FindingVerdict[];
  /** line-level 漏检清单（FN） */
  readonly misses: readonly TruthMiss[];
  readonly lineLevel: ScreeningCounts;
  readonly fileLevel: ScreeningCounts;
}

// ===== Token 记账与工具成本 =====

/** 工具成本计价（CARC 的工具成本口径，全部可配置；默认 0 = 不计价） */
export interface ToolCostPricing {
  /** 每次工具调用固定计价（token 数）；按 audit.toolCallLog 的条目数计 */
  readonly fixedCostPerCall: number;
  /** 工具结果每字符计价（token 数）；结果长度按 resultSummary 字符数计 */
  readonly costPerResultChar: number;
}

export const DEFAULT_TOOL_COST_PRICING: ToolCostPricing = {
  fixedCostPerCall: 0,
  costPerResultChar: 0,
};

/** 一次 Run 的 token 记账（口径全显式） */
export interface TokenMetrics {
  /** 未命中缓存的输入 token（usage.inputTokens = prompt_cache_miss_tokens） */
  readonly uncachedInputTokens: number;
  /** 命中缓存的输入 token（usage.cacheReadTokens = prompt_cache_hit_tokens，缺省 0） */
  readonly cachedInputTokens: number;
  /** 缓存写入 token（usage.cacheWriteTokens，DeepSeek 不上报、通常 0；计入总输入） */
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** 总输入 = 未命中 + 命中 + 缓存写入 */
  readonly totalInputTokens: number;
  /** 总 token = 总输入 + 输出（RIE 分母与 S/A/B 的 Token 判据均用此口径） */
  readonly totalTokens: number;
  /** 缓存命中率 = cachedInputTokens / totalInputTokens；totalInputTokens = 0 时为 null（未定义） */
  readonly cacheHitRate: number | null;
}

// ===== 质量（Recall / Precision / F1） =====

/**
 * 一组 Recall / Precision / F1。null = 未定义（分母为零）：
 * recall：tp + fn = 0（无真值位置，clean MR）；precision：tp + fp = 0（零 finding）。
 * f1：任一成分 null 则 null；两者均为 0 时按 ML 惯例取 0（tp = 0）。
 */
export interface PRFMetrics {
  readonly recall: number | null;
  readonly precision: number | null;
  readonly f1: number | null;
}

// ===== 派生效率指标（RIE / CARC） =====

export interface EfficiencyMetrics {
  /**
   * RIE = Recall × Precision / (Total Tokens / 1K)，line-level 口径。
   * 任一成分 null 或 totalTokens = 0（除零）时为 null。
   */
  readonly rie: number | null;
  /**
   * CARC = 非缓存输入 + 输出 + 工具成本（token 口径）：
   * uncachedInputTokens + cacheWriteTokens + outputTokens + toolCostTokens。
   * 缓存命中（cachedInputTokens）不计入。
   */
  readonly carc: number;
}

// ===== 单次 Run 的完整指标 =====

/** 单次 Run（一个 config 的一次重复运行）的全部指标 */
export interface RunMetrics {
  readonly caseId: string;
  readonly configId: MetricsConfigId;
  /** 规则粗筛明细（供 Ticket 11 judge 校准与人工抽检复用） */
  readonly screening: ScreeningResult;
  readonly lineCounts: ScreeningCounts;
  readonly fileCounts: ScreeningCounts;
  readonly lineLevel: PRFMetrics;
  readonly fileLevel: PRFMetrics;
  readonly tokens: TokenMetrics;
  readonly efficiency: EfficiencyMetrics;
  /** 工具成本（token 数，按 ToolCostPricing 计价） */
  readonly toolCostTokens: number;
  readonly toolCalls: number;
  readonly rounds: number;
}

/** 指标字段全集（统计聚合的可枚举词表） */
export const METRICS_FIELDS = [
  "lineTp",
  "lineFp",
  "lineFn",
  "lineRecall",
  "linePrecision",
  "lineF1",
  "fileTp",
  "fileFp",
  "fileFn",
  "fileRecall",
  "filePrecision",
  "fileF1",
  "uncachedInputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
  "totalInputTokens",
  "totalTokens",
  "cacheHitRate",
  "rie",
  "carc",
  "toolCostTokens",
  "toolCalls",
  "rounds",
] as const;

export type MetricsField = (typeof METRICS_FIELDS)[number];

/** 单次 Run 指标的扁平投影（统计聚合的输入形状）；token/计数恒非 null */
export type FlatMetrics = Readonly<Record<MetricsField, number | null>>;

// ===== 统计聚合 =====

/** 均值 ± 样本标准差（n-1；count ≤ 1 时 std = 0） */
export interface Stat {
  readonly count: number;
  readonly mean: number;
  readonly std: number;
}

/** 一组 RunMetrics 样本的统计汇总；values 按字段逐个给出 Stat（null = 无有效样本） */
export interface MetricsStats {
  /** 参与聚合的样本数（部分字段可能因 null 值少于该数） */
  readonly sampleCount: number;
  readonly values: Readonly<Record<MetricsField, Stat | null>>;
}

// ===== 评估输入 =====

/**
 * 单个 MR 的评估输入：MRCase + 各 config 的重复运行（Ticket 10 复用接口）。
 * 每个 config 的数组顺序 = 重复运行顺序：首元素为 rep1（冷启动），其余为 rep2+（热稳定）。
 */
export interface EvaluationInput {
  readonly mrCase: MRCase;
  /** 仅列出实际运行过的 config；每个数组非空 */
  readonly runsByConfig: Readonly<Partial<Record<MetricsConfigId, readonly RunResult[]>>>;
}

// ===== 分层缓存报告 =====

/** 一个 MR × 一个 config 的分层缓存报告（rep1 冷单列、rep2+ 热主口径） */
export interface ConfigCaseReport {
  readonly configId: MetricsConfigId;
  /** 重复运行次数（rep1 在内） */
  readonly repCount: number;
  /** rep1（冷启动）单列：单次运行指标，不做统计 */
  readonly cold: RunMetrics | null;
  /** rep2+（热稳定）主口径统计；rep 数 < 2 时为 null */
  readonly hot: MetricsStats | null;
  /** 每个 rep 的完整指标明细（rep1 在前），供 judge 校准与人工抽检复用 */
  readonly reps: readonly RunMetrics[];
}

/** 一个 MR 的评估报告（覆盖所有实际运行过的 config） */
export interface CaseMetricsReport {
  readonly caseId: string;
  readonly perConfig: Readonly<Partial<Record<MetricsConfigId, ConfigCaseReport>>>;
}

/** MetricsReport 中每 case 的摘要条目 */
export interface CaseSummaryEntry {
  readonly caseId: string;
  readonly repCount: number;
  /** rep1（冷）单值 */
  readonly cold: FlatMetrics | null;
  /** rep2+（热）均值 */
  readonly hot: FlatMetrics | null;
}

/** 跨 case 的 config 级汇总（每 case 等权） */
export interface ConfigSummary {
  readonly configId: MetricsConfigId;
  /** 有 ≥ 1 次运行的 case 数 */
  readonly caseCount: number;
  /** 有 rep2+ 热口径的 case 数 */
  readonly hotCaseCount: number;
  /** rep1（冷）跨 case：每指标均值 ± 标准差 */
  readonly cold: MetricsStats | null;
  /** rep2+（热）主口径：先 case 内热均值、再跨 case 均值 ± 标准差（每 case 等权） */
  readonly hot: MetricsStats | null;
  readonly perCase: readonly CaseSummaryEntry[];
}

/** Benchmark 级指标报告（Ticket 12 运行器与 Dashboard 的复用接口） */
export interface MetricsReport {
  /** 参与 case 数 */
  readonly caseCount: number;
  /** 各 config 汇总（仅含实际运行过的 config） */
  readonly perConfig: Readonly<Partial<Record<MetricsConfigId, ConfigSummary>>>;
}

// ===== S/A/B 判定（质量主锚 = 配置 C，spec #1 user story 29） =====

export type VerdictGrade = "S" | "A" | "B";
export type VerdictOutcome = VerdictGrade | "BELOW_B" | "NOT_EVALUABLE";

/** 一个档位的判定阈值（Recall/Token 相对锚 C 倍乘，Cache Hit 为绝对阈值） */
export interface VerdictThresholds {
  /** Recall ≥ C.lineRecall × recallRatio */
  readonly recallRatio: number;
  /** Total Tokens ≤ C.totalTokens × tokenRatio */
  readonly tokenRatio: number;
  /** Cache Hit Rate ≥ 该绝对值；null = 该档无缓存判据（B 级默认无） */
  readonly cacheHitRate: number | null;
}

/**
 * S/A/B 默认阈值（与 spec #1 user story 29 一字不差）：
 * S：Recall ≥ C×90% ∧ Token ≤ C×30% ∧ Cache Hit ≥ 85%（rep2+ 热口径）
 * A：Recall ≥ C×80% ∧ Token ≤ C×30% ∧ Cache Hit ≥ 80%
 * B：Recall ≥ C×70% ∧ Token ≤ C×50%（无缓存判据）
 * 注：设计文档 v2.0 第 7 章的 S 级另含 Precision ≥ C 与 Tool Calls ≤ C×30%，
 * spec 判定公式未纳入，此处按 spec 实现（阈值可经 options 覆盖）。
 */
export const DEFAULT_VERDICT_THRESHOLDS: Readonly<Record<VerdictGrade, VerdictThresholds>> = {
  S: { recallRatio: 0.9, tokenRatio: 0.3, cacheHitRate: 0.85 },
  A: { recallRatio: 0.8, tokenRatio: 0.3, cacheHitRate: 0.8 },
  B: { recallRatio: 0.7, tokenRatio: 0.5, cacheHitRate: null },
};

/** 判定输入：一个 config 的三个判据指标（取 rep2+ 热口径均值） */
export interface VerdictMetrics {
  /** line-level Recall（热口径均值）；null = 无有效样本 */
  readonly recall: number | null;
  /** Total Tokens（热口径均值） */
  readonly totalTokens: number | null;
  /** Cache Hit Rate（热口径均值） */
  readonly cacheHitRate: number | null;
}

/** 单条判据的判定明细 */
export interface CriterionResult {
  readonly grade: VerdictGrade;
  readonly metric: "RECALL" | "TOTAL_TOKENS" | "CACHE_HIT_RATE";
  /** AT_LEAST：相对锚倍乘下限；AT_MOST：相对锚倍乘上限；AT_LEAST_ABSOLUTE：绝对下限 */
  readonly comparison: "AT_LEAST" | "AT_MOST" | "AT_LEAST_ABSOLUTE";
  readonly pass: boolean;
  readonly value: number | null;
  /** 锚乘后的实际阈值（绝对判据为绝对值；未参与判定为 null） */
  readonly threshold: number | null;
  /** 判据说明（未参与判定 / 指标缺失等） */
  readonly note: string | null;
}

/** 单个 config 的 S/A/B 判定报告 */
export interface VerdictReport {
  readonly configId: MetricsConfigId;
  readonly outcome: VerdictOutcome;
  /** outcome ∈ {S, A, B} 时为档位，否则 null */
  readonly grade: VerdictGrade | null;
  readonly target: VerdictMetrics;
  /** 判定锚（恒为配置 C） */
  readonly anchor: Readonly<{ readonly configId: "C" } & VerdictMetrics>;
  /** S/A/B 每档每判据的明细（含未通过档位） */
  readonly criteria: readonly CriterionResult[];
  /** 英文判定依据（机读 outcome + 人读摘要） */
  readonly basis: string;
}

/** 多配置判定汇总（judgeAllVerdicts 输出） */
export interface VerdictReports {
  readonly anchorConfigId: "C";
  /** 锚 config C 是否有可用的热口径指标 */
  readonly anchorAvailable: boolean;
  readonly verdicts: readonly VerdictReport[];
}

export interface VerdictOptions {
  /** 阈值覆盖（缺省 DEFAULT_VERDICT_THRESHOLDS） */
  readonly thresholds?: Readonly<Record<VerdictGrade, VerdictThresholds>>;
}

// ===== 顶层选项 =====

/** 指标模块顶层选项 */
export interface MetricsOptions {
  readonly screening: ScreeningOptions;
  readonly toolCost: ToolCostPricing;
}

export const DEFAULT_METRICS_OPTIONS: MetricsOptions = {
  screening: DEFAULT_SCREENING_OPTIONS,
  toolCost: DEFAULT_TOOL_COST_PRICING,
};

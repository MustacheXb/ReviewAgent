/**
 * 确定性种子抽样器（Ticket 11：10% 人工抽检队列的底座）。
 *
 * 协议（确定性可复现的三个保证）：
 * 1. 排序键 = FNV-1a(seed + "\\u0000" + unit.key)（32 位定长整数哈希，无浮点参与排序，
 *    跨进程 / 跨运行稳定）+ key 字典序破并列；
 * 2. 分层（stratum）各自独立抽取 ceil(n_stratum × rate) 个单元——每层保证 ≥ 1 个
 *    （层非空且 rate > 0 时），避免稀有层（如 judge-规则分歧层）被均匀抽样稀释；
 * 3. 抽取结果按输入顺序返回（展示稳定），但选择本身与输入顺序无关
 *    （打乱输入顺序 → 同一 seed 抽出同一集合）。
 *
 * 样本量 = ceil(n × rate)（向上取整：小种群保底覆盖；分层下各层之和可能超过
 * ceil(N × rate)，属协议预期）。
 */

export interface SamplingUnit {
  /** 稳定唯一键（重复即 fail fast——抽样单元必须可无歧义标识） */
  readonly key: string;
  /** 分层标签；null / undefined = 无分层（全部落 "default" 层） */
  readonly stratum?: string | null;
}

export interface SamplingOptions {
  /** 抽样比例（(0, 1]；0.1 = 10% 人工抽检） */
  readonly rate: number;
  /** 种子（任意非空字符串；同种子 → 同样本） */
  readonly seed: string;
}

export interface SamplingPlan<T extends SamplingUnit> {
  readonly seed: string;
  readonly rate: number;
  readonly populationSize: number;
  readonly sampleSize: number;
  /** 入选单元（按输入顺序） */
  readonly selected: readonly T[];
  /** 未入选单元（按输入顺序） */
  readonly remaining: readonly T[];
  /** 各层抽样明细 */
  readonly strata: readonly StratumSelection[];
}

export interface StratumSelection {
  readonly stratum: string;
  readonly populationSize: number;
  readonly sampleSize: number;
  readonly selectedKeys: readonly string[];
}

/** 主入口：确定性种子抽样（纯函数） */
export function sampleUnits<T extends SamplingUnit>(
  units: readonly T[],
  options: SamplingOptions,
): SamplingPlan<T> {
  validateOptions(options);
  const validated = validateUnits(units);
  const keyed = validated.map((entry) => ({ ...entry, hash: fnv1a32(entry.key, options.seed) }));
  const strata = groupByStratum(keyed);
  const selectedKeys = new Set<string>();
  const strataSelections: StratumSelection[] = [];
  for (const [stratum, stratumUnits] of strata) {
    const selection = selectFromStratum(stratumUnits, options);
    strataSelections.push({
      stratum,
      populationSize: stratumUnits.length,
      sampleSize: selection.length,
      selectedKeys: selection.map((unit) => unit.key),
    });
    for (const unit of selection) {
      selectedKeys.add(unit.key);
    }
  }
  return {
    seed: options.seed,
    rate: options.rate,
    populationSize: keyed.length,
    sampleSize: selectedKeys.size,
    selected: keyed.filter((entry) => selectedKeys.has(entry.key)).map((entry) => entry.unit),
    remaining: keyed.filter((entry) => !selectedKeys.has(entry.key)).map((entry) => entry.unit),
    strata: strataSelections,
  };
}

interface KeyedUnit<T> {
  readonly unit: T;
  readonly key: string;
  readonly hash: number;
}

function selectFromStratum<T extends SamplingUnit>(
  stratumUnits: readonly KeyedUnit<T>[],
  options: SamplingOptions,
): readonly T[] {
  const sampleSize = Math.ceil(stratumUnits.length * options.rate);
  const ranked = [...stratumUnits].sort(compareByHash);
  return ranked.slice(0, sampleSize).map((entry) => entry.unit);
}

function compareByHash<T>(a: KeyedUnit<T>, b: KeyedUnit<T>): number {
  if (a.hash !== b.hash) {
    return a.hash - b.hash;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function groupByStratum<T extends SamplingUnit>(
  units: readonly KeyedUnit<T>[],
): ReadonlyMap<string, readonly KeyedUnit<T>[]> {
  const groups = new Map<string, KeyedUnit<T>[]>();
  for (const unit of units) {
    const stratum = unit.unit.stratum ?? "default";
    const existing = groups.get(stratum);
    if (existing === undefined) {
      groups.set(stratum, [unit]);
    } else {
      existing.push(unit);
    }
  }
  return groups;
}

function validateUnits<T extends SamplingUnit>(
  units: readonly T[],
): readonly { readonly unit: T; readonly key: string }[] {
  if (!Array.isArray(units)) {
    throw new Error("units must be an array of SamplingUnit");
  }
  const seen = new Set<string>();
  return units.map((unit, index) => {
    if (typeof unit !== "object" || unit === null) {
      throw new Error(`units[${index}] must be a SamplingUnit object`);
    }
    if (typeof unit.key !== "string" || unit.key.length === 0) {
      throw new Error(`units[${index}].key must be a non-empty string`);
    }
    if (seen.has(unit.key)) {
      throw new Error(`units[${index}].key "${unit.key}" is duplicated; sampling unit keys must be unique`);
    }
    seen.add(unit.key);
    if (unit.stratum !== undefined && unit.stratum !== null && typeof unit.stratum !== "string") {
      throw new Error(`units[${index}].stratum must be a string or null`);
    }
    return { unit, key: unit.key };
  });
}

function validateOptions(options: SamplingOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new Error("options must be a SamplingOptions object");
  }
  if (typeof options.rate !== "number" || !Number.isFinite(options.rate) || options.rate <= 0 || options.rate > 1) {
    throw new Error(
      `options.rate must be a number in (0, 1] (got ${JSON.stringify(options.rate)})`,
    );
  }
  if (typeof options.seed !== "string" || options.seed.length === 0) {
    throw new Error("options.seed must be a non-empty string");
  }
}


/** 种子与键的拼接分隔符（NUL：不出现在正常键文本中，杜绝 seed/键拼接歧义） */
const SEED_SEPARATOR = String.fromCharCode(0);

/** FNV-1a 32 位哈希（确定性、无浮点；仅作排序键，非密码学用途） */
export function fnv1a32(text: string, seedText = ""): number {
  const input = seedText.length > 0 ? seedText + SEED_SEPARATOR + text : text;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

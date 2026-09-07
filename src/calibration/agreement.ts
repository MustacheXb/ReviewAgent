/**
 * 校准一致性度量（纯函数）：我们的 judge 裁定 vs MCR-Bench 官方 judge 判定。
 *
 * 比较粒度 = 「(模型缺陷下标, 真值缺陷下标) 候选对」的二分类（match / no-match），
 * 两侧各自把样例内全部候选对分类完毕：
 * - 官方侧：matches 中 ground_truth_defect_index 非 null 的条目（1 起索引）；
 * - 我方侧：resolveAdjudication 占用解析后的命中对（0 起索引）。
 * 在每样例 findings × truths 全候选对宇宙上累计混淆矩阵，算
 * Cohen's kappa 与原始一致率；另计「命中对集合完全一致」的样例率（最严口径）。
 */

/** 混淆矩阵（二分类 rater=official/judge） */
export interface PairConfusion {
  /** 两侧均判 match */
  readonly both: number;
  /** 仅官方判 match */
  readonly officialOnly: number;
  /** 仅我方 judge 判 match */
  readonly judgeOnly: number;
  /** 两侧均判 no-match */
  readonly neither: number;
}

export const EMPTY_PAIR_CONFUSION: PairConfusion = {
  both: 0,
  officialOnly: 0,
  judgeOnly: 0,
  neither: 0,
};

/** 单侧命中对键（0 起 "finding:truth"） */
export type PairKey = string;

export function pairKey(findingIndex: number, truthIndex: number): PairKey {
  return `${findingIndex}:${truthIndex}`;
}

/** 官方判定 → 命中对键集合（1 起 → 0 起；truth 索引缺失/非法的条目不计） */
export function officialMatchedPairs(
  modelDefectCount: number,
  truthCount: number,
  officialMatches: readonly {
    readonly modelDefectIndex: number | null;
    readonly groundTruthDefectIndex: number | null;
  }[],
): ReadonlySet<PairKey> {
  const pairs = new Set<PairKey>();
  for (const match of officialMatches) {
    if (match.modelDefectIndex === null || match.groundTruthDefectIndex === null) {
      continue;
    }
    const findingIndex = match.modelDefectIndex - 1;
    const truthIndex = match.groundTruthDefectIndex - 1;
    if (findingIndex < 0 || findingIndex >= modelDefectCount || truthIndex < 0 || truthIndex >= truthCount) {
      continue;
    }
    pairs.add(pairKey(findingIndex, truthIndex));
  }
  return pairs;
}

/** 我方裁定 → 命中对键集合（0 起；界内已由 resolveAdjudication 保证） */
export function judgeMatchedPairs(
  matches: readonly { readonly findingIndex: number; readonly truthIndex: number }[],
): ReadonlySet<PairKey> {
  return new Set(matches.map((match) => pairKey(match.findingIndex, match.truthIndex)));
}

/**
 * 单样例候选对混淆：在 findings × truths 全候选对宇宙上，
 * 官方与我方各分类一次（无候选对 = 全零，不参与后续比率）。
 */
export function pairConfusionForSample(input: {
  readonly findingCount: number;
  readonly truthCount: number;
  readonly officialPairs: ReadonlySet<PairKey>;
  readonly judgePairs: ReadonlySet<PairKey>;
}): PairConfusion {
  validateCounts(input.findingCount, input.truthCount);
  let both = 0;
  let officialOnly = 0;
  let judgeOnly = 0;
  let neither = 0;
  for (let findingIndex = 0; findingIndex < input.findingCount; findingIndex++) {
    for (let truthIndex = 0; truthIndex < input.truthCount; truthIndex++) {
      const key = pairKey(findingIndex, truthIndex);
      const officialSays = input.officialPairs.has(key);
      const judgeSays = input.judgePairs.has(key);
      if (officialSays && judgeSays) {
        both++;
      } else if (officialSays) {
        officialOnly++;
      } else if (judgeSays) {
        judgeOnly++;
      } else {
        neither++;
      }
    }
  }
  return { both, officialOnly, judgeOnly, neither };
}

/** 累加混淆矩阵（不可变：返回新对象） */
export function addConfusion(left: PairConfusion, right: PairConfusion): PairConfusion {
  return {
    both: left.both + right.both,
    officialOnly: left.officialOnly + right.officialOnly,
    judgeOnly: left.judgeOnly + right.judgeOnly,
    neither: left.neither + right.neither,
  };
}

export interface AgreementMetrics {
  /** 原始一致率 po = (both + neither) / N；N=0 时为 null */
  readonly agreementRate: number | null;
  /** Cohen's kappa = (po - pe) / (1 - pe)；N=0 或 pe=1（退化）时为 null */
  readonly kappa: number | null;
  /** 候选对总数 N */
  readonly totalPairs: number;
}

/** 由混淆矩阵算原始一致率 + Cohen's kappa */
export function agreementMetrics(confusion: PairConfusion): AgreementMetrics {
  const total =
    confusion.both + confusion.officialOnly + confusion.judgeOnly + confusion.neither;
  if (total === 0) {
    return { agreementRate: null, kappa: null, totalPairs: 0 };
  }
  const agreementRate = (confusion.both + confusion.neither) / total;
  // 边际：官方判 match = both + officialOnly；我方判 match = both + judgeOnly
  const officialMatchMarginal = confusion.both + confusion.officialOnly;
  const judgeMatchMarginal = confusion.both + confusion.judgeOnly;
  const expectedMatch = (officialMatchMarginal * judgeMatchMarginal) / (total * total);
  const expectedNoMatch =
    ((total - officialMatchMarginal) * (total - judgeMatchMarginal)) / (total * total);
  const expectedAgreement = expectedMatch + expectedNoMatch;
  if (expectedAgreement >= 1) {
    return { agreementRate, kappa: null, totalPairs: total };
  }
  const kappa = (agreementRate - expectedAgreement) / (1 - expectedAgreement);
  return { agreementRate, kappa, totalPairs: total };
}

/** 命中对集合是否完全一致（最严口径：一对一映射完全相同） */
export function pairsExactlyMatch(
  officialPairs: ReadonlySet<PairKey>,
  judgePairs: ReadonlySet<PairKey>,
): boolean {
  if (officialPairs.size !== judgePairs.size) {
    return false;
  }
  for (const key of officialPairs) {
    if (!judgePairs.has(key)) {
      return false;
    }
  }
  return true;
}

function validateCounts(findingCount: number, truthCount: number): void {
  if (!Number.isInteger(findingCount) || findingCount < 0) {
    throw new Error(`findingCount must be a non-negative integer (got ${JSON.stringify(findingCount)})`);
  }
  if (!Number.isInteger(truthCount) || truthCount < 0) {
    throw new Error(`truthCount must be a non-negative integer (got ${JSON.stringify(truthCount)})`);
  }
}

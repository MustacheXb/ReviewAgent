import type { Finding } from "../../contracts/finding.js";
import type { MRTruth } from "../../contracts/mr-case.js";
import { type Result, ok } from "../../dataset/diff/types.js";
import {
  buildAliasLookup,
  canonicalNature,
  normalizeFilePath,
  screenFindings,
  validateFindings,
  validateScreeningOptions,
} from "../../metrics/screening.js";
import type { ScreeningOptions } from "../../metrics/types.js";
import {
  anchorKey,
  type MergeConfig,
  type MergeDecision,
  mergeShardFindings,
  type ShardFindings,
} from "../../sharding/merge-findings.js";

/**
 * 三判据纯函数（spec #48 实现决策 15，ticket #57）：对验证 harness 的双臂
 * 产出计算切分合并安全性的可判定指标。
 *
 * - 不丢（evaluateNoLoss）：基线检视（main 侧直跑）逐案例 × rep 检出的
 *   findings，在切分合并结果中是否仍有对应条目。两级匹配：strict = 同
 *   归一文件 + canonicalNature(category) 相等 + 行距 ≤ matchWindow；loose
 *   兜底 = 同文件 + 行距内（性质漂移不算丢，matchKind 记录去向）。rule
 *   自由文本不参与匹配（合并层同口径）。轨迹带 caseId + rep，可喂 #30
 *   对称 max σ 带判定层（#59/#60 实验设计）；strict / loose 在轨迹与汇总
 *   两级分列——σ 带层可按需只取 strict 口径，loose 不吞掉真实丢失信号。
 * - 不重（evaluateNoDuplicate）：合并结果内同锚点键（与合并层同一
 *   anchorKey 单一来源）且行距 ≤ 窗口的两两条目。合并层立新锚的前提即
 *   与同键既有锚行距超窗，故本判据在正确合并的产物上恒空——定位是合并
 *   层回归守卫（回归即漏网对显形），非独立检出器。
 * - 不误并（evaluateNoWrongMerge）：经公开 mergeShardFindings 同配置
 *   重放合并决策，按锚点分组（≥2 成员 = 实际发生并入的组），逐成员用
 *   判定链 screenFindings 单筛（一对一，无跨成员占用）映射真值下标；
 *   ≥2 个相异真值下标 = 把不同缺陷并成了一条（TP/FP 混合不判——严格
 *   口径，宁漏报不误报）。
 *
 * 口径说明：anchorKey 沿用合并层的原始 file 字符串（#51 冻结面，单一
 * 来源）；跨片同文件异形路径（如 b/ 前缀）的去重属合并层行为议题，本
 * 模块不单方面改变其语义。
 *
 * 输入形状错误沿用判定链 fail-fast 抛出风格（screening.ts 同层）；可
 * 组合失败（合并层拒绝）经 Result 原样透传。纯函数零 IO，同输入必同输出。
 */

// ===== 判据一：不丢 =====

/** 一条基线运行（某案例某 rep 的 main 侧直跑产出） */
export interface BaselineRunInput {
  readonly caseId: string;
  readonly rep: number;
  readonly findings: readonly Finding[];
}

export interface NoLossInput {
  /** 基线检视记录（逐案例 × rep；建议 3-rep，喂 σ 带判定层） */
  readonly baseline: readonly BaselineRunInput[];
  /** 被判定的结果（切分合并产出或直通产出） */
  readonly findings: readonly Finding[];
  /** 不丢匹配行距容差（非负整数） */
  readonly matchWindow: number;
  /** 性质等价口径（与判定链同源） */
  readonly screening: ScreeningOptions;
}

/** 匹配级别：strict = 性质等价命中；loose = 同文件行距内兜底（性质漂移） */
export type LossMatchKind = "strict" | "loose";

/** 一条基线 finding 的去向轨迹（σ 带判定层的最小喂数单元） */
export interface BaselineFindingTrace {
  readonly caseId: string;
  readonly rep: number;
  readonly findingId: string;
  readonly matchedFindingId: string | null;
  readonly matchKind: LossMatchKind | null;
  readonly lineDelta: number | null;
}

export interface NoLossPerCase {
  readonly caseId: string;
  readonly repCount: number;
  readonly baselineFindings: number;
  /** 性质等价命中（strict）数 */
  readonly strictMatched: number;
  /** 同文件行距内兜底命中（性质漂移）数 */
  readonly looseMatched: number;
  readonly lost: number;
}

export interface NoLossReport {
  readonly traces: readonly BaselineFindingTrace[];
  readonly perCase: readonly NoLossPerCase[];
  readonly totalBaseline: number;
  readonly totalStrict: number;
  readonly totalLoose: number;
  readonly totalMatched: number;
  readonly totalLost: number;
}

interface CandidateMatch {
  readonly finding: Finding;
  readonly index: number;
  readonly lineDelta: number;
  readonly natureMatch: boolean;
}

/** 基线 finding 在结果中找最佳对应：性质等价候选集非空不落 loose；集内行距最小者胜，平局取首见 */
function bestMatch(
  baseline: Finding,
  findings: readonly Finding[],
  matchWindow: number,
  aliasLookup: Readonly<Record<string, string>>,
): CandidateMatch | null {
  const candidates: CandidateMatch[] = [];
  const baselineNature = canonicalNature(baseline.category, aliasLookup);
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index]!;
    if (normalizeFilePath(finding.file) !== normalizeFilePath(baseline.file)) {
      continue;
    }
    const lineDelta = Math.abs(finding.line - baseline.line);
    if (lineDelta > matchWindow) {
      continue;
    }
    candidates.push({
      finding,
      index,
      lineDelta,
      natureMatch: canonicalNature(finding.category, aliasLookup) === baselineNature,
    });
  }
  const pool = candidates.some((candidate) => candidate.natureMatch)
    ? candidates.filter((candidate) => candidate.natureMatch)
    : candidates;
  if (pool.length === 0) {
    return null;
  }
  // 行距最小者胜；平局取首见（index 最小）
  return pool.reduce((best, candidate) =>
    candidate.lineDelta < best.lineDelta ? candidate : best,
  )!;
}

export function evaluateNoLoss(input: NoLossInput): NoLossReport {
  if (!Number.isInteger(input.matchWindow) || input.matchWindow < 0) {
    throw new Error(
      `matchWindow must be an integer >= 0 (got ${JSON.stringify(input.matchWindow)})`,
    );
  }
  validateScreeningOptions(input.screening);
  const aliasLookup = buildAliasLookup(input.screening.natureAliases);
  validateFindings(input.findings);

  const traces: BaselineFindingTrace[] = [];
  const perCaseOrder: string[] = [];
  const perCaseAccumulator = new Map<
    string,
    {
      caseId: string;
      reps: Set<number>;
      baselineFindings: number;
      strictMatched: number;
      looseMatched: number;
      lost: number;
    }
  >();
  for (const run of input.baseline) {
    validateFindings(run.findings);
    let perCase = perCaseAccumulator.get(run.caseId);
    if (perCase === undefined) {
      perCase = {
        caseId: run.caseId,
        reps: new Set(),
        baselineFindings: 0,
        strictMatched: 0,
        looseMatched: 0,
        lost: 0,
      };
      perCaseAccumulator.set(run.caseId, perCase);
      perCaseOrder.push(run.caseId);
    }
    perCase.reps.add(run.rep);
    for (const baseline of run.findings) {
      const match = bestMatch(baseline, input.findings, input.matchWindow, aliasLookup);
      traces.push({
        caseId: run.caseId,
        rep: run.rep,
        findingId: baseline.id,
        matchedFindingId: match === null ? null : match.finding.id,
        matchKind: match === null ? null : match.natureMatch ? "strict" : "loose",
        lineDelta: match === null ? null : match.lineDelta,
      });
      perCase.baselineFindings += 1;
      if (match === null) {
        perCase.lost += 1;
      } else if (match.natureMatch) {
        perCase.strictMatched += 1;
      } else {
        perCase.looseMatched += 1;
      }
    }
  }
  const perCase = perCaseOrder.map((caseId) => {
    const accumulated = perCaseAccumulator.get(caseId)!;
    return {
      caseId,
      repCount: accumulated.reps.size,
      baselineFindings: accumulated.baselineFindings,
      strictMatched: accumulated.strictMatched,
      looseMatched: accumulated.looseMatched,
      lost: accumulated.lost,
    };
  });
  return {
    traces,
    perCase,
    totalBaseline: perCase.reduce((sum, entry) => sum + entry.baselineFindings, 0),
    totalStrict: perCase.reduce((sum, entry) => sum + entry.strictMatched, 0),
    totalLoose: perCase.reduce((sum, entry) => sum + entry.looseMatched, 0),
    totalMatched: perCase.reduce((sum, entry) => sum + entry.strictMatched + entry.looseMatched, 0),
    totalLost: perCase.reduce((sum, entry) => sum + entry.lost, 0),
  };
}

// ===== 判据二：不重 =====

export interface DuplicatePair {
  readonly findingIdA: string;
  readonly findingIdB: string;
  readonly lineDelta: number;
}

export interface NoDuplicateReport {
  readonly findingCount: number;
  readonly pairs: readonly DuplicatePair[];
}

/**
 * 合并结果内的重复对检出：按合并层同款锚点键（anchorKey 单一来源）分组，
 * 组内两两判行距（对称覆盖——合并层只对锚判窗口，本判据覆盖任意成员对）。
 */
export function evaluateNoDuplicate(
  findings: readonly Finding[],
  lineWindow: number,
): NoDuplicateReport {
  if (!Number.isInteger(lineWindow) || lineWindow < 0) {
    throw new Error(
      `lineWindow must be an integer >= 0 (got ${JSON.stringify(lineWindow)})`,
    );
  }
  validateFindings(findings);
  const groups = new Map<string, Finding[]>();
  const groupOrder: string[] = [];
  for (const finding of findings) {
    const key = anchorKey(finding);
    let members = groups.get(key);
    if (members === undefined) {
      members = [];
      groups.set(key, members);
      groupOrder.push(key);
    }
    members.push(finding);
  }
  const pairs: DuplicatePair[] = [];
  for (const key of groupOrder) {
    const members = groups.get(key)!;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const first = members[a]!;
        const second = members[b]!;
        const lineDelta = Math.abs(first.line - second.line);
        if (lineDelta <= lineWindow) {
          pairs.push({ findingIdA: first.id, findingIdB: second.id, lineDelta });
        }
      }
    }
  }
  return { findingCount: findings.length, pairs };
}

// ===== 判据三：不误并 =====

export interface WrongMergeInput {
  /** 各片产出（重放合并决策的原料；分片文件不相交，组内成员多来自片内跨轮重复） */
  readonly shards: readonly ShardFindings[];
  /** 与被验运行同款的合并配置（回放上下文） */
  readonly merge: MergeConfig;
  /** 合成 MR 真值（成员真值映射用） */
  readonly truth: MRTruth;
  /** 性质等价口径（与判定链同源） */
  readonly screening: ScreeningOptions;
}

export interface WrongMergeMember {
  readonly findingId: string;
  readonly shardId: string;
  /** 该成员单筛命中的真值下标；FP 为 null */
  readonly matchedTruthIndex: number | null;
}

export interface WrongMergeEntry {
  readonly anchorFindingId: string;
  readonly members: readonly WrongMergeMember[];
  /** 组内命中的相异真值下标（≥2 即误并） */
  readonly distinctTruthIndices: readonly number[];
}

export interface NoWrongMergeReport {
  /** 实际发生并入的合并条目数（≥2 成员的锚点组数；受检面） */
  readonly mergedEntryCount: number;
  /** 误并条目（空 = 通过） */
  readonly entries: readonly WrongMergeEntry[];
}

export function evaluateNoWrongMerge(input: WrongMergeInput): Result<NoWrongMergeReport> {
  const merged = mergeShardFindings(input.shards, input.merge);
  if (!merged.ok) {
    return merged;
  }
  validateScreeningOptions(input.screening);
  // 决策按锚分组：first-seen 决策（锚自身）+ deduped 决策（并入者）同组
  const groups = new Map<string, MergeDecision[]>();
  const groupOrder: string[] = [];
  for (const decision of merged.value.decisions) {
    let members = groups.get(decision.anchorFindingId);
    if (members === undefined) {
      members = [];
      groups.set(decision.anchorFindingId, members);
      groupOrder.push(decision.anchorFindingId);
    }
    members.push(decision);
  }
  // 成员查找：决策源于同一输入 shards，按 shardId + findingId 唯一取回
  // （复合键用 JSON 数组序列化——与合并层 anchorKey 同技法，无分隔符歧义）
  const findingById = new Map<string, { finding: Finding; shardId: string }>();
  for (const shard of input.shards) {
    for (const finding of shard.findings) {
      findingById.set(JSON.stringify([shard.shardId, finding.id]), { finding, shardId: shard.shardId });
    }
  }
  let mergedEntryCount = 0;
  const entries: WrongMergeEntry[] = [];
  for (const anchorFindingId of groupOrder) {
    const decisions = groups.get(anchorFindingId)!;
    if (decisions.length < 2) {
      continue;
    }
    mergedEntryCount += 1;
    const members: WrongMergeMember[] = decisions.map((decision) => {
      const found = findingById.get(JSON.stringify([decision.shardId, decision.findingId]));
      const matchedTruthIndex =
        found === undefined
          ? null
          : screenFindings([found.finding], input.truth, input.screening).verdicts[0]
              ?.matchedTruthIndex ?? null;
      return { findingId: decision.findingId, shardId: decision.shardId, matchedTruthIndex };
    });
    const distinctTruthIndices = [
      ...new Set(
        members
          .map((member) => member.matchedTruthIndex)
          .filter((index): index is number => index !== null),
      ),
    ];
    if (distinctTruthIndices.length >= 2) {
      entries.push({ anchorFindingId, members, distinctTruthIndices });
    }
  }
  return ok({ mergedEntryCount, entries });
}

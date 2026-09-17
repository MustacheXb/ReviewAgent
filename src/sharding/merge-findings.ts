import type { Finding } from "../contracts/finding.js";
import { type Result, DatasetError, err, ok } from "../dataset/diff/types.js";

/**
 * 合并层纯函数（spec #48 实现决策 8–9，ticket #51）：把 N 片各自独立管线
 * 产出的 findings 按锚点键去重合并为单份检视结果。
 *
 * - 锚点键：同 file + 行号窗口 ±N（缺省 3，配置可调）+ rule / category 相同
 *   → 视为同一 Finding。锚点语义：首个产出该键的 finding 为锚，后续 finding
 *   与「锚」的行号差 ≤ 窗口才并入（非传递聚类）；双锚同时命中时取首见锚。
 * - 首见保留：合并条目的字段以首见分片为准；shardIds 列出全部来源分片。
 * - evidence 并集：并入时求并集且不引入重复条目；无命中条目原样透传。
 * - 合并决策可回放：每条输入 finding 的去重键命中与首见决策记录于 decisions。
 * - 纯函数零 IO：遍历序 = 分片数组序（串行执行序）+ 片内 findings 序，
 *   同输入必同输出。
 */
export interface MergeConfig {
  /** 锚点键行号窗口（±N 行；起步值 3，验证跑量化后可调） */
  readonly lineWindow: number;
}

export const DEFAULT_MERGE_CONFIG: Readonly<MergeConfig> = Object.freeze({ lineWindow: 3 });

/** 单片的产出：分片 id + 该片管线产出的 findings */
export interface ShardFindings {
  readonly shardId: string;
  readonly findings: readonly Finding[];
}

/** 合并后的 Finding：字段以首见分片为准，附加来源分片 provenance（管线外附加，不进模型输出 Schema） */
export interface MergedFinding extends Finding {
  readonly shardIds: readonly string[];
}

export type MergeAction = "first-seen" | "deduped";

/** 合并决策（可回放审计：每条输入 finding 的去向） */
export interface MergeDecision {
  readonly shardId: string;
  readonly findingId: string;
  /** first-seen = 确立新锚（首见保留）；deduped = 去重键命中并入已有锚 */
  readonly action: MergeAction;
  /** 并入（或确立）的锚 finding id */
  readonly anchorFindingId: string;
  /** deduped 时与锚的行号差（回放窗口判定）；first-seen 为 null */
  readonly lineDelta: number | null;
}

export interface MergeResult {
  /** 合并去重后的单份检视结果（无命中条目原样透传，顺序保持输入序） */
  readonly findings: readonly MergedFinding[];
  readonly decisions: readonly MergeDecision[];
  /** 本次生效的合并配置（回放窗口判定的上下文） */
  readonly config: MergeConfig;
}

/** 锚点：一条确立的合并条目及其并集累加状态 */
interface Anchor {
  readonly finding: Finding;
  readonly shardId: string;
  readonly shardIds: string[];
  /** evidence 并集；建立时为首见 evidence 原引用（透传不变），首次并入时替换为去重并集 */
  evidence: readonly string[];
  /** 惰性建立：首次并入时才创建（避免透传路径做无谓拷贝） */
  evidenceSeen: Set<string> | null;
}

export function mergeShardFindings(
  shards: readonly ShardFindings[],
  config: MergeConfig = DEFAULT_MERGE_CONFIG,
): Result<MergeResult> {
  const configError = validateMergeConfig(config);
  if (configError !== undefined) {
    return err(configError);
  }
  const inputError = validateShardFindings(shards);
  if (inputError !== undefined) {
    return err(inputError);
  }
  const anchorsByKey = new Map<string, Anchor[]>();
  const ordered: Anchor[] = [];
  const decisions: MergeDecision[] = [];
  for (const shard of shards) {
    for (const finding of shard.findings) {
      const key = anchorKey(finding);
      const candidates = anchorsByKey.get(key);
      const anchor = candidates === undefined ? undefined : findAnchor(candidates, finding, config.lineWindow);
      if (anchor === undefined) {
        const created: Anchor = {
          finding,
          shardId: shard.shardId,
          shardIds: [shard.shardId],
          evidence: finding.evidence,
          evidenceSeen: null,
        };
        if (candidates === undefined) {
          anchorsByKey.set(key, [created]);
        } else {
          candidates.push(created);
        }
        ordered.push(created);
        decisions.push({
          shardId: shard.shardId,
          findingId: finding.id,
          action: "first-seen",
          anchorFindingId: finding.id,
          lineDelta: null,
        });
        continue;
      }
      if (!anchor.shardIds.includes(shard.shardId)) {
        anchor.shardIds.push(shard.shardId);
      }
      absorbEvidence(anchor, finding.evidence);
      decisions.push({
        shardId: shard.shardId,
        findingId: finding.id,
        action: "deduped",
        anchorFindingId: anchor.finding.id,
        lineDelta: lineDelta(anchor, finding),
      });
    }
  }
  const findings: MergedFinding[] = ordered.map((anchor) => ({
    ...anchor.finding,
    evidence: anchor.evidence,
    shardIds: [...anchor.shardIds],
  }));
  return ok({ findings, decisions, config });
}

/** 锚点分组键：file + rule + category（JSON 数组序列化保证无分隔符歧义；导出供判据层复用同一口径） */
export function anchorKey(finding: Finding): string {
  return JSON.stringify([finding.file, finding.rule, finding.category]);
}

/** 合并配置校验（编排层入口先行调用：非法配置在零 LLM 成本时拒绝） */
export function validateMergeConfig(config: MergeConfig): DatasetError | undefined {
  if (!Number.isInteger(config.lineWindow) || config.lineWindow < 1) {
    return new DatasetError(
      "MERGE_CONFIG_INVALID",
      `lineWindow 必须为正整数（got ${config.lineWindow}）`,
    );
  }
  return undefined;
}

function validateShardFindings(shards: readonly ShardFindings[]): DatasetError | undefined {
  for (const shard of shards) {
    if (typeof shard.shardId !== "string" || shard.shardId.length === 0) {
      return new DatasetError("MERGE_INPUT_INVALID", "shardId 必须为非空字符串");
    }
  }
  return undefined;
}

/** 在同键已有锚中找行号窗口命中的首见锚（插入序，确定性 tie-break） */
function findAnchor(
  candidates: readonly Anchor[],
  finding: Finding,
  lineWindow: number,
): Anchor | undefined {
  return candidates.find((anchor) => lineDelta(anchor, finding) <= lineWindow);
}

/** 与锚的行号差绝对值（窗口判定与决策回放同口径） */
function lineDelta(anchor: Anchor, finding: Finding): number {
  return Math.abs(anchor.finding.line - finding.line);
}

/**
 * evidence 并集：不引入重复条目。首次并入时惰性建立去重集（顺带洗掉
 * 首见 evidence 的内部重复）；此后每次并入整体重赋值，不原地修改。
 */
function absorbEvidence(anchor: Anchor, incoming: readonly string[]): void {
  if (anchor.evidenceSeen === null) {
    anchor.evidenceSeen = new Set(anchor.evidence);
    anchor.evidence = [...anchor.evidenceSeen];
  }
  const fresh = incoming.filter((entry) => !anchor.evidenceSeen!.has(entry));
  for (const entry of fresh) {
    anchor.evidenceSeen!.add(entry);
  }
  if (fresh.length > 0) {
    anchor.evidence = [...anchor.evidence, ...fresh];
  }
}

import { allocateSampleSizes, sampleDeterministic } from "../sampling.js";
import { type MrBoundary, DEFAULT_MR_BOUNDARY } from "../mr-boundary-filter.js";
import { type Result, DatasetError, err, ok } from "../diff/types.js";

/**
 * Multi-SWE-bench Java 抽样清单构造（Ticket 08：128 实例中确定性抽 ~30）。
 *
 * 分层策略：以 9 个 GitHub 仓库（org/repo）为层，按层规模比例分配名额
 * （最大余数法），每层保底 1 条（仓库覆盖度），上限为层规模；
 * 层内确定性 PRNG 抽样（mulberry32，种子 = hash(seed:org/repo)）。
 * 抽样池 = 通过 MR 边界（≤10 文件 / fix_patch ≤2K 变更行）且 fix_patch
 * 可解析的实例（实测 128 条中 124 条合格，4 条因文件数/行数超界被拒，
 * 过滤率 3.1%）；全量池与逐条拒绝原因留痕于清单。
 * 纯函数：池数据由清单生成脚本实测产出并随清单提交，本模块零网络零下载。
 */

export const MSB_JAVA_DEFAULT_SEED = "poc1-msb-java-2026";
export const MSB_JAVA_DEFAULT_TARGET = 30;
export const MSB_JAVA_DEFAULT_MIN_PER_STRATUM = 1;

/** MSB 抽样池条目（生成脚本实测产出：记录标识 + 边界指标） */
export interface MsbPoolEntry {
  readonly instanceId: string;
  readonly org: string;
  readonly repo: string;
  readonly number: number;
  /** fix_patch 解析与边界指标状态（拒绝原因见 rejectReason） */
  readonly status: "eligible" | "rejected";
  /** fix_patch 文件数（解析失败时为 null） */
  readonly files: number | null;
  /** fix_patch 变更行数 = 新增 + 删除（解析失败时为 null） */
  readonly changedLines: number | null;
  readonly rejectReason: string | null;
}

export interface MsbSamplingManifest {
  readonly seed: string;
  readonly targetTotal: number;
  readonly minPerStratum: number;
  readonly stratification: string;
  /** MR 边界（spec #1：≤10 文件 / diff ≤2K 行） */
  readonly boundary: MrBoundary;
  readonly poolTotal: number;
  readonly eligibleCount: number;
  readonly rejectedCount: number;
  readonly rejectedByReason: Readonly<Record<string, number>>;
  /** 全量池（128 条，含指标与拒绝原因，过滤率留痕；按 instanceId 字典序） */
  readonly pool: readonly MsbPoolEntry[];
  /** 目标清单（按 instanceId 字典序） */
  readonly sampled: readonly MsbPoolEntry[];
  readonly total: number;
}

export interface MsbManifestOptions {
  readonly seed?: string;
  readonly targetTotal?: number;
  readonly minPerStratum?: number;
  readonly boundary?: MrBoundary;
}

/** 构建抽样清单（纯函数；同 seed 与同池必得同清单，与池输入顺序无关） */
export function buildMsbSamplingManifest(
  pool: readonly MsbPoolEntry[],
  options: MsbManifestOptions = {},
): Result<MsbSamplingManifest> {
  const seed = options.seed ?? MSB_JAVA_DEFAULT_SEED;
  const targetTotal = options.targetTotal ?? MSB_JAVA_DEFAULT_TARGET;
  const minPerStratum = options.minPerStratum ?? MSB_JAVA_DEFAULT_MIN_PER_STRATUM;
  const boundary = options.boundary ?? DEFAULT_MR_BOUNDARY;
  const poolError = validatePool(pool, boundary);
  if (poolError !== undefined) {
    return err(poolError);
  }

  const sortedPool = [...pool].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const eligible = sortedPool.filter((entry) => entry.status === "eligible");
  const rejected = sortedPool.filter((entry) => entry.status === "rejected");

  const strata = groupByRepo(eligible);
  const stratumKeys = [...strata.keys()].sort();
  const sizes = allocateSampleSizes(
    stratumKeys.map((key) => strata.get(key)!.length),
    targetTotal,
    minPerStratum,
  );
  const sampled: MsbPoolEntry[] = [];
  for (const [index, key] of stratumKeys.entries()) {
    const stratumPool = strata.get(key)!;
    const take = sampleDeterministic(
      stratumPool.map((entry) => entry.instanceId),
      sizes[index]!,
      `${seed}:${key}`,
    );
    const taken = new Set(take);
    sampled.push(...stratumPool.filter((entry) => taken.has(entry.instanceId)));
  }
  sampled.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  return ok({
    seed,
    targetTotal,
    minPerStratum,
    stratification: `by-repo proportional (largest remainder), min ${minPerStratum} per repo, cap at stratum size; in-stratum deterministic sample (mulberry32, seed hash("${seed}:<org>/<repo>"))`,
    boundary,
    poolTotal: sortedPool.length,
    eligibleCount: eligible.length,
    rejectedCount: rejected.length,
    rejectedByReason: countByReason(rejected),
    pool: sortedPool,
    sampled,
    total: sampled.length,
  });
}

/** 池条目自检：标识合法、无重复、状态与指标一致、指标与边界结论一致（按解析后的 boundary） */
function validatePool(pool: readonly MsbPoolEntry[], boundary: MrBoundary): DatasetError | undefined {
  const seen = new Set<string>();
  for (const entry of pool) {
    if (typeof entry.instanceId !== "string" || entry.instanceId.trim() === "") {
      return new DatasetError("INVALID_POOL_ENTRY", `instanceId 非法: ${JSON.stringify(entry.instanceId)}`);
    }
    if (seen.has(entry.instanceId)) {
      return new DatasetError("INVALID_POOL_ENTRY", `instanceId 重复: ${entry.instanceId}`);
    }
    seen.add(entry.instanceId);
    if (typeof entry.org !== "string" || entry.org.trim() === "" || typeof entry.repo !== "string" || entry.repo.trim() === "") {
      return new DatasetError("INVALID_POOL_ENTRY", `${entry.instanceId} 的 org/repo 必须为非空字符串`);
    }
    if (!Number.isInteger(entry.number) || entry.number < 1) {
      return new DatasetError("INVALID_POOL_ENTRY", `${entry.instanceId} 的 number 必须为 ≥1 的整数`);
    }
    if (entry.status === "eligible" && (entry.files === null || entry.changedLines === null)) {
      return new DatasetError("INVALID_POOL_ENTRY", `${entry.instanceId} 标记 eligible 但 files/changedLines 缺失`);
    }
    if (entry.status === "rejected" && (entry.rejectReason === null || entry.rejectReason.trim() === "")) {
      return new DatasetError("INVALID_POOL_ENTRY", `${entry.instanceId} 标记 rejected 但缺 rejectReason`);
    }
    if (entry.files === null || entry.changedLines === null) {
      continue;
    }
    const withinBoundary =
      entry.files <= boundary.maxFiles && entry.changedLines <= boundary.maxDiffLines;
    if (withinBoundary && entry.status !== "eligible") {
      return new DatasetError(
        "INVALID_POOL_ENTRY",
        `${entry.instanceId} 指标在边界内但 status 为 ${entry.status}（指标与结论不一致）`,
      );
    }
    if (!withinBoundary && entry.status === "eligible") {
      return new DatasetError(
        "INVALID_POOL_ENTRY",
        `${entry.instanceId} 标记 eligible 但指标超界（files=${entry.files}, changedLines=${entry.changedLines}）`,
      );
    }
  }
  return undefined;
}

function groupByRepo(eligible: readonly MsbPoolEntry[]): Map<string, MsbPoolEntry[]> {
  const strata = new Map<string, MsbPoolEntry[]>();
  for (const entry of eligible) {
    const key = `${entry.org}/${entry.repo}`;
    const bucket = strata.get(key);
    if (bucket === undefined) {
      strata.set(key, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  return strata;
}

function countByReason(rejected: readonly MsbPoolEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of rejected) {
    const reason = entry.rejectReason ?? "unknown";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

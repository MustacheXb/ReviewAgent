import { allocateSampleSizes, sampleDeterministic } from "../sampling.js";
import { type Result, DatasetError, err, ok } from "../diff/types.js";
import { resolveCweNature } from "./cwe-nature-map.js";
import { extractFixSha } from "./adapter.js";

/**
 * Vul4J 安全子集目标清单构造（Ticket 08：~30 条，清单产出即可，不跑检视）。
 *
 * 分层策略：以 CWE 编号为层（66 条 CWE 标注条目共 25 个 CWE），
 * 按层规模比例分配名额（最大余数法），每层保底 1 条（漏洞类型全覆盖），
 * 上限为层规模；层内确定性 PRNG 抽样（mulberry32，种子 = hash(seed:cwe)）。
 * 抽样池 = 通过 MR 边界（≤10 文件 / 源码补丁 ≤2K 变更行）且补丁可达可解析的
 * 条目；全量池与逐条拒绝原因留痕于清单（过滤率可复算）。
 * 纯函数：池数据由清单生成脚本实测产出并随清单提交，本模块零网络零下载。
 */

export const VUL4J_DEFAULT_SEED = "poc1-vul4j-2026";
export const VUL4J_DEFAULT_TARGET = 30;
export const VUL4J_DEFAULT_MIN_PER_STRATUM = 1;

/** Vul4J 抽样池条目（生成脚本实测产出：CSV 元数据 + 补丁可达性/边界指标） */
export interface Vul4jPoolEntry {
  readonly vulId: string;
  readonly cveId: string;
  readonly cweId: string;
  readonly cweName: string;
  readonly owaspId: string;
  /** CSV repo_slug 标签（可能与实际仓库不一致，定位以 fixCommitUrl 为准） */
  readonly repoSlug: string;
  readonly fixCommitUrl: string;
  /** 修复侧 SHA（commit 直链取尾段；compare 取 `..` 右侧） */
  readonly fixSha: string;
  /** 补丁获取状态（404/仓库迁移等） */
  readonly fetchStatus: "ok" | "unreachable";
  /** 源码补丁（测试剥离后）解析状态 */
  readonly parseStatus: "ok" | "failed";
  /** 被剥离的测试文件（逆补丁 MR 不含测试改动，剥离明细留痕） */
  readonly excludedTestFiles: readonly string[];
  /** 被剥离的二进制文件（parseUnifiedDiff 不支持二进制节） */
  readonly excludedBinaryFiles: readonly string[];
  /** 源码补丁边界指标：文件数（解析失败时为 null） */
  readonly files: number | null;
  /** 源码补丁边界指标：变更行数（新增+删除；解析失败时为 null） */
  readonly changedLines: number | null;
  /** CVE/CWE → 缺陷性质映射结果（matched=false = 显式降级 OTHER 留痕） */
  readonly nature: string;
  readonly natureMatched: boolean;
  /** 是否进入抽样池（拒绝原因见 rejectReason） */
  readonly status: "eligible" | "rejected";
  readonly rejectReason: string | null;
}

export interface Vul4jTargetManifest {
  readonly seed: string;
  readonly targetTotal: number;
  readonly minPerStratum: number;
  readonly stratification: string;
  /** 抽样池总数（CWE 标注条目） */
  readonly poolTotal: number;
  readonly eligibleCount: number;
  readonly rejectedCount: number;
  readonly rejectedByReason: Readonly<Record<string, number>>;
  /** 全量池（含指标与拒绝原因，过滤率留痕；按 vulId 数值序） */
  readonly pool: readonly Vul4jPoolEntry[];
  /** 目标清单（按 vulId 数值序） */
  readonly sampled: readonly Vul4jPoolEntry[];
  readonly total: number;
}

export interface Vul4jManifestOptions {
  readonly seed?: string;
  readonly targetTotal?: number;
  readonly minPerStratum?: number;
}

const VUL_ID_RE = /^VUL4J-(\d+)(-S)?$/;

/** 构建目标清单（纯函数；同 seed 与同池必得同清单，与池输入顺序无关） */
export function buildVul4jTargetManifest(
  pool: readonly Vul4jPoolEntry[],
  options: Vul4jManifestOptions = {},
): Result<Vul4jTargetManifest> {
  const poolError = validatePool(pool);
  if (poolError !== undefined) {
    return err(poolError);
  }
  const seed = options.seed ?? VUL4J_DEFAULT_SEED;
  const targetTotal = options.targetTotal ?? VUL4J_DEFAULT_TARGET;
  const minPerStratum = options.minPerStratum ?? VUL4J_DEFAULT_MIN_PER_STRATUM;

  const sortedPool = [...pool].sort(compareVulId);
  const eligible = sortedPool.filter((entry) => entry.status === "eligible");
  const rejected = sortedPool.filter((entry) => entry.status === "rejected");

  const strata = groupByCwe(eligible);
  const stratumKeys = [...strata.keys()].sort();
  const sizes = allocateSampleSizes(
    stratumKeys.map((key) => strata.get(key)!.length),
    targetTotal,
    minPerStratum,
  );
  const sampled: Vul4jPoolEntry[] = [];
  for (const [index, key] of stratumKeys.entries()) {
    const stratumPool = strata.get(key)!;
    const take = sampleDeterministic(
      stratumPool.map((entry) => entry.vulId),
      sizes[index]!,
      `${seed}:${key}`,
    );
    const taken = new Set(take);
    sampled.push(...stratumPool.filter((entry) => taken.has(entry.vulId)));
  }
  sampled.sort(compareVulId);
  return ok({
    seed,
    targetTotal,
    minPerStratum,
    stratification: `by-cwe-id proportional (largest remainder), min ${minPerStratum} per CWE, cap at stratum size; in-stratum deterministic sample (mulberry32, seed hash("${seed}:<cwe>"))`,
    poolTotal: sortedPool.length,
    eligibleCount: eligible.length,
    rejectedCount: rejected.length,
    rejectedByReason: countByReason(rejected),
    pool: sortedPool,
    sampled,
    total: sampled.length,
  });
}

/** 池条目自检：vulId 合法、状态与指标一致、CWE 映射与词表一致 */
function validatePool(pool: readonly Vul4jPoolEntry[]): DatasetError | undefined {
  const seen = new Set<string>();
  for (const entry of pool) {
    if (!VUL_ID_RE.test(entry.vulId)) {
      return new DatasetError("INVALID_POOL_ENTRY", `vulId 非法: ${JSON.stringify(entry.vulId)}`);
    }
    if (seen.has(entry.vulId)) {
      return new DatasetError("INVALID_POOL_ENTRY", `vulId 重复: ${entry.vulId}`);
    }
    seen.add(entry.vulId);
    if (entry.status === "eligible" && (entry.files === null || entry.changedLines === null || entry.parseStatus !== "ok" || entry.fetchStatus !== "ok")) {
      return new DatasetError(
        "INVALID_POOL_ENTRY",
        `${entry.vulId} 标记 eligible 但指标缺失（fetch/parse 必须为 ok 且 files/changedLines 非 null）`,
      );
    }
    if (entry.status === "rejected" && (entry.rejectReason === null || entry.rejectReason.trim() === "")) {
      return new DatasetError("INVALID_POOL_ENTRY", `${entry.vulId} 标记 rejected 但缺 rejectReason`);
    }
    const resolution = resolveCweNature(entry.cweId);
    if (resolution.nature !== entry.nature || resolution.matched !== entry.natureMatched) {
      return new DatasetError(
        "INVALID_POOL_ENTRY",
        `${entry.vulId} 的 nature/natureMatched 与词表映射不一致（期望 ${resolution.nature}/${resolution.matched}，得到 ${entry.nature}/${entry.natureMatched}）`,
      );
    }
  }
  return undefined;
}

function groupByCwe(eligible: readonly Vul4jPoolEntry[]): Map<string, Vul4jPoolEntry[]> {
  const strata = new Map<string, Vul4jPoolEntry[]>();
  for (const entry of eligible) {
    const key = entry.cweId;
    const bucket = strata.get(key);
    if (bucket === undefined) {
      strata.set(key, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  return strata;
}

/** vulId 数值序（VUL4J-9 < VUL4J-10 < VUL4J-80-S） */
function compareVulId(a: { readonly vulId: string }, b: { readonly vulId: string }): number {
  const na = Number(VUL_ID_RE.exec(a.vulId)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const nb = Number(VUL_ID_RE.exec(b.vulId)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return na - nb || a.vulId.localeCompare(b.vulId);
}

function countByReason(rejected: readonly Vul4jPoolEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of rejected) {
    const reason = entry.rejectReason ?? "unknown";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

import { type Defects4jProjectInfo, DEFECTS4J_PROJECTS } from "./projects.js";
import {
  allocateSampleSizes as sharedAllocateSampleSizes,
  sampleDeterministic,
} from "../sampling.js";

export {
  /** 分层名额分配（共享工具，见 src/dataset/sampling.ts；重导出保持本模块既有 API） */
  allocateSampleSizes,
} from "../sampling.js";

/**
 * Defects4J 分层抽样（Ticket 02：~100 条目标清单；实跑在 Ticket 12）。
 *
 * 分层策略：以 17 个项目为层，按层规模（active bug 数）比例分配名额
 * （最大余数法），每层保底 minPerStratum 条（保证项目覆盖度），上限为层规模。
 * 层内抽样：确定性 PRNG（mulberry32，种子 = hash(seed:project)）做部分
 * Fisher–Yates 洗牌取前 k 个 ID 后升序排序——同种子必得同清单，可复现。
 * 纯函数，零网络、零下载、不执行 defects4j 命令。
 *
 * 层内 ID 池：默认按 [1..bugCount] 连续假设；由于 v3 存在弃用空洞（active ID
 * 不连续），Ticket 12 应传入 active-bugs.csv 的实际 ID 集重生成清单。
 */
export interface SamplingManifestProject {
  readonly project: string;
  readonly bugCount: number;
  readonly sampledBugIds: readonly number[];
}

export interface SamplingManifest {
  readonly seed: string;
  readonly targetTotal: number;
  readonly minPerStratum: number;
  readonly stratification: string;
  /** 项目 active bug 总数（v3.0.1，已核实，见 projects.ts） */
  readonly bugCountsVerified: boolean;
  /** 层内 ID 池是否为实际 active ID 集（false = [1..bugCount] 连续假设，待 T12 用 active-bugs.csv 校准） */
  readonly bugIdPoolsVerified: boolean;
  readonly projects: readonly SamplingManifestProject[];
  readonly total: number;
}

export const DEFAULT_SAMPLING_SEED = "poc1-d4j-2026";

/** 层内确定性抽样：从 ID 池中取 k 个不重复 ID（升序返回） */
export function sampleBugIds(
  project: string,
  pool: readonly number[],
  k: number,
  seed: string,
): number[] {
  return sampleDeterministic(pool, k, `${seed}:${project}`).sort((a, b) => a - b);
}

/** 连续 ID 池 [1..count]（默认；active ID 集未校准时的近似） */
export function contiguousPool(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

/**
 * 构建完整分层抽样清单（纯函数；同 seed 可复现）。
 *
 * @param activeBugIds 可选的项目 → 实际 active bug ID 集（active-bugs.csv）；
 *        缺省按 [1..bugCount] 连续假设（manifest.bugIdPoolsVerified = false）。
 */
export function buildSamplingManifest(
  projects: readonly Defects4jProjectInfo[] = DEFECTS4J_PROJECTS,
  targetTotal: number = 100,
  seed: string = DEFAULT_SAMPLING_SEED,
  minPerStratum: number = 3,
  activeBugIds?: Readonly<Record<string, readonly number[]>>,
): SamplingManifest {
  const pools = projects.map((p) => activeBugIds?.[p.key] ?? contiguousPool(p.bugCount));
  const sizes = sharedAllocateSampleSizes(
    pools.map((pool) => pool.length),
    targetTotal,
    minPerStratum,
  );
  const manifestProjects: SamplingManifestProject[] = projects.map((p, i) => ({
    project: p.key,
    bugCount: p.bugCount,
    sampledBugIds: sampleBugIds(p.key, pools[i]!, sizes[i]!, seed),
  }));
  const total = manifestProjects.reduce((s, p) => s + p.sampledBugIds.length, 0);
  return {
    seed,
    targetTotal,
    minPerStratum,
    stratification: `proportional-to-bug-count (largest remainder), min ${minPerStratum} per project, cap at project bug count`,
    bugCountsVerified: true,
    bugIdPoolsVerified: activeBugIds !== undefined,
    projects: manifestProjects,
    total,
  };
}

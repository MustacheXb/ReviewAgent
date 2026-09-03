import { type Defects4jProjectInfo, DEFECTS4J_PROJECTS } from "./projects.js";

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

/** 比例分配 + 保底 + 上限（最大余数法）；返回各层名额 */
export function allocateSampleSizes(
  stratumSizes: readonly number[],
  targetTotal: number,
  minPerStratum: number,
): number[] {
  const n = stratumSizes.length;
  if (n === 0 || targetTotal <= 0) {
    return stratumSizes.map(() => 0);
  }
  if (stratumSizes.some((c) => !Number.isInteger(c) || c < 0)) {
    throw new RangeError("stratumSizes 必须为非负整数");
  }
  const floorCap = Math.min(minPerStratum, targetTotal);
  const alloc = stratumSizes.map((c) => Math.max(0, Math.min(c, floorCap)));
  const floorSum = alloc.reduce((s, v) => s + v, 0);
  // 保底总额已超目标（目标过小）：退化为无保底的纯比例分配，保证总额不超目标
  if (floorSum > targetTotal) {
    return allocateByLargestRemainder(stratumSizes, targetTotal, stratumSizes.reduce((s, v) => s + v, 0)).map((v, i) =>
      Math.min(v, stratumSizes[i]!),
    );
  }
  let remaining = targetTotal - floorSum;
  while (remaining > 0) {
    const capacity = stratumSizes.map((c, i) => Math.max(0, c - alloc[i]!));
    const totalCapacity = capacity.reduce((s, v) => s + v, 0);
    if (totalCapacity === 0) {
      break;
    }
    const step = allocateByLargestRemainder(capacity, remaining, totalCapacity);
    let granted = 0;
    for (let i = 0; i < n; i += 1) {
      const give = Math.min(step[i]!, capacity[i]!);
      alloc[i] = alloc[i]! + give;
      granted += give;
    }
    if (granted === 0) {
      break;
    }
    remaining -= granted;
  }
  return alloc;
}

/** 按权重以最大余数法分配 quota 个名额（逐项不超过权重由调用方容量保证） */
function allocateByLargestRemainder(
  weights: readonly number[],
  quota: number,
  totalWeight: number,
): number[] {
  const raw = weights.map((w) => (quota * w) / totalWeight);
  const base = raw.map((v) => Math.floor(v));
  let left = quota - base.reduce((s, v) => s + v, 0);
  const order = weights
    .map((w, i) => ({ i, frac: raw[i]! - base[i]!, weight: w }))
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.frac - a.frac || b.weight - a.weight);
  const extra = weights.map(() => 0);
  for (const item of order) {
    if (left <= 0) {
      break;
    }
    extra[item.i] = 1;
    left -= 1;
  }
  return base.map((v, i) => v + extra[i]!);
}

/** 层内确定性抽样：从 ID 池中取 k 个不重复 ID（升序返回） */
export function sampleBugIds(
  project: string,
  pool: readonly number[],
  k: number,
  seed: string,
): number[] {
  if (k <= 0 || pool.length === 0) {
    return [];
  }
  const take = Math.min(k, pool.length);
  const ids = [...pool];
  const rng = mulberry32(hashSeed(`${seed}:${project}`));
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(rng() * (ids.length - i));
    const tmp = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = tmp;
  }
  return ids.slice(0, take).sort((a, b) => a - b);
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
  const sizes = allocateSampleSizes(
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

/** mulberry32 PRNG（32 位，确定性） */
function mulberry32(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串种子 → 32 位整数（cyrb53 简化版） */
function hashSeed(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return (h1 ^ (h2 >>> 16)) >>> 0;
}

/**
 * 确定性抽样通用工具（T08 自 src/dataset/defects4j/sampling.ts 提取，
 * 行为逐字节保持不变——defects4j 的 golden 清单测试守护等价性）。
 *
 * 供 defects4j / vul4j / msb-java 三源清单构造共用：
 * - mulberry32 + hashSeed：字符串种子 → 确定性 PRNG；
 * - sampleDeterministic：部分 Fisher–Yates 洗牌取前 k 项（同种子必得同结果）；
 * - allocateSampleSizes：分层比例名额分配（最大余数法 + 保底 + 上限）。
 * 纯函数，零 IO、零网络。
 */

/** mulberry32 PRNG（32 位，确定性） */
export function mulberry32(seedValue: number): () => number {
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
export function hashSeed(text: string): number {
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

/**
 * 层内确定性抽样：部分 Fisher–Yates 洗牌取前 k 个元素（保持洗牌后顺序，
 * 不额外排序——排序语义由调用方决定，如 defects4j 按数字升序）。
 * k ≤ 0 或空池返回空数组；k 超过池大小时全量返回。
 */
export function sampleDeterministic<T>(
  pool: readonly T[],
  k: number,
  seedKey: string,
): T[] {
  if (k <= 0 || pool.length === 0) {
    return [];
  }
  const take = Math.min(k, pool.length);
  const items = [...pool];
  const rng = mulberry32(hashSeed(seedKey));
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(rng() * (items.length - i));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items.slice(0, take);
}

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

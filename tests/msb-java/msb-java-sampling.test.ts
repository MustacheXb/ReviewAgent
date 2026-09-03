import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMsbSamplingManifest,
  MSB_JAVA_DEFAULT_MIN_PER_STRATUM,
  MSB_JAVA_DEFAULT_SEED,
  MSB_JAVA_DEFAULT_TARGET,
  type MsbPoolEntry,
  type MsbSamplingManifest,
} from "../../src/dataset/msb-java/sampling.js";
import { DEFAULT_MR_BOUNDARY } from "../../src/dataset/mr-boundary-filter.js";

type EntryOverrides = Partial<Omit<MsbPoolEntry, "instanceId" | "org" | "repo">>;

function poolEntry(instanceId: string, org: string, repo: string, overrides: EntryOverrides = {}): MsbPoolEntry {
  const base: MsbPoolEntry = {
    instanceId,
    org,
    repo,
    number: 1,
    status: "eligible",
    files: 2,
    changedLines: 40,
    rejectReason: null,
  };
  const derivedNumber = Number(instanceId.split("-").at(-1));
  const withNumber = Number.isFinite(derivedNumber) && derivedNumber >= 1
    ? { ...base, number: derivedNumber }
    : base;
  return { ...withNumber, ...overrides };
}

/** 4 个仓库层，规模 [8,6,4,2]，共 20 条 */
function stratifiedPool(): MsbPoolEntry[] {
  const repos: readonly [string, string, number][] = [
    ["fasterxml", "jackson-databind", 8],
    ["elastic", "logstash", 6],
    ["google", "gson", 4],
    ["apache", "dubbo", 2],
  ];
  const pool: MsbPoolEntry[] = [];
  for (const [org, repo, count] of repos) {
    for (let i = 1; i <= count; i += 1) {
      pool.push(poolEntry(`${org}__${repo}-${i}`, org, repo));
    }
  }
  return pool;
}

describe("buildMsbSamplingManifest（确定性分层抽样）", () => {
  it("同 seed 同池必得同清单；与池输入顺序无关", () => {
    const pool = stratifiedPool();
    const first = buildMsbSamplingManifest(pool, { targetTotal: 9 });
    const second = buildMsbSamplingManifest([...pool].reverse(), { targetTotal: 9 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toEqual(first.value);
      const third = buildMsbSamplingManifest(pool, { targetTotal: 9 });
      expect(third.ok).toBe(true);
      if (third.ok) {
        expect(third.value).toEqual(first.value);
      }
    }
  });

  it("不同 seed 产生不同抽样（目标小于池规模时）", () => {
    const pool = Array.from({ length: 20 }, (_, i) => poolEntry(`google__gson-${i + 1}`, "google", "gson"));
    const a = buildMsbSamplingManifest(pool, { targetTotal: 6, seed: "seed-1" });
    const b = buildMsbSamplingManifest(pool, { targetTotal: 6, seed: "seed-2" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.sampled).not.toEqual(b.value.sampled);
    }
  });

  it("仓库分层保底：每个出现的仓库至少 1 条；超界条目拒绝留痕", () => {
    const pool = [
      ...stratifiedPool(),
      poolEntry("elastic__logstash-9000", "elastic", "logstash", {
        status: "rejected",
        rejectReason: "too-many-files",
        files: 48,
        changedLines: 3358,
      }),
      poolEntry("google__gson-9001", "google", "gson", {
        status: "rejected",
        rejectReason: "diff-too-large",
        files: 3,
        changedLines: 2500,
      }),
    ];
    const manifest = buildMsbSamplingManifest(pool, { targetTotal: 8 });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) {
      return;
    }
    const sampledRepos = new Set(manifest.value.sampled.map((e) => `${e.org}/${e.repo}`));
    expect(sampledRepos).toEqual(new Set(["fasterxml/jackson-databind", "elastic/logstash", "google/gson", "apache/dubbo"]));
    expect(manifest.value.sampled.every((e) => e.status === "eligible")).toBe(true);
    expect(manifest.value.rejectedByReason).toEqual({ "too-many-files": 1, "diff-too-large": 1 });
    expect(manifest.value.poolTotal).toBe(22);
    expect(manifest.value.eligibleCount).toBe(20);
    expect(manifest.value.rejectedCount).toBe(2);
  });

  it("sampled 按 instanceId 字典序", () => {
    const manifest = buildMsbSamplingManifest(stratifiedPool(), { targetTotal: 4 });
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      const ids = manifest.value.sampled.map((e) => e.instanceId);
      expect([...ids].sort()).toEqual(ids);
    }
  });

  it("池条目自检：instanceId 重复 / eligible 缺指标 / rejected 缺原因 / 指标在界内却标 rejected → 显式报错", () => {
    const dup = buildMsbSamplingManifest([
      poolEntry("a__r-1", "a", "r"),
      poolEntry("a__r-1", "a", "r"),
    ]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error.code).toBe("INVALID_POOL_ENTRY");
    }

    const missingMetrics = buildMsbSamplingManifest([poolEntry("a__r-1", "a", "r", { files: null, changedLines: null })]);
    expect(missingMetrics.ok).toBe(false);

    const rejectedNoReason = buildMsbSamplingManifest([
      poolEntry("a__r-1", "a", "r", { status: "rejected", rejectReason: null }),
    ]);
    expect(rejectedNoReason.ok).toBe(false);

    const inconsistent = buildMsbSamplingManifest([
      poolEntry("a__r-1", "a", "r", { status: "rejected", rejectReason: "too-many-files", files: 2, changedLines: 40 }),
    ]);
    expect(inconsistent.ok).toBe(false);
    if (!inconsistent.ok) {
      expect(inconsistent.error.message).toContain("指标与结论不一致");
    }
  });
});

describe("已提交的抽样清单（golden + 实测核验结论）", () => {
  const manifestPath = resolve(process.cwd(), "data/msb-java/sampling-manifest.json");
  const committed = JSON.parse(readFileSync(manifestPath, "utf8")) as MsbSamplingManifest;

  it("data/msb-java/sampling-manifest.json 等于 buildMsbSamplingManifest(pool) 输出（可复算）", () => {
    const rebuilt = buildMsbSamplingManifest(committed.pool);
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) {
      expect(rebuilt.value).toEqual(committed);
    }
  });

  it("实测核验结论留痕：池 128（java/ 9 文件全量），合格 124 / 拒绝 4（全部 too-many-files），抽样 30", () => {
    expect(committed.seed).toBe(MSB_JAVA_DEFAULT_SEED);
    expect(committed.targetTotal).toBe(MSB_JAVA_DEFAULT_TARGET);
    expect(committed.minPerStratum).toBe(MSB_JAVA_DEFAULT_MIN_PER_STRATUM);
    expect(committed.boundary).toEqual(DEFAULT_MR_BOUNDARY);
    expect(committed.poolTotal).toBe(128);
    expect(committed.eligibleCount).toBe(124);
    expect(committed.rejectedCount).toBe(4);
    expect(committed.rejectedByReason).toEqual({ "too-many-files": 4 });
    expect(committed.total).toBe(30);
  });

  it("抽样条目全部 eligible 且满足 MR 边界（≤10 文件 / ≤2000 变更行）", () => {
    for (const entry of committed.sampled) {
      expect(entry.status).toBe("eligible");
      expect(entry.files).toBeLessThanOrEqual(DEFAULT_MR_BOUNDARY.maxFiles);
      expect(entry.changedLines).toBeLessThanOrEqual(DEFAULT_MR_BOUNDARY.maxDiffLines);
    }
  });

  it("仓库覆盖：9 个 GitHub 仓库全部出现在抽样中（每层保底 1）", () => {
    const sampledRepos = new Set(committed.sampled.map((e) => `${e.org}/${e.repo}`));
    expect(sampledRepos.size).toBe(9);
    const poolRepos = new Set(committed.pool.map((e) => `${e.org}/${e.repo}`));
    expect(sampledRepos).toEqual(poolRepos);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCweNature } from "../../src/dataset/vul4j/cwe-nature-map.js";
import {
  buildVul4jTargetManifest,
  VUL4J_DEFAULT_MIN_PER_STRATUM,
  VUL4J_DEFAULT_SEED,
  VUL4J_DEFAULT_TARGET,
  type Vul4jPoolEntry,
  type Vul4jTargetManifest,
} from "../../src/dataset/vul4j/sampling.js";
import { DEFAULT_MR_BOUNDARY } from "../../src/dataset/mr-boundary-filter.js";

type EntryOverrides = Partial<Omit<Vul4jPoolEntry, "vulId" | "cweId">>;

function poolEntry(vulId: string, cweId: string, overrides: EntryOverrides = {}): Vul4jPoolEntry {
  const resolution = resolveCweNature(cweId);
  const base: Vul4jPoolEntry = {
    vulId,
    cveId: "CVE-2026-0000",
    cweId,
    cweName: "Sample CWE",
    owaspId: "",
    repoSlug: "example/repo",
    fixCommitUrl: `https://github.com/example/repo/commit/${"a".repeat(40)}`,
    fixSha: "a".repeat(40),
    fetchStatus: "ok",
    parseStatus: "ok",
    excludedTestFiles: [],
    excludedBinaryFiles: [],
    files: 2,
    changedLines: 30,
    nature: resolution.nature,
    natureMatched: resolution.matched,
    status: "eligible",
    rejectReason: null,
  };
  return { ...base, ...overrides };
}

/** 6 个 CWE 层，规模 [8,6,4,3,2,1]，共 24 条 */
function stratifiedPool(): Vul4jPoolEntry[] {
  const sizes: readonly [string, number][] = [
    ["CWE-79", 8],
    ["CWE-20", 6],
    ["CWE-611", 4],
    ["CWE-502", 3],
    ["CWE-835", 2],
    ["CWE-19", 1],
  ];
  const pool: Vul4jPoolEntry[] = [];
  let id = 1;
  for (const [cweId, count] of sizes) {
    for (let i = 0; i < count; i += 1) {
      pool.push(poolEntry(`VUL4J-${id}`, cweId));
      id += 1;
    }
  }
  return pool;
}

describe("buildVul4jTargetManifest（确定性分层抽样）", () => {
  it("同 seed 同池必得同清单；与池输入顺序无关", () => {
    const pool = stratifiedPool();
    const first = buildVul4jTargetManifest(pool, { targetTotal: 10 });
    const second = buildVul4jTargetManifest([...pool].reverse(), { targetTotal: 10 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toEqual(first.value);
      const third = buildVul4jTargetManifest(pool, { targetTotal: 10 });
      expect(third.ok).toBe(true);
      if (third.ok) {
        expect(third.value).toEqual(first.value);
      }
    }
  });

  it("不同 seed 产生不同抽样（目标小于池规模时 seed 决定层内选择）", () => {
    const pool = Array.from({ length: 24 }, (_, i) => poolEntry(`VUL4J-${i + 1}`, "CWE-79"));
    const a = buildVul4jTargetManifest(pool, { targetTotal: 8, seed: "seed-1" });
    const b = buildVul4jTargetManifest(pool, { targetTotal: 8, seed: "seed-2" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.sampled).not.toEqual(b.value.sampled);
    }
  });

  it("CWE 分层保底：每个出现的 CWE 层至少 1 条（漏洞类型全覆盖）", () => {
    const manifest = buildVul4jTargetManifest(stratifiedPool(), { targetTotal: 10 });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) {
      return;
    }
    const sampledCwes = new Set(manifest.value.sampled.map((e) => e.cweId));
    const poolCwes = new Set(manifest.value.pool.filter((e) => e.status === "eligible").map((e) => e.cweId));
    expect(sampledCwes).toEqual(poolCwes);
    expect(manifest.value.total).toBeLessThanOrEqual(10);
  });

  it("rejected 条目不进入抽样，拒绝原因按 reason 汇总留痕", () => {
    const pool = [
      ...stratifiedPool(),
      poolEntry("VUL4J-90", "CWE-79", {
        status: "rejected",
        rejectReason: "patch-unreachable",
        fetchStatus: "unreachable",
        files: null,
        changedLines: null,
      }),
      poolEntry("VUL4J-91", "CWE-835", {
        status: "rejected",
        rejectReason: "too-many-files",
        files: 11,
        changedLines: 3000,
      }),
    ];
    const manifest = buildVul4jTargetManifest(pool, { targetTotal: 10 });
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      expect(manifest.value.sampled.every((e) => e.status === "eligible")).toBe(true);
      expect(manifest.value.sampled.some((e) => e.vulId === "VUL4J-90" || e.vulId === "VUL4J-91")).toBe(false);
      expect(manifest.value.rejectedByReason).toEqual({ "patch-unreachable": 1, "too-many-files": 1 });
      expect(manifest.value.rejectedCount).toBe(2);
    }
  });

  it("sampled 按 vulId 数值序（VUL4J-9 < VUL4J-10 < VUL4J-80-S）", () => {
    const pool = [
      poolEntry("VUL4J-10", "CWE-20"),
      poolEntry("VUL4J-9", "CWE-79"),
      poolEntry("VUL4J-80-S", "CWE-611"),
    ];
    const manifest = buildVul4jTargetManifest(pool, { targetTotal: 3 });
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      expect(manifest.value.sampled.map((e) => e.vulId)).toEqual(["VUL4J-9", "VUL4J-10", "VUL4J-80-S"]);
    }
  });

  it("池条目自检：vulId 重复 / eligible 缺指标 / rejected 缺原因 / nature 与词表不一致 → 显式报错", () => {
    const dup = buildVul4jTargetManifest([poolEntry("VUL4J-1", "CWE-20"), poolEntry("VUL4J-1", "CWE-79")]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error.code).toBe("INVALID_POOL_ENTRY");
    }

    const missingMetrics = buildVul4jTargetManifest([
      poolEntry("VUL4J-1", "CWE-20", { files: null, changedLines: null }),
    ]);
    expect(missingMetrics.ok).toBe(false);
    if (!missingMetrics.ok) {
      expect(missingMetrics.error.code).toBe("INVALID_POOL_ENTRY");
    }

    const rejectedNoReason = buildVul4jTargetManifest([
      poolEntry("VUL4J-1", "CWE-20", { status: "rejected", rejectReason: null }),
    ]);
    expect(rejectedNoReason.ok).toBe(false);

    const natureMismatch = buildVul4jTargetManifest([
      poolEntry("VUL4J-1", "CWE-20", { nature: "CORRECTNESS" }),
    ]);
    expect(natureMismatch.ok).toBe(false);
    if (!natureMismatch.ok) {
      expect(natureMismatch.error.message).toContain("nature");
    }
  });
});

describe("已提交的目标清单（golden + 实测核验结论）", () => {
  const manifestPath = resolve(process.cwd(), "data/vul4j/target-manifest.json");
  const committed = JSON.parse(readFileSync(manifestPath, "utf8")) as Vul4jTargetManifest;

  it("data/vul4j/target-manifest.json 等于 buildVul4jTargetManifest(pool) 输出（可复算）", () => {
    const rebuilt = buildVul4jTargetManifest(committed.pool);
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) {
      expect(rebuilt.value).toEqual(committed);
    }
  });

  it("实测核验结论留痕：池 66（CWE 标注条目），合格 65 / 拒绝 1（VUL4J-23 补丁不可达），抽样 30", () => {
    expect(committed.seed).toBe(VUL4J_DEFAULT_SEED);
    expect(committed.targetTotal).toBe(VUL4J_DEFAULT_TARGET);
    expect(committed.minPerStratum).toBe(VUL4J_DEFAULT_MIN_PER_STRATUM);
    expect(committed.poolTotal).toBe(66);
    expect(committed.eligibleCount).toBe(65);
    expect(committed.rejectedCount).toBe(1);
    expect(committed.rejectedByReason).toEqual({ "patch-unreachable": 1 });
    expect(committed.total).toBe(30);
  });

  it("抽样条目全部 eligible 且满足 MR 边界（≤10 文件 / ≤2000 变更行）", () => {
    for (const entry of committed.sampled) {
      expect(entry.status).toBe("eligible");
      expect(entry.files).toBeLessThanOrEqual(DEFAULT_MR_BOUNDARY.maxFiles);
      expect(entry.changedLines).toBeLessThanOrEqual(DEFAULT_MR_BOUNDARY.maxDiffLines);
      expect(entry.fetchStatus).toBe("ok");
      expect(entry.parseStatus).toBe("ok");
    }
  });

  it("CWE 分层覆盖：抽样覆盖 ≥ 20 个 CWE 层，且含 natureMatched=false 的显式未知条目", () => {
    const sampledCwes = new Set(committed.sampled.map((e) => e.cweId));
    expect(sampledCwes.size).toBeGreaterThanOrEqual(20);
    const unmappedInPool = committed.pool.filter((e) => !e.natureMatched);
    expect(unmappedInPool.length).toBeGreaterThan(0);
    expect(committed.sampled.some((e) => !e.natureMatched)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  allocateSampleSizes,
  buildSamplingManifest,
  contiguousPool,
  DEFAULT_SAMPLING_SEED,
  sampleBugIds,
} from "../src/dataset/defects4j/sampling.js";
import { DEFECTS4J_PROJECTS, totalDefects4jBugs } from "../src/dataset/defects4j/projects.js";

describe("allocateSampleSizes（分层名额分配）", () => {
  it("保底每层至少 minPerStratum，上限不超过层规模", () => {
    const alloc = allocateSampleSizes([176, 4, 26, 9], 30, 3);
    expect(alloc.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(30);
    expect(alloc[1]).toBeGreaterThanOrEqual(Math.min(3, 4));
    expect(alloc[3]).toBeLessThanOrEqual(9);
  });

  it("容量充足时名额总和恰等于目标", () => {
    const alloc = allocateSampleSizes(DEFECTS4J_PROJECTS.map((p) => p.bugCount), 100, 3);
    expect(alloc.reduce((s, v) => s + v, 0)).toBe(100);
  });

  it("名额与项目规模正相关（大项目名额多于小项目）", () => {
    const alloc = allocateSampleSizes(DEFECTS4J_PROJECTS.map((p) => p.bugCount), 100, 3);
    const closure = alloc[DEFECTS4J_PROJECTS.findIndex((p) => p.key === "Closure")]!;
    const jacksonXml = alloc[DEFECTS4J_PROJECTS.findIndex((p) => p.key === "JacksonXml")]!;
    expect(closure).toBeGreaterThan(jacksonXml);
  });

  it("目标小于保底总额时退化为纯比例分配（总额不超目标）", () => {
    const alloc = allocateSampleSizes([50, 50, 50], 2, 3);
    expect(alloc.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(2);
  });

  it("非法层规模抛出显式错误", () => {
    expect(() => allocateSampleSizes([10, -1], 5, 3)).toThrow(RangeError);
  });
});

describe("sampleBugIds（层内确定性抽样）", () => {
  it("同种子结果可复现，不同种子结果不同", () => {
    const a = sampleBugIds("Lang", contiguousPool(61), 5, "seed-1");
    const aAgain = sampleBugIds("Lang", contiguousPool(61), 5, "seed-1");
    const b = sampleBugIds("Lang", contiguousPool(61), 5, "seed-2");
    expect(a).toEqual(aAgain);
    expect(a).not.toEqual(b);
  });

  it("ID 不重复、升序、都在池内", () => {
    const pool = [3, 7, 12, 40, 41, 55, 60, 61];
    const ids = sampleBugIds("Lang", pool, 6, "seed-1");
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    for (const id of ids) {
      expect(pool).toContain(id);
    }
  });

  it("k 超过池大小时全量返回", () => {
    expect(sampleBugIds("JacksonXml", contiguousPool(6), 10, "seed-1")).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("buildSamplingManifest（~100 条目标清单）", () => {
  const manifest = buildSamplingManifest();

  it("验收 5：产出 17 项目分层抽样清单，总数恰 100", () => {
    expect(manifest.projects).toHaveLength(17);
    expect(manifest.total).toBe(100);
    expect(manifest.projects.every((p) => p.sampledBugIds.length >= 3 || p.bugCount < 3)).toBe(true);
  });

  it("每个项目的抽样不超过其 bug 总数且 ID 合法", () => {
    for (const p of manifest.projects) {
      expect(p.sampledBugIds.length).toBeLessThanOrEqual(p.bugCount);
      for (const id of p.sampledBugIds) {
        expect(id).toBeGreaterThanOrEqual(1);
        expect(id).toBeLessThanOrEqual(p.bugCount);
      }
    }
  });

  it("清单确定性：同参数重建完全一致", () => {
    expect(buildSamplingManifest()).toEqual(manifest);
  });

  it("项目 active bug 总数已核实（v3.0.1，854 条），ID 池按连续假设待 T12 校准", () => {
    expect(manifest.bugCountsVerified).toBe(true);
    expect(manifest.bugIdPoolsVerified).toBe(false);
    expect(manifest.seed).toBe(DEFAULT_SAMPLING_SEED);
    expect(totalDefects4jBugs()).toBe(854);
  });

  it("传入实际 active ID 集（active-bugs.csv）时按池抽样且池校准标记为真", () => {
    const activeIds = { Lang: [1, 2, 3, 5, 6, 7, 9, 10, 12, 13, 15, 16] };
    const withPools = buildSamplingManifest(
      DEFECTS4J_PROJECTS,
      100,
      DEFAULT_SAMPLING_SEED,
      3,
      activeIds,
    );
    expect(withPools.bugIdPoolsVerified).toBe(true);
    const lang = withPools.projects.find((p) => p.project === "Lang")!;
    expect(lang.sampledBugIds.length).toBeLessThanOrEqual(12);
    for (const id of lang.sampledBugIds) {
      expect(activeIds.Lang).toContain(id);
    }
  });
});

describe("已提交的清单文件与生成器同步（golden）", () => {
  it("data/defects4j/sampling-manifest.json 等于 buildSamplingManifest() 输出", () => {
    const path = resolve(process.cwd(), "data/defects4j/sampling-manifest.json");
    const committed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(committed).toEqual(buildSamplingManifest());
  });
});

describe("DEFECTS4J_PROJECTS", () => {
  it("17 个项目，合计 854 active bugs（v3.0.1 已核实）", () => {
    expect(DEFECTS4J_PROJECTS).toHaveLength(17);
    expect(totalDefects4jBugs()).toBe(854);
  });
});

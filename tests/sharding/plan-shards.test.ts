import { describe, expect, it } from "vitest";
import type { MRCase } from "../../src/contracts/mr-case.js";
import { DEFAULT_MR_BOUNDARY, measureDiffBoundary } from "../../src/dataset/mr-boundary-filter.js";
import { parseUnifiedDiff } from "../../src/dataset/diff/parse-unified-diff.js";
import { fileBlock } from "../helpers/diff-blocks.js";
import { DEFAULT_SHARD_CONFIG, planShards } from "../../src/sharding/plan-shards.js";

function makeCase(caseId: string, diff: string, truth: MRCase["truth"] = null): MRCase {
  return {
    caseId,
    repoPath: "D:/repos/x",
    diff,
    issueDescription: "issue text",
    truth,
    labels: { source: "vul4j", riskClass: "Medium", allowedConfigs: ["A", "B", "C", "D", "E"] },
  };
}

describe("planShards（触发判定）", () => {
  it("域内 MRCase（10 文件、共 1000 行，双维均远离上限）：不切分（直通）", () => {
    const diff = Array.from({ length: 10 }, (_, i) => fileBlock(`src/F${i}.java`, 100)).join("");
    const result = planShards(makeCase("in-domain", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sharded).toBe(false);
    expect(result.value.shards).toEqual([]);
    expect(result.value.reason).toBeNull();
    expect(result.value.boundary).toEqual(DEFAULT_MR_BOUNDARY);
  });

  it("边界端点：恰 10 文件且恰 2000 变更行：直通（双维含端点）", () => {
    const diff = Array.from({ length: 10 }, (_, i) => fileBlock(`src/F${i}.java`, 200)).join("");
    const result = planShards(makeCase("at-boundary", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sharded).toBe(false);
  });

  it("文件数超界（11 文件、行数不超）：触发切分，reason = files", () => {
    const diff = Array.from({ length: 11 }, (_, i) => fileBlock(`src/F${i}.java`, 10)).join("");
    const result = planShards(makeCase("over-files", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sharded).toBe(true);
    expect(result.value.reason).toBe("files");
  });

  it("行数超界（≤10 文件、2001 行）：触发切分，reason = lines", () => {
    const diff = Array.from({ length: 5 }, (_, i) => fileBlock(`src/F${i}.java`, 400)).join("")
      + fileBlock("src/Big.java", 1);
    // 5 × 400 + 1 = 2001 行、6 文件
    const result = planShards(makeCase("over-lines", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sharded).toBe(true);
    expect(result.value.reason).toBe("lines");
  });

  it("双维同超：reason 取首个超界维度 files", () => {
    const diff = Array.from({ length: 11 }, (_, i) => fileBlock(`src/F${i}.java`, 300)).join("");
    // 11 文件（> 10）且 3300 行（> 2000）
    const result = planShards(makeCase("over-both", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sharded).toBe(true);
    expect(result.value.reason).toBe("files");
  });

  it("自定义边界配置生效（小边界便于测试）", () => {
    const diff = Array.from({ length: 3 }, (_, i) => fileBlock(`src/F${i}.java`, 10)).join("");
    const result = planShards(makeCase("custom-boundary", diff), {
      boundary: { maxFiles: 2, maxDiffLines: 100 },
      maxShards: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sharded).toBe(true);
    expect(result.value.reason).toBe("files");
  });

  it("非法配置（maxFiles < 1）：可区分拒绝", () => {
    const result = planShards(makeCase("bad-config", fileBlock("src/A.java", 1)), {
      boundary: { maxFiles: 0, maxDiffLines: 100 },
      maxShards: 20,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SHARD_CONFIG_INVALID");
  });

  it("非法 diff：MALFORMED_DIFF 拒绝", () => {
    const result = planShards(makeCase("bad-diff", "not a diff"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MALFORMED_DIFF");
  });
});

describe("planShards（包亲和贪心装箱）", () => {
  it("同目录文件优先同片：9 文件 src/a + 2 文件 src/b → a、b 各自成片（组不拆散）", () => {
    const aFiles = Array.from({ length: 9 }, (_, i) => fileBlock(`src/a/F${i}.java`, 3));
    const bFiles = Array.from({ length: 2 }, (_, i) => fileBlock(`src/b/G${i}.java`, 3));
    const result = planShards(makeCase("affinity-9-2", [...aFiles, ...bFiles].join("")));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards } = result.value;
    expect(shards).toHaveLength(2);
    expect(shards[0]?.filePaths).toEqual(
      Array.from({ length: 9 }, (_, i) => `src/a/F${i}.java`),
    );
    expect(shards[1]?.filePaths).toEqual(["src/b/G0.java", "src/b/G1.java"]);
  });

  it("目录交错出现仍按目录分组：同目录文件跨位置落同片", () => {
    // 出现序：b1, a1, b2, a2, b3, a3（b 组首现先于 a 组）
    const order = ["b/F1", "a/F1", "b/F2", "a/F2", "b/F3", "a/F3"];
    const diff = order.map((p) => fileBlock(`src/${p}.java`, 1)).join("");
    const result = planShards(makeCase("interleaved", diff), {
      boundary: { maxFiles: 3, maxDiffLines: 100 },
      maxShards: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards } = result.value;
    expect(shards).toHaveLength(2);
    expect(shards[0]?.filePaths).toEqual(["src/b/F1.java", "src/b/F2.java", "src/b/F3.java"]);
    expect(shards[1]?.filePaths).toEqual(["src/a/F1.java", "src/a/F2.java", "src/a/F3.java"]);
  });

  it("当前片装不下整组时开新片，后续小组可回填当前片（贪心装填）", () => {
    // 出现序交错：a1, b1, a2, c1, a3, b2, c2；maxFiles=4
    // a 组（3 文件）→ 片1；b 组（2 文件）装不下片1 → 片2；c 组（2 文件）回填片2
    const order = ["a/F1", "b/F1", "a/F2", "c/F1", "a/F3", "b/F2", "c/F2"];
    const diff = order.map((p) => fileBlock(`src/${p}.java`, 1)).join("");
    const result = planShards(makeCase("greedy-refill", diff), {
      boundary: { maxFiles: 4, maxDiffLines: 100 },
      maxShards: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards } = result.value;
    expect(shards).toHaveLength(2);
    expect(shards[0]?.filePaths).toEqual(["src/a/F1.java", "src/a/F2.java", "src/a/F3.java"]);
    expect(shards[1]?.filePaths).toEqual(["src/b/F1.java", "src/b/F2.java", "src/c/F1.java", "src/c/F2.java"]);
  });

  it("组自身超界（文件数维）：同目录组内顺序填满至域内上限", () => {
    const diff = Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    const result = planShards(makeCase("oversized-group-files", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards } = result.value;
    expect(shards.map((s) => s.files)).toEqual([10, 10, 5]);
    expect(shards.every((s) => s.filePaths.every((p) => p.startsWith("src/pkg/")))).toBe(true);
  });

  it("组自身超界（行数维）：同目录 3 文件各 900 行 → 片1 装满 1800 行、片2 剩 1 文件", () => {
    const diff = Array.from({ length: 3 }, (_, i) => fileBlock(`src/pkg/L${i}.java`, 900)).join("");
    const result = planShards(makeCase("oversized-group-lines", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards } = result.value;
    expect(shards).toHaveLength(2);
    expect(shards[0]?.filePaths).toEqual(["src/pkg/L0.java", "src/pkg/L1.java"]);
    expect(shards[0]?.diffLines).toBe(1800);
    expect(shards[1]?.filePaths).toEqual(["src/pkg/L2.java"]);
    expect(shards[1]?.diffLines).toBe(900);
  });

  it("装箱边界值：片行数恰达上限装入，再 +1 行开新片", () => {
    const diff = [
      fileBlock("src/a/F1.java", 60),
      fileBlock("src/a/F2.java", 40),
      fileBlock("src/b/G1.java", 1),
    ].join("");
    const result = planShards(makeCase("exact-fit", diff), {
      boundary: { maxFiles: 10, maxDiffLines: 100 },
      maxShards: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards } = result.value;
    expect(shards).toHaveLength(2);
    expect(shards[0]?.diffLines).toBe(100);
    expect(shards[0]?.files).toBe(2);
    expect(shards[1]?.diffLines).toBe(1);
  });

  it("不变量：每片严格落回验证域内（measureDiffBoundary 独立复核）且文件不丢不重", () => {
    // 25 文件、5 个目录、行数 50–350 交错，总行数 5000（双维超界）
    const paths: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      paths.push(`src/pkg${i % 5}/F${i}.java`);
    }
    const diff = paths.map((p, i) => fileBlock(p, 50 + (i * 13) % 300)).join("");
    const result = planShards(makeCase("invariants", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards, boundary } = result.value;
    expect(shards.length).toBeGreaterThan(1);
    const allPaths: string[] = [];
    for (const shard of shards) {
      expect(shard.files).toBeLessThanOrEqual(boundary.maxFiles);
      expect(shard.diffLines).toBeLessThanOrEqual(boundary.maxDiffLines);
      // 口径恒等：对片 diff 独立度量与元数据一致
      const metrics = measureDiffBoundary(shard.diff);
      expect(metrics.ok).toBe(true);
      if (metrics.ok) {
        expect(metrics.value.files).toBe(shard.files);
        expect(metrics.value.changedLines).toBe(shard.diffLines);
      }
      allPaths.push(...shard.filePaths);
    }
    // 不丢不重：分片文件并集 = 原 diff 文件集合
    expect([...allPaths].sort()).toEqual([...paths].sort());
  });
});

describe("planShards（单文件自身超界）", () => {
  it("唯一文件 diff 超界：单片执行 + outOfDomain 标注，不拒绝", () => {
    const result = planShards(makeCase("single-oversized", fileBlock("src/Huge.java", 2500)));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { sharded, reason, shards } = result.value;
    expect(sharded).toBe(true);
    expect(reason).toBe("lines");
    expect(shards).toHaveLength(1);
    expect(shards[0]?.outOfDomain).toBe(true);
    expect(shards[0]?.files).toBe(1);
    expect(shards[0]?.diffLines).toBe(2500);
    expect(shards[0]?.filePaths).toEqual(["src/Huge.java"]);
  });

  it("超界单文件不参与装箱：同目录正常文件仍聚片，outOfDomain 片追加末尾", () => {
    const diff = [
      fileBlock("src/big/Huge.java", 2500),
      fileBlock("src/x/N1.java", 100),
      fileBlock("src/x/N2.java", 100),
    ].join("");
    const result = planShards(makeCase("mixed-oversized", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards } = result.value;
    expect(shards).toHaveLength(2);
    expect(shards[0]).toMatchObject({
      files: 2,
      diffLines: 200,
      outOfDomain: false,
      filePaths: ["src/x/N1.java", "src/x/N2.java"],
    });
    expect(shards[1]).toMatchObject({
      files: 1,
      diffLines: 2500,
      outOfDomain: true,
      filePaths: ["src/big/Huge.java"],
    });
  });

  it("同目录内混入超界单文件：其余同目录文件聚片不受干扰", () => {
    const diff = [
      fileBlock("src/mix/A.java", 100),
      fileBlock("src/mix/B.java", 2500),
      fileBlock("src/mix/C.java", 100),
    ].join("");
    const result = planShards(makeCase("oversized-inside-group", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards } = result.value;
    expect(shards).toHaveLength(2);
    expect(shards[0]?.filePaths).toEqual(["src/mix/A.java", "src/mix/C.java"]);
    expect(shards[0]?.outOfDomain).toBe(false);
    expect(shards[1]?.filePaths).toEqual(["src/mix/B.java"]);
    expect(shards[1]?.outOfDomain).toBe(true);
  });

  it("全部文件超界：全部单片 outOfDomain（仍不拒绝）", () => {
    const diff = [fileBlock("src/B1.java", 2100), fileBlock("src/B2.java", 2200)].join("");
    const result = planShards(makeCase("all-oversized", diff));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.shards).toHaveLength(2);
    expect(result.value.shards.every((s) => s.outOfDomain)).toBe(true);
  });
});

describe("planShards（分片数超上限拒绝）", () => {
  it("所需分片数超上限：SHARD_LIMIT_EXCEEDED，错误消息含所需片数与上限", () => {
    const diff = Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    const result = planShards(makeCase("over-shard-limit", diff), {
      boundary: { maxFiles: 10, maxDiffLines: 2000 },
      maxShards: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SHARD_LIMIT_EXCEEDED");
    expect(result.error.message).toContain("所需分片数 3");
    expect(result.error.message).toContain("上限 2");
  });

  it("所需分片数恰等于上限：不拒绝（边界含端点）", () => {
    const diff = Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    const result = planShards(makeCase("at-shard-limit", diff), {
      boundary: { maxFiles: 10, maxDiffLines: 2000 },
      maxShards: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.shards).toHaveLength(3);
  });

  it("outOfDomain 片计入分片数（每片一次管线运行）", () => {
    const diff = [
      ...Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)),
      fileBlock("src/Huge.java", 2500),
    ].join("");
    // 25 同目录文件 → 3 片；Huge → 1 片 outOfDomain；共 4 片 > 3
    const result = planShards(makeCase("ood-counts", diff), {
      boundary: { maxFiles: 10, maxDiffLines: 2000 },
      maxShards: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SHARD_LIMIT_EXCEEDED");
    expect(result.error.message).toContain("所需分片数 4");
  });

  it("单片 outOfDomain 不因上限 1 被拒绝", () => {
    const result = planShards(makeCase("single-at-limit", fileBlock("src/Huge.java", 2500)), {
      boundary: { maxFiles: 10, maxDiffLines: 2000 },
      maxShards: 1,
    });
    expect(result.ok).toBe(true);
  });
});

describe("planShards（分片元数据与派生 MRCase）", () => {
  function sharded25() {
    const diff = Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    return planShards(makeCase("meta-25", diff));
  }

  it("shardId 派生规则：<caseId>#shard-NNN 连续编号（001 起）", () => {
    const result = sharded25();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.shards.map((s) => s.shardId)).toEqual([
      "meta-25#shard-001",
      "meta-25#shard-002",
      "meta-25#shard-003",
    ]);
  });

  it("缺省配置：验证域边界 10/2000、分片数上限 20", () => {
    expect(DEFAULT_SHARD_CONFIG.boundary).toEqual(DEFAULT_MR_BOUNDARY);
    expect(DEFAULT_SHARD_CONFIG.maxShards).toBe(20);
  });

  it("派生 MRCase：caseId = shardId、diff = 子 diff、repoPath/issue/labels/extensions 原样", () => {
    const diff = Array.from({ length: 3 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    const mrCase = makeCase("derive", diff);
    const withExtensions: MRCase = {
      ...mrCase,
      extensions: { cveId: "CVE-2026-0001" },
    };
    const result = planShards(withExtensions, {
      boundary: { maxFiles: 2, maxDiffLines: 2000 },
      maxShards: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const shard = result.value.shards[0]!;
    expect(shard.mrCase.caseId).toBe(shard.shardId);
    expect(shard.mrCase.diff).toBe(shard.diff);
    expect(shard.mrCase.diff).not.toBe(withExtensions.diff);
    expect(shard.mrCase.repoPath).toBe(withExtensions.repoPath);
    expect(shard.mrCase.issueDescription).toBe(withExtensions.issueDescription);
    expect(shard.mrCase.labels).toEqual(withExtensions.labels);
    expect(shard.mrCase.extensions).toEqual({ cveId: "CVE-2026-0001" });
    // clean MR（truth null）保持 null
    expect(shard.mrCase.truth).toBeNull();
  });

  it("truth 片内过滤：locations 与 fixPatch 过滤到片内文件；无真值文件的片 → truth null", () => {
    const diff = [
      fileBlock("src/a/X.java", 3),
      fileBlock("src/b/Y.java", 3),
      fileBlock("src/c/Z.java", 3),
    ].join("");
    const truth = {
      locations: [
        { file: "src/a/X.java", lineStart: 2, lineEnd: 2, defectNature: "NULL_DEREF" },
        { file: "src/b/Y.java", lineStart: 3, lineEnd: 4, defectNature: "RESOURCE_LEAK" },
      ],
      fixPatch: [fileBlock("src/a/X.java", 1), fileBlock("src/b/Y.java", 1)].join(""),
    };
    const result = planShards(makeCase("truth-split", diff, truth), {
      boundary: { maxFiles: 1, maxDiffLines: 2000 },
      maxShards: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { shards } = result.value;
    expect(shards).toHaveLength(3);
    expect(shards[0]?.mrCase.truth).toEqual({
      locations: [
        { file: "src/a/X.java", lineStart: 2, lineEnd: 2, defectNature: "NULL_DEREF" },
      ],
      fixPatch: fileBlock("src/a/X.java", 1),
    });
    expect(shards[1]?.mrCase.truth).toEqual({
      locations: [
        { file: "src/b/Y.java", lineStart: 3, lineEnd: 4, defectNature: "RESOURCE_LEAK" },
      ],
      fixPatch: fileBlock("src/b/Y.java", 1),
    });
    // Z 无真值 → 该片 truth null（兼容运行输入校验的非空约束）
    expect(shards[2]?.mrCase.truth).toBeNull();
  });

  it("truth.fixPatch 无法解析：INVALID_FIX_PATCH 拒绝", () => {
    const diff = [
      fileBlock("src/a/X.java", 3),
      fileBlock("src/b/Y.java", 3),
    ].join("");
    const truth = {
      locations: [{ file: "src/a/X.java", lineStart: 2, lineEnd: 2, defectNature: "NULL_DEREF" }],
      fixPatch: "garbage patch",
    };
    const result = planShards(makeCase("bad-fixpatch", diff, truth), {
      boundary: { maxFiles: 1, maxDiffLines: 2000 },
      maxShards: 20,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("INVALID_FIX_PATCH");
  });

  it("片 diff 可独立解析且文件集与元数据一致", () => {
    const result = sharded25();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    for (const shard of result.value.shards) {
      const parsed = parseUnifiedDiff(shard.diff);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      expect(parsed.value.map((f) => f.newPath ?? f.oldPath)).toEqual(shard.filePaths);
    }
  });

  it("确定性：同输入两次调用分片结果完全相同", () => {
    const first = sharded25();
    const second = sharded25();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("纯函数：不修改输入 MRCase", () => {
    const diff = Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    const mrCase = makeCase("purity", diff);
    const before = JSON.stringify(mrCase);
    planShards(mrCase);
    expect(JSON.stringify(mrCase)).toBe(before);
  });
});

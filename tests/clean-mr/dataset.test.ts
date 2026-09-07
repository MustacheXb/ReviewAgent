import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCleanMrManifest, cleanMrCasesFromManifest } from "../../src/dataset/clean-mr/manifest.js";
import { isNegativeControl } from "../../src/dataset/clean-mr/builder.js";
import { filterMrCases } from "../../src/dataset/mr-boundary-filter.js";
import { MSB_JAVA_REPOS, isMsbJavaRepo } from "../../src/dataset/clean-mr/repos.js";

/**
 * 已入库数据集（data/clean-mr/）完整性回归（零网络，读本地交付物）。
 * 数据集刷新（重跑采集脚本）后本测试同步约束其形状与口径不回退。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = resolve(repoRoot, "data/clean-mr");

function loadDataset() {
  const raw = JSON.parse(readFileSync(resolve(dataDir, "manifest.json"), "utf8"));
  const validated = validateCleanMrManifest(raw);
  if (!validated.ok) {
    throw new Error(`manifest 校验失败: ${validated.error.message}`);
  }
  return validated.value;
}

describe("clean MR 数据集（已入库交付物）", () => {
  const manifest = loadDataset();

  it("规模 ~50 条（45–60 容差），仓库来自 MSB Java 同 9 仓清单", () => {
    expect(manifest.total).toBe(manifest.cases.length);
    expect(manifest.total).toBeGreaterThanOrEqual(45);
    expect(manifest.total).toBeLessThanOrEqual(60);
    for (const c of manifest.cases) {
      expect(isMsbJavaRepo(c.org, c.repo)).toBe(true);
    }
    expect(MSB_JAVA_REPOS).toHaveLength(9);
  });

  it("全部案例：truth=null 阴性对照、clean-mr 来源、A 与 C 均可跑、issueDescription 空", () => {
    const loaded = cleanMrCasesFromManifest(manifest, {
      diffOf: (c) => readFileSync(resolve(dataDir, c.diffFile), "utf8"),
      repoPathOf: (c) => `D:/repos/${c.repo}/${c.baseSha.slice(0, 10)}`,
    });
    if (!loaded.ok) {
      throw new Error(loaded.error.message);
    }
    expect(loaded.value.failures).toEqual([]);
    expect(loaded.value.cases).toHaveLength(manifest.total);
    for (const mrCase of loaded.value.cases) {
      expect(mrCase.truth).toBeNull();
      expect(isNegativeControl(mrCase)).toBe(true);
      expect(mrCase.labels.source).toBe("clean-mr");
      expect(mrCase.issueDescription).toBe("");
      expect(mrCase.labels.allowedConfigs).toContain("A");
      expect(mrCase.labels.allowedConfigs).toContain("C");
    }
  });

  it("全部 diff 与清单 sha256 一致（校验默认开启）且通过 MR 边界过滤（≤10 文件 / ≤2000 行）", () => {
    const loaded = cleanMrCasesFromManifest(manifest, {
      diffOf: (c) => readFileSync(resolve(dataDir, c.diffFile), "utf8"),
      repoPathOf: () => "D:/repos/x",
    });
    if (!loaded.ok) {
      throw new Error(loaded.error.message);
    }
    const { accepted, report } = filterMrCases(loaded.value.cases);
    expect(accepted).toHaveLength(manifest.total);
    expect(report.rejected).toEqual([]);
  });

  it("清单元数据：FP 口径 + A vs C 对比声明 + 规则显式化（工单验收 2/3）", () => {
    expect(manifest.negativeControl.truthPolicy).toBe("none");
    expect(manifest.negativeControl.fpCriteria).toBe("every-finding-counts-as-fp");
    expect(manifest.negativeControl.comparison.dimension).toBe("active-retrieval-vs-diff-only");
    expect(manifest.rules.issueLink).toContain("filter_prs.py");
    expect(manifest.rules.revertedByLaterPr).toContain("revert");
    expect(manifest.target.perRepoQuota).toBeGreaterThan(0);
  });

  it("diff 文件体积有界（单文件 ≤ 128 KB）", () => {
    for (const c of manifest.cases) {
      expect(c.diffBytes).toBeGreaterThan(0);
      expect(c.diffBytes).toBeLessThanOrEqual(128 * 1024);
    }
  });
});

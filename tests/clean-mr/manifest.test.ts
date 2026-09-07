import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  BODY_PREVIEW_MAX_CHARS,
  buildCleanMrManifest,
  cleanMrCasesFromManifest,
  diffFileName,
  validateCleanMrManifest,
  type BuildManifestInput,
  type ManifestCaseInput,
} from "../../src/dataset/clean-mr/manifest.js";
import { isNegativeControl } from "../../src/dataset/clean-mr/builder.js";
import { SAMPLE_JAVA_DIFF, makePullRequest } from "../fixtures/clean-mr.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function caseInput(overrides: Partial<ManifestCaseInput> = {}): ManifestCaseInput {
  const pr = makePullRequest();
  return {
    org: "google",
    repo: "gson",
    number: pr.number,
    title: pr.title,
    body: pr.body,
    htmlUrl: pr.htmlUrl,
    mergedAt: pr.mergedAt as string,
    baseRef: pr.baseRef,
    baseSha: pr.baseSha,
    mergeCommitSha: pr.mergeCommitSha,
    diff: SAMPLE_JAVA_DIFF,
    diffSha256: sha256(SAMPLE_JAVA_DIFF),
    metrics: { files: 1, addedLines: 1, removedLines: 0, changedLines: 1, totalDiffLines: 12 },
    ...overrides,
  };
}

function manifestInput(overrides: Partial<BuildManifestInput> = {}): BuildManifestInput {
  const cases = overrides.cases ?? [caseInput(), caseInput({ number: 102 })];
  return {
    generatedAt: "2026-09-03T00:00:00Z",
    generator: "scripts/collect-clean-mrs.ts (unit-test)",
    targetTotal: 50,
    perRepoQuota: 6,
    scan: "GET /repos/{org}/{repo}/pulls?state=closed&sort=created&direction=desc&per_page=100 (newest first)",
    repoStats:
      overrides.repoStats ??
      [
        {
          org: "google",
          repo: "gson",
          scannedPrs: 10,
          evaluated: 3,
          accepted: cases.length,
          selected: cases.length,
          quota: 6,
          rejectedByReason: {
            "not-merged": 1,
            "issue-linked": 0,
            "revert-pr": 0,
            "reverted-later": 0,
            "dependency-bump": 0,
            "no-java-file": 0,
            "too-many-files": 0,
            "diff-too-large": 0,
            "malformed-diff": 0,
          },
          overflowPrNumbers: [],
          msbInstanceCount: 5,
        },
      ],
    cases,
  };
}

describe("buildCleanMrManifest（清单构造）", () => {
  it("汇总计数、caseId 生成、diff 文件名与校验和", () => {
    const result = buildCleanMrManifest(manifestInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const manifest = result.value;
    expect(manifest.total).toBe(2);
    expect(manifest.source).toBe("clean-mr");
    expect(manifest.cases.map((c) => c.caseId)).toEqual(["clean-google__gson-101", "clean-google__gson-102"]);
    expect(manifest.cases[0]!.diffFile).toBe("diffs/clean-google__gson-101.diff");
    expect(diffFileName("clean-google__gson-101")).toBe("diffs/clean-google__gson-101.diff");
    expect(manifest.cases[0]!.diffSha256).toBe(sha256(SAMPLE_JAVA_DIFF));
    expect(manifest.cases[0]!.diffBytes).toBeGreaterThan(0);
    expect(manifest.repos[0]!.selected).toBe(2);
  });

  it("正文预览截断至上限并标记（完整正文以 html_url 回链为准）", () => {
    const longBody = "x".repeat(BODY_PREVIEW_MAX_CHARS + 500);
    const result = buildCleanMrManifest(manifestInput({ cases: [caseInput({ body: longBody })] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const preview = result.value.cases[0]!.bodyPreview;
      expect(preview.length).toBe(BODY_PREVIEW_MAX_CHARS + "…[truncated 500 chars]".length);
      expect(preview.endsWith("…[truncated 500 chars]")).toBe(true);
    }
  });

  it("bodyPreview 换行归一（CRLF → LF）", () => {
    const result = buildCleanMrManifest(manifestInput({ cases: [caseInput({ body: "a\r\nb" })] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cases[0]!.bodyPreview).toBe("a\nb");
    }
  });

  it("FP 口径与 A vs C 对比元数据（工单验收 2/3）", () => {
    const result = buildCleanMrManifest(manifestInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const nc = result.value.negativeControl;
    expect(nc.truthPolicy).toBe("none");
    expect(nc.fpCriteria).toBe("every-finding-counts-as-fp");
    expect(nc.comparison.dimension).toBe("active-retrieval-vs-diff-only");
    expect(nc.comparison.metric).toBe("false-positive findings per clean MR");
  });

  it("规则文本显式落盘（含 MSB 移植声明与已知差异）", () => {
    const result = buildCleanMrManifest(manifestInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rules.merged).toContain("merged_at");
      expect(result.value.rules.issueLink).toContain("filter_prs.py");
      expect(result.value.rules.issueLinkPort).toContain("ASCII");
      expect(result.value.rules.javaFile).toContain(".java");
    }
  });

  it("一致性校验：selected 合计与 cases 数不符 / caseId 重复 / 仓库不在清单内", () => {
    const mismatch = buildCleanMrManifest(
      manifestInput({ repoStats: manifestInput().repoStats.map((r) => ({ ...r, selected: 3 })) }),
    );
    expect(mismatch.ok).toBe(false);

    const withDup = buildCleanMrManifest(manifestInput({ cases: [caseInput(), caseInput()] }));
    expect(withDup.ok).toBe(false);

    const foreignRepo = buildCleanMrManifest(manifestInput({ cases: [caseInput({ org: "unknown", repo: "repo" })] }));
    expect(foreignRepo.ok).toBe(false);
  });
});

describe("validateCleanMrManifest（消费前边界校验，T12 入口）", () => {
  it("构造产物可通过校验（往返一致）", () => {
    const built = buildCleanMrManifest(manifestInput());
    expect(built.ok).toBe(true);
    if (built.ok) {
      const validated = validateCleanMrManifest(JSON.parse(JSON.stringify(built.value)));
      expect(validated.ok).toBe(true);
    }
  });

  it("结构、口径与计数不符时显式拒绝", () => {
    expect(validateCleanMrManifest(null).ok).toBe(false);
    expect(validateCleanMrManifest({}).ok).toBe(false);

    const built = buildCleanMrManifest(manifestInput());
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const json = () => JSON.parse(JSON.stringify(built.value)) as Record<string, unknown>;

    expect(validateCleanMrManifest({ ...json(), schemaVersion: 99 }).ok).toBe(false);
    expect(validateCleanMrManifest({ ...json(), source: "defects4j" }).ok).toBe(false);
    expect(validateCleanMrManifest({ ...json(), negativeControl: undefined }).ok).toBe(false);
    expect(
      validateCleanMrManifest({
        ...json(),
        negativeControl: { truthPolicy: "none", fpCriteria: "something-else" },
      }).ok,
    ).toBe(false);
    expect(validateCleanMrManifest({ ...json(), total: 99 }).ok).toBe(false);

    const dupId = json();
    (dupId.cases as unknown[])[1] = { ...(dupId.cases as Record<string, unknown>[])[0]! };
    expect(validateCleanMrManifest(dupId).ok).toBe(false);
  });
});

describe("cleanMrCasesFromManifest（清单 → MRCase 批，T12 消费接口）", () => {
  it("注入 diff 读取与仓库路径：逐条构造 truth=null 的 MRCase", () => {
    const built = buildCleanMrManifest(manifestInput());
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const loaded = cleanMrCasesFromManifest(built.value, {
      diffOf: (c) => SAMPLE_JAVA_DIFF,
      repoPathOf: (c) => `D:/repos/${c.repo}/${c.baseSha.slice(0, 8)}`,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.cases).toHaveLength(2);
    expect(loaded.value.failures).toEqual([]);
    for (const mrCase of loaded.value.cases) {
      expect(mrCase.truth).toBeNull();
      expect(isNegativeControl(mrCase)).toBe(true);
      expect(mrCase.labels.source).toBe("clean-mr");
      expect(mrCase.labels.allowedConfigs).toContain("A");
      expect(mrCase.labels.allowedConfigs).toContain("C");
      expect(mrCase.diff).toBe(SAMPLE_JAVA_DIFF);
      expect(mrCase.repoPath).toBe("D:/repos/gson/b3f4ca20");
    }
  });

  it("diff 读取为空 → 失败显式收集；不静默跳过", () => {
    const built = buildCleanMrManifest(manifestInput());
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const loaded = cleanMrCasesFromManifest(built.value, {
      diffOf: (c) => (c.number === 101 ? SAMPLE_JAVA_DIFF : ""),
      repoPathOf: () => "D:/repos/x",
    });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.cases).toHaveLength(1);
      expect(loaded.value.failures).toHaveLength(1);
      expect(loaded.value.failures[0]!.caseId).toBe("clean-google__gson-102");
      expect(loaded.value.failures[0]!.message).toContain("diff 读取为空");
    }
  });

  it("diff 与清单 sha256 不一致（数据损坏）→ 失败；校验可显式关闭", () => {
    // 同形异文的合法 diff：sha256 必不匹配，但关闭校验后仍可解析构造
    const tamperedDiff = SAMPLE_JAVA_DIFF.replace("+    int added = 1;", "+    int added = 2;");
    const built = buildCleanMrManifest(manifestInput());
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const tampered = cleanMrCasesFromManifest(built.value, {
      diffOf: () => tamperedDiff,
      repoPathOf: () => "D:/repos/x",
    });
    expect(tampered.ok).toBe(true);
    if (tampered.ok) {
      expect(tampered.value.cases).toHaveLength(0);
      expect(tampered.value.failures).toHaveLength(2);
      expect(tampered.value.failures[0]!.message).toContain("sha256");
    }
    const skipCheck = cleanMrCasesFromManifest(built.value, {
      diffOf: () => tamperedDiff,
      repoPathOf: () => "D:/repos/x",
      verifyDiffChecksum: false,
    });
    expect(skipCheck.ok).toBe(true);
    if (skipCheck.ok) {
      expect(skipCheck.value.cases).toHaveLength(2);
      expect(skipCheck.value.failures).toEqual([]);
    }
  });

  it("清单未通过校验 → 整体报错", () => {
    const loaded = cleanMrCasesFromManifest({ schemaVersion: 0 } as never, {
      diffOf: () => "",
      repoPathOf: () => "x",
    });
    expect(loaded.ok).toBe(false);
  });
});

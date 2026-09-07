import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLEAN_MR_RULES,
  evaluateCleanMrCandidate,
  selectCleanMrCases,
  type CleanMrRuleConfig,
  type RepoCandidateScan,
} from "../../src/dataset/clean-mr/selection.js";
import {
  makeCandidate,
  makePullRequest,
  javaDiffWithFiles,
  SAMPLE_JAVA_DIFF,
  SAMPLE_POM_DIFF,
  SAMPLE_README_DIFF,
} from "../fixtures/clean-mr.js";

/** 全规则关闭（仅保留基础结构校验）的对照配置 */
const NO_EXTRA_RULES: CleanMrRuleConfig = {
  excludeIssueLinked: false,
  excludeRevertPrs: false,
  excludeRevertedByLaterPr: false,
  excludeDependencyBumps: false,
  requireJavaFile: false,
};

const NO_REVERTED = new Set<number>();

describe("evaluateCleanMrCandidate（规则链评估）", () => {
  it("merged 且无任何命中：通过并携带边界指标", () => {
    const evaluation = evaluateCleanMrCandidate(makeCandidate(), NO_REVERTED);
    expect(evaluation.accepted).toBe(true);
    expect(evaluation.reason).toBeNull();
    expect(evaluation.metrics?.files).toBe(1);
    expect(evaluation.metrics?.changedLines).toBe(1);
  });

  it("未合并（merged_at null）→ not-merged", () => {
    const evaluation = evaluateCleanMrCandidate(
      makeCandidate({ pr: makePullRequest({ mergedAt: null }) }),
      NO_REVERTED,
    );
    expect(evaluation).toMatchObject({ accepted: false, reason: "not-merged" });
  });

  it("issue 关联（MSB 口径）→ issue-linked 且留痕关联编号", () => {
    const candidate = makeCandidate({
      pr: makePullRequest({ title: "Add feature" }),
      commitMessages: ["Fixes #33"],
    });
    const evaluation = evaluateCleanMrCandidate(candidate, NO_REVERTED);
    expect(evaluation.accepted).toBe(false);
    expect(evaluation.reason).toBe("issue-linked");
    expect(evaluation.issueNumbers).toEqual([33]);
  });

  it("PR 本身是 revert → revert-pr", () => {
    const candidate = makeCandidate({
      pr: makePullRequest({ title: 'Revert "Add feature"' }),
    });
    expect(evaluateCleanMrCandidate(candidate, NO_REVERTED)).toMatchObject({
      accepted: false,
      reason: "revert-pr",
    });
  });

  it("被更晚的 revert PR 引用 → reverted-later", () => {
    const reverted = new Set([101]);
    const evaluation = evaluateCleanMrCandidate(makeCandidate(), reverted);
    expect(evaluation).toMatchObject({ accepted: false, reason: "reverted-later" });
  });

  it("依赖 bump（全部文件为依赖清单）→ dependency-bump", () => {
    const candidate = makeCandidate({ diff: SAMPLE_POM_DIFF });
    expect(evaluateCleanMrCandidate(candidate, NO_REVERTED)).toMatchObject({
      accepted: false,
      reason: "dependency-bump",
    });
  });

  it("无 Java 文件 → no-java-file", () => {
    const candidate = makeCandidate({ diff: SAMPLE_README_DIFF });
    expect(evaluateCleanMrCandidate(candidate, NO_REVERTED)).toMatchObject({
      accepted: false,
      reason: "no-java-file",
    });
  });

  it("超 10 文件 → too-many-files；超 2000 变更行 → diff-too-large", () => {
    const manyFiles = makeCandidate({ diff: javaDiffWithFiles(11, 1) });
    expect(evaluateCleanMrCandidate(manyFiles, NO_REVERTED)).toMatchObject({
      accepted: false,
      reason: "too-many-files",
    });
    const tooLarge = makeCandidate({ diff: javaDiffWithFiles(1, 2001) });
    expect(evaluateCleanMrCandidate(tooLarge, NO_REVERTED)).toMatchObject({
      accepted: false,
      reason: "diff-too-large",
    });
  });

  it("恰好边界端点（10 文件 / 2000 行）通过", () => {
    const atLimit = makeCandidate({ diff: javaDiffWithFiles(10, 200) });
    const evaluation = evaluateCleanMrCandidate(atLimit, NO_REVERTED);
    expect(evaluation.accepted).toBe(true);
    expect(evaluation.metrics?.files).toBe(10);
    expect(evaluation.metrics?.changedLines).toBe(2000);
  });

  it("不可解析 diff（含二进制/纯重命名）→ malformed-diff", () => {
    expect(evaluateCleanMrCandidate(makeCandidate({ diff: "garbage" }), NO_REVERTED)).toMatchObject({
      accepted: false,
      reason: "malformed-diff",
    });
    const binary = [
      "diff --git a/logo.png b/logo.png",
      "index 111..222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    expect(evaluateCleanMrCandidate(makeCandidate({ diff: binary }), NO_REVERTED)).toMatchObject({
      accepted: false,
      reason: "malformed-diff",
    });
  });

  it("规则链顺序：merged 校验最先（多处不满足时留痕首个原因）", () => {
    const candidate = makeCandidate({
      pr: makePullRequest({ title: "Fixes #9", mergedAt: null }),
    });
    expect(evaluateCleanMrCandidate(candidate, NO_REVERTED)).toMatchObject({
      accepted: false,
      reason: "not-merged",
    });
  });

  it("附加规则可配置关闭：全关后 issue 关联/依赖 bump/无 Java 的候选通过（核心结构仍校验）", () => {
    const candidate = makeCandidate({
      pr: makePullRequest({ title: "Fixes #33" }),
      diff: SAMPLE_POM_DIFF,
    });
    const evaluation = evaluateCleanMrCandidate(candidate, NO_REVERTED, NO_EXTRA_RULES);
    expect(evaluation.accepted).toBe(true);
    expect(evaluation.metrics?.files).toBe(1);
  });

  it("缺省配置 = 核心三规则 + 附加规则全开", () => {
    expect(DEFAULT_CLEAN_MR_RULES).toEqual({
      excludeIssueLinked: true,
      excludeRevertPrs: true,
      excludeRevertedByLaterPr: true,
      excludeDependencyBumps: true,
      requireJavaFile: true,
    });
  });
});

function scanOf(
  org: string,
  repo: string,
  candidates: ReturnType<typeof makeCandidate>[],
  scannedPrs = candidates.map((c) => c.pr),
): RepoCandidateScan {
  return { org, repo, scannedPrs, candidates };
}

describe("selectCleanMrCases（确定性选取）", () => {
  it("每仓取前 quota 条通过者；通过但超配额者留痕 overflow", () => {
    const scan = scanOf("google", "gson", [
      makeCandidate({ pr: makePullRequest({ number: 1 }) }),
      makeCandidate({ pr: makePullRequest({ number: 2, title: "Fixes #1" }) }),
      makeCandidate({ pr: makePullRequest({ number: 3 }) }),
      makeCandidate({ pr: makePullRequest({ number: 4 }) }),
    ]);
    const result = selectCleanMrCases([scan], { perRepoQuota: 2, rules: DEFAULT_CLEAN_MR_RULES, boundary: { maxFiles: 10, maxDiffLines: 2000 } });
    expect(result.total).toBe(2);
    expect(result.selected.map((s) => s.candidate.pr.number)).toEqual([1, 3]);
    const stats = result.repos[0]!;
    expect(stats).toMatchObject({ org: "google", repo: "gson", evaluated: 4, accepted: 3, selected: 2, quota: 2 });
    expect(stats.rejectedByReason["issue-linked"]).toBe(1);
    expect(stats.overflowPrNumbers).toEqual([4]);
  });

  it("scannedPrs 驱动 reverted-later 判定（跨候选引用）", () => {
    const scannedPrs = [
      makePullRequest({ number: 900, title: 'Revert "X"', body: "Reverts google/gson#101" }),
    ];
    const scan: RepoCandidateScan = {
      org: "google",
      repo: "gson",
      scannedPrs,
      candidates: [makeCandidate({ pr: makePullRequest({ number: 101 }) })],
    };
    const result = selectCleanMrCases([scan], { perRepoQuota: 6, rules: DEFAULT_CLEAN_MR_RULES, boundary: { maxFiles: 10, maxDiffLines: 2000 } });
    expect(result.total).toBe(0);
    expect(result.repos[0]!.rejectedByReason["reverted-later"]).toBe(1);
  });

  it("多仓库：各仓独立配额，全局顺序 = 仓库顺序", () => {
    const scanA = scanOf("google", "gson", [
      makeCandidate({ pr: makePullRequest({ number: 11 }) }),
      makeCandidate({ pr: makePullRequest({ number: 12 }) }),
    ]);
    const scanB = scanOf("mockito", "mockito", [
      makeCandidate({ pr: makePullRequest({ number: 21 }) }),
      makeCandidate({ pr: makePullRequest({ number: 22, title: "Fixes #2" }) }),
    ]);
    const result = selectCleanMrCases([scanA, scanB], {
      perRepoQuota: 5,
      rules: DEFAULT_CLEAN_MR_RULES,
      boundary: { maxFiles: 10, maxDiffLines: 2000 },
    });
    expect(result.total).toBe(3);
    expect(result.selected.map((s) => s.candidate.pr.number)).toEqual([11, 12, 21]);
    expect(result.repos.map((r) => `${r.org}/${r.repo}`)).toEqual(["google/gson", "mockito/mockito"]);
    expect(result.repos[1]!.rejectedByReason["issue-linked"]).toBe(1);
  });

  it("同输入必得同输出；不修改输入（纯函数）", () => {
    const scans = [
      scanOf("google", "gson", [
        makeCandidate({ pr: makePullRequest({ number: 31 }) }),
        makeCandidate({ pr: makePullRequest({ number: 32 }), diff: javaDiffWithFiles(11, 1) }),
      ]),
    ];
    const config = { perRepoQuota: 6, rules: DEFAULT_CLEAN_MR_RULES, boundary: { maxFiles: 10, maxDiffLines: 2000 } };
    const before = JSON.stringify(scans);
    const first = selectCleanMrCases(scans, config);
    const second = selectCleanMrCases(scans, config);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(scans)).toBe(before);
  });

  it("配额非法时显式抛错（fail fast）", () => {
    expect(() =>
      selectCleanMrCases([], { perRepoQuota: 0, rules: DEFAULT_CLEAN_MR_RULES, boundary: { maxFiles: 10, maxDiffLines: 2000 } }),
    ).toThrow(RangeError);
  });

  it("空输入零选取但结构完整", () => {
    const result = selectCleanMrCases([]);
    expect(result.total).toBe(0);
    expect(result.selected).toEqual([]);
    expect(result.repos).toEqual([]);
  });

  it("补位（targetTotal）：配额未凑齐总数时按仓库顺序从各仓剩余通过者补足", () => {
    // 仓 A 通过 5 条、仓 B 通过 2 条（quota=3 → 3+2=5），目标 7 → A 补 2
    const scanA = scanOf("google", "gson", [
      makeCandidate({ pr: makePullRequest({ number: 1 }) }),
      makeCandidate({ pr: makePullRequest({ number: 2 }) }),
      makeCandidate({ pr: makePullRequest({ number: 3 }) }),
      makeCandidate({ pr: makePullRequest({ number: 4 }) }),
      makeCandidate({ pr: makePullRequest({ number: 5 }) }),
    ]);
    const scanB = scanOf("mockito", "mockito", [
      makeCandidate({ pr: makePullRequest({ number: 21 }) }),
      makeCandidate({ pr: makePullRequest({ number: 22 }) }),
    ]);
    const result = selectCleanMrCases([scanA, scanB], {
      perRepoQuota: 3,
      targetTotal: 7,
      spillPerRepo: 4,
      rules: DEFAULT_CLEAN_MR_RULES,
      boundary: { maxFiles: 10, maxDiffLines: 2000 },
    });
    expect(result.total).toBe(7);
    expect(result.selected.map((s) => s.candidate.pr.number)).toEqual([1, 2, 3, 21, 22, 4, 5]);
    expect(result.repos[0]).toMatchObject({ selected: 5, quota: 3 });
    expect(result.repos[0]!.overflowPrNumbers).toEqual([]);
    expect(result.repos[1]).toMatchObject({ selected: 2, quota: 3 });
  });

  it("补位受 spillPerRepo 与剩余候选约束；目标不可达时按实际数返回", () => {
    const scanA = scanOf("google", "gson", [
      makeCandidate({ pr: makePullRequest({ number: 1 }) }),
      makeCandidate({ pr: makePullRequest({ number: 2 }) }),
      makeCandidate({ pr: makePullRequest({ number: 3 }) }),
    ]);
    // spillPerRepo=1：quota 2 + 补 1 = 3 < 目标 9
    const result = selectCleanMrCases([scanA], {
      perRepoQuota: 2,
      targetTotal: 9,
      spillPerRepo: 1,
      rules: DEFAULT_CLEAN_MR_RULES,
      boundary: { maxFiles: 10, maxDiffLines: 2000 },
    });
    expect(result.total).toBe(3);
    expect(result.selected.map((s) => s.candidate.pr.number)).toEqual([1, 2, 3]);
    expect(result.repos[0]!.overflowPrNumbers).toEqual([]);
  });

  it("未配置 targetTotal 时不补位（纯每仓配额语义）", () => {
    const scanA = scanOf("google", "gson", [
      makeCandidate({ pr: makePullRequest({ number: 1 }) }),
      makeCandidate({ pr: makePullRequest({ number: 2 }) }),
      makeCandidate({ pr: makePullRequest({ number: 3 }) }),
    ]);
    const result = selectCleanMrCases([scanA], {
      perRepoQuota: 2,
      rules: DEFAULT_CLEAN_MR_RULES,
      boundary: { maxFiles: 10, maxDiffLines: 2000 },
    });
    expect(result.total).toBe(2);
    expect(result.repos[0]!.overflowPrNumbers).toEqual([3]);
  });

  it("targetTotal 非法时显式抛错", () => {
    expect(() =>
      selectCleanMrCases([], {
        perRepoQuota: 1,
        targetTotal: 0,
        rules: DEFAULT_CLEAN_MR_RULES,
        boundary: { maxFiles: 10, maxDiffLines: 2000 },
      }),
    ).toThrow(RangeError);
  });
});

import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/contracts/finding.js";
import type { MRTruth } from "../../src/contracts/mr-case.js";
import {
  canonicalNature,
  normalizeFilePath,
  screenFindings,
} from "../../src/metrics/screening.js";
import type { ScreeningOptions } from "../../src/metrics/types.js";
import { DEFAULT_SCREENING_OPTIONS } from "../../src/metrics/types.js";
import { makeFinding, makeTruth, makeTruthLocation } from "./helpers.js";

/** 规则粗筛匹配口径：文件归一 / 行位容差 / 性质等价 / 一对一占用（issue #11 验收标准 1） */

const TRUTH_FILE = "src/main/java/com/example/Math.java";

function truthWith(overrides: Partial<Parameters<typeof makeTruthLocation>[0]> = {}): MRTruth {
  return makeTruth([makeTruthLocation({ ...overrides, file: TRUTH_FILE })]);
}

describe("screenFindings — line-level matching", () => {
  it("marks a finding inside the truth interval as TP with zero offset", () => {
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 10 })],
      truthWith({ lineStart: 8, lineEnd: 12 }),
    );
    expect(result.verdicts).toEqual([
      {
        findingId: "F001",
        outcome: "TP",
        matchedTruthIndex: 0,
        lineOffset: 0,
        fpReason: null,
        withinTolerance: false,
      },
    ]);
    expect(result.lineLevel).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(result.misses).toEqual([]);
  });

  it("marks a tolerance-band hit as TP with a position-offset marker", () => {
    const options: ScreeningOptions = { ...DEFAULT_SCREENING_OPTIONS, lineTolerance: 2 };
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 12 })],
      truthWith({ lineStart: 10, lineEnd: 10 }),
      options,
    );
    expect(result.verdicts[0]).toEqual({
      findingId: "F001",
      outcome: "TP",
      matchedTruthIndex: 0,
      lineOffset: 2,
      fpReason: null,
      withinTolerance: true,
    });
    expect(result.lineLevel.tp).toBe(1);
  });

  it("marks offsets below the interval as well as above it", () => {
    const options: ScreeningOptions = { ...DEFAULT_SCREENING_OPTIONS, lineTolerance: 3 };
    const result = screenFindings(
      [makeFinding({ id: "F001", file: TRUTH_FILE, line: 7 })],
      truthWith({ lineStart: 10, lineEnd: 10 }),
      options,
    );
    expect(result.verdicts[0]?.lineOffset).toBe(3);
    expect(result.verdicts[0]?.withinTolerance).toBe(true);
  });

  it("rejects a finding outside the tolerance band with NO_LINE_MATCH", () => {
    const options: ScreeningOptions = { ...DEFAULT_SCREENING_OPTIONS, lineTolerance: 2 };
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 15 })],
      truthWith({ lineStart: 10, lineEnd: 10 }),
      options,
    );
    expect(result.verdicts[0]).toMatchObject({ outcome: "FP", fpReason: "NO_LINE_MATCH" });
    expect(result.lineLevel).toEqual({ tp: 0, fp: 1, fn: 1 });
    expect(result.misses).toHaveLength(1);
  });

  it("with default tolerance 0, only interval hits count (adjacent line is FP)", () => {
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 11 })],
      truthWith({ lineStart: 10, lineEnd: 10 }),
    );
    expect(result.verdicts[0]).toMatchObject({ outcome: "FP", fpReason: "NO_LINE_MATCH" });
  });
});

describe("screenFindings — two-pass assignment (exact hits claim first)", () => {
  it("lets a later exact finding claim the truth before an earlier tolerance-band finding", () => {
    const options: ScreeningOptions = { ...DEFAULT_SCREENING_OPTIONS, lineTolerance: 2 };
    const truth = makeTruth([
      makeTruthLocation({ file: TRUTH_FILE, lineStart: 10, lineEnd: 10 }),
      makeTruthLocation({ file: TRUTH_FILE, lineStart: 20, lineEnd: 20 }),
    ]);
    const findings = [
      makeFinding({ id: "F1", file: TRUTH_FILE, line: 12 }),
      makeFinding({ id: "F2", file: TRUTH_FILE, line: 10 }),
    ];
    const result = screenFindings(findings, truth, options);
    expect(result.verdicts[0]).toMatchObject({
      findingId: "F1",
      outcome: "FP",
      fpReason: "DUPLICATE",
    });
    expect(result.verdicts[1]).toMatchObject({ findingId: "F2", outcome: "TP", lineOffset: 0 });
    expect(result.lineLevel).toEqual({ tp: 1, fp: 1, fn: 1 });
  });

  it("assigns a band finding to a second unclaimed truth when the first is taken", () => {
    const options: ScreeningOptions = { ...DEFAULT_SCREENING_OPTIONS, lineTolerance: 2 };
    const truth = makeTruth([
      makeTruthLocation({ file: TRUTH_FILE, lineStart: 10, lineEnd: 10 }),
      makeTruthLocation({ file: "src/Other.java", lineStart: 20, lineEnd: 20 }),
    ]);
    const findings = [
      makeFinding({ id: "F1", file: TRUTH_FILE, line: 10 }),
      makeFinding({ id: "F2", file: TRUTH_FILE, line: 11 }),
      makeFinding({ id: "F3", file: "src/Other.java", line: 21 }),
    ];
    const result = screenFindings(findings, truth, options);
    expect(result.verdicts[0]).toMatchObject({ findingId: "F1", outcome: "TP" });
    expect(result.verdicts[1]).toMatchObject({ findingId: "F2", outcome: "FP" });
    expect(result.verdicts[2]).toMatchObject({ findingId: "F3", outcome: "TP", lineOffset: 1 });
  });

  it("treats a redundant second finding on the same truth as DUPLICATE", () => {
    const truth = truthWith({ lineStart: 10, lineEnd: 10 });
    const findings = [
      makeFinding({ id: "F1", file: TRUTH_FILE, line: 10 }),
      makeFinding({ id: "F2", file: TRUTH_FILE, line: 10 }),
    ];
    const result = screenFindings(findings, truth);
    expect(result.verdicts[0]).toMatchObject({ outcome: "TP" });
    expect(result.verdicts[1]).toMatchObject({ outcome: "FP", fpReason: "DUPLICATE" });
    expect(result.lineLevel).toEqual({ tp: 1, fp: 1, fn: 0 });
  });
});

describe("screenFindings — nature equivalence", () => {
  it("rejects a wrong-nature finding with NO_NATURE_MATCH even when file and line hit", () => {
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 10, category: "PERFORMANCE" })],
      truthWith(),
    );
    expect(result.verdicts[0]).toMatchObject({ outcome: "FP", fpReason: "NO_NATURE_MATCH" });
  });

  it("matches nature case-insensitively and ignores surrounding whitespace", () => {
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 10, category: " correctness " })],
      truthWith({ defectNature: "Correctness" }),
    );
    expect(result.verdicts[0]).toMatchObject({ outcome: "TP" });
  });

  it("aligns vocabularies through the configurable alias map", () => {
    const options: ScreeningOptions = {
      ...DEFAULT_SCREENING_OPTIONS,
      natureAliases: { "NULL_POINTER": "NULL_SAFETY", "NPE": "NULL_SAFETY" },
    };
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 10, category: "null_pointer" })],
      truthWith({ defectNature: "NULL_SAFETY" }),
      options,
    );
    expect(result.verdicts[0]).toMatchObject({ outcome: "TP" });
  });

  it("rejects a truth nature outside the shared DEFECT_NATURES vocabulary", () => {
    expect(() => screenFindings([makeFinding()], truthWith({ defectNature: "defect-logic" }))).toThrow(
      /defectNature "defect-logic" is not in the shared DEFECT_NATURES vocabulary/,
    );
  });

  it("tolerates a finding category outside the vocabulary (counted as FP, not an error)", () => {
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 10, category: "MAINTAINABILITY" })],
      truthWith(),
    );
    expect(result.verdicts[0]).toMatchObject({ outcome: "FP", fpReason: "NO_NATURE_MATCH" });
  });

  it("reports NO_NATURE_MATCH when file and nature match different truth locations", () => {
    const truth = makeTruth([
      makeTruthLocation({ file: "src/A.java", lineStart: 10, lineEnd: 10, defectNature: "CORRECTNESS" }),
      makeTruthLocation({ file: "src/B.java", lineStart: 10, lineEnd: 10, defectNature: "PERFORMANCE" }),
    ]);
    const result = screenFindings(
      [makeFinding({ file: "src/A.java", line: 10, category: "PERFORMANCE" })],
      truth,
    );
    expect(result.verdicts[0]).toMatchObject({ outcome: "FP", fpReason: "NO_NATURE_MATCH" });
  });
});

describe("screenFindings — file matching", () => {
  it("rejects a finding in an unmatched file with NO_FILE_MATCH", () => {
    const result = screenFindings(
      [makeFinding({ file: "src/Elsewhere.java", line: 10 })],
      truthWith(),
    );
    expect(result.verdicts[0]).toMatchObject({ outcome: "FP", fpReason: "NO_FILE_MATCH" });
  });

  it("normalizes path separators, './' and unified-diff a/ b/ prefixes", () => {
    for (const file of [
      `a/${TRUTH_FILE}`,
      `b/${TRUTH_FILE}`,
      `./${TRUTH_FILE}`,
      TRUTH_FILE.replace(/\//g, "\\"),
    ]) {
      const result = screenFindings([makeFinding({ file, line: 10 })], truthWith());
      expect(result.verdicts[0]?.outcome, `file=${file}`).toBe("TP");
    }
  });
});

describe("screenFindings — file-level counts", () => {
  it("counts a file+nature hit as file-level TP even when the line misses", () => {
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 500 })],
      truthWith({ lineStart: 10, lineEnd: 10 }),
    );
    expect(result.lineLevel).toEqual({ tp: 0, fp: 1, fn: 1 });
    expect(result.fileLevel).toEqual({ tp: 1, fp: 0, fn: 0 });
  });

  it("keeps the nature requirement at file level", () => {
    const result = screenFindings(
      [makeFinding({ file: TRUTH_FILE, line: 10, category: "PERFORMANCE" })],
      truthWith(),
    );
    expect(result.fileLevel).toEqual({ tp: 0, fp: 1, fn: 1 });
  });

  it("enforces one-to-one occupation at file level too", () => {
    const truth = makeTruth([
      makeTruthLocation({ file: TRUTH_FILE, lineStart: 10, lineEnd: 10 }),
      makeTruthLocation({ file: "src/Other.java", lineStart: 10, lineEnd: 10 }),
    ]);
    const findings = [
      makeFinding({ id: "F1", file: TRUTH_FILE, line: 10 }),
      makeFinding({ id: "F2", file: TRUTH_FILE, line: 99 }),
    ];
    const result = screenFindings(findings, truth);
    expect(result.fileLevel).toEqual({ tp: 1, fp: 1, fn: 1 });
  });
});

describe("screenFindings — edge cases", () => {
  it("returns all truth locations as misses when there are zero findings", () => {
    const truth = makeTruth([
      makeTruthLocation({ file: "src/A.java", lineStart: 1, lineEnd: 5, defectNature: "CORRECTNESS" }),
      makeTruthLocation({ file: "src/B.java", lineStart: 9, lineEnd: 9, defectNature: "SECURITY" }),
    ]);
    const result = screenFindings([], truth);
    expect(result.verdicts).toEqual([]);
    expect(result.lineLevel).toEqual({ tp: 0, fp: 0, fn: 2 });
    expect(result.misses).toEqual([
      { truthIndex: 0, file: "src/A.java", lineStart: 1, lineEnd: 5, defectNature: "CORRECTNESS" },
      { truthIndex: 1, file: "src/B.java", lineStart: 9, lineEnd: 9, defectNature: "SECURITY" },
    ]);
  });

  it("marks every finding as FP on a clean MR (negative control)", () => {
    const findings = [makeFinding(), makeFinding({ id: "F002" })];
    const result = screenFindings(findings, null);
    expect(result.cleanMr).toBe(true);
    expect(result.verdicts).toEqual([
      {
        findingId: "F001",
        outcome: "FP",
        matchedTruthIndex: null,
        lineOffset: null,
        fpReason: "CLEAN_MR",
        withinTolerance: false,
      },
      {
        findingId: "F002",
        outcome: "FP",
        matchedTruthIndex: null,
        lineOffset: null,
        fpReason: "CLEAN_MR",
        withinTolerance: false,
      },
    ]);
    expect(result.misses).toEqual([]);
    expect(result.lineLevel).toEqual({ tp: 0, fp: 2, fn: 0 });
    expect(result.fileLevel).toEqual({ tp: 0, fp: 2, fn: 0 });
  });

  it("handles a clean MR with zero findings without crashing", () => {
    const result = screenFindings([], null);
    expect(result.lineLevel).toEqual({ tp: 0, fp: 0, fn: 0 });
    expect(result.fileLevel).toEqual({ tp: 0, fp: 0, fn: 0 });
  });
});

describe("screenFindings — input validation", () => {
  it("rejects invalid findings", () => {
    expect(() => screenFindings([makeFinding({ line: 0 })], truthWith())).toThrow(
      /findings\[0\]\.line must be an integer >= 1/,
    );
    expect(() =>
      screenFindings([{ ...makeFinding(), file: "" } as Finding], truthWith()),
    ).toThrow(/findings\[0\]\.file must be a non-empty string/);
  });

  it("rejects malformed truth locations", () => {
    expect(() =>
      screenFindings([makeFinding()], makeTruth([makeTruthLocation({ lineStart: 12, lineEnd: 10 })])),
    ).toThrow(/lineStart \(12\) must be <= lineEnd \(10\)/);
    expect(() => screenFindings([makeFinding()], { locations: [], fixPatch: "x" })).toThrow(
      /truth\.locations must be a non-empty array/,
    );
  });

  it("rejects invalid options", () => {
    expect(() =>
      screenFindings([makeFinding()], truthWith(), { ...DEFAULT_SCREENING_OPTIONS, lineTolerance: -1 }),
    ).toThrow(/lineTolerance must be an integer >= 0/);
    expect(() =>
      screenFindings([makeFinding()], truthWith(), {
        ...DEFAULT_SCREENING_OPTIONS,
        natureAliases: { CORRECTNESS: " " },
      }),
    ).toThrow(/natureAliases must map non-empty strings/);
  });
});

describe("normalizeFilePath / canonicalNature", () => {
  it("normalizes the file path vocabulary deterministically", () => {
    expect(normalizeFilePath("a/src/Main.java")).toBe("src/Main.java");
    expect(normalizeFilePath(".\\src\\Main.java")).toBe("src/Main.java");
    expect(normalizeFilePath("src//Main.java")).toBe("src/Main.java");
    expect(normalizeFilePath("./a/./src/Main.java")).toBe("src/Main.java");
  });

  it("canonicalizes nature values", () => {
    expect(canonicalNature(" correctness ", {})).toBe("CORRECTNESS");
    expect(canonicalNature("bug", { BUG: "CORRECTNESS" })).toBe("CORRECTNESS");
    expect(canonicalNature("unknown", { BUG: "CORRECTNESS" })).toBe("UNKNOWN");
  });
});

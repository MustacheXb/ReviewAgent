import { describe, expect, it } from "vitest";
import type { JudgeAdjudication } from "../../src/judge/contracts.js";
import { resolveAdjudication } from "../../src/judge/resolve.js";
import { adjudication, match } from "./helpers.js";

describe("resolveAdjudication — 置信度门槛", () => {
  it('默认门槛 "low"：none 恒拒绝（协议语义）', () => {
    const resolved = resolveAdjudication(
      adjudication([match({ finding: 0, truth: 0, confidence: "none" })]),
      1,
      1,
    );
    expect(resolved.matches).toHaveLength(0);
    expect(resolved.rejections).toHaveLength(1);
    expect(resolved.rejections[0]?.matchConfidence).toBe("none");
  });

  it('门槛 "none"：复现官方宽松口径——truth 索引非 null 即命中', () => {
    const resolved = resolveAdjudication(
      adjudication([match({ finding: 0, truth: 0, confidence: "none" })]),
      1,
      1,
      "none",
    );
    expect(resolved.matches).toHaveLength(1);
    expect(resolved.rejections).toHaveLength(0);
  });

  it('门槛 "medium"：low 被拒、medium/high 命中', () => {
    const resolved = resolveAdjudication(
      adjudication([
        match({ finding: 0, truth: 0, confidence: "low" }),
        match({ finding: 1, truth: 1, confidence: "medium" }),
        match({ finding: 2, truth: 2, confidence: "high" }),
      ]),
      3,
      3,
      "medium",
    );
    expect(resolved.matches.map((entry) => entry.findingIndex)).toEqual([1, 2]);
    expect(resolved.rejections.map((entry) => entry.findingIndex)).toEqual([0]);
  });

  it('门槛 "high"：仅 high 命中', () => {
    const resolved = resolveAdjudication(
      adjudication([
        match({ finding: 0, truth: 0, confidence: "medium" }),
        match({ finding: 1, truth: 1, confidence: "high" }),
      ]),
      2,
      2,
      "high",
    );
    expect(resolved.matches.map((entry) => entry.findingIndex)).toEqual([1]);
  });
});

describe("resolveAdjudication — 一对一占用", () => {
  it("同一真值被重复声明：首个占用幸存，后续丢弃并记 anomaly", () => {
    const resolved = resolveAdjudication(
      adjudication([
        match({ finding: 0, truth: 1 }),
        match({ finding: 1, truth: 1 }),
      ]),
      2,
      2,
    );
    expect(resolved.matches).toHaveLength(1);
    expect(resolved.matches[0]?.findingIndex).toBe(0);
    expect(resolved.anomalies).toHaveLength(1);
    expect(resolved.anomalies[0]).toContain("already claimed one-to-one");
  });

  it("同一 finding 重复声明：首个占用幸存，后续丢弃并记 anomaly", () => {
    const resolved = resolveAdjudication(
      adjudication([
        match({ finding: 0, truth: 0 }),
        match({ finding: 0, truth: 1 }),
      ]),
      1,
      2,
    );
    expect(resolved.matches).toHaveLength(1);
    expect(resolved.matches[0]?.truthIndex).toBe(0);
    expect(resolved.anomalies).toHaveLength(1);
    expect(resolved.anomalies[0]).toContain("duplicate match");
  });

  it("拒绝条目按 finding 记首条（多条拒绝不重复计入）", () => {
    const resolved = resolveAdjudication(
      adjudication([
        match({ finding: 0, truth: null, confidence: "none", reason: "first rejection" }),
        match({ finding: 0, truth: null, confidence: "none", reason: "second rejection" }),
      ]),
      1,
      1,
    );
    expect(resolved.rejections).toHaveLength(1);
    expect(resolved.rejections[0]?.matchReason).toBe("first rejection");
  });
});

describe("resolveAdjudication — 界内校验（有界失败）", () => {
  it("越界 finding 索引条目丢弃并记 anomaly", () => {
    const resolved = resolveAdjudication(
      adjudication([match({ finding: 5, truth: 0 })]),
      1,
      1,
    );
    expect(resolved.matches).toHaveLength(0);
    expect(resolved.anomalies[0]).toContain("out-of-range finding index");
  });

  it("越界 truth 索引条目丢弃并记 anomaly（不是拒绝也不是命中）", () => {
    const resolved = resolveAdjudication(
      adjudication([match({ finding: 0, truth: 9 })]),
      1,
      1,
    );
    expect(resolved.matches).toHaveLength(0);
    expect(resolved.rejections).toHaveLength(0);
    expect(resolved.anomalies[0]).toContain("out-of-range truth index");
  });

  it("adjudication.matches 非数组 → 显式抛错（契约违约）", () => {
    expect(() =>
      resolveAdjudication({ matches: "nope" } as unknown as JudgeAdjudication, 1, 1),
    ).toThrowError(/must be an array of JudgeMatch/);
  });

  it("非法计数入参 → 显式抛错", () => {
    expect(() => resolveAdjudication(adjudication([]), -1, 1)).toThrowError(/findingCount/);
    expect(() => resolveAdjudication(adjudication([]), 1, 1.5)).toThrowError(/truthCount/);
  });
});

describe("resolveAdjudication — 正常路径", () => {
  it("界内、过门槛、一对一的条目全部保留（顺序保留）", () => {
    const resolved = resolveAdjudication(
      adjudication([
        match({ finding: 2, truth: 0, confidence: "low" }),
        match({ finding: 0, truth: 1, confidence: "high" }),
        match({ finding: 1, truth: null, confidence: "none" }),
      ]),
      3,
      2,
    );
    expect(resolved.matches).toEqual([
      { findingIndex: 2, truthIndex: 0, matchConfidence: "low", matchReason: "test reason" },
      { findingIndex: 0, truthIndex: 1, matchConfidence: "high", matchReason: "test reason" },
    ]);
    expect(resolved.rejections.map((entry) => entry.findingIndex)).toEqual([1]);
    expect(resolved.anomalies).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { GptJudgeResponseFormatError } from "../../src/judge/errors.js";
import {
  extractJudgeJsonText,
  normalizeMatchEntry,
  parseJudgeAdjudication,
} from "../../src/judge/parse.js";
import { wireAdjudicationText, wireMatch } from "./helpers.js";

describe("extractJudgeJsonText — JSON 提取策略", () => {
  it("直接 JSON 对象原文返回", () => {
    const text = '{"matches": []}';
    expect(extractJudgeJsonText(text)).toBe(text);
  });

  it("剥 ```json 围栏", () => {
    const fenced = "```json\n{\"matches\": []}\n```";
    expect(extractJudgeJsonText(fenced)).toBe("{\"matches\": []}");
  });

  it("从前后杂文中提取首 { 到末 } 的子串", () => {
    const noisy = 'Here is my judgment:\n{"matches": [{"a": 1}]}\nHope this helps!';
    expect(extractJudgeJsonText(noisy)).toBe('{"matches": [{"a": 1}]}');
  });

  it("无 JSON 对象时返回 null（空串 / 纯文本 / 只有围栏头）", () => {
    expect(extractJudgeJsonText("")).toBeNull();
    expect(extractJudgeJsonText("no json here")).toBeNull();
    expect(extractJudgeJsonText("```json")).toBeNull();
  });
});

describe("parseJudgeAdjudication — 归一与校验", () => {
  it("1 起索引归一为 0 起，字段逐条保留", () => {
    const raw = wireAdjudicationText([
      wireMatch({ model: 1, truth: 2, confidence: "medium", reason: "same issue" }),
      wireMatch({ model: 3, truth: null, confidence: "none", reason: "different problem" }),
    ]);
    const parsed = parseJudgeAdjudication(raw);
    expect(parsed.matches).toEqual([
      { findingIndex: 0, truthIndex: 1, matchConfidence: "medium", matchReason: "same issue" },
      { findingIndex: 2, truthIndex: null, matchConfidence: "none", matchReason: "different problem" },
    ]);
  });

  it("缺失的 ground_truth_defect_index 视为显式拒绝（truthIndex null）", () => {
    const raw = JSON.stringify({
      matches: [{ model_defect_index: 1, match_confidence: "none", match_reason: "no match" }],
    });
    const parsed = parseJudgeAdjudication(raw);
    expect(parsed.matches[0]?.truthIndex).toBeNull();
  });

  it("非法条目丢弃不整单报废（confidence 词表外 / 索引非正整数 / 非对象）", () => {
    const raw = wireAdjudicationText([
      wireMatch({ model: 1, truth: 1, confidence: "certain" }),
      wireMatch({ model: 0, truth: 1 }),
      wireMatch({ model: 2, truth: -3 }),
      "not an object" as unknown as Record<string, unknown>,
      wireMatch({ model: 2, truth: 1, confidence: "low" }),
    ]);
    const parsed = parseJudgeAdjudication(raw);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]).toEqual({
      findingIndex: 1,
      truthIndex: 0,
      matchConfidence: "low",
      matchReason: "test reason",
    });
  });

  it("ground_truth_defect_index 存在但非法（非 null 非正整数）→ 条目整体非法，不伪装成拒绝", () => {
    const entry = normalizeMatchEntry(wireMatch({ model: 1, truth: 0 }));
    expect(entry).toBeNull();
    const entryFractional = normalizeMatchEntry(wireMatch({ model: 1, truth: 1.5 }));
    expect(entryFractional).toBeNull();
  });

  it("缺失 match_reason 时归一为空串（judge 理由可选）", () => {
    const raw = JSON.stringify({
      matches: [{ model_defect_index: 1, ground_truth_defect_index: 1, match_confidence: "high" }],
    });
    const parsed = parseJudgeAdjudication(raw);
    expect(parsed.matches[0]?.matchReason).toBe("");
  });

  it("summary 支持字符串与对象两种形态", () => {
    const objectSummary = parseJudgeAdjudication(
      wireAdjudicationText([wireMatch({ model: 1, truth: 1 })]),
    );
    expect(objectSummary.summary).toBe(JSON.stringify({}));

    const stringSummary = parseJudgeAdjudication(
      wireAdjudicationText([wireMatch({ model: 1, truth: 1 })], { summary: "all matched" }),
    );
    expect(stringSummary.summary).toBe("all matched");
  });
});

describe("parseJudgeAdjudication — 有界失败", () => {
  it("无 JSON 对象 → GptJudgeResponseFormatError", () => {
    expect(() => parseJudgeAdjudication("I cannot judge this.")).toThrowError(
      GptJudgeResponseFormatError,
    );
  });

  it("JSON 非法 → GptJudgeResponseFormatError 并附上下文摘要", () => {
    expect(() => parseJudgeAdjudication("{ matches: [ }")).toThrowError(/not valid JSON/);
  });

  it("matches 缺失 / 非数组 / 根非对象 → 显式错误", () => {
    expect(() => parseJudgeAdjudication("{}")).toThrowError(/must contain a "matches" array/);
    expect(() => parseJudgeAdjudication('{"matches": "nope"}')).toThrowError(/must be an array/);
    // 数组根：无 JSON 对象可提取（提取层拒绝，而非形状层）
    expect(() => parseJudgeAdjudication("[1, 2, 3]")).toThrowError(/contains no JSON object/);
  });

  it("错误消息只含响应摘要（120 字符级），不携带超长原文", () => {
    try {
      parseJudgeAdjudication(`{"matches": ${"x".repeat(500)}}`);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GptJudgeResponseFormatError);
      const message = (error as Error).message;
      expect(message.length).toBeLessThan(400);
    }
  });
});

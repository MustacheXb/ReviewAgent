import { describe, expect, it } from "vitest";

import type { OutputLanguage } from "../../src/contracts/output-language.js";
import { applyCandidateGate } from "../../src/gate/candidate-gate.js";
import type { GateInput } from "../../src/gate/candidate-gate.js";
import type { VerificationVerdict } from "../../src/loop/parse.js";

/**
 * 语言门对称参数化（#55，spec #49 决策 4）——candidate gate 直测 seam。
 *
 * en 是现状回归（缺省 = en：不传 outputLanguage 字段行为零变化）；zh 是
 * 对称判据：title / description 至少其一含 CJK，缺失即 NON_CHINESE 拒绝；
 * evidence 是代码引用面，不作 zh 判据（代码摘录中的 CJK 不引发 zh 误判）。
 * run 级 en 回归由 tests/evidence-gate.test.ts 零改动锁定；zh 的 run 级
 * 贯通（CLI → LoopInputs）属 #58；DSH 侧门与本门的对齐见
 * packages/review-dsh/tests/plugins/review-evidence.test.ts。
 */

const VALID_CANDIDATE = {
  id: "F001",
  severity: "P2",
  category: "CORRECTNESS",
  file: "src/main/java/Example.java",
  line: 42,
  title: "Incorrect URL encoding of query parameters",
  description: "The change encodes the joined query string instead of individual parameter values.",
  evidence: ["Example.java:42 - URLEncoder.encode applied to the joined query string"],
  rule: "CORRECTNESS-001",
  confidence: 0.9,
};

const candidate = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...VALID_CANDIDATE,
  ...overrides,
});

/** 单候选门输入：裁决全通过 + 空跨轮集合（语言检查位于裁决之前，判据不受影响） */
function gateInput(candidateObject: Record<string, unknown>, outputLanguage?: OutputLanguage): GateInput {
  return {
    candidates: [candidateObject],
    verdicts: new Map<string, VerificationVerdict>([
      [candidateObject.id as string, { pass: true, reason: "checked" }],
    ]),
    emittedIds: new Set<string>(),
    round: 1,
    // exactOptionalPropertyTypes：缺省 = 字段缺席（en），非显式 undefined
    ...(outputLanguage !== undefined ? { outputLanguage } : {}),
  };
}

describe("语言门参数化（#55：检查槽位随 outputLanguage 二选一）", () => {
  it("en（缺省）：中文候选仍拒 NON_ENGLISH，reason 冻结（现状回归）", () => {
    const chinese = candidate({ id: "F300", title: "循环边界差一错误", description: "循环会读取越界元素。" });

    const output = applyCandidateGate(gateInput(chinese));

    expect(output.findings).toEqual([]);
    expect(output.rejections).toEqual([
      {
        candidateId: "F300",
        stage: "NON_ENGLISH",
        reason: "finding text must be English only",
      },
    ]);
  });

  it("zh：title 与 description 均无 CJK → NON_CHINESE 拒绝（对称判据，留痕可观测）", () => {
    const english = candidate({ id: "F310" });

    const output = applyCandidateGate(gateInput(english, "zh"));

    expect(output.findings).toEqual([]);
    expect(output.rejections).toEqual([
      {
        candidateId: "F310",
        stage: "NON_CHINESE",
        reason: "finding text must contain Chinese (title or description)",
      },
    ]);
  });

  it("zh：title 含 CJK（description 英文）→ 放行", () => {
    const zhTitle = candidate({ id: "F311", title: "查询参数编码错误" });

    const output = applyCandidateGate(gateInput(zhTitle, "zh"));

    expect(output.rejections).toEqual([]);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]?.title).toBe("查询参数编码错误");
  });

  it("zh：description 含 CJK（title 英文）→ 放行（至少其一）", () => {
    const zhDescription = candidate({ id: "F312", description: "该改动对拼接后的查询串整体编码。" });

    const output = applyCandidateGate(gateInput(zhDescription, "zh"));

    expect(output.rejections).toEqual([]);
    expect(output.findings).toHaveLength(1);
  });

  it("zh：evidence 含 CJK（代码摘录）不参与判据——救不了纯英文候选，也不误判中文候选", () => {
    // 判据只有 title / description：evidence 的 CJK 救不了纯英文候选……
    const englishWithCjkEvidence = candidate({
      id: "F313",
      evidence: ["Example.java:42 - 中文注释：URLEncoder.encode applied to the joined query string"],
    });
    expect(applyCandidateGate(gateInput(englishWithCjkEvidence, "zh")).findings).toEqual([]);

    // ……也不会让已含中文的候选被误拒（代码摘录中的 CJK 不引发 zh 误判）
    const zhTitleWithCjkEvidence = candidate({
      id: "F314",
      title: "查询参数编码错误",
      evidence: ["Example.java:42 - 中文注释：URLEncoder.encode applied to the joined query string"],
    });
    const passed = applyCandidateGate(gateInput(zhTitleWithCjkEvidence, "zh"));
    expect(passed.rejections).toEqual([]);
    expect(passed.findings).toHaveLength(1);
  });

  it("en：evidence 含 CJK 仍拒 NON_ENGLISH（en 检查面含 evidence，现状）", () => {
    const cjkEvidence = candidate({
      id: "F315",
      evidence: ["Example.java:42 - URLEncoder.encode 应用于拼接后的查询串"],
    });

    const output = applyCandidateGate(gateInput(cjkEvidence, "en"));

    expect(output.findings).toEqual([]);
    expect(output.rejections[0]?.stage).toBe("NON_ENGLISH");
  });

  it("拦截链首败即出：zh 下 schema-invalid 候选仍先记 SCHEMA_INVALID（语言检查不越位）", () => {
    const broken = candidate({ id: "F316", title: "查询参数编码错误", severity: undefined });

    const output = applyCandidateGate(gateInput(broken, "zh"));

    expect(output.rejections).toHaveLength(1);
    expect(output.rejections[0]?.stage).toBe("SCHEMA_INVALID");
  });

  it("非法语言值 fail fast：单源 resolveOutputLanguage 人话错误", () => {
    expect(() => applyCandidateGate(gateInput(VALID_CANDIDATE, "fr" as OutputLanguage))).toThrow(
      'outputLanguage must be "en" or "zh" (got "fr")',
    );
  });
});

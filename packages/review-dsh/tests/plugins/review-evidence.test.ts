import { describe, expect, it } from "vitest";

import type { OutputLanguage } from "../../../../src/contracts/output-language.js";
import { applyCandidateGate as applyRootGate } from "../../../../src/gate/candidate-gate.js";
import type { GateInput as RootGateInput } from "../../../../src/gate/candidate-gate.js";
import type { VerificationVerdict } from "../../../../src/loop/parse.js";

import { applyCandidateGate as applyDshGate } from "../../src/plugins/review-evidence.js";
import type { GateInput as DshGateInput } from "../../src/plugins/review-evidence.js";

/**
 * #55：语言门对称参数化——DSH 门与根侧冻结门（src/gate/candidate-gate.ts）
 * 行为对齐。DSH 门是根门的 1:1 手写移植（非 import——import 会使对齐恒真），
 * 本测试就是那条移植纪律的执行点（同构 zone-a-parity 的双副本对照）：
 * 同输入喂两侧门，断言 GateOutput 逐字段相等（findings / rejections /
 * emittedIds）+ 形态侧写（拒 = 预期阶段留痕，过 = 唯一 Finding——防两侧
 * 同错；根门自身行为另由 tests/gate/candidate-gate.test.ts 锁定）。
 * 对齐是行为级而非结构级：两侧函数体存在既有微差（如 DSH 的
 * containsNonEnglish 对 evidence 多一层 Array.isArray 防卫），不在本对照面。
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

/** 单候选门输入（结构与根侧测试 helper 同构：裁决全通过 + 空跨轮集合） */
function gateInput(candidateObject: Record<string, unknown>, outputLanguage?: OutputLanguage) {
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

/** 对齐矩阵：语言门两侧判据的行为面（拒 = 预期阶段；过 = undefined） */
const ALIGNMENT_CASES: readonly {
  readonly name: string;
  readonly candidate: Record<string, unknown>;
  readonly outputLanguage?: OutputLanguage;
  readonly expectedStage?: string;
}[] = [
  {
    name: "en 缺省：中文候选拒 NON_ENGLISH（现状回归）",
    candidate: candidate({ id: "F300", title: "循环边界差一错误", description: "循环会读取越界元素。" }),
    expectedStage: "NON_ENGLISH",
  },
  {
    name: "zh：纯英文候选拒 NON_CHINESE（对称判据）",
    candidate: candidate({ id: "F310" }),
    outputLanguage: "zh",
    expectedStage: "NON_CHINESE",
  },
  {
    name: "zh：中文 title（description 英文）放行",
    candidate: candidate({ id: "F311", title: "查询参数编码错误" }),
    outputLanguage: "zh",
  },
  {
    name: "zh：中文 description（title 英文）放行（至少其一）",
    candidate: candidate({ id: "F312", description: "该改动对拼接后的查询串整体编码。" }),
    outputLanguage: "zh",
  },
  {
    name: "zh：evidence 含 CJK（代码摘录）不参与判据，中文 title 仍放行",
    candidate: candidate({
      id: "F313",
      title: "查询参数编码错误",
      evidence: ["Example.java:42 - 中文注释：URLEncoder.encode applied to the joined query string"],
    }),
    outputLanguage: "zh",
  },
  {
    name: "zh：evidence 含 CJK 救不了纯英文候选",
    candidate: candidate({
      id: "F314",
      evidence: ["Example.java:42 - 中文注释：URLEncoder.encode applied to the joined query string"],
    }),
    outputLanguage: "zh",
    expectedStage: "NON_CHINESE",
  },
  {
    name: "en：evidence 含 CJK 拒 NON_ENGLISH（en 检查面含 evidence）",
    candidate: candidate({ id: "F315", evidence: ["Example.java:42 - URLEncoder.encode 应用于拼接后的查询串"] }),
    outputLanguage: "en",
    expectedStage: "NON_ENGLISH",
  },
  {
    name: "zh：schema-invalid 候选先记 SCHEMA_INVALID（语言检查不越位）",
    candidate: candidate({ id: "F316", title: "查询参数编码错误", severity: undefined }),
    outputLanguage: "zh",
    expectedStage: "SCHEMA_INVALID",
  },
  {
    name: "zh：无证据中文候选过语言门后记 NO_EVIDENCE",
    candidate: candidate({ id: "F317", title: "查询参数编码错误", evidence: [] }),
    outputLanguage: "zh",
    expectedStage: "NO_EVIDENCE",
  },
];

describe.each(ALIGNMENT_CASES)("两侧门对齐（#55）：%s", ({ candidate: caseCandidate, outputLanguage, expectedStage }) => {
  it("同输入同输出：GateOutput 逐字段相等 + 形态侧写", () => {
    const input = gateInput(caseCandidate, outputLanguage);
    const output = applyDshGate(input as DshGateInput);

    // 对齐主断言：DSH 门 ≡ 根侧冻结门（手写拷贝的漂移在此红灯）
    expect(output).toEqual(applyRootGate(input as RootGateInput));
    if (expectedStage !== undefined) {
      expect(output.findings).toEqual([]);
      expect(output.rejections).toHaveLength(1);
      expect(output.rejections[0]?.stage).toBe(expectedStage);
    } else {
      expect(output.rejections).toEqual([]);
      expect(output.findings).toHaveLength(1);
    }
  });
});

describe("两侧门对齐（#55）：边界", () => {
  it("非法语言值：两侧同抛单源校验错误（resolveOutputLanguage 值导入单源）", () => {
    const input = gateInput(VALID_CANDIDATE, "fr" as OutputLanguage);
    expect(() => applyRootGate(input as RootGateInput)).toThrow(
      'outputLanguage must be "en" or "zh" (got "fr")',
    );
    expect(() => applyDshGate(input as DshGateInput)).toThrow(
      'outputLanguage must be "en" or "zh" (got "fr")',
    );
  });
});

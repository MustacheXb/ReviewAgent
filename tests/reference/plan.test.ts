import { describe, expect, it } from "vitest";
import {
  expandReferencePlan,
  referenceUnitKeyPath,
  validateReferencePlan,
  type ClaudeCodeReferencePlan,
} from "../../src/reference/plan.js";
import { CLAUDE_CODE_PROMPT_TEMPLATE_VERSION } from "../../src/reference/prompt.js";
import { referenceCleanCase, referenceMainCase, referencePlan } from "./helpers.js";

/**
 * 外部参照计划（Ticket 13）：校验 fail fast + 展开纯函数——
 * 源选择 / caseFilter / 每源限量 / rep 展开（无 config 维度 = 单列）。
 * allowedConfigs 不参与参照入样（A–E 矩阵宇宙纪律不约束外部参照）。
 */

describe("validateReferencePlan", () => {
  it("缺省计划合法", () => {
    expect(() => validateReferencePlan(referencePlan())).not.toThrow();
  });

  it("referenceId 非法：空 / 首字符非字母数字 / 超长", () => {
    for (const bad of ["", "-abc", "a b", "a".repeat(101)]) {
      expect(() => validateReferencePlan(referencePlan({ referenceId: bad }))).toThrow(
        /referenceId/,
      );
    }
  });

  it("sources 非法：空 / 未知源 / 重复", () => {
    expect(() => validateReferencePlan(referencePlan({ sources: [] }))).toThrow(/sources/);
    expect(() =>
      validateReferencePlan(
        referencePlan({
          sources: ["defects4j", "typo"] as unknown as ClaudeCodeReferencePlan["sources"],
        }),
      ),
    ).toThrow(/sources entries/);
    expect(() =>
      validateReferencePlan(referencePlan({ sources: ["defects4j", "defects4j"] })),
    ).toThrow(/duplicates/);
  });

  it("reps / maxTurns 非正整数拒绝", () => {
    expect(() => validateReferencePlan(referencePlan({ reps: 0 }))).toThrow(/reps/);
    expect(() => validateReferencePlan(referencePlan({ maxTurns: 0 }))).toThrow(/maxTurns/);
  });

  it("model 模式校验（注入防线与 client 层一致）", () => {
    expect(() => validateReferencePlan(referencePlan({ model: "sonnet; rm" }))).toThrow(/model/);
    expect(() => validateReferencePlan(referencePlan({ model: "" }))).toThrow(/model/);
  });

  it("model 模型族校验：Claude 系（claude-* 或 sonnet/opus/haiku 别名）之外拒绝", () => {
    for (const foreign of [
      "deepseek-v4-flash",
      "gpt-5.2-pro",
      "minimax-m3",
      "claude-",
      "claude",
      "SONNET",
    ]) {
      expect(() => validateReferencePlan(referencePlan({ model: foreign }))).toThrow(
        /Claude-family/,
      );
    }
    for (const allowed of ["sonnet", "opus", "haiku", "claude-sonnet-4-5-20250929"]) {
      expect(() => validateReferencePlan(referencePlan({ model: allowed }))).not.toThrow();
    }
  });

  it("promptTemplateVersion 非空", () => {
    expect(() =>
      validateReferencePlan(referencePlan({ promptTemplateVersion: "  " })),
    ).toThrow(/promptTemplateVersion/);
  });

  it("perSourceLimit：null 合法、非正整数拒绝", () => {
    expect(() => validateReferencePlan(referencePlan({ perSourceLimit: null }))).not.toThrow();
    expect(() => validateReferencePlan(referencePlan({ perSourceLimit: 0 }))).toThrow(
      /perSourceLimit/,
    );
  });

  it("caseFilter：空串 / 重复拒绝", () => {
    expect(() => validateReferencePlan(referencePlan({ caseFilter: [""] }))).toThrow(/caseFilter/);
    expect(() =>
      validateReferencePlan(referencePlan({ caseFilter: ["a", "a"] })),
    ).toThrow(/duplicates/);
  });

  it("非对象输入拒绝", () => {
    expect(() => validateReferencePlan(null as unknown as ClaudeCodeReferencePlan)).toThrow(
      /ClaudeCodeReferencePlan/,
    );
  });
});

describe("expandReferencePlan", () => {
  const mainA = referenceMainCase("expand-a");
  const mainB = referenceMainCase("expand-b");
  const clean = referenceCleanCase("expand-clean");

  it("全源展开：全部 case 入样，顺序 case → rep 1..N", () => {
    const expanded = expandReferencePlan(referencePlan({ reps: 2 }), [mainA, mainB, clean]);
    expect(expanded.cases.map((c) => c.caseId)).toEqual(["expand-a", "expand-b", "expand-clean"]);
    expect(expanded.units).toEqual([
      { source: "defects4j", caseId: "expand-a", rep: 1 },
      { source: "defects4j", caseId: "expand-a", rep: 2 },
      { source: "defects4j", caseId: "expand-b", rep: 1 },
      { source: "defects4j", caseId: "expand-b", rep: 2 },
      { source: "clean-mr", caseId: "expand-clean", rep: 1 },
      { source: "clean-mr", caseId: "expand-clean", rep: 2 },
    ]);
    expect(expanded.skipped).toEqual([]);
  });

  it("源选择：未选源的 case 留痕 SOURCE_NOT_SELECTED", () => {
    const expanded = expandReferencePlan(
      referencePlan({ sources: ["defects4j"] }),
      [mainA, clean],
    );
    expect(expanded.cases.map((c) => c.caseId)).toEqual(["expand-a"]);
    expect(expanded.skipped).toEqual([
      { source: "clean-mr", caseId: "expand-clean", reason: "SOURCE_NOT_SELECTED" },
    ]);
  });

  it("caseFilter：命中入样、未命中留痕 CASE_FILTERED_OUT", () => {
    const expanded = expandReferencePlan(
      referencePlan({ caseFilter: ["expand-b"] }),
      [mainA, mainB],
    );
    expect(expanded.cases.map((c) => c.caseId)).toEqual(["expand-b"]);
    expect(expanded.skipped).toEqual([
      { source: "defects4j", caseId: "expand-a", reason: "CASE_FILTERED_OUT" },
    ]);
  });

  it("perSourceLimit：每源限额内入样、超额留痕 SOURCE_LIMIT_REACHED", () => {
    const extra = [
      referenceMainCase("expand-c"),
      referenceMainCase("expand-d"),
    ];
    const expanded = expandReferencePlan(
      referencePlan({ sources: ["defects4j"], perSourceLimit: 2 }),
      [mainA, ...extra, clean],
    );
    expect(expanded.cases.map((c) => c.caseId)).toEqual(["expand-a", "expand-c"]);
    expect(expanded.skipped).toEqual([
      { source: "defects4j", caseId: "expand-d", reason: "SOURCE_LIMIT_REACHED" },
      { source: "clean-mr", caseId: "expand-clean", reason: "SOURCE_NOT_SELECTED" },
    ]);
  });

  it("allowedConfigs 不参与参照入样（外部参照不查 A–E 矩阵宇宙）", () => {
    const restricted = {
      ...mainA,
      labels: { ...mainA.labels, allowedConfigs: ["A"] as const },
    };
    const expanded = expandReferencePlan(referencePlan(), [restricted]);
    expect(expanded.cases).toHaveLength(1);
    expect(expanded.units).toHaveLength(1);
  });

  it("计划非法即抛（展开前校验）", () => {
    expect(() => expandReferencePlan(referencePlan({ reps: 0 }), [mainA])).toThrow(/reps/);
  });
});

describe("referenceUnitKeyPath", () => {
  it("合法 caseId 原样；非法字符替换为下划线（路径安全）", () => {
    expect(
      referenceUnitKeyPath({ source: "defects4j", caseId: "Chart-1.p001", rep: 2 }),
    ).toBe("defects4j/Chart-1.p001/rep-2");
    expect(
      referenceUnitKeyPath({ source: "defects4j", caseId: "weird/id case", rep: 1 }),
    ).toBe("defects4j/weird_id_case/rep-1");
  });
});

describe("模板版本随计划留档", () => {
  it("计划工厂使用当前模板版本（续跑兼容守卫材料）", () => {
    expect(referencePlan().promptTemplateVersion).toBe(CLAUDE_CODE_PROMPT_TEMPLATE_VERSION);
  });
});

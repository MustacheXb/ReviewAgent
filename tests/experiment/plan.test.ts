import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_SOURCES,
  configsForCase,
  expandPlan,
  runUnitKeyPath,
  validateExperimentPlan,
} from "../../src/experiment/plan.js";
import { experimentCleanCase, experimentMainCase, experimentPlan } from "./helpers.js";

/**
 * 实验计划（Ticket 12）：校验 fail fast + 展开（入样过滤 → allowedConfigs 求交 → rep 展开）。
 * 验收（issue #13）：成本纪律——子集/限量/配置过滤经计划显式表达，被排除 case 全部留痕。
 */

describe("validateExperimentPlan（fail fast）", () => {
  it("接受缺省计划", () => {
    expect(() => validateExperimentPlan(experimentPlan())).not.toThrow();
  });

  it("拒绝非法 experimentId（字符集与长度）", () => {
    expect(() =>
      validateExperimentPlan(experimentPlan({ experimentId: "bad id!" })),
    ).toThrow(/experimentId/);
    expect(() => validateExperimentPlan(experimentPlan({ experimentId: "" }))).toThrow(
      /experimentId/,
    );
    expect(() =>
      validateExperimentPlan(experimentPlan({ experimentId: "x".repeat(101) })),
    ).toThrow(/experimentId/);
  });

  it("拒绝空/重复/未知 sources", () => {
    expect(() => validateExperimentPlan(experimentPlan({ sources: [] }))).toThrow(/sources/);
    expect(() =>
      validateExperimentPlan(experimentPlan({ sources: ["defects4j", "defects4j"] })),
    ).toThrow(/duplicates/);
    expect(() =>
      validateExperimentPlan(experimentPlan({ sources: ["github"] as never })),
    ).toThrow(/sources entries/);
  });

  it("拒绝空/重复/未知 configs", () => {
    expect(() => validateExperimentPlan(experimentPlan({ configs: [] }))).toThrow(/configs/);
    expect(() => validateExperimentPlan(experimentPlan({ configs: ["A", "A"] }))).toThrow(
      /duplicates/,
    );
    expect(() => validateExperimentPlan(experimentPlan({ configs: ["F"] as never }))).toThrow(
      /configs entries/,
    );
  });

  it("拒绝非法 reps / verifier / model / limit / caseFilter / 人检参数", () => {
    expect(() => validateExperimentPlan(experimentPlan({ reps: 0 }))).toThrow(/reps/);
    expect(() => validateExperimentPlan(experimentPlan({ reps: 1.5 }))).toThrow(/reps/);
    expect(() =>
      validateExperimentPlan(experimentPlan({ verifier: "maybe" as never })),
    ).toThrow(/verifier/);
    expect(() =>
      validateExperimentPlan(experimentPlan({ model: "gpt-9" as never })),
    ).toThrow(/model/);
    expect(() => validateExperimentPlan(experimentPlan({ perSourceLimit: 0 }))).toThrow(
      /perSourceLimit/,
    );
    expect(() => validateExperimentPlan(experimentPlan({ caseFilter: ["", "a"] }))).toThrow(
      /caseFilter/,
    );
    expect(() => validateExperimentPlan(experimentPlan({ caseFilter: ["a", "a"] }))).toThrow(
      /duplicates/,
    );
    expect(() => validateExperimentPlan(experimentPlan({ humanReviewRate: 0 }))).toThrow(
      /humanReviewRate/,
    );
    expect(() => validateExperimentPlan(experimentPlan({ humanReviewRate: 1.1 }))).toThrow(
      /humanReviewRate/,
    );
    expect(() =>
      validateExperimentPlan(experimentPlan({ humanReviewSeed: "  " })),
    ).toThrow(/humanReviewSeed/);
  });

  it("成本守卫：deepseek-v4-pro 必须搭配 highRiskOnly", () => {
    expect(() =>
      validateExperimentPlan(experimentPlan({ model: "deepseek-v4-pro", highRiskOnly: false })),
    ).toThrow(/highRiskOnly/);
    expect(() =>
      validateExperimentPlan(experimentPlan({ model: "deepseek-v4-pro", highRiskOnly: true })),
    ).not.toThrow();
  });
});

describe("expandPlan（入样过滤 → 配置求交 → rep 展开）", () => {
  it("单元顺序 = case → config（A–E 序）→ rep 1..N", () => {
    const expanded = expandPlan(
      experimentPlan({ configs: ["C", "A"], reps: 2 }),
      [experimentMainCase("case-1")],
    );
    expect(expanded.units).toEqual([
      { source: "defects4j", caseId: "case-1", configId: "A", rep: 1 },
      { source: "defects4j", caseId: "case-1", configId: "A", rep: 2 },
      { source: "defects4j", caseId: "case-1", configId: "C", rep: 1 },
      { source: "defects4j", caseId: "case-1", configId: "C", rep: 2 },
    ]);
    expect(expanded.skipped).toEqual([]);
    expect(expanded.cases.map((mrCase) => mrCase.caseId)).toEqual(["case-1"]);
  });

  it("未选源留痕 SOURCE_NOT_SELECTED", () => {
    const expanded = expandPlan(
      experimentPlan({ sources: ["defects4j"] }),
      [experimentCleanCase("clean-1"), experimentMainCase("main-1")],
    );
    expect(expanded.cases.map((mrCase) => mrCase.caseId)).toEqual(["main-1"]);
    expect(expanded.skipped).toEqual([
      { source: "clean-mr", caseId: "clean-1", reason: "SOURCE_NOT_SELECTED" },
    ]);
  });

  it("caseFilter 精确过滤留痕 CASE_FILTERED_OUT", () => {
    const expanded = expandPlan(
      experimentPlan({ caseFilter: ["main-2"] }),
      [experimentMainCase("main-1"), experimentMainCase("main-2")],
    );
    expect(expanded.cases.map((mrCase) => mrCase.caseId)).toEqual(["main-2"]);
    expect(expanded.skipped.map((entry) => entry.reason)).toEqual(["CASE_FILTERED_OUT"]);
  });

  it("perSourceLimit 按源计数留痕 SOURCE_LIMIT_REACHED", () => {
    const expanded = expandPlan(
      experimentPlan({ perSourceLimit: 1 }),
      [
        experimentMainCase("d-1"),
        experimentMainCase("d-2"),
        experimentCleanCase("c-1"),
        experimentCleanCase("c-2"),
      ],
    );
    expect(expanded.cases.map((mrCase) => mrCase.caseId)).toEqual(["d-1", "c-1"]);
    expect(expanded.skipped.map((entry) => `${entry.caseId}:${entry.reason}`)).toEqual([
      "d-2:SOURCE_LIMIT_REACHED",
      "c-2:SOURCE_LIMIT_REACHED",
    ]);
  });

  it("highRiskOnly 仅入样 riskClass=High，其余留痕", () => {
    const highCase = experimentMainCase("high-1", { labels: { riskClass: "High" } });
    const lowCase = experimentMainCase("low-1", { labels: { riskClass: "Low" } });
    const expanded = expandPlan(experimentPlan({ highRiskOnly: true }), [lowCase, highCase]);
    expect(expanded.cases.map((mrCase) => mrCase.caseId)).toEqual(["high-1"]);
    expect(expanded.skipped.map((entry) => entry.reason)).toEqual(["RISK_CLASS_FILTERED_OUT"]);
  });

  it("MSB allowedConfigs=[C,E] 与计划配置求交（无交集留痕 NO_CONFIG_OVERLAP）", () => {
    const msbCase = experimentMainCase("msb-1", {
      labels: { source: "msb-java", allowedConfigs: ["C", "E"] },
    });
    const overlap = expandPlan(experimentPlan({ configs: ["A", "C", "E"] }), [msbCase]);
    expect(overlap.units.map((unit) => unit.configId)).toEqual(["C", "E"]);
    expect(overlap.skipped).toEqual([]);
    const noOverlap = expandPlan(experimentPlan({ configs: ["A", "B"] }), [msbCase]);
    expect(noOverlap.units).toEqual([]);
    expect(noOverlap.skipped.map((entry) => entry.reason)).toEqual(["NO_CONFIG_OVERLAP"]);
    expect(noOverlap.cases).toEqual([]);
  });

  it("configsForCase 返回计划配置 ∩ allowedConfigs（保持计划顺序）", () => {
    const caseAB = experimentMainCase("ab-1", { labels: { allowedConfigs: ["B", "A"] } });
    expect(configsForCase(experimentPlan({ configs: ["A", "C", "B"] }), caseAB)).toEqual([
      "A",
      "B",
    ]);
  });

  it("非法计划在展开入口即抛（不产出半份单元）", () => {
    expect(() => expandPlan(experimentPlan({ reps: 0 }), [])).toThrow(/reps/);
  });
});

describe("runUnitKeyPath（目录骨架）", () => {
  it("sanitizes 不安全字符的 caseId", () => {
    expect(
      runUnitKeyPath({ source: "defects4j", caseId: "Chart-3/path\\to", configId: "A", rep: 2 }),
    ).toBe("defects4j/Chart-3_path_to/A/rep-2");
  });

  it("EXPERIMENT_SOURCES 覆盖四源", () => {
    expect(EXPERIMENT_SOURCES).toEqual(["defects4j", "vul4j", "msb-java", "clean-mr"]);
  });
});

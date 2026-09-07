import { describe, expect, it } from "vitest";
import { DEFECT_NATURES } from "../../src/dataset/defect-nature.js";
import { isCweId, resolveCweNature } from "../../src/dataset/vul4j/cwe-nature-map.js";

/** 数据集实测出现的 24 个可映射 CWE（66 条 CWE 标注条目共 25 个不同 CWE，
 *  第 25 个 CWE-19 无足够信号不映射，见下方未命中用例） */
const DATASET_CWES = [
  "CWE-20", "CWE-22", "CWE-74", "CWE-77", "CWE-78", "CWE-79",
  "CWE-611", "CWE-502",
  "CWE-200", "CWE-254", "CWE-264", "CWE-269", "CWE-284", "CWE-287",
  "CWE-863", "CWE-918", "CWE-352",
  "CWE-310", "CWE-332", "CWE-345", "CWE-522", "CWE-532",
  "CWE-770", "CWE-835",
] as const;

describe("resolveCweNature（CVE/CWE → 缺陷性质映射表）", () => {
  it("数据集实测的 24 个 CWE 全部命中且映射值在 DEFECT_NATURES 词表内", () => {
    for (const cweId of DATASET_CWES) {
      const resolution = resolveCweNature(cweId);
      expect(resolution.matched, cweId).toBe(true);
      expect(DEFECT_NATURES).toContain(resolution.nature);
    }
  });

  it("注入/访问控制/加密类 → SECURITY；资源耗尽类（CWE-770/835）→ RESOURCE", () => {
    for (const cweId of ["CWE-20", "CWE-22", "CWE-79", "CWE-611", "CWE-502", "CWE-287", "CWE-918", "CWE-532"]) {
      expect(resolveCweNature(cweId)).toEqual({ cweId, nature: "SECURITY", matched: true });
    }
    expect(resolveCweNature("CWE-770")).toEqual({ cweId: "CWE-770", nature: "RESOURCE", matched: true });
    expect(resolveCweNature("CWE-835")).toEqual({ cweId: "CWE-835", nature: "RESOURCE", matched: true });
  });

  it("未命中（CWE-19 废弃泛化类 / 未知编号 / 非法标签）→ 显式降级 OTHER + matched=false，不静默", () => {
    for (const cweId of ["CWE-19", "CWE-9999", "Not Mapping", "", "cwe-20", "CVE-2026-1234"]) {
      const resolution = resolveCweNature(cweId);
      expect(resolution).toEqual({ cweId, nature: "OTHER", matched: false });
    }
  });

  it("健壮性预置（数据集未出现）：CWE-476→NULL_SAFETY、CWE-362→CONCURRENCY、CWE-787→BOUNDARY、CWE-754→EXCEPTION、CWE-404→RESOURCE", () => {
    expect(resolveCweNature("CWE-476").nature).toBe("NULL_SAFETY");
    expect(resolveCweNature("CWE-362").nature).toBe("CONCURRENCY");
    expect(resolveCweNature("CWE-787").nature).toBe("BOUNDARY");
    expect(resolveCweNature("CWE-754").nature).toBe("EXCEPTION");
    expect(resolveCweNature("CWE-404").nature).toBe("RESOURCE");
  });

  it("返回的 cweId 原样透传（留痕可溯源）", () => {
    expect(resolveCweNature("CWE-20").cweId).toBe("CWE-20");
    expect(resolveCweNature("Not Mapping").cweId).toBe("Not Mapping");
  });
});

describe("isCweId", () => {
  it("形如 CWE-N 才是可用标签", () => {
    expect(isCweId("CWE-20")).toBe(true);
    expect(isCweId("CWE-1")).toBe(true);
    expect(isCweId("Not Mapping")).toBe(false);
    expect(isCweId("")).toBe(false);
    expect(isCweId("cwe-20")).toBe(false);
  });
});

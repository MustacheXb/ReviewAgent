import { describe, expect, it } from "vitest";
import { parseVul4jDatasetCsv, VUL4J_DATASET_CSV_URL } from "../../src/dataset/vul4j/csv.js";

const HEADER =
  "no,vul_id,cve_id,cwe_id,cwe_name,owasp_id,repo_slug,human_patch,build_system," +
  "compliance_level,failing_tests,compile_cmd,test_all_cmd,test_cmd,cmd_options," +
  "failing_module,src,test,src_classes,test_classes,warning";

/** 构造一条 21 列数据行（未指定的列留空） */
function dataRow(vulId: string, overrides: Record<number, string> = {}): string {
  const cells = Array.from({ length: 21 }, () => "");
  cells[0] = "1";
  cells[1] = vulId;
  cells[2] = "CVE-2026-1234";
  cells[3] = "CWE-20";
  cells[4] = "Improper Input Validation";
  cells[5] = "none";
  cells[6] = "example/codec";
  cells[7] = `https://github.com/example/codec/commit/${"a".repeat(40)}`;
  cells[10] = "com.example.codec.DecoderTest#testNullRejected";
  for (const [index, value] of Object.entries(overrides)) {
    cells[Number(index)] = value;
  }
  return cells.join(",");
}

describe("parseVul4jDatasetCsv（Vul4J 数据集 CSV 解析）", () => {
  it("合法行 → 仅提取 POC1 消费的 9 个字段（failing_tests 取第 11 列）", () => {
    const parsed = parseVul4jDatasetCsv(`${HEADER}\n${dataRow("VUL4J-1")}\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value).toEqual([
      {
        no: 1,
        vulId: "VUL4J-1",
        cveId: "CVE-2026-1234",
        cweId: "CWE-20",
        cweName: "Improper Input Validation",
        owaspId: "none",
        repoSlug: "example/codec",
        humanPatch: `https://github.com/example/codec/commit/${"a".repeat(40)}`,
        failingTests: "com.example.codec.DecoderTest#testNullRejected",
      },
    ]);
  });

  it("RFC 4180：双引号字段内的逗号/转义引号/换行原样保留", () => {
    const row = dataRow("VUL4J-2", {
      4: '"Improper, ""Quoted"" Validation"',
      10: '"first line\nsecond line"',
    });
    const parsed = parseVul4jDatasetCsv(`${HEADER}\n${row}\n`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value[0]?.cweName).toBe('Improper, "Quoted" Validation');
      expect(parsed.value[0]?.failingTests).toBe("first line\nsecond line");
      expect(parsed.value).toHaveLength(1);
    }
  });

  it("SpotBugs 型 ID（VUL4J-80-S）与 compare URL 合法；CWE 空/Not Mapping 原样透传", () => {
    const row = dataRow("VUL4J-80-S", {
      3: "",
      7: `https://github.com/example/codec/compare/${"1".repeat(40)}..${"2".repeat(40)}`,
    });
    const parsed = parseVul4jDatasetCsv(`${HEADER}\n${row}\n`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value[0]?.vulId).toBe("VUL4J-80-S");
      expect(parsed.value[0]?.cweId).toBe("");
    }
  });

  it("表头漂移（列序/列名/列数）→ CSV_HEADER_DRIFT 显式报错", () => {
    const reordered = HEADER.split(",").map((c, i) => (i === 1 ? "cwe_id" : c)).join(",");
    for (const header of [reordered, HEADER.replace("vul_id", "vulid"), `${HEADER},extra_col`]) {
      const parsed = parseVul4jDatasetCsv(`${header}\n${dataRow("VUL4J-1")}\n`);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe("CSV_HEADER_DRIFT");
      }
    }
  });

  it.each([
    ["空文本", ""],
    ["仅空白", "   \n"],
    ["仅表头", HEADER],
    ["无数据行（尾随空行）", `${HEADER}\n`],
  ])("%s → INVALID_CSV", (_name, text) => {
    const parsed = parseVul4jDatasetCsv(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("INVALID_CSV");
    }
  });

  it("数据行列数不足 → INVALID_CSV_ROW 列数错误", () => {
    const shortRow = dataRow("VUL4J-1").split(",").slice(0, 18).join(",");
    const parsed = parseVul4jDatasetCsv(`${HEADER}\n${shortRow}\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("INVALID_CSV_ROW");
      expect(parsed.error.message).toContain("≠ 21");
    }
  });

  it("vul_id 非法 → INVALID_VUL_ID；human_patch 非 GitHub URL → INVALID_PATCH_URL", () => {
    const badVulId = parseVul4jDatasetCsv(`${HEADER}\n${dataRow("VUL-1")}\n`);
    expect(badVulId.ok).toBe(false);
    if (!badVulId.ok) {
      expect(badVulId.error.code).toBe("INVALID_VUL_ID");
    }

    const badUrl = parseVul4jDatasetCsv(`${HEADER}\n${dataRow("VUL4J-1", { 7: "https://gitlab.com/x/y/commit/abc" })}\n`);
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) {
      expect(badUrl.error.code).toBe("INVALID_PATCH_URL");
    }
  });

  it("官方 CSV 直链常量与实测核验一致（raw.githubusercontent master）", () => {
    expect(VUL4J_DATASET_CSV_URL).toBe(
      "https://raw.githubusercontent.com/tuhh-softsec/Vul4J/master/dataset/vul4j_dataset.csv",
    );
  });
});

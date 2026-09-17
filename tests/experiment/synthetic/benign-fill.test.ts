import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../../../src/dataset/diff/apply-unified-diff.js";
import { applyUnifiedDiff } from "../../../src/dataset/diff/apply-unified-diff.js";
import { measureDiffBoundary } from "../../../src/dataset/mr-boundary-filter.js";
import { generateBenignFill } from "../../../src/experiment/synthetic/benign-fill.js";
import { PARSER_PATH, REPORT_PATH, SERVICE_PATH, snapshotV2 } from "./fixtures.js";

const CASE_FILES = [PARSER_PATH, SERVICE_PATH, REPORT_PATH];
const FORBIDDEN = new Set(CASE_FILES);

describe("generateBenignFill（确定性）", () => {
  it("同参数同输出（diff / edits / filesTouched / diffLines 全等）", () => {
    const first = generateBenignFill(snapshotV2(), FORBIDDEN, { targetFiles: 3, targetDiffLines: 16 }, "seed-x");
    const second = generateBenignFill(snapshotV2(), FORBIDDEN, { targetFiles: 3, targetDiffLines: 16 }, "seed-x");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.value).toEqual(second.value);
  });

  it("快照不被修改（纯函数：base 内容逐字节不变）", () => {
    const base = snapshotV2();
    const before = JSON.stringify(base);
    const result = generateBenignFill(base, FORBIDDEN, { targetFiles: 3, targetDiffLines: 16 }, "seed-x");
    expect(result.ok).toBe(true);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("generateBenignFill（四类机械编辑与规模达标）", () => {
  it("四类编辑齐备（注释 / javadoc / 局部重命名 / 日志），双维目标均达标", () => {
    const result = generateBenignFill(snapshotV2(), FORBIDDEN, { targetFiles: 3, targetDiffLines: 16 }, "seed-kinds");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const kinds = new Set(result.value.edits.map((edit) => edit.kind));
    expect(kinds).toEqual(new Set(["comment", "javadoc", "rename", "log"]));
    expect(result.value.filesTouched.length).toBeGreaterThanOrEqual(3);
    expect(result.value.diffLines).toBeGreaterThanOrEqual(16);
  });

  it("填充只触碰与案例文件不相交的文件", () => {
    const result = generateBenignFill(snapshotV2(), FORBIDDEN, { targetFiles: 3, targetDiffLines: 16 }, "seed-disjoint");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    for (const edit of result.value.edits) {
      expect(CASE_FILES).not.toContain(edit.file);
    }
  });

  it("产出的 diff 可独立解析，度量口径与 diffLines / filesTouched 一致", () => {
    const result = generateBenignFill(snapshotV2(), FORBIDDEN, { targetFiles: 3, targetDiffLines: 16 }, "seed-metric");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const metrics = measureDiffBoundary(result.value.diff);
    expect(metrics.ok).toBe(true);
    if (!metrics.ok) {
      return;
    }
    expect(metrics.value.changedLines).toBe(result.value.diffLines);
    expect(metrics.value.files).toBe(result.value.filesTouched.length);
  });

  it("diff 干净套用回快照（严格模式逐字匹配通过）", () => {
    const base = snapshotV2();
    const result = generateBenignFill(base, FORBIDDEN, { targetFiles: 3, targetDiffLines: 16 }, "seed-apply");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const applied = applyUnifiedDiff(base, result.value.diff);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    // 每个被触碰文件的内容确实发生变化
    for (const path of Object.keys(applied.value.sources)) {
      expect(applied.value.sources[path]).not.toBe(base[path]);
    }
    // 未触碰文件不在产出里
    expect(applied.value.sources[PARSER_PATH]).toBeUndefined();
  });
});

describe("generateBenignFill（局部重命名的封闭性）", () => {
  /** G1/G2 共享标识符 deltaValue（非快照唯一 → 不可重命名）；F 有唯一标识符 omegaValue0–2 */
  function renameSnapshot(): SourceSnapshot {
    const classBody = (cls: string, identifierOf: (index: number) => string) => {
      const methods = Array.from({ length: 3 }, (_, index) => {
        const id = identifierOf(index);
        return [
          `    public int work${index}(int input) {`,
          `        int ${id} = input * ${index + 1};`,
          `        if (${id} > 100) {`,
          `            return ${id};`,
          `        }`,
          `        return ${id} + 1;`,
          `    }`,
        ].join("\n");
      });
      return ["package p;", "", `public class ${cls} {`, ...methods, "}", ""].join("\n");
    };
    return {
      "src/G1.java": classBody("G1", () => "deltaValue"),
      "src/G2.java": classBody("G2", () => "deltaValue"),
      "src/F.java": classBody("F", (index) => `omegaValue${index}`),
    };
  }

  it("跨文件同名标识符不被重命名；唯一标识符文件内全量替换", () => {
    const base = renameSnapshot();
    const result = generateBenignFill(base, new Set(), { targetFiles: 1, targetDiffLines: 16 }, "seed-rename");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 重命名编辑只发生在 F（唯一候选所在文件）
    const renameEdits = result.value.edits.filter((edit) => edit.kind === "rename");
    expect(renameEdits.length).toBeGreaterThanOrEqual(1);
    for (const edit of renameEdits) {
      expect(edit.file).toBe("src/F.java");
    }
    const applied = applyUnifiedDiff(base, result.value.diff);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    const merged: SourceSnapshot = { ...base, ...applied.value.sources };
    // 每条重命名的标识符：文件内无残留、新名在场（独立从声明行提取标识符）
    for (const edit of renameEdits) {
      const declLine = base[edit.file]!.split("\n")[edit.line - 1]!;
      const identifier = /int (\w+) = /.exec(declLine)![1]!;
      expect(merged[edit.file]).not.toMatch(new RegExp(`\\b${identifier}\\b`));
      expect(merged[edit.file]).toContain(`${identifier}Filled`);
    }
    // 共享标识符原样保留（G1/G2 未被重命名波及）
    expect(merged["src/G1.java"]).toContain("deltaValue");
    expect(merged["src/G2.java"]).toContain("deltaValue");
    expect(merged["src/G1.java"]).not.toContain("Filled");
    expect(merged["src/G2.java"]).not.toContain("Filled");
  });
});

describe("generateBenignFill（目标与耗尽）", () => {
  it("零目标：空 diff、零编辑、零触碰", () => {
    const result = generateBenignFill(snapshotV2(), FORBIDDEN, { targetFiles: 0, targetDiffLines: 0 }, "seed-zero");
    expect(result).toEqual({
      ok: true,
      value: { diff: "", edits: [], filesTouched: [], diffLines: 0 },
    });
  });

  it("候选耗尽：显式失败（不静默短缺），含进度与目标", () => {
    const result = generateBenignFill(snapshotV2(), FORBIDDEN, { targetFiles: 99, targetDiffLines: 0 }, "seed-exhaust");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_FILL_EXHAUSTED");
    expect(result.error.message).toContain("99");
  });

  it.each([
    { name: "文件数为负", targets: { targetFiles: -1, targetDiffLines: 5 } },
    { name: "文件数非整数", targets: { targetFiles: 1.5, targetDiffLines: 5 } },
    { name: "行数为负", targets: { targetFiles: 1, targetDiffLines: -2 } },
  ])("非法目标（$name）：fail fast", ({ targets }) => {
    const result = generateBenignFill(snapshotV2(), FORBIDDEN, targets, "seed-invalid");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_INPUT_INVALID");
  });

  it("候选文件全部被禁改：直接耗尽", () => {
    const everythingForbidden = new Set(Object.keys(snapshotV2()));
    const result = generateBenignFill(snapshotV2(), everythingForbidden, { targetFiles: 1, targetDiffLines: 1 }, "seed-none");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_FILL_EXHAUSTED");
  });
});

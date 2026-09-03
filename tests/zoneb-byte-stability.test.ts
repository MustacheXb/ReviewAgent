import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildZoneB } from "../src/zoneb/zone-b-builder.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";

const SAMPLE_REPO_PATH = fileURLToPath(new URL("./fixtures/sample-java-repo", import.meta.url));

const CHANGED_FILES = ["src/main/java/com/example/math/MathUtils.java"];

/**
 * 工单 #4 验收标准（Zone B 静态构造）：
 * - 同一仓库两次构造字节一致（确定性）；
 * - 不依赖构建环境、不调用 LLM（构造输入只有仓库快照 + 变更文件清单；
 *   fixture 无任何构建文件，"Build file: none detected" 即为运行证据）；
 * - Symbol Index 签名级（不含函数体），范围按包/模块圈定。
 */
describe("buildZoneB — static deterministic construction", () => {
  it("produces byte-identical output when constructing Zone B twice for the same repository", async () => {
    const first = await buildZoneB({ repoPath: SAMPLE_REPO_PATH, changedFiles: CHANGED_FILES, budgetChars: 16_000 });
    const second = await buildZoneB({ repoPath: SAMPLE_REPO_PATH, changedFiles: CHANGED_FILES, budgetChars: 16_000 });

    expect(second.content).toBe(first.content);
    expect(second.record).toEqual(first.record);
    // 字节稳定性的另一面：无绝对路径、无反斜杠、无时间戳类内容
    expect(first.content).not.toContain(SAMPLE_REPO_PATH);
    expect(first.content).not.toContain("\\");
  });

  it("contains repo identity, repo map (directory tree) and package structure", async () => {
    const zoneB = await buildZoneB({ repoPath: SAMPLE_REPO_PATH, changedFiles: CHANGED_FILES, budgetChars: 16_000 });

    expect(zoneB.content).toContain("Repo name: sample-java-repo");
    expect(zoneB.content).toContain("Java files: 4");
    expect(zoneB.content).toContain("Build file: none detected");
    expect(zoneB.content).toContain("src/main/java/com/example/math/");
    expect(zoneB.content).toContain("  Calculator.java");
    expect(zoneB.content).toContain("  Main.java");
    expect(zoneB.content).toContain("  MathUtils.java");
    expect(zoneB.content).toContain("com.example.math (3 file(s))");
    expect(zoneB.content).toContain("com.example.util (1 file(s))");
  });

  it("scopes the Symbol Index to the packages of the changed files", async () => {
    const zoneB = await buildZoneB({ repoPath: SAMPLE_REPO_PATH, changedFiles: CHANGED_FILES, budgetChars: 16_000 });

    expect(zoneB.content).toContain("Scope: packages of changed files (com.example.math)");
    // Repo map / package structure 覆盖全仓，但 Symbol Index 只含变更包的文件
    const symbolIndexSection = zoneB.content.split("## Symbol index")[1] ?? "";
    expect(symbolIndexSection).toContain("src/main/java/com/example/math/MathUtils.java");
    expect(symbolIndexSection).toContain("src/main/java/com/example/math/Calculator.java");
    expect(symbolIndexSection).toContain("src/main/java/com/example/math/Main.java");
    expect(symbolIndexSection).not.toContain("StringUtils.java");
  });

  it("keeps the Symbol Index at signature level (declarations only, no method bodies)", async () => {
    const zoneB = await buildZoneB({ repoPath: SAMPLE_REPO_PATH, changedFiles: CHANGED_FILES, budgetChars: 16_000 });

    // 签名在
    expect(zoneB.content).toContain("public static int sumFirst(int[] values, int count)");
    expect(zoneB.content).toContain("private MathUtils()");
    expect(zoneB.content).toContain("public int total(int[] readings, int count)");
    // 函数体不在（MathUtils.sumFirst / StringUtils.join 的实现语句）
    expect(zoneB.content).not.toContain("sum += values[i]");
    expect(zoneB.content).not.toContain("int sum = 0");
    expect(zoneB.content).not.toContain("builder.append(separator)");
    expect(zoneB.content).not.toContain("return sum");
  });

  it("reports the zone-b layer record with budget accounting", async () => {
    const zoneB = await buildZoneB({ repoPath: SAMPLE_REPO_PATH, changedFiles: CHANGED_FILES, budgetChars: 16_000 });

    expect(zoneB.record.layer).toBe("zone-b");
    expect(zoneB.record.budgetChars).toBe(16_000);
    expect(zoneB.record.contentChars).toBe(zoneB.content.length);
    expect(zoneB.record.truncated).toBe(false);
    expect(zoneB.record.shownEntries).toBe(zoneB.record.totalEntries);
  });

  it("truncates with an explicit in-content notice when the budget is exceeded (no silent drops)", async () => {
    const zoneB = await buildZoneB({ repoPath: SAMPLE_REPO_PATH, changedFiles: CHANGED_FILES, budgetChars: 700 });

    expect(zoneB.record.truncated).toBe(true);
    expect(zoneB.record.shownEntries).toBeLessThan(zoneB.record.totalEntries);
    expect(zoneB.content).toMatch(
      /truncated: showing \d+ of \d+ .+ \(zone B (repo-map|package-structure|symbol-index) budget \d+ chars exceeded\)/,
    );
  });

  it("uses path-derived packages for changed files missing from the snapshot", async () => {
    const zoneB = await buildZoneB({
      repoPath: SAMPLE_REPO_PATH,
      changedFiles: ["src/main/java/com/example/util/Missing.java"],
      budgetChars: 16_000,
    });

    expect(zoneB.content).toContain("Scope: packages of changed files (com.example.util)");
    const symbolIndexSection = zoneB.content.split("## Symbol index")[1] ?? "";
    expect(symbolIndexSection).toContain("src/main/java/com/example/util/StringUtils.java");
    expect(symbolIndexSection).not.toContain("src/main/java/com/example/math/MathUtils.java");
  });
});

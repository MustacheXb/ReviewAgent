/**
 * bin 编译判鲜（#45）：两个产品面 bin（review-agent / review-kernel-host）
 * 的「在位检查」从存在性升级为 mtime 判鲜的单元测试。
 *
 * 背景事故（本票踩到）：kernel-host 编译镜像在位，但 review-llm dist 是
 * #41 时代的陈旧产物——wire.ts `import { profileOf } from "review-llm"` 在
 * 运行时经 node_modules default 条件落到无该导出的 dist/index.js，host
 * 子进程秒死（stdout closed before a response frame）。存在性检查看不见
 * 「源已改、产物旧」；判鲜语义 = 任一源树中最新文件的 mtime 晚于产物
 * mtime 即陈旧。
 */

import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { isCompileStale } from "../../bin/lib/compile-freshness.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "compile-freshness-"));
const past = new Date(Date.now() - 3_600_000);

/** 触碰文件 mtime 到「当前」（比任何过去时间新） */
function touchNow(path: string): void {
  const now = new Date();
  utimesSync(path, now, now);
}

/** 回拨文件 mtime（模拟陈旧产物/源） */
function touchPast(path: string): void {
  utimesSync(path, past, past);
}

function writeSource(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "export {};\n");
  return path;
}

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("isCompileStale — mtime 判鲜（bin 在位检查的升级语义）", () => {
  it("产物缺席 → 陈旧（原 existsSync 语义保留）", () => {
    const srcDir = join(fixtureRoot, "case-absent", "src");
    writeSource(srcDir, "main.ts");
    const outputPath = join(fixtureRoot, "case-absent", "out", "main.js");
    expect(isCompileStale(outputPath, [srcDir])).toBe(true);
  });

  it("产物比全部源新 → 新鲜（温路径不重编）", () => {
    const srcDir = join(fixtureRoot, "case-fresh", "src");
    writeSource(srcDir, "main.ts");
    const outputPath = join(fixtureRoot, "case-fresh", "out", "main.js");
    writeSource(join(fixtureRoot, "case-fresh", "out"), "main.js");
    touchPast(srcDir);
    touchNow(outputPath);
    expect(isCompileStale(outputPath, [srcDir])).toBe(false);
  });

  it("任一源文件比产物新 → 陈旧（编辑源后产物未重建——本票事故形态）", () => {
    const srcDir = join(fixtureRoot, "case-edited", "src");
    const edited = writeSource(srcDir, "wire.ts");
    const outputPath = join(fixtureRoot, "case-edited", "out", "main.js");
    writeSource(join(fixtureRoot, "case-edited", "out"), "main.js");
    touchNow(edited);
    touchPast(outputPath);
    expect(isCompileStale(outputPath, [srcDir])).toBe(true);
  });

  it("嵌套子目录的源同样参与判鲜（递归遍历）", () => {
    const srcDir = join(fixtureRoot, "case-nested", "src");
    const nested = writeSource(join(srcDir, "llm"), "wire.ts");
    const outputPath = join(fixtureRoot, "case-nested", "out", "main.js");
    writeSource(join(fixtureRoot, "case-nested", "out"), "main.js");
    touchNow(nested);
    touchPast(outputPath);
    expect(isCompileStale(outputPath, [srcDir])).toBe(true);
  });

  it("源根缺席 → 不贡献陈旧信号（多根判鲜中允许某根不存在）", () => {
    const srcDir = join(fixtureRoot, "case-missing-root", "src");
    writeSource(srcDir, "main.ts");
    const outputPath = join(fixtureRoot, "case-missing-root", "out", "main.js");
    writeSource(join(fixtureRoot, "case-missing-root", "out"), "main.js");
    touchPast(srcDir);
    touchNow(outputPath);
    const absentRoot = join(fixtureRoot, "case-missing-root", "not-a-dir");
    expect(isCompileStale(outputPath, [srcDir, absentRoot])).toBe(false);
  });

  it("多源根交叉判鲜：跨包源（root src）更新同样使包内镜像判陈旧", () => {
    const ownSrc = join(fixtureRoot, "case-cross", "own", "src");
    const rootSrc = join(fixtureRoot, "case-cross", "repo", "src");
    const editedInRoot = writeSource(rootSrc, "prefetch.ts");
    writeSource(ownSrc, "main.ts");
    const outputPath = join(fixtureRoot, "case-cross", "own", "out", "main.js");
    writeSource(join(fixtureRoot, "case-cross", "own", "out"), "main.js");
    touchNow(editedInRoot);
    touchPast(ownSrc);
    touchPast(outputPath);
    expect(isCompileStale(outputPath, [ownSrc, rootSrc])).toBe(true);
  });

  it("产物 mtime 精确等于最新源 mtime → 新鲜（不严格晚于）", () => {
    const srcDir = join(fixtureRoot, "case-equal", "src");
    const source = writeSource(srcDir, "main.ts");
    const outputPath = join(fixtureRoot, "case-equal", "out", "main.js");
    writeSource(join(fixtureRoot, "case-equal", "out"), "main.js");
    touchPast(source); // 回拨到整毫秒，规避 Date TimeClip 的小数截断噪声
    const sourceMtime = statSync(source).mtimeMs;
    utimesSync(outputPath, new Date(sourceMtime), new Date(sourceMtime));
    expect(isCompileStale(outputPath, [srcDir])).toBe(false);
  });
});

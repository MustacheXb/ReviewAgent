import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseAlignmentGateArgs } from "../../src/experiment/alignment-gate-cli.js";
import { toRunSnapshot } from "../../src/experiment/run-store.js";
import { makeMrCase, makeTruth } from "../metrics/helpers.js";
import { gateRunRecord, gateRunResult, makeGateRunDir } from "./helpers.js";

/** 对齐门 CLI（#31）：参数解析 fail fast + main 退出码契约（PASS/INCONCLUSIVE=0、FAIL=1、用法错误=2） */

describe("parseAlignmentGateArgs", () => {
  it("最小合法参数：两侧必填，噪声侧与输出口径取缺省", () => {
    const parsed = parseAlignmentGateArgs(["--baseline", "runs/b", "--candidate", "runs/c"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.baseline).toBe("runs/b");
    expect(parsed.options.candidate).toBe("runs/c");
    expect(parsed.options.noise).toBeNull();
    expect(parsed.options.out).toBeNull();
    expect(parsed.options.options.metrics).toEqual([
      "lineRecall",
      "linePrecision",
      "totalTokens",
      "cacheHitRate",
    ]);
    expect(parsed.options.options.minSampleCount).toBe(3);
    expect(parsed.options.options.advisorySampleCount).toBe(15);
    expect(parsed.options.options.significanceLevel).toBe(0.05);
    expect(parsed.options.options.temporalPairingHours).toBe(48);
  });

  it("全量旗标：噪声侧 / JSON 落盘 / 指标子集 / 护栏 / 建议阈值 / α / 时点阈值", () => {
    const parsed = parseAlignmentGateArgs([
      "--baseline", "b",
      "--candidate", "c",
      "--noise", "n",
      "--out", "gate.json",
      "--metrics", "lineRecall,totalTokens",
      "--min-sample", "5",
      "--advisory-sample", "20",
      "--alpha", "0.01",
      "--gap-hours", "24",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.noise).toBe("n");
    expect(parsed.options.out).toBe("gate.json");
    expect(parsed.options.options.metrics).toEqual(["lineRecall", "totalTokens"]);
    expect(parsed.options.options.minSampleCount).toBe(5);
    expect(parsed.options.options.advisorySampleCount).toBe(20);
    expect(parsed.options.options.significanceLevel).toBe(0.01);
    expect(parsed.options.options.temporalPairingHours).toBe(24);
  });

  it("共享骨架取值形式：--flag=value 与 --help（message + usage 附文）", () => {
    const inline = parseAlignmentGateArgs(["--baseline=b", "--candidate=c"]);
    expect(inline.ok).toBe(true);
    if (!inline.ok) return;
    expect(inline.options.baseline).toBe("b");

    const help = parseAlignmentGateArgs(["--help"]);
    expect(help.ok).toBe(false);
    if (help.ok) return;
    expect(help.message).toContain("--help");
    expect(help.usage).toContain("--baseline");
  });

  it("用法错误 fail fast：缺必填 / 未知旗标 / 吞值 / 重复旗标 / 非法值", () => {
    const missing = parseAlignmentGateArgs(["--candidate", "c"]);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.message).toContain("--baseline");

    const unknown = parseAlignmentGateArgs(["--baseline", "b", "--candidate", "c", "--frobnicate"]);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.message).toContain("--frobnicate");

    const swallowed = parseAlignmentGateArgs(["--baseline", "--candidate", "c"]);
    expect(swallowed.ok).toBe(false);
    if (swallowed.ok) return;
    expect(swallowed.message).toContain("--baseline");

    const duplicated = parseAlignmentGateArgs(["--baseline", "b", "--baseline", "b2", "--candidate", "c"]);
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) return;
    expect(duplicated.message).toContain("--baseline");

    const badMetric = parseAlignmentGateArgs([
      "--baseline", "b", "--candidate", "c", "--metrics", "lineRecall,nope",
    ]);
    expect(badMetric.ok).toBe(false);
    if (badMetric.ok) return;
    expect(badMetric.message).toContain("nope");
    expect(badMetric.message).toContain("linePrecision");

    const badAlpha = parseAlignmentGateArgs(["--baseline", "b", "--candidate", "c", "--alpha", "1.5"]);
    expect(badAlpha.ok).toBe(false);
    if (badAlpha.ok) return;
    // 数值域规则单源（validateAlignmentGateOptions）：消息指明选项字段
    expect(badAlpha.message).toContain("significanceLevel");
  });
});

describe("main（退出码契约）", () => {
  let workDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "review-agent-gate-cli-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(workDir, { recursive: true, force: true });
  });

  /** 造一个 run 目录（3 rep，totalTokens 各 rep = base + rep×step） */
  async function makeRunDir(name: string, baseTokens: number, step: number): Promise<string> {
    return makeGateRunDir(
      workDir,
      name,
      [makeMrCase({ caseId: "c1", truth: makeTruth(), source: "vul4j" })],
      [1, 2, 3].map((rep) =>
        gateRunRecord({
          rep,
          baseline: toRunSnapshot(
            gateRunResult({ usage: { inputTokens: baseTokens + rep * step, outputTokens: 100, cacheReadTokens: 0 } }),
          ),
        }),
      ),
    );
  }

  it("带内 PASS → 0；stdout 含判定表与总结论", async () => {
    const baselineDir = await makeRunDir("baseline", 100000, 1000);
    const candidateDir = await makeRunDir("candidate", 100000, 1000);
    const exitCode = await main(["--baseline", baselineDir, "--candidate", candidateDir]);
    expect(exitCode).toBe(0);
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("PASS");
    expect(printed).toContain("C/totalTokens");
  });

  it("带外 OUT → 1", async () => {
    const baselineDir = await makeRunDir("baseline", 100000, 1000);
    const candidateDir = await makeRunDir("candidate", 900000, 1000);
    const exitCode = await main(["--baseline", baselineDir, "--candidate", candidateDir]);
    expect(exitCode).toBe(1);
  });

  it("用法错误 → 2", async () => {
    const exitCode = await main(["--candidate", "c"]);
    expect(exitCode).toBe(2);
  });

  it("--out 落盘结构化 JSON 报告", async () => {
    const baselineDir = await makeRunDir("baseline", 100000, 1000);
    const candidateDir = await makeRunDir("candidate", 100000, 1000);
    const outPath = path.join(workDir, "gate-report.json");
    const exitCode = await main(["--baseline", baselineDir, "--candidate", candidateDir, "--out", outPath]);
    expect(exitCode).toBe(0);
    const written = JSON.parse(await readFile(outPath, "utf8")) as { verdict?: string; cells?: unknown[] };
    expect(written.verdict).toBe("PASS");
    expect(Array.isArray(written.cells)).toBe(true);
    expect(written.cells).toHaveLength(4); // 四指标 × 单 config C
  });
});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadGateSide } from "../../src/experiment/alignment-gate-io.js";
import { toRunSnapshot } from "../../src/experiment/run-store.js";
import { makeFinding, makeMrCase, makeTruth } from "../metrics/helpers.js";
import { gateRunRecord, gateRunResult, makeGateRunDir } from "./helpers.js";

/**
 * 对齐门加载器（#31）：run 目录（cases.json + runs/ 记录树）→ GateSideInput。
 * 记录经 RunStore.save 造出后 round-trip 验证（自含，不依赖真实 runs/ 数据）。
 * 单元键 = runUnitKeyString（contracts/run-unit 稳定键形 `${source}/${caseId}/${configId}/rep-${rep}`）。
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-gate-io-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("loadGateSide", () => {
  it("run 目录 → GateSideInput：单元键、执行窗、扁平指标全链", async () => {
    const runDir = await makeGateRunDir(
      workDir,
      "side-a",
      [
        makeMrCase({ caseId: "c1", truth: makeTruth(), source: "vul4j" }),
        makeMrCase({ caseId: "c2", truth: makeTruth(), source: "vul4j" }),
      ],
      [
        gateRunRecord({ completedAt: "2026-09-08T22:11:00.000Z" }),
        gateRunRecord({ caseId: "c2", rep: 2, completedAt: "2026-09-09T02:37:00.000Z" }),
        gateRunRecord({ configId: "A", rep: 3, completedAt: "2026-09-08T23:00:00.000Z" }),
      ],
    );

    const side = await loadGateSide(runDir);
    expect(side.name).toBe("side-a");
    expect(side.units).toHaveLength(3);

    const keys = side.units.map((unit) => unit.unitKey).sort();
    expect(keys).toEqual(["vul4j/c1/A/rep-3", "vul4j/c1/C/rep-1", "vul4j/c2/C/rep-2"]);

    // 执行窗 = completedAt 的 min/max（ISO-8601 UTC 字典序）
    expect(side.window).toEqual({ first: "2026-09-08T22:11:00.000Z", last: "2026-09-09T02:37:00.000Z" });

    // 指标管线同径：usage 1000/200/500 → totalTokens 1700、cacheHitRate 1/3；finding 命中真值 → recall 1
    const unit = side.units.find((u) => u.unitKey === "vul4j/c1/C/rep-1");
    expect(unit?.flat.totalTokens).toBe(1700);
    expect(unit?.flat.cacheHitRate).toBeCloseTo(500 / 1500, 12);
    expect(unit?.flat.lineRecall).toBe(1);
    expect(unit?.flat.linePrecision).toBe(1);
  });

  it("effective 快照优先于 baseline（Verifier on 记录按复核口径入指标）", async () => {
    const runDir = await makeGateRunDir(
      workDir,
      "side-effective",
      [makeMrCase({ caseId: "c1", truth: makeTruth(), source: "vul4j" })],
      [
        gateRunRecord({
          verifier: "on",
          baseline: toRunSnapshot(gateRunResult({ findings: [makeFinding()] })),
          effective: toRunSnapshot(gateRunResult({ findings: [], usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } })),
        }),
      ],
    );
    const side = await loadGateSide(runDir);
    const unit = side.units[0];
    // effective：零 finding → precision null；usage 10/5/0 → totalTokens 15
    expect(unit?.flat.totalTokens).toBe(15);
    expect(unit?.flat.linePrecision).toBeNull();
    expect(unit?.flat.lineRecall).toBe(0);
  });

  it("目录不存在 / cases.json 缺失 / 无记录 → fail fast", async () => {
    await expect(loadGateSide(path.join(workDir, "no-such-dir"))).rejects.toThrow(/does not exist/);

    const emptyDir = path.join(workDir, "empty");
    await mkdir(emptyDir, { recursive: true });
    await expect(loadGateSide(emptyDir)).rejects.toThrow(/cases\.json/);

    const noRecords = path.join(workDir, "no-records");
    await mkdir(path.join(noRecords, "runs"), { recursive: true });
    await writeFile(path.join(noRecords, "cases.json"), JSON.stringify([makeMrCase()]), "utf8");
    await expect(loadGateSide(noRecords)).rejects.toThrow(/no run records/);
  });

  it("记录 caseId 不在 cases.json → fail fast 指明单元", async () => {
    const runDir = await makeGateRunDir(
      workDir,
      "side-unknown-case",
      [makeMrCase({ caseId: "c1", truth: makeTruth(), source: "vul4j" })],
      [gateRunRecord({ caseId: "ghost" })],
    );
    await expect(loadGateSide(runDir)).rejects.toThrow(/ghost/);
  });

  it("损坏 rep 文件不静默丢弃 → fail fast 列出文件", async () => {
    const runDir = await makeGateRunDir(
      workDir,
      "side-corrupt",
      [makeMrCase({ caseId: "c1", truth: makeTruth(), source: "vul4j" })],
      [gateRunRecord()],
    );
    await writeFile(path.join(runDir, "runs", "vul4j", "c1", "C", "rep-9.json"), "{ not json", "utf8");
    await expect(loadGateSide(runDir)).rejects.toThrow(/rep-9\.json/);
  });
});

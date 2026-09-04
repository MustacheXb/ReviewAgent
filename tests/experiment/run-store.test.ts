import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunAudit, RunResult } from "../../src/contracts/run.js";
import type { MRCase } from "../../src/contracts/mr-case.js";
import {
  RunStore,
  recordToBaselineRunResult,
  recordToRunResult,
  toAuditLight,
  toRunSnapshot,
} from "../../src/experiment/run-store.js";
import type { RunRecord } from "../../src/experiment/run-store.js";
import type { RunUnit } from "../../src/experiment/plan.js";
import { experimentMainCase } from "./helpers.js";

/**
 * 运行留痕存储（Ticket 12）：快照投影（requests 去除）、记录 → RunResult 重建、
 * 断点续跑读写（存在且可解析 = 已完成；损坏视同未完成）。
 */

let storeDir: string;

beforeAll(async () => {
  storeDir = await mkdtemp(path.join(tmpdir(), "review-agent-run-store-"));
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

const AUDIT: RunAudit = {
  requests: [
    {
      model: "deepseek-v4-flash",
      effort: "default",
      messages: [{ role: "system", content: "zone-a" }],
      tools: [],
    },
  ],
  toolCallLog: [{ name: "review.get_file", argumentsJson: "{}", resultSummary: "loaded" }],
  phaseLog: [{ round: 1, phase: "Deep Reasoning", requestCount: 1 }],
  rejections: [],
  truncated: false,
  truncationReasons: [],
};

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    caseId: "case-1",
    configId: "A",
    findings: [],
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 },
    rounds: 1,
    toolCalls: 1,
    audit: AUDIT,
    auditPath: "runs/audit/audit-file.json",
    ...overrides,
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    source: "defects4j",
    caseId: "case-1",
    configId: "A",
    rep: 1,
    model: "deepseek-v4-flash",
    verifier: "off",
    completedAt: "2026-09-04T00:00:00.000Z",
    baseline: toRunSnapshot(runResult()),
    effective: null,
    verifierPass: null,
    ...overrides,
  };
}

describe("toRunSnapshot / toAuditLight（轻量投影）", () => {
  it("去除 requests（重放字节以 auditPath 为准），保留其余审计面", () => {
    const snapshot = toRunSnapshot(runResult());
    expect(snapshot.audit).not.toHaveProperty("requests");
    expect(snapshot.audit.toolCallLog).toEqual(AUDIT.toolCallLog);
    expect(snapshot.audit.phaseLog).toEqual(AUDIT.phaseLog);
    expect(snapshot.findings).toEqual([]);
    expect(snapshot.auditPath).toBe("runs/audit/audit-file.json");
  });

  it("prefetch / fullRepo / ledger 为可选投影字段", () => {
    const withExtras = toRunSnapshot(
      runResult({
        audit: {
          ...AUDIT,
          prefetch: [],
          fullRepo: {
            budgetChars: 1,
            contentChars: 1,
            truncated: false,
            totalFiles: 1,
            shownFiles: 1,
          },
          ledger: [],
        },
      }),
    );
    expect(withExtras.audit.prefetch).toEqual([]);
    expect(withExtras.audit.fullRepo).toBeDefined();
    expect(withExtras.audit.ledger).toEqual([]);
    const bare = toAuditLight(AUDIT);
    expect(bare.prefetch).toBeUndefined();
    expect(bare.fullRepo).toBeUndefined();
    expect(bare.ledger).toBeUndefined();
  });
});

describe("recordToRunResult（重建形状）", () => {
  it("effective 优先于 baseline（Verifier on 的主口径）", () => {
    const effectiveSnapshot = toRunSnapshot(
      runResult({ findings: [], usage: { inputTokens: 150, outputTokens: 15 } }),
    );
    const rebuilt = recordToRunResult(record({ effective: effectiveSnapshot }));
    expect(rebuilt.usage).toEqual({ inputTokens: 150, outputTokens: 15 });
  });

  it("recordToBaselineRunResult 恒取 baseline（off 档对照口径）", () => {
    const effectiveSnapshot = toRunSnapshot(runResult({ usage: { inputTokens: 999, outputTokens: 99 } }));
    const baseline = recordToBaselineRunResult(record({ effective: effectiveSnapshot }));
    expect(baseline.usage).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });
  });

  it("auditPath 仅在非空时回填（可选字段纪律）", () => {
    const { auditPath: _omitted, ...withoutAuditPath } = runResult();
    const withoutPath = toRunSnapshot(withoutAuditPath);
    expect(recordToRunResult(record({ baseline: withoutPath })).auditPath).toBeUndefined();
  });
});

describe("RunStore（断点续跑读写）", () => {
  it("save → read 往返一致（路径 <root>/<source>/<caseId>/<configId>/rep-<rep>.json）", async () => {
    const store = new RunStore(path.join(storeDir, "round-trip"));
    const saved = await store.save(record());
    expect(saved).toBe(path.join(store.root, "defects4j", "case-1", "A", "rep-1.json"));
    const loaded = await store.read({
      source: "defects4j",
      caseId: "case-1",
      configId: "A",
      rep: 1,
    });
    expect(loaded).not.toBeNull();
    expect(loaded?.caseId).toBe("case-1");
    expect(loaded?.model).toBe("deepseek-v4-flash");
    expect(loaded?.baseline.findings).toEqual([]);
  });

  it("缺失 / 损坏 / 形状不符的记录均返回 null（视同未完成，重跑覆盖）", async () => {
    const store = new RunStore(path.join(storeDir, "corrupt"));
    const missing = await store.read({
      source: "defects4j",
      caseId: "nope",
      configId: "A",
      rep: 1,
    });
    expect(missing).toBeNull();
    const unit: RunUnit = { source: "defects4j", caseId: "bad", configId: "A", rep: 1 };
    await mkdir(path.dirname(store.pathOf(unit)), { recursive: true });
    await writeFile(store.pathOf(unit), "{ not json", "utf8");
    expect(await store.read(unit)).toBeNull();
    await writeFile(store.pathOf(unit), JSON.stringify({ caseId: "shape-only" }), "utf8");
    expect(await store.read(unit)).toBeNull();
  });

  it("readAll 递归扫描 rep-*.json，忽略其他文件；目录缺失返回空数组", async () => {
    const empty = new RunStore(path.join(storeDir, "missing-root"));
    expect(await empty.readAll()).toEqual([]);
    const store = new RunStore(path.join(storeDir, "scan"));
    await store.save(record({ rep: 1 }));
    await store.save(
      record({
        source: "clean-mr",
        caseId: "case-2",
        configId: "C",
        rep: 2,
      }),
    );
    const unit: RunUnit = { source: "defects4j", caseId: "case-1", configId: "A", rep: 3 };
    await mkdir(path.dirname(store.pathOf(unit)), { recursive: true });
    await writeFile(store.pathOf(unit), JSON.stringify({ stray: true }), "utf8"); // 形状不符 → 不计入
    await mkdir(path.join(store.root, "defects4j", "case-1", "A", "notes.txt"), {
      recursive: true,
    });
    const all = await store.readAll();
    expect(all.map((entry) => `${entry.source}/${entry.caseId}/${entry.configId}/rep-${entry.rep}`).sort()).toEqual([
      "clean-mr/case-2/C/rep-2",
      "defects4j/case-1/A/rep-1",
    ]);
  });

  it("caseId 含路径分隔符时按 sanitize 落盘（防目录逃逸）", async () => {
    const store = new RunStore(path.join(storeDir, "sanitize"));
    const unit: RunUnit = { source: "defects4j", caseId: "../escape", configId: "A", rep: 1 };
    const segments = store.pathOf(unit).split(/[\\/]/);
    expect(segments).not.toContain(".."); // 无父目录引用（不逃逸）
    expect(segments).toContain(".._escape"); // 分隔符替换为下划线
    expect(store.pathOf(unit).endsWith(path.join("defects4j", ".._escape", "A", "rep-1.json"))).toBe(
      true,
    );
  });

  it("空 rootDir 构造即抛", () => {
    expect(() => new RunStore("")).toThrow(/rootDir/);
    expect(() => new RunStore("   ")).toThrow(/rootDir/);
  });
});

describe("RunRecord 判别（重建时的防御）", () => {
  it("MRCase 与记录的 caseId 无关（记录自带判别字段）", () => {
    const mrCase: MRCase = experimentMainCase("case-1");
    expect(mrCase.caseId).toBe("case-1");
    expect(record().caseId).toBe("case-1");
  });
});

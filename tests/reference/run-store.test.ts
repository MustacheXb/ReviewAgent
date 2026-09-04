import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REFERENCE_CONFIG_ID } from "../../src/contracts/config.js";
import type { ReferenceRunRecord } from "../../src/reference/run-store.js";
import {
  referenceRecordToRunResult,
  ReferenceRunStore,
} from "../../src/reference/run-store.js";
import { CLAUDE_CODE_PROMPT_TEMPLATE_VERSION } from "../../src/reference/prompt.js";
import { findingJson } from "./helpers.js";

/**
 * 外部参照运行留痕（Ticket 13）：(source, caseId, rep) 级记录 + raw 档案读写；
 * 损坏记录视同未完成（重跑覆盖）；记录 → RunResult 投影锁定单列 configId。
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-ref-store-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<ReferenceRunRecord> = {}): ReferenceRunRecord {
  return {
    source: "defects4j",
    caseId: "store-001",
    rep: 1,
    completedAt: "2026-09-01T00:00:00.000Z",
    requestedModel: "sonnet",
    actualModels: ["claude-sonnet-4-5"],
    claudeVersion: "2.1.241",
    maxTurns: 5,
    promptTemplateVersion: CLAUDE_CODE_PROMPT_TEMPLATE_VERSION,
    status: "ok",
    findings: [
      {
        id: "F001",
        severity: "P1",
        category: "CORRECTNESS",
        file: "src/main/java/com/example/math/MathUtils.java",
        line: 20,
        title: "Off-by-one loop bound reads values[count]",
        description: "The loop condition 'i <= count' reads values[count], which is out of bounds when count equals values.length.",
        evidence: ["for (int i = 0; i <= count; i++)", "values[i]"],
        rule: "CORRECTNESS-001",
        confidence: 0.9,
      },
    ],
    rejections: [],
    usage: { inputTokens: 1000, outputTokens: 200 },
    numTurns: 3,
    totalCostUsd: 0.05,
    permissionDenials: 0,
    parseNotes: [],
    rawPath: "raw/defects4j/store-001/rep-1.json",
    ...overrides,
  };
}

describe("ReferenceRunStore", () => {
  it("记录路径骨架：runs/<source>/<caseId>/rep-<rep>.json；raw 同构", () => {
    const store = new ReferenceRunStore(path.join(workDir, "paths"));
    const unit = { source: "defects4j" as const, caseId: "store-001", rep: 2 };
    expect(store.pathOf(unit)).toBe(
      path.join(store.root, "runs", "defects4j", "store-001", "rep-2.json"),
    );
    expect(store.rawPathOf(unit)).toBe(
      path.join(store.root, "raw", "defects4j", "store-001", "rep-2.json"),
    );
  });

  it("caseId 含路径分隔符等非法字符时替换为下划线（路径穿越防线）", () => {
    const store = new ReferenceRunStore(path.join(workDir, "sanitize"));
    const unit = { source: "defects4j" as const, caseId: "../evil/id", rep: 1 };
    // ".._evil_id" 是字面目录名（非目录上跳），落在 runs/defects4j/ 之内
    expect(store.pathOf(unit)).toContain(
      path.join("runs", "defects4j", ".._evil_id", "rep-1.json"),
    );
    // 恰为 ".." 的段替换为 "_"（唯一会上跳的字面量）
    const dotdot = store.pathOf({ source: "defects4j", caseId: "..", rep: 1 });
    expect(dotdot).toContain(path.join("runs", "defects4j", "_", "rep-1.json"));
  });

  it("空 rootDir 拒绝", () => {
    expect(() => new ReferenceRunStore("  ")).toThrow(/rootDir/);
  });

  it("save → read 往返一致；不存在返回 null", async () => {
    const store = new ReferenceRunStore(path.join(workDir, "roundtrip"));
    const unit = { source: "defects4j" as const, caseId: "store-roundtrip", rep: 1 };
    expect(await store.read(unit)).toBeNull();
    await store.save(makeRecord({ caseId: unit.caseId }));
    expect(await store.read(unit)).toMatchObject({ caseId: "store-roundtrip", rep: 1 });
  });

  it("损坏 JSON / 形状不符：read 返回 null（视同未完成，续跑可重试）", async () => {
    const store = new ReferenceRunStore(path.join(workDir, "corrupt"));
    const base = { source: "defects4j" as const, caseId: "store-corrupt", rep: 1 };
    await mkdir(path.dirname(store.pathOf(base)), { recursive: true });
    await writeFile(store.pathOf(base), "{ not json", "utf8");
    expect(await store.read(base)).toBeNull();
    const partial = makeRecord({ caseId: base.caseId });
    await writeFile(store.pathOf(base), JSON.stringify({ ...partial, findings: "oops" }), "utf8");
    expect(await store.read(base)).toBeNull();
  });

  it("readAll 递归扫描全部记录；根目录不存在返回空数组", async () => {
    const empty = new ReferenceRunStore(path.join(workDir, "missing-root"));
    expect(await empty.readAll()).toEqual([]);
    const store = new ReferenceRunStore(path.join(workDir, "all"));
    await store.save(makeRecord({ caseId: "all-1", rep: 1 }));
    await store.save(makeRecord({ caseId: "all-2", rep: 1, source: "clean-mr" }));
    const records = await store.readAll();
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.caseId))).toEqual(new Set(["all-1", "all-2"]));
  });
});

describe("referenceRecordToRunResult（同一 metrics 管线的投影）", () => {
  it("configId 恒为单列参照位 claude-code；rounds = numTurns；toolCalls = 0（CLI 不暴露）", () => {
    const runResult = referenceRecordToRunResult(makeRecord());
    expect(runResult.configId).toBe(REFERENCE_CONFIG_ID);
    expect(runResult.caseId).toBe("store-001");
    expect(runResult.findings).toHaveLength(1);
    expect(runResult.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
    expect(runResult.rounds).toBe(3);
    expect(runResult.toolCalls).toBe(0);
    expect(runResult.audit).toEqual({
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      // 外部参照不经 harness 循环，无请求序列可分类
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    });
  });

  it("numTurns 缺失时 rounds 记 0", () => {
    const runResult = referenceRecordToRunResult(makeRecord({ numTurns: null }));
    expect(runResult.rounds).toBe(0);
  });

  it("findingJson 工厂产出与 Schema 合法（测试自检）", () => {
    const record = makeRecord();
    expect(record.findings[0]).toEqual(findingJson("F001"));
  });
});

import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/contracts/finding.js";
import type { LlmUsage } from "../../src/contracts/llm-client.js";
import type { MRCase } from "../../src/contracts/mr-case.js";
import { DEFAULT_MR_BOUNDARY } from "../../src/dataset/mr-boundary-filter.js";
import { fileBlock } from "../helpers/diff-blocks.js";
import { DEFAULT_SHARD_CONFIG, planShards } from "../../src/sharding/plan-shards.js";
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  type SingleMrRun,
  orchestrateReview,
} from "../../src/sharding/orchestrate-review.js";

function makeCase(caseId: string, diff: string): MRCase {
  return {
    caseId,
    repoPath: "D:/repos/x",
    diff,
    issueDescription: "issue text",
    truth: null,
    labels: { source: "vul4j", riskClass: "Medium", allowedConfigs: ["A", "B", "C", "D", "E"] },
  };
}

/** 构造合法 Finding（默认值 + 覆盖） */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    severity: "P2",
    category: "NullCheck",
    file: "src/App.java",
    line: 100,
    title: "可能的空指针",
    description: "该返回值可能为 null，直接解引用存在 NPE 风险",
    evidence: ["src/App.java:100 returnValue != null 检查缺失"],
    rule: "null-safety",
    confidence: 0.8,
    ...overrides,
  };
}

function makeRun(overrides: Partial<SingleMrRun> = {}): SingleMrRun {
  return {
    findings: [],
    usage: { inputTokens: 100, outputTokens: 10 },
    runId: "run-1",
    ...overrides,
  };
}

/** fake 单 MR 运行器：捕获每次收到的 MRCase 与执行序，检测并发交错 */
function makeFakeRunner(respond: (mrCase: MRCase, index: number) => SingleMrRun) {
  const calls: { readonly mrCase: MRCase; readonly startSeq: number; readonly endSeq: number }[] = [];
  let active = 0;
  let maxActive = 0;
  let seq = 0;
  let runCount = 0;
  const runner = {
    async run(mrCase: MRCase): Promise<SingleMrRun> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const startSeq = seq;
      seq += 1;
      const outcome = respond(mrCase, runCount);
      runCount += 1;
      // 异步边界：串行编排下不产生并发（maxActive 恒 1）
      await Promise.resolve();
      const endSeq = seq;
      seq += 1;
      active -= 1;
      calls.push({ mrCase, startSeq, endSeq });
      return outcome;
    },
  };
  return {
    runner,
    calls,
    maxActive: () => maxActive,
    runCount: () => runCount,
  };
}

describe("orchestrateReview（域内直通）", () => {
  it("域内 MRCase：单次直接运行，结果不携带 shards 节与 provenance 字段", async () => {
    const mrCase = makeCase("direct", fileBlock("src/A.java", 10));
    const findings = [makeFinding({ id: "F1" })];
    const usage: LlmUsage = { inputTokens: 42, outputTokens: 7 };
    const fake = makeFakeRunner(() => makeRun({ findings, usage, runId: "run-1" }));
    const result = await orchestrateReview(mrCase, fake.runner);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sharded).toBe(false);
    expect(fake.runCount()).toBe(1);
    // 直通收到原 MRCase（同引用，不派生分片）
    expect(fake.calls[0]?.mrCase).toBe(mrCase);
    // findings / usage 原样透传（零拷贝引用）
    expect(result.value.findings).toBe(findings);
    expect(result.value.usage).toBe(usage);
    // 不携带 shards 节与 provenance 字段（决策 11）
    expect("shards" in result.value).toBe(false);
    expect("shardIds" in (result.value.findings[0] as object)).toBe(false);
  });
});

describe("orchestrateReview（分片串行执行）", () => {
  it("超界 MR：分片串行下发（执行序无交错），每片收到正确的派生 MRCase", async () => {
    const diff = Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    const mrCase = makeCase("serial-25", diff);
    const fake = makeFakeRunner((_mrCase, index) =>
      makeRun({ runId: `run-${index + 1}`, auditPath: `audit/run-${index + 1}.json` }),
    );
    const result = await orchestrateReview(mrCase, fake.runner);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sharded).toBe(true);
    // 独立复核：每片收到的正是切分器计划的分片 MRCase（子 diff / shardId / 同仓字段）
    const plan = planShards(mrCase);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const shards = plan.value.shards;
    expect(fake.calls.map((call) => call.mrCase.caseId)).toEqual(shards.map((s) => s.shardId));
    for (const [index, call] of fake.calls.entries()) {
      expect(call.mrCase.diff).toBe(shards[index]!.diff);
      expect(call.mrCase.repoPath).toBe(mrCase.repoPath);
      expect(call.mrCase.issueDescription).toBe(mrCase.issueDescription);
      expect(call.mrCase.labels).toEqual(mrCase.labels);
    }
    // 串行：全程无并发、前一片结束序号先于后一片开始（执行序无交错）
    expect(fake.maxActive()).toBe(1);
    for (let index = 1; index < fake.calls.length; index += 1) {
      expect(fake.calls[index - 1]!.endSeq).toBeLessThan(fake.calls[index]!.startSeq);
    }
  });
});

describe("orchestrateReview（shards 节 / 审计引用 / usage 汇总）", () => {
  it("结果 shards 节字段齐全，每片审计 runId 关联", async () => {
    const diff = Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    const fake = makeFakeRunner((_mrCase, index) =>
      makeRun({ runId: `run-${index + 1}`, auditPath: `audit/run-${index + 1}.json` }),
    );
    const result = await orchestrateReview(makeCase("shards-meta", diff), fake.runner);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.shards).toEqual({
      reason: "files",
      boundary: DEFAULT_MR_BOUNDARY,
      count: 3,
      entries: [
        { shardId: "shards-meta#shard-001", files: 10, diffLines: 30, outOfDomain: false, runId: "run-1", auditPath: "audit/run-1.json" },
        { shardId: "shards-meta#shard-002", files: 10, diffLines: 30, outOfDomain: false, runId: "run-2", auditPath: "audit/run-2.json" },
        { shardId: "shards-meta#shard-003", files: 5, diffLines: 15, outOfDomain: false, runId: "run-3", auditPath: "audit/run-3.json" },
      ],
    });
    // runs 按片序携带各次运行（审计引用可核对）
    expect(result.value.runs.map((run) => run.runId)).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("usage / token 汇总 = 各片之和（可选 cache 字段：任一片定义即在）", async () => {
    const diff = [fileBlock("src/a/X.java", 3), fileBlock("src/b/Y.java", 3)].join("");
    const fake = makeFakeRunner((_mrCase, index) =>
      makeRun({
        runId: `run-${index + 1}`,
        usage:
          index === 0
            ? { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2 }
            : { inputTokens: 50, outputTokens: 20 },
      }),
    );
    const result = await orchestrateReview(
      makeCase("usage-sum", diff),
      fake.runner,
      {
        ...DEFAULT_ORCHESTRATION_CONFIG,
        shard: { boundary: { maxFiles: 1, maxDiffLines: 2000 }, maxShards: 20 },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.usage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
    });
  });

  it("单文件超界：单片执行 + outOfDomain 呈现", async () => {
    const fake = makeFakeRunner((_mrCase, index) => makeRun({ runId: `run-${index + 1}` }));
    const result = await orchestrateReview(makeCase("single-huge", fileBlock("src/Huge.java", 2500)), fake.runner);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sharded).toBe(true);
    expect(result.value.shards).toMatchObject({
      reason: "lines",
      count: 1,
      entries: [{ shardId: "single-huge#shard-001", files: 1, diffLines: 2500, outOfDomain: true }],
    });
    expect(fake.runCount()).toBe(1);
  });
});

describe("orchestrateReview（分片数超限拒绝）", () => {
  it("超限：可区分拒绝（SHARD_LIMIT_EXCEEDED，含所需片数与上限），零运行成本", async () => {
    const diff = Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    const fake = makeFakeRunner(() => makeRun());
    const result = await orchestrateReview(makeCase("over-limit", diff), fake.runner, {
      ...DEFAULT_ORCHESTRATION_CONFIG,
      shard: { ...DEFAULT_SHARD_CONFIG, maxShards: 2 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SHARD_LIMIT_EXCEEDED");
    expect(result.error.message).toContain("所需分片数 3");
    expect(result.error.message).toContain("上限 2");
    // 拒绝发生在任何运行之前（零 LLM 成本）
    expect(fake.runCount()).toBe(0);
  });
});

describe("orchestrateReview（合并层接线与配置统一传入）", () => {
  function twoShardConfig() {
    return {
      ...DEFAULT_ORCHESTRATION_CONFIG,
      shard: { boundary: { maxFiles: 1, maxDiffLines: 2000 }, maxShards: 20 },
    };
  }

  it("跨片锚点键命中：合并为一条（首见保留 + shardIds provenance + evidence 并集）", async () => {
    const diff = [fileBlock("src/a/X.java", 3), fileBlock("src/b/Y.java", 3)].join("");
    const fake = makeFakeRunner((_mrCase, index) =>
      makeRun({
        runId: `run-${index + 1}`,
        findings: [
          index === 0
            ? makeFinding({ id: "A", line: 100, evidence: ["e1"] })
            : makeFinding({ id: "B", line: 102, severity: "P1", evidence: ["e2"] }),
        ],
      }),
    );
    const result = await orchestrateReview(makeCase("merge-case", diff), fake.runner, twoShardConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(1);
    const merged = result.value.findings[0]!;
    // 首见保留：字段取片 1（B 的 severity P1 不覆盖）
    expect(merged.id).toBe("A");
    expect(merged.severity).toBe("P2");
    // provenance + evidence 并集
    expect(merged).toMatchObject({
      shardIds: ["merge-case#shard-001", "merge-case#shard-002"],
      evidence: ["e1", "e2"],
    });
  });

  it("合并窗口经编排配置传入：lineWindow=1 时差 2 不再合并", async () => {
    const diff = [fileBlock("src/a/X.java", 3), fileBlock("src/b/Y.java", 3)].join("");
    const fake = makeFakeRunner((_mrCase, index) =>
      makeRun({
        runId: `run-${index + 1}`,
        findings: [makeFinding({ id: index === 0 ? "A" : "B", line: 100 + index * 2 })],
      }),
    );
    const result = await orchestrateReview(makeCase("window-1", diff), fake.runner, {
      ...twoShardConfig(),
      merge: { lineWindow: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(2);
  });

  it("切分边界经编排配置传入：maxFiles=2 触发 3 文件切分，缺省则直通", async () => {
    const diff = [fileBlock("src/a/X.java", 3), fileBlock("src/a/Y.java", 3), fileBlock("src/a/Z.java", 3)].join("");
    const fake = makeFakeRunner(() => makeRun());
    const direct = await orchestrateReview(makeCase("cfg-boundary", diff), fake.runner);
    expect(direct.ok).toBe(true);
    if (!direct.ok) {
      return;
    }
    expect(direct.value.sharded).toBe(false);

    const sharded = await orchestrateReview(
      makeCase("cfg-boundary", diff),
      fake.runner,
      { ...DEFAULT_ORCHESTRATION_CONFIG, shard: { boundary: { maxFiles: 2, maxDiffLines: 2000 }, maxShards: 20 } },
    );
    expect(sharded.ok).toBe(true);
    if (!sharded.ok) {
      return;
    }
    expect(sharded.value.sharded).toBe(true);
    expect(sharded.value.shards).toMatchObject({ reason: "files", count: 2 });
  });

  it("非法合并配置：运行前拒绝（零运行成本）", async () => {
    const diff = Array.from({ length: 25 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 3)).join("");
    const fake = makeFakeRunner(() => makeRun());
    const result = await orchestrateReview(makeCase("bad-merge-cfg", diff), fake.runner, {
      ...DEFAULT_ORCHESTRATION_CONFIG,
      merge: { lineWindow: 0 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MERGE_CONFIG_INVALID");
    expect(fake.runCount()).toBe(0);
  });
});

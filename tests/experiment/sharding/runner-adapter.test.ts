import { describe, expect, it } from "vitest";
import { join } from "node:path";

import type { ConfigId } from "../../../src/contracts/config.js";
import type { MRCase } from "../../../src/contracts/mr-case.js";
import type { RunResult } from "../../../src/contracts/run.js";
import {
  experimentSingleMrRunner,
  type ExperimentUnitRequest,
} from "../../../src/experiment/sharding/runner-adapter.js";

/**
 * #57 实验侧运行器适配（决策 12）：单元执行面 → SingleMrRunner。
 *
 * 锁线：请求面保真（configId / model / issue / diff / repoPath 直传、
 * auditDir 按单元 caseId 派生 + sanitize）与产出面保真（findings / usage
 * 零拷贝透传、runId = 单元 caseId、auditPath 随行）——适配器只做形状转换，
 * 不增删任何检视语义。
 */

function makeCase(caseId: string): MRCase {
  return {
    caseId,
    repoPath: "D:/repos/example",
    diff: "--- a/x.java\n+++ b/x.java\n@@ -1,2 +1,3 @@\n base\n+add\n tail\n",
    issueDescription: `issue of ${caseId}`,
    truth: null,
    labels: { source: "vul4j", riskClass: "Medium", allowedConfigs: ["B"] },
  };
}

/** 最小 RunResult 夹具（适配器只消费 caseId / findings / usage / auditPath） */
function fakeRunResult(request: ExperimentUnitRequest, findings: RunResult["findings"]): RunResult {
  return {
    caseId: request.caseId,
    configId: request.configId,
    model: request.model,
    findings,
    usage: { inputTokens: 10, outputTokens: 2 },
    rounds: 1,
    toolCalls: 0,
    audit: {
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: join(request.auditDir, "audit.json"),
  };
}

const FINDING = {
  id: "F001",
  severity: "P2",
  category: "NullCheck",
  file: "src/main/java/com/example/Parser.java",
  line: 5,
  title: "possible NPE",
  description: "missing null check",
  evidence: ["Parser.java:5"],
  rule: "null-safety",
  confidence: 0.9,
} as const;

describe("experimentSingleMrRunner（#57 决策 12 实验侧适配）", () => {
  it("请求面保真：configId / model / issue / diff / repoPath 直传；auditDir 按单元 caseId 派生（sanitize）", async () => {
    const requests: ExperimentUnitRequest[] = [];
    const runner = experimentSingleMrRunner({
      configId: "B" as ConfigId,
      model: "deepseek-v4-flash",
      auditRoot: join("D:", "exp", "audit", "sharding", "g1", "treatment"),
      executeUnit: async (request) => {
        requests.push(request);
        return fakeRunResult(request, []);
      },
    });
    const mrCase = makeCase("g1-treatment#shard-001");

    await runner.run(mrCase);

    expect(requests).toEqual([
      {
        configId: "B",
        model: "deepseek-v4-flash",
        caseId: "g1-treatment#shard-001",
        issueDescription: "issue of g1-treatment#shard-001",
        diff: mrCase.diff,
        repoPath: mrCase.repoPath,
        // caseId 中的 # 等非安全字符被 sanitize 替换（与实验 runner 落盘路径同款纪律）
        auditDir: join("D:", "exp", "audit", "sharding", "g1", "treatment", "g1-treatment_shard-001"),
      },
    ]);
  });

  it("产出面保真：findings / usage 零拷贝透传；runId = 单元 caseId（实验侧无内核 runId，编排内 caseId 唯一）；auditPath 随行", async () => {
    const findings: RunResult["findings"] = [FINDING];
    const usage = { inputTokens: 42, outputTokens: 7, cacheReadTokens: 5 };
    const runner = experimentSingleMrRunner({
      configId: "A" as ConfigId,
      model: "glm-4.7",
      auditRoot: "audit-root",
      executeUnit: async (request) => ({
        ...fakeRunResult(request, findings),
        usage,
      }),
    });

    const run = await runner.run(makeCase("c1"));

    expect(run.findings).toBe(findings);
    expect(run.usage).toBe(usage);
    expect(run.runId).toBe("c1");
    expect(run.auditPath).toBe(join("audit-root", "c1", "audit.json"));
    expect(run.rounds).toBe(1);
    expect(run.toolCalls).toBe(0);
  });

  it("分片间审计目录互异：两片各自 auditDir 派生自自身 caseId（不串片）", async () => {
    const auditDirs: string[] = [];
    const runner = experimentSingleMrRunner({
      configId: "B" as ConfigId,
      model: "deepseek-v4-flash",
      auditRoot: "audit-root",
      executeUnit: async (request) => {
        auditDirs.push(request.auditDir);
        return fakeRunResult(request, []);
      },
    });

    await runner.run(makeCase("g1-treatment#shard-001"));
    await runner.run(makeCase("g1-treatment#shard-002"));

    expect(auditDirs[0]).not.toBe(auditDirs[1]);
    expect(auditDirs).toEqual([
      join("audit-root", "g1-treatment_shard-001"),
      join("audit-root", "g1-treatment_shard-002"),
    ]);
  });
});

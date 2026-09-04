import type { MetricsConfigId } from "../../src/contracts/config.js";
import type { Finding } from "../../src/contracts/finding.js";
import type { LlmUsage } from "../../src/contracts/llm-client.js";
import type { MRCase, MRTruth, TruthLocation } from "../../src/contracts/mr-case.js";
import type { RunAudit, RunResult, ToolCallRecord } from "../../src/contracts/run.js";
import { usage } from "../helpers/llm-script.js";

/** 指标测试的对象工厂（全部返回新对象，字段显式可覆盖） */

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    severity: "P1",
    category: "CORRECTNESS",
    file: "src/main/java/com/example/Math.java",
    line: 10,
    title: "sample finding",
    description: "sample description",
    evidence: ["src/main/java/com/example/Math.java:10"],
    rule: "RULE-001",
    confidence: 0.9,
    ...overrides,
  };
}

export function makeTruthLocation(overrides: Partial<TruthLocation> = {}): TruthLocation {
  return {
    file: "src/main/java/com/example/Math.java",
    lineStart: 10,
    lineEnd: 10,
    defectNature: "CORRECTNESS",
    ...overrides,
  };
}

export function makeTruth(locations: readonly TruthLocation[] = [makeTruthLocation()]): MRTruth {
  return { locations, fixPatch: "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-old\n+new" };
}

export function makeMrCase(overrides: {
  readonly caseId?: string;
  readonly truth?: MRTruth | null;
  readonly source?: string;
} = {}): MRCase {
  return {
    caseId: overrides.caseId ?? "case-001",
    repoPath: "/repos/sample",
    diff: "diff --git a/src/main/java/com/example/Math.java b/src/main/java/com/example/Math.java",
    issueDescription: "sample issue description",
    truth: overrides.truth === undefined ? makeTruth() : overrides.truth,
    labels: {
      source: overrides.source ?? "test",
      riskClass: "Medium",
      allowedConfigs: ["A", "B", "C", "D", "E"],
    },
  };
}

export function makeRunResult(overrides: {
  readonly caseId?: string;
  readonly configId?: MetricsConfigId;
  readonly findings?: readonly Finding[];
  readonly usage?: LlmUsage;
  readonly rounds?: number;
  readonly toolCalls?: number;
  readonly toolCallLog?: readonly ToolCallRecord[];
} = {}): RunResult {
  const toolCallLog = overrides.toolCallLog ?? [];
  const audit: RunAudit = {
    requests: [],
    toolCallLog: [...toolCallLog],
    phaseLog: [],
    rejections: [],
    truncated: false,
    truncationReasons: [],
  };
  return {
    caseId: overrides.caseId ?? "case-001",
    configId: overrides.configId ?? "C",
    findings: overrides.findings ?? [],
    usage: overrides.usage ?? usage(1000, 200),
    rounds: overrides.rounds ?? 1,
    toolCalls: overrides.toolCalls ?? toolCallLog.length,
    audit,
  };
}

export function makeToolCall(resultSummary: string): ToolCallRecord {
  return { name: "review.get_symbol", argumentsJson: "{}", resultSummary };
}

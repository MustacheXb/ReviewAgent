import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/fake/fake-llm-client.js";
import { CONFIGS } from "../src/contracts/config.js";
import { filterMrCases } from "../src/dataset/mr-boundary-filter.js";
import { msbRecordToMrCase } from "../src/dataset/msb-java/adapter.js";
import { vul4jToMrCase } from "../src/dataset/vul4j/adapter.js";
import { runReview } from "../src/run/run-review.js";
import { validateRunInputs } from "../src/run/validate-inputs.js";
import { HAPPY_PATH_RESPONSES } from "./helpers/happy-path-script.js";
import { MSB_SAMPLE_RECORD } from "./fixtures/msb-sample.js";
import { VUL4J_SAMPLE_RECORD_INPUT, VUL4J_SAMPLE_VUL_ID } from "./fixtures/vul4j-sample.js";

/**
 * 验收（工单 #9）：两个新数据源的 MRCase 可直接喂给 T01 harness——
 * 边界过滤（T02 复用）接受 + validateRunInputs 通过 + runReview 全流程跑通
 * （FakeLlmClient 脚本化回复，零真实 LLM、零网络）。
 */

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-dataset-sources-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

const VUL4J_REPO_PATH = "D:/repos/vul4j-codec-fixed";
const MSB_REPO_PATH = "D:/repos/msb-jackson-databind-base";

describe("Vul4J MRCase → T01 harness（逆补丁法）", () => {
  it("通过 MR 边界过滤（≤10 文件 / ≤2K 行）", () => {
    const converted = vul4jToMrCase(VUL4J_SAMPLE_RECORD_INPUT, { repoPath: VUL4J_REPO_PATH });
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const filtered = filterMrCases([converted.value]);
    expect(filtered.report).toEqual(
      expect.objectContaining({ total: 1, acceptedCount: 1, rejectedCount: 0 }),
    );
  });

  it("runReview(config A) 全流程跑通（fake LLM，六阶段一轮完成）", async () => {
    const converted = vul4jToMrCase(VUL4J_SAMPLE_RECORD_INPUT, { repoPath: VUL4J_REPO_PATH });
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const result = await runReview(CONFIGS.A, converted.value, FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES), {
      auditDir,
    });
    expect(result.caseId).toBe(VUL4J_SAMPLE_VUL_ID);
    expect(result.configId).toBe("A");
    expect(result.rounds).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.auditPath).toBeDefined();
  });
});

describe("MSB-Java MRCase → T01 harness（真实 PR 形态）", () => {
  it("通过 MR 边界过滤（≤10 文件 / ≤2K 行）", () => {
    const converted = msbRecordToMrCase(MSB_SAMPLE_RECORD, { repoPath: MSB_REPO_PATH });
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const filtered = filterMrCases([converted.value]);
    expect(filtered.report).toEqual(
      expect.objectContaining({ total: 1, acceptedCount: 1, rejectedCount: 0 }),
    );
  });

  it("validateRunInputs 接受（含 extensions 扩展字段，向下兼容）", () => {
    const converted = msbRecordToMrCase(MSB_SAMPLE_RECORD, { repoPath: MSB_REPO_PATH });
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(() =>
      validateRunInputs(CONFIGS.E, converted.value, FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES), {}),
    ).not.toThrow();
  });

  it("runReview(config E，MSB 允许配置) 全流程跑通（fake LLM）", async () => {
    const converted = msbRecordToMrCase(MSB_SAMPLE_RECORD, { repoPath: MSB_REPO_PATH });
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.labels.allowedConfigs).toContain("E");
    const result = await runReview(CONFIGS.E, converted.value, FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES), {
      auditDir,
    });
    expect(result.caseId).toBe(MSB_SAMPLE_RECORD.instance_id);
    expect(result.configId).toBe("E");
    expect(result.rounds).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.auditPath).toBeDefined();
  });
});

describe("两源混合批量过滤（T12 数据管线形态）", () => {
  it("filterMrCases 同时处理两源 case，全量接受并按 source 留痕", () => {
    const vul4j = vul4jToMrCase(VUL4J_SAMPLE_RECORD_INPUT, { repoPath: VUL4J_REPO_PATH });
    const msb = msbRecordToMrCase(MSB_SAMPLE_RECORD, { repoPath: MSB_REPO_PATH });
    expect(vul4j.ok).toBe(true);
    expect(msb.ok).toBe(true);
    if (!vul4j.ok || !msb.ok) {
      return;
    }
    const filtered = filterMrCases([vul4j.value, msb.value]);
    expect(filtered.accepted.map((c) => c.caseId)).toEqual([
      vul4j.value.caseId,
      msb.value.caseId,
    ]);
    expect(filtered.report.rejected).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildCalibrationSamples,
  mcrCategoryDistribution,
  parseLineRange,
  parseMcrDataset,
  parseMcrModelOutputs,
  parseMcrOfficialJudgments,
} from "../../src/calibration/mcr-bench.js";

function datasetLine(taskId: string, options: { readonly defects?: unknown; readonly diff?: string } = {}): string {
  return JSON.stringify({
    task_id: taskId,
    pr_title: `title-${taskId}`,
    pr_description: "issue description",
    code_diff: { commits: [], diff: options.diff ?? "diff --git a/f b/f" },
    linked_issues: [],
    ground_truth: {
      defects_count: 2,
      defects:
        options.defects ??
        [
          {
            defect_id: "d1",
            title: "NPE in render",
            description: "render() may return null",
            taxonomy: "NullDereference",
            severity: "major",
            location: { file: "src/Chart.java", lines: "86" },
          },
          {
            defect_id: "d2",
            title: "Resource leak",
            description: "stream not closed",
            taxonomy: "ResourceLeak",
            severity: "minor",
            location: { file: "unknown", lines: "unknown" },
          },
        ],
    },
  });
}

function outputLine(taskId: string): string {
  return JSON.stringify({
    task_id: taskId,
    generated_results: {
      task_id: taskId,
      round_id: 1,
      defects: [
        {
          defect_id: "m1",
          title: "Null pointer in render",
          description: "render() may return null",
          location: { file: "src/Chart.java", lines: "86" },
        },
      ],
    },
  });
}

function judgmentLine(taskId: string): string {
  return JSON.stringify({
    task_id: taskId,
    tp: 1,
    fp: 0,
    fn: 1,
    tn: 0,
    precision: 1.0,
    recall: 0.5,
    f1: 0.667,
    matches: [
      {
        model_defect_index: 1,
        ground_truth_defect_index: 1,
        match_confidence: "high",
        match_reason: "same NPE",
      },
    ],
    unmatched_ground_truth: [2],
    unmatched_model: [],
  });
}

describe("parseLineRange — lines 字符串容忍解析", () => {
  it("单行 / 区间 / 逗号列表 / unknown 四种实测形态", () => {
    expect(parseLineRange("86")).toEqual({ lineStart: 86, lineEnd: 86 });
    expect(parseLineRange("58-84")).toEqual({ lineStart: 58, lineEnd: 84 });
    expect(parseLineRange("314, 356")).toEqual({ lineStart: 314, lineEnd: 356 });
    expect(parseLineRange("unknown")).toBeNull();
  });

  it("未知形态有界失败（返回 null，不抛错）", () => {
    expect(parseLineRange("")).toBeNull();
    expect(parseLineRange("abc")).toBeNull();
    expect(parseLineRange(42)).toBeNull();
    expect(parseLineRange(null)).toBeNull();
    expect(parseLineRange(undefined)).toBeNull();
  });
});

describe("parseMcrDataset — dataset/<lang>.jsonl 解析", () => {
  it("默认 round1 子集：round2+ 过滤、坏行跳过计数", () => {
    const text = [
      datasetLine("Chart-1_round1"),
      datasetLine("Chart-1_round2"),
      "{ not valid json",
      datasetLine("Math-7_round1"),
    ].join("\n");
    const result = parseMcrDataset(text);
    expect(result.records.map((record) => record.taskId)).toEqual(["Chart-1_round1", "Math-7_round1"]);
    expect(result.roundFilteredLines).toBe(1);
    expect(result.skippedLines).toBe(1);
  });

  it("rounds 可覆盖（含全部轮次）", () => {
    const text = [datasetLine("Chart-1_round1"), datasetLine("Chart-1_round2")].join("\n");
    const result = parseMcrDataset(text, { rounds: ["round1", "round2"] });
    expect(result.records).toHaveLength(2);
  });

  it("缺陷卡字段解析：lines 归一、unknown file → null、PR 上下文保留", () => {
    const result = parseMcrDataset(datasetLine("Chart-1_round1"));
    const record = result.records[0];
    expect(record?.prTitle).toBe("title-Chart-1_round1");
    expect(record?.diff).toBe("diff --git a/f b/f");
    const [first, second] = record?.defects ?? [];
    expect(first).toMatchObject({
      defectId: "d1",
      title: "NPE in render",
      taxonomy: "NullDereference",
      severity: "major",
      file: "src/Chart.java",
      lineStart: 86,
      lineEnd: 86,
    });
    expect(second).toMatchObject({ file: null, lineStart: null, lineEnd: null });
  });

  it("必需字段缺失（defect_id 空）→ 该行有界跳过", () => {
    const bad = JSON.stringify({
      task_id: "X_round1",
      ground_truth: { defects: [{ defect_id: "", title: "t", description: "d", location: {} }] },
    });
    const result = parseMcrDataset([datasetLine("Chart-1_round1"), bad].join("\n"));
    expect(result.records).toHaveLength(1);
    expect(result.skippedLines).toBe(1);
  });
});

describe("parseMcrModelOutputs — generated_results 解析", () => {
  it("嵌套 generated_results.defects 展开", () => {
    const result = parseMcrModelOutputs(outputLine("Chart-1_round1"));
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.defects[0]).toMatchObject({
      defectId: "m1",
      title: "Null pointer in render",
      file: "src/Chart.java",
    });
  });

  it("generated_results 缺失 → 该行跳过", () => {
    const result = parseMcrModelOutputs([outputLine("A_round1"), JSON.stringify({ task_id: "B_round1" })].join("\n"));
    expect(result.records).toHaveLength(1);
    expect(result.skippedLines).toBe(1);
  });
});

describe("parseMcrOfficialJudgments — 官方判定解析", () => {
  it("matches / unmatched 双侧解析，1 起索引原样保留", () => {
    const result = parseMcrOfficialJudgments(judgmentLine("Chart-1_round1"));
    const judgment = result.records[0];
    expect(judgment).toMatchObject({ taskId: "Chart-1_round1", tp: 1, fp: 0, fn: 1 });
    expect(judgment?.matches).toEqual([
      {
        modelDefectIndex: 1,
        groundTruthDefectIndex: 1,
        matchConfidence: "high",
        matchReason: "same NPE",
      },
    ]);
    expect(judgment?.unmatchedGroundTruth).toEqual([2]);
    expect(judgment?.unmatchedModel).toEqual([]);
  });

  it("缺 model_defect_index 的条目丢弃；非数组 matches → 行跳过", () => {
    const tolerant = JSON.stringify({
      task_id: "A_round1",
      matches: [{ ground_truth_defect_index: 1, match_confidence: "high" }, { model_defect_index: 1, ground_truth_defect_index: 1, match_confidence: "low" }],
    });
    const result = parseMcrOfficialJudgments(tolerant);
    expect(result.records[0]?.matches).toHaveLength(1);

    const bad = JSON.stringify({ task_id: "B_round1", matches: "nope" });
    const badResult = parseMcrOfficialJudgments([judgmentLine("C_round1"), bad].join("\n"));
    expect(badResult.records).toHaveLength(1);
    expect(badResult.skippedLines).toBe(1);
  });

  it("tp/fp/fn 缺失时为 null（0 不被误吞）", () => {
    const result = parseMcrOfficialJudgments(
      JSON.stringify({ task_id: "A_round1", tp: 0, matches: [] }),
    );
    expect(result.records[0]).toMatchObject({ tp: 0, fp: null, fn: null });
  });
});

describe("buildCalibrationSamples — 三侧对齐组装", () => {
  function fixture() {
    const tasks = parseMcrDataset(
      [datasetLine("Chart-1_round1"), datasetLine("Chart-1_round2"), datasetLine("Missing-9_round1")].join("\n"),
    );
    const outputs = parseMcrModelOutputs([outputLine("Chart-1_round1"), outputLine("Chart-1_round2")].join("\n"));
    const judgments = parseMcrOfficialJudgments(
      [judgmentLine("Chart-1_round1"), judgmentLine("Chart-1_round2")].join("\n"),
    );
    return buildCalibrationSamples({ modelName: "gpt-5.2", tasks: tasks.records, outputs: outputs.records, judgments: judgments.records });
  }

  it("round1 样例组装：卡片只携带 id/title/description（信息面纪律）", () => {
    const { samples } = fixture();
    expect(samples).toHaveLength(1);
    const sample = samples[0];
    expect(sample?.taskId).toBe("Chart-1_round1");
    expect(sample?.modelName).toBe("gpt-5.2");
    expect(sample?.request.caseId).toBe("Chart-1_round1");
    expect(sample?.request.context).toBeNull();
    // 信息面与官方 judge 一致：location/taxonomy/severity 一律不进卡片
    expect(sample?.request.findings[0]).toEqual({
      id: "m1",
      title: "Null pointer in render",
      description: "render() may return null",
      file: null,
      line: null,
      category: null,
      evidence: [],
    });
    expect(sample?.request.truths[0]).toEqual({
      id: "d1",
      title: "NPE in render",
      description: "render() may return null",
      file: null,
      lineStart: null,
      lineEnd: null,
      category: null,
      severity: null,
    });
    expect(sample?.official.tp).toBe(1);
  });

  it("缺官方判定的 task（dataset 有、judge 无）跳过并计数", () => {
    const { samples, skippedTasks } = fixture();
    // Chart-1_round1 组装；Chart-1_round2 被 rounds 过滤；Missing-9 无输出/判定 → 跳过
    expect(samples).toHaveLength(1);
    expect(skippedTasks).toBe(1);
  });

  it("零缺陷侧（模型零输出或真值零卡）跳过——TN/平凡分支不构成一致性信息", () => {
    const tasks = parseMcrDataset(
      datasetLine("Empty-1_round1", { defects: [] }),
    );
    const outputs = parseMcrModelOutputs(outputLine("Empty-1_round1"));
    const judgments = parseMcrOfficialJudgments(judgmentLine("Empty-1_round1"));
    const { samples, skippedTasks } = buildCalibrationSamples({
      modelName: "m",
      tasks: tasks.records,
      outputs: outputs.records,
      judgments: judgments.records,
    });
    expect(samples).toHaveLength(0);
    expect(skippedTasks).toBe(1);
  });
});

describe("mcrCategoryDistribution — 类别分布参照", () => {
  it("taxonomy × severity 计数", () => {
    const tasks = parseMcrDataset(
      [datasetLine("A_round1"), datasetLine("B_round1")].join("\n"),
    );
    const distribution = mcrCategoryDistribution(tasks.records);
    expect(distribution.taxonomy).toEqual({ NullDereference: 2, ResourceLeak: 2 });
    expect(distribution.severity).toEqual({ major: 2, minor: 2 });
  });
});

import { describe, expect, it } from "vitest";
import type {
  JudgeFindingCard,
  JudgeRequest,
  JudgeTruthCard,
} from "../../src/judge/contracts.js";
import { buildJudgeMessages } from "../../src/judge/prompt.js";

function findingCard(overrides: Partial<JudgeFindingCard> = {}): JudgeFindingCard {
  return {
    id: "F001",
    title: "Null pointer dereference",
    description: "The variable x may be null when dereferenced.",
    file: "src/Main.java",
    line: 42,
    category: "NULL_SAFETY",
    evidence: ["src/Main.java:42"],
    ...overrides,
  };
}

function truthCard(overrides: Partial<JudgeTruthCard> = {}): JudgeTruthCard {
  return {
    id: "TRUTH-1",
    title: "Possible null reference",
    description: "x is used without a null check.",
    file: "src/Main.java",
    lineStart: 40,
    lineEnd: 45,
    category: "NULL_SAFETY",
    severity: "major",
    ...overrides,
  };
}

function request(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    caseId: "case-001",
    findings: [findingCard()],
    truths: [truthCard()],
    context: null,
    ...overrides,
  };
}

describe("buildJudgeMessages — 系统提示词", () => {
  it("保留官方匹配判据原文并标注两条 POC1 扩展判据", () => {
    const { systemPrompt } = buildJudgeMessages(request());
    expect(systemPrompt).toContain("semantic similarity");
    expect(systemPrompt).toContain("One-to-One Matching");
    expect(systemPrompt).toContain("Location Is A Hint, Not The Criterion");
    expect(systemPrompt).toContain("Fix Patch Explains The Defect");
    // 扩展判据必须显式标注（可审计：哪些判据不是官方原文）
    expect(systemPrompt).toContain("(EXTENSION)");
  });

  it("锁定 TP/FP/FN 计分语义与输出 JSON 要求", () => {
    const { systemPrompt } = buildJudgeMessages(request());
    expect(systemPrompt).toContain("**True Positive (TP)**");
    expect(systemPrompt).toContain("The output format must be valid JSON");
  });
});

describe("buildJudgeMessages — 用户提示词卡片渲染", () => {
  it("渲染 1 起索引的 ground_truth / model_defect XML 块与总数", () => {
    const { userPrompt } = buildJudgeMessages(
      request({
        findings: [findingCard(), findingCard({ id: "F002" })],
        truths: [truthCard(), truthCard({ id: "TRUTH-2" })],
      }),
    );
    expect(userPrompt).toContain("## Ground Truth Defects (Total: 2)");
    expect(userPrompt).toContain("<ground_truth_defect_1>");
    expect(userPrompt).toContain("<ground_truth_defect_2>");
    expect(userPrompt).toContain("## Model Output Defects (Total: 2)");
    expect(userPrompt).toContain("<model_defect_1>");
    expect(userPrompt).toContain("<model_defect_2>");
  });

  it("渲染位置/类别/严重级/证据标签，null 字段不出现", () => {
    const { userPrompt } = buildJudgeMessages(request());
    expect(userPrompt).toContain("<file>src/Main.java</file>");
    expect(userPrompt).toContain("<line>42</line>");
    expect(userPrompt).toContain("<lines>40-45</lines>");
    expect(userPrompt).toContain("<category>NULL_SAFETY</category>");
    expect(userPrompt).toContain("<severity>major</severity>");
    expect(userPrompt).toContain("<evidence>");

    const bare = buildJudgeMessages(
      request({
        findings: [findingCard({ file: null, line: null, category: null, evidence: [] })],
        truths: [
          truthCard({ file: null, lineStart: null, lineEnd: null, category: null, severity: null }),
        ],
      }),
    );
    expect(bare.userPrompt).not.toContain("<file>");
    expect(bare.userPrompt).not.toContain("<line>");
    expect(bare.userPrompt).not.toContain("<lines>");
    expect(bare.userPrompt).not.toContain("<category>");
    expect(bare.userPrompt).not.toContain("<severity>");
    expect(bare.userPrompt).not.toContain("<evidence>");
  });

  it("校准模式（title+description 卡片 + 无上下文）不渲染 MR 上下文区块", () => {
    const { userPrompt } = buildJudgeMessages(request());
    expect(userPrompt).not.toContain("## Merge Request Context");
    expect(userPrompt).not.toContain("<diff>");
    expect(userPrompt).not.toContain("<issue_description>");
    expect(userPrompt).not.toContain("<fix_patch>");
  });

  it("真值缺 title/description 时渲染 N/A 占位（不破坏块结构）", () => {
    const { userPrompt } = buildJudgeMessages(
      request({ truths: [truthCard({ title: null, description: null })] }),
    );
    expect(userPrompt).toContain("<title>N/A</title>");
    expect(userPrompt).toContain("<description>N/A</description>");
  });

  it("行区间渲染：单行 / 区间 / 单侧", () => {
    const single = buildJudgeMessages(request({ truths: [truthCard({ lineStart: 7, lineEnd: 7 })] }));
    expect(single.userPrompt).toContain("<lines>7</lines>");
    const oneSided = buildJudgeMessages(
      request({ truths: [truthCard({ lineStart: null, lineEnd: 9 })] }),
    );
    expect(oneSided.userPrompt).toContain("<lines>9</lines>");
  });

  it("转义 XML 特殊字符，防止卡片内容破坏标签结构", () => {
    const { userPrompt } = buildJudgeMessages(
      request({
        findings: [findingCard({ title: "a < b & c > d" })],
      }),
    );
    expect(userPrompt).toContain("a &lt; b &amp; c &gt; d");
    expect(userPrompt).not.toContain("a < b");
  });
});

describe("buildJudgeMessages — MR 上下文（POC1 判定链模式）", () => {
  it("渲染 issue_description / fix_patch / diff 区块", () => {
    const { userPrompt } = buildJudgeMessages(
      request({
        context: {
          issueDescription: "NPE reported by user",
          diff: "diff --git a/f b/f",
          fixPatch: "--- a/f\n+++ b/f",
        },
      }),
    );
    expect(userPrompt).toContain("## Merge Request Context");
    expect(userPrompt).toContain("<issue_description>\nNPE reported by user\n</issue_description>");
    expect(userPrompt).toContain("<fix_patch>\n--- a/f\n+++ b/f\n</fix_patch>");
    expect(userPrompt).toContain("## Code Diff\n<diff>\ndiff --git a/f b/f\n</diff>");
  });

  it("空字段区块省略（issue 为空串 / fixPatch null / diff 为空串）", () => {
    const { userPrompt } = buildJudgeMessages(
      request({
        context: { issueDescription: "", diff: "", fixPatch: null },
      }),
    );
    expect(userPrompt).toContain("## Merge Request Context");
    expect(userPrompt).not.toContain("<issue_description>");
    expect(userPrompt).not.toContain("<fix_patch>");
    expect(userPrompt).not.toContain("<diff>");
  });
});

describe("buildJudgeMessages — 有界截断", () => {
  it("超限文本截断并内联留痕标记", () => {
    const longText = "x".repeat(500);
    const { userPrompt } = buildJudgeMessages(
      request({ findings: [findingCard({ title: longText })] }),
      { maxDiffChars: 100, maxIssueDescriptionChars: 100, maxFixPatchChars: 100, maxTitleChars: 100, maxDescriptionChars: 4000, maxEvidenceEntries: 3, maxEvidenceCharsPerEntry: 400 },
    );
    expect(userPrompt).toContain("[truncated 400 chars]");
    expect(userPrompt).not.toContain(longText);
  });

  it("证据条数与单条长度均有界", () => {
    const { userPrompt } = buildJudgeMessages(
      request({
        findings: [
          findingCard({ evidence: ["abcdefg", "two", "three", "four", "five"] }),
        ],
      }),
      { maxDiffChars: 100, maxIssueDescriptionChars: 100, maxFixPatchChars: 100, maxTitleChars: 500, maxDescriptionChars: 4000, maxEvidenceEntries: 3, maxEvidenceCharsPerEntry: 5 },
    );
    // 条数上限：前三条进入，后两条丢弃
    expect(userPrompt).toContain("abcde");
    expect(userPrompt).toContain("two");
    expect(userPrompt).toContain("three");
    expect(userPrompt).not.toContain("four");
    expect(userPrompt).not.toContain("five");
    // 单条长度上限：超长证据截断留痕（"abcdefg" → 5 字符 + 截断标记）
    expect(userPrompt).toContain("abcde\n[truncated 2 chars]");
    expect(userPrompt).not.toContain("abcdefg");
  });
});

describe("buildJudgeMessages — 输出格式契约", () => {
  it("声明 1 起索引字段与 confidence 词表，嵌入双方总数", () => {
    const { userPrompt } = buildJudgeMessages(
      request({ findings: [findingCard(), findingCard({ id: "F002" })] }),
    );
    expect(userPrompt).toContain('"model_defect_index": 1');
    expect(userPrompt).toContain('"ground_truth_defect_index"');
    expect(userPrompt).toContain("One of \"high\", \"medium\", \"low\", \"none\"");
    expect(userPrompt).toContain('"total_ground_truth": 1');
    expect(userPrompt).toContain('"total_model_outputs": 2');
    expect(userPrompt).toContain("Output ONLY valid JSON");
  });
});

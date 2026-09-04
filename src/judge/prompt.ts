/**
 * LLM-Hit-Judge 提示词构造（纯函数、确定性：同输入恒同字节）。
 *
 * 来源：MCR-Bench 官方 evaluation/Metric/prompt_builder.py 的 build_matching_prompt
 * （2026-09-03 逐字核验）。系统提示词保持官方原文，追加两条 POC1 扩展判据
 * （标注 EXTENSION），均不改变官方匹配语义：
 * - 位置是提示不是判据（研究笔记坑 2：位置缺失/偏差时只做语义匹配）；
 * - fix_patch 用于理解缺陷身份（逆补丁法真值侧）。
 *
 * 卡片渲染：官方 <ground_truth_defect_N>/<model_defect_N> 块结构，字段标签按需渲染
 * （null 字段不出现）；校准模式（context = null 且卡片只有 id/title/description）
 * 渲染结果与官方提示词逐块同构，保证 judge 校准的一致性比较不受信息面差异污染。
 */

import type {
  JudgeContextLimits,
  JudgeFindingCard,
  JudgeMrContext,
  JudgeRequest,
  JudgeTruthCard,
} from "./contracts.js";
import { DEFAULT_JUDGE_CONTEXT_LIMITS } from "./contracts.js";

export interface JudgeMessages {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

/** 系统提示词：官方原文 + 两条标注的 POC1 扩展判据 */
const SYSTEM_PROMPT = `You are a code review evaluation expert. Your task is to determine whether defects in the model output match defects in the ground truth.

## Matching Criteria

The primary criterion for matching is **semantic similarity** - whether two defects describe the same or highly similar code issues.

### How to Judge Semantic Similarity:

1. **Core Problem Identification**
   - Compare the fundamental issue being described in both defects
   - Two defects match if they identify the same underlying problem, even if expressed differently
   - Example: "Null pointer dereference" and "Potential null reference exception" are semantically similar

2. **Description Analysis**
   - Focus on the essence of the problem, not exact wording
   - Consider synonyms and different phrasings of the same concept
   - Ignore minor differences in terminology or style

3. **Context Understanding**
   - Understand the code issue context from the description
   - Match defects that address the same code problem even if described from different angles

### Matching Rules:

- **True Positive (TP)**: A model defect matches a ground truth defect if they describe the same or highly similar code issue semantically
- **False Positive (FP)**: A model defect that cannot be matched to any ground truth defect (the model incorrectly identified a non-existent issue)
- **False Negative (FN)**: A ground truth defect that cannot be matched to any model defect (the model missed a real issue)

### Important Guidelines:

1. **One-to-One Matching**: Each model defect can match at most one ground truth defect, and vice versa
2. **Best Match Priority**: If a model defect could potentially match multiple ground truth defects, choose the best semantic match
3. **Strict Matching**: Only match defects that are semantically similar. Do not force matches for dissimilar defects
4. **Completeness**: Ensure you check all model defects against all ground truth defects
5. **Location Is A Hint, Not The Criterion** (EXTENSION): file and line information helps locate the code under discussion, but it is not the matching criterion. A pair still matches when the described problem is the same but the reported location is imprecise or differs. When a side carries no location information, judge on semantics alone. A pair does not match when the described problems are different, even if they sit in the same file and lines.
6. **Fix Patch Explains The Defect** (EXTENSION): a ground truth may include a minimal fix patch; it shows the code change that removes the defect. Use it to understand what the defect is, but do not require the model defect to mention the fix itself.

The output format must be valid JSON containing the matching results.`;

/** 入口：JudgeRequest → (system, user) 提示词对 */
export function buildJudgeMessages(
  request: JudgeRequest,
  limits: JudgeContextLimits = DEFAULT_JUDGE_CONTEXT_LIMITS,
): JudgeMessages {
  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(request, limits),
  };
}

function buildUserPrompt(request: JudgeRequest, limits: JudgeContextLimits): string {
  const sections = [
    "Please determine whether the defects in the model output match the defects in the ground truth based on semantic similarity.",
  ];
  const contextSection = renderContextSection(request.context, limits);
  if (contextSection !== null) {
    sections.push(contextSection);
  }
  sections.push(renderTruthsSection(request.truths, limits));
  sections.push(renderFindingsSection(request.findings, limits));
  sections.push(INSTRUCTIONS_SECTION);
  sections.push(renderOutputFormatSection(request.truths.length, request.findings.length));
  return `${sections.join("\n\n")}\n`;
}

function renderContextSection(context: JudgeMrContext | null, limits: JudgeContextLimits): string | null {
  if (context === null) {
    return null;
  }
  const parts: string[] = ["## Merge Request Context"];
  if (context.issueDescription.trim().length > 0) {
    parts.push(`<issue_description>\n${truncate(context.issueDescription, limits.maxIssueDescriptionChars)}\n</issue_description>`);
  }
  if (context.fixPatch !== null && context.fixPatch.trim().length > 0) {
    parts.push(`<fix_patch>\n${truncate(context.fixPatch, limits.maxFixPatchChars)}\n</fix_patch>`);
  }
  if (context.diff.trim().length > 0) {
    parts.push(`## Code Diff\n<diff>\n${truncate(context.diff, limits.maxDiffChars)}\n</diff>`);
  }
  return parts.join("\n\n");
}

function renderTruthsSection(truths: readonly JudgeTruthCard[], limits: JudgeContextLimits): string {
  const blocks = truths.map((card, index) => {
    const tags = [
      `<id>${escapeText(card.id)}</id>`,
      `<title>${truncate(escapeText(card.title ?? "N/A"), limits.maxTitleChars)}</title>`,
      `<description>${truncate(escapeText(card.description ?? "N/A"), limits.maxDescriptionChars)}</description>`,
    ];
    if (card.file !== null) {
      tags.push(`<file>${escapeText(card.file)}</file>`);
    }
    if (card.lineStart !== null || card.lineEnd !== null) {
      tags.push(`<lines>${renderLineRange(card.lineStart, card.lineEnd)}</lines>`);
    }
    if (card.category !== null) {
      tags.push(`<category>${escapeText(card.category)}</category>`);
    }
    if (card.severity !== null) {
      tags.push(`<severity>${escapeText(card.severity)}</severity>`);
    }
    return `<ground_truth_defect_${index + 1}>\n${tags.join("\n")}\n</ground_truth_defect_${index + 1}>`;
  });
  return `## Ground Truth Defects (Total: ${truths.length})\n${blocks.join("\n")}`;
}

function renderFindingsSection(findings: readonly JudgeFindingCard[], limits: JudgeContextLimits): string {
  const blocks = findings.map((card, index) => {
    const tags = [
      `<id>${escapeText(card.id)}</id>`,
      `<title>${truncate(escapeText(card.title), limits.maxTitleChars)}</title>`,
      `<description>${truncate(escapeText(card.description), limits.maxDescriptionChars)}</description>`,
    ];
    if (card.file !== null) {
      tags.push(`<file>${escapeText(card.file)}</file>`);
    }
    if (card.line !== null) {
      tags.push(`<line>${card.line}</line>`);
    }
    if (card.category !== null) {
      tags.push(`<category>${escapeText(card.category)}</category>`);
    }
    if (card.evidence.length > 0) {
      const entries = card.evidence
        .slice(0, limits.maxEvidenceEntries)
        .map((entry) => truncate(escapeText(entry), limits.maxEvidenceCharsPerEntry));
      tags.push(`<evidence>\n${entries.join("\n")}\n</evidence>`);
    }
    return `<model_defect_${index + 1}>\n${tags.join("\n")}\n</model_defect_${index + 1}>`;
  });
  return `## Model Output Defects (Total: ${findings.length})\n${blocks.join("\n")}`;
}

const INSTRUCTIONS_SECTION = `## Instructions

1. For each model defect, determine if it semantically matches any ground truth defect
2. Compare the core problem described in the title and description
3. Match defects that describe the same underlying code issue, even if worded differently
4. Assign each model defect to at most one ground truth defect (the best match)
5. Identify all unmatched ground truth defects (false negatives)
6. Identify all unmatched model defects (false positives)`;

function renderOutputFormatSection(truthCount: number, findingCount: number): string {
  return `## Output Format

You must output valid JSON with the following structure:

{
  "matches": [
    {
      "model_defect_index": 1,
      "ground_truth_defect_index": 1,
      "match_confidence": "high",
      "match_reason": "Both defects describe the same null pointer dereference issue in the same code context"
    }
  ],
  "unmatched_ground_truth": [2, 3],
  "summary": {
    "total_ground_truth": ${truthCount},
    "total_model_outputs": ${findingCount},
    "matched_pairs": 0,
    "false_positives": 0,
    "false_negatives": 0
  }
}

### Field Descriptions:

- **matches**: Array of match results
  - \`model_defect_index\`: Index of the model defect (starting from 1)
  - \`ground_truth_defect_index\`: Index of the matched ground truth defect (starting from 1), or \`null\` if no match
  - \`match_confidence\`: One of "high", "medium", "low", "none"
  - \`match_reason\`: Brief explanation of why they match (or why they don't match if confidence is "none")

- **unmatched_ground_truth**: Array of ground truth defect indices (starting from 1) that were not matched by any model defect

- **summary**: Overall statistics
  - \`matched_pairs\`: Number of successfully matched pairs (TP)
  - \`false_positives\`: Number of model defects that could not be matched (FP)
  - \`false_negatives\`: Number of ground truth defects that were not matched (FN)

**CRITICAL**: Output ONLY valid JSON. Do not include markdown code blocks, explanations outside the JSON, or any other text.`;
}

function renderLineRange(lineStart: number | null, lineEnd: number | null): string {
  if (lineStart !== null && lineEnd !== null) {
    return lineStart === lineEnd ? `${lineStart}` : `${lineStart}-${lineEnd}`;
  }
  if (lineStart !== null) {
    return `${lineStart}`;
  }
  return `${lineEnd ?? "unknown"}`;
}

/** 有界截断：超限内容截断并内联标记（审计可见，不静默丢失信号） */
function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "[truncated]";
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`;
}

/** XML 文本节点的最小转义（& < >），保持卡片内容不破坏标签结构 */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

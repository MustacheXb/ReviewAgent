import type { MRCase } from "../contracts/mr-case.js";

/**
 * Claude Code 外部参照提示词（Ticket 13 / issue #14）。
 *
 * 同目标纪律：检视使命 / Finding Schema / Severity 定义与主 harness 的 Zone A
 * （src/loop/messages.ts SYSTEM_PROMPT）逐字对齐——外部参照比较的是同一检视目标
 * 下的跨模型能力，提示词差异会污染对比。差异仅两处（刻意保留）：
 * 1. Claude Code 以自身 agent 形态运行（可用仓库读取工具、自主多轮），
 *    不复刻主 harness 的六阶段骨架——参照测的是"Claude Code 本来的样子"；
 * 2. 输出载体从"每阶段一条 JSON 回复"改为"最终单条 {"findings": [...]}"。
 *
 * 模板版本：提示词演进时递增（随计划落盘并作续跑兼容守卫；旧记录不与新模板混跑）。
 */
export const CLAUDE_CODE_PROMPT_TEMPLATE_VERSION = "claude-code-reference-1";

/**
 * 构造完整提示词（纯函数、确定性：同 case 同字节）。
 * 结构：角色与使命 → 检视输入（caseId / issue 描述 / diff，与主 harness 初始
 * user 消息同内容）→ Finding Schema 与 Severity → 输出纪律。
 */
export function buildClaudeCodePrompt(mrCase: MRCase): string {
  const issueDescription =
    mrCase.issueDescription.trim().length > 0 ? mrCase.issueDescription : "(none)";
  return [
    "You are a senior Java code reviewer. Review the merge request (MR) below and produce structured, evidence-backed findings.",
    "",
    "The current working directory is the repository snapshot at the MR base state. You may read files and search the repository as needed to build context.",
    "",
    "## Merge request under review",
    "",
    `Case ID: ${mrCase.caseId}`,
    "Issue description:",
    issueDescription,
    "",
    "Unified diff:",
    "```diff",
    mrCase.diff,
    "```",
    "",
    "## Finding schema",
    "Each finding is a JSON object with exactly these fields:",
    '- id: string, stable identifier, e.g. "F001"',
    '- severity: "P0" | "P1" | "P2" | "P3"',
    '- category: string, e.g. "CORRECTNESS", "RESOURCE", "CONCURRENCY", "SECURITY", "PERFORMANCE", "MAINTAINABILITY"',
    "- file: string, repository-relative path of the affected file",
    "- line: integer >= 1, line number in the file after the MR is applied",
    "- title: string, one-line summary",
    "- description: string, detailed explanation of the issue and its impact",
    "- evidence: array of strings, each entry cites a concrete symbol, line number, or code excerpt",
    '- rule: string, rule or pattern identifier, e.g. "CORRECTNESS-001"',
    "- confidence: number between 0 and 1",
    "",
    "## Severity definitions",
    "- P0: Critical. Must fix before merge (security vulnerability, data loss, crash).",
    "- P1: Major. Likely bug that breaks existing behavior or introduces a serious defect.",
    "- P2: Minor. Possible issue, edge case, or maintainability concern.",
    "- P3: Info. Style, naming, or documentation nit.",
    "",
    "## Evidence policy",
    "Every finding must cite concrete evidence: specific symbols, line numbers, and code excerpts available in the MR diff or the repository you inspected.",
    "",
    "## Reply discipline",
    "All output must be in English. Reply with a single JSON object and no other text:",
    '{"findings": [ { ...finding objects following the schema above... } ]}',
    "If the merge request has no issues, reply with an empty findings array: {\"findings\": []}.",
  ].join("\n");
}

import type { MRCase } from "../contracts/mr-case.js";
import type { LlmMessage } from "../contracts/llm-client.js";
import { resolveOutputLanguage, type OutputLanguage } from "../contracts/output-language.js";

/**
 * Zone A 稳定前缀：检视角色、政策、六阶段方法论、输出 Schema、Severity 定义、Evidence Policy。
 * 字节稳定：不含任何 run 特定数据（caseId / diff 均在 Zone C），同一 harness 版本内所有请求共享同一字节。
 *
 * #53（spec #49 / ADR-0010）起按语言分序列：主体英文不动，仅 Output language
 * 节按语言渲染——每语言一条冻结字节序列（前缀缓存按请求头部字节精确匹配，
 * 序列内字节恒定）；en 序列与分序列改造前逐字节相同（en 是全部既有实验
 * 结论的锚定形态），zh 序列为新增的一条冻结前缀。
 */
const PROMPT_HEAD = [
  "You are a senior Java code reviewer running inside a controlled review harness.",
  "",
  "## Mission",
  "Review the merge request (MR) provided by the user and produce structured, evidence-backed findings.",
  "",
  "## Review methodology (fixed phase order)",
  "The review proceeds through six phases. In each phase the harness instructs you with a \"Phase N of 6\" message. Phases always execute in this order:",
  "1. Change Understanding",
  "2. Risk Classification",
  "3. Context Decision",
  "4. Context Retrieval",
  "5. Deep Reasoning",
  "6. Evidence Verification",
  "",
  "## Evidence policy (No Evidence, No Finding)",
  "Every candidate finding must cite concrete evidence: specific symbols, line numbers, and code excerpts available in the MR diff or the conversation context. Candidates without evidence are rejected by the Evidence Gate and will not appear in the final findings.",
  "",
];

/**
 * Output language 节（唯一按语言渲染的一节）：指令以英文书写，内容指定
 * 目标输出语言与「代码摘录 / 路径 / 标识符 / 枚举不翻译」约束。zh 句与
 * #55 语言门对称（title / description 至少其一含中文，缺失即语言违规）。
 */
const OUTPUT_LANGUAGE_SECTIONS: Readonly<Record<OutputLanguage, readonly string[]>> = {
  en: [
    "## Output language",
    "All review output must be in English. Findings containing non-English text are rejected.",
  ],
  zh: [
    "## Output language",
    "Findings must be in Chinese: write the title, the description, and the natural-language parts of evidence entries in Chinese. Keep code excerpts, file paths, identifiers, and enum values exactly as written; never translate them. A finding is rejected when neither its title nor its description contains Chinese text.",
  ],
};

const PROMPT_TAIL = [
  "",
  "## Finding schema",
  "Each candidate finding is a JSON object with exactly these fields:",
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
  "## Risk classes",
  "- Low: comments, renames, formatting, mechanical changes.",
  "- Medium: business logic, API, state, or data-structure changes.",
  "- High: concurrency, transaction, security, resource, distributed, performance, or lifecycle changes.",
  "",
  "## Reply discipline",
  "When a phase message asks for a JSON reply, reply with a single JSON object and no other text.",
];

/** 渲染 Zone A 冻结序列（按语言；序列内字节恒定——分序列是前缀缓存纪律的前提） */
function renderSystemPrompt(outputLanguage: OutputLanguage): string {
  return [...PROMPT_HEAD, ...OUTPUT_LANGUAGE_SECTIONS[outputLanguage], ...PROMPT_TAIL].join("\n");
}

/** en 冻结序列（与分序列改造前逐字节相同；既有 golden / parity 期望的锚点） */
export const SYSTEM_PROMPT = renderSystemPrompt("en");

/** Zone A 的 system 消息（outputLanguage 缺省 en；非法值 fail fast 人话错误） */
export function buildSystemMessage(outputLanguage?: OutputLanguage): LlmMessage {
  return { role: "system", content: renderSystemPrompt(resolveOutputLanguage(outputLanguage)) };
}

/**
 * config B 注入的确定性上下文消息（工单 #4 挂载点）。
 * 消息在循环开始前一次性构造，循环内严格 append-only（只追加、不重排、不改写）。
 */
export interface ContextMessages {
  /** Zone B：插在 system（Zone A）之后、初始 user 消息（Zone C 起点）之前 */
  readonly zoneB?: readonly LlmMessage[];
  /** 预取层：按固定管线顺序（Symbol → Reference → Call Chain）追加在初始 user 消息之后 */
  readonly prefetch?: readonly LlmMessage[];
  /** config C 全仓注入：追加在初始 user 消息（及预取层，若有）之后（工单 #6 扩展字段） */
  readonly fullRepo?: readonly LlmMessage[];
}

/** 初始消息序列：[system(Zone A), Zone B?, 初始 user(Zone C 起点 / Diff 层), 预取层?, 全仓注入?] */
export function buildInitialMessages(
  mrCase: MRCase,
  contextMessages: ContextMessages = {},
  outputLanguage?: OutputLanguage,
): readonly LlmMessage[] {
  return [
    buildSystemMessage(outputLanguage),
    ...(contextMessages.zoneB ?? []),
    buildInitialUserMessage(mrCase),
    ...(contextMessages.prefetch ?? []),
    ...(contextMessages.fullRepo ?? []),
  ];
}

/** Zone C 起点：MR 输入（caseId、issue 描述、unified diff），只追加、不改写 */
export function buildInitialUserMessage(mrCase: MRCase): LlmMessage {
  const issueDescription =
    mrCase.issueDescription.trim().length > 0 ? mrCase.issueDescription : "(none)";
  const content = [
    "Merge request under review.",
    "",
    `Case ID: ${mrCase.caseId}`,
    "Issue description:",
    issueDescription,
    "",
    "Unified diff:",
    "```diff",
    mrCase.diff,
    "```",
  ].join("\n");
  return { role: "user", content };
}

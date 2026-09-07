import type { LlmRequest } from "../contracts/llm-client.js";
import type { CacheBreakRecord, CacheBreakReason } from "../contracts/run.js";

/**
 * Cache Break 原因分类器（spec #1 user story 13）：对相邻请求做字节前缀分歧检测，
 * 将首个分歧位置映射到 Zone 分区得到原因分类。
 *
 * 纯观测纪律：只读取请求数组，绝不修改请求字节（Zone A 字节稳定是既有测试锚点）；
 * 分类结果随审计留痕（RunAudit.cacheBreaks），供报告 / dashboard 归因缓存命中率波动。
 *
 * 分歧判定（规范字节布局镜像线上 wire 字段序：model 段 → messages 段 → tools 段）：
 * - model 段分歧 → MODEL_CHANGED；
 * - messages[0]（system，Zone A 头部）分歧 → SYSTEM_PROMPT_CHANGED；
 * - messages 中段（非首条 system）分歧 → CONTEXT_REORDERED（重排 / 中段插入 / 改写）；
 * - 消息序列一致而 tools 段分歧 → TOOL_SCHEMA_CHANGED（Zone A 工具 schema）。
 *
 * 前缀语义：下一请求是前一请求的前缀（append-only 增长或收缩）不构成 break——
 * 前缀缓存对"新请求 ⊂ 旧请求"仍全额命中，命中率波动只能来自稳定前缀被破坏。
 */

/** 全部原因分类的规范序（报告 / dashboard 列序） */
export const CACHE_BREAK_REASONS: readonly CacheBreakReason[] = [
  "MODEL_CHANGED",
  "SYSTEM_PROMPT_CHANGED",
  "TOOL_SCHEMA_CHANGED",
  "CONTEXT_REORDERED",
];

/** 请求对的规范字节布局（各段独立序列化，段起点可计算） */
interface RequestLayout {
  readonly modelBytes: string;
  readonly messageBytes: readonly string[];
  readonly toolsBytes: string;
  readonly messagesStart: number;
  readonly toolsStart: number;
}

/** 对请求序列的全部相邻对做分类（requests[i-1] vs requests[i]，i = 1..n-1） */
export function classifyCacheBreaks(requests: readonly LlmRequest[]): readonly CacheBreakRecord[] {
  if (!Array.isArray(requests)) {
    return [];
  }
  const records: CacheBreakRecord[] = [];
  for (let index = 1; index < requests.length; index++) {
    const record = classifyAdjacentPair(requests[index - 1], requests[index], index);
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}

function classifyAdjacentPair(
  previous: LlmRequest,
  next: LlmRequest,
  requestIndex: number,
): CacheBreakRecord | null {
  if (!isClassifiableRequest(previous) || !isClassifiableRequest(next)) {
    return null;
  }
  const a = layoutOf(previous);
  const b = layoutOf(next);
  if (a.modelBytes !== b.modelBytes) {
    return {
      requestIndex,
      reason: "MODEL_CHANGED",
      zone: "MODEL",
      divergeByteOffset: firstDiffOffset(a.modelBytes, b.modelBytes),
    };
  }
  const messageBreak = classifyMessageDivergence(previous, a, b, requestIndex);
  if (messageBreak !== null) {
    return messageBreak;
  }
  // 消息序列逐条一致（前缀关系：append-only 增长或收缩都不破坏前缀缓存）→ 比对 tools 段
  if (a.toolsBytes !== b.toolsBytes) {
    return {
      requestIndex,
      reason: "TOOL_SCHEMA_CHANGED",
      zone: "A",
      divergeByteOffset: a.toolsStart + firstDiffOffset(a.toolsBytes, b.toolsBytes),
    };
  }
  return null;
}

function classifyMessageDivergence(
  previous: LlmRequest,
  a: RequestLayout,
  b: RequestLayout,
  requestIndex: number,
): CacheBreakRecord | null {
  const shared = Math.min(a.messageBytes.length, b.messageBytes.length);
  for (let index = 0; index < shared; index++) {
    const previousBytes = a.messageBytes[index];
    const nextBytes = b.messageBytes[index];
    if (previousBytes === undefined || nextBytes === undefined || previousBytes === nextBytes) {
      continue;
    }
    // 分歧字节位置 = messages 段起点 + 该条消息前的布局前缀 + 消息内首个差异字符
    const offset =
      a.messagesStart +
      messagePrefixLength(a.messageBytes, index) +
      firstDiffOffset(previousBytes, nextBytes);
    const systemHead = index === 0 && previous.messages[0]?.role === "system";
    return systemHead
      ? { requestIndex, reason: "SYSTEM_PROMPT_CHANGED", zone: "A", divergeByteOffset: offset }
      : { requestIndex, reason: "CONTEXT_REORDERED", zone: "B/C", divergeByteOffset: offset };
  }
  return null;
}

/** 规范字节布局：model 段 → messages 段（逐条序列化）→ tools 段 */
function layoutOf(request: LlmRequest): RequestLayout {
  const modelBytes = JSON.stringify(request.model);
  const messageBytes = request.messages.map((message) => JSON.stringify(message));
  const toolsBytes = JSON.stringify(request.tools);
  const messagesStart = modelBytes.length;
  return {
    modelBytes,
    messageBytes,
    toolsBytes,
    messagesStart,
    toolsStart: messagesStart + messagesSegmentLength(messageBytes),
  };
}

/** messages 段在布局中的总长："[" + m0 + "," + … + "]"；空数组 = "[]" */
function messagesSegmentLength(messageBytes: readonly string[]): number {
  if (messageBytes.length === 0) {
    return 2;
  }
  const contentLength = messageBytes.reduce((sum, bytes) => sum + bytes.length, 0);
  return contentLength + messageBytes.length + 1;
}

/** 第 index 条消息前的布局前缀长："[" + m0 + "," + … + "," */
function messagePrefixLength(messageBytes: readonly string[], index: number): number {
  let length = 1;
  for (let i = 0; i < index; i++) {
    length += (messageBytes[i] ?? "").length + 1;
  }
  return length;
}

/** 两段字节的首个差异位置；无差异时返回公共长度（一方为另一方前缀） */
function firstDiffOffset(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    if (a[index] !== b[index]) {
      return index;
    }
  }
  return shared;
}

function isClassifiableRequest(request: unknown): request is LlmRequest {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const record = request as Partial<LlmRequest>;
  return typeof record.model === "string" && Array.isArray(record.messages) && Array.isArray(record.tools);
}

/** 按原因分类计数（报告 / dashboard 的统计口径；零值字段保留，列序恒定） */
export function tallyCacheBreakReasons(
  records: readonly CacheBreakRecord[],
): Readonly<Record<CacheBreakReason, number>> {
  const tally: Record<CacheBreakReason, number> = {
    MODEL_CHANGED: 0,
    SYSTEM_PROMPT_CHANGED: 0,
    TOOL_SCHEMA_CHANGED: 0,
    CONTEXT_REORDERED: 0,
  };
  for (const record of records) {
    if (tally[record.reason] !== undefined) {
      tally[record.reason]++;
    }
  }
  return tally;
}

import type { ToolCall } from "../contracts/llm-client.js";
import type { ToolCallRecord } from "../contracts/run.js";

/**
 * 工具执行 seam（T03 挂载点）。
 * T01 的 config A 不挂任何工具；T03 在此接口上实现 7 个零构建 review.* 工具。
 */
export interface ToolExecutor {
  /** 执行一次工具调用，返回工具结果内容（进入 tool 角色消息与审计 resultSummary） */
  execute(call: ToolCall): Promise<string>;
}

/** 工具调用被跳过（工具未启用或预算耗尽）时的审计记录 */
export function skippedToolCallRecord(call: ToolCall, reason: string): ToolCallRecord {
  return { name: call.name, argumentsJson: call.argumentsJson, resultSummary: `SKIPPED: ${reason}` };
}

/** 工具执行失败的审计记录（失败也计入工具调用预算，防失败死循环） */
export function failedToolCallRecord(call: ToolCall, message: string): ToolCallRecord {
  return { name: call.name, argumentsJson: call.argumentsJson, resultSummary: `ERROR: ${message}` };
}

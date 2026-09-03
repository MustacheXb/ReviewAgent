import type { ToolCall, ToolSchema } from "../contracts/llm-client.js";
import type { ToolExecutor } from "../loop/tools.js";
import type { RepoContext } from "../zoneb/repo-context.js";
import { toCanonicalJson } from "./json-canonical.js";

/**
 * review.* 工具注册表（spec #1 工单 #6；主文档第 20 章 Tool Schema Optimization）。
 *
 * 注册表层纪律：
 * - 工具名必须属于固定清单 REVIEW_TOOL_ORDER，数量 / 顺序 / schema 固定；
 * - parametersJson 由注册表统一经 toCanonicalJson 序列化（固定字段顺序），
 *   同一 schema 结构永远产出同一字节串——C/D/E 挂载零漂移（Zone A 稳定前缀的一部分）；
 * - 工具 schema 属 Zone A（字节稳定），工具结果属 Zone C（append-only）。
 *
 * T06（检索工具四件套）扩展方式：新增 buildReviewSearchTools() 产出
 * ReviewToolDefinition[]，并在 toolkit.ts 的装配处并入——注册表按
 * REVIEW_TOOL_ORDER 自动排序与查重，schema 序列化无需任何额外处理。
 */

/**
 * 7 个 review.* 工具的固定顺序（设计文档第 20 章：Tool 数量/顺序/Schema 固定）。
 * T05 实现前三个（读取三件套）；T06 补齐后四个（检索四件套）。
 */
export const REVIEW_TOOL_ORDER: readonly string[] = [
  "review.get_diff",
  "review.get_symbol",
  "review.get_file",
  "review.find_references",
  "review.get_call_chain",
  "review.search_rule",
  "review.search_history",
];

/** 工具运行时上下文（executor 执行时所需的最小输入） */
export interface ToolRunContext {
  /** MR unified diff（review.get_diff 数据源） */
  readonly diff: string;
  /** 仓库快照读取层（懒加载 memoize；get_symbol / get_file 数据源） */
  readonly repo: () => Promise<RepoContext>;
  /** 单次工具结果字符预算 */
  readonly resultBudgetChars: number;
}

/** 工具定义：参数 schema 以结构化对象声明，序列化由注册表统一保证字节稳定 */
export interface ReviewToolDefinition {
  readonly name: string;
  readonly description: string;
  /** 参数 JSON Schema（对象；键序无关，序列化固定） */
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolRunContext): Promise<string>;
}

/** 注册后的工具（含字节稳定的 parametersJson 与执行器） */
export interface RegisteredReviewTool {
  readonly name: string;
  readonly description: string;
  readonly parametersJson: string;
  execute(args: Record<string, unknown>, context: ToolRunContext): Promise<string>;
}

/** 把工具定义组装为注册表工具：查重、校验固定清单、按固定顺序排序、schema 规范化序列化 */
export function assembleReviewTools(
  definitions: readonly ReviewToolDefinition[],
): readonly RegisteredReviewTool[] {
  const byName = new Map<string, ReviewToolDefinition>();
  for (const definition of definitions) {
    if (!REVIEW_TOOL_ORDER.includes(definition.name)) {
      throw new Error(
        `tool "${definition.name}" is not part of the fixed review.* tool set (${REVIEW_TOOL_ORDER.join(", ")})`,
      );
    }
    if (byName.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is registered more than once`);
    }
    if (typeof definition.description !== "string" || definition.description.trim().length === 0) {
      throw new Error(`tool "${definition.name}" must declare a non-empty description`);
    }
    byName.set(definition.name, definition);
  }
  return REVIEW_TOOL_ORDER.flatMap((name) => {
    const definition = byName.get(name);
    return definition === undefined
      ? []
      : [
          {
            name: definition.name,
            description: definition.description,
            parametersJson: toCanonicalJson(definition.parameters),
            execute: definition.execute,
          },
        ];
  });
}

/** 注册表工具 → 请求挂载的 ToolSchema（name/description/parametersJson 字段固定） */
export function toToolSchema(tool: RegisteredReviewTool): ToolSchema {
  return { name: tool.name, description: tool.description, parametersJson: tool.parametersJson };
}

/** 由注册表工具集构造 ToolExecutor（runReview 的 toolExecutor 挂载点） */
export function createToolExecutor(
  tools: readonly RegisteredReviewTool[],
  context: ToolRunContext,
): ToolExecutor {
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
  return {
    execute: async (call: ToolCall): Promise<string> => {
      const tool = byName.get(call.name);
      if (tool === undefined) {
        throw new Error(
          `unknown tool "${boundedEcho(call.name, 60)}" (available: ${tools.map((entry) => entry.name).join(", ")})`,
        );
      }
      const args = parseToolArguments(call);
      return tool.execute(args, context);
    },
  };
}

/**
 * 工具入参校验：argumentsJson 必须是合法 JSON 对象（解析失败有界失败——
 * 错误信息只回显截断后的入参，不透传超长原文）。
 */
export function parseToolArguments(call: ToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.argumentsJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${call.name}: arguments are not valid JSON (got ${boundedEcho(call.argumentsJson, 80)}): ${message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${call.name}: arguments must be a JSON object (got ${boundedEcho(call.argumentsJson, 80)})`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** 必填字符串参数 */
export function requireStringArg(
  toolName: string,
  args: Record<string, unknown>,
  field: string,
): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${toolName}: argument "${field}" must be a non-empty string`);
  }
  return value;
}

/** 可选正整数参数（缺省 undefined） */
export function optionalPositiveIntArg(
  toolName: string,
  args: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = args[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${toolName}: argument "${field}" must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** 错误信息中的原文回显（有界） */
export function boundedEcho(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}...`;
}

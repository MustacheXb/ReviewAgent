import type { KnowledgeEntry } from "../contracts/knowledge.js";
import type { RepoContext } from "../zoneb/repo-context.js";
import type { ChangedSymbolRef } from "../zoneb/changed-symbols.js";
import { qualifiedName } from "../zoneb/changed-symbols.js";
import { buildCallChainBlocks } from "../zoneb/call-chain.js";
import type { ReferenceSite } from "../zoneb/reference-sites.js";
import { enclosingLabel, findReferenceSites } from "../zoneb/reference-sites.js";
import type { JavaSymbol } from "../zoneb/symbols.js";
import { readThroughLedger } from "./ledger.js";
import { applyLineBudget } from "./result-budget.js";
import type { ReviewToolDefinition } from "./registry.js";
import { boundedEcho, requireStringArg } from "./registry.js";

/**
 * 检索工具四件套（spec #1 工单 #7；ADR-0003：零构建静态解析）。
 *
 * - review.find_references：ripgrep 名字级全词引用匹配（词法天花板为已知限制，
 *   重载/override 误报可接受——实验内各配置共享同一精度）；
 * - review.get_call_chain：1~2 层名字级引用链（Q27 降级范围，复用 config B
 *   固定管线的 buildCallChainBlocks，不越界实现）；
 * - review.search_rule / review.search_history：C3 Knowledge 语料的
 *   大小写不敏感子串文本检索（POC1 最薄可用版，语料静态注入，默认空）。
 *
 * 共同纪律：入参显式校验；输出确定性（同输入永远同字节）；超预算在行边界
 * 截断并留痕；错误有界且不泄漏仓库绝对路径。
 * T07 Context Ledger：find_references / get_call_chain 登记为 symbol
 * （标识 = 工具名 + 符号名），search_rule / search_history 登记为 evidence
 * （标识 = 工具名 + query）；重复的同一规范化请求返回 "Already loaded: ctx#NNN" 引用。
 */

/** 检索四件套的固定定义（顺序由注册表 REVIEW_TOOL_ORDER 保证） */
export function buildReviewSearchTools(): readonly ReviewToolDefinition[] {
  return [FIND_REFERENCES_TOOL, GET_CALL_CHAIN_TOOL, SEARCH_RULE_TOOL, SEARCH_HISTORY_TOOL];
}

export const FIND_REFERENCES_TOOL: ReviewToolDefinition = {
  name: "review.find_references",
  description:
    "Find name-level references to a symbol across all Java sources (whole-word, case-sensitive match; no type resolution, so overloads and overrides are not distinguished). Returns declaration and usage sites with their enclosing symbols.",
  parameters: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Simple (unqualified) symbol name to search for, e.g. \"sumFirst\" or \"MathUtils\".",
      },
    },
    required: ["symbol"],
    additionalProperties: false,
  },
  execute: async (args, context): Promise<string> => {
    const name = requireStringArg("review.find_references", args, "symbol");
    return readThroughLedger(
      context.ledger,
      "symbol",
      `review.find_references "${name}"`,
      async () => {
        const repo = await context.repo();
        const sites = await searchReferenceSites("review.find_references", repo, name);
        return renderReferenceSites(sites, name, context.resultBudgetChars);
      },
    );
  },
};

export const GET_CALL_CHAIN_TOOL: ReviewToolDefinition = {
  name: "review.get_call_chain",
  description:
    "Build a name-level call chain around a method or constructor: hop-1 callers, hop-2 callers of those callers, and callees invoked inside the method body. Whole-word name matching without type resolution; overloads are not distinguished.",
  parameters: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Simple name of the method or constructor to build the chain around, e.g. \"sumFirst\".",
      },
    },
    required: ["symbol"],
    additionalProperties: false,
  },
  execute: async (args, context): Promise<string> => {
    const name = requireStringArg("review.get_call_chain", args, "symbol");
    return readThroughLedger(
      context.ledger,
      "symbol",
      `review.get_call_chain "${name}"`,
      async () => {
        const repo = await context.repo();
        return renderCallChain(repo, name, context.resultBudgetChars);
      },
    );
  },
};

export const SEARCH_RULE_TOOL: ReviewToolDefinition = {
  name: "review.search_rule",
  description:
    "Search the project rule base (defect-pattern and business rules) with a case-insensitive substring query. Returns matching rule entries; entries are statically configured per run.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Case-insensitive substring to search for in rule titles and texts.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  execute: async (args, context): Promise<string> => {
    const query = requireStringArg("review.search_rule", args, "query");
    return readThroughLedger(
      context.ledger,
      "evidence",
      `review.search_rule "${query}"`,
      async () =>
        renderKnowledgeSearch({
          label: "Rule",
          corpusLabel: "rule",
          unit: "rule(s)",
          entries: context.rules,
          query,
          budgetChars: context.resultBudgetChars,
        }),
    );
  },
};

export const SEARCH_HISTORY_TOOL: ReviewToolDefinition = {
  name: "review.search_history",
  description:
    "Search historical review and defect records for this repository with a case-insensitive substring query. Returns matching history entries; entries are statically configured per run.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Case-insensitive substring to search for in history entry titles and texts.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  execute: async (args, context): Promise<string> => {
    const query = requireStringArg("review.search_history", args, "query");
    return readThroughLedger(
      context.ledger,
      "evidence",
      `review.search_history "${query}"`,
      async () =>
        renderKnowledgeSearch({
          label: "History",
          corpusLabel: "history",
          unit: "history record(s)",
          entries: context.history,
          query,
          budgetChars: context.resultBudgetChars,
        }),
    );
  },
};

/** find_references 的结果渲染（真实读取路径，与 T06 输出字节一致） */
function renderReferenceSites(
  sites: readonly ReferenceSite[],
  name: string,
  budgetChars: number,
): string {
  const filesWithMatches = new Set(sites.map((site) => site.file)).size;
  const header = `References to "${name}" (name-level whole-word match, no type resolution): ${sites.length} match(es) across ${filesWithMatches} file(s)`;
  if (sites.length === 0) {
    return header;
  }
  const lines = sites.flatMap((site) => [
    `  ${site.file}:${site.line} [${site.isDeclaration ? "declaration" : "usage"}] ${enclosingLabel(site.enclosing)}`,
    `      ${site.text.trim()}`,
  ]);
  const budget = applyLineBudget(
    [header, ...lines],
    budgetChars,
    (shown, total) =>
      `Tool result truncated: showing ${shown} of ${total} result lines (tool result budget ${budgetChars} chars exceeded).`,
  );
  return budget.lines.join("\n");
}

/** get_call_chain 的结果渲染（真实读取路径，与 T06 输出字节一致） */
async function renderCallChain(
  repo: RepoContext,
  name: string,
  budgetChars: number,
): Promise<string> {
  const refs = await findMethodRefs(repo, name);
  const header = `Call chain for "${name}" (name-level, up to 2 hops, no type resolution): ${refs.length} method declaration(s) matched`;
  if (refs.length === 0) {
    return `Call chain for "${name}" (name-level, up to 2 hops, no type resolution): no method or constructor named "${name}" found across ${repo.javaFiles.length} Java file(s)`;
  }
  const blocks = await buildCallChainBlocks(repo, refs).catch((error: unknown) => {
    throw new Error(`review.get_call_chain: ${errorMessage(error)}`, { cause: error });
  });
  const budget = applyLineBudget(
    [header, "", ...blocks.flatMap((block) => [...block, ""])],
    budgetChars,
    (shown, total) =>
      `Tool result truncated: showing ${shown} of ${total} result lines (tool result budget ${budgetChars} chars exceeded).`,
  );
  return budget.lines.join("\n").trimEnd();
}

/** findReferenceSites 的工具边界包装：错误带工具名前缀（有界失败，可归因到工具） */
async function searchReferenceSites(
  toolName: string,
  repo: RepoContext,
  name: string,
): Promise<readonly ReferenceSite[]> {
  return findReferenceSites(repo, name).catch((error: unknown) => {
    throw new Error(`${toolName}: ${errorMessage(error)}`, { cause: error });
  });
}

/** 全仓扫描名字命中的方法/构造器声明（文件顺序 → 限定名/文件/行号排序，确定性） */
async function findMethodRefs(repo: RepoContext, name: string): Promise<readonly ChangedSymbolRef[]> {
  const refs: ChangedSymbolRef[] = [];
  for (const file of repo.javaFiles) {
    const index = await repo.symbolIndex(file).catch((error: unknown) => {
      // 归一为仓库相对路径消息（不泄漏绝对路径，与 get_file 的错误纪律一致）
      throw new Error(
        `review.get_call_chain: symbol index unavailable for file "${file}" (not found or unreadable)`,
        { cause: error },
      );
    });
    for (const topType of index.symbols) {
      collectMethodRefs(file, topType, topType.name, name, refs);
    }
  }
  return refs.sort(
    (a, b) =>
      compare(qualifiedName(a), qualifiedName(b)) ||
      compare(a.file, b.file) ||
      a.symbol.line - b.symbol.line,
  );
}

/** 递归收集类型树内名字命中的方法/构造器（typeName 取顶层类型，与 Zone B 惯例一致） */
function collectMethodRefs(
  file: string,
  typeSymbol: JavaSymbol,
  rootTypeName: string,
  name: string,
  out: ChangedSymbolRef[],
): void {
  for (const member of typeSymbol.members) {
    if ((member.kind === "method" || member.kind === "constructor") && member.name === name) {
      out.push({ file, symbol: member, typeName: rootTypeName });
    }
    if (member.members.length > 0) {
      collectMethodRefs(file, member, rootTypeName, name, out);
    }
  }
}

/** C3 Knowledge 语料检索渲染（大小写不敏感子串；确定性；超预算行边界截断留痕） */
interface KnowledgeSearchInput {
  /** 输出标题里的检索名（"Rule" / "History"） */
  readonly label: string;
  /** 语料名（"rule" / "history"） */
  readonly corpusLabel: string;
  /** 计数单位（"rule(s)" / "history record(s)"） */
  readonly unit: string;
  readonly entries: readonly KnowledgeEntry[];
  readonly query: string;
  readonly budgetChars: number;
}

/** query 回显上限（自由文本输入，防止超长 query 侵占结果预算） */
const QUERY_ECHO_MAX_CHARS = 120;

function renderKnowledgeSearch(input: KnowledgeSearchInput): string {
  const header = `${input.label} search "${boundedEcho(input.query, QUERY_ECHO_MAX_CHARS)}" (case-insensitive substring):`;
  if (input.entries.length === 0) {
    return `${header} ${input.corpusLabel} corpus is empty (0 entries configured for this run)`;
  }
  const needle = input.query.toLowerCase();
  const matches = input.entries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(needle) ||
      entry.text.toLowerCase().includes(needle),
  );
  if (matches.length === 0) {
    return `${header} 0 of ${input.entries.length} ${input.unit} matched`;
  }
  const lines = [
    `${header} ${matches.length} of ${input.entries.length} ${input.unit} matched`,
    ...matches.flatMap(renderKnowledgeEntry),
  ];
  const budget = applyLineBudget(
    lines,
    input.budgetChars,
    (shown, total) =>
      `Tool result truncated: showing ${shown} of ${total} result lines (tool result budget ${input.budgetChars} chars exceeded).`,
  );
  return budget.lines.join("\n");
}

/** 单条语料条目渲染："[id] title" + 缩进正文行（多行正文逐行缩进） */
function renderKnowledgeEntry(entry: KnowledgeEntry): readonly string[] {
  return [
    `  [${entry.id}] ${entry.title}`,
    ...entry.text.split("\n").map((line) => `    ${line}`),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

import type { JavaSymbol } from "../zoneb/symbols.js";
import { formatSymbolSignature } from "../zoneb/symbols.js";
import { readThroughLedger } from "./ledger.js";
import { applyLineBudget } from "./result-budget.js";
import type { ReviewToolDefinition, ToolRunContext } from "./registry.js";
import { requireStringArg } from "./registry.js";

/**
 * review.get_symbol：签名级符号检索（tree-sitter-java 零构建，ADR-0003）。
 *
 * - 名字级精确匹配（大小写敏感，无类型解析）：扫描全部 Java 文件的符号索引，
 *   命中符号返回签名（种类/修饰符/返回类型/参数表/行号），不含函数体；
 * - 类型命中附带其成员签名（递归嵌套）；
 * - 确定性：文件顺序 = 排序后的文件清单，符号顺序 = AST 文档顺序；
 * - 解析失败文件命中时显式留痕（词法精度天花板为已知限制）；
 * - 超预算在行边界截断并留痕；
 * - T07 Context Ledger：登记为 symbol（标识 = 工具名 + 符号名），
 *   重复查询返回 "Already loaded: ctx#NNN" 引用。
 */

export const GET_SYMBOL_TOOL: ReviewToolDefinition = {
  name: "review.get_symbol",
  description:
    "Look up a symbol by its simple name across all Java sources and return signature-level declarations (kind, modifiers, return type, parameters, line number; no method bodies). Type matches include their members.",
  parameters: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Simple (unqualified) symbol name to look up, e.g. \"sumFirst\" or \"MathUtils\".",
      },
    },
    required: ["symbol"],
    additionalProperties: false,
  },
  execute: async (args, context): Promise<string> => {
    const name = requireStringArg("review.get_symbol", args, "symbol");
    return readThroughLedger(
      context.ledger,
      "symbol",
      `review.get_symbol "${name}"`,
      async () => renderSymbolLookup(name, context),
    );
  },
};

/** 真实读取路径：全仓符号索引扫描 + 签名渲染（含零命中显式留痕） */
async function renderSymbolLookup(name: string, context: ToolRunContext): Promise<string> {
  const repo = await context.repo();
  const lines: string[] = [];
  let matchCount = 0;
  let parseErrorFiles = 0;

  for (const file of repo.javaFiles) {
    const index = await repo.symbolIndex(file);
    const matches = collectMatches(index.symbols, name);
    if (matches.length === 0) {
      continue;
    }
    if (index.parseError) {
      parseErrorFiles++;
    }
    matchCount += matches.length;
    const packageName = index.packageName.length > 0 ? index.packageName : "(default package)";
    lines.push(`${file} (package ${packageName})`);
    for (const match of matches) {
      lines.push(...renderSymbolLines(match, 1));
    }
  }

  const header = [`Symbol "${name}": ${matchCount} match(es) across ${repo.javaFiles.length} Java file(s)`];
  if (parseErrorFiles > 0) {
    header.push(
      `Note: ${parseErrorFiles} file(s) with matching symbols contain parse errors; signatures may be incomplete.`,
    );
  }
  if (matchCount === 0) {
    return header.join("\n");
  }
  const budget = applyLineBudget(
    [...header, ...lines],
    context.resultBudgetChars,
    (shown, total) =>
      `Tool result truncated: showing ${shown} of ${total} result lines (tool result budget ${context.resultBudgetChars} chars exceeded).`,
  );
  return budget.lines.join("\n");
}

/** 递归收集名字命中的符号（文档顺序） */
function collectMatches(symbols: readonly JavaSymbol[], name: string): readonly JavaSymbol[] {
  const matches: JavaSymbol[] = [];
  for (const symbol of symbols) {
    if (symbol.name === name) {
      matches.push(symbol);
    }
    if (symbol.members.length > 0) {
      matches.push(...collectMatches(symbol.members, name));
    }
  }
  return matches;
}

/** 符号行渲染：命中符号及其成员（嵌套缩进），与 Zone B Symbol Index 同风格 */
function renderSymbolLines(symbol: JavaSymbol, depth: number): readonly string[] {
  const indent = "  ".repeat(depth);
  return [
    `${indent}L${symbol.line} ${formatSymbolSignature(symbol)}`,
    ...symbol.members.flatMap((member) => renderSymbolLines(member, depth + 1)),
  ];
}

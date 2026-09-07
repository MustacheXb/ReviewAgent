import type { Parser, Node } from "web-tree-sitter";

/**
 * 签名级符号索引（Zone B Symbol Index 生成器，ADR-0003：tree-sitter-java，零构建）。
 *
 * - 签名级：只提取种类 / 名称 / 修饰符 / 返回类型 / 参数表 / 行号，不含函数体；
 * - 确定性：遍历顺序 = AST 文档顺序（tree-sitter 确定），输入相同输出字节相同；
 * - 解析失败（ERROR 节点）：置 parseError 标记，由上层留痕，不静默丢弃。
 */

export type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "record"
  | "method"
  | "constructor"
  | "field"
  | "enum-constant";

export interface JavaSymbol {
  readonly kind: SymbolKind;
  readonly name: string;
  /** 声明起始行（1-based） */
  readonly line: number;
  /** 声明结束行（1-based，含）；仅用于圈定/求交，不渲染进 Zone B */
  readonly endLine: number;
  readonly modifiers: readonly string[];
  /** method / field 的类型 */
  readonly returnType?: string;
  /** method / constructor / record 的形参表（归一化空白后含括号） */
  readonly params?: string;
  /** 嵌套成员（类型含成员；method/field 无成员） */
  readonly members: readonly JavaSymbol[];
}

/** 文件内的一次调用（名字级：被调方法名或构造类型名 + 调用点行号） */
export interface FileInvocation {
  readonly name: string;
  readonly line: number;
}

export interface FileSymbolIndex {
  /** 仓库相对 POSIX 路径 */
  readonly file: string;
  /** 解析出的包名（缺省包为 ""） */
  readonly packageName: string;
  readonly parseError: boolean;
  /** 顶层类型（嵌套类型在 members 里递归） */
  readonly symbols: readonly JavaSymbol[];
  /** 全文件的名字级调用点（method_invocation + new 表达式，文档顺序） */
  readonly invocations: readonly FileInvocation[];
}

const TYPE_DECL_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
]);

const MODIFIER_KEYWORDS = new Set([
  "public",
  "protected",
  "private",
  "abstract",
  "static",
  "final",
  "transient",
  "volatile",
  "synchronized",
  "native",
  "strictfp",
  "default",
]);

/** 解析一个 Java 文件，产出签名级符号索引 */
export function extractFileSymbols(parser: Parser, file: string, source: string): FileSymbolIndex {
  const tree = parser.parse(source);
  if (tree === null) {
    // tree-sitter 仅在输入为 null/undefined 时返回 null；此处视为解析失败并留痕
    return { file, packageName: "", parseError: true, symbols: [], invocations: [] };
  }
  const root = tree.rootNode;
  const packageName = extractPackageName(root);
  const symbols: JavaSymbol[] = [];
  for (const child of root.namedChildren) {
    if (TYPE_DECL_TYPES.has(child.type)) {
      symbols.push(extractTypeSymbol(child));
    }
  }
  const invocations = extractInvocations(root);
  return {
    file,
    packageName,
    parseError: root.hasError,
    symbols,
    invocations,
  };
}

function extractPackageName(root: Node): string {
  const packageDecl = root.namedChildren.find((child) => child.type === "package_declaration");
  if (packageDecl === undefined) {
    return "";
  }
  const nameNode =
    packageDecl.childForFieldName("name") ??
    packageDecl.namedChildren.find((child) => child.type !== ";");
  return nameNode?.text ?? "";
}

function extractTypeSymbol(node: Node): JavaSymbol {
  const kind = typeKindOf(node.type);
  const name = node.childForFieldName("name")?.text ?? "(anonymous)";
  const params =
    node.type === "record_declaration"
      ? normalizeParams(node.childForFieldName("parameters")?.text)
      : undefined;
  const body = node.childForFieldName("body");
  const members = body !== null && body !== undefined ? extractMembers(body) : [];
  return {
    kind,
    name,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: extractModifiers(node),
    ...(params !== undefined ? { params } : {}),
    members,
  };
}

function extractMembers(body: Node): JavaSymbol[] {
  const members: JavaSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === "enum_body_declarations") {
      // enum 的方法/字段成员包在 enum_body_declarations 里，摊平处理
      members.push(...extractMembers(child));
      continue;
    }
    const member = extractMember(child);
    if (member !== undefined) {
      members.push(member);
    }
  }
  return members;
}

function extractMember(node: Node): JavaSymbol | undefined {
  if (TYPE_DECL_TYPES.has(node.type)) {
    return extractTypeSymbol(node);
  }
  if (node.type === "method_declaration" || node.type === "constructor_declaration") {
    return extractCallableSymbol(node);
  }
  if (node.type === "field_declaration") {
    return extractFirstFieldSymbol(node);
  }
  if (node.type === "enum_constant") {
    return {
      kind: "enum-constant",
      name: node.childForFieldName("name")?.text ?? "(unknown)",
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: [],
      members: [],
    };
  }
  return undefined;
}

function extractCallableSymbol(node: Node): JavaSymbol {
  const returnType =
    node.type === "method_declaration" ? node.childForFieldName("type")?.text : undefined;
  const params = normalizeParams(node.childForFieldName("parameters")?.text);
  return {
    kind: node.type === "constructor_declaration" ? "constructor" : "method",
    name: node.childForFieldName("name")?.text ?? "(anonymous)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: extractModifiers(node),
    ...(returnType !== undefined ? { returnType } : {}),
    ...(params !== undefined ? { params } : {}),
    members: [],
  };
}

function extractFirstFieldSymbol(node: Node): JavaSymbol | undefined {
  const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
  if (declarator === undefined) {
    return undefined;
  }
  const returnType = node.childForFieldName("type")?.text;
  return {
    kind: "field",
    name: declarator.childForFieldName("name")?.text ?? "(unknown)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: extractModifiers(node),
    ...(returnType !== undefined ? { returnType } : {}),
    members: [],
  };
}

function extractModifiers(node: Node): readonly string[] {
  const modifiersNode = node.namedChildren.find((child) => child.type === "modifiers");
  if (modifiersNode === undefined) {
    return [];
  }
  const keywords: string[] = [];
  for (let i = 0; i < modifiersNode.childCount; i++) {
    const child = modifiersNode.child(i);
    if (child !== null && MODIFIER_KEYWORDS.has(child.type)) {
      keywords.push(child.type);
    }
  }
  return keywords;
}

function extractInvocations(root: Node): readonly FileInvocation[] {
  const invocations: FileInvocation[] = [];
  for (const invocation of root.descendantsOfType("method_invocation")) {
    const name = invocation.childForFieldName("name")?.text;
    if (name !== undefined) {
      invocations.push({ name, line: invocation.startPosition.row + 1 });
    }
  }
  for (const creation of root.descendantsOfType("object_creation_expression")) {
    const type = creation.childForFieldName("type")?.text;
    if (type !== undefined) {
      invocations.push({ name: type, line: creation.startPosition.row + 1 });
    }
  }
  return invocations;
}

function typeKindOf(nodeType: string): SymbolKind {
  switch (nodeType) {
    case "interface_declaration":
      return "interface";
    case "enum_declaration":
      return "enum";
    case "record_declaration":
      return "record";
    default:
      return "class";
  }
}

function normalizeParams(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 签名渲染：`final class MathUtils` / `public static int sumFirst(int[] values, int count)`。
 * 只含签名要素，不含函数体。
 */
export function formatSymbolSignature(symbol: JavaSymbol): string {
  const mods = symbol.modifiers.length > 0 ? `${symbol.modifiers.join(" ")} ` : "";
  switch (symbol.kind) {
    case "class":
    case "interface":
    case "enum":
      return `${mods}${symbol.kind} ${symbol.name}`;
    case "record":
      return `${mods}record ${symbol.name}${symbol.params ?? ""}`;
    case "constructor":
      return `${mods}${symbol.name}${symbol.params ?? "()"}`;
    case "method":
      return `${mods}${symbol.returnType ?? "void"} ${symbol.name}${symbol.params ?? "()"}`;
    case "field":
      return `${mods}${symbol.returnType ?? "var"} ${symbol.name}`;
    case "enum-constant":
      return symbol.name;
  }
}

/** 行区间 [startLine, endLine]（含端点，1-based） */
export interface LineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

function intersects(symbol: JavaSymbol, span: LineSpan): boolean {
  return symbol.line <= span.endLine && span.startLine <= symbol.endLine;
}

/**
 * 把符号树剪枝为「与任一 span 相交」的子树：
 * 类型若自身或后代相交则保留；成员仅保留相交者。输出仍为文档顺序。
 */
export function pruneSymbolsToSpans(
  symbols: readonly JavaSymbol[],
  spans: readonly LineSpan[],
): readonly JavaSymbol[] {
  const pruned: JavaSymbol[] = [];
  for (const symbol of symbols) {
    const ownHit = spans.some((span) => intersects(symbol, span));
    const prunedMembers = symbol.members.length > 0 ? pruneSymbolsToSpans(symbol.members, spans) : [];
    if (ownHit || prunedMembers.length > 0) {
      pruned.push({ ...symbol, members: prunedMembers });
    }
  }
  return pruned;
}

/** 剪枝树的最深层符号（方法优先；类型无相交成员时为其自身） */
export function innermostSymbols(symbols: readonly JavaSymbol[]): readonly JavaSymbol[] {
  const result: JavaSymbol[] = [];
  for (const symbol of symbols) {
    if (symbol.members.length > 0) {
      result.push(...innermostSymbols(symbol.members));
    } else {
      result.push(symbol);
    }
  }
  return result;
}

/** 包含指定行的符号链（根类型 → … → 最内层符号；空数组 = 不在任何符号内） */
export function symbolPathAt(
  symbols: readonly JavaSymbol[],
  line: number,
): readonly JavaSymbol[] {
  for (const symbol of symbols) {
    if (symbol.line <= line && line <= symbol.endLine) {
      return [symbol, ...symbolPathAt(symbol.members, line)];
    }
  }
  return [];
}

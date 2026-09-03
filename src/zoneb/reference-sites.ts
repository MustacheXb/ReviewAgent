import type { RgMatch } from "../codeintel/rg.js";
import { rgSearchWord } from "../codeintel/rg.js";
import type { RepoContext } from "./repo-context.js";
import type { JavaSymbol } from "./symbols.js";
import { symbolPathAt } from "./symbols.js";

/**
 * Reference 层与 Call Chain 层共用的引用点解析（ADR-0003：ripgrep 词法匹配）。
 *
 * 名字级全词匹配（大小写敏感、固定字符串），对每个匹配点解析其包内符号链，
 * 得到「谁在引用」的词法视图。精度天花板（重载 / override 不分辨）为已知限制。
 *
 * 确定性降噪：整行为注释（行首 //、/*、* ）的匹配被过滤——注释提及不是代码引用，
 * 且该词法规则跨平台确定（行内尾随注释不影响，因行本身含真实代码）。
 */

const COMMENT_LINE_PATTERN = /^\s*(\/\/|\/\*|\*)/;

export interface ReferenceSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** 引用点所在的符号链（根类型 → … → 最内层；空 = 顶层位置） */
  readonly enclosing: readonly JavaSymbol[];
  /** 引用点行 == 包含符号的声明行（即声明处本身，非调用处） */
  readonly isDeclaration: boolean;
}

/** 该符号链的展示名：Type.method / Type / (top-level) */
export function enclosingLabel(path: readonly JavaSymbol[]): string {
  if (path.length === 0) {
    return "(top-level)";
  }
  return path.map((symbol) => symbol.name).join(".");
}

export async function findReferenceSites(repo: RepoContext, name: string): Promise<readonly ReferenceSite[]> {
  const matches: readonly RgMatch[] = await rgSearchWord(repo.repoPath, name).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`reference search failed for symbol "${name}": ${message}`, { cause: error });
    },
  );
  const sites: ReferenceSite[] = [];
  for (const match of matches) {
    if (COMMENT_LINE_PATTERN.test(match.text)) {
      continue;
    }
    const index = await repo.symbolIndex(match.file);
    const path = index.parseError ? [] : symbolPathAt(index.symbols, match.line);
    const innermost = path.at(-1);
    sites.push({
      file: match.file,
      line: match.line,
      text: match.text,
      enclosing: path,
      isDeclaration: innermost !== undefined && innermost.line === match.line,
    });
  }
  return sites;
}

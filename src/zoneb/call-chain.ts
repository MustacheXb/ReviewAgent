import type { RepoContext } from "./repo-context.js";
import type { ChangedSymbolRef } from "./changed-symbols.js";
import { qualifiedName } from "./changed-symbols.js";
import type { ReferenceSite } from "./reference-sites.js";
import { enclosingLabel, findReferenceSites } from "./reference-sites.js";

/**
 * Call Chain 层（config B 固定管线第四层；get_call_chain 的 POC1 形态）。
 *
 * 降级为名字级引用链（ADR-0003）：
 * - hop 1：变更方法的引用点（非声明处）→ 引用者的符号限定名；
 * - hop 2：对 hop 1 引用者的方法名再做一次名字级检索；
 * - Callee hop 1：变更方法体内（base 版本）的名字级调用点。
 */

export async function buildCallChainBlocks(
  repo: RepoContext,
  methodRefs: readonly ChangedSymbolRef[],
): Promise<readonly (readonly string[])[]> {
  const sitesByName = new Map<string, readonly ReferenceSite[]>();
  const blocks: (readonly string[])[] = [];
  for (const ref of methodRefs) {
    blocks.push(await buildChainForMethod(repo, ref, (name) => loadSites(repo, sitesByName, name)));
  }
  return blocks;
}

async function loadSites(
  repo: RepoContext,
  cache: Map<string, readonly ReferenceSite[]>,
  name: string,
): Promise<readonly ReferenceSite[]> {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const sites = await findReferenceSites(repo, name);
  cache.set(name, sites);
  return sites;
}

async function buildChainForMethod(
  repo: RepoContext,
  ref: ChangedSymbolRef,
  sitesOf: (name: string) => Promise<readonly ReferenceSite[]>,
): Promise<readonly string[]> {
  const header = `${qualifiedName(ref)} - ${ref.symbol.kind} at ${ref.file}:${ref.symbol.line}`;
  const sites = await sitesOf(ref.symbol.name);
  const callSites = sites.filter((site) => !site.isDeclaration);

  const hop1 = [
    "  Callers (hop 1):",
    ...renderEntries(callSites.map((site) => siteEntry(site))),
  ];

  const callerMethodNames = [...new Set(callSites.flatMap((site) => callerMethodNameOf(site)))]
    .filter((name) => name.length > 0)
    .sort();

  const hop2: string[] = [];
  for (const callerName of callerMethodNames) {
    const hop2Sites = (await sitesOf(callerName)).filter((site) => !site.isDeclaration);
    hop2.push(`  Callers of "${callerName}" (hop 2):`);
    hop2.push(...renderEntries(hop2Sites.map((site) => siteEntry(site))));
  }
  if (hop2.length === 0) {
    hop2.push("  Callers (hop 2):", "    (no method-level callers identified at hop 1)");
  }

  const callees = await calleesOf(repo, ref);
  const calleeLines = ["  Callees (hop 1):", ...renderEntries(callees)];

  return [header, ...hop1, ...hop2, ...calleeLines];
}

/** 引用点 → 展示条目：限定名 - 文件:行 */
function siteEntry(site: ReferenceSite): string {
  return `${enclosingLabel(site.enclosing)} - ${site.file}:${site.line}`;
}

/** 引用点最内层符号为方法/构造器时的方法名（hop 2 的检索对象） */
function callerMethodNameOf(site: ReferenceSite): readonly string[] {
  const innermost = site.enclosing.at(-1);
  if (innermost === undefined) {
    return [];
  }
  return innermost.kind === "method" || innermost.kind === "constructor" ? [innermost.name] : [];
}

async function calleesOf(repo: RepoContext, ref: ChangedSymbolRef): Promise<readonly string[]> {
  const index = await repo.symbolIndex(ref.file);
  const inRange = index.invocations.filter(
    (invocation) => invocation.line >= ref.symbol.line && invocation.line <= ref.symbol.endLine,
  );
  const entries = [
    ...new Set(inRange.map((invocation) => `${invocation.name} - ${ref.file}:${invocation.line}`)),
  ];
  return entries.sort(compare);
}

function renderEntries(entries: readonly string[]): readonly string[] {
  const unique = [...new Set(entries)].sort(compare);
  return unique.length > 0 ? unique.map((entry) => `    ${entry}`) : ["    (none)"];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

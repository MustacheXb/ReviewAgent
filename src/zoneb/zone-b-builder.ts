import type { PrefetchLayerRecord } from "../contracts/prefetch.js";
import { applyBlockBudget } from "./budget.js";
import type { RepoContext } from "./repo-context.js";
import { derivePackageFromPath, loadRepoContext } from "./repo-context.js";
import type { FileSymbolIndex, JavaSymbol } from "./symbols.js";
import { formatSymbolSignature } from "./symbols.js";

/**
 * Zone B 静态构造器（spec #1 工单 #4；主文档第 5 章 Zone B）。
 *
 * 内容：Repo Identity + Repo Map（目录树 + 包结构）+ Symbol Index（签名级，
 * 按变更文件所在包圈定范围）+ Project Rules（POC1 固定说明）。
 *
 * 确定性保证：
 * - 文件清单 / 包名 / 符号均来自排序后的确定性遍历（RepoContext 纪律）；
 * - 渲染只含仓库相对 POSIX 路径与源码事实，无时间戳 / 绝对路径 / 环境信息；
 * - 同一仓库状态 + 同一变更文件集合 → 字节级相同输出（有测试锁定）。
 *
 * 不经过 LLM、不依赖构建环境（tree-sitter-java 词法解析，ADR-0003）。
 */

export interface ZoneBInput {
  readonly repoPath: string;
  /** 变更文件（仓库相对 POSIX 路径）；Symbol Index 按其所在包/模块圈定范围 */
  readonly changedFiles: readonly string[];
  readonly budgetChars: number;
}

export interface ZoneBResult {
  /** 渲染后的 Zone B 消息内容（字节稳定） */
  readonly content: string;
  readonly record: PrefetchLayerRecord;
}

const MAP_SHARE = 0.4;
const PACKAGE_SHARE = 0.2;

export async function buildZoneB(input: ZoneBInput, context?: RepoContext): Promise<ZoneBResult> {
  const repo = context ?? (await loadRepoContext(input.repoPath));
  const scopePackages = resolveScopePackages(repo, input.changedFiles);
  const scopedFiles = repo.javaFiles.filter((file) =>
    scopePackages.has(repo.packageNameByFile.get(file) ?? ""),
  );

  const identity = renderIdentity(repo);
  const mapSection = renderRepoMapSection(repo, Math.floor(input.budgetChars * MAP_SHARE));
  const packageSection = renderPackageSection(repo, Math.floor(input.budgetChars * PACKAGE_SHARE));
  const symbolSection = await renderSymbolIndexSection(repo, scopePackages, scopedFiles, Math.floor(input.budgetChars * (1 - MAP_SHARE - PACKAGE_SHARE)));
  const rules = renderProjectRules();

  const content = [
    ZONE_B_HEADER,
    identity,
    mapSection.content,
    packageSection.content,
    symbolSection.content,
    rules,
  ].join("\n\n");

  const record: PrefetchLayerRecord = {
    layer: "zone-b",
    budgetChars: input.budgetChars,
    contentChars: content.length,
    truncated: mapSection.truncated || packageSection.truncated || symbolSection.truncated,
    totalEntries: mapSection.total + packageSection.total + symbolSection.total,
    shownEntries: mapSection.shown + packageSection.shown + symbolSection.shown,
  };
  return { content, record };
}

const ZONE_B_HEADER = [
  "Repository context (Zone B). Statically and deterministically constructed from the repository",
  "snapshot (zero-build, no LLM). Identical repository state and scope produce byte-identical output.",
].join("\n");

function resolveScopePackages(repo: RepoContext, changedFiles: readonly string[]): ReadonlySet<string> {
  const packages = new Set<string>();
  for (const file of changedFiles) {
    if (repo.hasFile(file)) {
      packages.add(repo.packageNameByFile.get(file) ?? "");
    } else {
      packages.add(derivePackageFromPath(file));
    }
  }
  return packages;
}

function renderIdentity(repo: RepoContext): string {
  return [
    "## Repo identity",
    `Repo name: ${repo.repoName}`,
    `Java files: ${repo.javaFiles.length}`,
    `Build file: ${detectBuildFile(repo)}`,
  ].join("\n");
}

function detectBuildFile(repo: RepoContext): string {
  if (repo.rootFileNames.includes("pom.xml")) {
    return "maven (pom.xml)";
  }
  const gradle = repo.rootFileNames.find((name) => name === "build.gradle" || name === "build.gradle.kts");
  return gradle !== undefined ? `gradle (${gradle})` : "none detected";
}

interface SectionResult {
  readonly content: string;
  readonly total: number;
  readonly shown: number;
  readonly truncated: boolean;
}

function renderRepoMapSection(repo: RepoContext, budgetChars: number): SectionResult {
  const dirs = new Map<string, string[]>();
  for (const file of repo.javaFiles) {
    const separator = file.lastIndexOf("/");
    const dir = separator >= 0 ? file.slice(0, separator + 1) : "";
    const name = separator >= 0 ? file.slice(separator + 1) : file;
    const entries = dirs.get(dir) ?? [];
    entries.push(name);
    dirs.set(dir, entries);
  }
  const blocks = [...dirs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, names]) => [
      dir.length > 0 ? dir : "(repository root)",
      ...[...names].sort().map((name) => `  ${name}`),
    ]);
  return applySection(
    "## Repo map (directory tree of Java sources)",
    blocks,
    budgetChars,
    (shown, total) =>
      `Repo map truncated: showing ${shown} of ${total} directory entries (zone B repo-map budget ${budgetChars} chars exceeded).`,
  );
}

function renderPackageSection(repo: RepoContext, budgetChars: number): SectionResult {
  const packages = new Map<string, string[]>();
  for (const file of repo.javaFiles) {
    const packageName = repo.packageNameByFile.get(file) ?? "";
    const entry = packages.get(packageName) ?? [];
    entry.push(file);
    packages.set(packageName, entry);
  }
  const blocks = [...packages.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([packageName, files]) => [
      `${packageName.length > 0 ? packageName : "(default package)"} (${files.length} file(s))`,
      ...files.map((file) => `  ${file}`),
    ]);
  return applySection(
    "## Package structure",
    blocks,
    budgetChars,
    (shown, total) =>
      `Package structure truncated: showing ${shown} of ${total} package entries (zone B package-structure budget ${budgetChars} chars exceeded).`,
  );
}

async function renderSymbolIndexSection(
  repo: RepoContext,
  scopePackages: ReadonlySet<string>,
  scopedFiles: readonly string[],
  budgetChars: number,
): Promise<SectionResult> {
  const scopeLine =
    scopePackages.size > 0
      ? `Scope: packages of changed files (${[...scopePackages].sort().join(", ")})`
      : "Scope: (no changed files provided)";
  const indexes = await Promise.all(scopedFiles.map((file) => repo.symbolIndex(file)));
  const failures = indexes.filter((index) => index.parseError);
  const headerLines = [
    "## Symbol index (signature level, no method bodies)",
    scopeLine,
    `Parse failures: ${failures.length === 0 ? "none" : `${failures.length} file(s) (marked below; signatures unavailable)`}`,
  ];
  if (scopedFiles.length === 0) {
    return {
      content: [...headerLines, "No Java files found in scope."].join("\n"),
      total: 0,
      shown: 0,
      truncated: false,
    };
  }
  const blocks = indexes.map((index) => renderSymbolFileBlock(index));
  return applySection(
    headerLines.join("\n"),
    blocks,
    budgetChars,
    (shown, total) =>
      `Symbol index truncated: showing ${shown} of ${total} file entries (zone B symbol-index budget ${budgetChars} chars exceeded).`,
  );
}

function renderSymbolFileBlock(index: FileSymbolIndex): readonly string[] {
  const packageName = index.packageName.length > 0 ? index.packageName : "(default package)";
  const failureMark = index.parseError ? " [parse failed; signatures unavailable]" : "";
  const lines = [`${index.file} (package ${packageName})${failureMark}`];
  if (!index.parseError) {
    for (const symbol of index.symbols) {
      lines.push(...renderSymbolLines(symbol, 1));
    }
  }
  return lines;
}

function renderSymbolLines(symbol: JavaSymbol, depth: number): readonly string[] {
  const indent = "  ".repeat(depth);
  return [
    `${indent}L${symbol.line} ${formatSymbolSignature(symbol)}`,
    ...symbol.members.flatMap((member) => renderSymbolLines(member, depth + 1)),
  ];
}

function renderProjectRules(): string {
  return [
    "## Project rules",
    "No project-specific rules are configured in POC1 (zero-build static construction;",
    "project rule sources are out of scope for this phase).",
  ].join("\n");
}

function applySection(
  header: string,
  blocks: readonly (readonly string[])[],
  budgetChars: number,
  buildNotice: (shown: number, total: number) => string,
): SectionResult {
  const budget = applyBlockBudget(blocks, budgetChars, buildNotice);
  return {
    content: budget.lines.length > 0 ? `${header}\n\n${budget.lines.join("\n")}` : header,
    total: budget.totalBlocks,
    shown: budget.shownBlocks,
    truncated: budget.truncated,
  };
}

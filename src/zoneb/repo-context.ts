import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { getJavaParser } from "../codeintel/java-parser.js";
import { readUtf8Tolerant, repoRootName, toPosixPath } from "../codeintel/fs-utils.js";
import { rgListFiles } from "../codeintel/rg.js";
import type { FileSymbolIndex } from "./symbols.js";
import { extractFileSymbols } from "./symbols.js";

/**
 * 仓库快照上下文：Zone B 构造与 config B 预取管线共用的确定性读取层。
 *
 * - 文件清单来自 ripgrep（排序去重，仓库相对 POSIX 路径）；
 * - 包名用文件头部的词法提取（package 声明必须位于类型声明之前，读头部 8KB 足够；
 *   超长 license 头导致提取不到时归入默认包——确定性兜底，已在代码注释留痕）；
 * - 源码读取与符号解析按需 memoize（同一文件只读/解析一次）。
 */

const PACKAGE_HEAD_BYTES = 8192;
const PACKAGE_PATTERN = /^[ \t]*package[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*;/m;

export interface RepoContext {
  /** 绝对仓库根 */
  readonly repoPath: string;
  readonly repoName: string;
  /** 全部 Java 文件（排序、仓库相对 POSIX 路径） */
  readonly javaFiles: readonly string[];
  /** 词法包名（默认包为 ""） */
  readonly packageNameByFile: ReadonlyMap<string, string>;
  /** 仓库根下的普通文件名（构建文件探测用） */
  readonly rootFileNames: readonly string[];
  hasFile(file: string): boolean;
  readSource(file: string): Promise<string>;
  symbolIndex(file: string): Promise<FileSymbolIndex>;
}

export async function loadRepoContext(repoPath: string): Promise<RepoContext> {
  const resolvedRoot = path.resolve(repoPath);
  const javaFiles = await rgListFiles(resolvedRoot, "*.java").catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to list Java files under repository path "${resolvedRoot}" (is it an existing directory?): ${message}`,
      { cause: error },
    );
  });
  const packageNameByFile = new Map<string, string>();
  for (const file of javaFiles) {
    packageNameByFile.set(file, await extractPackageLexically(resolvedRoot, file));
  }
  const rootFileNames = await listRootFileNames(resolvedRoot);
  const sourceCache = new Map<string, string>();
  const indexCache = new Map<string, FileSymbolIndex>();
  const parser = await getJavaParser();
  return {
    repoPath: resolvedRoot,
    repoName: repoRootName(resolvedRoot),
    javaFiles,
    packageNameByFile,
    rootFileNames,
    hasFile: (file: string) => javaFiles.includes(file),
    readSource: async (file: string) => {
      const cached = sourceCache.get(file);
      if (cached !== undefined) {
        return cached;
      }
      const source = await readUtf8Tolerant(absoluteFile(resolvedRoot, file));
      sourceCache.set(file, source);
      return source;
    },
    symbolIndex: async (file: string) => {
      const cached = indexCache.get(file);
      if (cached !== undefined) {
        return cached;
      }
      const source = await readUtf8Tolerant(absoluteFile(resolvedRoot, file));
      const index = extractFileSymbols(parser, file, source);
      indexCache.set(file, index);
      return index;
    },
  };
}

/** 文件头部词法包名（无 package 声明 → 默认包 ""） */
async function extractPackageLexically(repoPath: string, file: string): Promise<string> {
  const absPath = absoluteFile(repoPath, file);
  let handle: FileHandle;
  try {
    handle = await open(absPath, "r");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read file "${absPath}": ${message}`, { cause: error });
  }
  try {
    const buffer = Buffer.alloc(PACKAGE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PACKAGE_HEAD_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    return PACKAGE_PATTERN.exec(head)?.[1] ?? "";
  } finally {
    await handle.close();
  }
}

/** 变更文件不在快照中时的路径推导包名（src/main/java 前缀剥离，否则取目录部分） */
export function derivePackageFromPath(posixFile: string): string {
  const knownRoots = ["src/main/java", "src/test/java"];
  for (const root of knownRoots) {
    if (posixFile.startsWith(`${root}/`)) {
      return packageFromDirs(posixFile.slice(root.length + 1).split("/").slice(0, -1));
    }
  }
  const segments = toPosixPath(posixFile).split("/");
  const javaIndex = segments.lastIndexOf("java");
  const dirs = javaIndex >= 0 ? segments.slice(javaIndex + 1, -1) : segments.slice(0, -1);
  return packageFromDirs(dirs);
}

function packageFromDirs(dirs: readonly string[]): string {
  return dirs.filter((segment) => segment.length > 0).join(".");
}

function absoluteFile(repoPath: string, file: string): string {
  return path.join(repoPath, ...file.split("/"));
}

async function listRootFileNames(repoPath: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(repoPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read repository root "${repoPath}": ${message}`, { cause: error });
  }
}

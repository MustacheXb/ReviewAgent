import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { toRepoRelativePath } from "./fs-utils.js";

/**
 * ripgrep 封装（ADR-0003：词法引用匹配后端；选型见研究笔记 ripgrep-from-node.md）。
 *
 * - @vscode/ripgrep@1.18.0：平台二进制随 npm tarball 分发（optional deps），零构建脚本；
 * - 检索结果统一按 (file, line) 排序后返回，消除 rg 并行输出的顺序不确定性；
 * - 路径归一化为仓库相对 POSIX 路径；
 * - 退出码语义：0 = 有匹配，1 = 无匹配（不是错误），2 = 错误；
 * - 不使用 rg 的 --max-count 等静默截断开关——截断一律由上层预算层显式留痕。
 *
 * 本模块同时是 T06（review.find_references / get_call_chain）的检索底座；
 * search_rule / search_history 检索的是内存静态语料，不走本模块。
 */

export interface RgMatch {
  /** 仓库相对 POSIX 路径 */
  readonly file: string;
  /** 1-based 行号 */
  readonly line: number;
  /** 整行文本（保留缩进，去除行尾空白） */
  readonly text: string;
}

export interface RgSearchOptions {
  /** 文件 glob，默认 "*.java"（POC1 锁定 Java 单语言） */
  readonly glob?: string;
  /** 单次调用超时（毫秒），默认 30000；超时杀进程并抛错（不静默挂起） */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** 列出 root 下匹配 glob 的全部文件（排序去重后的仓库相对 POSIX 路径） */
export function rgListFiles(root: string, glob: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<readonly string[]> {
  const args = [
    "--files",
    "--no-config",
    "--no-ignore",
    "--no-messages",
    "-g",
    glob,
    "--",
    root,
  ];
  return runRg(args, timeoutMs).then((stdout) => {
    const files = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => toRepoRelativePath(root, line))
      .filter((file) => file.length > 0);
    return [...new Set(files)].sort(comparePaths);
  });
}

/**
 * 大小写敏感的全词匹配检索（find_references 语义：名字级精确匹配）。
 * 固定字符串 + 全词边界，不做正则解释。
 */
export function rgSearchWord(
  root: string,
  word: string,
  options: RgSearchOptions = {},
): Promise<readonly RgMatch[]> {
  const glob = options.glob ?? "*.java";
  const args = [
    "--json",
    "--no-config",
    "--no-ignore",
    "--no-messages",
    "--case-sensitive",
    "--fixed-strings",
    "--word-regexp",
    "-g",
    glob,
    "--",
    word,
    root,
  ];
  return runRg(args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS).then((stdout) => {
    const matches: RgMatch[] = [];
    for (const line of stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const parsed = parseMatchEvent(line);
      if (parsed !== undefined) {
        matches.push(parsed);
      }
    }
    const normalized = matches.map((match) => ({
      ...match,
      file: toRepoRelativePath(root, match.file),
    }));
    normalized.sort((a, b) => comparePaths(a.file, b.file) || a.line - b.line || compareText(a.text, b.text));
    return normalized;
  });
}

interface RgMatchEvent {
  readonly type: "match";
  readonly data: {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text: string };
  };
}

function parseMatchEvent(line: string): RgMatch | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as Partial<RgMatchEvent>;
  if (candidate.type !== "match" || typeof candidate.data !== "object" || candidate.data === null) {
    return undefined;
  }
  const pathText = candidate.data.path?.text;
  const lineNumber = candidate.data.line_number;
  const lineText = candidate.data.lines?.text;
  if (typeof pathText !== "string" || typeof lineNumber !== "number" || typeof lineText !== "string") {
    return undefined;
  }
  return {
    file: pathText,
    line: lineNumber,
    text: lineText.replace(/\r?\n$/, "").trimEnd(),
  };
}

function runRg(args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(rgPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`ripgrep timed out after ${timeoutMs}ms (pattern: ${describePattern(args)})`));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        // 不回显 rgPath（宿主机内部绝对路径；错误字节需跨环境可复现）
        reject(new Error(`failed to spawn ripgrep binary: ${error.message}`, { cause: error }));
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // 0 = 有匹配；1 = 无匹配；2 = 错误
      if (code === 2) {
        reject(new Error(`ripgrep failed (exit code 2): ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function describePattern(args: readonly string[]): string {
  const index = args.indexOf("--");
  return index >= 0 && index + 1 < args.length ? args[index + 1] ?? "(none)" : "(none)";
}

function comparePaths(a: string, b: string): number {
  return compareText(a, b);
}

function compareText(a: string, b: string): number {
  // JS 字符串比较按 UTF-16 码元，跨平台确定
  return a < b ? -1 : a > b ? 1 : 0;
}

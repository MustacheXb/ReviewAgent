/**
 * .env.local 装载：Benchmark 试跑的 API key / 接入点本机注入面（零依赖 dotenv 子集）。
 *
 * 语义：
 * - KEY=VALUE 行；首个 = 分割，值中的 = 保留；
 * - 空行与 # 注释行跳过（行内 # 是值的一部分，不解析）；
 * - 成对单/双引号剥离；BOM 剥离；CRLF 行尾安全；
 * - 目标 env 已有非空值优先不覆盖（显式环境变量 > 文件；空值视为未设置）；
 * - 空值行不注入（skippedKeys 留痕——空值 = 显式未设置）；
 * - 坏行留痕不中断（malformedLines 只报行号：原文可能恰是裸贴的 key，绝不回显）。
 *
 * 纪律：.env.local 已被 .gitignore；装载结果只含键名与行号，值绝不进日志/错误信息。
 */

import { readFileSync } from "node:fs";

export interface EnvLocalLoadResult {
  readonly filePath: string;
  /** 文件是否存在（缺失 = no-op，不报错——.env.local 是可选注入面） */
  readonly exists: boolean;
  /** 成功注入目标 env 的键名（按文件顺序） */
  readonly loadedKeys: readonly string[];
  /** 未注入的键名：文件值为空，或目标 env 已有非空值 */
  readonly skippedKeys: readonly string[];
  /** 无法解析的行（"line N" 定位，1 起；不含原文） */
  readonly malformedLines: readonly string[];
}

/** 合法行形态：KEY=VALUE（key 为 [A-Za-z_][A-Za-z0-9_]*；"KEY = value" 视为坏行） */
const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * 装载 .env.local 到目标 env（缺省 process.env）。
 * 注入是对目标对象的就地写入（env 语义使然）；其余调用方拿到不可变的结果对象。
 */
export function loadEnvLocalFile(
  filePath: string,
  target: Record<string, string | undefined> = process.env,
): EnvLocalLoadResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { filePath, exists: false, loadedKeys: [], skippedKeys: [], malformedLines: [] };
    }
    throw new Error(`failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const loadedKeys: string[] = [];
  const skippedKeys: string[] = [];
  const malformedLines: string[] = [];
  // BOM 剥离（Windows 编辑器常给）；split(/\r?\n/) 同时吃掉 CRLF
  const lines = content.replace(/^﻿/, "").split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = ENV_LINE_RE.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      malformedLines.push(`line ${index + 1}`);
      continue;
    }
    const key = match[1];
    const value = stripPairedQuotes(match[2].trim());
    if (value === "") {
      skippedKeys.push(key);
      continue;
    }
    const existing = target[key];
    if (typeof existing === "string" && existing.trim().length > 0) {
      skippedKeys.push(key);
      continue;
    }
    target[key] = value;
    loadedKeys.push(key);
  }
  return { filePath, exists: true, loadedKeys, skippedKeys, malformedLines };
}

/** 成对引号剥离（"value" / 'value' → value；不成对原样保留） */
function stripPairedQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

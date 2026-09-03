import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

/**
 * tree-sitter-java 解析封装（ADR-0003：零构建静态解析，wasm 路线）。
 *
 * 选型（研究笔记 tree-sitter-in-typescript.md，本机实测）：
 * - web-tree-sitter@0.27.0（wasm，免编译、免构建脚本，pnpm 10 友好）
 * - tree-sitter-java@0.23.5 官方包自带 tree-sitter-java.wasm
 *
 * 本模块同时是 T05（review.get_symbol 等工具）的解析底座：
 * 换原生绑定时仅需替换 initJavaParser 内部实现（接口不变）。
 */

let parserPromise: Promise<Parser> | undefined;

/** 初始化 Java parser（进程级 memoization；wasm 只加载一次） */
export function getJavaParser(): Promise<Parser> {
  parserPromise ??= initJavaParser();
  return parserPromise;
}

async function initJavaParser(): Promise<Parser> {
  try {
    await Parser.init();
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("tree-sitter-java/tree-sitter-java.wasm");
    const wasmBytes = new Uint8Array(await readFile(wasmPath));
    const javaLanguage = await Language.load(wasmBytes);
    const parser = new Parser();
    parser.setLanguage(javaLanguage);
    return parser;
  } catch (error) {
    throw new Error(`failed to initialize the Java tree-sitter parser: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

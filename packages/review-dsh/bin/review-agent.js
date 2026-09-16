#!/usr/bin/env node
/**
 * #26 review-agent 产品面 bin：USAGE_TEXT 宣告的命令在此成真。
 *
 * 只做三件事（零行为逻辑）：编译产物判鲜（#45 起从存在性升级为 mtime
 * 判鲜——任一源树最新 mtime 晚于产物即重编）+ argv 透传运行 CLI 主缝
 * （main.js）+ 子进程退出码透传。
 *
 * 两级产物各判鲜各重编：
 * - 本包 CLI 镜像 .tmp-gen（旗标经 tsconfig.cli.json 单一来源，产物落包内
 *   .tmp-gen，node_modules 解析走包目录）；
 * - review-llm dist（运行时经 node_modules default 条件消费——#45 起
 *   wire 序列化器 import 该包的画像表，陈旧 dist 会让 CLI 在导入期秒死，
 *   见 tests/bin/bin-stale-artifacts.test.ts 的事故回归钉）。
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isCompileStale } from "./lib/compile-freshness.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageDir, "..", "..");
// tsc 项目模式：依赖图公共根 = repo 根 → 产物镜像 repo 根相对结构
const compiledEntry = join(packageDir, ".tmp-gen", "packages", "review-dsh", "src", "cli", "main.js");
const reviewLlmDistEntry = join(repoRoot, "packages", "review-llm", "dist", "index.js");
const reviewLlmSrcRoot = join(repoRoot, "packages", "review-llm", "src");

const mirrorStale = isCompileStale(compiledEntry, [join(packageDir, "src"), join(repoRoot, "src")]);
const llmDistStale = isCompileStale(reviewLlmDistEntry, [reviewLlmSrcRoot]);

if (mirrorStale || llmDistStale) {
  const tscPath = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
  const compileProject = (tsconfigPath, label) => {
    const compile = spawnSync(process.execPath, [tscPath, "-p", tsconfigPath], {
      stdio: "inherit",
    });
    if (compile.error !== undefined || compile.status !== 0) {
      process.stderr.write(`review-agent: ${label} compile failed\n`);
      process.exit(compile.status ?? 1);
    }
  };
  if (mirrorStale) {
    compileProject(join(packageDir, "tsconfig.cli.json"), "CLI");
  }
  if (llmDistStale) {
    compileProject(join(reviewLlmSrcRoot, "..", "tsconfig.build.json"), "review-llm dist");
  }
}

const run = spawnSync(process.execPath, [compiledEntry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);

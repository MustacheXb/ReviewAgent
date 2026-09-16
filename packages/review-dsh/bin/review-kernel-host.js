#!/usr/bin/env node
/**
 * #27 review-kernel-host 产品面 bin：实验 runner 长驱的内核宿主进程。
 *
 * 与 review-agent bin 同款（零行为逻辑）：编译产物判鲜（#45 起从存在性
 * 升级为 mtime 判鲜——任一源树最新 mtime 晚于产物即重编）+ argv 透传 +
 * 退出码透传。stdin/stdout = SDK JSON-RPC wire。
 *
 * 两级产物各判鲜各重编：
 * - 本包 host 镜像 .tmp-gen-host（旗标经 tsconfig.kernel-host.json 单源；
 *   编译图公共根 = repo 根，含 root src）；
 * - review-llm dist（运行时经 node_modules default 条件消费——#45 起
 *   host 依赖图 import 该包，陈旧 dist 会让 host 在导入期秒死，
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
const compiledEntry = join(packageDir, ".tmp-gen-host", "packages", "review-dsh", "src", "kernel-host", "main.js");
const reviewLlmDistEntry = join(repoRoot, "packages", "review-llm", "dist", "index.js");
const reviewLlmSrcRoot = join(repoRoot, "packages", "review-llm", "src");

const mirrorStale = isCompileStale(compiledEntry, [join(packageDir, "src"), join(repoRoot, "src")]);
const llmDistStale = isCompileStale(reviewLlmDistEntry, [reviewLlmSrcRoot]);

if (mirrorStale || llmDistStale) {
  const tscPath = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
  // 编译输出只进 stderr：stdout 承载 JSON-RPC 帧（协议纯净性），tsc 诊断不得混入
  const compileProject = (tsconfigPath, label) => {
    const compile = spawnSync(process.execPath, [tscPath, "-p", tsconfigPath], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (compile.stdout !== null && compile.stdout.length > 0) {
      process.stderr.write(compile.stdout);
    }
    if (compile.stderr !== null && compile.stderr.length > 0) {
      process.stderr.write(compile.stderr);
    }
    if (compile.error !== undefined || compile.status !== 0) {
      process.stderr.write(`review-kernel-host: ${label} compile failed\n`);
      process.exit(compile.status ?? 1);
    }
  };
  if (mirrorStale) {
    compileProject(join(packageDir, "tsconfig.kernel-host.json"), "kernel host");
  }
  if (llmDistStale) {
    compileProject(join(reviewLlmSrcRoot, "..", "tsconfig.build.json"), "review-llm dist");
  }
}

const run = spawnSync(process.execPath, [compiledEntry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);

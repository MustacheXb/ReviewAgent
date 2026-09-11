#!/usr/bin/env node
/**
 * #26 review-agent 产品面 bin：USAGE_TEXT 宣告的命令在此成真。
 *
 * 只做三件事（零行为逻辑）：编译产物在位检查（缺席则按 tsconfig.cli.json
 * 编译——编译旗标单一来源，产物落包内 .tmp-gen，node_modules 解析走包目录）、
 * argv 透传运行 CLI 主缝（main.js）、子进程退出码透传。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// tsc 项目模式：依赖图公共根 = repo 根 → 产物镜像 repo 根相对结构
const compiledEntry = join(packageDir, ".tmp-gen", "packages", "review-dsh", "src", "cli", "main.js");

if (!existsSync(compiledEntry)) {
  const tscPath = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
  const compile = spawnSync(process.execPath, [tscPath, "-p", join(packageDir, "tsconfig.cli.json")], {
    stdio: "inherit",
  });
  if (compile.error !== undefined || compile.status !== 0) {
    process.stderr.write("review-agent: CLI compile failed\n");
    process.exit(compile.status ?? 1);
  }
}

const run = spawnSync(process.execPath, [compiledEntry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);

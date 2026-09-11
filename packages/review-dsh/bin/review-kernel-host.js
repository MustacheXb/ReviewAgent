#!/usr/bin/env node
/**
 * #27 review-kernel-host 产品面 bin：实验 runner 长驱的内核宿主进程。
 *
 * 与 review-agent bin 同款（零行为逻辑）：编译产物在位检查（缺席则按
 * tsconfig.kernel-host.json 编译——旗标经 tsconfig.cli.json 单源）+ argv
 * 透传 + 退出码透传。stdin/stdout = SDK JSON-RPC wire。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// tsc 项目模式：依赖图公共根 = repo 根 → 产物镜像 repo 根相对结构
const compiledEntry = join(packageDir, ".tmp-gen-host", "packages", "review-dsh", "src", "kernel-host", "main.js");

if (!existsSync(compiledEntry)) {
  const tscPath = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
  // 编译输出只进 stderr：stdout 承载 JSON-RPC 帧（协议纯净性），tsc 诊断不得混入
  const compile = spawnSync(process.execPath, [tscPath, "-p", join(packageDir, "tsconfig.kernel-host.json")], {
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
    process.stderr.write("review-kernel-host: kernel host compile failed\n");
    process.exit(compile.status ?? 1);
  }
}

const run = spawnSync(process.execPath, [compiledEntry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);

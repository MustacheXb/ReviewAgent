/**
 * bin 编译判鲜（#45）：产品面 bin（review-agent / review-kernel-host）的
 * 「在位检查」从存在性升级为 mtime 判鲜的共享实现。
 *
 * 背景事故（本票踩到）：kernel-host 编译镜像在位，但运行时经 node_modules
 * default 条件消费的 review-llm dist 是陈旧产物——wire.ts 的
 * `import { profileOf } from "review-llm"` 落到无该导出的 dist/index.js，
 * host 子进程秒死。存在性检查看不见「源已改、产物旧」。
 *
 * 判鲜语义：任一源树中最新文件的 mtime 严格晚于产物 mtime 即陈旧；
 * 源根缺席不贡献信号（多根判鲜允许某根不存在）。纯 node 内建、零依赖，
 * 供两个 bin 与单元测试共用（tests/bin/compile-freshness.test.ts）。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 目录树内最新文件 mtime（递归）；目录缺席或不可读返回入参 latest（不贡献信号） */
function newestMtime(dir, latest) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = newestMtime(path, latest);
    } else if (entry.isFile()) {
      const mtime = statSync(path).mtimeMs;
      if (mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
}

/**
 * 产物是否陈旧：缺席 → true；任一源根的最新 mtime 严格晚于产物 mtime → true。
 * 等于视为新鲜（同刻产物不重编）。
 */
export function isCompileStale(outputPath, sourceRoots) {
  if (!existsSync(outputPath)) {
    return true;
  }
  let outputMtime;
  try {
    outputMtime = statSync(outputPath).mtimeMs;
  } catch {
    return true;
  }
  for (const root of sourceRoots) {
    if (newestMtime(root, 0) > outputMtime) {
      return true;
    }
  }
  return false;
}

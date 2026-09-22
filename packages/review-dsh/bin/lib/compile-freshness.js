/**
 * bin 编译判鲜（#45）：产品面 bin（review-agent / review-kernel-host）的
 * 「在位检查」从存在性升级为 mtime 判鲜的共享实现。
 *
 * 背景事故（本票踩到）：kernel-host 编译镜像在位，但运行时经 node_modules
 * default 条件消费的 review-llm dist 是陈旧产物——wire.ts 的
 * `import { profileOf } from "review-llm"` 落到无该导出的 dist/index.js，
 * host 子进程秒死。存在性检查看不见「源已改、产物旧」。
 *
 * 判鲜语义：任一源树中最新文件的 mtime 晚于产物 mtime 超过 1ms 容差即
 * 陈旧（容差吸收文件系统亚毫秒精度噪声，见 FRESHNESS_TOLERANCE_MS 注）；
 * 源根缺席不贡献信号（多根判鲜允许某根不存在）。纯 node 内建、零依赖，
 * 供两个 bin 与单元测试共用（tests/bin/compile-freshness.test.ts）。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 判鲜容差（ms）：吸收文件系统时间戳的亚毫秒精度噪声。跨文件系统比较
 * 「源 mtime vs 产物 mtime」时，utimes 往返可损失 ~1µs（ext4 纳秒截断，
 * CI 实测 .999 vs 整毫秒）——「产物等于源」的场景会被严格比较翻转成
 * 「源严格晚于」→ 误判陈旧 → 无谓重编 / 测试间歇红灯。1ms 远小于任何
 * 真实「源已改、产物旧」的差距（秒级以上），容差不吞真陈旧信号。
 */
const FRESHNESS_TOLERANCE_MS = 1;

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
 * 产物是否陈旧：缺席 → true；任一源根的最新 mtime 晚于产物 mtime 超过
 * 判鲜容差（1ms）→ true。容差内（含相等与亚毫秒噪声）视为新鲜——
 * 同刻产物不重编。
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
    if (newestMtime(root, 0) > outputMtime + FRESHNESS_TOLERANCE_MS) {
      return true;
    }
  }
  return false;
}

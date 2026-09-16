/**
 * #45 bin 判鲜接线（进程级回归钉）：产品面 bin 的在位检查从存在性升级为
 * mtime 判鲜后，「源已改、产物旧」必须触发重编。
 *
 * 事故形态（本票踩到）：review-llm dist 是陈旧产物——kernel-host 镜像里的
 * wire.ts `import { profileOf } from "review-llm"` 在运行时经 node_modules
 * default 条件落到无该导出的 dist/index.js，host 子进程秒死。存在性检查
 * 看不见这类陈旧；判鲜语义 = 任一源树最新 mtime 晚于产物 mtime。
 *
 * 手法：只回拨产物 mtime、不改内容——并行 worker 的 spawn 读到的仍是合法
 * 字节，不会互相打断；断言 spawn 后产物 mtime 变新（重编发生）+ shutdown
 * 握手成功（host 真能跑）。回拨 30 天保证必然新于任一源树的最新文件。
 *
 * 判鲜语义本身的单元面见 tests/bin/compile-freshness.test.ts；本文件只钉
 * bin 的接线（含 review-llm dist 腿与编译镜像腿）。
 */

import { spawn } from "node:child_process";
import { statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const HOST_BIN = join(PACKAGE_DIR, "bin", "review-kernel-host.js");
const COMPILED_ENTRY = join(PACKAGE_DIR, ".tmp-gen-host", "packages", "review-dsh", "src", "kernel-host", "main.js");
const REVIEW_LLM_DIST_ENTRY = join(PACKAGE_DIR, "..", "review-llm", "dist", "index.js");

const TEST_TIMEOUT_MS = 240_000;
/** 回拨幅度：30 天——必然早于任何源文件的 mtime，判鲜信号确定性成立 */
const STALE_BACKDATE_MS = 30 * 24 * 3_600_000;

/** 逐行读 host stdout 的帧（JSON-RPC 响应）；流先关 = 协议违约，显式失败 */
async function readFrame(lines: AsyncIterableIterator<string>): Promise<Record<string, unknown>> {
  const next = await lines.next();
  if (next.done) {
    throw new Error("kernel-host stdout closed before a response frame arrived");
  }
  return JSON.parse(next.value) as Record<string, unknown>;
}

/** spawn host bin 并完成一次 shutdown 握手：响应帧 id 匹配 + 退出码 0 */
async function spawnHostAndShutdown(label: string): Promise<void> {
  const child = spawn(process.execPath, [HOST_BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (stdout === null || stdin === null) {
    child.kill();
    throw new Error(`${label}: kernel-host spawned without piped stdio`);
  }
  const lines = createInterface({ input: stdout })[Symbol.asyncIterator]();
  const exited = new Promise<number>((resolveExit) => {
    child.once("exit", (code) => {
      resolveExit(code ?? -1);
    });
  });
  try {
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shutdown" })}\n`);
    stdin.end();
    const frame = await readFrame(lines);
    expect(frame.id, `${label}: shutdown 响应帧 id`).toBe(1);
    expect("error" in frame, `${label}: shutdown 不应回错误帧`).toBe(false);
    const code = await exited;
    expect(code, `${label}: shutdown 后退出码`).toBe(0);
  } finally {
    child.kill();
  }
}

/** 回拨产物 mtime（内容不动），返回回拨到的时刻（ms） */
function backdate(path: string): number {
  const past = new Date(Date.now() - STALE_BACKDATE_MS);
  utimesSync(path, past, past);
  return past.getTime();
}

describe("bin 判鲜接线（#45）：陈旧产物 → spawn 前重编", () => {
  it(
    "镜像与 review-llm dist 双腿陈旧 → shutdown 握手成功且两产物 mtime 变新",
    async () => {
      // 前置 spawn：产物缺席则编译（吸收并行 worker 的清树/编译活动），
      // 同时验证基线路径（在位/新建产物 + shutdown）本身健康
      await spawnHostAndShutdown("前置");

      // 制造陈旧：双腿产物回拨 30 天（源树最新 mtime 必然晚于它）
      const mirrorBackdatedAt = backdate(COMPILED_ENTRY);
      const distBackdatedAt = backdate(REVIEW_LLM_DIST_ENTRY);
      expect(statSync(COMPILED_ENTRY).mtimeMs).toBe(mirrorBackdatedAt);
      expect(statSync(REVIEW_LLM_DIST_ENTRY).mtimeMs).toBe(distBackdatedAt);

      // 陈旧态 spawn：判鲜必须触发重编，host 以新产物完成 shutdown 握手
      await spawnHostAndShutdown("陈旧态");

      // 重编证据：产物 mtime 已晚于回拨时刻（旧 existsSync 语义下保持陈旧值）
      expect(statSync(COMPILED_ENTRY).mtimeMs).toBeGreaterThan(mirrorBackdatedAt);
      expect(statSync(REVIEW_LLM_DIST_ENTRY).mtimeMs).toBeGreaterThan(distBackdatedAt);
    },
    TEST_TIMEOUT_MS,
  );
});

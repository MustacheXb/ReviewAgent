/**
 * #26 验收（进程级烟测）：spawn 产品面 bin → 退出码 + stdout 形状。
 *
 * 产品面 = bin/review-agent.js（在位检查 + 按需编译 + argv/退出码透传）——
 * 烟测直接 spawn bin，编译路径与运行路径都是真产品路径；beforeAll 清掉
 * .tmp-gen 强制首个 spawn 走 bin 的按需编译（tsconfig.cli.json 单一来源）。
 *
 * - 成功路径：真实 DeepSeek 适配器代码路径 + 本地 stub HTTP 端点（127.0.0.1，
 *   零外网）跑通 config A 六阶段 → 退出码 0、stdout = 单个 JSON 文档（findings
 *   结构化 + auditPath）、审计文件落盘可重读（请求携带 wireBody——真实适配器
 *   来源）；哨兵 key 全程不出现在 stdout/stderr（凭据不落日志）；
 * - 截断路径：verdict 永不 complete（脚本耗尽后 stub 持续供给 fallback 回复，
 *   镜像 fake 适配器为上界截断预留的形态）→ MAX_ROUNDS 耗尽 → 退出码 0（诚实
 *   截断 = 产出了结果与审计，不是中止）+ stdout.truncated=true + rounds=5 +
 *   审计 30 请求（5 轮 × 6 阶段）；
 * - 错误路径：--config 越界 → 退出码 1 + stderr 用法信息；凭据缺失（无
 *   DEEPSEEK_API_KEY）→ 退出码 1 + 指引信息，stdout 干净。
 *
 * 退出码契约（票面）：完成（含诚实截断）0 / 中止或错误 1。
 */

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";
import { chatResponse, CONFIG_A_REPLIES, configAResponses } from "./cli-fixtures.js";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const BIN_ENTRY = join(PACKAGE_DIR, "bin", "review-agent.js");

const TEST_TIMEOUT_MS = 180_000;

/**
 * 本地 stub 端点（零外网）：按序回放响应体；脚本耗尽后若有 fallback 则持续
 * 供给（无 fallback 时 500——成功路径以此兜住「多发了未脚本化的请求」）。
 */
function startStubServer(responses: string[], fallback?: string): Promise<{ server: Server; url: string }> {
  let next = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `unexpected ${request.method} ${request.url}` }));
      return;
    }
    const body = next < responses.length ? responses[next] : fallback;
    next += 1;
    if (body === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "script exhausted" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("stub server has no port");
      }
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** 截断剧本：round 1 六阶段照常但 verdict complete=false，之后 stub fallback 永不完成 */
function configATruncatingResponses(): string[] {
  const replies = [...CONFIG_A_REPLIES];
  replies[5] = '{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports the finding"}],"complete":false}';
  return replies.map(chatResponse);
}

interface CliRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [BIN_ENTRY, ...args],
      { env, cwd: PACKAGE_DIR, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null && error.code === undefined) {
          // spawn 本身失败（非退出码语义）
          rejectPromise(error);
          return;
        }
        resolvePromise({ code: error === null ? 0 : Number(error.code), stdout, stderr });
      },
    );
  });
}

const workDirs: string[] = [];

afterAll(async () => {
  await Promise.all(workDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI 进程级烟测（#26）", () => {
  beforeAll(async () => {
    // 清掉既有编译产物 → 首个 spawn 走 bin 的按需编译真路径（防陈旧产物掩蔽）
    await rm(join(PACKAGE_DIR, ".tmp-gen"), { recursive: true, force: true });
  }, 30_000);

  it(
    "成功路径：本地 stub 端点 → 退出码 0 + stdout JSON 形状 + 审计文件落盘，key 不落日志",
    async () => {
      const { server, url } = await startStubServer(configAResponses());
      try {
        const outDir = await mkdtemp(join(tmpdir(), "review-agent-cli-smoke-"));
        workDirs.push(outDir);
        const diffFile = join(outDir, "fix-url-encoding.diff");
        await writeFile(diffFile, SAMPLE_MR_CASE.diff, "utf8");
        const sentinelKey = "sk-cli-smoke-sentinel-key";

        const run = await runCli(
          ["review", "--repo", SAMPLE_MR_CASE.repoPath, "--mr", diffFile, "--out", outDir],
          { ...process.env, DEEPSEEK_URL: url, DEEPSEEK_API_KEY: sentinelKey },
        );

        // —— 退出码契约：完成 0
        expect(run.code).toBe(0);
        // —— stdout 形状：整个 stdout 即一个 JSON 文档
        const outcome = JSON.parse(run.stdout) as Record<string, unknown>;
        expect(outcome).toMatchObject({
          ok: true,
          caseId: "fix-url-encoding",
          configId: "A",
          truncated: false,
          rounds: 1,
          toolCalls: 0,
        });
        expect(outcome.findings).toHaveLength(1);
        expect((outcome.findings as { readonly id: string }[])[0]).toMatchObject({ id: "F001" });
        // —— 审计文件：路径在场且可重读（真实适配器来源 → 请求携带 wireBody）
        const auditPath = outcome.auditPath;
        expect(typeof auditPath).toBe("string");
        const audit = JSON.parse(await readFile(auditPath as string, "utf8")) as {
          readonly runId: string;
          readonly configId: string;
          readonly requests: readonly { readonly wireBody?: string }[];
        };
        expect(audit.runId).toBe(outcome.runId);
        expect(audit.configId).toBe("A");
        expect(audit.requests).toHaveLength(6);
        expect(audit.requests.every((request) => request.wireBody !== undefined)).toBe(true);
        // —— 凭据不落日志（AC5）：哨兵 key 不出现在任何输出
        expect(run.stdout).not.toContain(sentinelKey);
        expect(run.stderr).not.toContain(sentinelKey);
      } finally {
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "截断路径：verdict 永不 complete → MAX_ROUNDS 耗尽 → 退出码 0 + truncated=true + rounds=5 + 30 请求",
    async () => {
      const { server, url } = await startStubServer(
        configATruncatingResponses(),
        chatResponse('{"verdicts":[],"complete":false}'),
      );
      try {
        const outDir = await mkdtemp(join(tmpdir(), "review-agent-cli-smoke-trunc-"));
        workDirs.push(outDir);
        const diffFile = join(outDir, "fix-url-encoding.diff");
        await writeFile(diffFile, SAMPLE_MR_CASE.diff, "utf8");

        const run = await runCli(
          ["review", "--repo", SAMPLE_MR_CASE.repoPath, "--mr", diffFile, "--out", outDir],
          { ...process.env, DEEPSEEK_URL: url, DEEPSEEK_API_KEY: "sk-cli-smoke-trunc-key" },
        );

        // —— 退出码契约的边界：诚实截断 = 产出了结果与审计（POC1 record 语义），
        //    不是中止——完整性信号在 stdout.truncated，退出码仍为 0
        expect(run.code).toBe(0);
        const outcome = JSON.parse(run.stdout) as Record<string, unknown>;
        expect(outcome).toMatchObject({
          ok: true,
          truncated: true,
          rounds: 5,
        });
        // round-1 已过闸的 F001 在截断下保留（诚实部分结果）
        expect(outcome.findings).toHaveLength(1);
        expect((outcome.findings as { readonly id: string }[])[0]).toMatchObject({ id: "F001" });
        // —— 轮数上限经真进程兑现：审计 30 请求（5 轮 × 6 阶段）+ 截断记因
        const audit = JSON.parse(
          await readFile(outcome.auditPath as string, "utf8"),
        ) as {
          readonly requests: readonly unknown[];
          readonly truncationReasons: readonly string[];
        };
        expect(audit.requests).toHaveLength(30);
        expect(audit.truncationReasons).toContain("MAX_ROUNDS_REACHED");
      } finally {
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "config 越界：--config F → 退出码 1 + stderr 用法信息，stdout 干净",
    async () => {
      const run = await runCli(
        ["review", "--repo", "whatever", "--mr", "whatever.diff", "--config", "F"],
        { ...process.env },
      );

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("--config");
      expect(run.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "凭据缺失：无 DEEPSEEK_API_KEY → 退出码 1 + 指引信息，stdout 干净",
    async () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.DEEPSEEK_API_KEY;
      delete env.DEEPSEEK_URL;
      const outDir = await mkdtemp(join(tmpdir(), "review-agent-cli-smoke-"));
      workDirs.push(outDir);
      const diffFile = join(outDir, "fix.diff");
      await writeFile(diffFile, SAMPLE_MR_CASE.diff, "utf8");
      const run = await runCli(
        ["review", "--repo", SAMPLE_MR_CASE.repoPath, "--mr", diffFile, "--out", outDir],
        env,
      );

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("DEEPSEEK_API_KEY");
      expect(run.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );
});

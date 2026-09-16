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
 *   DEEPSEEK_API_KEY）→ 退出码 1 + 指引信息，stdout 干净；
 * - #46 .env.local：bin 所在 cwd 的 .env.local 自动装载（文件值生效 /
 *   已有环境变量优先不被覆盖），摘要走 stderr（review 的 stdout 契约是
 *   单个 JSON 文档）；
 * - #46 smoke 子命令：双探针 200 → 退出码 0 + 人话报告；凭据缺失 →
 *   退出码 1 + 人话诊断（verdict 路径，不是异常路径）。
 *
 * 退出码契约（票面）：完成（含诚实截断）0 / 中止或错误 1；smoke 按诊断
 * 结论给码（通过 0 / 任何失败诊断 1）。
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";
import { chatResponse, configAResponses, CONFIG_A_REPLIES, SMOKE_PING_TOOL_CALL_BODY } from "../../../../tests/helpers/dsh-replies.js";
import { startStubLlmServer } from "../../../../tests/helpers/stub-llm-server.js";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const BIN_ENTRY = join(PACKAGE_DIR, "bin", "review-agent.js");

const TEST_TIMEOUT_MS = 180_000;

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

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string = PACKAGE_DIR,
): Promise<CliRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [BIN_ENTRY, ...args],
      { env, cwd, windowsHide: true },
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
      const stub = await startStubLlmServer(configAResponses());
      try {
        const outDir = await mkdtemp(join(tmpdir(), "review-agent-cli-smoke-"));
        workDirs.push(outDir);
        const diffFile = join(outDir, "fix-url-encoding.diff");
        await writeFile(diffFile, SAMPLE_MR_CASE.diff, "utf8");
        const sentinelKey = "sk-cli-smoke-sentinel-key";

        const run = await runCli(
          ["review", "--repo", SAMPLE_MR_CASE.repoPath, "--mr", diffFile, "--out", outDir],
          { ...process.env, DEEPSEEK_URL: stub.url, DEEPSEEK_API_KEY: sentinelKey },
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
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "截断路径：verdict 永不 complete → MAX_ROUNDS 耗尽 → 退出码 0 + truncated=true + rounds=5 + 30 请求",
    async () => {
      const stub = await startStubLlmServer(
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
          { ...process.env, DEEPSEEK_URL: stub.url, DEEPSEEK_API_KEY: "sk-cli-smoke-trunc-key" },
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
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "--model 下传（#45）：glm-4.7 经 CLI 旗标 → 审计顶层 model + wire 体按画像序列化",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      try {
        const outDir = await mkdtemp(join(tmpdir(), "review-agent-cli-smoke-model-"));
        workDirs.push(outDir);
        const diffFile = join(outDir, "fix-url-encoding.diff");
        await writeFile(diffFile, SAMPLE_MR_CASE.diff, "utf8");

        const run = await runCli(
          [
            "review",
            "--repo",
            SAMPLE_MR_CASE.repoPath,
            "--mr",
            diffFile,
            "--out",
            outDir,
            "--model",
            "glm-4.7",
          ],
          { ...process.env, DEEPSEEK_URL: stub.url, DEEPSEEK_API_KEY: "sk-cli-smoke-model-key" },
        );

        expect(run.code).toBe(0);
        const outcome = JSON.parse(run.stdout) as Record<string, unknown>;
        const audit = JSON.parse(await readFile(outcome.auditPath as string, "utf8")) as {
          readonly model: string;
          readonly requests: readonly { readonly wireBody?: string }[];
        };
        // CLI 旗标 → policy → 审计顶层 model（实验数据一路进审计）
        expect(audit.model).toBe("glm-4.7");
        // wire 体按画像序列化：glm 档无 thinking、32768 信封
        const firstWire = JSON.parse(String(audit.requests[0]?.wireBody)) as Record<string, unknown>;
        expect(firstWire.model).toBe("glm-4.7");
        expect("thinking" in firstWire).toBe(false);
        expect("reasoning_effort" in firstWire).toBe(false);
        expect(firstWire.max_tokens).toBe(32_768);
      } finally {
        await stub.close();
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

describe("CLI .env.local 与 smoke 子命令（#46）", () => {
  /** 干净凭据环境（.env.local 是唯一来源） */
  function cleanCredentialEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.REVIEWER_API_KEY;
    delete env.DEEPSEEK_API_KEY;
    delete env.REVIEWER_URL;
    delete env.DEEPSEEK_URL;
    return env;
  }

  it(
    ".env.local 文件值生效：cwd 的 .env.local 提供 REVIEWER_URL/KEY → 检视跑通（exit 0）+ stderr 摘要",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      try {
        const cwd = await mkdtemp(join(tmpdir(), "review-agent-envlocal-"));
        workDirs.push(cwd);
        const diffFile = join(cwd, "fix-url-encoding.diff");
        await writeFile(diffFile, SAMPLE_MR_CASE.diff, "utf8");
        await writeFile(
          join(cwd, ".env.local"),
          `REVIEWER_URL=${stub.url}\nREVIEWER_API_KEY=sk-envlocal-file-sentinel\n`,
          "utf8",
        );

        const run = await runCli(
          ["review", "--repo", SAMPLE_MR_CASE.repoPath, "--mr", diffFile, "--out", join(cwd, "out")],
          cleanCredentialEnv(),
          cwd,
        );

        // 文件值到达适配器（否则无端点可用 → exit 1）
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ ok: true });
        // 摘要走 stderr（review 的 stdout 契约 = 单个 JSON 文档）；只报键名
        expect(run.stderr).toContain(".env.local");
        expect(run.stderr).toContain("REVIEWER_URL");
        expect(run.stderr).toContain("REVIEWER_API_KEY");
        // key 纪律：文件里的哨兵 key 不出现在任何输出
        expect(run.stdout).not.toContain("sk-envlocal-file-sentinel");
        expect(run.stderr).not.toContain("sk-envlocal-file-sentinel");
      } finally {
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    ".env.local 不覆盖已有环境变量：env REVIEWER_URL 指向 stub、文件指向死端口 → 仍跑通（env 优先）",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      try {
        const cwd = await mkdtemp(join(tmpdir(), "review-agent-envlocal-prio-"));
        workDirs.push(cwd);
        const diffFile = join(cwd, "fix-url-encoding.diff");
        await writeFile(diffFile, SAMPLE_MR_CASE.diff, "utf8");
        // 文件值指向端口 1（连接必拒）——若文件覆盖 env，检视必然失败
        await writeFile(
          join(cwd, ".env.local"),
          "REVIEWER_URL=http://127.0.0.1:1\nREVIEWER_API_KEY=sk-envlocal-dead-sentinel\n",
          "utf8",
        );

        const run = await runCli(
          ["review", "--repo", SAMPLE_MR_CASE.repoPath, "--mr", diffFile, "--out", join(cwd, "out")],
          { ...cleanCredentialEnv(), REVIEWER_URL: stub.url, REVIEWER_API_KEY: "sk-envlocal-env-sentinel" },
          cwd,
        );

        // env 优先胜出：适配器打 stub 而非死端口
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ ok: true });
        // 摘要如实报 skipped（键名级）
        expect(run.stderr).toContain("skipped");
        expect(run.stderr).toContain("REVIEWER_URL");
      } finally {
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    ".env.local 读失败（非缺失）：目录占位 EISDIR → 退出码 1 + 干净人话错误（无堆栈，与实验 CLI 的干净处理对齐）",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "review-agent-envlocal-err-"));
      workDirs.push(cwd);
      // 目录占位 → readFileSync EISDIR（loader 只吞 ENOENT，其余抛出）
      await mkdir(join(cwd, ".env.local"));
      const diffFile = join(cwd, "fix.diff");
      await writeFile(diffFile, SAMPLE_MR_CASE.diff, "utf8");

      const run = await runCli(
        ["review", "--repo", SAMPLE_MR_CASE.repoPath, "--mr", diffFile, "--out", join(cwd, "out")],
        cleanCredentialEnv(),
        cwd,
      );

      expect(run.code).toBe(1);
      expect(run.stderr).toContain(".env.local");
      // 干净错误路径：不是未捕获异常的堆栈形态
      expect(run.stderr).not.toMatch(/^\s+at\s/m);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "smoke 子命令：双探针 200 → 退出码 0 + stdout 人话报告（端点/模型/双探针）",
    async () => {
      const toolCallReply = JSON.stringify(SMOKE_PING_TOOL_CALL_BODY);
      const stub = await startStubLlmServer([chatResponse("pong"), toolCallReply]);
      try {
        const run = await runCli(["smoke"], {
          ...cleanCredentialEnv(),
          REVIEWER_URL: stub.url,
          REVIEWER_API_KEY: "sk-smoke-process-sentinel",
        });

        expect(run.code).toBe(0);
        expect(run.stdout).toContain("通过");
        expect(run.stdout).toContain("补全探针");
        expect(run.stdout).toContain("review_smoke_ping");
        expect(run.stdout).toContain(stub.url);
        // key 纪律：哨兵不落 stdout/stderr
        expect(run.stdout).not.toContain("sk-smoke-process-sentinel");
        expect(run.stderr).not.toContain("sk-smoke-process-sentinel");
      } finally {
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "smoke 子命令：凭据缺失 → 退出码 1 + stdout 人话诊断（verdict 路径，不发探针）",
    async () => {
      const run = await runCli(["smoke"], cleanCredentialEnv());

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("凭据缺失");
      expect(run.stdout).toContain("REVIEWER_API_KEY");
      expect(run.stdout).toContain(".env.local");
    },
    TEST_TIMEOUT_MS,
  );
});

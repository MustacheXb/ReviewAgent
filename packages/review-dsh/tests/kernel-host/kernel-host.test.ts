/**
 * #27 验收（kernel host）：SDK JSON-RPC wire 上的长驻内核进程。
 *
 * 两条轴：
 * - 裸 wire（不借 SDK 客户端件）：直接 spawn host bin、手写 JSON-RPC 行——
 *   无效 configId → -32603 错误帧且进程存活；未知方法 → -32603；有效
 *   review/run → 结果帧；shutdown → 回帧后以 0 退出（线上协议契约）；
 * - 驱动器（runner 侧 dsh-kernel.ts，建在同一 SDK transport 上）：config A
 *   全链路（findings + 审计落盘 wireBody + sessions 树）、同进程 preset 切换
 *   （A → B，逐请求切配置）、错误帧隔离（失败单元不拖垮下一单元）、凭据缺失
 *   fail fast（key 名指引，值不回显）。
 *
 * LLM 端点 = 本地 stub（127.0.0.1，零外网）；beforeAll 清 .tmp-gen-host 强制
 * 首个 spawn 走 bin 的按需编译真路径（与 cli-smoke 的 .tmp-gen 树隔离，防
 * 并行 worker 竞争）。
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDshKernelDriver } from "../../../../src/experiment/dsh-kernel.js";
import type { ConfigId } from "../../../../src/contracts/config.js";
import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";
import {
  chatResponse,
  configARepliesFor,
  configAResponses,
  FINDING_F001_ZH,
} from "../../../../tests/helpers/dsh-replies.js";
import { startStubLlmServer } from "../../../../tests/helpers/stub-llm-server.js";

import { ZONE_A } from "../../src/plugins/review-policy.js";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const HOST_BIN = join(PACKAGE_DIR, "bin", "review-kernel-host.js");

const TEST_TIMEOUT_MS = 240_000;

const workDirs: string[] = [];

afterAll(async () => {
  await Promise.all(workDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeAuditDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

function stubEnv(stubUrl: string, sentinelKey: string): NodeJS.ProcessEnv {
  return { ...process.env, DEEPSEEK_URL: stubUrl, DEEPSEEK_API_KEY: sentinelKey };
}

/** 逐行读 host stdout 的帧（JSON-RPC 响应）；流先关 = 协议违约，显式失败 */
async function readFrame(lines: AsyncIterableIterator<string>): Promise<Record<string, unknown>> {
  const next = await lines.next();
  if (next.done) {
    throw new Error("kernel-host stdout closed before a response frame arrived");
  }
  return JSON.parse(next.value) as Record<string, unknown>;
}

function errorCode(frame: Record<string, unknown>): number {
  const error = frame.error as { readonly code?: unknown } | undefined;
  return typeof error?.code === "number" ? error.code : Number.NaN;
}

describe("DSH kernel host（#27）", () => {
  beforeAll(async () => {
    // 清掉既有编译产物 → 首个 spawn 走 bin 的按需编译真路径（防陈旧产物掩蔽）
    await rm(join(PACKAGE_DIR, ".tmp-gen-host"), { recursive: true, force: true });
  }, 60_000);

  it(
    "裸 wire：错误帧 -32603 且进程存活 → 有效 review/run 结果帧 → shutdown 回帧 + 退出 0",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      const auditDir = await makeAuditDir("dsh-host-raw-wire-");
      const child = spawn(process.execPath, [HOST_BIN], {
        env: stubEnv(stub.url, "sk-raw-wire-sentinel"),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout = child.stdout;
      const stdin = child.stdin;
      if (stdout === null || stdin === null) {
        child.kill();
        throw new Error("kernel-host spawned without piped stdio");
      }
      const lines = createInterface({ input: stdout })[Symbol.asyncIterator]();
      const exited = new Promise<number>((resolveExit) => {
        child.once("exit", (code) => {
          resolveExit(code ?? -1);
        });
      });
      const write = (frame: unknown): void => {
        stdin.write(`${JSON.stringify(frame)}\n`);
      };
      try {
        // 1) 无效 configId → -32603 错误帧（handler throw），进程存活
        write({
          jsonrpc: "2.0",
          id: 1,
          method: "review/run",
          params: {
            configId: "F",
            caseId: "raw-wire",
            issueDescription: "",
            diff: SAMPLE_MR_CASE.diff,
            repoPath: SAMPLE_MR_CASE.repoPath,
            auditDir,
          },
        });
        const invalid = await readFrame(lines);
        expect(invalid.id).toBe(1);
        expect(errorCode(invalid)).toBe(-32603);
        expect(JSON.stringify(invalid)).toContain("configId");

        // 2) 未知方法 → -32603（方法面只有 review/run + shutdown）
        write({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: {} });
        const unknown = await readFrame(lines);
        expect(unknown.id).toBe(2);
        expect(errorCode(unknown)).toBe(-32603);

        // 3) 有效 review/run → 结果帧（POC1 RunResult + auditPath）
        write({
          jsonrpc: "2.0",
          id: 3,
          method: "review/run",
          params: {
            configId: "A",
            caseId: "raw-wire",
            issueDescription: "",
            diff: SAMPLE_MR_CASE.diff,
            repoPath: SAMPLE_MR_CASE.repoPath,
            auditDir,
          },
        });
        const ok = await readFrame(lines);
        expect(ok.id).toBe(3);
        const result = ok.result as Record<string, unknown>;
        expect(result.caseId).toBe("raw-wire");
        expect(result.configId).toBe("A");
        expect(result.findings).toHaveLength(1);
        expect(typeof result.auditPath).toBe("string");

        // 4) shutdown → 回帧 + 进程以 0 退出
        write({ jsonrpc: "2.0", id: 4, method: "shutdown", params: {} });
        const bye = await readFrame(lines);
        expect(bye.id).toBe(4);
        expect(await exited).toBe(0);
      } finally {
        child.kill();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "驱动器 config A：findings F001 + rounds 1 + 审计落盘（wireBody）+ sessions 树",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      const auditDir = await makeAuditDir("dsh-host-driver-a-");
      const driver = createDshKernelDriver({ env: stubEnv(stub.url, "sk-driver-a-sentinel") });
      try {
        const result = await driver.runUnit({
          configId: "A",
          caseId: "fix-url-encoding",
          issueDescription: "URL encoding regression",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
        });

        expect(result.caseId).toBe("fix-url-encoding");
        expect(result.configId).toBe("A");
        expect(result.findings.map((finding) => finding.id)).toEqual(["F001"]);
        expect(result.rounds).toBe(1);
        expect(result.toolCalls).toBe(0);
        if (result.auditPath === undefined) {
          throw new Error("driver result is missing auditPath");
        }
        // 审计文件：host 落盘、可重读、请求携带真实适配器来源的 wireBody
        const audit = JSON.parse(await readFile(result.auditPath, "utf8")) as {
          readonly runId: string;
          readonly configId: string;
          readonly requests: readonly { readonly wireBody?: string }[];
        };
        expect(audit.configId).toBe("A");
        expect(audit.requests).toHaveLength(6);
        expect(audit.requests.every((request) => request.wireBody !== undefined)).toBe(true);
        // sessions 树：host 在 auditDir/sessions 下为本次运行建会话目录
        const sessions = await readdir(join(auditDir, "sessions"));
        expect(sessions.some((entry) => entry.startsWith("run-"))).toBe(true);
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "同进程 preset 切换：A 单元后 B 单元（同一 host 进程，configId 逐请求切）",
    async () => {
      const stub = await startStubLlmServer([...configAResponses(), ...configAResponses()]);
      const auditDir = await makeAuditDir("dsh-host-switch-");
      const driver = createDshKernelDriver({ env: stubEnv(stub.url, "sk-switch-sentinel") });
      try {
        const unitA = await driver.runUnit({
          configId: "A",
          caseId: "switch-a",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
        });
        const unitB = await driver.runUnit({
          configId: "B",
          caseId: "switch-b",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
        });

        expect(unitA.configId).toBe("A");
        expect(unitA.audit.prefetch).toBeUndefined();
        expect(unitB.configId).toBe("B");
        // B 的确定性预取留痕（POC1 RunAudit.prefetch 契约；A 合法缺席）
        expect(unitB.audit.prefetch).toBeDefined();
        expect(unitB.findings.map((finding) => finding.id)).toEqual(["F001"]);
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "错误帧隔离：configId F 失败后，同进程下一有效请求成功（失败单元不拖垮 host）",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      const auditDir = await makeAuditDir("dsh-host-isolation-");
      const driver = createDshKernelDriver({ env: stubEnv(stub.url, "sk-isolation-sentinel") });
      try {
        await expect(
          driver.runUnit({
            configId: "F" as ConfigId,
            caseId: "bad-unit",
            issueDescription: "",
            diff: SAMPLE_MR_CASE.diff,
            auditDir,
          }),
        ).rejects.toThrow(/configId/);

        const recovered = await driver.runUnit({
          configId: "A",
          caseId: "good-unit",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
        });
        expect(recovered.caseId).toBe("good-unit");
        expect(recovered.findings.map((finding) => finding.id)).toEqual(["F001"]);
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "真实 API 级 turn 预算转发：首响应延迟 11.5s（> 缺省 10s）单元不炸（#29 冒烟回归）",
    async () => {
      // 冒烟现场：真实网关 thinking 单 turn 30-90s+，host 组装若不转发真实级
      // turnTimeoutMs，缺省 10s 在首个慢 turn 上炸掉单元（review-runtime:
      // "turn 1 did not end within 10000ms"）。延迟只加首响应控慢测试成本。
      const stub = await startStubLlmServer(configAResponses(), undefined, {
        firstResponseDelayMs: 11_500,
      });
      const auditDir = await makeAuditDir("dsh-host-slow-turn-");
      const driver = createDshKernelDriver({ env: stubEnv(stub.url, "sk-slow-turn-sentinel") });
      try {
        const result = await driver.runUnit({
          configId: "A",
          caseId: "slow-first-turn",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
        });
        expect(result.findings.map((finding) => finding.id)).toEqual(["F001"]);
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "凭据缺失：无任何 key 名 → runUnit 拒绝并指引角色名（别名并列），进程正常关闭",
    async () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.DEEPSEEK_API_KEY;
      delete env.DEEPSEEK_URL;
      delete env.REVIEWER_API_KEY;
      delete env.REVIEWER_URL;
      const auditDir = await makeAuditDir("dsh-host-no-creds-");
      const driver = createDshKernelDriver({ env });
      try {
        await expect(
          driver.runUnit({
            configId: "A",
            caseId: "no-creds",
            issueDescription: "",
            diff: SAMPLE_MR_CASE.diff,
            auditDir,
          }),
        ).rejects.toThrow(/REVIEWER_API_KEY/u);
      } finally {
        await driver.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("DSH kernel host — model 下传与凭据透传（#45）", () => {
  it(
    "驱动器 model 下传：自定义 model 贯穿 host（结果 model + 审计顶层 model + wire 体按画像序列化）",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      const auditDir = await makeAuditDir("dsh-host-model-glm-");
      const driver = createDshKernelDriver({ env: stubEnv(stub.url, "sk-model-glm-sentinel") });
      try {
        const result = await driver.runUnit({
          configId: "A",
          caseId: "model-glm",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
          model: "glm-4.7",
        });

        // POC1 RunResult.model：model 是实验数据，从请求一路进结果与审计
        expect(result.model).toBe("glm-4.7");
        if (result.auditPath === undefined) {
          throw new Error("driver result is missing auditPath");
        }
        const audit = JSON.parse(await readFile(result.auditPath, "utf8")) as {
          readonly model: string;
          readonly requests: readonly { readonly wireBody?: string }[];
        };
        expect(audit.model).toBe("glm-4.7");
        // wire 体按画像序列化（#45）：glm 档无 thinking、32768 信封
        const firstWire = JSON.parse(String(audit.requests[0]?.wireBody)) as Record<string, unknown>;
        expect("thinking" in firstWire).toBe(false);
        expect("reasoning_effort" in firstWire).toBe(false);
        expect(firstWire.max_tokens).toBe(32_768);
        expect(firstWire.model).toBe("glm-4.7");
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "缺省 model：不带 model 的 runUnit 回落 deepseek-v4-flash（DeepSeek 默认路径行为不变）",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      const auditDir = await makeAuditDir("dsh-host-model-default-");
      const driver = createDshKernelDriver({ env: stubEnv(stub.url, "sk-model-default-sentinel") });
      try {
        const result = await driver.runUnit({
          configId: "A",
          caseId: "model-default",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
        });

        expect(result.model).toBe("deepseek-v4-flash");
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "REVIEWER_* 凭据透传：url / key 经角色环境变量到达 host 子进程（别名缺席亦可用）",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      const auditDir = await makeAuditDir("dsh-host-reviewer-env-");
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.DEEPSEEK_API_KEY;
      delete env.DEEPSEEK_URL;
      env.REVIEWER_URL = stub.url;
      env.REVIEWER_API_KEY = "sk-reviewer-passthrough-sentinel";
      const driver = createDshKernelDriver({ env });
      try {
        const result = await driver.runUnit({
          configId: "A",
          caseId: "reviewer-env",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
        });

        // 角色名凭据完成整条链路（host 子进程解析别名 → 适配器 → stub 端点）
        expect(result.findings.map((finding) => finding.id)).toEqual(["F001"]);
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("DSH kernel host — language 下传（#58）", () => {
  it(
    "zh 端到端：语言参数贯穿 policy（zh 序列 + 语言门放行）→ 中文 findings + 审计顶层 zh + wire system = zh 冻结序列",
    async () => {
      const stub = await startStubLlmServer(configARepliesFor(FINDING_F001_ZH).map(chatResponse));
      const auditDir = await makeAuditDir("dsh-host-language-zh-");
      const driver = createDshKernelDriver({ env: stubEnv(stub.url, "sk-language-zh-sentinel") });
      try {
        const result = await driver.runUnit({
          configId: "A",
          caseId: "language-zh",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
          language: "zh",
        });

        // 语言门 zh 判据放行中文候选（title / description 中文；file / rule / 枚举原样）
        expect(result.outputLanguage).toBe("zh");
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
          id: "F001",
          file: "src/main/java/Example.java",
          rule: "CORRECTNESS-001",
          title: "查询参数的 URL 编码错误",
          description: "该改动对拼接后的查询串整体编码，而非逐个参数值编码。",
          evidence: ["Example.java:42 - 对拼接后的查询串调用了 URLEncoder.encode，应逐个参数值编码"],
        });
        if (result.auditPath === undefined) {
          throw new Error("driver result is missing auditPath");
        }
        const audit = JSON.parse(await readFile(result.auditPath, "utf8")) as {
          readonly outputLanguage: string;
          readonly requests: readonly { readonly wireBody?: string }[];
        };
        expect(audit.outputLanguage).toBe("zh");
        // wire 首请求 system = zh 冻结序列（Zone A 按语言分序列的进程级字节锚）
        const firstWire = JSON.parse(String(audit.requests[0]?.wireBody)) as {
          readonly messages: readonly { readonly role: string; readonly content: string }[];
        };
        expect(firstWire.messages[0]?.role).toBe("system");
        expect(firstWire.messages[0]?.content).toBe(ZONE_A.zh);
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "非法 language：裸 wire language \"fr\" → -32603 错误帧且进程存活（后续有效请求成功）",
    async () => {
      const stub = await startStubLlmServer(configAResponses());
      const auditDir = await makeAuditDir("dsh-host-language-fr-");
      const child = spawn(process.execPath, [HOST_BIN], {
        env: stubEnv(stub.url, "sk-language-fr-sentinel"),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout = child.stdout;
      const stdin = child.stdin;
      if (stdout === null || stdin === null) {
        child.kill();
        throw new Error("kernel-host spawned without piped stdio");
      }
      const lines = createInterface({ input: stdout })[Symbol.asyncIterator]();
      const write = (frame: unknown): void => {
        stdin.write(`${JSON.stringify(frame)}\n`);
      };
      try {
        // 1) 非法 language → -32603（handler throw），进程存活
        write({
          jsonrpc: "2.0",
          id: 1,
          method: "review/run",
          params: {
            configId: "A",
            caseId: "language-fr",
            issueDescription: "",
            diff: SAMPLE_MR_CASE.diff,
            repoPath: SAMPLE_MR_CASE.repoPath,
            auditDir,
            language: "fr",
          },
        });
        const invalid = await readFrame(lines);
        expect(invalid.id).toBe(1);
        expect(errorCode(invalid)).toBe(-32603);
        expect(JSON.stringify(invalid)).toContain("language");

        // 2) 进程存活：同进程后续有效请求成功（缺省 en）
        write({
          jsonrpc: "2.0",
          id: 2,
          method: "review/run",
          params: {
            configId: "A",
            caseId: "language-recovered",
            issueDescription: "",
            diff: SAMPLE_MR_CASE.diff,
            repoPath: SAMPLE_MR_CASE.repoPath,
            auditDir,
          },
        });
        const ok = await readFrame(lines);
        expect(ok.id).toBe(2);
        const result = ok.result as { readonly outputLanguage?: string; readonly findings: readonly unknown[] };
        expect(result.outputLanguage).toBe("en");
        expect(result.findings).toHaveLength(1);
      } finally {
        child.kill();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "en 字节回归：显式 language \"en\" 与缺省运行的请求字节逐字节一致（system = en 冻结序列 = 现状）",
    async () => {
      const stub = await startStubLlmServer([...configAResponses(), ...configAResponses()]);
      const auditDir = await makeAuditDir("dsh-host-language-en-");
      const driver = createDshKernelDriver({ env: stubEnv(stub.url, "sk-language-en-sentinel") });
      try {
        const omitted = await driver.runUnit({
          configId: "A",
          caseId: "language-en-default",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
        });
        const explicit = await driver.runUnit({
          configId: "A",
          caseId: "language-en-explicit",
          issueDescription: "",
          diff: SAMPLE_MR_CASE.diff,
          repoPath: SAMPLE_MR_CASE.repoPath,
          auditDir,
          language: "en",
        });

        // 恒携带 en（缺省与显式同档）
        expect(omitted.outputLanguage).toBe("en");
        expect(explicit.outputLanguage).toBe("en");
        // AC5：en 显式不改变请求字节——语言的影响面是 Zone A system 消息
        // （messages[0]；MR intro 内嵌 caseId，两次运行天然不同，不在对照面）
        expect(explicit.auditPath).toBeDefined();
        const [defaultAudit, explicitAudit] = await Promise.all([
          readFile(omitted.auditPath ?? "", "utf8"),
          readFile(explicit.auditPath ?? "", "utf8"),
        ]) as [string, string];
        const firstWireOf = (auditJson: string): unknown =>
          JSON.parse(String((JSON.parse(auditJson) as { readonly requests: readonly { readonly wireBody?: string }[] }).requests[0]?.wireBody));
        const systemOf = (auditJson: string): string =>
          (firstWireOf(auditJson) as { readonly messages: readonly { readonly role: string; readonly content: string }[] }).messages[0]?.content ?? "";
        // 显式 en 的 system 与缺省运行逐字节一致，且即 en 冻结序列（= 现状，
        // #53 字节锁的进程级对照锚——en 序列与 #53 前逐字节相同）
        expect(systemOf(explicitAudit)).toBe(systemOf(defaultAudit));
        expect(systemOf(defaultAudit)).toBe(ZONE_A.en);
        expect(systemOf(explicitAudit)).toBe(ZONE_A.en);
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

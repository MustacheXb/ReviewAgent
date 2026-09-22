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
 * #61 增量（review/run 内嵌切分编排，spec Q1–Q9）：超界 MR 切分串行合并为
 * 超界形状结果帧（求和口径 + shards 节）+ 每片一帧 review/progress 通知 +
 * 各片审计落盘（AC1）；分片数超限 → 专用错误码 -32000 + error.data 结构化
 * 拒绝、零片执行、进程存活（AC2，Q9 接管服务端分发的裸 wire 帧形状锁）；
 * 不可解析 diff（纯重命名块）退回直通形状（AC3 行为锁——实现前后不变形，
 * 绝不比旧行为差）；域内直通形状由 #27 既有测试锁（AC4）。
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
  FINDING_F001,
  FINDING_F001_ZH,
} from "../../../../tests/helpers/dsh-replies.js";
import { fileBlock } from "../../../../tests/helpers/diff-blocks.js";
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

/** 裸 wire host 会话（#61 起超界 / 超限 / 退直通场景共用）：写帧 + 逐行读帧 + 退出码 */
interface HostWire {
  readonly write: (frame: unknown) => void;
  readonly lines: AsyncIterableIterator<string>;
  readonly exited: Promise<number>;
  readonly close: () => void;
}

function spawnHostWire(stubUrl: string, sentinelKey: string): HostWire {
  const child = spawn(process.execPath, [HOST_BIN], {
    env: stubEnv(stubUrl, sentinelKey),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (stdout === null || stdin === null) {
    child.kill();
    throw new Error("kernel-host spawned without piped stdio");
  }
  return {
    write: (frame) => {
      stdin.write(`${JSON.stringify(frame)}\n`);
    },
    lines: createInterface({ input: stdout })[Symbol.asyncIterator](),
    exited: new Promise<number>((resolveExit) => {
      child.once("exit", (code) => {
        resolveExit(code ?? -1);
      });
    }),
    close: () => {
      child.kill();
    },
  };
}

/** 读帧直至响应帧到达，收集途经的通知帧（进度帧与响应帧的相对顺序可观测） */
async function readUntilResponse(
  lines: AsyncIterableIterator<string>,
): Promise<{ readonly response: Record<string, unknown>; readonly notifications: Record<string, unknown>[] }> {
  const notifications: Record<string, unknown>[] = [];
  for (;;) {
    const frame = await readFrame(lines);
    if (typeof frame.method === "string") {
      notifications.push(frame);
      continue;
    }
    return { response: frame, notifications };
  }
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

describe("DSH kernel host — review/run 内嵌切分编排（#61）", () => {
  /** shard-002 剧本 finding：与 F001 同规则同类别、异文件异行 → 锚点键不命中（各自独立呈现） */
  const FINDING_F002 = {
    ...FINDING_F001,
    id: "F002",
    file: "src/main/java/Other.java",
    line: 7,
    evidence: ["Other.java:7 - URLEncoder.encode applied to the joined query string"],
  };

  /** shard-002 剧本：config A 六阶段同款，candidates / verdicts 换 F002（剧本结构单源） */
  function configAF002Responses(): string[] {
    return configARepliesFor(FINDING_F002).map(chatResponse);
  }

  /** 12 文件超界 diff（目录亲和 → 2 片：pkg-a / pkg-b 各 6 文件 12 行） */
  function twoShardDiff(): string {
    return [
      ...Array.from({ length: 6 }, (_, i) => `src/pkg-a/A${i + 1}.java`),
      ...Array.from({ length: 6 }, (_, i) => `src/pkg-b/B${i + 1}.java`),
    ]
      .map((file) => fileBlock(file, 2))
      .join("");
  }

  it(
    "AC1 超界切分：12 文件 → 2 片串行 → 超界形状结果帧 + 每片一帧 review/progress + 各片审计落盘",
    async () => {
      // 剧本按序：回复 1–6 = shard-001（F001）、7–12 = shard-002（F002）——
      // 串行执行下序号对齐；若两片交错，findings 与各片审计即错位（对齐断言即串行证明）
      const stub = await startStubLlmServer([...configAResponses(), ...configAF002Responses()]);
      const auditDir = await makeAuditDir("dsh-host-61-shard-");
      const host = spawnHostWire(stub.url, "sk-61-shard-sentinel");
      try {
        host.write({
          jsonrpc: "2.0",
          id: 1,
          method: "review/run",
          params: {
            configId: "A",
            caseId: "rpc-big-mr",
            issueDescription: "",
            diff: twoShardDiff(),
            repoPath: SAMPLE_MR_CASE.repoPath,
            auditDir,
          },
        });
        const { response, notifications } = await readUntilResponse(host.lines);
        expect(response.id).toBe(1);

        // —— 进度通知（Q4/Q6）：每片完成后一帧（method 无 id），字段如契、按片序
        expect(notifications).toHaveLength(2);
        const progressFrames = notifications as unknown as readonly {
          readonly method: string;
          readonly params: Record<string, unknown>;
        }[];
        const progress1 = progressFrames[0]!;
        const progress2 = progressFrames[1]!;
        expect(progress1.method).toBe("review/progress");
        expect(progress1.params).toMatchObject({
          shardIndex: 1,
          shardCount: 2,
          shardId: "rpc-big-mr#shard-001",
        });
        expect(progress2.method).toBe("review/progress");
        expect(progress2.params).toMatchObject({
          shardIndex: 2,
          shardCount: 2,
          shardId: "rpc-big-mr#shard-002",
        });

        // —— 超界形状（Q2）：求和口径摘要 + shards 节；顶层无 audit 投影 /
        //    auditPath / runId（各片关联在 shards.entries——多片无单一关联键）
        const result = response.result as Record<string, unknown>;
        expect(result).toMatchObject({
          caseId: "rpc-big-mr",
          configId: "A",
          model: "deepseek-v4-flash",
          outputLanguage: "en",
          truncated: false,
          rounds: 2,
          toolCalls: 0,
        });
        // stub 常量：每请求 miss 100 / completion 10 / cache hit 50 → 每片 6 请求
        // {600, 60, 300}，两片和
        expect(result.usage).toEqual({
          inputTokens: 1200,
          outputTokens: 120,
          cacheReadTokens: 600,
        });
        expect("audit" in result).toBe(false);
        expect("auditPath" in result).toBe(false);
        expect("runId" in result).toBe(false);
        const shards = result.shards as {
          readonly reason: string;
          readonly count: number;
          readonly entries: readonly {
            readonly shardId: string;
            readonly runId: string;
            readonly auditPath: string;
          }[];
        };
        expect(shards).toMatchObject({
          reason: "files",
          boundary: { maxFiles: 10, maxDiffLines: 2000 },
          count: 2,
        });
        expect(shards.entries.map((entry) => entry.shardId)).toEqual([
          "rpc-big-mr#shard-001",
          "rpc-big-mr#shard-002",
        ]);
        // 进度帧与 shards 条目对位（runId / auditPath 同源——单一挂点证明）
        expect(progress1.params.runId).toBe(shards.entries[0]!.runId);
        expect(progress1.params.auditPath).toBe(shards.entries[0]!.auditPath);
        expect(progress2.params.runId).toBe(shards.entries[1]!.runId);
        expect(progress2.params.auditPath).toBe(shards.entries[1]!.auditPath);

        // —— 合并 findings：F001（片 1）/ F002（片 2）各带单 shardIds（异文件不并）
        const findings = result.findings as { readonly id: string; readonly shardIds: string[] }[];
        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({ id: "F001", shardIds: ["rpc-big-mr#shard-001"] });
        expect(findings[1]).toMatchObject({ id: "F002", shardIds: ["rpc-big-mr#shard-002"] });

        // —— 各片审计落盘可读且与条目对齐（AC1 落盘断言；串行执行的可观测证明）
        for (const [index, expectedFindingId] of ["F001", "F002"].entries()) {
          const entry = shards.entries[index]!;
          const audit = JSON.parse(await readFile(entry.auditPath, "utf8")) as {
            readonly runId: string;
            readonly caseId: string;
            readonly findings: readonly { readonly id: string }[];
          };
          expect(audit.runId).toBe(entry.runId);
          expect(audit.caseId).toBe(`rpc-big-mr#shard-00${index + 1}`);
          expect(audit.findings.map((finding) => finding.id)).toEqual([expectedFindingId]);
        }

        // —— shutdown 回帧 + 退出 0（超界请求不破坏进程生命周期）
        host.write({ jsonrpc: "2.0", id: 9, method: "shutdown", params: {} });
        expect((await readFrame(host.lines)).id).toBe(9);
        expect(await host.exited).toBe(0);
      } finally {
        host.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC2 超限：210 文件 → -32000 错误帧 + error.data 结构化拒绝（零片执行零进度帧），进程存活",
    async () => {
      // 剧本仅存活验证消费（拒绝零运行成本——零片执行断言见 auditDir 空检查）
      const stub = await startStubLlmServer(configAResponses());
      const auditDir = await makeAuditDir("dsh-host-61-limit-");
      const host = spawnHostWire(stub.url, "sk-61-limit-sentinel");
      try {
        const diff = Array.from({ length: 210 }, (_, i) => fileBlock(`src/pkg/P${i}.java`, 2)).join("");
        host.write({
          jsonrpc: "2.0",
          id: 1,
          method: "review/run",
          params: {
            configId: "A",
            caseId: "rpc-over-limit",
            issueDescription: "",
            diff,
            repoPath: SAMPLE_MR_CASE.repoPath,
            auditDir,
          },
        });
        const { response, notifications } = await readUntilResponse(host.lines);
        // —— 零片执行：零进度帧（Q6——超限拒绝零片执行亦零帧）
        expect(notifications).toHaveLength(0);
        expect(response.id).toBe(1);
        // —— 专用错误码 -32000（与运行失败 -32603 可区分——Q1/Q9；CLI 退出码 2 的 RPC 对应物）
        expect(errorCode(response)).toBe(-32000);
        const error = response.error as {
          readonly code: number;
          readonly message: string;
          readonly data?: unknown;
        };
        expect(error.message).toContain("所需分片数 21");
        expect(error.message).toContain("上限 20");
        // —— error.data 结构化拒绝参数（平台侧可编程区分并提示拆 MR 的源）
        expect(error.data).toEqual({ rejectReason: "shard-limit", requiredShards: 21, shardLimit: 20 });
        // —— 零运行成本：拒绝前无任何运行留痕（sessions / audit 由运行器按片创建）
        expect(await readdir(auditDir)).toEqual([]);

        // —— 进程存活：同进程后续域内请求成功（直通形状——失败隔离同款）
        host.write({
          jsonrpc: "2.0",
          id: 2,
          method: "review/run",
          params: {
            configId: "A",
            caseId: "rpc-recovered",
            issueDescription: "",
            diff: SAMPLE_MR_CASE.diff,
            repoPath: SAMPLE_MR_CASE.repoPath,
            auditDir,
          },
        });
        const recovered = await readFrame(host.lines);
        expect(recovered.id).toBe(2);
        expect((recovered.result as Record<string, unknown>).findings).toHaveLength(1);

        // —— shutdown 回帧 + 退出 0
        host.write({ jsonrpc: "2.0", id: 9, method: "shutdown", params: {} });
        expect((await readFrame(host.lines)).id).toBe(9);
        expect(await host.exited).toBe(0);
      } finally {
        host.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC3 不可解析 diff（纯重命名块）：退回直通（直通形状 + 零进度帧）——行为锁，实现前后不变形",
    async () => {
      // 纯重命名块（rename from / to、无 hunk）是 host 既有输入集（内核从不
      // 解析 diff）——编排接入后该输入集必须保真回退直通，绝不比旧行为差
      // （与 #56 CLI 同款回归锁；本测试实现前后都应绿，锁的是不变形）
      const stub = await startStubLlmServer(configAResponses());
      const auditDir = await makeAuditDir("dsh-host-61-rename-");
      const host = spawnHostWire(stub.url, "sk-61-rename-sentinel");
      try {
        const diff = [
          "diff --git a/src/Old.java b/src/New.java",
          "similarity index 100%",
          "rename from src/Old.java",
          "rename to src/New.java",
          "",
        ].join("\n");
        host.write({
          jsonrpc: "2.0",
          id: 1,
          method: "review/run",
          params: {
            configId: "A",
            caseId: "rpc-rename",
            issueDescription: "",
            diff,
            repoPath: SAMPLE_MR_CASE.repoPath,
            auditDir,
          },
        });
        const { response, notifications } = await readUntilResponse(host.lines);
        // —— 直通零进度帧（Q6：仅切分执行时发）
        expect(notifications).toHaveLength(0);
        expect(response.id).toBe(1);
        // —— 直通形状：字段集与现状逐键等价（audit 投影 + auditPath 在场、无 shards 节）
        const result = response.result as Record<string, unknown>;
        expect(Object.keys(result).sort()).toEqual([
          "audit",
          "auditPath",
          "caseId",
          "configId",
          "findings",
          "model",
          "outputLanguage",
          "rounds",
          "toolCalls",
          "usage",
        ]);
        expect(result.caseId).toBe("rpc-rename");
        expect((result.findings as { readonly id: string }[]).map((finding) => finding.id)).toEqual(["F001"]);
        expect(typeof result.auditPath).toBe("string");
      } finally {
        host.close();
        await stub.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

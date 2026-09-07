import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONFIGS } from "../../src/contracts/config.js";
import { DeepSeekClient } from "../../src/deepseek/deepseek-client.js";
import { validateFinding } from "../../src/finding/finding-schema.js";
import { runReview } from "../../src/run/run-review.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";

/**
 * 冒烟 e2e（Ticket 04）：单 MR（Ticket 01 手写样例）× config A × 真实 DeepSeek API。
 *
 * 运行条件：环境变量 DEEPSEEK_API_KEY 存在（key 只经环境变量注入，绝不回显/落盘）。
 * 无 key 时显式 SKIP——`pnpm test` 不依赖真实网络，本文件也不在常规测试 include 内。
 */

const rawEnvKey = process.env.DEEPSEEK_API_KEY;
const hasApiKey = typeof rawEnvKey === "string" && rawEnvKey.trim().length > 0;

if (!hasApiKey) {
  // 显式 SKIP 说明（不输出 key 内容）
  console.info(
    "[smoke-e2e] DEEPSEEK_API_KEY is not set: the real-API smoke e2e is SKIPPED. " +
      "Export DEEPSEEK_API_KEY and run `pnpm test:e2e` to execute it.",
  );
}

describe.skipIf(!hasApiKey)("smoke e2e: config A × sample MR × real DeepSeek API", () => {
  it(
    "completes a real review run with real usage accounting, an audit file and a schema-valid finding",
    async () => {
      const client = new DeepSeekClient(); // key 从环境变量读取；缺失会在构造时 fail fast
      const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, client, {
        auditDir: "runs/e2e-smoke",
      });

      // 端到端通路：runReview 正常收敛并产出合法 Finding（工单验收标准）
      expect(result.caseId).toBe(SAMPLE_MR_CASE.caseId);
      expect(result.configId).toBe("A");
      expect(result.findings.length).toBeGreaterThan(0);
      for (const finding of result.findings) {
        expect(validateFinding(finding), `finding ${finding.id} must be schema-valid`).toEqual([]);
      }

      // 真实 usage 记账：冷启动必有未命中输入；cache hit/miss 口径为 miss/hit 二分
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(typeof result.usage.cacheReadTokens).toBe("number");
      expect(result.usage).not.toHaveProperty("cacheWriteTokens");

      // 审计落盘：请求字节 + usage + findings 完整持久化
      expect(result.auditPath).toBeDefined();
      const auditFile = JSON.parse(await readFile(result.auditPath ?? "", "utf8")) as Record<string, unknown>;
      expect(auditFile.model).toBe("deepseek-v4-flash");
      expect(auditFile.usage).toEqual(result.usage);
      expect(auditFile.findings).toEqual(result.findings);
      expect(Array.isArray(auditFile.requests)).toBe(true);

      const promptTokens = result.usage.inputTokens + (result.usage.cacheReadTokens ?? 0);
      const cacheHitRate = promptTokens > 0 ? (result.usage.cacheReadTokens ?? 0) / promptTokens : 0;
      console.info(
        `[smoke-e2e] rounds=${result.rounds} requests=${result.audit.requests.length} ` +
          `findings=${result.findings.length} truncated=${result.audit.truncated} ` +
          `usage=${JSON.stringify(result.usage)} cacheHitRate=${cacheHitRate.toFixed(3)} ` +
          `audit=${result.auditPath}`,
      );
    },
  );
});

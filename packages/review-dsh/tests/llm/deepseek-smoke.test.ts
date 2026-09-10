/**
 * 真实 DeepSeek API 冒烟（#19 验收面）：env 门控——无 DEEPSEEK_API_KEY 整组跳过。
 *
 * 默认 CI 零网络：本组仅在显式提供 key 的本地/受控环境运行（凭据只经环境变量
 * 注入，不落代码与日志）。全链路 = 生产 DeepSeekLlmAdapter + config A profile
 * 真跑六阶段，验证「同 seam 互换 + wire 字节捕获 + usage 计量 + 审计成形」在
 * 真实响应形态下成立（单元测试的 fake fetch 覆盖不了服务端真实字节）。
 *
 * 断言口径：结构性断言（请求次数 / wire 字段 / 审计形状）锁死；模型产出内容
 * （findings 具体条目）不硬断言——真实模型输出天然非确定。
 */

import { describe, expect, it } from "vitest";

import { SYSTEM_PROMPT } from "../../../../src/loop/messages.js";
import { DeepSeekLlmAdapter } from "../../src/llm/deepseek-adapter.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import { mountAdapter } from "../helpers/mount-profile.js";

/** 冒烟输入：小体量 Java diff，内含一处资源泄漏（流未关闭）供检视发现 */
const SMOKE_INPUT: MrInput = {
  caseId: "SMOKE-1",
  issueDescription: "Add a file hashing utility",
  diff: [
    "--- a/src/main/java/HashUtil.java",
    "+++ b/src/main/java/HashUtil.java",
    "@@ -1,4 +1,15 @@",
    " import java.io.FileInputStream;",
    " import java.io.InputStream;",
    " import java.security.MessageDigest;",
    " ",
    "+public class HashUtil {",
    '+    public static String sha256(String path) throws Exception {',
    '+        MessageDigest digest = MessageDigest.getInstance("SHA-256");',
    "+        InputStream in = new FileInputStream(path);",
    "+        byte[] buffer = new byte[8192];",
    "+        int read;",
    "+        while ((read = in.read(buffer)) > 0) {",
    "+            digest.update(buffer, 0, read);",
    "+        }",
    "+        return bytesToHex(digest.digest());",
    "+    }",
    "+}",
  ].join("\n"),
};

/** 真跑预算：thinking 模式单 turn 可达分钟级（单 turn 上界 5 分钟 × 6） */
const TURN_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 900_000;

describe.skipIf(!process.env.DEEPSEEK_API_KEY)("DeepSeek 真实 API 冒烟（config A 全链路）", () => {
  it(
    "六阶段真跑：6 次请求、wire 字节全捕获、usage 计量、审计成形",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { ctx } = await mountAdapter(new DeepSeekLlmAdapter(), {
        policy: { turnTimeoutMs: TURN_TIMEOUT_MS },
      });

      const result = await ctx.reviewRuntime.run(SMOKE_INPUT);
      const audit = result.audit;

      // —— 请求序列：一阶段一 turn，6 次（config A 零工具）
      expect(audit.requests).toHaveLength(6);

      // —— wire 字节：逐条在场、JSON 可解析、ADR-0002 锁定字段线上成形
      for (const request of audit.requests) {
        expect(request.wireBody).toBeDefined();
        const wire = JSON.parse(request.wireBody ?? "") as {
          model: string;
          thinking: { type: string };
          reasoning_effort: string;
          stream: boolean;
          messages: { role: string; content: string }[];
        };
        expect(wire.model).toBe("deepseek-v4-flash");
        expect(wire.thinking).toEqual({ type: "enabled" });
        expect(wire.reasoning_effort).toBe("high");
        expect(wire.stream).toBe(false);
        expect(wire.messages[0]?.role).toBe("system");
      }

      // —— 请求 1 布局：wire messages[0] = Zone A 字节（complete system prompt）
      const firstWire = JSON.parse(audit.requests[0]?.wireBody ?? "") as {
        messages: { role: string; content: string }[];
      };
      expect(firstWire.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });

      // —— usage 计量：真模型必有消耗。cached 命中是网关侧环境行为（实测所用
      // 网关对同前缀重复请求回报 cached_tokens: 0），故只约束记账纪律：字段
      // 存在即必为正（mapUsage 命中为 0 时不臆造零值条目）；官方
      // prompt_cache_hit/miss_tokens 与网关 cached_tokens 两形态的拆分记账
      // 由 response.test 单测锁定
      expect(audit.usage.inputTokens).toBeGreaterThan(0);
      expect(audit.usage.outputTokens).toBeGreaterThan(0);
      if (audit.usage.cacheReadTokens !== undefined) {
        expect(audit.usage.cacheReadTokens).toBeGreaterThan(0);
      }

      // —— 审计结构：config A 形状
      expect(audit.configId).toBe("A");
      expect(audit.model).toBe("deepseek-v4-flash");
      expect(audit.effort).toBe("default");
      expect(audit.rounds).toBe(1);
      expect(audit.toolCalls).toBe(0);
      expect(audit.phaseLog).toHaveLength(6);
      expect(audit.runId).toMatch(/-A-SMOKE-1$/);

      // —— 产出：spec 要求「产出 Finding」——输入内嵌的流未关闭资源泄漏
      //（P1 级、证据直白）是模型可靠发现的缺陷；条目内容不锁定（非确定）
      expect(result.findings.length).toBeGreaterThan(0);
      expect(Array.isArray(audit.rejections)).toBe(true);
    },
  );
});

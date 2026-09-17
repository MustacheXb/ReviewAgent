import { describe, expect, it } from "vitest";

import { resolveOutputLanguage, type OutputLanguage } from "../../src/contracts/output-language.js";
import {
  buildInitialMessages,
  buildSystemMessage,
  SYSTEM_PROMPT,
} from "../../src/loop/messages.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";

/**
 * #53 Zone A 分序列渲染（spec #49 实现决策 3 / ADR-0010）：提示词主体英文
 * 不动，仅 Output language 节按语言渲染——每语言一条冻结字节序列（前缀缓存
 * 按请求头部字节精确匹配，序列内字节恒定）。
 *
 * 锁线：en 序列与分序列改造前逐字节相同（en 是既有实验结论的锚定形态，
 * 回归锁）；zh 为新增冻结序列，与 en 的差异恰好是 Output language 一节
 * （差异面最小——zh 验证结果的差异只能归因于语言切换本身）；缺省 = en；
 * 非法值 fail fast（人话错误）。语言节期望为手写冻结字面量（独立于实现
 * 的真值源，防恒真式）。
 */

/** 手写冻结期望：en 语言节（= 现状字节，分序列改造不得漂移） */
const EN_OUTPUT_LANGUAGE_SECTION = [
  "## Output language",
  "All review output must be in English. Findings containing non-English text are rejected.",
].join("\n");

/** 手写冻结期望：zh 语言节（#53 定稿新增；措辞冻结，改动须重新冻结并重验证） */
const ZH_OUTPUT_LANGUAGE_SECTION = [
  "## Output language",
  "Findings must be in Chinese: write the title, the description, and the natural-language parts of evidence entries in Chinese. Keep code excerpts, file paths, identifiers, and enum values exactly as written; never translate them. A finding is rejected when neither its title nor its description contains Chinese text.",
].join("\n");

describe("Zone A 分序列渲染（#53）", () => {
  it("en 冻结序列：缺省与显式 en 等价，逐字节含手写 en 语言节（回归锁）", () => {
    const en = buildSystemMessage("en").content;
    expect(buildSystemMessage().content).toBe(en);
    expect(en).toBe(SYSTEM_PROMPT);
    expect(en).toContain(EN_OUTPUT_LANGUAGE_SECTION);
  });

  it("zh 冻结序列：含手写 zh 语言节；与 en 的差异恰好是 Output language 一节", () => {
    const en = buildSystemMessage("en").content;
    const zh = buildSystemMessage("zh").content;
    expect(zh).toContain(ZH_OUTPUT_LANGUAGE_SECTION);
    // 差异面最小（用户故事 16）：节互换即互还原（两节均已断言在场，
    // replace 恰好换掉该节，等式证明其余字节逐字节相同）
    expect(zh.replace(ZH_OUTPUT_LANGUAGE_SECTION, EN_OUTPUT_LANGUAGE_SECTION)).toBe(en);
    expect(en.replace(EN_OUTPUT_LANGUAGE_SECTION, ZH_OUTPUT_LANGUAGE_SECTION)).toBe(zh);
    // zh ≠ en（防两节相同导致互换断言恒真）
    expect(zh).not.toBe(en);
  });

  it("非法语言值 fail fast：人话错误（含实际值）", () => {
    expect(() => buildSystemMessage("fr" as OutputLanguage)).toThrow(
      'outputLanguage must be "en" or "zh" (got "fr")',
    );
    expect(() => buildSystemMessage(null as unknown as OutputLanguage)).toThrow(
      'outputLanguage must be "en" or "zh" (got null)',
    );
  });

  it("resolveOutputLanguage：缺省 en / 合法透传 / 非法拒绝（配置入口共用校验）", () => {
    expect(resolveOutputLanguage(undefined)).toBe("en");
    expect(resolveOutputLanguage("en")).toBe("en");
    expect(resolveOutputLanguage("zh")).toBe("zh");
    expect(() => resolveOutputLanguage("ja")).toThrow(
      'outputLanguage must be "en" or "zh" (got "ja")',
    );
  });

  it("buildInitialMessages 语言下传：首消息按语言渲染，其余消息不随语言变", () => {
    const en = buildInitialMessages(SAMPLE_MR_CASE);
    const zh = buildInitialMessages(SAMPLE_MR_CASE, {}, "zh");
    expect(en[0]).toEqual(buildSystemMessage("en"));
    expect(zh[0]).toEqual(buildSystemMessage("zh"));
    // Zone C 起点（初始 user 消息）不随语言变化
    expect(zh.slice(1)).toEqual(en.slice(1));
  });
});

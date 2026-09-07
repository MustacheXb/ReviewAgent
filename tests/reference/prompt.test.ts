import { describe, expect, it } from "vitest";
import { buildClaudeCodePrompt, CLAUDE_CODE_PROMPT_TEMPLATE_VERSION } from "../../src/reference/prompt.js";
import { referenceCleanCase, referenceMainCase } from "./helpers.js";

/**
 * Claude Code 外部参照提示词（Ticket 13）：与主 harness Zone A 同目标纪律——
 * 检视输入（caseId / issue 描述 / diff）与 Finding Schema / Severity 逐字对齐；
 * 差异仅 agent 形态说明与单条 JSON 输出纪律。确定性：同 case 同字节。
 */

describe("buildClaudeCodePrompt", () => {
  it("确定性：同 case 两次构造字节一致", () => {
    const case_ = referenceMainCase("prompt-det-001");
    expect(buildClaudeCodePrompt(case_)).toBe(buildClaudeCodePrompt(case_));
  });

  it("携带检视输入三要素：caseId、issue 描述、unified diff", () => {
    const prompt = buildClaudeCodePrompt(referenceMainCase("prompt-input-001"));
    expect(prompt).toContain("Case ID: prompt-input-001");
    expect(prompt).toContain("ArrayIndexOutOfBoundsException");
    expect(prompt).toContain("for (int i = 0; i <= count; i++) {");
    expect(prompt).toContain("```diff");
  });

  it("issue 描述为空时以占位符留痕（clean MR）", () => {
    const prompt = buildClaudeCodePrompt(referenceCleanCase("prompt-clean-001"));
    expect(prompt).toContain("Case ID: prompt-clean-001");
    expect(prompt).toContain("(none)");
  });

  it("Finding Schema 字段与 Severity 定义与主 harness 对齐", () => {
    const prompt = buildClaudeCodePrompt(referenceMainCase("prompt-schema-001"));
    for (const field of ["id", "severity", "category", "file", "line", "title", "description", "evidence", "rule", "confidence"]) {
      expect(prompt).toContain(`- ${field}:`);
    }
    for (const severity of ["P0", "P1", "P2", "P3"]) {
      expect(prompt).toContain(`- ${severity}:`);
    }
  });

  it("输出纪律：单条 {\"findings\": [...]}，空检出示空数组", () => {
    const prompt = buildClaudeCodePrompt(referenceMainCase("prompt-discipline-001"));
    expect(prompt).toContain('{"findings": [ { ...finding objects following the schema above... } ]}');
    expect(prompt).toContain('{"findings": []}');
    expect(prompt).toContain("All output must be in English.");
  });

  it("声明工作目录即仓库快照（agent 形态说明）", () => {
    const prompt = buildClaudeCodePrompt(referenceMainCase("prompt-cwd-001"));
    expect(prompt).toContain(
      "The current working directory is the repository snapshot at the MR base state.",
    );
  });

  it("模板版本常量非空且随计划留档（续跑兼容守卫）", () => {
    expect(CLAUDE_CODE_PROMPT_TEMPLATE_VERSION.length).toBeGreaterThan(0);
  });
});

/**
 * Finding 契约（spec #1 Finding JSON Schema）。
 * 只有通过 Evidence Gate（"No Evidence, No Finding"）的候选才允许产出。
 */

export interface Finding {
  readonly id: string;
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly category: string;
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly description: string;
  /** 支撑本条结论的可验证材料：具体符号、行号与代码摘录 */
  readonly evidence: readonly string[];
  readonly rule: string;
  readonly confidence: number;
}

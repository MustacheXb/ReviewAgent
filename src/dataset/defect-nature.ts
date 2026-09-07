/**
 * 缺陷性质词表（TruthLocation.defectNature）。
 *
 * 与 Finding.category 对齐：本词表是 T02 定义的首个权威词表（全大写 token，
 * 与设计文档 Finding 示例的 "RESOURCE" 风格一致），T01/T03 的 Finding.category
 * 与判定链（规则粗筛、LLM-as-judge）应复用同一词表，保证真值-结论可比。
 */
export const DEFECT_NATURES = [
  "CORRECTNESS",
  "NULL_SAFETY",
  "BOUNDARY",
  "EXCEPTION",
  "CONCURRENCY",
  "RESOURCE",
  "PERFORMANCE",
  "SECURITY",
  "API_MISUSE",
  "TYPE_SAFETY",
  "OTHER",
] as const;

export type DefectNature = (typeof DEFECT_NATURES)[number];

export const DEFAULT_DEFECT_NATURE: DefectNature = "CORRECTNESS";

/** Defects4J 的 bug 均由失败测试触发定义（功能性缺陷），未提供性质标签时缺省 CORRECTNESS */
export function isDefectNature(value: string): value is DefectNature {
  return (DEFECT_NATURES as readonly string[]).includes(value);
}

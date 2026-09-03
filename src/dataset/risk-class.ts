/**
 * 风险分级（与 MRCase.labels.riskClass 的字面量联合一致；
 * 契约文件由 T01 拥有，此处仅提取类型别名供数据集侧复用）。
 */
export type RiskClass = "Low" | "Medium" | "High";

export const DEFAULT_RISK_CLASS: RiskClass = "Medium";

export function isRiskClass(value: string): value is RiskClass {
  return value === "Low" || value === "Medium" || value === "High";
}

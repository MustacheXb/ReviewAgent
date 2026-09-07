/**
 * Defects4J 17 项目清单与 active bug 总数（分层抽样的总体参数）。
 *
 * 数据已按 Defects4J v3.0.1（tag 2024-11-27）逐项核实：17 项目 active bugs
 * 合计 854 + 10 deprecated（源码级核验记录见
 * D:\xubao\code\AI4SE\.spec-notes\defects4j-export.md 第 5 节）。
 *
 * 注意：active bug 的 ID 集合**不保证连续**（v3 存在弃用空洞，如 Lang #18/#25/#48、
 * JacksonDatabind #65/#89 弃用、Collections 1-24 重新激活）。分层抽样清单默认按
 * [1..bugCount] 连续假设抽取，Ticket 12 应以
 * `framework/projects/<PID>/active-bugs.csv` 的实际 ID 集为准，通过
 * buildSamplingManifest 的 activeBugIds 参数重生成清单。
 */
export interface Defects4jProjectInfo {
  /** Defects4J 项目 key（如 "Lang"，即 defects4j -p 参数） */
  readonly key: string;
  /** 该项目 active bug 总数（v3.0.1，已核实） */
  readonly bugCount: number;
}

export const DEFECTS4J_PROJECTS: readonly Defects4jProjectInfo[] = Object.freeze([
  { key: "Chart", bugCount: 26 },
  { key: "Cli", bugCount: 39 },
  { key: "Closure", bugCount: 174 },
  { key: "Codec", bugCount: 18 },
  { key: "Collections", bugCount: 28 },
  { key: "Compress", bugCount: 47 },
  { key: "Csv", bugCount: 16 },
  { key: "Gson", bugCount: 18 },
  { key: "JacksonCore", bugCount: 26 },
  { key: "JacksonDatabind", bugCount: 110 },
  { key: "JacksonXml", bugCount: 6 },
  { key: "Jsoup", bugCount: 93 },
  { key: "JxPath", bugCount: 22 },
  { key: "Lang", bugCount: 61 },
  { key: "Math", bugCount: 106 },
  { key: "Mockito", bugCount: 38 },
  { key: "Time", bugCount: 26 },
]);

export function totalDefects4jBugs(projects: readonly Defects4jProjectInfo[] = DEFECTS4J_PROJECTS): number {
  return projects.reduce((sum, p) => sum + p.bugCount, 0);
}

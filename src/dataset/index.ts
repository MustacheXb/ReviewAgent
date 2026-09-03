/**
 * 数据集构造模块对外入口。
 *
 * Ticket 02（逆补丁法基座）：
 * - defectRecord 输入 schema 与校验：defect-record.ts
 * - 逆补丁转换核心（数据源无关）：inverse-patch.ts
 * - 逆 diff 引擎：diff/（parse / reverse / apply / serialize）
 * - 真值构造：truth.ts + defect-nature.ts（词表）
 * - MR 边界过滤：mr-boundary-filter.ts
 * - Defects4J 适配层与分层抽样：defects4j/
 *
 * Ticket 08（缺陷引入数据接入）：
 * - Vul4J 适配层（CVE/CWE → defectNature、riskClass=High）：vul4j/
 * - Multi-SWE-bench Java 适配层（真实 PR 形态，只跑 C/E）：msb-java/
 * - 确定性抽样通用工具（三源共用）：sampling.ts
 */
export * from "./defect-record.js";
export * from "./defect-nature.js";
export * from "./inverse-patch.js";
export * from "./mr-boundary-filter.js";
export * from "./risk-class.js";
export * from "./sampling.js";
export * from "./truth.js";
export * from "./verify-inverse.js";
export * from "./diff/apply-unified-diff.js";
export * from "./diff/parse-unified-diff.js";
export * from "./diff/reverse-unified-diff.js";
export * from "./diff/serialize-unified-diff.js";
export * from "./diff/types.js";
export * from "./defects4j/adapter.js";
export * from "./defects4j/projects.js";
export * from "./defects4j/sampling.js";
export * from "./vul4j/adapter.js";
export * from "./vul4j/csv.js";
export * from "./vul4j/cwe-nature-map.js";
export * from "./vul4j/sampling.js";
export * from "./msb-java/adapter.js";
export * from "./msb-java/sampling.js";

/**
 * 数据集构造模块（Ticket 02）对外入口。
 *
 * 供 T08/T09（Vul4J、Multi-SWE-bench、clean MR）复用的接口：
 * - defectRecord 输入 schema 与校验：defect-record.ts
 * - 逆补丁转换核心（数据源无关）：inverse-patch.ts
 * - 逆 diff 引擎：diff/（parse / reverse / apply / serialize）
 * - 真值构造：truth.ts + defect-nature.ts（词表）
 * - MR 边界过滤：mr-boundary-filter.ts
 * - Defects4J 适配层与分层抽样：defects4j/
 * - clean MR 阴性对照（T09）：clean-mr/（GitHub PR 模型 / 挖掘规则 / MRCase 构造 /
 *   确定性选取 / 清单；采集脚本见 scripts/collect-clean-mrs.ts，测试零网络）
 */
export * from "./defect-record.js";
export * from "./defect-nature.js";
export * from "./inverse-patch.js";
export * from "./mr-boundary-filter.js";
export * from "./risk-class.js";
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
export * from "./clean-mr/repos.js";
export * from "./clean-mr/pr-records.js";
export * from "./clean-mr/mining-rules.js";
export * from "./clean-mr/builder.js";
export * from "./clean-mr/selection.js";
export * from "./clean-mr/manifest.js";

/**
 * MCR-Bench 校准模块（Ticket 11 / issue #12；spec #1 user story 24）。
 *
 * 用法（真实数据运行时，见 tests/e2e/mcr-bench-calibration.e2e.ts）：
 * - 读 MCR-bench 仓库三侧文件：
 *   dataset/java.jsonl（默认 round1 子集）、
 *   generated_results/<model>/java/java_responses.jsonl、
 *   evaluation/Metric/LLM_responses/<model>/java/java_evaluation_results.jsonl；
 * - buildCalibrationSamples 组装「7 模型输出 × 官方判定」校准样例；
 * - runCalibration(samples, new GptJudgeClient(...)) → CalibrationReport
 *   （kappa / 原始一致率 / 命中对集合完全一致率 / 分模型聚合 / 有界错误留痕）。
 *
 * 单元测试全部使用小 fixture + FakeJudgeClient（零网络）。
 */

export * from "./mcr-bench.js";
export * from "./agreement.js";
export * from "./run.js";

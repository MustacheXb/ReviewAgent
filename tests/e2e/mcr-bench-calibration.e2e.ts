import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCalibrationSamples,
  parseMcrDataset,
  parseMcrModelOutputs,
  parseMcrOfficialJudgments,
  runCalibration,
} from "../../src/calibration/index.js";
import { GptJudgeClient, OPENAI_API_KEY_ENV_VAR } from "../../src/judge/gpt-judge-client.js";

/**
 * MCR-Bench 校准 e2e（Ticket 11 / spec user story 24）：
 * 「7 模型输出 × 官方判定」→ 我们的 GPT judge 复核 → 一致性报告（kappa / 一致率）。
 *
 * 运行条件（两者缺一即显式 SKIP；`pnpm test` 零网络）：
 * - OPENAI_API_KEY：真实 judge API key（只经环境变量注入）
 * - MCR_BENCH_ROOT：本地 MCR-bench 仓库路径（git clone DeepSoftwareAnalytics/MCR-bench）
 *
 * 可选环境变量：
 * - MCR_BENCH_MODELS：逗号分隔的被评模型列表（默认 gpt-5.2；7 模型全量见研究笔记）
 * - MCR_BENCH_MAX_TASKS：每模型校准任务上限（默认 20；真实数据属运行时，测试默认有界）
 *
 * 报告落盘 runs/calibration/（JSON）。
 */

const rawEnvKey = process.env[OPENAI_API_KEY_ENV_VAR];
const hasApiKey = typeof rawEnvKey === "string" && rawEnvKey.trim().length > 0;
const mcrRoot = process.env.MCR_BENCH_ROOT?.trim() ?? "";
const hasMcrRoot = mcrRoot.length > 0;

const MCR_MODELS = (process.env.MCR_BENCH_MODELS?.trim() ?? "gpt-5.2")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model.length > 0);
const MAX_TASKS = Number.parseInt(process.env.MCR_BENCH_MAX_TASKS ?? "20", 10);

if (!hasApiKey || !hasMcrRoot) {
  console.info(
    "[mcr-calibration-e2e] Missing " +
      `${hasApiKey ? "" : "OPENAI_API_KEY "}${!hasApiKey && !hasMcrRoot ? "and " : ""}` +
      `${hasMcrRoot ? "" : "MCR_BENCH_ROOT "}` +
      "— the MCR-Bench calibration e2e is SKIPPED. " +
      "Export both (clone DeepSoftwareAnalytics/MCR-bench, point MCR_BENCH_ROOT at the repo) " +
      "and run `pnpm test:e2e` to execute it.",
  );
}

const runnable = hasApiKey && hasMcrRoot;

describe.skipIf(!runnable)("MCR-Bench calibration e2e: our GPT judge vs official judgments", () => {
  it(
    "produces an agreement report over the round1 java subset",
    async () => {
      const judge = new GptJudgeClient();
      const reports: Record<string, unknown>[] = [];
      const datasetText = await readMcrFile(
        ["dataset", "java.jsonl"],
        "dataset/java.jsonl (clone MCR-bench, set MCR_BENCH_ROOT)",
      );
      const tasks = parseMcrDataset(datasetText);
      for (const modelName of MCR_MODELS) {
        const outputsText = await readMcrFile(
          ["generated_results", modelName, "java", "java_responses.jsonl"],
          `generated_results/${modelName}/java/java_responses.jsonl`,
        );
        const judgmentsText = await readMcrFile(
          ["evaluation", "Metric", "LLM_responses", modelName, "java", "java_evaluation_results.jsonl"],
          `evaluation/Metric/LLM_responses/${modelName}/java/java_evaluation_results.jsonl`,
        );

        const outputs = parseMcrModelOutputs(outputsText);
        const judgments = parseMcrOfficialJudgments(judgmentsText);
        const { samples, skippedTasks } = buildCalibrationSamples({
          modelName,
          tasks: tasks.records,
          outputs: outputs.records,
          judgments: judgments.records,
        });
        if (samples.length === 0) {
          throw new Error(
            `no calibration samples assembled for model ${modelName} ` +
              `(tasks=${tasks.records.length}, outputs=${outputs.records.length}, ` +
              `judgments=${judgments.records.length}, skipped=${skippedTasks})`,
          );
        }
        // 有界成本：默认每模型前 20 个任务（真实全量校准属运行时脚本，非测试）
        const bounded = samples.slice(0, Number.isInteger(MAX_TASKS) && MAX_TASKS > 0 ? MAX_TASKS : samples.length);
        const report = await runCalibration(bounded, judge);

        // 报告完整性：样本计数守恒、错误有界、分模型聚合在场
        expect(report.sampleCount).toBe(bounded.length);
        expect(report.comparedCount + report.errorCount).toBe(bounded.length);
        expect(report.perModel).toHaveLength(1);
        expect(report.perModel[0]?.modelName).toBe(modelName);

        console.info(
          `[mcr-calibration-e2e] model=${modelName} samples=${report.sampleCount} ` +
            `compared=${report.comparedCount} errors=${report.errorCount} ` +
            `agreementRate=${report.agreementRate ?? "n/a"} kappa=${report.kappa ?? "n/a"} ` +
            `exactPairMatch=${report.exactPairMatchCount}/${report.comparedCount}`,
        );
        reports.push({
          modelName,
          dataset: {
            round1Tasks: tasks.records.length,
            roundFiltered: tasks.roundFilteredLines,
            skippedLines: tasks.skippedLines,
            skippedTasks,
          },
          calibration: report,
        });
      }

      // 落盘：runs/calibration/（供人工检视与后续趋势对比）
      const outDir = path.resolve("runs", "calibration");
      await mkdir(outDir, { recursive: true });
      const outFile = path.join(outDir, `mcr-bench-java-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      await writeFile(outFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), models: reports }, null, 2)}\n`, "utf8");
      console.info(`[mcr-calibration-e2e] report written to ${outFile}`);
    },
    600_000,
  );
});

async function readMcrFile(relative: readonly string[], what: string): Promise<string> {
  const filePath = path.join(mcrRoot, ...relative);
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${what} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

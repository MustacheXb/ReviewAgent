import { defineConfig } from "vitest/config";

export default defineConfig({
  // review-llm（workspace 内部包）按 "source" 条件解析到 TS 源而非 dist 产物，
  // 保证测试始终跑当前源码（exports: types/source 指向 src，default 指向 dist 供编译路径运行时用）
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // 产品代码覆盖率（src/）：scripts/ 为进程入口壳（experiment / reference /
      // 数据准备），由 e2e 与手工流程触达，不计入常规门
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      // 零网络常规门的最低覆盖线（全局；当前基线 86.9% lines）
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});

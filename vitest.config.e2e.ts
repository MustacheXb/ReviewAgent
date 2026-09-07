import { defineConfig } from "vitest/config";

/**
 * 冒烟 e2e 专用配置：真实 DeepSeek API、单 MR × config A。
 * 不进常规测试（pnpm test 的 include 是 *.test.ts）；经 `pnpm test:e2e` 显式运行，
 * 且仅在环境变量 DEEPSEEK_API_KEY 存在时真正执行（否则显式 SKIP）。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    // thinking 模式长思考 + 有界重试：单用例给足 30 分钟
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
  },
});

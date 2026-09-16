import { defineConfig } from "vitest/config";

export default defineConfig({
  // review-llm（workspace 内部包）按 "source" 条件解析到 TS 源而非 dist 产物
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // 纪律门自检（tests/gate/**）只在 gate 配置下有意义：它断言的是门环境
    // 的不变量（出站被 no-network-setup 拦截），常规套件无拦截、必然红
    exclude: ["tests/gate/**", "node_modules/**"],
  },
});

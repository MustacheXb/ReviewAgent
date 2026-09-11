import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // 纪律门自检（tests/gate/**）只在 gate 配置下有意义：它断言的是门环境
    // 的不变量（出站被 no-network-setup 拦截），常规套件无拦截、必然红
    exclude: ["tests/gate/**", "node_modules/**"],
  },
});

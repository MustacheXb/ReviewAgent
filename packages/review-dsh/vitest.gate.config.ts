import { defineConfig } from "vitest/config";

/**
 * #28 确定性纪律门（具名 CI 套件）：Ticket 1–8 迁移验收断言的收口。
 *
 * 入选件全部 fake LLM（进程内适配器替身）、零 HTTP——与产品面烟测
 * （cli-smoke / kernel-host 的 127.0.0.1 stub）分轴；运行经
 * `pnpm --filter review-dsh gate:discipline`（CI 具名 job）。
 *
 * 五族断言 → 入选文件的映射：
 * - Zone A 字节稳定        → loop/zone-a-stability + loop/zone-a-parity
 *                            + presets/review-presets（每配置字节确定，覆盖 A–E）
 * - 无变更零 Cache Break    → loop/cache-discipline
 * - 审计可重放              → audit/audit-export（#24 重放轴）
 * - 六阶段骨架 + 两上界     → loop/walking-skeleton（阶段轨迹）
 *                            + loop/evidence-gate（MAX_ROUNDS：rounds=5、30 请求）
 *                            + context/kernel-tools（max_tool_calls：第 7 次拒绝留痕）
 * - Evidence Gate 生效      → loop/evidence-gate（三态 + 跨轮去重）
 * - 五配置全覆盖            → presets/review-presets（A–E 全跑通）
 *
 * 全部断言从主缝观测（fake 适配器捕获的请求字节 / 导出审计与结果对象
 * （Finding、phaseLog）），不窥探内核内部状态。零网络强制由 setupFiles 的
 * 出站拦截 + net-guard 自检测试共同兑现（断网即拦截，任何意外出站都会
 * 让门变红）。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/gate/net-guard.test.ts",
      "tests/loop/walking-skeleton.test.ts",
      "tests/loop/zone-a-stability.test.ts",
      "tests/loop/zone-a-parity.test.ts",
      "tests/loop/cache-discipline.test.ts",
      "tests/loop/evidence-gate.test.ts",
      "tests/context/kernel-tools.test.ts",
      "tests/audit/audit-export.test.ts",
      "tests/presets/review-presets.test.ts",
    ],
    setupFiles: ["./tests/gate/no-network-setup.ts"],
  },
});

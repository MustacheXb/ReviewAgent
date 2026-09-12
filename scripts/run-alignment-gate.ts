/**
 * 指标对齐门 v2 CLI 入口（#31）。
 *
 * 运行（仓库内，无需额外依赖；纯离线，零网关消耗）：
 *   pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
 *     --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck \
 *     --outDir .tmp-gen scripts/run-alignment-gate.ts
 *   node .tmp-gen/scripts/run-alignment-gate.js --baseline <dir> --candidate <dir> [--noise <dir>]
 *
 * 或经 package.json 脚本（参数经 `pnpm alignment-gate -- <args>` 透传）。
 * 退出码：PASS/INCONCLUSIVE → 0；FAIL → 1；用法/加载错误 → 2。
 */
import { main } from "../src/experiment/alignment-gate-cli.js";

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);

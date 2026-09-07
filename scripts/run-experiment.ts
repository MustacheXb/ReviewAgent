/**
 * 实验运行器入口（Ticket 12 / issue #13）——「一条命令跑全量矩阵」。
 *
 * 运行（仓库内，无需额外依赖；产物落 runs/<experimentId>/，已被 gitignore）：
 *   pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
 *     --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck \
 *     --outDir .tmp-gen scripts/run-experiment.ts
 *   node .tmp-gen/scripts/run-experiment.js --id <id> ...
 *
 * 或经 package.json 脚本（自动编译后执行，参数经 `pnpm experiment -- <args>` 透传）：
 *   pnpm experiment -- --id smoke --cases-file dataset.json --configs A --reps 2
 *
 * key 只经环境变量注入（DEEPSEEK_API_KEY 恒需；--judge 另需 OPENAI_API_KEY）；
 * 缺失时启动即报错并给清单，绝不回显 key 值。
 */
import { main } from "../src/experiment/cli.js";

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);

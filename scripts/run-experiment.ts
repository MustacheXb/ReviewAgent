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
 * key 只经环境变量注入（REVIEWER_API_KEY 恒需，旧名 DEEPSEEK_API_KEY 兼容；
 * --judge 另需 JUDGE_API_KEY 或旧名 OPENAI_API_KEY）；本机注入首选仓库根
 * .env.local（已被 gitignore，启动时自动装载；已存在的环境变量优先不覆盖）。
 * 接入点可经 REVIEWER_URL / JUDGE_URL（旧名 DEEPSEEK_URL / OPENAI_URL 兼容）
 * 环境变量覆盖（自定义 OpenAI 兼容网关，尾斜杠自动归一，接入点进 plan.json
 * 留痕、key 绝不落盘）；被测模型经 --model <id> 自由指定（flash/pro 别名保留，
 * wire 序列化与指标口径按 provider 画像表分派）；judge 与被测可能同源时默认
 * 拒绝——任一侧自定义接入点设定则降级为 warning 放行（异构性转为实验者责任）。
 * 缺失时启动即报错并给清单，绝不回显 key 值。
 */
import { main } from "../src/experiment/cli.js";

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);

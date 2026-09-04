/**
 * 外部参照运行器入口（Ticket 13 / issue #14）——「一条命令跑 Claude Code 单列参照」。
 *
 * 运行（仓库内，无需额外依赖；产物落 runs/claude-code/<referenceId>/，已被 gitignore）：
 *   pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
 *     --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck \
 *     --outDir .tmp-gen scripts/run-claude-code-reference.ts
 *   node .tmp-gen/scripts/run-claude-code-reference.js --id <id> ...
 *
 * 或经 package.json 脚本（自动编译后执行，参数经 `pnpm reference -- <args>` 透传）：
 *   pnpm reference -- --id ref-claude-001 --cases-file dataset.json --clean-mr
 *
 * 认证沿用 claude CLI 自身配置（本 harness 不经手任何凭据，无环境变量要求）；
 * 提示词 / 模型 / 轮数 / CLI 版本全量留档（raw/<source>/<caseId>/rep-<rep>.json）。
 * 外部参照单列报告：不进 S/A/B 主判定（报告与 Dashboard 双处显式标注）。
 */
import { main } from "../src/reference/cli.js";

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);

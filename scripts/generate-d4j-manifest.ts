/**
 * 生成 Defects4J 分层抽样目标清单（Ticket 02 交付物；实跑在 Ticket 12）。
 *
 * 运行（仓库内，无需额外依赖）：
 *   pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
 *     --strict --skipLibCheck --outDir .tmp-gen scripts/generate-d4j-manifest.ts
 *   node .tmp-gen/scripts/generate-d4j-manifest.js && rm -rf .tmp-gen
 *
 * 产出：data/defects4j/sampling-manifest.json（确定性：同 seed 同清单）
 *
 * 注意：清单基于 projects.ts 中「待验证」的 bug 总数；Ticket 12 以
 * `defects4j query` 实际 ID 集为准刷新 projects.ts 后重跑本脚本即可。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildSamplingManifest } from "../src/dataset/defects4j/sampling.js";

/** 输出路径默认相对仓库根（即运行目录），可用 argv[2] 覆盖 */
const outputPath = resolve(process.argv[2] ?? "data/defects4j/sampling-manifest.json");

const manifest = buildSamplingManifest();
const json = JSON.stringify(manifest, null, 2) + "\n";

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, json, "utf8");

console.log(`written: ${outputPath}`);
console.log(`total sampled: ${manifest.total} (target ${manifest.targetTotal}, seed ${manifest.seed})`);

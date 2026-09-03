import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCleanMrManifest, cleanMrCasesFromManifest } from "../src/dataset/clean-mr/manifest.js";
import { isNegativeControl } from "../src/dataset/clean-mr/builder.js";
import { filterMrCases } from "../src/dataset/mr-boundary-filter.js";

const raw = JSON.parse(readFileSync("data/clean-mr/manifest.json", "utf8"));
const validated = validateCleanMrManifest(raw);
if (!validated.ok) {
  throw new Error(`validate 失败: ${validated.error.message}`);
}
console.log(`manifest 校验通过: ${validated.value.total} 条`);

const loaded = cleanMrCasesFromManifest(validated.value, {
  diffOf: (c) => readFileSync(resolve("data/clean-mr", c.diffFile), "utf8"),
  repoPathOf: (c) => `D:/repos/${c.repo}/checkout/${c.baseSha.slice(0, 10)}`,
});
if (!loaded.ok) {
  throw new Error(`加载失败: ${loaded.error.message}`);
}
console.log(`MRCase 构造: ${loaded.value.cases.length} 条, 失败: ${loaded.value.failures.length}`);
if (loaded.value.failures.length > 0) {
  throw new Error(`存在失败: ${JSON.stringify(loaded.value.failures)}`);
}

for (const c of loaded.value.cases) {
  if (c.truth !== null) {
    throw new Error(`${c.caseId} truth 非 null`);
  }
  if (!isNegativeControl(c)) {
    throw new Error(`${c.caseId} 非阴性对照`);
  }
  if (c.labels.source !== "clean-mr") {
    throw new Error(`${c.caseId} source 错误`);
  }
  if (!c.labels.allowedConfigs.includes("A") || !c.labels.allowedConfigs.includes("C")) {
    throw new Error(`${c.caseId} 缺 A/C 配置`);
  }
  if (c.issueDescription !== "") {
    throw new Error(`${c.caseId} issueDescription 非空`);
  }
}
const { accepted, report } = filterMrCases(loaded.value.cases);
console.log(`边界过滤复检: accepted ${accepted.length} / ${report.total}, rejected ${report.rejectedCount}`);
if (accepted.length !== 50) {
  throw new Error(`边界过滤后有淘汰: ${JSON.stringify(report.rejected)}`);
}
console.log("全部 50 条：truth=null、source=clean-mr、A/C 可跑、边界通过 ✓");

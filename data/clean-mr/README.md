# clean MR 阴性对照集（Ticket 09 / issue #10）

50 条 merged、无 issue 关联且未被 revert 的真实 GitHub PR，构造**无真值阴性对照**，
专测 False Positive（config A vs C：主动检索是否推高无中生有率）。
候选仓库与 Multi-SWE-bench Java 子集相同的 9 仓。

## 入库内容

| 文件 | 说明 |
|---|---|
| `manifest.json` | 数据集清单：全部 50 条的元数据（baseSha / mergeCommitSha / 边界指标 / diff sha256）、显式挖掘规则文本、FP 口径与 A vs C 对比声明 |
| `diffs/<caseId>.diff` | 每条 case 的 PR unified diff（检视对象本体） |

## 不入库（.gitignore 覆盖）

- `data/clean-mr/.cache/`：采集期 GitHub API 原始快照（分页 PR 列表 JSON、各候选 PR 的
  commits JSON 与 diff，约 33MB）。仅作断点续采缓存，非交付物。
- `.tmp-gen/`：采集/校验脚本的 tsc 编译输出目录。

## 重新采集（可重放）

需要 `gh` CLI 已认证（GitHub API 有界调用，预算 1500 次）：

```bash
pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck \
  --outDir .tmp-gen scripts/collect-clean-mrs.ts
node .tmp-gen/scripts/collect-clean-mrs.js && rm -rf .tmp-gen
```

- 断点续采：已抓取页/commits/diff 落 `.cache/`，重跑只补缺口；删除 `.cache/` 可全新快照。
- 单仓重采：`node .tmp-gen/scripts/collect-clean-mrs.js elastic/logstash`。
- 规则、配额（每仓 6 条 + 补位 4 条，全局目标 50）均显式落盘于 `manifest.json`
  的 `rules` / `target` 块，选取为确定性纯函数——同输入必得同输出。

## 校验

```bash
# 独立校验脚本（清单结构 / truth=null / 边界过滤 / A+C 可跑）
pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck \
  --outDir .tmp-gen scripts/verify-clean-mr-dataset.ts
node .tmp-gen/scripts/verify-clean-mr-dataset.js && rm -rf .tmp-gen

# 离线回归测试（零网络，读本目录交付物）
pnpm test -- tests/clean-mr/dataset.test.ts
```

## 消费方式（T12 实验运行器）

`cleanMrCasesFromManifest(manifest, deps)`（`src/dataset/clean-mr/manifest.ts`）：
注入 `diffOf`（读 diff 文本）与 `repoPathOf`（按 `baseSha` checkout 的本地克隆路径），
逐条构造 `MRCase`；diff 与清单 sha256 默认强校验（数据损坏显式失败），失败项显式收集。
FP 口径：`truth === null`（`isNegativeControl`），该 case 上每条 Finding 计 1 FP，
无 Recall / Precision 分母——衔接 T10 判定链的 truth=null 约定。

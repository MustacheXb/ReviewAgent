# DSH 内核真实网关冒烟 r3（指标对齐门 #29 前置）

- **实验 ID**: `dsh-gateway-smoke-r3`
- **日期**: 2026-09-11
- **规模**: 单单元 VUL4J-38 / D / rep-1——与 POC1 基线同单元同配置
- **结果**: completed（2 findings），rounds=1 / toolCalls=6 / 输出 17,805 token / 182.7s / 64,979 token 总耗
- **意义**: DSH 内核 ↔ 真实网关端到端首通（kernel-host 长驻进程 + 优雅退出 + turn 预算护栏全量生效）；与 POC1 同单元结构同构（rounds=1 / toolCalls=6 / findings=2 / 输出 15,557）——单单元冒烟即提示两侧输出量级一致、差异属响应侧正常波动（全量 45 单元对照证实该判断，见 `runs/dsh-vul4j-gateway/REPORT.md` 与 `docs/report/DSH 指标对齐门报告.md`）

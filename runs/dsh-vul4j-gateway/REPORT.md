# DSH 内核 gateway 口径 45 单元重跑（指标对齐门 #29）

- **实验 ID**: `dsh-vul4j-gateway`
- **日期**: 2026-09-11
- **规模**: Vul4J 3 case（VUL4J-38 / 52 / 79）× 配置 A/B/C/D/E × 3 reps = **45 单元，全部完成**（首跑 44 成功 + 1 turn 超时，resume 补 1 通过；最终 failed=0）
- **模型**: `deepseek-v4-flash` @ 火山引擎网关（与基线同端点同模型名；ADR-0002 锁定档）
- **运行时**: **review-dsh 内核**（kernel-host 长驻进程，经 #27 实验 runner 路径）——本实验即 DSH 迁移验收第二层门的对照侧
- **对照基线**: `runs/poc1-vul4j-gateway/`（冻结薄 harness，2026-09-08，45/45）

## 结论

**门不过（池化口径 18/20 格落 ±1σ 带，2 OUT：C/linePrecision、C/cacheHitRate），归因指向运行时不可控面**——DSH 与 POC1 的首个请求逐字节一致、分歧全部始于模型响应；POC1 自身同单元重跑呈同模式且摆幅更大（findings 0↔3、输出 5.9×、rounds 1↔5），自门检验 28 次尝试 11/28 token 出带。无证据表明 DSH 运行时引入系统性偏差；检验力问题立诊断票 #30。

**完整对照表、归因清单、环境版本锁定与预算记录见 `docs/report/DSH 指标对齐门报告.md`。**

## 预算

45 单元实际总账 **8,749,984 token**（未命中输入 997,404 / 命中输入 6,673,152 / 输出 1,079,428）= 基线的 0.78×；另有冒烟 64,979 与一次 turn 超时中止的未入账尝试（估 20–40 万）。

---

*产物索引：`report.json`（全量数据）/ `dashboard.md`（自动看板）/ `runs/**/rep-*.json`（45 份 run 记录）/ `audit/**`（45 份审计）。冒烟见 `runs/dsh-gateway-smoke-r3/REPORT.md`。*

# POC1 代码智能后端为零构建静态解析，不依赖编译

企业落地场景中，检视目标项目只提供静态源码快照（无构建环境、不可编译），编译器级索引——scip-java 是 javac 编译器插件、jdt-ls 需 Maven/Gradle 项目 import——在目标部署中不可用，POC1 必须在同一约束下验证。选定 tree-sitter-java（签名级符号提取，Zone B Symbol Index 的生成器）+ ripgrep（词法引用匹配）+ 文件读取的零构建静态解析；C1/C2 层精度天花板为词法级（重载/override 分辨不精确）。

## Considered Options

- scip-java（类型精确、单个离线 protobuf 索引、TS 官方绑定）：被否——需 repo 可构建，违反生产约束；且 v0.13 要求 JDK 17+/Gradle 8+，连带排除 Java 7/8 时代数据集。
- jdt-ls（LSP 现成 callHierarchy/incomingCalls）：被否——项目 import 依赖构建配置解析，大 repo 索引慢，同为构建依赖。
- Kythe/CodeQL/Glean：管线或运行时过重，均隐含构建步骤。

## Consequences

- review.get_symbol / get_file 可靠；review.find_references 为名字级匹配，重载/override 存在误报漏报——实验内各配置共享同一工具精度，配置间对比（C/D/E）的有效性不受影响；外部参照 Claude Code 同为词法工具（grep/read），跨参照对比亦公平。
- review.get_call_chain 降级为 1~2 层名字级引用链（与工具实现范围决策一致）。
- 词法精度天花板作为已知限制写入设计文档 v2；Phase 2+ 可评估接收者类型启发式推断等增强，仍不引入构建依赖。
- 数据集不再要求可构建——Defects4J 等 Java 7/8 时代老项目重新进入 Q28 候选范围。

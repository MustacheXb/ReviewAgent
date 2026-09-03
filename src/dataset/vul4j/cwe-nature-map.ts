import type { DefectNature } from "../defect-nature.js";

/**
 * Vul4J CVE/CWE → 缺陷性质（DefectNature）映射表（Ticket 08）。
 *
 * 词表对齐 DEFECT_NATURES（T02 权威词表，无 UNKNOWN 档）：映射不到的 CWE
 * 显式降级为 OTHER 并以 matched=false 留痕（调用方负责把 matched=false 记入
 * MRCase.extensions 与清单，见 adapter.ts / sampling.ts）。
 *
 * 映射原则：Vul4J 条目均为安全漏洞，注入/越权/加密/信息泄露类映射 SECURITY；
 * 资源耗尽类（无界分配、不可达退出条件的循环）映射 RESOURCE；
 * 已废弃的泛化类（CWE-19 Data Processing Errors）无足够信号，不映射。
 *
 * 核验状态（2026-09-03，github.com/tuhh-softsec/Vul4J master 的
 * dataset/vul4j_dataset.csv 实测下载逐行解析）：CWE 子集 66 条全部带 CVE，
 * 共 25 个不同 CWE；「数据集出现」标记以下的映射均覆盖实测分布；
 * 其余为健壮性预置（数据集未出现，防 T12 数据更新后漂移）。
 */

export interface CweNatureResolution {
  /** 输入的 CWE 编号（原样透传，如 "CWE-20"） */
  readonly cweId: string;
  /** 映射到的缺陷性质（词表 DEFECT_NATURES） */
  readonly nature: DefectNature;
  /** 是否命中映射表；false = 显式降级 OTHER（词表无 UNKNOWN 档） */
  readonly matched: boolean;
}

type Nature = DefectNature;

/** 数据集实测出现的 25 个 CWE → 缺陷性质 */
const DATASET_CWE_MAP: Readonly<Record<string, Nature>> = {
  // 注入与输入类 → SECURITY
  "CWE-20": "SECURITY", // Improper Input Validation（输入校验缺失，x9）
  "CWE-22": "SECURITY", // Path Traversal（路径穿越，x7）
  "CWE-74": "SECURITY", // Injection（下游注入，x2）
  "CWE-77": "SECURITY", // Command Injection（x1）
  "CWE-78": "SECURITY", // OS Command Injection（x1）
  "CWE-79": "SECURITY", // XSS（x6）
  "CWE-611": "SECURITY", // XXE：XML 外部实体注入（x6）
  "CWE-502": "SECURITY", // 不可信数据反序列化（x4）
  // 访问控制 / 认证 / 授权类 → SECURITY
  "CWE-200": "SECURITY", // 敏感信息暴露（x1）
  "CWE-254": "SECURITY", // 7PK Security Features（宽泛安全特性类，x1）
  "CWE-264": "SECURITY", // 权限与访问控制（废弃宽泛类，x5）
  "CWE-269": "SECURITY", // 特权管理不当（x1）
  "CWE-284": "SECURITY", // 访问控制不当（x1）
  "CWE-287": "SECURITY", // 认证不当（x2）
  "CWE-863": "SECURITY", // 授权不当（x1）
  "CWE-918": "SECURITY", // SSRF（x2）
  "CWE-352": "SECURITY", // CSRF（x1）
  // 加密 / 完整性类 → SECURITY
  "CWE-310": "SECURITY", // 加密问题（x1）
  "CWE-332": "SECURITY", // PRNG 熵不足（x1）
  "CWE-345": "SECURITY", // 数据真实性验证不足（x1）
  "CWE-522": "SECURITY", // 凭据保护不足（x1）
  "CWE-532": "SECURITY", // 日志写入敏感信息（x1）
  // 资源耗尽类（DoS）→ RESOURCE
  "CWE-770": "RESOURCE", // 无上限的资源分配（x1）
  "CWE-835": "RESOURCE", // 不可达退出条件的循环（DoS，x8）
};

/** 健壮性预置：常见安全 CWE（本数据集未出现，防数据更新漂移） */
const EXTRA_CWE_MAP: Readonly<Record<string, Nature>> = {
  "CWE-476": "NULL_SAFETY", // 空指针解引用
  "CWE-362": "CONCURRENCY", // 共享资源并发竞争
  "CWE-754": "EXCEPTION", // 异常条件检查不当
  "CWE-190": "BOUNDARY", // 整数上溢
  "CWE-191": "BOUNDARY", // 整数下溢
  "CWE-125": "BOUNDARY", // 越界读
  "CWE-787": "BOUNDARY", // 越界写
  "CWE-404": "RESOURCE", // 资源未正确关闭
  "CWE-401": "RESOURCE", // 内存未释放
  "CWE-400": "RESOURCE", // 资源消耗不可控
  "CWE-209": "SECURITY", // 错误信息泄露敏感数据
};

const CWE_MAP: Readonly<Record<string, Nature>> = { ...DATASET_CWE_MAP, ...EXTRA_CWE_MAP };

const CWE_ID_RE = /^CWE-\d+$/;

/** 是否为 Vul4J 安全子集的可用标签（形如 CWE-N） */
export function isCweId(value: string): boolean {
  return CWE_ID_RE.test(value);
}

/**
 * CWE → 缺陷性质（纯函数）。
 * - 命中映射表：返回对应性质，matched = true；
 * - 未命中（含 "Not Mapping"、空串、未知编号）：显式降级 OTHER，matched = false，
 *   由调用方留痕（不静默）。
 */
export function resolveCweNature(cweId: string): CweNatureResolution {
  const nature = CWE_MAP[cweId];
  if (nature !== undefined && CWE_ID_RE.test(cweId)) {
    return { cweId, nature, matched: true };
  }
  return { cweId, nature: "OTHER", matched: false };
}

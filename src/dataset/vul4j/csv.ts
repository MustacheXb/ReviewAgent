import { type Result, DatasetError, err, ok } from "../diff/types.js";

/**
 * Vul4J 数据集 CSV 解析（Ticket 08）。
 *
 * 数据源（2026-09-03 实测核验，github.com/tuhh-softsec/Vul4J master）：
 * `dataset/vul4j_dataset.csv`，21 列，129 条（VUL4J-1..79 PoV 型 +
 * VUL4J-80-S..129-S SpotBugs 型）。本模块只提取 POC1 消费的字段；
 * 构建/测试命令列（compile_cmd 等）与检视 MR 构造无关，不透传。
 *
 * 本模块纯函数：不下载、不落盘；下载由 scripts/generate-vul4j-manifest.ts
 * （清单生成）与 T12 数据管线负责。
 */

/** Vul4J 官方数据集 CSV 下载直链 */
export const VUL4J_DATASET_CSV_URL =
  "https://raw.githubusercontent.com/tuhh-softsec/Vul4J/master/dataset/vul4j_dataset.csv";

/** 实测核验的表头（顺序敏感，漂移即显式报错） */
const EXPECTED_HEADER = [
  "no",
  "vul_id",
  "cve_id",
  "cwe_id",
  "cwe_name",
  "owasp_id",
  "repo_slug",
  "human_patch",
  "build_system",
  "compliance_level",
  "failing_tests",
  "compile_cmd",
  "test_all_cmd",
  "test_cmd",
  "cmd_options",
  "failing_module",
  "src",
  "test",
  "src_classes",
  "test_classes",
  "warning",
] as const;

/** 一条 Vul4J 漏洞条目（仅 POC1 消费的字段） */
export interface Vul4jCsvEntry {
  /** 行号（CSV no 列） */
  readonly no: number;
  /** 漏洞 ID（如 "VUL4J-1"、"VUL4J-80-S"） */
  readonly vulId: string;
  /** CVE 编号（如 "CVE-2017-18349"；无映射时为 "Not Mapping"） */
  readonly cveId: string;
  /** CWE 编号（如 "CWE-20"；无映射时为 "Not Mapping"；SpotBugs 型为空串） */
  readonly cweId: string;
  /** CWE 名称（如 "Improper Input Validation"） */
  readonly cweName: string;
  /** OWASP 标签（如 "CWE Top 25"、"A4"、"none"） */
  readonly owaspId: string;
  /** 仓库标签（注意：与 human_patch 实际仓库可能不一致，见 adapter.ts 说明） */
  readonly repoSlug: string;
  /** 修复 commit/compare 的 GitHub URL（数据集内只有 URL，不含 diff 正文） */
  readonly humanPatch: string;
  /** 失败测试（PoV）签名，如 "com.example.Foo#testBar"（多条逗号分隔） */
  readonly failingTests: string;
}

const VUL_ID_RE = /^VUL4J-\d+(-S)?$/;
const PATCH_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(commit\/[0-9a-f]+|compare\/[0-9a-f.]+\.\.[0-9a-f]+)$/;

/** 解析 Vul4J 数据集 CSV 文本（纯函数；逐行校验，任何漂移显式报错不静默截断） */
export function parseVul4jDatasetCsv(text: string): Result<readonly Vul4jCsvEntry[]> {
  if (typeof text !== "string" || text.trim() === "") {
    return err(new DatasetError("INVALID_CSV", "CSV 文本为空"));
  }
  const rows = parseCsvRows(text);
  if (rows.length < 2) {
    return err(new DatasetError("INVALID_CSV", "CSV 仅含表头（或为空）"));
  }
  const header = rows[0]!;
  if (header.length !== EXPECTED_HEADER.length || header.some((h, i) => h !== EXPECTED_HEADER[i])) {
    return err(
      new DatasetError(
        "CSV_HEADER_DRIFT",
        `表头与实测核验的 21 列不一致: ${JSON.stringify(header.slice(0, 8))}...`,
      ),
    );
  }
  const entries: Vul4jCsvEntry[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.length === 1 && row[0] === "") {
      continue;
    }
    if (row.length !== EXPECTED_HEADER.length) {
      return err(
        new DatasetError("INVALID_CSV_ROW", `第 ${i + 1} 行列数 ${row.length} ≠ ${EXPECTED_HEADER.length}`),
      );
    }
    const rowError = toEntry(row, i + 1);
    if (rowError !== undefined) {
      return err(rowError);
    }
    entries.push({
      no: Number(row[0]),
      vulId: row[1]!,
      cveId: row[2]!,
      cweId: row[3]!,
      cweName: row[4]!,
      owaspId: row[5]!,
      repoSlug: row[6]!,
      humanPatch: row[7]!,
      failingTests: row[10]!,
    });
  }
  if (entries.length === 0) {
    return err(new DatasetError("INVALID_CSV", "CSV 无数据行"));
  }
  return ok(entries);
}

function toEntry(row: readonly string[], lineNo: number): DatasetError | undefined {
  if (!VUL_ID_RE.test(row[1]!)) {
    return new DatasetError("INVALID_VUL_ID", `第 ${lineNo} 行 vul_id 非法: ${JSON.stringify(row[1])}`);
  }
  if (!PATCH_URL_RE.test(row[7]!)) {
    return new DatasetError(
      "INVALID_PATCH_URL",
      `第 ${lineNo} 行 human_patch 非 GitHub commit/compare URL: ${JSON.stringify(row[7])}`,
    );
  }
  return undefined;
}

/** RFC 4180 风格 CSV 行解析（支持双引号转义与字段内换行；忽略 \r） */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

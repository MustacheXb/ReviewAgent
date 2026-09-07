import type { LlmMessage } from "../contracts/llm-client.js";
import type {
  PrefetchLayerRecord,
  PrefetchLayerName,
  ResolvedPrefetchBudgets,
} from "../contracts/prefetch.js";
import type { RepoContext } from "./repo-context.js";
import { loadRepoContext } from "./repo-context.js";
import { analyzeDiff, oldSpansOf, type FileDiff } from "./diff-analysis.js";
import {
  changedMethodNames,
  changedMethodRefs,
  resolveChangedFileSymbols,
  type ChangedFileSymbols,
} from "./changed-symbols.js";
import { buildCallChainBlocks } from "./call-chain.js";
import { findReferenceSites } from "./reference-sites.js";
import { buildZoneB } from "./zone-b-builder.js";
import { applyBlockBudget } from "./budget.js";
import type { JavaSymbol } from "./symbols.js";
import { formatSymbolSignature } from "./symbols.js";

/**
 * config B 确定性预取管线（spec #1 工单 #4；主文档第 6 章配置 B）。
 *
 * 固定顺序：Diff → Symbol → Reference → Call Chain（不可配置、不可乱序）：
 * - Diff 层 = 初始 user 消息（Zone C 起点，config A 既有行为），本模块只做 diff 分析；
 * - Symbol / Reference / Call Chain 三层按固定顺序渲染为追加的确定性 user 消息；
 * - Zone B（Repo Map + 签名级 Symbol Index）插在 system（Zone A）与初始 user 消息之间。
 *
 * 全程零 LLM、零工具调用；同一仓库 + 同一 diff → 字节级相同的注入内容。
 */

export interface PrefetchInput {
  readonly repoPath: string;
  readonly diff: string;
  readonly budgets: ResolvedPrefetchBudgets;
}

export interface PrefetchContext {
  readonly zoneBMessage: LlmMessage;
  /** 固定管线顺序的三层消息：Symbol → Reference → Call Chain */
  readonly layerMessages: readonly LlmMessage[];
  /** 注入层记账（zone-b, symbol, reference, call-chain 顺序） */
  readonly records: readonly PrefetchLayerRecord[];
}

const PIPELINE_LINE = "Deterministic prefetch pipeline: Diff -> Symbol -> Reference -> Call Chain.";

export async function buildPrefetchContext(input: PrefetchInput): Promise<PrefetchContext> {
  const analysis = analyzeDiff(input.diff);
  const repo = await loadRepoContext(input.repoPath);
  const changedFiles = analysis.files.map((fileDiff) => fileDiff.file);

  const zoneB = await buildZoneB(
    { repoPath: input.repoPath, changedFiles, budgetChars: input.budgets.zoneBBudgetChars },
    repo,
  );
  const changed = await resolveChangedFileSymbols(repo, analysis);

  const symbolLayer = await renderSymbolLayer(analysis.files, changed, input.budgets.symbolLayerBudgetChars);
  const referenceLayer = await renderReferenceLayer(repo, changed, input.budgets.referenceLayerBudgetChars);
  const callChainLayer = await renderCallChainLayer(repo, changed, input.budgets.callChainLayerBudgetChars);

  return {
    zoneBMessage: { role: "user", content: zoneB.content },
    layerMessages: [
      { role: "user", content: symbolLayer.content },
      { role: "user", content: referenceLayer.content },
      { role: "user", content: callChainLayer.content },
    ],
    records: [zoneB.record, symbolLayer.record, referenceLayer.record, callChainLayer.record],
  };
}

interface LayerRenderResult {
  readonly content: string;
  readonly record: PrefetchLayerRecord;
}

async function renderSymbolLayer(
  fileDiffs: readonly FileDiff[],
  changed: readonly ChangedFileSymbols[],
  budgetChars: number,
): Promise<LayerRenderResult> {
  const blocks = changed.map((entry) => symbolFileBlock(entry, fileDiffs.find((fd) => fd.file === entry.file)));
  return renderLayer(
    "symbol",
    budgetChars,
    [
      "Prefetched context (1 of 3) - Symbol layer.",
      PIPELINE_LINE,
      "Changed symbols at signature level (types and members intersecting the diff hunks; no method bodies).",
    ],
    blocks,
    (shown, total) =>
      `Symbol layer truncated: showing ${shown} of ${total} file entries (budget ${budgetChars} chars exceeded).`,
  );
}

function symbolFileBlock(entry: ChangedFileSymbols, fileDiff: FileDiff | undefined): readonly string[] {
  if (!entry.presentInSnapshot) {
    return [`${entry.file} (not present in the repository snapshot)`];
  }
  const spans = fileDiff !== undefined ? oldSpansOf(fileDiff) : [];
  const spanText =
    spans.length > 0
      ? ` (changed lines: ${spans.map((span) => `${span.startLine}-${span.endLine}`).join(", ")})`
      : "";
  if (entry.pruned.length === 0) {
    return [`${entry.file}${spanText}`, "  (no symbols intersect the changed lines)"];
  }
  return [
    `${entry.file}${spanText}`,
    ...entry.pruned.flatMap((symbol) => renderPrunedSymbol(symbol, 0)),
  ];
}

function renderPrunedSymbol(symbol: JavaSymbol, depth: number): readonly string[] {
  const indent = "  ".repeat(depth + 1);
  return [
    `${indent}L${symbol.line} ${formatSymbolSignature(symbol)}`,
    ...symbol.members.flatMap((member) => renderPrunedSymbol(member, depth + 1)),
  ];
}

async function renderReferenceLayer(
  repo: RepoContext,
  changed: readonly ChangedFileSymbols[],
  budgetChars: number,
): Promise<LayerRenderResult> {
  const names = changedMethodNames(changed);
  const blocks: (readonly string[])[] = [];
  for (const name of names) {
    const sites = await findReferenceSites(repo, name);
    blocks.push([
      `Symbol "${name}": ${sites.length} match(es)`,
      ...sites.map((site) => `  ${site.file}:${site.line}: ${site.text}`),
    ]);
  }
  if (names.length === 0) {
    blocks.push(["No changed symbols identified in the diff; nothing to search."]);
  }
  return renderLayer(
    "reference",
    budgetChars,
    [
      "Prefetched context (2 of 3) - Reference layer.",
      PIPELINE_LINE,
      "Name-level word matches of changed symbols across all Java sources (lexical, no type resolution).",
    ],
    blocks,
    (shown, total) =>
      `Reference layer truncated: showing ${shown} of ${total} symbol entries (budget ${budgetChars} chars exceeded).`,
  );
}

async function renderCallChainLayer(
  repo: RepoContext,
  changed: readonly ChangedFileSymbols[],
  budgetChars: number,
): Promise<LayerRenderResult> {
  const methodRefs = changedMethodRefs(changed);
  const blocks: (readonly string[])[] = [...await buildCallChainBlocks(repo, methodRefs)];
  if (methodRefs.length === 0) {
    blocks.push(["No changed methods identified in the diff; no call chains to build."]);
  }
  return renderLayer(
    "call-chain",
    budgetChars,
    [
      "Prefetched context (3 of 3) - Call chain layer.",
      PIPELINE_LINE,
      "Name-level call chains up to 2 hops around changed methods (lexical, no type resolution).",
    ],
    blocks,
    (shown, total) =>
      `Call chain layer truncated: showing ${shown} of ${total} chain entries (budget ${budgetChars} chars exceeded).`,
  );
}

function renderLayer(
  layer: PrefetchLayerName,
  budgetChars: number,
  headerLines: readonly string[],
  blocks: readonly (readonly string[])[],
  buildNotice: (shown: number, total: number) => string,
): LayerRenderResult {
  const budget = applyBlockBudget(blocks, budgetChars, buildNotice);
  const content =
    budget.lines.length > 0
      ? `${headerLines.join("\n")}\n\n${budget.lines.join("\n")}`
      : headerLines.join("\n");
  return {
    content,
    record: {
      layer,
      budgetChars,
      contentChars: content.length,
      truncated: budget.truncated,
      totalEntries: budget.totalBlocks,
      shownEntries: budget.shownBlocks,
    },
  };
}

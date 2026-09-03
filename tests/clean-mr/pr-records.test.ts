import { describe, expect, it } from "vitest";
import {
  parseCommitMessages,
  parsePullRequestItem,
  parsePullRequestList,
} from "../../src/dataset/clean-mr/pr-records.js";
import { makeRawListItem } from "../fixtures/clean-mr.js";

describe("parsePullRequestItem（GitHub pulls 列表条目 → 领域模型）", () => {
  it("解析实测形状的条目（2026-09 API 实测）", () => {
    const result = parsePullRequestItem(makeRawListItem(), 0);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual({
      number: 3102,
      title: "Add JsonReader.getCharacterOffset to track stream position",
      body: "Rationale: Allow stream-reading large JSON files.",
      state: "closed",
      draft: false,
      createdAt: "2026-08-20T10:00:00Z",
      mergedAt: "2026-08-26T14:40:52Z",
      mergeCommitSha: "61f2c646066e959f65cb99a826a2a759be42dbdd",
      htmlUrl: "https://github.com/google/gson/pull/3102",
      baseRef: "main",
      baseSha: "b3f4ca20087f9066de4c340522ff84e0558e1ad1",
      labels: ["enhancement"],
    });
  });

  it("body 为 null、merged_at 为 null（未合并）合法", () => {
    const result = parsePullRequestItem(
      makeRawListItem({ body: null, merged_at: null, merge_commit_sha: null }),
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.body).toBeNull();
    expect(result.value.mergedAt).toBeNull();
    expect(result.value.mergeCommitSha).toBeNull();
  });

  it("畸形输入显式报错（含字段定位）", () => {
    expect(parsePullRequestItem(null, 0).ok).toBe(false);
    expect(parsePullRequestItem(makeRawListItem({ number: 0 }), 0).ok).toBe(false);
    expect(parsePullRequestItem(makeRawListItem({ title: "" }), 0).ok).toBe(false);
    expect(parsePullRequestItem(makeRawListItem({ draft: "no" }), 0).ok).toBe(false);
    expect(parsePullRequestItem(makeRawListItem({ merged_at: "yesterday" }), 0).ok).toBe(false);
    expect(parsePullRequestItem(makeRawListItem({ base: null }), 0).ok).toBe(false);
    expect(parsePullRequestItem(makeRawListItem({ base: { ref: "main", sha: "xyz" } }), 0).ok).toBe(false);
    expect(parsePullRequestItem(makeRawListItem({ labels: ["enhancement"] }), 0).ok).toBe(false);
  });
});

describe("parsePullRequestList（整页解析）", () => {
  it("保持顺序逐条解析", () => {
    const result = parsePullRequestList([makeRawListItem(), makeRawListItem({ number: 3101 })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((p) => p.number)).toEqual([3102, 3101]);
    }
  });

  it("非数组 / 条目畸形显式报错", () => {
    expect(parsePullRequestList({}).ok).toBe(false);
    const bad = parsePullRequestList([makeRawListItem(), makeRawListItem({ number: -1 })]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.message).toContain("pulls[1]");
    }
  });
});

describe("parseCommitMessages（PR 提交消息）", () => {
  it("提取 commit.commit.message 列表", () => {
    const raw = [
      { sha: "a".repeat(40), commit: { message: "Add feature" } },
      { sha: "b".repeat(40), commit: { message: "Fixes #33\n\nbody" } },
    ];
    const result = parseCommitMessages(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["Add feature", "Fixes #33\n\nbody"]);
    }
  });

  it("空提交列表与畸形输入", () => {
    expect(parseCommitMessages([])).toEqual({ ok: true, value: [] });
    expect(parseCommitMessages(null).ok).toBe(false);
    expect(parseCommitMessages([{}]).ok).toBe(false);
    expect(parseCommitMessages([{ commit: {} }]).ok).toBe(false);
  });
});

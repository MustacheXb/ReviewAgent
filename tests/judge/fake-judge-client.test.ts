import { describe, expect, it } from "vitest";
import type { JudgeRequest } from "../../src/judge/contracts.js";
import {
  FakeJudgeClient,
  JudgeScriptExhaustedError,
} from "../../src/judge/fake-judge-client.js";
import { adjudication, match } from "./helpers.js";

function request(caseId = "case-001"): JudgeRequest {
  return { caseId, findings: [], truths: [], context: null };
}

describe("FakeJudgeClient — 脚本回放", () => {
  it("按调用顺序回放裁定", async () => {
    const first = adjudication([match({ finding: 0, truth: 0 })]);
    const second = adjudication([]);
    const client = FakeJudgeClient.fromAdjudications([first, second]);
    await expect(client.adjudicate(request())).resolves.toEqual(first);
    await expect(client.adjudicate(request())).resolves.toEqual(second);
    expect(client.callCount).toBe(2);
  });

  it("fromAdjudications 便捷构造 + 脚本耗尽显式失败", async () => {
    const client = FakeJudgeClient.fromAdjudications([adjudication([])]);
    await client.adjudicate(request());
    await expect(client.adjudicate(request())).rejects.toBeInstanceOf(JudgeScriptExhaustedError);
  });

  it("fail 步骤抛出注入的错误（驱动判定链有界失败分支）", async () => {
    const client = new FakeJudgeClient([
      { kind: "fail", error: new Error("injected network failure") },
    ]);
    await expect(client.adjudicate(request())).rejects.toThrowError("injected network failure");
  });
});

describe("FakeJudgeClient — 请求捕获与隔离", () => {
  it("捕获收到的请求（深拷贝：后续变更不影响捕获内容）", async () => {
    const client = FakeJudgeClient.fromAdjudications([adjudication([])]);
    const mutable = {
      caseId: "case-001",
      findings: [
        { id: "F001", title: "t", description: "d", file: "f", line: 1, category: null, evidence: ["e"] },
      ],
      truths: [],
      context: null,
    };
    await client.adjudicate(mutable);
    mutable.findings[0]!.title = "mutated after call";
    expect(client.capturedRequests[0]?.findings[0]?.title).toBe("t");
  });

  it("返回裁定为防御性拷贝（修改返回值不影响脚本回放）", async () => {
    const reply = adjudication([match({ finding: 0, truth: 0 })]);
    const client = FakeJudgeClient.fromAdjudications([reply, reply]);
    const first = (await client.adjudicate(request())) as unknown as {
      matches: { findingIndex: number }[];
    };
    first.matches[0]!.findingIndex = 99;
    const second = await client.adjudicate(request());
    expect(second.matches[0]?.findingIndex).toBe(0);
  });
});

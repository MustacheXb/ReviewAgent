import { describe, expect, it } from "vitest";
import {
  createContextLedger,
  createInertContextLedger,
  LEDGER_REFERENCE_ECHO_MAX_CHARS,
} from "../src/tools/ledger.js";

/**
 * 工单 #8 验收：Context Ledger 纯逻辑（功能态 / 惰性态）。
 * 断言对象是 ContextLedger 的公开方法输出（runReview 工具挂载的同一接口）：
 * 命中语义（精确重复）、引用格式（字节确定）、顺序编号、防御性快照。
 */

describe("createContextLedger (functional ledger, run-private)", () => {
  it("misses before registration and returns a formatted reference after registering", () => {
    const ledger = createContextLedger();
    const description = "review.get_file src/main/java/com/example/math/MathUtils.java:15-22";

    expect(ledger.referenceIfLoaded("range", description)).toBeUndefined();

    ledger.register("range", description);
    expect(ledger.referenceIfLoaded("range", description)).toBe(
      `Already loaded: ctx#001 (${description})`,
    );
  });

  it("assigns sequential zero-padded ids in registration order", () => {
    const ledger = createContextLedger();
    for (let index = 1; index <= 10; index++) {
      ledger.register("symbol", `review.get_symbol "symbol${index}"`);
    }
    expect(ledger.snapshot().map((entry) => entry.id)).toEqual([
      "ctx#001",
      "ctx#002",
      "ctx#003",
      "ctx#004",
      "ctx#005",
      "ctx#006",
      "ctx#007",
      "ctx#008",
      "ctx#009",
      "ctx#010",
    ]);
  });

  it("keys on kind and description together (same description under another kind misses)", () => {
    const ledger = createContextLedger();
    ledger.register("file", "review.get_file src/Foo.java");

    expect(ledger.referenceIfLoaded("file", "review.get_file src/Foo.java")).toContain("ctx#001");
    expect(ledger.referenceIfLoaded("range", "review.get_file src/Foo.java")).toBeUndefined();
    expect(ledger.referenceIfLoaded("symbol", "review.get_file src/Foo.java")).toBeUndefined();
  });

  it("does not match different descriptions (no subsumption between overlapping reads)", () => {
    const ledger = createContextLedger();
    ledger.register("file", "review.get_file src/Foo.java");

    // 整读之后的子区间读取、不同区间、其他工具的相同符号名：均不命中
    expect(ledger.referenceIfLoaded("range", "review.get_file src/Foo.java:100-180")).toBeUndefined();
    expect(ledger.referenceIfLoaded("file", "review.get_file src/Bar.java")).toBeUndefined();
    expect(ledger.referenceIfLoaded("symbol", "review.get_symbol \"sumFirst\"")).toBeUndefined();
  });

  it("bounds the description echo inside the reference (deterministic truncation)", () => {
    const ledger = createContextLedger();
    const longDescription = `review.search_rule "${"x".repeat(400)}"`;
    ledger.register("evidence", longDescription);

    const reference = ledger.referenceIfLoaded("evidence", longDescription);
    expect(reference).toBeDefined();
    const echo = reference?.slice("Already loaded: ctx#001 (".length, -1) ?? "";
    expect(echo.length).toBe(LEDGER_REFERENCE_ECHO_MAX_CHARS + 3);
    expect(echo.endsWith("...")).toBe(true);
  });

  it("returns defensive snapshots: earlier snapshots freeze, arrays and entries are fresh copies", () => {
    const ledger = createContextLedger();
    ledger.register("file", "review.get_file src/Foo.java");
    const first = ledger.snapshot();
    ledger.register("symbol", "review.get_symbol \"Foo\"");

    expect(first).toHaveLength(1);
    expect(ledger.snapshot()).toHaveLength(2);

    const second = ledger.snapshot();
    const third = ledger.snapshot();
    expect(second).not.toBe(third);
    expect(second[0]).not.toBe(third?.[0]);
  });
});

describe("createInertContextLedger (A/B/C/D default: zero behavior change)", () => {
  it("never reports a hit and keeps the snapshot empty even after register calls", () => {
    const ledger = createInertContextLedger();
    ledger.register("file", "review.get_file src/Foo.java");

    expect(ledger.referenceIfLoaded("file", "review.get_file src/Foo.java")).toBeUndefined();
    expect(ledger.snapshot()).toEqual([]);
  });
});

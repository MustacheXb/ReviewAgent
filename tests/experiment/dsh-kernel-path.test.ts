/**
 * #29 冒烟回归：driver 的 host bin 定位（resolveHostBinPath）。
 *
 * 真实 runner（pnpm experiment）把驱动器编译进 .tmp-gen/src/experiment/
 * （tsc 项目模式以 repo 根为公共根，产物镜像 repo 根相对结构）——比源树
 * src/experiment/ 深一级。固定层级假设（new URL("../../")）在编译树里解析出
 * .tmp-gen/packages/...（不存在），host 子进程秒死 MODULE_NOT_FOUND、单元以
 * "JSON-RPC input closed" 失败。root e2e 从源码 import 驱动器，覆盖不到该
 * 语境——定位逻辑按 repo 根标记逐级上溯，源树/编译树/任意嵌套深度统一成立。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { resolveHostBinPath } from "../../src/experiment/dsh-kernel.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 独立 fixture 树（可选放置 bin 标记；登记待清理） */
function makeFixture(withMarker: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-bin-path-"));
  fixtureRoots.push(root);
  mkdirSync(join(root, "a", "b", "c", "d"), { recursive: true });
  if (withMarker) {
    mkdirSync(join(root, "packages", "review-dsh", "bin"), { recursive: true });
    writeFileSync(join(root, "packages", "review-dsh", "bin", "review-kernel-host.js"), "");
  }
  return root;
}

describe("resolveHostBinPath", () => {
  it("源树深度（src/experiment → 仓库根）定位到包内 bin", () => {
    expect(resolveHostBinPath(join(repoRoot, "src", "experiment"))).toBe(
      join(repoRoot, "packages", "review-dsh", "bin", "review-kernel-host.js"),
    );
  });

  it("编译树深度（.tmp-gen/src/experiment，pnpm experiment 产物镜像）定位到同一 bin——冒烟回归：固定两级假设曾在此解析到不存在路径", () => {
    expect(resolveHostBinPath(join(repoRoot, ".tmp-gen", "src", "experiment"))).toBe(
      join(repoRoot, "packages", "review-dsh", "bin", "review-kernel-host.js"),
    );
  });

  it("任意嵌套深度按标记上溯（fixture 深树）", () => {
    const root = makeFixture(true);
    expect(resolveHostBinPath(join(root, "a", "b", "c", "d"))).toBe(
      join(root, "packages", "review-dsh", "bin", "review-kernel-host.js"),
    );
  });

  it("上溯范围内无标记即 fail fast（错误列出探测过的路径）", () => {
    const root = makeFixture(false);
    expect(() => resolveHostBinPath(join(root, "a", "b", "c", "d"))).toThrow(
      /review-kernel-host bin not found[\s\S]*packages.*review-kernel-host\.js/,
    );
  });
});

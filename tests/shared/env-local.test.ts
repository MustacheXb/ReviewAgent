import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvLocalFile } from "../../src/shared/env-local.js";

/**
 * .env.local 装载（Benchmark 试跑的 API key / 接入点本机注入面）：
 * KEY=VALUE 解析 / 成对引号剥离 / 注释与空行跳过 / 目标 env 已有非空值
 * 优先 / 空值不注入 / 坏行留痕不中断 / 文件缺失 no-op / BOM 与 CRLF。
 * 目标 env 以普通对象注入（不碰 process.env，测试零全局污染）。
 */

let workDir: string;
let fileCounter = 0;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "env-local-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeEnvFile(content: string): Promise<string> {
  fileCounter += 1;
  const filePath = path.join(workDir, `env-${fileCounter}.local`);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

describe("loadEnvLocalFile — 基本装载", () => {
  it("KEY=VALUE 注入目标 env（值中 = 保留，首个 = 分割）", async () => {
    const filePath = await writeEnvFile("DEEPSEEK_API_KEY=sk-abc123\nDEEPSEEK_URL=https://relay.example.com/v1\nNOTE=a=b=c\n");
    const target: Record<string, string | undefined> = {};
    const result = loadEnvLocalFile(filePath, target);
    expect(result.exists).toBe(true);
    expect(result.loadedKeys).toEqual(["DEEPSEEK_API_KEY", "DEEPSEEK_URL", "NOTE"]);
    expect(target.DEEPSEEK_API_KEY).toBe("sk-abc123");
    expect(target.DEEPSEEK_URL).toBe("https://relay.example.com/v1");
    expect(target.NOTE).toBe("a=b=c");
  });

  it("成对单/双引号剥离；不成对引号原样保留", async () => {
    const filePath = await writeEnvFile('A="quoted value"\nB=\'single quoted\'\nC="unpaired\n');
    const target: Record<string, string | undefined> = {};
    loadEnvLocalFile(filePath, target);
    expect(target.A).toBe("quoted value");
    expect(target.B).toBe("single quoted");
    expect(target.C).toBe('"unpaired');
  });

  it("注释行与空行跳过；行内注释不解析（# 是值的一部分）", async () => {
    const filePath = await writeEnvFile("# 注释行\n\n  # 缩进注释\nKEY=value # not a comment\n");
    const target: Record<string, string | undefined> = {};
    const result = loadEnvLocalFile(filePath, target);
    expect(result.loadedKeys).toEqual(["KEY"]);
    expect(result.malformedLines).toEqual([]);
    expect(target.KEY).toBe("value # not a comment");
  });

  it("BOM 剥离 + CRLF 行尾（Windows 编辑器友好）", async () => {
    const filePath = await writeEnvFile("﻿KEY=value\r\nOTHER=2\r\n");
    const target: Record<string, string | undefined> = {};
    const result = loadEnvLocalFile(filePath, target);
    expect(result.loadedKeys).toEqual(["KEY", "OTHER"]);
    expect(target.KEY).toBe("value");
    expect(target.OTHER).toBe("2");
  });
});

describe("loadEnvLocalFile — 覆盖与留痕纪律", () => {
  it("目标 env 已有非空值优先（不覆盖）；空值视为未设置（可注入）", async () => {
    const filePath = await writeEnvFile("DEEPSEEK_API_KEY=from-file\nOTHER=from-file\n");
    const target: Record<string, string | undefined> = {
      DEEPSEEK_API_KEY: "from-env",
      OTHER: "",
    };
    const result = loadEnvLocalFile(filePath, target);
    expect(result.loadedKeys).toEqual(["OTHER"]);
    expect(result.skippedKeys).toEqual(["DEEPSEEK_API_KEY"]);
    expect(target.DEEPSEEK_API_KEY).toBe("from-env");
    expect(target.OTHER).toBe("from-file");
  });

  it("空值行不注入（skippedKeys 留痕——空值=显式未设置）", async () => {
    const filePath = await writeEnvFile("DEEPSEEK_API_KEY=\n");
    const target: Record<string, string | undefined> = {};
    const result = loadEnvLocalFile(filePath, target);
    expect(result.loadedKeys).toEqual([]);
    expect(result.skippedKeys).toEqual(["DEEPSEEK_API_KEY"]);
    expect("DEEPSEEK_API_KEY" in target).toBe(false);
  });

  it("坏行留痕不中断（仅行号，不回显原文——裸贴 key 行不泄漏）；合法行仍装载", async () => {
    const filePath = await writeEnvFile("GOOD=1\n坏行没有等号\nALSO GOOD=2\n=VALUE_ONLY\n");
    const target: Record<string, string | undefined> = {};
    const result = loadEnvLocalFile(filePath, target);
    expect(result.loadedKeys).toEqual(["GOOD"]);
    expect(result.malformedLines).toEqual(["line 2", "line 3", "line 4"]);
    expect(target.GOOD).toBe("1");
  });

  it("文件缺失 no-op（exists=false，目标 env 不动）", () => {
    const target: Record<string, string | undefined> = { PRESENT: "yes" };
    const result = loadEnvLocalFile(path.join(workDir, "does-not-exist.local"), target);
    expect(result.exists).toBe(false);
    expect(result.loadedKeys).toEqual([]);
    expect(result.skippedKeys).toEqual([]);
    expect(result.malformedLines).toEqual([]);
    expect(target).toEqual({ PRESENT: "yes" });
  });
});

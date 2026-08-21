/**
 * Persistence 持久化单元测试
 */
import { describe, it, expect } from "../runner.js";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonFilePersistence } from "../../lib/core/session/persistence.js";

describe("JsonFilePersistence", () => {
  it("save 后 load 返回相同数据", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-persist-"));
    const p = new JsonFilePersistence(dir);
    const key = "g1.json";
    const data = { id: "g1", core: { world: { currentScene: "书房" } } };

    p.save(key, data);
    const loaded = p.load(key);

    expect(loaded).toEqual(data);
    expect(existsSync(join(dir, "g1.json"))).toBeTrue();
  });

  it("load 不存在的 key 返回 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-persist-"));
    const p = new JsonFilePersistence(dir);
    expect(p.load("missing.json")).toBeNull();
  });

  it("load 损坏 JSON 返回 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-persist-"));
    writeFileSync(join(dir, "bad.json"), "{not valid json", "utf8");
    const p = new JsonFilePersistence(dir);
    expect(p.load("bad.json")).toBeNull();
  });

  it("key 为绝对路径时不重复拼接 rootDir", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-persist-"));
    const p = new JsonFilePersistence(dir);
    const abs = join(dir, "abs.json");
    expect(p.filePath(abs)).toBe(abs);
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "persistence 单元测试"));

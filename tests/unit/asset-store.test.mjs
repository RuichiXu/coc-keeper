/**
 * AssetStore 全局资产库单元测试
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "../runner.js";
import { ASSET_KINDS, AssetStore, slugify, assetIdFor } from "../../lib/core/index.js";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "coc-assets-"));
  return { store: new AssetStore(dir), dir };
}

describe("AssetStore", () => {
  it("save/load/list 剧本资产", () => {
    const { store, dir } = tempStore();
    const saved = store.save(ASSET_KINDS.SCENARIO, { name: "深渊低语", text: "剧本正文" });
    expect(saved.id).toBe("sc-深渊低语");
    expect(store.load(ASSET_KINDS.SCENARIO, saved.id).text).toBe("剧本正文");
    expect(store.list(ASSET_KINDS.SCENARIO)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("同名资产自动加后缀避免覆盖", () => {
    const { store, dir } = tempStore();
    const a = store.save(ASSET_KINDS.ENTITY, { name: "守夜人" });
    const b = store.save(ASSET_KINDS.ENTITY, { name: "守夜人" });
    expect(a.id).toBe("ent-守夜人");
    expect(b.id).toBe("ent-守夜人-2");
    expect(store.list(ASSET_KINDS.ENTITY)).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("update 保留 id 并更新时间", () => {
    const { store, dir } = tempStore();
    const saved = store.save(ASSET_KINDS.INVESTIGATOR, { name: "张三", occupation: "记者" });
    const updated = store.update(ASSET_KINDS.INVESTIGATOR, saved.id, { occupation: "侦探" });
    expect(updated.id).toBe(saved.id);
    expect(updated.occupation).toBe("侦探");
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(store.load(ASSET_KINDS.INVESTIGATOR, saved.id).occupation).toBe("侦探");
    rmSync(dir, { recursive: true, force: true });
  });

  it("delete 删除资产", () => {
    const { store, dir } = tempStore();
    const saved = store.save(ASSET_KINDS.ENTITY, { name: "祭坛" });
    expect(store.delete(ASSET_KINDS.ENTITY, saved.id)).toBeTrue();
    expect(store.load(ASSET_KINDS.ENTITY, saved.id)).toBeNull();
    expect(store.delete(ASSET_KINDS.ENTITY, saved.id)).toBeFalse();
    rmSync(dir, { recursive: true, force: true });
  });

  it("slugify / assetIdFor 生成安全 id", () => {
    expect(slugify(" 深渊·低语！ ")).toBe("深渊-低语");
    expect(assetIdFor(ASSET_KINDS.SCENARIO, "深渊低语")).toBe("sc-深渊低语");
    expect(assetIdFor(ASSET_KINDS.INVESTIGATOR, "张三")).toBe("inv-张三");
    expect(assetIdFor(ASSET_KINDS.ENTITY, "守夜人")).toBe("ent-守夜人");
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "asset-store 单元测试"));

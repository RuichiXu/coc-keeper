/**
 * 全局资产库 AssetStore（Core 层，零 DSH 依赖）
 *
 * 资产目录结构（rootDir 下）：
 *   scenarios/<id>.json      剧本（全局唯一，可被多场游戏引用）
 *   investigators/<id>.json  通用调查员卡（模板）
 *   entities/<id>.json       通用实体（NPC/地点/物品模板）
 *
 * 语义：
 * - 资产是模板，游戏内实例为副本（copy-on-write），修改实例不影响资产。
 * - 删除资产不影响已实例化到游戏内的副本数据。
 * - 删除剧本资产时由调用方负责级联删除引用它的场次。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const ASSET_KINDS = {
  SCENARIO: "scenarios",
  INVESTIGATOR: "investigators",
  ENTITY: "entities",
};

/**
 * 名称安全化：中文/字母/数字保留，其他转连字符。
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  const clean = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean.slice(0, 48) : "untitled";
}

/**
 * 生成资产 id（kind 前缀 + 名称 slug）。
 * @param {string} kind
 * @param {string} name
 * @returns {string}
 */
export function assetIdFor(kind, name) {
  const prefix = kind === ASSET_KINDS.SCENARIO ? "sc" : kind === ASSET_KINDS.INVESTIGATOR ? "inv" : "ent";
  return `${prefix}-${slugify(name)}`;
}

export class AssetStore {
  /**
   * @param {string} rootDir - 资产根目录（如 ~/.dsh/coc/assets）
   */
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  kindDir(kind) {
    return join(this.rootDir, kind);
  }

  fileFor(kind, id) {
    return join(this.kindDir(kind), `${id}.json`);
  }

  /**
   * 列出某类资产。
   * @param {string} kind
   * @returns {Array<object>}
   */
  list(kind) {
    const dir = this.kindDir(kind);
    if (!existsSync(dir)) return [];
    const out = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const asset = this.load(kind, file.slice(0, -5));
      if (asset !== null) out.push(asset);
    }
    out.sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id), "zh-CN"));
    return out;
  }

  /**
   * 读取资产。
   * @param {string} kind
   * @param {string} id
   * @returns {object|null}
   */
  load(kind, id) {
    const file = this.fileFor(kind, id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * 保存资产（自动补 id / kind / createdAt / updatedAt）。
   * @param {string} kind
   * @param {object} asset
   * @param {string} [preferredId] - 期望 id；冲突时自动加 -2 / -3 …
   * @returns {object} 已保存的资产
   */
  save(kind, asset, preferredId) {
    const base = preferredId ?? asset.id ?? assetIdFor(kind, asset.name);
    let id = base;
    let n = 2;
    while (this.load(kind, id) !== null && id !== asset.id) {
      id = `${base}-${n}`;
      n += 1;
    }
    const now = new Date().toISOString();
    const saved = {
      ...asset,
      id,
      kind,
      createdAt: asset.createdAt ?? now,
      updatedAt: now,
    };
    const file = this.fileFor(kind, id);
    mkdirSync(this.kindDir(kind), { recursive: true });
    writeFileSync(file, JSON.stringify(saved, null, 2), "utf8");
    return saved;
  }

  /**
   * 更新资产（保留原 id；不存在则新建）。
   * @param {string} kind
   * @param {string} id
   * @param {object} patch
   * @returns {object|null}
   */
  update(kind, id, patch) {
    const existing = this.load(kind, id);
    if (existing === null) return null;
    const merged = { ...existing, ...patch, id, kind, updatedAt: new Date().toISOString() };
    const file = this.fileFor(kind, id);
    writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  }

  /**
   * 删除资产。
   * @param {string} kind
   * @param {string} id
   * @returns {boolean}
   */
  delete(kind, id) {
    const file = this.fileFor(kind, id);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }

  /**
   * 按名称查找（精确匹配）。
   * @param {string} kind
   * @param {string} name
   * @returns {object|null}
   */
  findByName(kind, name) {
    for (const asset of this.list(kind)) {
      if (asset.name === name) return asset;
    }
    return null;
  }
}

/**
 * Persistence 持久化接口与 JSON 文件实现
 *
 * 职责：
 * - 定义 Persistence 接口（load / save）
 * - 提供 JsonFilePersistence（当前默认实现）
 *
 * 未来可替换为 SQLite / 云端同步等实现，调用方只依赖接口。
 *
 * Core 零 DSH 依赖；仅使用 Node.js 内置 fs。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Persistence 接口（JSDoc 描述）。
 *
 * @typedef {object} Persistence
 * @property {(key: string) => object|null} load - 读取指定 key 的数据，不存在返回 null
 * @property {(key: string, data: object) => void} save - 保存数据到指定 key
 */

/**
 * JSON 文件持久化实现。
 * key 为文件路径。
 */
export class JsonFilePersistence {
  /**
   * @param {string} rootDir - 数据根目录
   */
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  /**
   * 解析 key 为绝对文件路径。
   * @param {string} key
   * @returns {string}
   */
  filePath(key) {
    return key.startsWith(this.rootDir) ? key : `${this.rootDir}/${key}`;
  }

  /**
   * 读取 JSON 文件，不存在或损坏时返回 null。
   * @param {string} key
   * @returns {object|null}
   */
  load(key) {
    const file = this.filePath(key);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * 写入 JSON 文件（原子性由调用方保证；这里直接覆盖写）。
   * @param {string} key
   * @param {object} data
   */
  save(key, data) {
    const file = this.filePath(key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  }
}

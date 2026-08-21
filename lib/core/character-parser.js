/**
 * CoC 人物卡解析器
 *
 * 纯函数，零外部依赖。从旧 index.js:422-502 提取，逻辑完全保留。
 *
 * 支持：
 * - JSON 数组 / JSON 对象（自动识别）
 * - 「姓名：xxx / 职业：xxx / 力量：50」式行文本
 *
 * 属性别名：
 *   力量→STR 体质→CON 体型→SIZ 敏捷→DEX 智力→INT 灵感→INT
 *   意志→POW 外貌→APP 教育→EDU 幸运→LUCK 生命值→HP 理智→SAN 魔法值→MP
 */

// ── 常量 ──────────────────────────────────────────────────

export const STAT_ALIASES = {
  力量: "STR",
  体质: "CON",
  体型: "SIZ",
  敏捷: "DEX",
  智力: "INT",
  灵感: "INT",
  意志: "POW",
  外貌: "APP",
  教育: "EDU",
  幸运: "LUCK",
  生命值: "HP",
  理智: "SAN",
  魔法值: "MP",
};

export const STAT_KEYS = new Set([
  "STR",
  "CON",
  "SIZ",
  "DEX",
  "INT",
  "POW",
  "APP",
  "EDU",
  "LUCK",
  "HP",
  "SAN",
  "MP",
]);

// ── 解析 ──────────────────────────────────────────────────

/**
 * 解析人物卡文本。
 * 支持 JSON 数组/对象，或「姓名：xxx / 力量：50」式行文本。
 *
 * @param {string} text
 * @returns {Array<object>} 原始人物对象数组
 */
export function parseCharacters(text) {
  const trimmed = String(text).trim();

  // JSON 格式
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      if (list.every((item) => typeof item === "object" && item !== null)) {
        return list;
      }
    } catch {
      // 继续尝试行式解析
    }
  }

  // 行式解析
  const characters = [];
  let current = null;

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    // 新人物：姓名：xxx
    const nameMatch = /^(?:姓名|名字|名称|人物)[：:\s]+(.+)$/.exec(line);
    if (nameMatch !== null) {
      current = {
        name: nameMatch[1].trim(),
        occupation: "",
        stats: {},
        skills: {},
        inventory: [],
        notes: "",
      };
      characters.push(current);
      continue;
    }

    if (current === null) continue;

    // 键值对
    const kv = /^([^：:]+)[：:]\s*(.+)$/.exec(line);
    if (kv === null) {
      current.notes += `${line}\n`;
      continue;
    }

    const key = kv[1].trim();
    const value = kv[2].trim();

    if (key === "职业" || key === "职业/职务" || key === "职位") {
      current.occupation = value;
      continue;
    }
    if (key === "备注" || key === "笔记" || key === "背景") {
      current.notes = value;
      continue;
    }
    if (key === "物品" || key === "装备" || key === "道具" || key === "随身物品") {
      current.inventory = value
        .split(/[、,，;；]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }

    const num = Number(value);
    const statKey = STAT_ALIASES[key] ?? key.toUpperCase();

    if (
      Number.isFinite(num) &&
      (STAT_KEYS.has(statKey) ||
        Object.prototype.hasOwnProperty.call(STAT_ALIASES, key))
    ) {
      current.stats[statKey] = num;
    } else if (Number.isFinite(num)) {
      current.skills[statKey] = num;
    } else {
      current.notes += `${key}：${value}\n`;
    }
  }

  return characters;
}

// ── 标准化 ────────────────────────────────────────────────

/**
 * 将 RawCharacter 标准化为正式的 Character 结构。
 * 自动补全缺失字段，生成稳定 ID。
 *
 * @param {object} raw - 原始人物数据
 * @param {number} index - 人物索引（用于生成 ID）
 * @returns {object} 标准化后的人物
 */
export function normalizeCharacter(raw, index) {
  const stats = {};
  for (const [key, value] of Object.entries(raw.stats ?? {})) {
    const num = Number(value);
    if (Number.isFinite(num)) stats[String(key).toUpperCase()] = num;
  }

  const skills = {};
  for (const [key, value] of Object.entries(raw.skills ?? {})) {
    const num = Number(value);
    if (Number.isFinite(num)) skills[String(key)] = num;
  }

  const nameText = String(raw.name ?? `人物${index + 1}`).trim();

  return {
    id:
      typeof raw.id === "string" && raw.id.length > 0
        ? raw.id
        : `pc-${Date.now().toString(36)}-${index}`,
    name: nameText,
    player: String(raw.player ?? ""),
    occupation: String(raw.occupation ?? ""),
    stats,
    hp: Number(raw.hp ?? stats.HP ?? 0),
    san: Number(raw.san ?? stats.SAN ?? 0),
    mp: Number(raw.mp ?? stats.MP ?? 0),
    luck: Number(raw.luck ?? stats.LUCK ?? 0),
    skills,
    inventory: Array.isArray(raw.inventory) ? raw.inventory.map(String) : [],
    notes: String(raw.notes ?? ""),
  };
}
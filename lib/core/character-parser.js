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
  生命: "HP",
  理智: "SAN",
  魔法值: "MP",
  魔法: "MP",
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

// 英文字段别名（人物卡 / 档案式文本）
const NAME_KEYS = new Set(["name", "character", "investigator"]);
const OCCUPATION_KEYS = new Set(["occupation", "job", "career", "profession"]);

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

  const newCharacter = (name) => {
    current = {
      name,
      occupation: "",
      stats: {},
      skills: {},
      inventory: [],
      notes: "",
    };
    characters.push(current);
    return current;
  };

  let pendingStat = null;
  let pendingSkill = null;
  let inSkills = false;

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    // 进入技能段
    if (/(^|\/)\s*(技能|SKILLS)\s*(\/|$)/i.test(line)) {
      inSkills = true;
      continue;
    }
    // 离开技能段
    if (inSkills && /(战斗|资源|COMBAT|RESOURCES|随身物品|财务|关系|CONTACTS|TRAITS)/i.test(line)) {
      inSkills = false;
    }

    // 新人物：姓名：xxx / NAME: xxx
    const nameMatch =
      /^(?:姓名|名字|名称|人物|NAME|Name|Character|Investigator)[：:\s]+(.+)$/.exec(line);
    if (nameMatch !== null) {
      newCharacter(nameMatch[1].trim());
      pendingStat = null;
      continue;
    }

    // 档案式人物名：伊芙琳·“伊芙”·默瑟 / EVELYN “EVIE” MERCER
    const dossierName = /^([\u4e00-\u9fff·“”]{2,})\s*\/\s*[A-Za-z\s·'"“”.-]+$/.exec(line);
    if (dossierName !== null && current === null) {
      newCharacter(dossierName[1].trim());
      pendingStat = null;
      continue;
    }
    if (dossierName !== null && current !== null) continue; // 同行的英文名忽略

    if (current === null) continue;

    // 属性标签行（数值在下一行）：力量 STR / 体质 CON / STR
    const statLabel = /^([\u4e00-\u9fff]{2,4})\s+([A-Z]{2,4})$|^([A-Z]{2,4})$|^([\u4e00-\u9fff]{2,4})$/.exec(line);
    if (statLabel !== null) {
      const candidate = statLabel[1] ?? statLabel[2] ?? statLabel[3] ?? statLabel[4];
      const statKey = STAT_ALIASES[candidate] ?? candidate.toUpperCase();
      if (STAT_KEYS.has(statKey) || Object.prototype.hasOwnProperty.call(STAT_ALIASES, candidate)) {
        pendingStat = statKey;
        continue;
      }
    }

    // 纯数字行（承接 pendingStat，或技能三列的前一行的技能值？）
    const bareNumber = /^(\d{1,3})(?:\s*\/\s*(\d{1,3}))?$/.exec(line);
    if (bareNumber !== null && pendingStat !== null) {
      current.stats[pendingStat] = Number(bareNumber[1]);
      pendingStat = null;
      continue;
    }

    // 纯属性行：STR 50 / STR: 50 / 力量 50
    const bareStat = /^([A-Z]{2,4}|[\u4e00-\u9fff]{2})\s*[:：]?\s*(\d+)\s*$/.exec(line);
    if (bareStat !== null) {
      const statKey = STAT_ALIASES[bareStat[1]] ?? bareStat[1].toUpperCase();
      const num = Number(bareStat[2]);
      if (STAT_KEYS.has(statKey)) {
        current.stats[statKey] = num;
        pendingStat = null;
        continue;
      }
    }

    // 技能三列行：技能名 常规值 困难值 极难值（如「侦查 75 37 15」）
    const skillRow = /^(.+?)\s+(\d{1,3})\s+\d{1,3}\s+\d{1,3}\s*$/.exec(line);
    if (skillRow !== null && pendingStat === null) {
      const skillName = skillRow[1].trim();
      const value = Number(skillRow[2]);
      if (skillName.length > 0 && skillName.length <= 24) {
        current.skills[skillName] = value;
        continue;
      }
    }

    // 技能段：技能名行 + 下一行数值（如「侦查」/「75」）
    if (inSkills && pendingSkill === null && /^[\u4e00-\u9fff/·：、A-Za-z]{2,24}$/.test(line)) {
      pendingSkill = line;
      continue;
    }
    if (pendingSkill !== null && bareNumber !== null) {
      current.skills[pendingSkill] = Number(bareNumber[1]);
      pendingSkill = null;
      continue;
    }

    // 键值对
    const kv = /^([^：:]+)[：:]\s*(.+)$/.exec(line);
    if (kv !== null) {
      const key = kv[1].trim();
      const value = kv[2].trim();

      const keyLower = key.toLowerCase();
      if (key === "职业" || key === "职业/职务" || key === "职位" || OCCUPATION_KEYS.has(keyLower)) {
        current.occupation = value;
        continue;
      }
      if (NAME_KEYS.has(keyLower)) {
        current.name = value;
        continue;
      }
      if (key === "备注" || key === "笔记" || key === "背景" || keyLower === "notes") {
        current.notes = value;
        continue;
      }
      if (key === "物品" || key === "装备" || key === "道具" || key === "随身物品" || keyLower === "inventory") {
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
      continue;
    }

    // 档案式职业行：新闻摄影记者 · 波士顿《信使报》 · 29岁
    const dossierOccupation = /^([\u4e00-\u9fff]{2,10})\s*·/.exec(line);
    if (dossierOccupation !== null && current.occupation.length === 0) {
      current.occupation = dossierOccupation[1].trim();
      continue;
    }

    current.notes += `${line}\n`;
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
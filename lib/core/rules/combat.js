/**
 * 战斗规则引擎
 *
 * 纯函数，零外部依赖。从旧 index.js:1261-1457 提取，逻辑完全保留。
 *
 * 职责：
 * - 命中检定
 * - 闪避/反击判定
 * - 伤害掷骰（含伤害加值 DB）
 * - 武器伤害表
 * - 返回事件而非直接修改状态
 */

import { evaluateCoC, rollDice, TIER_LABELS } from "../dice.js";

// ── 武器伤害表 ────────────────────────────────────────────

const WEAPON_DAMAGE = {
  "格斗（斗殴）": "1d3", "拳": "1d3", "踢": "1d3",
  "格斗（剑）": "1d8", "刀": "1d6", "猎刀": "1d4+2",
  "格斗（斧）": "1d8+1", "斧": "1d8+1",
  "格斗（矛）": "1d6", "矛": "1d6",
  "格斗（鞭）": "1d2",
  "格斗（链锯）": "2d8",
  "投掷": "1d4",
  ".22 手枪": "1d6", ".32 手枪": "1d8", ".38 手枪": "1d10", ".45 手枪": "1d10+2",
  "9mm 手枪": "1d10",
  "步枪": "2d6", ".22 步枪": "1d6+1", ".30 步枪": "2d6+2",
  "霰弹枪": "4d6/2d6/1d6", "霰弹": "4d6/2d6/1d6",
  "冲锋枪": "1d10",
  "机枪": "2d6+2",
};

const WEAPON_SKILL_MAP = {
  "格斗（斗殴）": "格斗（斗殴）", "拳": "格斗（斗殴）", "踢": "格斗（斗殴）",
  "剑": "格斗（剑）", "刀": "格斗（剑）",
  "斧": "格斗（斧）",
  "矛": "格斗（矛）",
  "手枪": "射击（手枪）", ".38": "射击（手枪）", ".45": "射击（手枪）",
  "步枪": "射击（步枪/霰弹枪）",
  "霰弹": "射击（步枪/霰弹枪）",
  "冲锋枪": "射击（冲锋枪）",
  "机枪": "射击（机枪）",
  "投掷": "投掷",
  "弓": "射击（步枪/霰弹枪）",
};

// ── DB 计算 ───────────────────────────────────────────────

/**
 * 计算伤害加值 DB 表达式（CoC 7e 标准表）。
 *
 * STR+SIZ 2-64   → "-2"
 * STR+SIZ 65-84  → "-1"
 * STR+SIZ 85-124 → "0"
 * STR+SIZ 125-164 → "1d4"
 * STR+SIZ 165-204 → "1d6"
 * STR+SIZ 205-284 → "2d6"
 * STR+SIZ 285+    → "3d6"（标准表到 364，超过按 3d6 封顶）
 *
 * @param {number} str
 * @param {number} siz
 * @returns {string} DB 表达式
 */
export function dbExpression(str, siz) {
  const total = str + siz;
  if (total <= 64) return "-2";
  if (total <= 84) return "-1";
  if (total <= 124) return "0";
  if (total <= 164) return "1d4";
  if (total <= 204) return "1d6";
  if (total <= 284) return "2d6";
  return "3d6";
}

/**
 * 掷 DB 表达式（支持负数常量与正数骰式）。
 * @param {string} expr - 如 "-2", "-1", "0", "1d4", "2d6"
 * @returns {number}
 */
export function rollDb(expr) {
  const str = String(expr).trim();
  if (str === "0") return 0;

  // 纯整数常量（含负数），如 "-2"、"-1"
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);

  const negative = str.startsWith("-");
  const body = negative ? str.slice(1) : str;
  const diceMatch = body.match(/(\d+)d(\d+)(?:\s*[+-]\s*(\d+))?/);
  if (!diceMatch) return 0;

  const count = parseInt(diceMatch[1], 10);
  const sides = parseInt(diceMatch[2], 10);
  const mod = diceMatch[3] ? parseInt(diceMatch[3], 10) : 0;

  let total = mod;
  const dice = rollDice(count, sides);
  for (const d of dice) total += d;
  return negative ? -total : total;
}

// ── 先攻与伤情（C-2 补全） ────────────────────────────────

/**
 * 先攻排序（CoC 7e：DEX×5 检定，成功者按出目升序，失败者按 DEX 降序排在成功者之后）。
 * @param {Array<{ name: string, dex: number }>} participants
 * @returns {{ order: Array<object>, rolls: Array<object> }}
 */
export function rollInitiative(participants) {
  const rolls = [];
  for (const participant of participants ?? []) {
    const dex = Number(participant?.dex ?? participant?.stats?.DEX ?? 50);
    const target = dex * 5;
    const rolled = Math.floor(Math.random() * 100) + 1;
    const success = rolled <= target;
    rolls.push({ name: String(participant?.name ?? "未命名"), dex, target, rolled, success });
  }
  const succeeded = rolls.filter((entry) => entry.success).sort((a, b) => a.rolled - b.rolled);
  const failed = rolls.filter((entry) => !entry.success).sort((a, b) => b.dex - a.dex);
  return { order: [...succeeded, ...failed], rolls };
}

/**
 * 伤情判定：重伤（单次伤害 ≥ 最大 HP 的一半）、濒死（HP ≤ 0）、死亡（HP ≤ -maxHp）。
 * @param {object} opts
 * @param {number} opts.damage - 本次实际伤害
 * @param {number} opts.hpAfter - 伤害后 HP
 * @param {number} opts.maxHp - 最大 HP
 * @returns {{ majorWound: boolean, dying: boolean, dead: boolean, status: string }}
 */
export function evaluateWoundState(opts) {
  const { damage = 0, hpAfter = 0, maxHp = 10 } = opts;
  const majorWound = damage >= Math.floor(maxHp / 2);
  const dead = hpAfter <= -maxHp;
  const dying = hpAfter <= 0 && !dead;
  const status = dead ? "dead" : dying ? "dying" : "alive";
  return { majorWound, dying, dead, status };
}

/**
 * 解析护甲值：数字直接使用；字符串表达式（如 "1d10"）掷骰。
 * @param {number|string} armor
 * @returns {number}
 */
export function resolveArmor(armor) {
  if (armor === undefined || armor === null || armor === "") return 0;
  if (typeof armor === "number") return armor;
  const str = String(armor).trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  const diceMatch = str.match(/(\d+)d(\d+)(?:\s*[+-]\s*(\d+))?/);
  if (!diceMatch) return 0;
  const count = parseInt(diceMatch[1], 10);
  const sides = parseInt(diceMatch[2], 10);
  const mod = diceMatch[3] ? parseInt(diceMatch[3], 10) : 0;
  let total = mod;
  const dice = rollDice(count, sides);
  for (const d of dice) total += d;
  return total;
}

// ── 掷伤害 ────────────────────────────────────────────────

/**
 * 根据伤害表达式掷骰
 * @param {string} expr - 如 "1d8", "1d4+2", "4d6/2d6/1d6"
 * @param {string} [range] - 射程（处理霰弹枪递减）
 * @returns {number}
 */
function rollDamage(expr, range) {
  let damageExpr = expr;

  // 处理霰弹枪射程递减
  if (damageExpr.includes("/")) {
    const parts = damageExpr.split("/");
    if (range === "point-blank" || range === "close") damageExpr = parts[0];
    else if (range === "medium") damageExpr = parts[1] || parts[0];
    else damageExpr = parts[2] || parts[0];
  }

  const diceMatch = damageExpr.match(/(\d+)d(\d+)(?:\s*[+-]\s*(\d+))?/);
  if (!diceMatch) return 0;

  const count = parseInt(diceMatch[1], 10);
  const sides = parseInt(diceMatch[2], 10);
  const mod = diceMatch[3] ? parseInt(diceMatch[3], 10) : 0;

  let damage = 0;
  const dice = rollDice(count, sides);
  for (const d of dice) damage += d;
  return damage + mod;
}

// ── 战斗结算 ──────────────────────────────────────────────

/**
 * 执行一次战斗回合结算。
 *
 * @param {object} opts
 * @param {string} opts.attackerName
 * @param {string} opts.defenderName
 * @param {object} opts.attacker - 攻击方数据 { skills?: {}, stats?: { STR, SIZ, HP } }
 * @param {object} opts.defender - 防御方数据 { skills?: {}, stats?: { STR, SIZ, HP }, hp?: number }
 * @param {string} [opts.weapon="格斗（斗殴）"]
 * @param {string} [opts.skill] - 使用的技能名（缺省根据武器推断）
 * @param {boolean} [opts.defenderDodge=false]
 * @param {string} [opts.range="close"]
 * @param {boolean} [opts.defenderIsEntity=false]
 * @param {string} [opts.gameId="default"]
 * @returns {{
 *   hit: boolean,
 *   damage: number,
 *   hpBefore: number,
 *   hpAfter: number,
 *   attackerRoll: number,
 *   defenderRoll: number,
 *   attackTier: string,
 *   dodgeSuccess: boolean,
 *   details: string,
 *   events: Array<object>
 * }}
 */
export function performCombatRound(opts) {
  const {
    attackerName,
    defenderName,
    attacker,
    defender,
    weapon = "格斗（斗殴）",
    skill = "",
    defenderDodge = false,
    range = "close",
    defenderIsEntity = false,
    armor = 0,
    gameId = "default",
  } = opts;

  // 获取攻击技能值
  let attackSkill = 25;
  if (skill) {
    attackSkill = attacker.skills?.[skill] || 25;
  } else {
    const matchedKey = Object.keys(WEAPON_SKILL_MAP).find((k) =>
      weapon.includes(k)
    );
    const skillName = matchedKey ? WEAPON_SKILL_MAP[matchedKey] : "格斗（斗殴）";
    attackSkill = attacker.skills?.[skillName] || 25;
  }

  // 攻击检定
  const attackRoll = Math.floor(Math.random() * 100) + 1;
  const attackEval = evaluateCoC(attackSkill, attackRoll, true);
  const hit = attackEval.tier !== "fail" && attackEval.tier !== "fumble";

  // 闪避判定
  let defenderRoll = 0;
  let dodgeSuccess = false;
  if (defenderDodge && hit) {
    const dodgeSkill = defender.skills?.["闪避"] || 50;
    defenderRoll = Math.floor(Math.random() * 100) + 1;
    dodgeSuccess = defenderRoll <= dodgeSkill;
  }

  // 伤害计算
  const matchedWeapon = Object.keys(WEAPON_DAMAGE).find((k) =>
    weapon.includes(k)
  );
  const damageExpr = matchedWeapon ? WEAPON_DAMAGE[matchedWeapon] : "1d3";
  let damage = rollDamage(damageExpr, range);

  // 伤害加值 DB（仅近战和投掷）
  const isRanged = ["手枪", "步枪", "霰弹", "冲锋枪", "机枪"].some((k) =>
    weapon.includes(k)
  );
  if (!isRanged && attacker.stats) {
    const str = attacker.stats.STR || 50;
    const siz = attacker.stats.SIZ || 50;
    const db = rollDb(dbExpression(str, siz));
    damage += db;
    if (damage < 0) damage = 0;
  }

  // 成功档次加伤
  if (attackEval.tier === "critical") {
    const minDmg = damageExpr.match(/\d+/);
    damage = Math.max(damage, minDmg ? parseInt(minDmg[0]) : 1);
  }

  // 最终伤害：闪避成功为 0；否则先减护甲，护甲不减到 0 以下（至少 1 点）。
  let finalDamage = dodgeSuccess ? 0 : damage;
  if (finalDamage < 0) finalDamage = 0;
  if (finalDamage > 0) {
    const armorValue = resolveArmor(armor);
    finalDamage = Math.max(1, finalDamage - armorValue);
  }

  // 防御方 HP（maxHp 用于重伤判定：单次伤害 ≥ 最大 HP 的一半）
  const hpBefore = defender.hp ?? defender.stats?.HP ?? 10;
  const maxHp = defender.stats?.HP ?? hpBefore;
  const hpAfter = Math.max(0, hpBefore - finalDamage);
  const wound = evaluateWoundState({ damage: finalDamage, hpAfter, maxHp });

  const tierLabel = TIER_LABELS[attackEval.tier] ?? attackEval.tier;

  // 构建详情
  let details = `攻击方 ${attackerName}（${weapon}，技能 ${attackSkill}）→ 出目 ${attackRoll}（${tierLabel}）`;
  if (defenderDodge && hit) {
    details += `\n防御方 ${defenderName} 尝试闪避 → 出目 ${defenderRoll}${dodgeSuccess ? "（成功）" : "（失败）"}`;
  }
  if (hit && !dodgeSuccess) {
    details += `\n伤害 ${damageExpr}${!isRanged ? " + DB" : ""} = ${damage} → 实际伤害 ${finalDamage}`;
    details += `\n${defenderName} HP：${hpBefore} → ${hpAfter}`;
    if (wound.majorWound) details += "（重伤）";
    if (wound.dying) details += "（濒死）";
    if (wound.dead) details += "（死亡）";
  } else if (hit && dodgeSuccess) {
    details += `\n闪避成功，未造成伤害`;
  } else {
    details += `\n未命中`;
  }

  // 构建事件
  const events = [];
  const at = new Date().toISOString();

  // 攻击检定事件
  events.push({
    type: "RollPerformed",
    at,
    gameId,
    kind: "open",
    player: attackerName,
    label: `攻击 ${defenderName}（${weapon}）`,
    skill: skill || "格斗（斗殴）",
    expression: "d100",
    dice: [attackRoll],
    rolled: attackRoll,
    total: attackRoll,
    target: attackSkill,
    difficulty: "regular",
    tier: attackEval.tier,
    passed: hit,
  });

  // 伤害事件
  if (hit && !dodgeSuccess && finalDamage > 0) {
    events.push({
      type: "DamageApplied",
      at,
      gameId,
      target: defenderIsEntity ? `entity:${defenderName}` : defenderName,
      amount: finalDamage,
      source: `${attackerName}（${weapon}）`,
      hpBefore,
      hpAfter,
      isMajorWound: wound.majorWound,
      status: wound.status,
    });
  }

  return {
    hit: hit && !dodgeSuccess,
    damage: finalDamage,
    hpBefore,
    hpAfter,
    attackerRoll: attackRoll,
    defenderRoll,
    attackTier: attackEval.tier,
    dodgeSuccess,
    majorWound: wound.majorWound,
    status: wound.status,
    dying: wound.dying,
    dead: wound.dead,
    details,
    events,
  };
}
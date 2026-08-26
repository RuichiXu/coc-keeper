/**
 * CoC 7e 骰点引擎
 *
 * 纯函数，零外部依赖。可直接在任何 JS 环境使用。
 * 从旧 index.js:154-226 提取，逻辑完全保留。
 *
 * 支持：
 * - 任意骰式（d100、3d6、d20+2 等）
 * - CoC 7e 百分骰成功档次判定（大成功/极限成功/困难成功/常规成功/失败/大失败）
 * - 难度等级（常规/困难/极限）
 */

// ── 常量 ──────────────────────────────────────────────────

export const TIER_LABELS = {
  critical: "大成功",
  extreme: "极限成功",
  hard: "困难成功",
  regular: "常规成功",
  pass: "成功",
  fail: "失败",
  fumble: "大失败",
};

export const DIFFICULTY_LABELS = {
  regular: "常规",
  hard: "困难",
  extreme: "极限",
};

// ── 骰子解析 ──────────────────────────────────────────────

/**
 * 解析骰式字符串，如 "d100", "3d6", "d20+2", "2d10-1"
 * @param {string} expr
 * @returns {{ count: number, sides: number, mod: number }}
 * @throws 骰式格式无效时抛出 Error
 */
export function parseDiceExpression(expr) {
  const m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(String(expr).trim());
  if (m === null) {
    throw new Error(`无法解析骰式 "${expr}"；支持格式：d100、3d6、d20+2、2d10-1`);
  }
  const count = m[1] === "" ? 1 : Number.parseInt(m[1], 10);
  const sides = Number.parseInt(m[2], 10);
  const mod = m[3] === undefined ? 0 : Number.parseInt(m[3], 10);

  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error(`骰子个数 ${count} 无效（1-100）`);
  }
  if (!Number.isInteger(sides) || sides < 2 || sides > 1000) {
    throw new Error(`骰面 ${sides} 无效（2-1000）`);
  }
  return { count, sides, mod };
}

// ── 掷骰 ──────────────────────────────────────────────────

/**
 * 掷一组骰子
 * @param {number} count
 * @param {number} sides
 * @returns {number[]}
 */
export function rollDice(count, sides) {
  const dice = [];
  for (let i = 0; i < count; i += 1) {
    dice.push(Math.floor(Math.random() * sides) + 1);
  }
  return dice;
}

/**
 * 执行一次完整掷骰
 * @param {string} expression
 * @returns {{ dice: number[], rolled: number, total: number, percentile: boolean }}
 */
export function roll(expression) {
  const parsed = parseDiceExpression(expression);
  const dice = rollDice(parsed.count, parsed.sides);
  const percentile = parsed.sides === 100 && parsed.count === 1;
  const total = dice.reduce((a, b) => a + b, 0) + parsed.mod;
  return { dice, rolled: total, total, percentile };
}

// ── CoC 7e 判定 ───────────────────────────────────────────

/**
 * CoC 7e 百分骰成功档次判定。
 *
 * 规则（CoC 7e）：
 * - 大成功（critical）：01 总是大成功；技能值 ≥ 50 时 01-05 也为大成功
 * - 极限成功（extreme）：≤ 技能值/5（向下取整）
 * - 困难成功（hard）：≤ 技能值/2（向下取整）
 * - 常规成功（regular）：≤ 技能值
 * - 大失败（fumble）：技能值 < 50 时 96-00（含 100）；技能值 ≥ 50 时仅 00（=100）
 * - 其余 > 技能值的情况为普通失败（fail）
 *
 * @param {number} target
 * @param {number} rolled
 * @param {boolean} percentile
 * @returns {{ tier: string }}
 */
export function evaluateCoC(target, rolled, percentile) {
  if (!percentile) {
    return { tier: rolled <= target ? "pass" : "fail" };
  }

  const fifth = Math.floor(target / 5);
  const half = Math.floor(target / 2);

  let tier;
  if (rolled === 1) tier = "critical";
  else if (target >= 50 && rolled <= 5) tier = "critical";
  else if (rolled <= fifth) tier = "extreme";
  else if (rolled <= half) tier = "hard";
  else if (rolled <= target) tier = "regular";
  else if (target < 50 ? rolled >= 96 : rolled === 100) tier = "fumble";
  else tier = "fail";

  return { tier };
}

/**
 * 判断某档位是否通过了指定难度
 * @param {string} tier
 * @param {string} difficulty
 * @param {boolean} percentile
 * @returns {boolean}
 */
export function passedFor(tier, difficulty, percentile) {
  if (!percentile) return tier === "pass" || tier === "critical";
  if (tier === "critical" || tier === "extreme") return true;
  if (tier === "fumble" || tier === "fail") return false;
  if (difficulty === "extreme") return false;
  if (difficulty === "hard") return tier === "hard";
  return tier === "regular" || tier === "hard";
}

/**
 * 执行一次完整 CoC 检定：掷骰 + 判定。
 *
 * @param {string} expression - 骰式，如 "d100", "3d6"
 * @param {number|null} [target] - 目标技能值（可选，百分骰时按 CoC 7e 分档判定）
 * @param {string} [difficulty="regular"] - 难度等级
 * @returns {{
 *   dice: number[],
 *   rolled: number,
 *   total: number,
 *   percentile: boolean,
 *   target: number|null,
 *   difficulty: string,
 *   tier: string|null,
 *   passed: boolean|null
 * }}
 */
export function performRoll(expression, target, difficulty = "regular") {
  const parsed = parseDiceExpression(expression);
  const dice = rollDice(parsed.count, parsed.sides);
  const percentile = parsed.sides === 100 && parsed.count === 1;
  const total = dice.reduce((a, b) => a + b, 0) + parsed.mod;
  const rolled = total;

  const hasTarget = Number.isFinite(target) && target > 0;
  let tier = null;
  let passed = null;

  if (hasTarget) {
    const evaluation = evaluateCoC(target, rolled, percentile);
    tier = evaluation.tier;
    passed = passedFor(tier, difficulty, percentile);
  }

  return {
    dice,
    rolled,
    total,
    percentile,
    target: hasTarget ? target : null,
    difficulty,
    tier,
    passed,
  };
}

/**
 * 渲染骰点结果行（用于展示）。
 * 格式：掷 d100 = 45 目标 60（常规）→ 常规成功 ✓
 *
 * @param {object} result
 * @returns {string}
 */
export function renderRollLine(result) {
  const player = result.player ? ` · ${result.player}` : "";
  const label = result.label ? `（${result.label}）` : "";
  const target =
    result.target !== null && result.target !== undefined
      ? ` 目标 ${result.target}${result.difficulty ? `（${DIFFICULTY_LABELS[result.difficulty] ?? result.difficulty}）` : ""}`
      : "";
  const tier =
    result.tier !== null && result.tier !== undefined
      ? ` → ${TIER_LABELS[result.tier] ?? result.tier}${result.passed ? " ✓" : ""}`
      : "";
  const dice =
    result.dice && result.dice.length > 1 ? ` [${result.dice.join("+")}]` : "";
  return `掷 ${result.expression ?? "d100"}${dice} = ${result.rolled}${target}${tier}`;
}
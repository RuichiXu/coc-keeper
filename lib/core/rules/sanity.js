/**
 * SAN 检定规则引擎
 *
 * 纯函数，零外部依赖。从旧 index.js:1150-1257 提取，逻辑完全保留。
 *
 * 职责：
 * - 解析 SAN 损失格式（"0/1d3", "1/1d6+1", "1d3"）
 * - 执行 SAN 检定（INT 对抗）
 * - 判定疯狂（临时性/不定性/永久性）
 * - 返回事件而非直接修改状态
 */

import { evaluateCoC, rollDice, TIER_LABELS } from "../dice.js";

// ── SAN 损失解析 ──────────────────────────────────────────

/**
 * 解析 SAN 损失表达式。
 * 支持格式：
 * - "0/1d3" → 成功损失 0，失败损失 1d3
 * - "1/1d6+1" → 成功损失 1，失败损失 1d6+1
 * - "1d3" → 固定损失 1d3
 *
 * @param {string} sanLossExpr
 * @returns {{ successExpr: string, failExpr: string }}
 */
export function parseSanLoss(sanLossExpr) {
  const str = String(sanLossExpr ?? "").trim();
  let successExpr = "0";
  let failExpr = str;

  const slashIdx = str.indexOf("/");
  if (slashIdx >= 0) {
    successExpr = str.slice(0, slashIdx).trim() || "0";
    failExpr = str.slice(slashIdx + 1).trim();
  }

  return { successExpr, failExpr };
}

/**
 * 掷骰表达式（如 "1d3", "1d6+1"），返回数值。
 * @param {string} expr
 * @returns {number}
 */
export function rollExpr(expr) {
  if (!expr || expr.length === 0) return 0;
  const diceMatch = expr.match(/(\d+)d(\d+)(?:\s*[+-]\s*(\d+))?/);
  if (diceMatch) {
    const count = parseInt(diceMatch[1], 10);
    const sides = parseInt(diceMatch[2], 10);
    const mod = diceMatch[3] ? parseInt(diceMatch[3], 10) : 0;
    let loss = 0;
    const dice = rollDice(count, sides);
    for (const d of dice) loss += d;
    return loss + mod;
  }
  return parseInt(expr, 10) || 0;
}

// ── SAN 检定 ──────────────────────────────────────────────

/**
 * 执行一次 SAN 检定。
 *
 * @param {object} opts
 * @param {string} opts.characterName - 角色名
 * @param {number} opts.currentSan - 当前 SAN 值
 * @param {number} [opts.intValue=50] - INT 值（用于临时性疯狂判定）
 * @param {string} opts.sanLoss - SAN 损失表达式（如 "0/1d3"）
 * @param {string} [opts.description=""] - 触发原因描述
 * @param {string} [opts.eventId=""] - 事件幂等键（如同一 SAN 源只结算一次）；仅透出到事件，由上层去重
 * @param {string} [opts.gameId="default"]
 * @returns {{
 *   sanLost: number,
 *   sanBefore: number,
 *   sanAfter: number,
 *   passed: boolean,
 *   rolled: number,
 *   tier: string,
 *   madness: string,
 *   events: Array<object>
 * }}
 */
export function performSanityCheck(opts) {
  const {
    characterName,
    currentSan = 50,
    intValue = 50,
    sanLoss = "0/1d3",
    description = "",
    eventId = "",
    gameId = "default",
  } = opts;

  const { successExpr, failExpr } = parseSanLoss(sanLoss);
  const san = currentSan;

  // SAN 检定
  const rolled = Math.floor(Math.random() * 100) + 1;
  const target = san;
  const evaluation = evaluateCoC(target, rolled, true);
  const passed = evaluation.tier !== "fail" && evaluation.tier !== "fumble";

  // 计算实际损失
  const lossExpr = passed ? successExpr : failExpr;
  const loss = rollExpr(lossExpr);

  const sanBefore = san;
  const sanAfter = Math.max(0, san - loss);

  // 疯狂判定
  let madness = "无";
  if (loss >= 5 && sanAfter > 0) {
    const intRoll = Math.floor(Math.random() * 100) + 1;
    if (intRoll > intValue) {
      madness = `临时性疯狂（INT 检定失败，出目 ${intRoll}/${intValue}）`;
    } else {
      madness = `临时性疯狂（已通过 INT 检定，出目 ${intRoll}/${intValue}）——暂未陷入疯狂，但 SAN 损失巨大`;
    }
  }
  if (loss >= san * 0.2 && sanAfter > 0) {
    madness = `不定性疯狂（24 小时内损失 ${loss} ≥ ${Math.floor(san * 0.2)}）`;
  }
  if (sanAfter <= 0) {
    madness = "永久性疯狂（SAN 归零）";
  }

  const tierLabel = TIER_LABELS[evaluation.tier] ?? evaluation.tier;

  // 构建事件
  const events = [];

  // RollPerformed 事件
  // SAN 检定属于不宜向玩家展示精确数值的暗骰；聊天区不渲染 SAN 行，
  // 因此这里必须用 kind: "secret"，玩家视图的 recentRolls 才不会泄露目标/出目。
  events.push({
    type: "RollPerformed",
    at: new Date().toISOString(),
    gameId,
    kind: "secret",
    player: characterName,
    label: `SAN 检定：${description}`,
    skill: "SAN",
    expression: "d100",
    dice: [rolled],
    rolled,
    total: rolled,
    target: san,
    difficulty: "regular",
    tier: evaluation.tier,
    passed,
    eventId: typeof eventId === "string" && eventId.trim().length > 0 ? eventId.trim() : "",
  });

  // SanityLost 事件
  events.push({
    type: "SanityLost",
    at: new Date().toISOString(),
    gameId,
    character: characterName,
    amount: loss,
    sanBefore,
    sanAfter,
    cause: description,
    madnessTriggered: madness,
    eventId: typeof eventId === "string" && eventId.trim().length > 0 ? eventId.trim() : "",
  });

  return {
    sanLost: loss,
    sanBefore,
    sanAfter,
    passed,
    rolled,
    tier: tierLabel,
    madness,
    events,
  };
}
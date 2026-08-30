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

// ── 疯狂与恢复（C-2 补全） ────────────────────────────────

/**
 * 临时性疯狂判定：单次理智损失 ≥ 5 点时进行 INT 检定，失败则陷入临时性疯狂。
 * @param {object} opts
 * @param {number} opts.loss - 本次理智损失
 * @param {number} opts.sanAfter - 损失后的 SAN 值
 * @param {number} opts.intValue - INT 值
 * @returns {{ triggered: boolean, passedInt: boolean, intRoll: number, summary: string }}
 */
export function evaluateTemporaryMadness(opts) {
  const { loss = 0, sanAfter = 50, intValue = 50 } = opts;
  if (loss < 5 || sanAfter <= 0) {
    return { triggered: false, passedInt: true, intRoll: 0, summary: "" };
  }
  const intRoll = Math.floor(Math.random() * 100) + 1;
  const passedInt = intRoll <= intValue;
  const triggered = !passedInt;
  const summary = triggered
    ? `临时性疯狂（INT 检定失败，出目 ${intRoll}/${intValue}）`
    : `临时性疯狂（已通过 INT 检定，出目 ${intRoll}/${intValue}）——暂未陷入疯狂，但 SAN 损失巨大`;
  return { triggered, passedInt, intRoll, summary };
}

/**
 * 不定性疯狂判定：24 小时内累计理智损失 ≥ 当前 SAN 的 20%。
 * @param {object} opts
 * @param {number} opts.loss - 本次理智损失
 * @param {number} [opts.recentLoss] - 24 小时内已累计损失（不含本次；缺省用 loss 估）
 * @param {number} opts.currentSan - 损失前 SAN 值
 * @returns {{ triggered: boolean, threshold: number, totalLoss: number }}
 */
export function evaluateIndefiniteMadness(opts) {
  const { loss = 0, currentSan = 50 } = opts;
  const recentLoss = opts.recentLoss ?? 0;
  const totalLoss = Math.max(loss, recentLoss + loss);
  const threshold = Math.floor(currentSan * 0.2);
  return { triggered: totalLoss >= threshold, threshold, totalLoss };
}

/**
 * 学习克苏鲁神话知识：获得 1d6 克苏鲁神话技能，同时永久损失 1d6 SAN。
 * @param {object} opts
 * @param {string} opts.characterName
 * @param {number} [opts.currentSan=50]
 * @param {number} [opts.currentMythos=0]
 * @param {string} [opts.gameId="default"]
 * @returns {{ sanLoss: number, sanAfter: number, mythosGain: number, mythosAfter: number, events: Array<object> }}
 */
export function learnCthulhuMythos(opts) {
  const {
    characterName,
    currentSan = 50,
    currentMythos = 0,
    gameId = "default",
  } = opts;
  const mythosGain = Math.floor(Math.random() * 6) + 1;
  const sanLoss = Math.floor(Math.random() * 6) + 1;
  const mythosAfter = Math.min(99, currentMythos + mythosGain);
  const sanAfter = Math.max(0, currentSan - sanLoss);
  const at = new Date().toISOString();
  const events = [
    {
      type: "SanityLost",
      at,
      gameId,
      character: characterName,
      amount: sanLoss,
      sanBefore: currentSan,
      sanAfter,
      cause: "学习克苏鲁神话知识",
      permanent: true,
    },
    {
      type: "SkillGrown",
      at,
      gameId,
      character: characterName,
      skill: "克苏鲁神话",
      before: currentMythos,
      after: mythosAfter,
      gain: mythosGain,
    },
  ];
  return { sanLoss, sanAfter, mythosGain, mythosAfter, events };
}

/**
 * 理智恢复：精神分析成功 1d3/月，冒险奖励 1d6+4，战胜神话生物 1d10。
 * @param {object} opts
 * @param {string} opts.characterName
 * @param {number} [opts.currentSan=50]
 * @param {number} [opts.maxSan] - SAN 上限（默认 POW；未提供时不设上限）
 * @param {string} opts.method - "psychoanalysis" | "adventure" | "mythos-victory"
 * @param {string} [opts.gameId="default"]
 * @returns {{ recovered: number, sanAfter: number, method: string, events: Array<object> }}
 */
export function recoverSanity(opts) {
  const {
    characterName,
    currentSan = 50,
    maxSan = null,
    method = "psychoanalysis",
    gameId = "default",
  } = opts;
  let recovered = 0;
  if (method === "adventure") {
    recovered = Math.floor(Math.random() * 6) + 1 + 4; // 1d6+4
  } else if (method === "mythos-victory") {
    recovered = Math.floor(Math.random() * 10) + 1; // 1d10
  } else {
    recovered = Math.floor(Math.random() * 3) + 1; // 精神分析 1d3
  }
  const cap = maxSan === null || maxSan === undefined ? null : Math.max(0, maxSan);
  const sanAfter = cap === null ? currentSan + recovered : Math.min(cap, currentSan + recovered);
  const at = new Date().toISOString();
  const events = [
    {
      type: "StateChanged",
      at,
      gameId,
      target: characterName,
      changes: { san: sanAfter },
      reason: method,
    },
  ];
  return { recovered, sanAfter, method, events };
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

  // 疯狂判定（C-2：临时性/不定性/永久性由独立判定函数出，便于测试与复用）
  const temporary = evaluateTemporaryMadness({ loss, sanAfter, intValue });
  const indefinite = evaluateIndefiniteMadness({ loss, currentSan: san });
  let madness = "无";
  let temporaryMadness = temporary.triggered;
  let indefiniteMadness = indefinite.triggered;
  if (temporary.triggered || temporary.summary.length > 0) {
    madness = temporary.summary;
  }
  if (indefinite.triggered && sanAfter > 0) {
    madness = `不定性疯狂（24 小时内损失 ${indefinite.totalLoss} ≥ ${indefinite.threshold}）`;
    indefiniteMadness = true;
  }
  if (sanAfter <= 0) {
    madness = "永久性疯狂（SAN 归零）";
    temporaryMadness = false;
    indefiniteMadness = false;
  }

  const tierLabel = TIER_LABELS[evaluation.tier] ?? evaluation.tier;

  // 构建事件
  const events = [];

  // RollPerformed 事件
  // 针对玩家调查员的 SAN 检定（SC）是明骰：玩家能随时查看自己的 SC 掷骰与出目。
  // 聊天区由 chat-bridge 渲染 [SAN 检定] 行，玩家视图 recentRolls 同样可见。
  events.push({
    type: "RollPerformed",
    at: new Date().toISOString(),
    gameId,
    kind: "open",
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
    temporaryMadness,
    indefiniteMadness,
    events,
  };
}
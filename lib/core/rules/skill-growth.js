/**
 * 技能成长规则引擎
 *
 * 纯函数，零外部依赖。从旧 index.js:1461-1501 提取，逻辑完全保留。
 *
 * 规则：
 * - 冒险结束时，对打勾标记的技能尝试成长
 * - 掷 d100，若大于当前技能值则增加 1d10
 */

/**
 * 尝试一次技能成长。
 *
 * @param {object} opts
 * @param {string} opts.characterName
 * @param {string} opts.skillName
 * @param {number} opts.currentValue - 当前技能值
 * @param {string} [opts.gameId="default"]
 * @returns {{
 *   before: number,
 *   after: number,
 *   rolled: number,
 *   grown: boolean,
 *   gain: number,
 *   events: Array<object>
 * }}
 */
export function performSkillGrowth(opts) {
  const {
    characterName,
    skillName,
    currentValue = 0,
    gameId = "default",
  } = opts;

  const before = currentValue;
  const rolled = Math.floor(Math.random() * 100) + 1;
  let grown = false;
  let after = before;
  let gain = 0;

  if (rolled > before) {
    gain = Math.floor(Math.random() * 10) + 1;
    after = before + gain;
    grown = true;
  }

  const events = [];
  const at = new Date().toISOString();

  events.push({
    type: "RollPerformed",
    at,
    gameId,
    kind: "open",
    player: characterName,
    label: `技能成长：${skillName}`,
    skill: skillName,
    expression: "d100",
    dice: [rolled],
    rolled,
    total: rolled,
    target: before,
    difficulty: "regular",
    tier: grown ? "pass" : "fail",
    passed: grown,
  });

  if (grown) {
    events.push({
      type: "SkillGrown",
      at,
      gameId,
      character: characterName,
      skill: skillName,
      before,
      after,
      gain,
    });
  }

  return {
    before,
    after,
    rolled,
    grown,
    gain,
    events,
  };
}
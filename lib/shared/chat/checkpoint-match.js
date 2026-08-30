/**
 * 检定点匹配（Checkpoint Match）
 *
 * 从 chat-bridge 下沉到共享层，供两处使用：
 * 1. 聊天桥 `.ra` 掷骰后匹配剧本检定点；
 * 2. `coc_check` 登记门禁时直接写入 checkpointId（门禁从创建起就绑定检定点）。
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */

/**
 * 为一次检定寻找命中的剧本检定点。
 * 有动作文本时按 keys/trigger 打分；无动作文本时只在场景池里唯一匹配时才返回。
 * @param {object} flat
 * @param {string} skill
 * @param {string} difficulty
 * @param {string} action
 * @returns {object|null} 检定点
 */
export function findCheckpointMatch(flat, skill, difficulty, action) {
  const checks = (flat?.scenarioCheckpoints ?? []).filter(
    (check) => String(check?.skill ?? "").trim() === String(skill ?? "").trim() &&
      String(check?.difficulty ?? "regular") === String(difficulty ?? "regular")
  );
  if (checks.length === 0) return null;
  const scene = String(flat?.currentScene ?? "");
  const scenePool = checks.filter((check) => {
    const checkScene = String(check?.scene ?? "");
    const floor = String(check?.floor ?? "");
    return (
      checkScene.length === 0 ||
      scene.includes(checkScene) ||
      checkScene.includes(scene) ||
      (floor.length > 0 && scene.includes(floor))
    );
  });
  const pool = scenePool.length > 0 ? scenePool : checks;
  const actionText = String(action ?? "").trim();
  if (actionText.length === 0) {
    // 玩家只发 .ra技能 没写动作时，仅在唯一匹配时记录，避免误配多个检定点。
    return pool.length === 1 ? pool[0] : null;
  }
  let best = null;
  let bestScore = -1;
  for (const check of pool) {
    let score = 0;
    for (const key of check?.keys ?? []) {
      const word = String(key).trim();
      if (word.length >= 2 && actionText.includes(word)) score += 3;
    }
    const trigger = String(check?.trigger ?? "");
    if (actionText.length >= 2 && trigger.includes(actionText.slice(0, Math.min(8, actionText.length)))) {
      score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = check;
    }
  }
  if (bestScore <= 0 && pool.length !== 1) return null;
  return best ?? pool[0];
}

/**
 * 为检定结果寻找应揭示/应隐藏的剧本原文（显式检定点 trigger）。
 * @param {object} flat
 * @param {string} skill
 * @param {string} difficulty
 * @param {string} action
 * @returns {string|null} 检定点 trigger 原文
 */
export function findCheckpointReveal(flat, skill, difficulty, action) {
  const match = findCheckpointMatch(flat, skill, difficulty, action);
  return match !== null && typeof match?.trigger === "string" && match.trigger.trim().length > 0
    ? match.trigger
    : null;
}

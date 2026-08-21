/**
 * Knowledge 分层（World Truth / Player Knowledge / KP Secret）
 *
 * 核心原则：
 * - LLM 只能看到与其角色相匹配的信息，避免向玩家泄露未揭示剧情。
 * - 分层是纯函数：输入普通对象，输出普通对象，零 DSH 依赖。
 *
 * 层定义：
 * - "kp-full"：KP 完整视野（含未揭示关键点、暗骰数值、全部提醒）
 * - "player"  ：玩家视野（场景/时间/公开骰点/已揭示关键点/已抵达分支）
 * - "public"  ：公开摘要（适合面板标题栏等极简场景）
 */

export const KNOWLEDGE_LAYERS = Object.freeze({
  KP_FULL: "kp-full",
  PLAYER: "player",
  PUBLIC: "public",
});

/**
 * 判断一条骰点记录对某层是否可见。
 * 暗骰（kind === "secret"）仅 KP 完整视野可见。
 * @param {object} roll
 * @param {string} layer
 * @returns {boolean}
 */
export function isRollVisible(roll, layer) {
  if (layer === KNOWLEDGE_LAYERS.KP_FULL) return true;
  return roll?.kind !== "secret";
}

/**
 * 过滤骰点历史。
 * @param {Array<object>} rollHistory
 * @param {string} layer
 * @param {number} [limit=12]
 * @returns {Array<object>}
 */
export function filterRolls(rollHistory, layer, limit = 12) {
  return (rollHistory ?? [])
    .filter((roll) => isRollVisible(roll, layer))
    .slice(-limit)
    .reverse();
}

/**
 * 过滤关键剧情点。
 * - kp-full：全部
 * - 其他层：仅 revealed === true
 * @param {Array<object>} keyPoints
 * @param {string} layer
 * @returns {Array<object>}
 */
export function filterKeyPoints(keyPoints, layer) {
  const all = keyPoints ?? [];
  if (layer === KNOWLEDGE_LAYERS.KP_FULL) return all;
  return all.filter((kp) => kp?.revealed === true);
}

/**
 * 过滤分支。
 * - kp-full：全部
 * - player：仅已抵达（reached）分支
 * - public：无（面板极简视图不展示分支细节）
 * @param {Array<object>} branches
 * @param {string} layer
 * @returns {Array<object>}
 */
export function filterBranches(branches, layer) {
  const all = branches ?? [];
  if (layer === KNOWLEDGE_LAYERS.KP_FULL) return all;
  if (layer === KNOWLEDGE_LAYERS.PLAYER) return all.filter((b) => b?.reached === true);
  return [];
}

/**
 * 过滤提醒。
 * - kp-full：全部
 * - 其他层：空（提醒是 KP 内部信息）
 * @param {Array<object>} reminders
 * @param {string} layer
 * @returns {Array<object>}
 */
export function filterReminders(reminders, layer) {
  if (layer === KNOWLEDGE_LAYERS.KP_FULL) return reminders ?? [];
  return [];
}

/**
 * 过滤实体。
 * - kp-full：全部
 * - player：仅 scene 与当前场景一致或 scene 为空的实体（玩家能看到所在场景的 NPC/物品）
 * - public：仅实体名（用于面板摘要）
 * @param {Array<object>} entities
 * @param {string} layer
 * @param {string} [currentScene=""]
 * @returns {Array<object>}
 */
export function filterEntities(entities, layer, currentScene = "") {
  const all = entities ?? [];
  if (layer === KNOWLEDGE_LAYERS.KP_FULL) return all;
  if (layer === KNOWLEDGE_LAYERS.PUBLIC) {
    return all.map((e) => ({ id: e.id, type: e.type, name: e.name }));
  }
  return all.filter((e) => e?.scene === "" || e?.scene === undefined || e?.scene === currentScene);
}

/**
 * 构建知识分层视图。
 * @param {object} state - 普通对象，含 kpMode/currentScene/time/synopsis/rollHistory/keyPoints/branches/reminders/entities 等
 * @param {string} layer - kp-full / player / public
 * @returns {object}
 */
export function buildKnowledgeView(state, layer = KNOWLEDGE_LAYERS.PLAYER) {
  const view = {
    layer,
    title: state.title ?? state.id ?? "",
    kpMode: state.kpMode ?? "ai",
    currentScene: state.currentScene ?? "",
    time: state.time ?? "",
    synopsis: state.synopsis ?? "",
    rules: state.rules ?? null,
    scenario: state.scenario ?? null,
    characters: state.characters ?? [],
    tasks: state.tasks ?? [],
    entities: filterEntities(state.entities, layer, state.currentScene ?? ""),
    keyPoints: filterKeyPoints(state.keyPoints, layer),
    branches: filterBranches(state.branches, layer),
    reminders: filterReminders(state.reminders, layer),
    recentRolls: filterRolls(state.rollHistory, layer, state.maxRecentRolls ?? 12),
  };
  if (layer === KNOWLEDGE_LAYERS.KP_FULL) {
    view.currentBranchId = state.currentBranchId ?? "";
    view.toolTrace = (state.toolTrace ?? []).slice(-10).reverse();
    view.logLength = state.log?.length ?? 0;
  }
  return view;
}

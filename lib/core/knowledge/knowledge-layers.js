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
 * 清理文本中的“模组元叙事”措辞（如“是模组主要探索场景”“需要过 SAN check”）。
 * 实体/剧情点描述是给玩家看的游戏内信息，不应出现超出剧本维度的 GM 用语。
 * 纯函数：输入字符串，输出清理后的字符串。
 * @param {string} text
 * @returns {string}
 */
export function sanitizeMetaText(text) {
  if (typeof text !== "string") return "";
  let out = text;
  // “，是模组主要探索场景”等含“模组”的从句
  out = out.replace(/[，,、]\s*(?:是|为)?(?:本|该)?模组(?:的)?[^。；！？]*/g, "");
  // GM 指令式备注：“，需要过 SAN check”“，可进行侦查检定”等
  out = out.replace(/[，,（(]?\s*(?:需要?过?|可?进行|触发一次)?\s*(?:SAN|理智|侦查|聆听|潜行|灵感)[^。；！？]{0,24}(?:check|检定)[。．]?/gi, "");
  out = out.replace(/[，,、]\s*需要?过?\s*SAN\s*check[。．]?/gi, "");
  // 括号内的模组/玩家须知类元信息
  out = out.replace(/[（(][^）)]*(?:模组|SAN\s*check|玩家须知|调查员须知)[^）)]*[）)]/g, "");
  // 清理残留的句首/句尾标点
  out = out.replace(/^[，,、\s]+/g, "");
  out = out.replace(/[，,、\s]+$/g, "");
  out = out.replace(/[。．；;]+$/g, "");
  return out.trim();
}

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
 * - kp-full：全部（保留原始描述）
 * - 其他层：仅 revealed === true，且描述经 sanitizeMetaText 清理 GM 用语
 * @param {Array<object>} keyPoints
 * @param {string} layer
 * @returns {Array<object>}
 */
export function filterKeyPoints(keyPoints, layer) {
  const all = keyPoints ?? [];
  if (layer === KNOWLEDGE_LAYERS.KP_FULL) return all;
  return all
    .filter((kp) => kp?.revealed === true)
    .map((kp) => ({ ...kp, desc: sanitizeMetaText(kp.desc ?? kp.description ?? "") }));
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
 * - kp-full：全部（底牌：完整 desc/state/scene 等）
 * - player：仅 KP 显式揭示（revealed === true）的实体；只输出玩家认知字段
 *   （playerDesc/playerState），绝不回退到 KP 的 desc/state，避免整张底牌泄露。
 * - public：仅已揭示实体的名称（用于面板摘要）
 * @param {Array<object>} entities
 * @param {string} layer
 * @param {string} [currentScene=""]
 * @returns {Array<object>}
 */
export function filterEntities(entities, layer, currentScene = "") {
  const all = entities ?? [];
  if (layer === KNOWLEDGE_LAYERS.KP_FULL) return all;
  if (layer === KNOWLEDGE_LAYERS.PUBLIC) {
    return all
      .filter((e) => e?.revealed === true)
      .map((e) => ({ id: e.id, type: e.type, name: e.name }));
  }
  return all
    .filter((e) => e?.revealed === true)
    .map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      desc: sanitizeMetaText(e.playerDesc ?? ""),
      state: sanitizeMetaText(e.playerState ?? ""),
    }));
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

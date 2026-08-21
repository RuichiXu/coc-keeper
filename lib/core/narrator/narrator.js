/**
 * Narrator（AI KP 嘴）—— 叙述输出辅助
 *
 * 负责叙述文本的兜底、校验与最终格式。零 DSH 依赖。
 */

/**
 * 判断叙述文本是否有效（非空且不只是工具调用说明）。
 * @param {string} text
 * @returns {boolean}
 */
export function isNarrationComplete(text) {
  return typeof text === "string" && text.trim().length > 0;
}

/**
 * 格式化最终叙述：为空时按 finish 状态给兜底文案。
 * @param {string} rawNarration - LLM 输出的纯文本
 * @param {object} [finish] - LLM finish 状态 { kind, failure? }
 * @param {string} [fallbackText="（本轮未产生叙述，请再说一次你的行动）"]
 * @returns {string}
 */
export function formatNarration(rawNarration, finish, fallbackText = "（本轮未产生叙述，请再说一次你的行动）") {
  const text = String(rawNarration ?? "").trim();
  if (text.length > 0) return text;
  if (finish !== null && finish !== undefined && finish.kind === "error") {
    return `（模型调用失败：${finish.failure?.message ?? "未知错误"}）`;
  }
  return fallbackText;
}

/**
 * 截断过长叙述，避免撑爆日志。
 * @param {string} text
 * @param {number} [maxChars=4000]
 * @returns {string}
 */
export function clampNarration(text, maxChars = 4000) {
  const s = String(text ?? "");
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "…";
}

/**
 * 构建一条 KP 日志条目。
 * @param {number} seq
 * @param {string} at
 * @param {string} text
 * @returns {{ seq: number, at: string, kind: "kp", player: string, text: string }}
 */
export function makeKpLogEntry(seq, at, text) {
  return { seq, at, kind: "kp", player: "", text };
}

/**
 * 构建一条玩家日志条目。
 * @param {number} seq
 * @param {string} at
 * @param {string} text
 * @param {string} player
 * @returns {{ seq: number, at: string, kind: "user", player: string, text: string }}
 */
export function makeUserLogEntry(seq, at, text, player = "") {
  return { seq, at, kind: "user", player, text };
}

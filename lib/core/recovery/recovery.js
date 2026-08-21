/**
 * Narrative Recovery（叙事恢复）
 *
 * 纯函数，零 DSH 依赖。
 * 处理中断的聊天轮次：busy 卡死检测、恢复提示构建、最后叙述丢失检测。
 */

/**
 * 检测 busy 是否已过期（上次更新超过 staleMs）。
 * @param {object} state - { busy, updatedAt }
 * @param {string} nowIso
 * @param {number} [staleMs=5*60*1000]
 * @returns {boolean}
 */
export function isBusyStale(state, nowIso, staleMs = 5 * 60 * 1000) {
  if (state?.busy !== true) return false;
  const updatedAt = Date.parse(state?.updatedAt ?? "");
  if (!Number.isFinite(updatedAt)) return true;
  return Date.parse(nowIso) - updatedAt > staleMs;
}

/**
 * 构建恢复提示：让 KP 从最后状态续写。
 * @param {object} state
 * @returns {string}
 */
export function buildRecoveryPrompt(state) {
  const lastUser = [...(state?.log ?? [])].reverse().find((e) => e.kind === "user");
  const lastKp = [...(state?.log ?? [])].reverse().find((e) => e.kind === "kp");
  if (lastUser !== undefined && (lastKp === undefined || lastKp.seq < lastUser.seq)) {
    return `（系统恢复）上一轮「${lastUser.player ?? "玩家"}：${lastUser.text}」尚未得到 KP 回复。请基于当前状态快照继续叙述。`;
  }
  return "（系统恢复）检测到上一轮回复中断，请基于当前状态快照继续主持。";
}

/**
 * 检查叙述是否丢失：最后一条日志是 user 而不是 kp。
 * @param {object} state
 * @returns {boolean}
 */
export function hasMissingNarration(state) {
  const log = state?.log ?? [];
  if (log.length === 0) return false;
  const last = log[log.length - 1];
  return last.kind === "user";
}

/**
 * 从最近 toolTrace 提取摘要，辅助 KP 回忆刚发生的事。
 * @param {Array<object>} toolTrace
 * @param {number} [limit=6]
 * @returns {Array<string>}
 */
export function summarizeToolTrace(toolTrace, limit = 6) {
  return (toolTrace ?? [])
    .slice(-limit)
    .map((entry) => `${entry.tool ?? "?"}${entry.ok === false ? "（失败）" : ""}：${entry.text ?? ""}`.slice(0, 160));
}

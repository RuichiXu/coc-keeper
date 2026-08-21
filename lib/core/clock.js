/**
 * 游戏内时钟
 *
 * 纯函数，零外部依赖。从旧 index.js:128-151 提取，逻辑完全保留。
 *
 * 支持：
 * - 中文日期解析（「1925年10月1日 下午3点」）
 * - 时间推进（+1小时、+1天、到夜晚21点）
 * - 解析失败时在原时间后标注
 *
 * 未来扩展：
 * - 定时事件调度
 * - 与 Trigger Engine 集成
 */

// ── 解析 ──────────────────────────────────────────────────

/**
 * 解析中文日期时间文本。
 * 支持格式：
 * - 「1925年10月1日」
 * - 「1925年10月1日 下午3点」
 * - 「1925年10月1日 晚上9点」
 * - 「1925年10月1日 上午9点」
 *
 * @param {string} text
 * @returns {{ year: number, month: number, day: number, hour: number } | null}
 */
export function parseGameTime(text) {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  const m = /^(\d{1,4})年(\d{1,2})月(\d{1,2})日(?:\s*(上午|下午|晚上)?\s*(\d{1,2})?点?)?/.exec(
    text.trim()
  );
  if (m === null) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const period = m[4] ?? "";
  let hour = m[5] ? Number(m[5]) : 9;

  if (period === "下午" && hour < 12) hour += 12;
  else if (period === "晚上" && hour < 12) hour += 12;
  else if (period === "上午" && hour === 12) hour = 0;

  return { year, month, day, hour };
}

// ── 格式化 ────────────────────────────────────────────────

/**
 * 将 GameTime 格式化为中文文本。
 * 例如：{ year: 1925, month: 10, day: 1, hour: 15 } → "1925年10月1日 下午3点"
 *
 * @param {{ year: number, month: number, day: number, hour: number }} gt
 * @returns {string}
 */
export function formatGameTime(gt) {
  const h = gt.hour;
  const periodOut = h >= 18 ? "晚上" : h >= 12 ? "下午" : "上午";
  const hOut = h % 12 === 0 ? 12 : h % 12;
  return `${gt.year}年${gt.month}月${gt.day}日 ${periodOut}${hOut}点`;
}

// ── 时间推进 ──────────────────────────────────────────────

/**
 * 推进游戏内时间。
 *
 * @param {string} current - 当前时间文本（如「1925年10月1日 下午3点」）
 * @param {"hour"|"day"|"night"} mode - 推进模式
 * @returns {string} 推进后的时间文本
 *
 * 解析失败时，不报错，在原时间后标注推进操作。
 */
export function advanceGameTime(current, mode) {
  const label = mode === "hour" ? "+1小时" : mode === "day" ? "+1天" : "到夜晚";

  if (typeof current !== "string" || current.trim().length === 0) {
    return mode === "night"
      ? "1925年10月1日 晚上9点"
      : `1925年10月1日 上午9点（${label}）`;
  }

  const parsed = parseGameTime(current);
  if (parsed === null) {
    return `${current.trim()}（${label}）`;
  }

  const date = new Date(parsed.year, parsed.month - 1, parsed.day, parsed.hour, 0, 0);

  if (mode === "hour") date.setHours(date.getHours() + 1);
  else if (mode === "day") date.setDate(date.getDate() + 1);
  else if (mode === "night") date.setHours(21);

  return formatGameTime({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
  });
}

// ── 时间差计算 ────────────────────────────────────────────

/**
 * 计算两个 GameTime 之间的分钟差。
 * 返回 t2 - t1（正数表示 t2 晚于 t1）。
 *
 * @param {{ year: number, month: number, day: number, hour: number }} t1
 * @param {{ year: number, month: number, day: number, hour: number }} t2
 * @returns {number}
 */
export function minutesBetween(t1, t2) {
  const d1 = new Date(t1.year, t1.month - 1, t1.day, t1.hour, 0, 0);
  const d2 = new Date(t2.year, t2.month - 1, t2.day, t2.hour, 0, 0);
  return (d2.getTime() - d1.getTime()) / 60000;
}

/**
 * 判断 t1 是否在 t2 之后。
 * @param {{ year: number, month: number, day: number, hour: number }} t1
 * @param {{ year: number, month: number, day: number, hour: number }} t2
 * @returns {boolean}
 */
export function isAfter(t1, t2) {
  return minutesBetween(t2, t1) > 0;
}

/**
 * 判断 t1 是否在 t2 之前。
 * @param {{ year: number, month: number, day: number, hour: number }} t1
 * @param {{ year: number, month: number, day: number, hour: number }} t2
 * @returns {boolean}
 */
export function isBefore(t1, t2) {
  return minutesBetween(t1, t2) > 0;
}
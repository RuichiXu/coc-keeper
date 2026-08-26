/**
 * Game Clock 定时事件调度
 *
 * 纯函数，零 DSH 依赖。
 * 事件格式：{ id, at, text, fired }
 * - at：游戏内时间文本（如「1925年10月1日 下午3点」）
 * - 当游戏内时间达到或超过 at 且未 fired 时触发
 */
import { parseGameTime, isAfter } from "./clock.js";

/**
 * 比较两个游戏内时间文本。
 * @param {string} currentText
 * @param {string} atText
 * @returns {boolean} current 是否在 at 之后（含解析失败时 false）
 */
export function isTimeReached(currentText, atText) {
  const current = parseGameTime(currentText);
  const at = parseGameTime(atText);
  if (current === null || at === null) return false;
  return isAfter(current, at) || (current.year === at.year && current.month === at.month && current.day === at.day && current.hour === at.hour);
}

/**
 * 评估定时事件：返回已触发与待触发。
 * @param {Array<object>} events
 * @param {string} currentTime
 * @returns {{ fired: Array<object>, pending: Array<object> }}
 */
export function evaluateScheduledEvents(events, currentTime) {
  const fired = [];
  const pending = [];
  for (const event of events ?? []) {
    if (event.fired === true) continue;
    if (isTimeReached(currentTime, event.at)) fired.push(event);
    else pending.push(event);
  }
  return { fired, pending };
}

/**
 * 创建定时事件。
 * @param {string} id
 * @param {string} at
 * @param {string} text
 * @returns {{ id: string, at: string, text: string, fired: boolean }}
 */
export function createScheduledEvent(id, at, text) {
  return { id, at, text, fired: false };
}

/**
 * 标记事件已触发。
 * @param {Array<object>} events
 * @param {string} eventId
 * @returns {object|null}
 */
export function fireScheduledEvent(events, eventId) {
  const event = (events ?? []).find((e) => e.id === eventId);
  if (event === undefined) return null;
  event.fired = true;
  return event;
}

/**
 * 格式化定时事件为可读文本。
 * @param {object} event
 * @returns {string}
 */
export function formatScheduledEvent(event) {
  return `⏰ ${event.at}：${event.text}`;
}

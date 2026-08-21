/**
 * Game Event 系统
 *
 * 所有重要的世界状态变化都应通过 Game Event 表达。
 * Event 是 World State、Trigger、日志、回放、Debug、存档、UI 之间的公共连接层。
 *
 * 原则：
 * - 状态变化 = 发布 Event → WorldState.apply(event)
 * - Trigger = 订阅 Event + 检查 WorldState
 * - Trace = 记录所有 Event
 * - 回放 = 重放 Event 序列
 */

// ── EventBus 实现 ─────────────────────────────────────────

/**
 * 事件总线：发布/订阅 GameEvent。
 *
 * 用法：
 *   const bus = new EventBus();
 *   bus.subscribe("RollPerformed", (event) => { ... });
 *   bus.publish({ type: "RollPerformed", ... });
 */
export class EventBus {
  /** @type {Map<string, Set<Function>>} */
  #subscribers = new Map();
  /** @type {Array<object>} */
  #eventHistory = [];
  /** @type {number} */
  #maxHistory;

  /**
   * @param {number} [maxHistory=2000] 最大保留事件数
   */
  constructor(maxHistory = 2000) {
    this.#maxHistory = maxHistory;
  }

  /**
   * 发布事件
   * @param {object} event - 必须包含 type 字段
   */
  publish(event) {
    this.#eventHistory.push(event);
    if (this.#eventHistory.length > this.#maxHistory) {
      this.#eventHistory = this.#eventHistory.slice(-this.#maxHistory);
    }

    const handlers = this.#subscribers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          void handler(event);
        } catch (err) {
          console.error(`[EventBus] handler error for ${event.type}:`, err);
        }
      }
    }
  }

  /**
   * 订阅事件类型
   * @param {string} eventType - 事件类型名（如 "RollPerformed"）
   * @param {Function} handler - 处理函数 (event) => void
   * @returns {() => void} 取消订阅函数
   */
  subscribe(eventType, handler) {
    if (!this.#subscribers.has(eventType)) {
      this.#subscribers.set(eventType, new Set());
    }
    this.#subscribers.get(eventType).add(handler);

    return () => {
      this.#subscribers.get(eventType)?.delete(handler);
    };
  }

  /**
   * 返回所有已发布事件
   * @returns {ReadonlyArray<object>}
   */
  history() {
    return this.#eventHistory;
  }

  /**
   * 按类型过滤历史事件
   * @param {string} eventType
   * @returns {Array<object>}
   */
  historyOf(eventType) {
    return this.#eventHistory.filter((e) => e.type === eventType);
  }

  /** 清空历史（谨慎使用） */
  clearHistory() {
    this.#eventHistory = [];
  }
}
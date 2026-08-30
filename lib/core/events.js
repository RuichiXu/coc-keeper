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

// ── 事件目录（C-1）────────────────────────────────────────

/**
 * 事件类型目录。新增事件先在这里登记，再在 WorldState.applyEvent 里实现。
 */
export const GAME_EVENT_TYPES = Object.freeze([
  "RollPerformed",
  "SanitySettled",
  "CheckpointPassed",
  "GateCreated",
  "GateResolved",
  "GateFailed",
  "GateExpired",
  "SceneChanged",
  "TimeAdvanced",
  "KeyPointRevealed",
  "BranchLanded",
  "ItemAcquired",
  "SpellShown",
  "NightEventFired",
  "EndingResolved",
  // 既有事件（兼容旧代码）
  "DamageApplied",
  "SanityLost",
  "StateChanged",
  "ClueDiscovered",
  "EntityCreated",
  "EntityUpdated",
  "SkillGrown",
  "CharacterCreated",
  "ScenarioImported",
]);

export const GAME_EVENT_TYPE_SET = new Set(GAME_EVENT_TYPES);

/**
 * 每个事件类型必填字段（供 validateGameEvent 使用）。
 */
export const EVENT_REQUIRED_FIELDS = Object.freeze({
  RollPerformed: [],
  SanitySettled: ["player"],
  CheckpointPassed: ["checkpointId"],
  GateCreated: ["skill"],
  GateResolved: ["skill"],
  GateFailed: ["skill"],
  GateExpired: ["gateId"],
  SceneChanged: ["to"],
  TimeAdvanced: ["to"],
  KeyPointRevealed: ["keyPointId"],
  BranchLanded: ["branchId", "chosen"],
  ItemAcquired: ["item"],
  SpellShown: [],
  NightEventFired: ["eventId"],
  EndingResolved: ["branchId", "chosen"],
  DamageApplied: ["target", "hpAfter"],
  SanityLost: ["character", "sanAfter"],
  StateChanged: ["target", "changes"],
  ClueDiscovered: ["clueId"],
  EntityCreated: ["entityId"],
  EntityUpdated: ["entityId", "changes"],
  SkillGrown: ["character", "skill"],
  CharacterCreated: [],
  ScenarioImported: [],
});

/**
 * 校验事件结构，返回问题列表（空数组 = 合法）。
 * @param {object} event
 * @returns {string[]}
 */
export function validateGameEvent(event) {
  const issues = [];
  const type = String(event?.type ?? "");
  if (type.length === 0) {
    issues.push("事件缺少 type");
    return issues;
  }
  if (!GAME_EVENT_TYPE_SET.has(type)) {
    issues.push(`未知事件类型：${type}`);
    return issues;
  }
  for (const field of EVENT_REQUIRED_FIELDS[type] ?? []) {
    if (event[field] === undefined || event[field] === null || event[field] === "") {
      issues.push(`${type} 缺少必填字段 ${field}`);
    }
  }
  return issues;
}

/**
 * 构造一个已通过结构校验的事件对象（不分配 seq/id，由 EventLog 统一分配）。
 * @param {string} type
 * @param {object} fields
 * @param {object} [opts]
 * @param {string} [opts.at] - ISO 时间，默认当前时间
 * @returns {object}
 */
export function createGameEvent(type, fields, opts = {}) {
  const event = {
    type,
    at: opts.at ?? new Date().toISOString(),
    ...fields,
  };
  const issues = validateGameEvent(event);
  if (issues.length > 0) {
    throw new Error(`事件结构非法：${issues.join("；")}`);
  }
  return event;
}

// ── EventLog 实现（C-1 流水账）────────────────────────────

/**
 * 结构化事件流水账：自动分配 seq/id/at，支持按类型查询与 correlationId 串联因果链。
 *
 * 用法：
 *   const log = new EventLog();
 *   const evt = log.append({ type: "GateCreated", skill: "侦查", ... });
 *   log.query({ type: "GateCreated" });
 *   log.query({ correlationId: "evt-1" });
 */
export class EventLog {
  /** @type {Array<object>} */
  #entries = [];
  /** @type {number} */
  #max;
  /** @type {number} */
  #seq = 0;

  /**
   * @param {number} [max=4000] 最大保留事件数
   */
  constructor(max = 4000) {
    this.#max = max;
  }

  /**
   * 追加事件：校验结构、分配 id/seq/at（缺失时）。
   * @param {object} event
   * @returns {object} 已盖章的事件
   */
  append(event) {
    const issues = validateGameEvent(event);
    if (issues.length > 0) {
      throw new Error(`事件结构非法：${issues.join("；")}`);
    }
    this.#seq += 1;
    const stamped = {
      ...event,
      id: event.id ?? `evt-${this.#seq}`,
      seq: this.#seq,
      at: event.at ?? new Date().toISOString(),
    };
    this.#entries.push(stamped);
    if (this.#entries.length > this.#max) {
      this.#entries = this.#entries.slice(-this.#max);
    }
    return stamped;
  }

  /**
   * 查询事件。
   * @param {object} [opts]
   * @param {string} [opts.type] - 按类型过滤
   * @param {string} [opts.correlationId] - 按因果链 ID 过滤
   * @param {number} [opts.afterSeq] - 只取 seq 大于该值的事件
   * @param {number} [opts.limit] - 返回条数上限（默认全部）
   * @returns {Array<object>}
   */
  query(opts = {}) {
    let out = this.#entries.slice();
    if (opts.afterSeq !== undefined) {
      out = out.filter((entry) => entry.seq > opts.afterSeq);
    }
    if (opts.type !== undefined) {
      out = out.filter((entry) => entry.type === opts.type);
    }
    if (opts.correlationId !== undefined) {
      out = out.filter((entry) => entry.correlationId === opts.correlationId);
    }
    if (opts.limit !== undefined && opts.limit > 0) {
      out = out.slice(-opts.limit);
    }
    return out;
  }

  /** 全部事件（只读副本）。 */
  entries() {
    return this.#entries.slice();
  }

  /** 当前最大 seq。 */
  lastSeq() {
    return this.#seq;
  }

  /** 清空事件账本。 */
  clear() {
    this.#entries = [];
    this.#seq = 0;
  }

  /**
   * 导出为可序列化对象。
   * @returns {object}
   */
  toJSON() {
    return {
      seq: this.#seq,
      max: this.#max,
      entries: this.#entries.slice(),
    };
  }

  /**
   * 从纯对象恢复。
   * @param {object} data
   * @returns {EventLog}
   */
  static fromJSON(data) {
    const log = new EventLog(data?.max ?? 4000);
    log.#seq = data?.seq ?? 0;
    log.#entries = (data?.entries ?? []).slice();
    if (log.#entries.length > log.#max) {
      log.#entries = log.#entries.slice(-log.#max);
    }
    return log;
  }
}

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

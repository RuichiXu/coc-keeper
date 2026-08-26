/**
 * Trigger Engine（触发器引擎）
 *
 * 从状态中评估触发器条件，产出待触发/已触发结果。
 * Step 5 先支持场景提醒（reminders）与分支/关键点提示；
 * 后续可扩展 state 条件（HP/SAN 阈值）并接 EventBus 自动触发。
 *
 * 纯函数 + 类，零 DSH 依赖。
 */

export const TRIGGER_TYPES = Object.freeze({
  SCENE: "scene",
  BRANCH_PENDING: "branch-pending",
  KEYPOINT_PENDING: "keypoint-pending",
  STATE: "state",
});

/**
 * 评估单个触发器是否满足条件。
 * @param {object} trigger - { id, type, scene?, branchId?, keyPointId?, condition?, text, fired }
 * @param {object} state - 普通对象状态（currentScene/currentBranchId/branches/keyPoints 等）
 * @returns {boolean}
 */
export function evaluateTrigger(trigger, state) {
  if (trigger === null || trigger === undefined) return false;
  if (trigger.fired === true) return false;

  switch (trigger.type) {
    case TRIGGER_TYPES.SCENE:
      return trigger.scene === "" || trigger.scene === undefined || trigger.scene === state.currentScene;
    case TRIGGER_TYPES.BRANCH_PENDING: {
      const branch = (state.branches ?? []).find((b) => b.id === trigger.branchId);
      return branch !== undefined && branch.reached === true && branch.chosen === null;
    }
    case TRIGGER_TYPES.KEYPOINT_PENDING: {
      const kp = (state.keyPoints ?? []).find((k) => k.id === trigger.keyPointId);
      return kp !== undefined && kp.revealed === false && (kp.scene === "" || kp.scene === undefined || kp.scene === state.currentScene);
    }
    case TRIGGER_TYPES.STATE: {
      const cond = trigger.condition ?? {};
      const actual = cond.path?.split(".").reduce((obj, key) => (obj === null || obj === undefined ? undefined : obj[key]), state);
      switch (cond.op) {
        case "eq": return actual === cond.value;
        case "neq": return actual !== cond.value;
        case "lt": return Number(actual) < Number(cond.value);
        case "lte": return Number(actual) <= Number(cond.value);
        case "gt": return Number(actual) > Number(cond.value);
        case "gte": return Number(actual) >= Number(cond.value);
        case "contains": return Array.isArray(actual) && actual.includes(cond.value);
        default: return false;
      }
    }
    default:
      return false;
  }
}

/**
 * 评估一组触发器。
 * @param {Array<object>} triggers
 * @param {object} state
 * @returns {{ fired: Array<object>, pending: Array<object> }}
 */
export function evaluateTriggers(triggers, state) {
  const fired = [];
  const pending = [];
  for (const trigger of triggers ?? []) {
    if (evaluateTrigger(trigger, state)) fired.push(trigger);
    else if (trigger.fired !== true) pending.push(trigger);
  }
  return { fired, pending };
}

/**
 * 把 flat.reminders 转为 scene 触发器。
 * @param {Array<object>} reminders - { id, scene, text, fired }
 * @returns {Array<object>}
 */
export function remindersToTriggers(reminders) {
  return (reminders ?? []).map((r) => ({
    id: r.id,
    type: TRIGGER_TYPES.SCENE,
    scene: r.scene ?? "",
    text: r.text ?? "",
    fired: r.fired === true,
  }));
}

/**
 * 当前场景待触发的提醒（不含已 fired）。
 * @param {object} state
 * @returns {Array<object>}
 */
export function pendingReminders(state) {
  const triggers = remindersToTriggers(state.reminders);
  return evaluateTriggers(triggers, state).fired
    .filter((t) => t.fired !== true)
    .map((t) => ({ id: t.id, scene: t.scene, text: t.text }));
}

/**
 * 触发器引擎：持有规则，支持手动触发并记录历史。
 */
export class TriggerEngine {
  /**
   * @param {Array<object>} [triggers=[]]
   */
  constructor(triggers = []) {
    this.triggers = [...triggers];
    this.history = [];
  }

  /**
   * 评估当前状态，返回满足条件的触发器。
   * @param {object} state
   * @returns {Array<object>}
   */
  evaluate(state) {
    const { fired } = evaluateTriggers(this.triggers, state);
    return fired;
  }

  /**
   * 标记触发器已触发。
   * @param {string} triggerId
   * @returns {object|null}
   */
  fire(triggerId) {
    const trigger = this.triggers.find((t) => t.id === triggerId);
    if (trigger === undefined) return null;
    trigger.fired = true;
    this.history.push({ id: trigger.id, firedAt: new Date().toISOString() });
    return trigger;
  }
}

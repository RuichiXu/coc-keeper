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
  KEYPOINT_PREREQ: "keypoint-prereq",
  BRANCH_PREREQ: "branch-prereq",
  ENDING: "ending",
});

// ── 结构化前置条件（C-4：从 story-prereqs 并入 Trigger Engine） ──

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function phraseMatchedLocal(text, phrase) {
  const source = String(text ?? "");
  const needle = String(phrase ?? "");
  if (needle.length < 2) return false;
  let index = source.indexOf(needle);
  while (index !== -1) {
    const before = source.slice(Math.max(0, index - 4), index);
    if (!/(?:没|未|不|无|非|别|莫)/.test(before)) return true;
    index = source.indexOf(needle, index + 1);
  }
  return false;
}

function sanitySettledFor(sanitySettled, checkpointId) {
  const id = String(checkpointId ?? "");
  if (id.length === 0) return false;
  return asArray(sanitySettled).some((entry) => {
    const eventId = String(entry?.eventId ?? "");
    return eventId.includes(id) || eventId === `scenario:${id}`;
  });
}

/**
 * 评估单个条件组（与 story-prereqs 同语义，C-4 统一到这里）。
 * @param {object|null} requires
 * @param {object} ctx - { currentScene, playerText, narration, passedCheckpointIds, sanitySettled, keyPoints, branches }
 * @returns {boolean}
 */
export function evaluatePrerequisites(requires, ctx) {
  const req = requires ?? null;
  if (req === null || typeof req !== "object") return true;

  if (req.scene !== undefined && req.scene !== null) {
    const scene = String(req.scene ?? "").trim();
    if (scene.length > 0 && String(ctx.currentScene ?? "").trim() !== scene) return false;
  }

  if (asArray(req.entryEvidence).length > 0) {
    const combined = `${String(ctx.playerText ?? "")}\n${String(ctx.narration ?? "")}`;
    if (String(combined).trim().length > 0) {
      const hit = asArray(req.entryEvidence).some((phrase) => phraseMatchedLocal(combined, phrase));
      if (!hit) return false;
    }
  }

  const checkpointGroups = asArray(req.checkpointGroups);
  if (checkpointGroups.length > 0) {
    const passed = new Set(asArray(ctx.passedCheckpointIds).map(String));
    for (const group of checkpointGroups) {
      const ids = asArray(group);
      if (ids.length > 0 && !ids.some((id) => passed.has(String(id)))) return false;
    }
  }

  const sanityEventIds = asArray(req.sanityEventIds);
  if (sanityEventIds.length > 0 && !sanityEventIds.some((id) => sanitySettledFor(ctx.sanitySettled, id))) {
    return false;
  }

  const keyPointIds = asArray(req.keyPointIds);
  if (keyPointIds.length > 0) {
    const keyPoints = asArray(ctx.keyPoints);
    for (const id of keyPointIds) {
      const kp = keyPoints.find((entry) => String(entry?.id ?? "") === String(id));
      if (kp?.revealed !== true) return false;
    }
  }

  const branchChoiceIds = asArray(req.branchChoiceIds);
  if (branchChoiceIds.length > 0) {
    const branches = asArray(ctx.branches);
    for (const id of branchChoiceIds) {
      const branch = branches.find((entry) => String(entry?.id ?? "") === String(id));
      if (branch?.reached !== true || String(branch?.chosen ?? "").trim().length === 0) return false;
    }
  }

  // 选项级条件：必须与 branchChoiceIds 搭配，任一引用分支的已选选项命中即可。
  const optionLabels = typeof req.optionLabel === "string"
    ? [req.optionLabel]
    : asArray(req.optionLabel);
  if (optionLabels.length > 0) {
    if (branchChoiceIds.length === 0) return false;
    const branches = asArray(ctx.branches);
    const hit = branchChoiceIds.some((id) => {
      const branch = branches.find((entry) => String(entry?.id ?? "") === String(id));
      if (branch?.reached !== true) return false;
      const chosen = String(branch?.chosen ?? "").trim();
      if (chosen.length === 0) return false;
      return optionLabels.some((label) => {
        const text = String(label ?? "").trim();
        if (text.length === 0) return false;
        return chosen === text || chosen.includes(text) || text.includes(chosen);
      });
    });
    if (!hit) return false;
  }

  // 否定条件：not 内的条件满足时，本组条件不满足。
  if (req.not !== undefined && req.not !== null) {
    if (evaluatePrerequisites(req.not, ctx)) return false;
  }

  return true;
}

/**
 * 评估 requiresAnyOf：任意一组满足即通过（缺省通过）。
 * @param {object[]|undefined} requiresAnyOf
 * @param {object} ctx
 * @returns {boolean}
 */
export function evaluateRequiresAnyOf(requiresAnyOf, ctx) {
  const groups = asArray(requiresAnyOf);
  if (groups.length === 0) return true;
  return groups.some((group) => evaluatePrerequisites(group, ctx));
}

/**
 * 判断关键点/分支是否满足全部结构化前置条件。
 * @param {{ requires?: object, requiresAnyOf?: object[] } | null} target
 * @param {object} ctx
 * @returns {boolean}
 */
export function prerequisitesSatisfied(target, ctx) {
  const requires = target?.requires;
  const requiresAnyOf = target?.requiresAnyOf;
  if (requires === undefined && requiresAnyOf === undefined) return false;
  const baseHit = requires === undefined ? true : evaluatePrerequisites(requires, ctx);
  const anyHit = requiresAnyOf === undefined ? true : evaluateRequiresAnyOf(requiresAnyOf, ctx);
  return baseHit && anyHit;
}

/**
 * 从普通状态对象构建前置条件上下文。
 * @param {object} state
 * @returns {object}
 */
export function prerequisiteContextFromState(state) {
  return {
    currentScene: String(state?.currentScene ?? ""),
    playerText: String(state?.playerText ?? ""),
    narration: String(state?.narration ?? ""),
    passedCheckpointIds: asArray(state?.passedCheckpointIds),
    sanitySettled: asArray(state?.sanitySettled),
    keyPoints: asArray(state?.keyPoints),
    branches: asArray(state?.branches),
  };
}

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
    case TRIGGER_TYPES.KEYPOINT_PREREQ: {
      const kp = asArray(state.keyPoints).find((entry) => String(entry?.id ?? "") === String(trigger.keyPointId));
      if (kp === undefined || kp.revealed === true) return false;
      return prerequisitesSatisfied(kp, prerequisiteContextFromState(state));
    }
    case TRIGGER_TYPES.BRANCH_PREREQ: {
      const branch = asArray(state.branches).find((entry) => String(entry?.id ?? "") === String(trigger.branchId));
      if (branch === undefined || branch.reached === true) return false;
      return prerequisitesSatisfied(branch, prerequisiteContextFromState(state));
    }
    case TRIGGER_TYPES.ENDING:
      return state.endingReached === true;
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

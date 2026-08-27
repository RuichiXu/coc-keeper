/**
 * Scenario Contract 运行时校验器
 *
 * 在候选叙述落盘前，用剧本执行契约做确定性校验：
 * - 线索门禁：对应检定未通过前，KP 叙述不得出现受保护线索词
 * - NPC 知识边界：NPC 不得说出其 unknown 中的信息
 * - 仪式条件：叙述出现仪式完成/进行时，前置条件必须已满足
 * - 最终分支白名单：叙述进入某分支/结局时，该分支必须在白名单内
 * - 夜晚事件：入睡后触发剧本事件；不入睡时按 sleepPolicy 给出强制/惩罚提示
 *
 * 纯函数，零 DSH 依赖。
 */
import { normalizeScenarioContract } from "../../core/scenario/contract.js";

function asSet(value) {
  return value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);
}

/**
 * 判断线索门禁是否已通过。
 * @param {object} gate
 * @param {object} context
 * @returns {boolean}
 */
export function isClueGatePassed(gate, context) {
  const passedIds = asSet(context.passedGateIds);
  if (passedIds.has(gate.id) || (gate.gateCheckId.length > 0 && passedIds.has(gate.gateCheckId))) {
    return true;
  }
  const rolledSkills = asSet(context.rolledSkills);
  if (gate.skill.length > 0 && rolledSkills.has(gate.skill)) {
    return true;
  }
  if (gate.skill === "理智" && context.sanityChecked === true) {
    return true;
  }
  return false;
}

/**
 * 检查单个线索门禁在叙述中的泄露。
 * @param {object} gate
 * @param {string} narration
 * @param {object} context
 * @returns {string|null} 违规描述
 */
export function checkClueGate(gate, narration, context) {
  if (isClueGatePassed(gate, context)) return null;
  for (const word of gate.clueWords) {
    if (word.length >= 2 && narration.includes(word)) {
      return `线索门禁「${gate.id}」：叙述中出现受保护线索「${word}」，但对应检定尚未通过`;
    }
  }
  if (gate.protectedText.length > 0 && narration.includes(gate.protectedText)) {
    return `线索门禁「${gate.id}」：叙述中出现受保护内容「${gate.protectedText}」，但对应检定尚未通过`;
  }
  return null;
}

/**
 * 检查 NPC 知识边界。
 * @param {object} entry
 * @param {string} narration
 * @param {object} context
 * @returns {string|null}
 */
export function checkNpcKnowledge(entry, narration, context) {
  if (entry.unknown.length === 0) return null;
  if (!narration.includes(entry.npcName)) return null;
  const knownWords = new Set([
    ...asSet(entry.knows),
    ...asSet(context.knownClues),
    ...asSet(context.revealedKeyPoints),
  ]);
  for (const word of entry.unknown) {
    if (word.length === 0) continue;
    if (narration.includes(word) && !knownWords.has(word)) {
      return `NPC 知识边界「${entry.npcName}」：叙述让该 NPC 说出了其不应知晓的「${word}」`;
    }
  }
  return null;
}

function requirementSatisfied(requirement, context) {
  const value = String(requirement.value ?? "");
  if (value.length === 0) return true;
  const inventory = asSet(context.inventory);
  const knownClues = new Set([...asSet(context.knownClues), ...asSet(context.revealedKeyPoints)]);
  const participants = asSet(context.participants);

  switch (requirement.kind) {
    case "item":
      return [...inventory].some((item) => item.includes(value) || value.includes(item));
    case "location":
      return String(context.currentScene ?? "").includes(value);
    case "time":
      return String(context.time ?? "").includes(value);
    case "participant":
      return participants.has(value) || [...participants].some((name) => name.includes(value) || value.includes(name));
    case "clue":
      return [...knownClues].some((clue) => clue.includes(value) || value.includes(clue));
    case "keyPoint":
      return [...knownClues].some((clue) => clue.includes(value) || value.includes(clue));
    case "branchReached": {
      const branches = Array.isArray(context.branches) ? context.branches : [];
      if (String(context.currentBranchId ?? "") === value) return true;
      return branches.some(
        (branch) => String(branch?.id ?? "") === value && branch?.reached === true
      );
    }
    default:
      return true;
  }
}

/**
 * 检查仪式条件。
 * @param {object} ritual
 * @param {string} narration
 * @param {object} context
 * @returns {string|null}
 */
export function checkRitualConditions(ritual, narration, context) {
  if (ritual.keywords.length === 0) return null;
  const mentioned = ritual.keywords.some((word) => word.length >= 2 && narration.includes(word));
  if (!mentioned) return null;
  const missing = [];
  for (const requirement of ritual.requires) {
    if (!requirementSatisfied(requirement, context)) {
      missing.push(requirement.label);
    }
  }
  if (missing.length > 0) {
    return `仪式条件「${ritual.name}」未满足：缺少 ${missing.join("、")}`;
  }
  return null;
}

/**
 * 检查最终分支白名单。
 * @param {object} contract
 * @param {string} narration
 * @param {object} context
 * @returns {string|null}
 */
export function checkFinalBranchWhitelist(contract, narration, context) {
  const whitelist = contract.finalBranchWhitelist ?? [];
  if (whitelist.length === 0) return null;
  const text = String(narration ?? "");
  const branches = Array.isArray(context.branches) ? context.branches : [];
  const whitelistBranchIds = new Set(whitelist.map((entry) => entry.branchId).filter(Boolean));

  // 非白名单分支的标题一旦被推进，直接违规。
  for (const branch of branches) {
    const title = String(branch?.title ?? "").trim();
    if (title.length < 2 || !text.includes(title)) continue;
    const branchId = String(branch?.id ?? "");
    if (branchId.length > 0 && !whitelistBranchIds.has(branchId)) {
      return `最终分支白名单：叙述推进了分支「${title}」，但该分支不在白名单内`;
    }
  }

  // 白名单内条目：叙述触及结局关键词/结局 id 时，前置条件必须已满足。
  for (const entry of whitelist) {
    const branch = branches.find((item) => String(item?.id ?? "") === entry.branchId);
    const branchTitle = branch !== undefined ? String(branch.title ?? "").trim() : "";
    const endingTokens = [
      ...(entry.endingKeywords ?? []),
      ...entry.endingId.split("/").map((token) => token.trim()),
    ].filter((token) => token.length >= 2);
    const triggered =
      (branchTitle.length >= 2 && text.includes(branchTitle)) ||
      endingTokens.some((token) => text.includes(token));
    if (!triggered) continue;
    const missing = [];
    for (const requirement of entry.requires) {
      if (!requirementSatisfied(requirement, context)) {
        missing.push(requirement.label);
      }
    }
    if (missing.length > 0) {
      return `最终分支白名单「${entry.id}」：结局前置条件未满足，缺少 ${missing.join("、")}`;
    }
  }
  return null;
}

/**
 * 校验候选叙述是否违反剧本执行契约。
 * @param {object|undefined} contractInput
 * @param {string} narration
 * @param {object} context - {rolledSkills, sanityChecked, passedGateIds, revealedKeyPoints,
 *   currentScene, time, inventory, knownClues, participants, branches}
 * @returns {{ passed: boolean, violations: string[] }}
 */
export function validateCandidateNarration(contractInput, narration, context = {}) {
  const contract = normalizeScenarioContract(contractInput);
  const text = String(narration ?? "");
  const violations = [];

  for (const gate of contract.clueGates) {
    const violation = checkClueGate(gate, text, context);
    if (violation !== null) violations.push(violation);
  }
  for (const entry of contract.npcKnowledge) {
    const violation = checkNpcKnowledge(entry, text, context);
    if (violation !== null) violations.push(violation);
  }
  for (const ritual of contract.ritualConditions) {
    const violation = checkRitualConditions(ritual, text, context);
    if (violation !== null) violations.push(violation);
  }
  const branchViolation = checkFinalBranchWhitelist(contract, text, context);
  if (branchViolation !== null) violations.push(branchViolation);

  return { passed: violations.length === 0, violations };
}

/**
 * 评估夜晚事件。
 *
 * 设计约定：夜晚事件与时钟不是严格绑定。调查员入睡（或叙述中出现入睡）后触发
 * onSleep 事件；onTime 事件才按 time 匹配。调查员在“有 onSleep 事件的夜晚”选择
 * 不入睡时，返回 forcedSleep 提示（KP 强制入睡或给予惩罚）。
 *
 * @param {object|undefined} contractInput
 * @param {object} context - {time, sleeping, narrationMentionsSleep, firedNightEventIds}
 * @returns {{ fired: object[], forcedSleep: object|null }}
 */
export function evaluateNightEvents(contractInput, context = {}) {
  const contract = normalizeScenarioContract(contractInput);
  const fired = [];
  const firedIds = new Set(asSet(context.firedNightEventIds));
  const time = String(context.time ?? "");
  const currentScene = String(context.currentScene ?? "");
  const isNight = /(?:夜|午夜|子夜|凌晨|晚上)/.test(time);
  const wantsSleep = context.sleeping === true || context.narrationMentionsSleep === true;
  const sceneMatches = (event) =>
    String(event.scene ?? "").trim().length === 0 ||
    currentScene.includes(String(event.scene ?? "").trim()) ||
    String(event.scene ?? "").trim().includes(currentScene);

  for (const event of contract.nightEvents) {
    if (firedIds.has(event.id)) continue;
    if (event.trigger === "onTime") {
      if (isNight && event.nightLabel.length > 0 && time.includes(event.nightLabel)) {
        fired.push(event);
      }
      continue;
    }
    // onSleep：只有调查员入睡（或叙述中出现入睡）且事件场景与当前场景匹配才触发。
    if (wantsSleep && sceneMatches(event)) fired.push(event);
  }

  let forcedSleep = null;
  if (isNight && !wantsSleep) {
    const pendingForce = contract.nightEvents.find(
      (event) =>
        event.trigger === "onSleep" &&
        event.sleepPolicy === "force" &&
        !firedIds.has(event.id) &&
        sceneMatches(event)
    );
    if (pendingForce !== undefined) {
      forcedSleep = {
        eventId: pendingForce.id,
        title: pendingForce.title,
        sleepPolicy: pendingForce.sleepPolicy,
        penaltyText: pendingForce.penaltyText,
        reason: "今夜有剧本事件；调查员若不入睡，KP 应强制入睡或给予大惩罚",
      };
    }
  }

  return { fired, forcedSleep };
}

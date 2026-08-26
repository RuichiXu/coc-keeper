/**
 * Scenario Contract（剧本执行契约）
 *
 * 把剧本中“程序必须强制保证”的规则从叙事中抽出，形成可校验的结构化契约：
 * - clueGates：线索门禁（哪些词在对应检定通过前不得出现在 KP 叙述中）
 * - npcKnowledge：NPC 知识边界（NPC 不能说出其 unknown 中的信息）
 * - ritualConditions：仪式/关键事件的前置条件
 * - nightEvents：夜晚事件（默认调查员入睡后触发；不入睡按 sleepPolicy 处理）
 * - finalBranchWhitelist：最终分支白名单（哪些分支允许抵达哪些结局）
 *
 * 纯数据 + 纯函数，零 DSH 依赖。
 */

export const SCENARIO_CONTRACT_VERSION = 1;

/**
 * 创建空契约。
 * @param {object} [overrides]
 * @returns {object}
 */
export function createScenarioContract(overrides = {}) {
  return {
    version: SCENARIO_CONTRACT_VERSION,
    clueGates: [],
    npcKnowledge: [],
    ritualConditions: [],
    nightEvents: [],
    finalBranchWhitelist: [],
    ...overrides,
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRequirement(req) {
  const value = String(req?.value ?? "").trim();
  return {
    kind: String(req?.kind ?? "item").trim() || "item",
    value,
    label: String(req?.label ?? value).trim() || value,
  };
}

/**
 * 归一化契约：补齐字段、过滤无效条目，保证运行时校验的输入形状稳定。
 * @param {object} input
 * @returns {object}
 */
export function normalizeScenarioContract(input) {
  const raw = input ?? {};

  const clueGates = asArray(raw.clueGates)
    .map((gate, index) => ({
      id: String(gate?.id ?? `cg-${index + 1}`),
      title: String(gate?.title ?? ""),
      clueWords: asArray(gate?.clueWords).map(String).map((word) => word.trim()).filter(Boolean),
      protectedText: String(gate?.protectedText ?? "").trim(),
      gateCheckId: String(gate?.gateCheckId ?? ""),
      skill: String(gate?.skill ?? ""),
      scene: String(gate?.scene ?? ""),
      revealWhen: gate?.revealWhen === "none" ? "none" : String(gate?.revealWhen ?? "checkPassed"),
    }))
    .filter((gate) => gate.clueWords.length > 0 || gate.protectedText.length > 0);

  const npcKnowledge = asArray(raw.npcKnowledge)
    .map((entry, index) => ({
      id: String(entry?.id ?? `nk-${index + 1}`),
      npcName: String(entry?.npcName ?? "").trim(),
      npcIds: asArray(entry?.npcIds).map(String).filter(Boolean),
      knows: asArray(entry?.knows).map(String).map((word) => word.trim()).filter(Boolean),
      unknown: asArray(entry?.unknown).map(String).map((word) => word.trim()).filter(Boolean),
    }))
    .filter((entry) => entry.npcName.length > 0);

  const ritualConditions = asArray(raw.ritualConditions)
    .map((ritual, index) => ({
      id: String(ritual?.id ?? `rc-${index + 1}`),
      name: String(ritual?.name ?? "").trim(),
      keywords: asArray(ritual?.keywords).map(String).map((word) => word.trim()).filter(Boolean),
      requires: asArray(ritual?.requires).map(normalizeRequirement).filter((req) => req.value.length > 0),
    }))
    .filter((ritual) => ritual.name.length > 0 && ritual.requires.length > 0);

  const nightEvents = asArray(raw.nightEvents)
    .map((event, index) => ({
      id: String(event?.id ?? `ne-${index + 1}`),
      title: String(event?.title ?? "").trim(),
      scene: String(event?.scene ?? "").trim(),
      nightLabel: String(event?.nightLabel ?? "").trim(),
      trigger: event?.trigger === "onTime" ? "onTime" : "onSleep",
      sleepPolicy: ["force", "penalty", "allow"].includes(event?.sleepPolicy) ? event.sleepPolicy : "force",
      penaltyText: String(event?.penaltyText ?? "").trim(),
      effect: String(event?.effect ?? "").trim(),
      eventText: String(event?.eventText ?? "").trim(),
    }))
    .filter((event) => event.title.length > 0 || event.effect.length > 0);

  const finalBranchWhitelist = asArray(raw.finalBranchWhitelist)
    .map((entry, index) => ({
      id: String(entry?.id ?? `fb-${index + 1}`),
      branchId: String(entry?.branchId ?? "").trim(),
      endingId: String(entry?.endingId ?? "").trim(),
      requires: asArray(entry?.requires).map(normalizeRequirement).filter((req) => req.value.length > 0),
    }))
    .filter((entry) => entry.branchId.length > 0 || entry.endingId.length > 0);

  return {
    version: SCENARIO_CONTRACT_VERSION,
    status: raw.status,
    source: raw.source,
    reviewed: raw.reviewed === true,
    clueGates,
    npcKnowledge,
    ritualConditions,
    nightEvents,
    finalBranchWhitelist,
  };
}

/**
 * 校验契约结构，返回问题列表（空数组 = 结构可用）。
 * @param {object} contract
 * @returns {string[]}
 */
export function validateScenarioContract(contract) {
  const issues = [];
  const normalized = normalizeScenarioContract(contract);
  if (normalized.version !== SCENARIO_CONTRACT_VERSION) {
    issues.push(`version 应为 ${SCENARIO_CONTRACT_VERSION}，实际 ${normalized.version}`);
  }
  // 结构问题应基于原始输入报告：归一化会过滤掉无效条目，不能因此掩盖问题。
  for (const gate of asArray(contract?.clueGates)) {
    const words = asArray(gate?.clueWords).map(String).filter((word) => word.trim().length > 0);
    const protectedText = String(gate?.protectedText ?? "").trim();
    if (words.length === 0 && protectedText.length === 0) {
      issues.push(`线索门禁 ${gate?.id ?? "?"} 没有 clueWords/protectedText`);
    }
  }
  for (const entry of asArray(contract?.npcKnowledge)) {
    const knows = asArray(entry?.knows).map(String).filter(Boolean);
    const unknown = asArray(entry?.unknown).map(String).filter(Boolean);
    if (String(entry?.npcName ?? "").trim().length > 0 && knows.length === 0 && unknown.length === 0) {
      issues.push(`NPC 知识条目 ${entry?.id ?? "?"} 的 knows/unknown 都为空（不生效）`);
    }
  }
  for (const ritual of asArray(contract?.ritualConditions)) {
    const requires = asArray(ritual?.requires).filter((req) => String(req?.value ?? "").trim().length > 0);
    if (String(ritual?.name ?? "").trim().length > 0 && requires.length === 0) {
      issues.push(`仪式条件 ${ritual?.id ?? "?"} 没有 requires`);
    }
  }
  return issues;
}

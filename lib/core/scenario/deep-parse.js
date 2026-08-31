/**
 * 深度剧本解析（D 阶段）：LLM 生成多线剧情图与结局条件。
 *
 * 与 contract-ai.js 同一模式：纯 Prompt + 解析 + 校验，零 DSH 依赖，
 * 不直接调用 LLM。导入链路通过 deps.callLlmApi 调用后把结果交给本模块解析。
 *
 * 产物结构（deepParse）：
 * {
 *   version: "1.0",
 *   keyPointConditions: [{ keyPointId, requires?, requiresAnyOf? }],
 *   branchConditions:   [{ branchId, requires?, requiresAnyOf?, autoChooseLabel? }],
 *   plotEdges:          [{ from, to, label?, requires?, consequences? }],
 *   endings:            [{ id?, branchId, title, optionLabel?, requires?, blockers?, endingKeywords? }]
 * }
 *
 * 条件对象沿用 B-3/C-4 的运行时 schema：
 *   scene / entryEvidence / checkpointGroups / sanityEventIds / keyPointIds / branchChoiceIds
 *
 * 本模块只负责“草稿”的生成与校验；确认后才允许进入运行时（D-2/D-4 接入）。
 */

export const DEEP_PARSE_VERSION = "1.0";

const CONDITION_KEYS = Object.freeze([
  "scene",
  "entryEvidence",
  "checkpointGroups",
  "sanityEventIds",
  "keyPointIds",
  "branchChoiceIds",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

/**
 * 校验单个前置条件对象。
 * @param {object|null} cond
 * @param {string} label - 用于报错定位
 * @returns {string[]} 问题列表
 */
export function validateConditionObject(cond, label = "condition") {
  const issues = [];
  if (cond === null || cond === undefined) return issues;
  if (typeof cond !== "object" || Array.isArray(cond)) {
    issues.push(`${label} 必须是对象`);
    return issues;
  }

  const keys = Object.keys(cond);
  if (keys.length === 0) {
    issues.push(`${label} 不能为空对象（空条件会被视为“立即满足”）`);
    return issues;
  }
  for (const key of keys) {
    if (!CONDITION_KEYS.includes(key)) {
      issues.push(`${label} 含未知字段 ${key}（允许：${CONDITION_KEYS.join(" / ")}）`);
    }
  }

  if (cond.scene !== undefined && cond.scene !== null && typeof cond.scene !== "string") {
    issues.push(`${label}.scene 必须是字符串`);
  }
  if (cond.entryEvidence !== undefined && cond.entryEvidence !== null) {
    if (!Array.isArray(cond.entryEvidence) || cond.entryEvidence.some((item) => nonEmptyString(item).length === 0)) {
      issues.push(`${label}.entryEvidence 必须是非空字符串数组`);
    }
  }
  if (cond.checkpointGroups !== undefined && cond.checkpointGroups !== null) {
    if (!Array.isArray(cond.checkpointGroups) || cond.checkpointGroups.length === 0) {
      issues.push(`${label}.checkpointGroups 必须是非空数组（组内 OR、组间 AND）`);
    } else {
      for (const group of cond.checkpointGroups) {
        if (!Array.isArray(group) || group.length === 0 || group.some((id) => nonEmptyString(id).length === 0)) {
          issues.push(`${label}.checkpointGroups 每项必须是非空字符串数组`);
          break;
        }
      }
    }
  }
  for (const listKey of ["sanityEventIds", "keyPointIds", "branchChoiceIds"]) {
    if (cond[listKey] !== undefined && cond[listKey] !== null) {
      if (!Array.isArray(cond[listKey]) || cond[listKey].length === 0 || cond[listKey].some((id) => nonEmptyString(id).length === 0)) {
        issues.push(`${label}.${listKey} 必须是非空字符串数组`);
      }
    }
  }

  return issues;
}

/**
 * 校验 requires + requiresAnyOf 组合（任一存在即合法；都缺省时报错）。
 * @param {object} entry - 含 requires/requiresAnyOf 的条目
 * @param {string} label
 * @returns {string[]}
 */
export function validatePrerequisitePair(entry, label) {
  const issues = [];
  const hasRequires = entry?.requires !== undefined && entry?.requires !== null;
  const hasAnyOf = entry?.requiresAnyOf !== undefined && entry?.requiresAnyOf !== null;

  if (!hasRequires && !hasAnyOf) {
    issues.push(`${label} 必须提供 requires 或 requiresAnyOf`);
    return issues;
  }

  issues.push(...validateConditionObject(entry.requires, `${label}.requires`));
  if (entry.requiresAnyOf !== undefined && entry.requiresAnyOf !== null) {
    if (!Array.isArray(entry.requiresAnyOf) || entry.requiresAnyOf.length === 0) {
      issues.push(`${label}.requiresAnyOf 必须是非空数组`);
    } else {
      for (let index = 0; index < entry.requiresAnyOf.length; index += 1) {
        issues.push(...validateConditionObject(entry.requiresAnyOf[index], `${label}.requiresAnyOf[${index}]`));
      }
    }
  }
  return issues;
}

/**
 * 归一化 LLM 返回的深度解析对象，只保留本模块认识的字段。
 * @param {object|null} raw
 * @returns {object} 归一化后的 deepParse
 */
export function normalizeDeepParse(raw) {
  const source = raw ?? {};
  return {
    version: nonEmptyString(source.version) || DEEP_PARSE_VERSION,
    keyPointConditions: asArray(source.keyPointConditions).map((entry) => ({
      keyPointId: nonEmptyString(entry?.keyPointId),
      ...(entry?.requires !== undefined ? { requires: entry.requires } : {}),
      ...(entry?.requiresAnyOf !== undefined ? { requiresAnyOf: asArray(entry.requiresAnyOf) } : {}),
    })),
    branchConditions: asArray(source.branchConditions).map((entry) => ({
      branchId: nonEmptyString(entry?.branchId),
      ...(entry?.requires !== undefined ? { requires: entry.requires } : {}),
      ...(entry?.requiresAnyOf !== undefined ? { requiresAnyOf: asArray(entry.requiresAnyOf) } : {}),
      ...(entry?.autoChooseLabel !== undefined ? { autoChooseLabel: nonEmptyString(entry.autoChooseLabel) } : {}),
    })),
    plotEdges: asArray(source.plotEdges).map((entry) => ({
      from: nonEmptyString(entry?.from),
      to: nonEmptyString(entry?.to),
      ...(entry?.label !== undefined ? { label: nonEmptyString(entry.label) } : {}),
      ...(entry?.requires !== undefined ? { requires: asArray(entry.requires) } : {}),
      ...(entry?.consequences !== undefined && entry?.consequences !== null ? { consequences: entry.consequences } : {}),
    })),
    endings: asArray(source.endings).map((entry) => ({
      id: nonEmptyString(entry?.id),
      branchId: nonEmptyString(entry?.branchId),
      title: nonEmptyString(entry?.title),
      ...(entry?.optionLabel !== undefined ? { optionLabel: nonEmptyString(entry.optionLabel) } : {}),
      ...(entry?.requires !== undefined && entry?.requires !== null ? { requires: entry.requires } : {}),
      ...(entry?.blockers !== undefined ? { blockers: asArray(entry.blockers) } : {}),
      ...(entry?.endingKeywords !== undefined ? { endingKeywords: asArray(entry.endingKeywords).map((item) => nonEmptyString(item)).filter((item) => item.length > 0) } : {}),
    })),
  };
}

/**
 * 校验深度解析对象。flat 可选：传入时额外校验 ID 是否存在于当前剧本结构。
 * @param {object} deepParse
 * @param {object} [flat] - { keyPoints, branches }
 * @returns {string[]} 问题列表（空数组 = 合法）
 */
export function validateDeepParse(deepParse, flat) {
  const issues = [];
  if (deepParse === null || deepParse === undefined || typeof deepParse !== "object" || Array.isArray(deepParse)) {
    return ["deepParse 必须是对象"];
  }

  const keyPointIds = new Set(asArray(flat?.keyPoints).map((kp) => String(kp?.id ?? "")).filter((id) => id.length > 0));
  const branchIds = new Set(asArray(flat?.branches).map((branch) => String(branch?.id ?? "")).filter((id) => id.length > 0));

  for (let index = 0; index < asArray(deepParse.keyPointConditions).length; index += 1) {
    const entry = deepParse.keyPointConditions[index];
    const label = `keyPointConditions[${index}]`;
    if (nonEmptyString(entry?.keyPointId).length === 0) {
      issues.push(`${label}.keyPointId 不能为空`);
    } else if (keyPointIds.size > 0 && !keyPointIds.has(String(entry.keyPointId))) {
      issues.push(`${label}.keyPointId 不存在于当前 keyPoints：${entry.keyPointId}`);
    }
    issues.push(...validatePrerequisitePair(entry, label));
  }

  for (let index = 0; index < asArray(deepParse.branchConditions).length; index += 1) {
    const entry = deepParse.branchConditions[index];
    const label = `branchConditions[${index}]`;
    if (nonEmptyString(entry?.branchId).length === 0) {
      issues.push(`${label}.branchId 不能为空`);
    } else if (branchIds.size > 0 && !branchIds.has(String(entry.branchId))) {
      issues.push(`${label}.branchId 不存在于当前 branches：${entry.branchId}`);
    }
    issues.push(...validatePrerequisitePair(entry, label));
    if (entry?.autoChooseLabel !== undefined && nonEmptyString(entry.autoChooseLabel).length === 0) {
      issues.push(`${label}.autoChooseLabel 必须是非空字符串`);
    }
  }

  for (let index = 0; index < asArray(deepParse.plotEdges).length; index += 1) {
    const edge = deepParse.plotEdges[index];
    const label = `plotEdges[${index}]`;
    if (nonEmptyString(edge?.from).length === 0) issues.push(`${label}.from 不能为空`);
    if (nonEmptyString(edge?.to).length === 0) issues.push(`${label}.to 不能为空`);
    if (edge?.requires !== undefined) {
      for (let condIndex = 0; condIndex < asArray(edge.requires).length; condIndex += 1) {
        issues.push(...validateConditionObject(edge.requires[condIndex], `${label}.requires[${condIndex}]`));
      }
    }
    if (edge?.consequences !== undefined && edge?.consequences !== null && (typeof edge.consequences !== "object" || Array.isArray(edge.consequences))) {
      issues.push(`${label}.consequences 必须是对象`);
    }
  }

  for (let index = 0; index < asArray(deepParse.endings).length; index += 1) {
    const ending = deepParse.endings[index];
    const label = `endings[${index}]`;
    if (nonEmptyString(ending?.branchId).length === 0) {
      issues.push(`${label}.branchId 不能为空`);
    } else if (branchIds.size > 0 && !branchIds.has(String(ending.branchId))) {
      issues.push(`${label}.branchId 不存在于当前 branches：${ending.branchId}`);
    }
    if (nonEmptyString(ending?.title).length === 0) issues.push(`${label}.title 不能为空`);
    if (ending?.requires !== undefined && ending?.requires !== null) {
      issues.push(...validateConditionObject(ending.requires, `${label}.requires`));
    }
    for (let blockerIndex = 0; blockerIndex < asArray(ending?.blockers).length; blockerIndex += 1) {
      issues.push(...validateConditionObject(ending.blockers[blockerIndex], `${label}.blockers[${blockerIndex}]`));
    }
    if (ending?.endingKeywords !== undefined && (!Array.isArray(ending.endingKeywords) || ending.endingKeywords.some((item) => nonEmptyString(item).length === 0))) {
      issues.push(`${label}.endingKeywords 必须是非空字符串数组`);
    }
  }

  return issues;
}

/**
 * 构建深度解析 Prompt。
 * @param {object} flat - { scenario:{text,name}, scenarioCheckpoints?, scenarioFacts?, entities?, keyPoints?, branches? }
 * @returns {string}
 */
export function buildDeepParsePrompt(flat) {
  const text = String(flat?.scenario?.text ?? "");
  const name = String(flat?.scenario?.name ?? "剧本");
  const grounded = {
    checkpoints: asArray(flat?.scenarioCheckpoints).map((item) => ({
      id: item.id ?? "",
      skill: item.skill ?? "",
      trigger: item.trigger ?? "",
      keys: item.keys ?? [],
      scene: item.scene ?? "",
      floor: item.floor ?? "",
    })),
    keyPoints: asArray(flat?.keyPoints).map((item) => ({
      id: item.id ?? "",
      title: item.title ?? "",
      scene: item.scene ?? "",
    })),
    branches: asArray(flat?.branches).map((branch) => ({
      id: branch.id ?? "",
      title: branch.title ?? "",
      scene: branch.scene ?? "",
      options: asArray(branch.options).map((option) => ({
        label: option.label ?? "",
        leadsTo: option.leadsTo ?? "",
      })),
    })),
  };

  return [
    `你是 CoC 跑团剧本的结构化专家。请阅读剧本《${name}》的原文，输出该剧本的「深度剧情解析」JSON，用于驱动多线剧情图与结局条件。`,
    ``,
    `只输出一个 JSON 对象（不要 Markdown 代码块），结构如下：`,
    `{`,
    `  "keyPointConditions": [{"keyPointId":"kp-1","requires":{"checkpointGroups":[["chk-1","chk-2"]]},"requiresAnyOf":[{"keyPointIds":["kp-2"]}]}],`,
    `  "branchConditions": [{"branchId":"br-1","requires":{"sanityEventIds":["chk-9"]},"autoChooseLabel":"掀开地毯查看"}],`,
    `  "plotEdges": [{"from":"br:br-1","to":"kp:kp-3","label":"撞门","requires":[],"consequences":{"setFlags":{"branch:br-1:chosen":"撞门"}}}],`,
    `  "endings": [{"id":"end-1","branchId":"br-3","title":"墨渊消散的结局","optionLabel":"逆序念诵（送神）","requires":{"keyPointIds":["kp-7"],"branchChoiceIds":["br-3"]},"blockers":[{"branchChoiceIds":["br-3"]}],"endingKeywords":["墨渊消散","送神"]}]`,
    `}`,
    ``,
    `字段说明与约束：`,
    `- 条件对象只允许这些字段（可组合，缺省字段不检查）：`,
    `  scene: 当前场景必须精确等于该字符串。`,
    `  entryEvidence: 文本中需出现至少一个进门证据短语（空文本豁免）。`,
    `  checkpointGroups: 检定点组数组；组内 OR，组间 AND。`,
    `  sanityEventIds: SAN 结算事件 ID，命中任意一个即满足。`,
    `  keyPointIds: 这些关键点必须全部已揭示。`,
    `  branchChoiceIds: 这些分支必须全部 reached 且已选择。`,
    `- keyPointConditions / branchConditions：给现有关键点/分支补挂 requires / requiresAnyOf；ID 必须引用下面“结构化参考”里的 id。`,
    `- autoChooseLabel：事件落地时优先选择的选项 label 子串。`,
    `- plotEdges：剧情图有向边。from/to 使用 br:<branchId> / kp:<keyPointId> / end:<branchId>:<n> 形式；`,
    `  label 一般是对应分支选项文本；consequences 用 {setFlags:{key:value}} 形式表达进入后的世界事实变化。`,
    `- endings：结局节点。branchId 是对应的最终分支；requires 是抵达结局必须满足的条件；`,
    `  blockers 是阻断条件数组（命中任意一个即不可抵达）；endingKeywords 是叙述中出现即视为进入结局的关键词。`,
    `- 不确定的条件宁可不写，也不要编造空条件。`,
    ``,
    `剧本结构化参考（已有草拟，供你校正）：`,
    JSON.stringify(grounded, null, 2),
    ``,
    `剧本原文：`,
    text.slice(0, 30000),
  ].join("\n");
}

/**
 * 解析 LLM 返回的深度解析 JSON。
 * @param {string} rawText
 * @param {object} [flat] - 传入时校验 ID 引用
 * @returns {{ deepParse: object|null, issues: string[], raw: string }}
 */
export function parseDeepParseResult(rawText, flat) {
  let source = String(rawText ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fenced) source = fenced[1];
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { deepParse: null, issues: ["LLM 返回中没有 JSON 对象"], raw: source.slice(0, 400) };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    return { deepParse: null, issues: [`JSON 解析失败：${error.message}`], raw: source.slice(0, 400) };
  }
  const deepParse = normalizeDeepParse(parsed);
  const issues = validateDeepParse(deepParse, flat);
  return { deepParse, issues, raw: source.slice(0, 400) };
}

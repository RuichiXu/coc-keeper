/**
 * 深度剧本解析（D 阶段）：LLM 生成多线剧情图与结局条件。
 *
 * 与 contract-ai.js 同一模式：纯 Prompt + 解析 + 校验，零 DSH 依赖，
 * 不直接调用 LLM。导入链路通过 deps.callLlmApi 调用后把结果交给本模块解析。
 *
 * 产物结构（deepParse）：
 * {
 *   version: "1.0",
 *   keyPoints:   [{ id, title, scene?, desc? }],                    // 确定性草拟为空时由 LLM 生成新节点
 *   branches:    [{ id, title, scene?, desc?, options:[{label,leadsTo}] }],
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

import { buildDeterministicSkeleton } from "./deterministic-skeleton.js";
import { extractFinalChoiceBranches } from "./final-branch-extractor.js";

export const DEEP_PARSE_VERSION = "1.0";

export const CONDITION_KEYS = Object.freeze([
  "scene",
  "entryEvidence",
  "checkpointGroups",
  "sanityEventIds",
  "keyPointIds",
  "branchChoiceIds",
  "optionLabel",
  "not",
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

  if (cond.optionLabel !== undefined && cond.optionLabel !== null) {
    const labels = typeof cond.optionLabel === "string" ? [cond.optionLabel] : asArray(cond.optionLabel);
    if (labels.length === 0 || labels.some((item) => nonEmptyString(item).length === 0)) {
      issues.push(`${label}.optionLabel 必须是非空字符串或非空字符串数组`);
    } else if (asArray(cond.branchChoiceIds).length === 0) {
      issues.push(`${label}.optionLabel 必须与 branchChoiceIds 搭配使用`);
    }
  }

  if (cond.not !== undefined && cond.not !== null) {
    if (typeof cond.not !== "object" || Array.isArray(cond.not)) {
      issues.push(`${label}.not 必须是条件对象`);
    } else {
      issues.push(...validateConditionObject(cond.not, `${label}.not`));
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
    keyPoints: asArray(source.keyPoints).map((entry) => ({
      id: nonEmptyString(entry?.id),
      title: nonEmptyString(entry?.title),
      ...(entry?.scene !== undefined ? { scene: nonEmptyString(entry.scene) } : {}),
      ...(entry?.desc !== undefined ? { desc: nonEmptyString(entry.desc) } : {}),
      ...(entry?.finalChoice === true ? { finalChoice: true } : {}),
    })),
    branches: asArray(source.branches).map((entry) => ({
      id: nonEmptyString(entry?.id),
      title: nonEmptyString(entry?.title),
      ...(entry?.scene !== undefined ? { scene: nonEmptyString(entry.scene) } : {}),
      ...(entry?.desc !== undefined ? { desc: nonEmptyString(entry.desc) } : {}),
      ...(entry?.finalChoice === true ? { finalChoice: true } : {}),
      ...(entry?.checkpointBranch === true ? { checkpointBranch: true } : {}),
      options: asArray(entry?.options).map((option) => ({
        label: nonEmptyString(option?.label),
        leadsTo: nonEmptyString(option?.leadsTo),
      })),
    })),
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
      ...(entry?.mutexGroup !== undefined ? { mutexGroup: nonEmptyString(entry.mutexGroup) } : {}),
      ...(entry?.requires !== undefined && entry?.requires !== null ? { requires: entry.requires } : {}),
      ...(entry?.blockers !== undefined ? { blockers: asArray(entry.blockers) } : {}),
      ...(entry?.endingKeywords !== undefined ? { endingKeywords: asArray(entry.endingKeywords).map((item) => nonEmptyString(item)).filter((item) => item.length > 0) } : {}),
    })),
  };
}


/**
 * 从 LLM 原始返回中提取第一个完整 JSON 对象（模型无关）。
 * 依次尝试：代码围栏 → 最小修复（去尾逗号）→ 平衡花括号扫描 → 首末花括号截取。
 * 解析成功后，若返回体是 {"deepParse": {...}} 外壳则自动解包。
 * @param {string} rawText
 * @returns {object|null}
 */
export function extractJsonObject(rawText) {
  const source = String(rawText ?? "").replace(/^\uFEFF/, "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  const candidate = fenced ? fenced[1] : source;

  const tryParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const unwrap = (parsed) => {
    if (parsed !== null && parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) {
      const inner = parsed.deepParse;
      if (inner !== null && inner !== undefined && typeof inner === "object" && !Array.isArray(inner)) {
        const looksLikeDeepParse =
          Object.keys(parsed).length === 1 ||
          Array.isArray(inner.keyPoints) ||
          Array.isArray(inner.branches) ||
          Array.isArray(inner.endings) ||
          Array.isArray(inner.plotEdges) ||
          Array.isArray(inner.keyPointConditions) ||
          Array.isArray(inner.branchConditions);
        if (looksLikeDeepParse) return inner;
      }
    }
    return parsed;
  };

  let parsed = tryParse(candidate);
  if (parsed !== undefined) return unwrap(parsed);

  const repaired = candidate.replace(/,(\s*[}\]])/g, "$1");
  parsed = tryParse(repaired);
  if (parsed !== undefined) return unwrap(parsed);

  const balanced = sliceFirstBalancedObject(candidate);
  if (balanced !== null) {
    parsed = tryParse(balanced);
    if (parsed !== undefined) return unwrap(parsed);
    parsed = tryParse(balanced.replace(/,(\s*[}\]])/g, "$1"));
    if (parsed !== undefined) return unwrap(parsed);
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    parsed = tryParse(candidate.slice(start, end + 1));
    if (parsed !== undefined) return unwrap(parsed);
    parsed = tryParse(candidate.slice(start, end + 1).replace(/,(\s*[}\]])/g, "$1"));
    if (parsed !== undefined) return unwrap(parsed);
  }
  return null;
}

function sliceFirstBalancedObject(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let startIndex = -1;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (startIndex < 0) startIndex = index;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function canonicalizeStringList(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? [text] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function canonicalizeCheckpointGroups(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? [[text]] : [];
  }
  if (!Array.isArray(value)) return [];
  const groups = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      const ids = canonicalizeStringList(item);
      if (ids.length > 0) groups.push(ids);
    } else if (typeof item === "string" && item.trim().length > 0) {
      groups.push([item.trim()]);
    }
  }
  return groups;
}

function canonicalizeOptionLabel(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(value)) {
    const labels = value
      .filter((item) => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    if (labels.length === 0) return undefined;
    return labels.length === 1 ? labels[0] : labels;
  }
  return undefined;
}

function canonicalizeNot(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? { entryEvidence: [text] } : undefined;
  }
  if (Array.isArray(value)) {
    const strings = canonicalizeStringList(value);
    if (strings.length > 0) return { entryEvidence: strings };
    for (const item of value) {
      if (item !== null && item !== undefined && typeof item === "object" && !Array.isArray(item)) {
        const canonical = canonicalizeCondition(item);
        if (canonical !== undefined) return canonical;
      }
    }
    return undefined;
  }
  if (typeof value === "object") return canonicalizeCondition(value);
  return undefined;
}

/**
 * 条件对象模型无关归一：只保留合法字段，字符串/数组形态一律折叠成运行时 schema。
 * 归一后为空对象时返回 undefined（调用方应删除该条件）。
 * @param {object} cond
 * @returns {object|undefined}
 */
export function canonicalizeCondition(cond) {
  if (cond === null || cond === undefined || typeof cond !== "object" || Array.isArray(cond)) return undefined;
  const out = {};
  for (const key of Object.keys(cond)) {
    if (!CONDITION_KEYS.includes(key)) continue;
    const value = cond[key];
    if (key === "scene") {
      if (typeof value === "string" && value.trim().length > 0) out.scene = value.trim();
    } else if (key === "entryEvidence" || key === "sanityEventIds" || key === "keyPointIds" || key === "branchChoiceIds") {
      const list = canonicalizeStringList(value);
      if (list.length > 0) out[key] = list;
    } else if (key === "checkpointGroups") {
      const groups = canonicalizeCheckpointGroups(value);
      if (groups.length > 0) out.checkpointGroups = groups;
    } else if (key === "optionLabel") {
      const label = canonicalizeOptionLabel(value);
      if (label !== undefined) out.optionLabel = label;
    } else if (key === "not") {
      const not = canonicalizeNot(value);
      if (not !== undefined) out.not = not;
    }
  }
  // 运行时规则：optionLabel 必须与 branchChoiceIds 搭配使用。
  // 模型经常只写 optionLabel，确定性剥掉，交给 preflight/审校去提示补 branchChoiceIds。
  if (out.optionLabel !== undefined && (out.branchChoiceIds === undefined || out.branchChoiceIds.length === 0)) {
    delete out.optionLabel;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function canonicalizeConditionEntry(entry, idKey) {
  if (entry === null || entry === undefined || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const out = { [idKey]: nonEmptyString(entry[idKey]) };

  // 别名：一些模型把条件数组放在 conditions 字段。
  if (entry.requires === undefined && entry.requiresAnyOf === undefined && entry.conditions !== undefined && entry.conditions !== null) {
    if (Array.isArray(entry.conditions)) entry.requiresAnyOf = entry.conditions;
    else if (typeof entry.conditions === "object") entry.requires = entry.conditions;
  }

  const requires = canonicalizeCondition(entry.requires);
  if (requires !== undefined) out.requires = requires;
  if (entry.requiresAnyOf !== undefined && entry.requiresAnyOf !== null) {
    const groups = asArray(entry.requiresAnyOf)
      .map((group) => canonicalizeCondition(group))
      .filter((group) => group !== undefined);
    if (groups.length > 0) out.requiresAnyOf = groups;
  }
  if (idKey === "branchId" && entry.autoChooseLabel !== undefined) {
    const label = nonEmptyString(entry.autoChooseLabel);
    if (label.length > 0) out.autoChooseLabel = label;
  }
  // 归一后既无条件又无 autoChooseLabel 的条目没有任何运行时作用，
  // 模型无关地直接丢弃，避免空条件条目把 preflight 打成 high。
  if (out.requires === undefined && out.requiresAnyOf === undefined) {
    if (idKey === "keyPointId" || out.autoChooseLabel === undefined) return undefined;
  }
  return out;
}

function canonicalizeEdgeRequires(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string" && item.trim().length > 0) return { entryEvidence: [item.trim()] };
        return canonicalizeCondition(item);
      })
      .filter((condition) => condition !== undefined);
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? [{ entryEvidence: [text] }] : [];
  }
  const single = canonicalizeCondition(value);
  return single !== undefined ? [single] : [];
}

function canonicalizeEdge(edge) {
  if (edge === null || edge === undefined || typeof edge !== "object" || Array.isArray(edge)) return undefined;
  const out = { from: nonEmptyString(edge.from), to: nonEmptyString(edge.to) };
  if (edge.label !== undefined) out.label = nonEmptyString(edge.label);
  const requires = canonicalizeEdgeRequires(edge.requires);
  if (requires !== undefined) out.requires = requires;
  if (edge.consequences !== undefined && edge.consequences !== null && typeof edge.consequences === "object" && !Array.isArray(edge.consequences)) {
    out.consequences = edge.consequences;
  }
  return out;
}

function canonicalizeBlockers(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((item) => {
      if (typeof item === "string" && item.trim().length > 0) return { entryEvidence: [item.trim()] };
      return canonicalizeCondition(item);
    })
    .filter((condition) => condition !== undefined);
}

function canonicalizeEnding(ending) {
  if (ending === null || ending === undefined || typeof ending !== "object" || Array.isArray(ending)) return undefined;
  const out = {
    id: nonEmptyString(ending.id),
    branchId: nonEmptyString(ending.branchId),
    title: nonEmptyString(ending.title),
  };
  const optionLabel = canonicalizeOptionLabel(ending.optionLabel);
  if (optionLabel !== undefined) out.optionLabel = optionLabel;
  if (ending.mutexGroup !== undefined) {
    const mutexGroup = nonEmptyString(ending.mutexGroup);
    if (mutexGroup.length > 0) out.mutexGroup = mutexGroup;
  }

  // 别名：conditions 为对象时视作 requires，为数组且无 blockers 时视作 blockers。
  let sourceRequires = ending.requires;
  if ((sourceRequires === undefined || sourceRequires === null) && ending.conditions !== undefined && ending.conditions !== null && typeof ending.conditions === "object" && !Array.isArray(ending.conditions)) {
    sourceRequires = ending.conditions;
  }
  const requires = canonicalizeCondition(sourceRequires);
  if (requires !== undefined) out.requires = requires;

  let sourceBlockers = ending.blockers;
  if ((sourceBlockers === undefined || sourceBlockers === null) && Array.isArray(ending.conditions) && (sourceRequires === undefined || sourceRequires === null)) {
    sourceBlockers = ending.conditions;
  }
  const blockers = canonicalizeBlockers(sourceBlockers);
  if (blockers.length > 0) out.blockers = blockers;

  if (ending.endingKeywords !== undefined && ending.endingKeywords !== null) {
    const keywords = canonicalizeStringList(ending.endingKeywords);
    if (keywords.length > 0) out.endingKeywords = keywords;
  }
  return out;
}

function canonicalizeKeyPoint(entry) {
  if (entry === null || entry === undefined || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const out = { id: nonEmptyString(entry.id), title: nonEmptyString(entry.title) };
  if (entry.scene !== undefined) out.scene = nonEmptyString(entry.scene);
  if (entry.desc !== undefined) out.desc = nonEmptyString(entry.desc);
  if (entry.finalChoice === true) out.finalChoice = true;
  return out;
}

function canonicalizeBranch(entry) {
  if (entry === null || entry === undefined || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const out = { id: nonEmptyString(entry.id), title: nonEmptyString(entry.title) };
  if (entry.scene !== undefined) out.scene = nonEmptyString(entry.scene);
  if (entry.desc !== undefined) out.desc = nonEmptyString(entry.desc);
  if (entry.finalChoice === true) out.finalChoice = true;
  if (entry.checkpointBranch === true) out.checkpointBranch = true;
  out.options = asArray(entry.options).map((option) => {
    if (option === null || option === undefined || typeof option !== "object" || Array.isArray(option)) {
      return { label: "", leadsTo: "" };
    }
    return { label: nonEmptyString(option?.label), leadsTo: nonEmptyString(option?.leadsTo) };
  });
  return out;
}

/**
 * 模型无关的 deepParse 归一化：解包外壳、剥离未知字段、折叠形态变体。
 * skeletonLocked=true 时强制清空 keyPoints。
 * @param {object} raw
 * @param {{skeletonLocked?: boolean}} [options]
 * @returns {{ deepParse: object, issues: string[] }}
 */
export function canonicalizeDeepParse(raw, options = {}) {
  const source = raw ?? {};
  const unwrapped =
    source.deepParse !== null && source.deepParse !== undefined && typeof source.deepParse === "object" && !Array.isArray(source.deepParse)
      ? source.deepParse
      : source;
  const skeletonLocked = options.skeletonLocked === true;
  const issues = [];

  let keyPoints = asArray(unwrapped.keyPoints).map(canonicalizeKeyPoint).filter((entry) => entry !== undefined);
  if (skeletonLocked && keyPoints.length > 0) {
    issues.push("骨架锁定模式不允许生成 keyPoints，已自动剥离");
    keyPoints = [];
  }

  const branches = asArray(unwrapped.branches).map(canonicalizeBranch).filter((entry) => entry !== undefined);
  const keyPointConditions = asArray(unwrapped.keyPointConditions)
    .map((entry) => canonicalizeConditionEntry(entry, "keyPointId"))
    .filter((entry) => entry !== undefined);
  const branchConditions = asArray(unwrapped.branchConditions)
    .map((entry) => canonicalizeConditionEntry(entry, "branchId"))
    .filter((entry) => entry !== undefined);
  const plotEdges = asArray(unwrapped.plotEdges).map(canonicalizeEdge).filter((edge) => edge !== undefined);
  const endings = asArray(unwrapped.endings).map(canonicalizeEnding).filter((ending) => ending !== undefined);

  return {
    deepParse: {
      version: nonEmptyString(unwrapped.version) || DEEP_PARSE_VERSION,
      keyPoints,
      branches,
      keyPointConditions,
      branchConditions,
      plotEdges,
      endings,
    },
    issues,
  };
}

/**
 * 计算多最终分支互斥缺口：对每个最终分支 B，取其它最终分支 C 的所有结局
 * 共同要求的 keyPointIds，若 B 自己的任何结局都不要求这些 key，且 B 的
 * branchCondition 尚未用 not 排除它们，则记入缺口。
 * @param {object} deepParse
 * @param {Set<string>} finalChoiceIds
 * @returns {Array<{branchId: string, keys: string[]}>}
 */
function computeFinalBranchMutexGaps(deepParse, finalChoiceIds) {
  const finalIds = [...finalChoiceIds];
  const endings = asArray(deepParse?.endings);
  const positiveByBranch = new Map();
  const commonByBranch = new Map();

  for (const branchId of finalIds) {
    const branchEndings = endings.filter((ending) => String(ending?.branchId ?? "") === branchId);
    const keySets = branchEndings.map((ending) => {
      const req = ending?.requires;
      const keys =
        req !== null && req !== undefined && typeof req === "object" && !Array.isArray(req)
          ? asArray(req.keyPointIds).map((id) => String(id)).filter((id) => id.length > 0)
          : [];
      return new Set(keys);
    });
    const positive = new Set();
    for (const set of keySets) for (const key of set) positive.add(key);
    const common = new Set(positive);
    for (const set of keySets) {
      for (const key of common) if (!set.has(key)) common.delete(key);
    }
    positiveByBranch.set(branchId, positive);
    commonByBranch.set(branchId, common);
  }

  const gaps = [];
  for (const branchId of finalIds) {
    const ownPositive = positiveByBranch.get(branchId) ?? new Set();
    const missing = new Set();
    for (const otherId of finalIds) {
      if (otherId === branchId) continue;
      for (const key of commonByBranch.get(otherId) ?? []) {
        if (!ownPositive.has(key)) missing.add(key);
      }
    }
    const entry = asArray(deepParse?.branchConditions).find((cond) => String(cond?.branchId ?? "") === branchId);
    const notKeys = new Set(
      entry?.requires?.not !== undefined && entry?.requires?.not !== null && typeof entry.requires.not === "object" && !Array.isArray(entry.requires.not)
        ? asArray(entry.requires.not.keyPointIds).map((id) => String(id)).filter((id) => id.length > 0)
        : []
    );
    const stillMissing = [...missing].filter((key) => !notKeys.has(key));
    if (stillMissing.length > 0) gaps.push({ branchId, keys: stillMissing });
  }
  return gaps;
}

/**
 * 确定性结构修复（骨架锁定）：不替模型做语义判断，只修“没有它运行时必坏”的结构问题：
 * - 最终抉择分支必须有带 scene 门控的 branchCondition，且禁止 autoChooseLabel；
 * - 结局必须有直接入边，requires 至少带 branchChoiceIds（有 optionLabel 时补齐）。
 * 返回修复日志，供 quality/issues 透出，避免静默修改。
 * @param {object} deepParse
 * @param {object} flat
 * @returns {{ deepParse: object, repairs: string[] }}
 */
export function repairSkeletonWiringDeepParse(deepParse, flat) {
  const repairs = [];
  const dp = JSON.parse(JSON.stringify(deepParse ?? {}));
  const allBranches = [...asArray(flat?.branches), ...asArray(dp.branches)];
  const finalChoiceIds = new Set(
    allBranches
      .filter((branch) => branch?.finalChoice === true || String(branch?.id ?? "").startsWith("br-final"))
      .map((branch) => String(branch?.id ?? ""))
  );
  const branchById = new Map(allBranches.map((branch) => [String(branch?.id ?? ""), branch]));
  const isEndingHost = (branch) => {
    const id = String(branch?.id ?? "");
    return finalChoiceIds.has(id) || (asArray(branch?.options).length >= 2 && branch?.checkpointBranch !== true);
  };

  // 1) 最终抉择分支 branchCondition 结构兜底。
  // 最终抉择分支的 branchCondition 只允许“scene 门控”：玩家选择权与结局
  // 路由由 plotEdges/endings 负责。模型若写出多条互斥 branchCondition
  // （如 requires kp-17 与 not kp-17），确定性收敛为一条 {scene} 门控。
  const sceneHeadings = asArray(flat?.scenarioFacts)
    .map((fact) => nonEmptyString(fact?.heading) || nonEmptyString(fact?.scene))
    .filter((scene) => scene.length > 0);
  for (const branchId of finalChoiceIds) {
    const branch = branchById.get(branchId);
    const entries = asArray(dp.branchConditions).filter((cond) => String(cond?.branchId ?? "") === branchId);
    if (entries.length === 0) {
      if (branch !== undefined) {
        const scene = nonEmptyString(branch?.scene);
        dp.branchConditions.push({ branchId, requires: scene.length > 0 ? { scene } : {} });
        repairs.push(`为最终分支 ${branchId} 补 branchCondition（scene=${scene || "未知"}）`);
      }
      continue;
    }
    if (entries.length > 1) {
      dp.branchConditions = asArray(dp.branchConditions).filter(
        (cond) => !(String(cond?.branchId ?? "") === branchId) || cond === entries[0]
      );
      repairs.push(`最终分支 ${branchId} 存在 ${entries.length} 条 branchCondition，收敛为 1 条 scene 门控`);
    }
    const entry = entries[0];
    if (entry.autoChooseLabel !== undefined) {
      delete entry.autoChooseLabel;
      repairs.push(`删除最终分支 ${branchId} 的 autoChooseLabel（最终抉择不得代选）`);
    }
    // 优先取已有 scene；没有则用骨架分支 scene；再没有用最后一个场景标题兜底。
    const existingScene =
      entry.requires !== undefined && entry.requires !== null && typeof entry.requires === "object" && !Array.isArray(entry.requires)
        ? nonEmptyString(entry.requires.scene)
        : "";
    const anyScene = asArray(entry.requiresAnyOf)
      .map((group) => (group !== null && group !== undefined && typeof group === "object" && !Array.isArray(group) ? nonEmptyString(group.scene) : ""))
      .find((scene) => scene.length > 0) ?? "";
    let scene = existingScene.length > 0 ? existingScene : anyScene.length > 0 ? anyScene : nonEmptyString(branch?.scene);
    // 模型常编造“第一公园·怪物已降临”这类不在场景标题清单里的 scene，
    // 运行时无法匹配。若候选 scene 不在清单里，按骨架 scene → 最后一个
    // 场景标题的顺序确定性回退。
    if (scene.length === 0 || (sceneHeadings.length > 0 && !sceneHeadings.includes(scene))) {
      // 多最终分支时，模型若用分支标题作为 scene（如“无力抗争的终局”），
      // 且各分支互不相同，则保留——这比强行回退到同一个章节标题更能区分分支。
      if (finalChoiceIds.size > 1 && nonEmptyString(branch?.title).length > 0 && nonEmptyString(branch.title) === scene) {
        repairs.push(`最终分支 ${branchId} 的 scene 不在场景标题清单中，但等于分支标题，保留：${scene}`);
      } else {
      // 多最终分支场景回退时避免碰撞：已被其它最终分支占用的标题不再复用。
      const usedByOtherFinal = new Set(
        asArray(dp.branchConditions)
          .filter((cond) => finalChoiceIds.has(String(cond?.branchId ?? "")) && String(cond?.branchId ?? "") !== branchId)
          .map((cond) =>
            cond?.requires !== null && cond?.requires !== undefined && typeof cond.requires === "object" && !Array.isArray(cond.requires)
              ? nonEmptyString(cond.requires.scene)
              : ""
          )
          .filter((value) => value.length > 0)
      );
      const skeletonScene = nonEmptyString(branch?.scene);
      if (skeletonScene.length > 0 && sceneHeadings.includes(skeletonScene) && !usedByOtherFinal.has(skeletonScene)) {
        repairs.push(`最终分支 ${branchId} 的 scene 不在场景标题清单中（${scene || "空"}），回退为骨架 scene：${skeletonScene}`);
        scene = skeletonScene;
      } else if (sceneHeadings.length > 0) {
        let fallbackScene = [...sceneHeadings].reverse().find((heading) => !usedByOtherFinal.has(heading));
        if (fallbackScene === undefined) fallbackScene = sceneHeadings[sceneHeadings.length - 1];
        repairs.push(`最终分支 ${branchId} 的 scene 不在场景标题清单中（${scene || "空"}），回退为未被占用的场景标题：${fallbackScene}`);
        scene = fallbackScene;
      }
      }
    }
    if (scene.length > 0) {
      entry.requires = { scene };
      delete entry.requiresAnyOf;
      // 同步 deepParse 里该分支的 scene，避免 review/运行时分支 scene 与门控不一致。
      const dpBranch = asArray(dp.branches).find((candidate) => String(candidate?.id ?? "") === branchId);
      if (dpBranch !== undefined && nonEmptyString(dpBranch.scene) !== scene) {
        dpBranch.scene = scene;
      }
      if (existingScene.length === 0 && anyScene.length === 0) {
        repairs.push(`为最终分支 ${branchId} 的 branchCondition 补 scene 门控：${scene}`);
      } else {
        repairs.push(`最终分支 ${branchId} 的 branchCondition 收敛为仅 scene 门控：${scene}`);
      }
    } else {
      delete entry.requiresAnyOf;
    }
  }

  // 1b) 多最终分支同 scene 去重：两个最终分支共享同一 scene 门控时，
  // 运行时无法区分该进入哪个分支。若它们标题不同，用分支标题替换 scene，
  // 保证互斥分支不会同时 reached。
  if (finalChoiceIds.size > 1) {
    const sceneCounts = new Map();
    for (const branchId of finalChoiceIds) {
      const cond = asArray(dp.branchConditions).find((entry) => String(entry?.branchId ?? "") === branchId);
      const sc =
        cond?.requires !== null && cond?.requires !== undefined && typeof cond.requires === "object" && !Array.isArray(cond.requires)
          ? nonEmptyString(cond.requires.scene)
          : "";
      if (sc.length > 0) sceneCounts.set(sc, (sceneCounts.get(sc) ?? 0) + 1);
    }
    for (const [sharedScene, count] of sceneCounts) {
      if (count <= 1) continue;
      for (const branchId of finalChoiceIds) {
        const cond = asArray(dp.branchConditions).find((entry) => String(entry?.branchId ?? "") === branchId);
        if (cond === undefined) continue;
        const sc =
          cond?.requires !== null && cond?.requires !== undefined && typeof cond.requires === "object" && !Array.isArray(cond.requires)
            ? nonEmptyString(cond.requires.scene)
            : "";
        if (sc !== sharedScene) continue;
        const branch = branchById.get(branchId);
        const title = nonEmptyString(branch?.title);
        if (title.length === 0 || title === sharedScene) continue;
        cond.requires.scene = title;
        const dpBranch = asArray(dp.branches).find((candidate) => String(candidate?.id ?? "") === branchId);
        if (dpBranch !== undefined) dpBranch.scene = title;
        repairs.push(`最终分支 ${branchId} 与其它最终分支共享 scene「${sharedScene}」，改用分支标题作为 scene：${title}`);
      }
    }
  }

  // 1b) 多最终分支互斥兜底：最终抉择分支之间必须互斥。否则两个分支都会被
  // reached，但其中一个分支的结局条件不满足时会让玩家卡在该分支选项上。
  // 规则：对每个最终分支 B，取其它最终分支 C 的所有结局共同要求的
  // keyPointIds，若 B 自己的任何结局都不要求这些 key，则把它们加入 B 的
  // branchCondition.requires.not.keyPointIds，使 B 在 C 的激活条件下不可达。
  if (finalChoiceIds.size > 1) {
    for (const gap of computeFinalBranchMutexGaps(dp, finalChoiceIds)) {
      const entry = asArray(dp.branchConditions).find((cond) => String(cond?.branchId ?? "") === gap.branchId);
      if (entry === undefined) continue;
      if (entry.requires === null || entry.requires === undefined || typeof entry.requires !== "object" || Array.isArray(entry.requires)) {
        entry.requires = {};
      }
      const not =
        entry.requires.not !== null && entry.requires.not !== undefined && typeof entry.requires.not === "object" && !Array.isArray(entry.requires.not)
          ? entry.requires.not
          : {};
      const mergedKeys = new Set(asArray(not.keyPointIds).map((id) => String(id)).filter((id) => id.length > 0));
      for (const key of gap.keys) mergedKeys.add(key);
      not.keyPointIds = [...mergedKeys];
      entry.requires.not = not;
      repairs.push(`为最终分支 ${gap.branchId} 补互斥 not.keyPointIds：[${gap.keys.join(", ")}]`);
    }
  }

  // 2) 结局结构兜底（仅限可挂结局的分支）。
  for (let index = 0; index < asArray(dp.endings).length; index += 1) {
    const ending = dp.endings[index];
    const branchId = nonEmptyString(ending?.branchId);
    if (branchId.length === 0) continue;
    const branch = branchById.get(branchId);
    if (branch === undefined || !isEndingHost(branch)) continue;

    let changed = false;
    if (nonEmptyString(ending.id).length === 0) {
      ending.id = `end-${branchId}-${index + 1}`;
      changed = true;
    }
    const branchOptions = asArray(branch.options);
    if (nonEmptyString(ending.optionLabel).length === 0 && branchOptions.length === 1) {
      const only = nonEmptyString(branchOptions[0]?.label);
      if (only.length > 0) {
        ending.optionLabel = only;
        changed = true;
      }
    }
    let req = ending.requires;
    if (req === null || req === undefined || typeof req !== "object" || Array.isArray(req)) {
      req = {};
      ending.requires = req;
      changed = true;
    }
    if (!Array.isArray(req.branchChoiceIds) || req.branchChoiceIds.length === 0) {
      req.branchChoiceIds = [branchId];
      changed = true;
    }
    const endingLabel = nonEmptyString(ending.optionLabel);
    if (endingLabel.length > 0 && req.optionLabel === undefined) {
      req.optionLabel = endingLabel;
      changed = true;
    }
    if (changed) repairs.push(`补齐结局 ${String(ending.title ?? ending.id ?? branchId)} 的结构化 requires/optionLabel`);

    const from = `br:${branchId}`;
    const to = `end:${String(ending.id ?? "")}`;
    const hasDirectEdge = asArray(dp.plotEdges).some((edge) => String(edge?.from ?? "") === from && String(edge?.to ?? "") === to);
    if (!hasDirectEdge && to.length > "end:".length) {
      const edgeRequires = [];
      if (endingLabel.length > 0) edgeRequires.push({ branchChoiceIds: [branchId], optionLabel: endingLabel });
      else edgeRequires.push({ branchChoiceIds: [branchId] });
      dp.plotEdges.push({ from, to, label: endingLabel.length > 0 ? endingLabel : nonEmptyString(ending.title), requires: edgeRequires });
      repairs.push(`为结局 ${String(ending.title ?? ending.id)} 补直接入边 ${from} → ${to}`);
    }
  }

  return { deepParse: dp, repairs };
}

/**
 * 收集可引用的关键点 / 分支 ID（当前 flat + LLM 新生成的节点）。
/**
 * 收集可引用的关键点 / 分支 ID（当前 flat + LLM 新生成的节点）。
 * @param {object} deepParse
 * @param {object} [flat]
 * @returns {{ keyPointIds: Set<string>, branchIds: Set<string> }}
 */
function collectReferenceIds(deepParse, flat) {
  const keyPointIds = new Set(asArray(flat?.keyPoints).map((kp) => String(kp?.id ?? "")).filter((id) => id.length > 0));
  const branchIds = new Set(asArray(flat?.branches).map((branch) => String(branch?.id ?? "")).filter((id) => id.length > 0));
  for (const kp of asArray(deepParse?.keyPoints)) {
    const id = String(kp?.id ?? "").trim();
    if (id.length > 0) keyPointIds.add(id);
  }
  for (const branch of asArray(deepParse?.branches)) {
    const id = String(branch?.id ?? "").trim();
    if (id.length > 0) branchIds.add(id);
  }
  return { keyPointIds, branchIds };
}

/**
 * 校验深度解析对象。flat 可选：传入时额外校验 ID 是否存在于当前剧本结构或 LLM 生成的新节点。
 * @param {object} deepParse
 * @param {object} [flat] - { keyPoints, branches }
 * @returns {string[]} 问题列表（空数组 = 合法）
 */
export function validateDeepParse(deepParse, flat) {
  const issues = [];
  if (deepParse === null || deepParse === undefined || typeof deepParse !== "object" || Array.isArray(deepParse)) {
    return ["deepParse 必须是对象"];
  }

  const { keyPointIds, branchIds } = collectReferenceIds(deepParse, flat);

  for (let index = 0; index < asArray(deepParse.keyPoints).length; index += 1) {
    const entry = deepParse.keyPoints[index];
    const label = `keyPoints[${index}]`;
    if (nonEmptyString(entry?.id).length === 0) issues.push(`${label}.id 不能为空`);
    if (nonEmptyString(entry?.title).length === 0) issues.push(`${label}.title 不能为空`);
  }

  for (let index = 0; index < asArray(deepParse.branches).length; index += 1) {
    const entry = deepParse.branches[index];
    const label = `branches[${index}]`;
    if (nonEmptyString(entry?.id).length === 0) {
      issues.push(`${label}.id 不能为空`);
    } else if (branchIds.size > 0 && !branchIds.has(String(entry.id))) {
      branchIds.add(String(entry.id));
    }
    if (nonEmptyString(entry?.title).length === 0) issues.push(`${label}.title 不能为空`);
    if (asArray(entry?.options).length === 0) {
      issues.push(`${label}.options 至少需要一个选项`);
    } else {
      for (let optionIndex = 0; optionIndex < asArray(entry.options).length; optionIndex += 1) {
        const option = entry.options[optionIndex];
        if (nonEmptyString(option?.label).length === 0) issues.push(`${label}.options[${optionIndex}].label 不能为空`);
        if (nonEmptyString(option?.leadsTo).length === 0) issues.push(`${label}.options[${optionIndex}].leadsTo 不能为空`);
      }
    }
  }

  for (let index = 0; index < asArray(deepParse.keyPointConditions).length; index += 1) {
    const entry = deepParse.keyPointConditions[index];
    const label = `keyPointConditions[${index}]`;
    if (nonEmptyString(entry?.keyPointId).length === 0) {
      issues.push(`${label}.keyPointId 不能为空`);
    } else if (keyPointIds.size > 0 && !keyPointIds.has(String(entry.keyPointId))) {
      issues.push(`${label}.keyPointId 不存在于当前或生成的 keyPoints：${entry.keyPointId}`);
    }
    issues.push(...validatePrerequisitePair(entry, label));
  }

  for (let index = 0; index < asArray(deepParse.branchConditions).length; index += 1) {
    const entry = deepParse.branchConditions[index];
    const label = `branchConditions[${index}]`;
    if (nonEmptyString(entry?.branchId).length === 0) {
      issues.push(`${label}.branchId 不能为空`);
    } else if (branchIds.size > 0 && !branchIds.has(String(entry.branchId))) {
      issues.push(`${label}.branchId 不存在于当前或生成的 branches：${entry.branchId}`);
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
    for (const prefix of ["br:", "kp:"]) {
      if (String(edge?.from ?? "").startsWith(prefix)) {
        const id = String(edge.from).slice(prefix.length);
        if (id.length > 0 && !(prefix === "br:" ? branchIds : keyPointIds).has(id)) {
          issues.push(`${label}.from 引用了不存在的 ${prefix}${id}`);
        }
      }
      if (String(edge?.to ?? "").startsWith(prefix)) {
        const id = String(edge.to).slice(prefix.length);
        if (id.length > 0 && !(prefix === "br:" ? branchIds : keyPointIds).has(id)) {
          issues.push(`${label}.to 引用了不存在的 ${prefix}${id}`);
        }
      }
    }
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
      issues.push(`${label}.branchId 不存在于当前或生成的 branches：${ending.branchId}`);
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
    if (ending?.mutexGroup !== undefined && nonEmptyString(ending.mutexGroup).length === 0) {
      issues.push(`${label}.mutexGroup 必须是非空字符串`);
    }
  }

  return issues;
}

/**
 * 收集确定性结构化参考（单段与两段式 Prompt 共用）。
 * @param {object} flat
 * @returns {object}
 */
function buildGroundedRef(flat) {
  return {
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
}

/**
 * 收集连线阶段允许的 leadsTo 目标词表（封闭词表）。
 * @param {object} flat
 * @param {object} [inventory] - 第一段生成的节点清单（可选）
 * @returns {string[]}
 */
export function collectDeepParseTargets(flat, inventory = null) {
  const grounded = buildGroundedRef(flat);
  const targets = new Set();
  for (const kp of grounded.keyPoints) {
    if (nonEmptyString(kp.title).length > 0) targets.add(nonEmptyString(kp.title));
    if (nonEmptyString(kp.scene).length > 0) targets.add(nonEmptyString(kp.scene));
  }
  for (const branch of grounded.branches) {
    if (nonEmptyString(branch.title).length > 0) targets.add(nonEmptyString(branch.title));
    if (nonEmptyString(branch.scene).length > 0) targets.add(nonEmptyString(branch.scene));
  }
  for (const kp of asArray(inventory?.keyPoints)) {
    if (nonEmptyString(kp?.title).length > 0) targets.add(nonEmptyString(kp.title));
    if (nonEmptyString(kp?.scene).length > 0) targets.add(nonEmptyString(kp.scene));
  }
  for (const branch of asArray(inventory?.branches)) {
    if (nonEmptyString(branch?.title).length > 0) targets.add(nonEmptyString(branch.title));
    if (nonEmptyString(branch?.scene).length > 0) targets.add(nonEmptyString(branch.scene));
  }
  for (const ending of asArray(inventory?.endings)) {
    if (nonEmptyString(ending?.title).length > 0) targets.add(nonEmptyString(ending.title));
    for (const word of asArray(ending?.endingKeywords)) {
      if (nonEmptyString(word).length > 0) targets.add(nonEmptyString(word));
    }
  }
  for (const fact of asArray(flat?.scenarioFacts)) {
    if (nonEmptyString(fact?.scene).length > 0) targets.add(nonEmptyString(fact.scene));
  }
  return [...targets].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/**
 * 构建深度解析 Prompt（单段式，保留兼容）。
 * @param {object} flat - { scenario:{text,name}, scenarioCheckpoints?, scenarioFacts?, entities?, keyPoints?, branches? }
 * @returns {string}
 */
export function buildDeepParsePrompt(flat) {
  const text = String(flat?.scenario?.text ?? "");
  const name = String(flat?.scenario?.name ?? "剧本");
  const grounded = buildGroundedRef(flat);

  return [
    `你是 CoC 跑团剧本的结构化专家。请阅读剧本《${name}》的原文，输出该剧本的「深度剧情解析」JSON，用于驱动多线剧情图与结局条件。`,
    ``,
    `只输出一个 JSON 对象（不要 Markdown 代码块），结构如下：`,
    `{`,
    `  "keyPoints": [{"id":"kp-1","title":"进入书房","scene":"三层书房","desc":"调查员进入书房"}],`,
    `  "branches": [{"id":"br-1","title":"如何进入书房","scene":"三层书房","options":[{"label":"撞门","leadsTo":"三层书房"}]}],`,
    `  "keyPointConditions": [{"keyPointId":"kp-1","requires":{"checkpointGroups":[["chk-1","chk-2"]]},"requiresAnyOf":[{"keyPointIds":["kp-2"]}]}],`,
    `  "branchConditions": [{"branchId":"br-1","requires":{"sanityEventIds":["chk-9"]},"autoChooseLabel":"掀开地毯查看"}],`,
    `  "plotEdges": [{"from":"br:br-1","to":"kp:kp-1","label":"撞门","requires":[],"consequences":{"setFlags":{"branch:br-1:chosen":"撞门"}}}],`,
    `  "endings": [{"id":"end-1","branchId":"br-1","title":"墨渊消散的结局","optionLabel":"逆序念诵（送神）","mutexGroup":"最终结局","requires":{"keyPointIds":["kp-7"],"branchChoiceIds":["br-1"],"optionLabel":"逆序念诵（送神）"},"blockers":[{"branchChoiceIds":["br-1"]}],"endingKeywords":["墨渊消散","送神"]}]`,
    `}`,
    ``,
    `字段说明与约束：`,
    `- keyPoints / branches：剧情图节点草稿。若下方“结构化参考”中已有可用的关键点/分支，必须复用其 id，不要重复生成；`,
    `  若参考为空或明显不全，可以生成新的节点，id 使用 kp-1 / br-1 形式（不要 ai- 前缀）。`,
    `- 条件对象只允许这些字段（可组合，缺省字段不检查）：`,
    `  scene: 当前场景必须精确等于该字符串。`,
    `  entryEvidence: 文本中需出现至少一个进门证据短语（空文本豁免）。`,
    `  checkpointGroups: 检定点组数组；组内 OR，组间 AND。`,
    `  sanityEventIds: SAN 结算事件 ID，命中任意一个即满足。`,
    `  keyPointIds: 这些关键点必须全部已揭示。`,
    `  branchChoiceIds: 这些分支必须全部 reached 且已选择。`,
    `  optionLabel: 与 branchChoiceIds 搭配；任一引用分支的已选选项与它相等/互相包含即满足。`,
    `  not: 条件对象取反；not 内条件满足时本组不满足。`,
    `- keyPointConditions / branchConditions：给关键点/分支补挂 requires / requiresAnyOf；ID 必须引用本 JSON 或“结构化参考”里的 id。`,
    `- autoChooseLabel：事件落地时优先选择的选项 label 子串。`,
    `- plotEdges：剧情图有向边。from/to 使用 br:<branchId> / kp:<keyPointId> / end:<branchId>:<n> 形式；`,
    `  label 一般是对应分支选项文本；consequences 用 {setFlags:{key:value}} 形式表达进入后的世界事实变化。`,
    `- endings：结局节点。branchId 是对应的最终分支；optionLabel 用于区分同一最终分支的不同结局；`,
    `  mutexGroup 相同的结局互斥，只能有一个达成；requires 是抵达结局必须满足的条件；`,
    `  blockers 是阻断条件数组（命中任意一个即不可抵达）；endingKeywords 是叙述中出现即视为进入结局的关键词。`,
    `- 生成后自检清单（有确定性工具会逐项检查，不通过会退回重生成）：`,
    `  1) 每个分支选项的 leadsTo 必须命中某个关键点标题/分支标题/结局标题或结局关键词；`,
    `  2) 每个结局必须有“入边”：其分支的某个选项 leadsTo 指向该结局标题或关键词；`,
    `  3) plotEdges 的 end: 端点必须等于某个已声明结局的 id 或 title；`,
    `  4) 玩家选择型分支（多选项）不要挂 branchCondition，除非写 autoChooseLabel；`,
    `  5) 条件里能写 scene 就写 scene，不要依赖运行时兜底。`,
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
 * 两段式深度解析 Prompt：
 *  - 第一段只生成节点清单（keyPoints/branches/endings，不含边、条件、leadsTo）；
 *  - 第二段只生成连线与条件（leadsTo 必须从封闭词表选择，边/条件只能引用清单内 id）。
 *
 * @param {object} flat - { scenario:{text,name}, scenarioCheckpoints?, scenarioFacts?, entities?, keyPoints?, branches? }
 * @param {object} [inventory] - 第一段节点清单；传入后 wiringPrompt 会把它作为硬约束。
 * @returns {{ inventoryPrompt: string, wiringPrompt: string }}
 */
export function buildDeepParseTwoStagePrompts(flat, inventory = null) {
  const text = String(flat?.scenario?.text ?? "");
  const name = String(flat?.scenario?.name ?? "剧本");
  const grounded = buildGroundedRef(flat);
  const groundedJson = JSON.stringify(grounded, null, 2);

  const inventoryPrompt = [
    `你是 CoC 跑团剧本的结构化专家。请阅读剧本《${name}》的原文，输出「节点清单」JSON。`,
    ``,
    `只输出一个 JSON 对象（不要 Markdown 代码块），结构如下：`,
    `{`,
    `  "keyPoints": [{"id":"kp-1","title":"进入书房","scene":"三层书房","desc":"调查员进入书房"}],`,
    `  "branches": [{"id":"br-1","title":"如何进入书房","scene":"三层书房","options":[{"label":"撞门"}]}],`,
    `  "endings": [{"id":"end-1","branchId":"br-1","title":"墨渊消散的结局","optionLabel":"逆序念诵（送神）","mutexGroup":"最终结局","endingKeywords":["墨渊消散","送神"]}]`,
    `}`,
    ``,
    `约束：`,
    `- 这一阶段只生成节点清单，不要生成 plotEdges / keyPointConditions / branchConditions / requires / blockers / leadsTo。`,
    `- 若“结构化参考”中已有可用的关键点/分支，必须复用其 id；参考为空或不全时才生成新节点，id 使用 kp-1 / br-1 / end-1 形式。`,
    `- 分支 options 只写 label，不写 leadsTo；同一最终分支的多个结局必须用 optionLabel 区分，互斥结局给相同 mutexGroup。`,
    ``,
    `剧本结构化参考（已有草拟，供你校正）：`,
    groundedJson,
    ``,
    `剧本原文：`,
    text.slice(0, 30000),
  ].join("\n");

  const wiringPrompt = [
    `你是 CoC 跑团剧本的结构化专家。请阅读剧本《${name}》的原文与第一阶段生成的节点清单，输出「连线与条件」JSON。`,
    ``,
    `只输出一个 JSON 对象（不要 Markdown 代码块），结构如下：`,
    `{`,
    `  "branchOptionLeadsTo": [{"branchId":"br-1","optionIndex":0,"leadsTo":"进入书房"}],`,
    `  "keyPointConditions": [{"keyPointId":"kp-1","requires":{"checkpointGroups":[["chk-1","chk-2"]]},"requiresAnyOf":[{"keyPointIds":["kp-2"]}]}],`,
    `  "branchConditions": [{"branchId":"br-1","requires":{"sanityEventIds":["chk-9"]},"autoChooseLabel":"掀开地毯查看"}],`,
    `  "plotEdges": [{"from":"br:br-1","to":"kp:kp-1","label":"撞门","requires":[],"consequences":{"setFlags":{"branch:br-1:chosen":"撞门"}}}],`,
    `  "endingConditions": [{"endingId":"end-1","requires":{"keyPointIds":["kp-7"],"branchChoiceIds":["br-1"],"optionLabel":"逆序念诵（送神）"},"blockers":[{"branchChoiceIds":["br-1"]}]}]`,
    `}`,
    ``,
    `约束：`,
    `- 只能引用“节点清单”和“结构化参考”里已有的 id；不得新造关键点/分支/结局。`,
    `- branchOptionLeadsTo 必须为每个分支的每个选项都写一条；leadsTo 必须从下方“允许目标词表”里精确选择一项。`,
    `- 每个结局必须至少有一个分支选项的 leadsTo 等于该结局的 title 或 endingKeywords 之一；`,
    `  同一最终分支的多个结局用 endingConditions[].requires/blockers 区分，不要互相遮蔽。`,
    `- plotEdges 的 from/to 只能是 br:<branchId> / kp:<keyPointId> / end:<endingId>；end: 必须等于已声明结局的 id。`,
    `- 条件对象只允许 scene / entryEvidence / checkpointGroups / sanityEventIds / keyPointIds / branchChoiceIds / optionLabel / not；`,
    `  能写 scene 就写 scene；多选项玩家选择分支不要写 branchCondition，除非给 autoChooseLabel。`,
    ``,
    `节点清单（第一阶段输出，必须原样遵守）：`,
    JSON.stringify(inventory ?? { keyPoints: [], branches: [], endings: [] }, null, 2),
    ``,
    `允许目标词表（leadsTo 只能从这里选）：`,
    JSON.stringify(collectDeepParseTargets(flat, inventory), null, 0),
    ``,
    `结构化参考（检定点/事实，供你补条件）：`,
    groundedJson,
    ``,
    `剧本原文：`,
    text.slice(0, 30000),
  ].join("\n");

  return { inventoryPrompt, wiringPrompt };
}

/**
 * 合并两段式生成结果：把 wiring 的 leadsTo / 条件 / 边 灌回 inventory 节点，
 * 再走 normalizeDeepParse + validateDeepParse。
 *
 * @param {object} inventory - 第一段节点清单
 * @param {object} wiring - 第二段连线与条件
 * @param {object} [flat] - 传入时校验 ID 引用
 * @returns {{ deepParse: object|null, issues: string[] }}
 */
export function combineDeepParseParts(inventory, wiring, flat) {
  const branches = asArray(inventory?.branches).map((branch) => {
    const options = asArray(branch?.options).map((option, optionIndex) => {
      const target = asArray(wiring?.branchOptionLeadsTo).find(
        (entry) => String(entry?.branchId ?? "") === String(branch?.id ?? "") && Number(entry?.optionIndex ?? -1) === optionIndex
      );
      return {
        label: nonEmptyString(option?.label),
        leadsTo: nonEmptyString(target?.leadsTo),
      };
    });
    return { ...branch, options };
  });

  const endings = asArray(inventory?.endings).map((ending) => {
    const wiringEntry = asArray(wiring?.endingConditions).find(
      (entry) => String(entry?.endingId ?? "") === String(ending?.id ?? "")
    );
    return {
      ...ending,
      ...(wiringEntry?.requires !== undefined && wiringEntry?.requires !== null ? { requires: wiringEntry.requires } : {}),
      ...(wiringEntry?.blockers !== undefined ? { blockers: asArray(wiringEntry.blockers) } : {}),
    };
  });

  const merged = normalizeDeepParse({
    keyPoints: asArray(inventory?.keyPoints),
    branches,
    endings,
    keyPointConditions: asArray(wiring?.keyPointConditions),
    branchConditions: asArray(wiring?.branchConditions),
    plotEdges: asArray(wiring?.plotEdges),
  });
  return { deepParse: merged, issues: validateDeepParse(merged, flat) };
}

/**
 * 骨架锁定生成 Prompt：LLM 不生成新节点，只给确定性 keyPoints/branches
 * 挂条件、补 plotEdges、声明 endings（M3 核心）。
 *
 * @param {object} flat - { scenario:{text,name}, scenarioCheckpoints?, scenarioFacts?, entities?, keyPoints?, branches? }
 * @returns {string}
 */
export function buildSkeletonWiringPrompt(flat) {
  const text = String(flat?.scenario?.text ?? "");
  const name = String(flat?.scenario?.name ?? "剧本");
  const grounded = buildGroundedRef(flat);
  // 骨架为空时，从场景事实/检定点确定性生成节点骨架，避免 LLM 拿空骨架编 id。
  if (grounded.keyPoints.length === 0 && grounded.branches.length === 0) {
    const skeleton = buildDeterministicSkeleton(flat);
    grounded.keyPoints = skeleton.keyPoints;
    grounded.branches = skeleton.branches;
  }
  // 追加“玩家选择型最终分支”提取结果（id 保持 br-final-*/kp-final-*，带 finalChoice 标记）。
  {
    const finalChoice = extractFinalChoiceBranches(flat);
    for (const kp of finalChoice.keyPoints) {
      grounded.keyPoints.push({ ...kp });
    }
    for (const branch of finalChoice.branches) {
      grounded.branches.push({ ...branch });
    }
  }

  return [
    `你是 CoC 跑团剧本的结构化专家。请阅读剧本《${name}》的原文，只对下方“确定性节点骨架”做标注，不要生成任何新节点。`,
    ``,
    `只输出一个 JSON 对象（不要 Markdown 代码块），结构如下：`,
    `{`,
    `  "keyPointConditions": [{"keyPointId":"kp-1","requires":{"checkpointGroups":[["chk-1","chk-2"]]},"requiresAnyOf":[{"keyPointIds":["kp-2"]}]}],`,
    `  "branchConditions": [{"branchId":"br-1","requires":{"sanityEventIds":["chk-9"]},"autoChooseLabel":"掀开地毯查看"}],`,
    `  "plotEdges": [{"from":"br:br-1","to":"kp:kp-1","label":"撞门","requires":[],"consequences":{"setFlags":{"branch:br-1:chosen":"撞门"}}}],`,
    `  "endings": [{"id":"end-1","branchId":"br-1","title":"墨渊消散的结局","optionLabel":"逆序念诵（送神）","mutexGroup":"最终结局","requires":{"keyPointIds":["kp-7"],"branchChoiceIds":["br-1"],"optionLabel":"逆序念诵（送神）"},"blockers":[{"branchChoiceIds":["br-1"]}],"endingKeywords":["墨渊消散","送神"]}]`,
    `}`,
    ``,
    `约束：`,
    `- 不要生成 keyPoints 字段；keyPointConditions.keyPointId 必须来自下方骨架。`,
    `- branches 允许补充，但只能用于骨架无法表达“玩家选择型最终分支”时；补充的分支写在 deep-parse 的 branches 字段里，且 options 至少 2 个。`,
    `- 必须声明至少一个结局，endings 不得为空数组；必须给出足够的 plotEdges，不得为空数组。`,
    `- plotEdges 的 from/to 只能是 br:<branchId> / kp:<keyPointId> / end:<endingId>；end: 必须等于你声明的 endings[].id。`,
    `- 每个结局必须至少有一条 plotEdges 从 br:<branchId> 指向 end:<endingId>，作为该结局的入边。`,
    `- endings[].branchId 必须来自骨架分支或你补充的分支；optionLabel 必须等于该分支某个选项 label；`,
    `  同一最终分支的多个结局用 optionLabel 区分，且 requires/blockers 必须互不相同；mutexGroup 相同的结局互斥。`,
    `- 骨架中来自“最终抉择”的分支是玩家选择型最终分支；结局必须优先挂在这些分支上，不要挂在技能检定分支上。`,
    `- 最终抉择分支必须写一条 branchCondition：requires.scene 为其场景，禁止 autoChooseLabel。`,
    `- 骨架中来自检定点的分支（checkpointBranch）不需要写 branchCondition，也不要给它们挂结局。`,
    `- 条件对象只允许 scene / entryEvidence / checkpointGroups / sanityEventIds / keyPointIds / branchChoiceIds / optionLabel / not；`,
    `  能写 scene 就写 scene；多选项玩家选择分支不要写 branchCondition，除非给 autoChooseLabel。`,
    `- 条件宁缺毋滥，不要编造空条件。`,
    ``,
    `确定性节点骨架（你只能引用这里的 id）：`,
    JSON.stringify(grounded, null, 2),
    ``,
    `剧本原文：`,
    text.slice(0, 30000),
  ].join("\n");
}

/**
 * 解析骨架锁定生成结果：模型无关 JSON 提取 → 骨架锁定归一 → 确定性结构修复 → 校验。
 *
 * @param {string} rawText
 * @param {object} [flat]
 * @returns {{ deepParse: object|null, issues: string[], raw: string }}
 */
export function parseSkeletonWiringResult(rawText, flat) {
  const raw = String(rawText ?? "");
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    return { deepParse: null, issues: ["LLM 返回中没有合法 JSON 对象"], raw: raw.slice(0, 400) };
  }
  const canonical = canonicalizeDeepParse(parsed, { skeletonLocked: true });
  const issues = [...canonical.issues];
  const repaired = repairSkeletonWiringDeepParse(canonical.deepParse, flat);
  for (const repair of repaired.repairs) issues.push(`结构修复：${repair}`);
  issues.push(...validateDeepParse(repaired.deepParse, flat));
  return { deepParse: repaired.deepParse, issues, raw: raw.slice(0, 400) };
}

/**
 * 解析 LLM 返回的深度解析 JSON：模型无关 JSON 提取 → 归一 → 校验。
 * @param {string} rawText
 * @param {object} [flat] - 传入时校验 ID 引用
 * @returns {{ deepParse: object|null, issues: string[], raw: string }}
 */
export function parseDeepParseResult(rawText, flat) {
  const raw = String(rawText ?? "");
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    return { deepParse: null, issues: ["LLM 返回中没有合法 JSON 对象"], raw: raw.slice(0, 400) };
  }
  const canonical = canonicalizeDeepParse(parsed);
  const issues = [...canonical.issues, ...validateDeepParse(canonical.deepParse, flat)];
  return { deepParse: canonical.deepParse, issues, raw: raw.slice(0, 400) };
}

/**
 * 把已确认的深度解析条件写入 flat.keyPoints / flat.branches（D-4 运行时）。
 *
 * - 只覆盖 deepParse 中显式给出的节点；未覆盖节点保留确定性草拟条件。
 * - 条件对象浅拷贝，避免后续修改污染 deepParse 草稿。
 *
 * @param {object} flat - { keyPoints, branches, deepParse? }
 * @returns {{ keyPointsApplied: number, branchesApplied: number }}
 */
export function applyConfirmedDeepParse(flat) {
  const deepParse = flat?.deepParse ?? null;
  const keyPoints = asArray(flat?.keyPoints);
  const branches = asArray(flat?.branches);
  let keyPointsApplied = 0;
  let branchesApplied = 0;

  // 引擎规则 2：确认稿条件若没有 scene 门控，自动补目标节点 scene，
  // 避免纯 keyPointIds 链在多轮内把跨场景关键点全部自动揭示。
  const gateByScene = (condition, scene) => {
    if (condition === null || condition === undefined || typeof condition !== "object" || Array.isArray(condition)) return condition;
    const text = nonEmptyString(scene);
    if (text.length === 0 || (condition.scene !== undefined && condition.scene !== null)) return condition;
    if (Object.keys(condition).length === 1 && condition.not !== undefined) return condition;
    return { ...condition, scene: text };
  };

  for (const entry of asArray(deepParse?.keyPointConditions)) {
    const id = nonEmptyString(entry?.keyPointId);
    if (id.length === 0) continue;
    const kp = keyPoints.find((candidate) => String(candidate?.id ?? "") === id);
    if (kp === undefined) continue;
    if (entry?.requires !== undefined) kp.requires = gateByScene(entry.requires, kp.scene);
    if (entry?.requiresAnyOf !== undefined) {
      kp.requiresAnyOf = asArray(entry.requiresAnyOf).map((group) => gateByScene(group, kp.scene));
    }
    kp.deepParseApplied = true;
    keyPointsApplied += 1;
  }

  for (const entry of asArray(deepParse?.branchConditions)) {
    const id = nonEmptyString(entry?.branchId);
    if (id.length === 0) continue;
    const branch = branches.find((candidate) => String(candidate?.id ?? "") === id);
    if (branch === undefined) continue;
    if (entry?.requires !== undefined) branch.requires = gateByScene(entry.requires, branch.scene);
    if (entry?.requiresAnyOf !== undefined) {
      branch.requiresAnyOf = asArray(entry.requiresAnyOf).map((group) => gateByScene(group, branch.scene));
    }
    if (entry?.autoChooseLabel !== undefined && nonEmptyString(entry.autoChooseLabel).length > 0) {
      branch.autoChooseLabel = entry.autoChooseLabel;
    }
    branch.deepParseApplied = true;
    branchesApplied += 1;
  }

  return { keyPointsApplied, branchesApplied };
}

/**
 * 检测没有出口分支的场景（引擎规则 3：导入后给 KP 的确定性提示）。
 * 只做“分支选项 leadsTo / 深解析出边”两个信号，不作语义判断。
 *
 * @param {object} story - { keyPoints, branches }
 * @param {object} [deepParse] - flat.deepParse（可选，取其 plotEdges）
 * @returns {Array<{ scene: string, issue: string }>}
 */
export function detectDeadEndScenes(story, deepParse = null) {
  const issues = [];
  const branches = asArray(story?.branches);
  const keyPoints = asArray(story?.keyPoints);
  const scenes = new Set();
  for (const branch of branches) {
    const scene = nonEmptyString(branch?.scene);
    if (scene.length > 0) scenes.add(scene);
  }
  for (const kp of keyPoints) {
    const scene = nonEmptyString(kp?.scene);
    if (scene.length > 0) scenes.add(scene);
  }

  const branchExitByScene = new Map();
  for (const branch of branches) {
    const scene = nonEmptyString(branch?.scene);
    const hasExit = (branch?.options ?? []).some((option) => nonEmptyString(option?.leadsTo).length > 0);
    branchExitByScene.set(scene, (branchExitByScene.get(scene) ?? false) || hasExit);
  }

  const edgeExitByScene = new Map();
  const branchSceneById = new Map(branches.map((branch) => [String(branch?.id ?? ""), nonEmptyString(branch?.scene)]));
  const kpSceneById = new Map(keyPoints.map((kp) => [String(kp?.id ?? ""), nonEmptyString(kp?.scene)]));
  for (const edge of asArray(deepParse?.plotEdges)) {
    const from = nonEmptyString(edge?.from);
    let scene = "";
    if (from.startsWith("br:")) scene = branchSceneById.get(from.slice(3)) ?? "";
    else if (from.startsWith("kp:")) scene = kpSceneById.get(from.slice(3)) ?? "";
    if (scene.length > 0) edgeExitByScene.set(scene, true);
  }

  for (const scene of scenes) {
    if (branchExitByScene.get(scene) === true) continue;
    if (edgeExitByScene.get(scene) === true) continue;
    issues.push({ scene, issue: "no_exit" });
  }
  return issues;
}

/**
 * 生成即校验：在 LLM 生成/修订后、进入人工或 LLM 审核前，先做确定性结构检查。
 * 返回结构化 issue 列表，供生成器/修订器自动修正；pass 表示 high=0 且 medium=0。
 *
 * @param {object} deepParse - 已 normalize 的 deepParse
 * @param {object} flat - { keyPoints, branches, scenarioFacts?, ... }
 * @returns {{ issues: Array<{severity:string,where:string,problem:string,suggestion:string}>, high:number, medium:number, low:number, pass:boolean }}
 */
export function runDeepParsePreflight(deepParse, flat) {
  const issues = [];

  // 结构校验失败一律 high：引用不存在的节点/空条件/非法字段等。
  for (const message of validateDeepParse(deepParse, flat)) {
    issues.push({ severity: "high", where: "schema", problem: message, suggestion: "按提示修正字段或引用" });
  }

  const kpList = asArray(flat?.keyPoints);
  const branchList0 = asArray(flat?.branches);
  const endings0 = asArray(deepParse?.endings);
  const plotEdges0 = asArray(deepParse?.plotEdges);
  if (branchList0.length > 0 && endings0.length === 0) {
    issues.push({ severity: "high", where: "endings", problem: "有分支骨架但未声明任何结局", suggestion: "至少声明一个结局并给出入边" });
  }
  if (branchList0.length > 0 && plotEdges0.length === 0) {
    issues.push({ severity: "medium", where: "plotEdges", problem: "有分支骨架但 plotEdges 为空，剧情图无法连通", suggestion: "至少给出关键分支到关键点/结局的边" });
  }
  // 骨架或 deepParse 补充分支里存在“玩家选择型最终分支”时，结局必须挂在这些分支上，不得挂技能检定分支。
  const finalChoiceIds = new Set(
    [
      ...branchList0,
      ...asArray(deepParse?.branches),
    ].filter((branch) => branch?.finalChoice === true || String(branch?.id ?? "").startsWith("br-final")).map((branch) => String(branch?.id ?? "")),
  );
  {
    const allCandidateBranches = [
      ...branchList0,
      ...asArray(deepParse?.branches),
    ];
    const hasCheckpointBranches = allCandidateBranches.some((branch) => branch?.checkpointBranch === true);
    if (endings0.length > 0 && (finalChoiceIds.size > 0 || hasCheckpointBranches)) {
      // 允许挂结局的分支：最终抉择分支优先；补充分支若为“多选项且非检定点”同样可挂。
      const candidateIds = new Set([
        ...finalChoiceIds,
        ...allCandidateBranches
          .filter((branch) => branch?.finalChoice === true || String(branch?.id ?? "").startsWith("br-final") || (asArray(branch?.options).length >= 2 && branch?.checkpointBranch !== true))
          .map((branch) => String(branch?.id ?? "")),
      ]);
      for (let endingIndex = 0; endingIndex < endings0.length; endingIndex += 1) {
        const ending = endings0[endingIndex];
        if (!candidateIds.has(String(ending?.branchId ?? ""))) {
          issues.push({
            severity: "high",
            where: `endings[${endingIndex}].branchId`,
            problem: `结局必须挂在玩家选择型最终分支或多选项非检定点分支上（候选：${[...candidateIds].join(" / ") || "无"}），不能挂在技能检定分支：${String(ending?.branchId ?? "")}`,
            suggestion: "把 endings[].branchId 改为候选分支 id，并同步 optionLabel 为其选项 label",
          });
        }
        const requires = ending?.requires;
        const hasRequires = requires !== null && requires !== undefined && typeof requires === "object" && !Array.isArray(requires) && Object.keys(requires).length > 0;
        if (!hasRequires && ending?.requiresAnyOf === undefined) {
          issues.push({
            severity: "high",
            where: `endings[${endingIndex}].requires`,
            problem: `结局 ${String(ending?.title ?? ending?.id ?? "")} 缺少结构化 requires（至少要有 branchChoiceIds+optionLabel 或其他条件）`,
            suggestion: "补 requires：{branchChoiceIds:[<最终分支 id>], optionLabel:<选项 label>} 或 {keyPointIds:[...]}",
          });
        }
        const endingId = String(ending?.id ?? "");
        const directEdge = endingId.length > 0 && plotEdges0.some((edge) => String(edge?.from ?? "") === `br:${String(ending?.branchId ?? "")}` && String(edge?.to ?? "") === `end:${endingId}`);
        if (endingId.length > 0 && !directEdge) {
          issues.push({
            severity: "high",
            where: `endings[${endingIndex}]`,
            problem: `结局 ${String(ending?.title ?? endingId)} 缺少直接入边 br:${String(ending?.branchId ?? "")} → end:${endingId}`,
            suggestion: "补 plotEdges 项：{from:\"br:<branchId>\", to:\"end:<endingId>\", label:<选项 label>}",
          });
        }
      }
    }
  }

  const branchList = asArray(flat?.branches);
  const endings = asArray(deepParse?.endings);
  const plotEdges = asArray(deepParse?.plotEdges);
  const keyPointConditions = asArray(deepParse?.keyPointConditions);
  const branchConditions = asArray(deepParse?.branchConditions);
  // 最终抉择分支必须有 branchCondition 先 reached，且不能 autoChooseLabel 代选。
  if (finalChoiceIds.size > 0) {
    const finalBranches = [
      ...branchList0,
      ...asArray(deepParse?.branches),
    ].filter((branch) => finalChoiceIds.has(String(branch?.id ?? "")));
    for (const branch of finalBranches) {
      const id = String(branch?.id ?? "");
      if (!finalChoiceIds.has(id)) continue;
      const cond = branchConditions.find((entry) => String(entry?.branchId ?? "") === id);
      if (cond === undefined) {
        issues.push({
          severity: "high",
          where: `branchConditions[${id}]`,
          problem: `最终抉择分支 ${id} 缺少 branchCondition，运行时无法先 reached 等待玩家选择`,
          suggestion: `补 {branchId:"${id}", requires:{scene:"${String(branch?.scene ?? "")}"}}，且不要写 autoChooseLabel`,
        });
        continue;
      }
      if (String(cond?.autoChooseLabel ?? "").length > 0) {
        issues.push({
          severity: "high",
          where: `branchConditions[${id}].autoChooseLabel`,
          problem: `最终抉择分支 ${id} 不允许 autoChooseLabel，会剥夺玩家选择权`,
          suggestion: "删除 autoChooseLabel",
        });
      }
      const hasScene = cond?.requires?.scene !== undefined && cond?.requires?.scene !== null;
      const anyScene = asArray(cond?.requiresAnyOf).some((group) => group?.scene !== undefined && group?.scene !== null);
      if (!hasScene && !anyScene) {
        issues.push({
          severity: "high",
          where: `branchConditions[${id}]`,
          problem: `最终抉择分支 ${id} 的 branchCondition 必须带 scene 门控，否则会在任意场景 reached`,
          suggestion: `把 requires.scene 设为 ${String(branch?.scene ?? "")}`,
        });
      }
    }
  }
  // 多最终分支互斥：任一最终分支的 branchCondition 必须用 not 排除其它最终
  // 分支的共同前置关键点，否则两个分支都会 reached，但其中一个分支的结局
  // 条件不满足，玩家会卡在分支选项上。
  if (finalChoiceIds.size > 1) {
    for (const gap of computeFinalBranchMutexGaps(deepParse, finalChoiceIds)) {
      issues.push({
        severity: "high",
        where: `branchConditions[${gap.branchId}]`,
        problem: `最终分支 ${gap.branchId} 未排除其它最终分支的共同前置关键点：[${gap.keys.join(", ")}]，多个最终分支可能同时 reached 且结局不可选`,
        suggestion: `在 branchCondition.requires.not.keyPointIds 中加入这些 id（确定性修复会自动补）`,
      });
    }
  }

  const kpById = new Map(kpList.map((kp) => [String(kp?.id ?? ""), kp]));
  const branchById = new Map(branchList.map((branch) => [String(branch?.id ?? ""), branch]));

  // checkpointGroups 只能引用真实检定点 id；模型常会编造“克罗斯存活/死亡”
  // 这类状态短语，运行时永远无法满足。这里作为 high 结构问题拦下。
  const checkpointIds = new Set(
    asArray(flat?.scenarioCheckpoints).map((check) => String(check?.id ?? "")).filter((id) => id.length > 0)
  );
  if (checkpointIds.size > 0) {
    const validateCheckpointGroups = (condition, where) => {
      if (condition === null || condition === undefined || typeof condition !== "object" || Array.isArray(condition)) return;
      for (let groupIndex = 0; groupIndex < asArray(condition.checkpointGroups).length; groupIndex += 1) {
        for (const id of asArray(condition.checkpointGroups[groupIndex])) {
          if (nonEmptyString(id).length > 0 && !checkpointIds.has(String(id))) {
            issues.push({
              severity: "high",
              where,
              problem: `checkpointGroups 引用了不存在的检定点 id：${String(id)}（可用 id：${[...checkpointIds].join(" / ") || "无"}）`,
              suggestion: "改为真实检定点 id，或改用 keyPointIds/entryEvidence 表达状态",
            });
          }
        }
      }
      if (condition.not !== undefined && condition.not !== null && typeof condition.not === "object" && !Array.isArray(condition.not)) {
        validateCheckpointGroups(condition.not, `${where}.not`);
      }
    };
    for (let index = 0; index < keyPointConditions.length; index += 1) {
      const entry = keyPointConditions[index];
      validateCheckpointGroups(entry?.requires, `keyPointConditions[${index}].requires`);
      for (let groupIndex = 0; groupIndex < asArray(entry?.requiresAnyOf).length; groupIndex += 1) {
        validateCheckpointGroups(entry.requiresAnyOf[groupIndex], `keyPointConditions[${index}].requiresAnyOf[${groupIndex}]`);
      }
    }
    for (let index = 0; index < branchConditions.length; index += 1) {
      const entry = branchConditions[index];
      validateCheckpointGroups(entry?.requires, `branchConditions[${index}].requires`);
      for (let groupIndex = 0; groupIndex < asArray(entry?.requiresAnyOf).length; groupIndex += 1) {
        validateCheckpointGroups(entry.requiresAnyOf[groupIndex], `branchConditions[${index}].requiresAnyOf[${groupIndex}]`);
      }
    }
    for (let index = 0; index < endings.length; index += 1) {
      validateCheckpointGroups(endings[index]?.requires, `endings[${index}].requires`);
      for (let blockerIndex = 0; blockerIndex < asArray(endings[index]?.blockers).length; blockerIndex += 1) {
        validateCheckpointGroups(endings[index].blockers[blockerIndex], `endings[${index}].blockers[${blockerIndex}]`);
      }
    }
    for (let edgeIndex = 0; edgeIndex < plotEdges.length; edgeIndex += 1) {
      for (let condIndex = 0; condIndex < asArray(plotEdges[edgeIndex]?.requires).length; condIndex += 1) {
        validateCheckpointGroups(plotEdges[edgeIndex].requires[condIndex], `plotEdges[${edgeIndex}].requires[${condIndex}]`);
      }
    }
  }

  // 深解析自己生成的关键点/分支也要能引用。
  for (const kp of asArray(deepParse?.keyPoints)) {
    if (kpById.has(String(kp?.id ?? ""))) continue;
    kpById.set(String(kp?.id ?? ""), kp);
  }
  for (const branch of asArray(deepParse?.branches)) {
    if (branchById.has(String(branch?.id ?? ""))) continue;
    branchById.set(String(branch?.id ?? ""), branch);
  }

  const allKp = [...kpById.values()];
  const allBranches = [...branchById.values()];
  const sceneNames = new Set([
    ...allKp.map((kp) => nonEmptyString(kp?.scene)),
    ...allBranches.map((branch) => nonEmptyString(branch?.scene)),
    ...asArray(flat?.scenarioFacts).map((fact) => nonEmptyString(fact?.scene)).filter((item) => item.length > 0),
  ]);

  const titleTargets = [
    ...allKp.map((kp) => nonEmptyString(kp?.title)),
    ...allBranches.map((branch) => nonEmptyString(branch?.title)),
    ...endings.map((ending) => nonEmptyString(ending?.title)),
    ...endings.flatMap((ending) => asArray(ending?.endingKeywords).map((item) => nonEmptyString(item))),
  ].filter((item) => item.length > 0);

  const matchTitle = (text) => {
    const value = nonEmptyString(text);
    if (value.length === 0) return true;
    return titleTargets.some((title) => title === value || title.includes(value) || value.includes(title));
  };

  // 1. 分支选项 leadsTo 必须命中某个节点标题/结局关键词（否则运行时只能靠自动补点兜底）。
  for (const branch of allBranches) {
    for (let optionIndex = 0; optionIndex < asArray(branch?.options).length; optionIndex += 1) {
      const option = branch.options[optionIndex];
      const leadsTo = nonEmptyString(option?.leadsTo);
      if (leadsTo.length === 0) continue;
      if (!matchTitle(leadsTo) && !sceneNames.has(leadsTo)) {
        issues.push({
          severity: "medium",
          where: `branches[${String(branch.id)}].options[${optionIndex}].leadsTo`,
          problem: `leadsTo 未命中任何关键点/分支/结局标题或场景名：${leadsTo}`,
          suggestion: "把 leadsTo 改为现有关键点标题、结局标题/关键词，或现有场景名",
        });
      }
    }
  }

  // 2. 结局必须“有入边”：对应最终分支存在、optionLabel 能匹配该分支的选项。
  for (let endingIndex = 0; endingIndex < endings.length; endingIndex += 1) {
    const ending = endings[endingIndex];
    const where = `endings[${endingIndex}]`;
    const branch = branchById.get(String(ending?.branchId ?? ""));
    if (branch === undefined) continue; // validateDeepParse 已报 high
    const optionLabel = nonEmptyString(ending?.optionLabel);
    const branchOptions = asArray(branch.options);
    if (optionLabel.length > 0 && !branchOptions.some((option) => nonEmptyString(option?.label) === optionLabel)) {
      issues.push({
        severity: "high",
        where,
        problem: `ending.optionLabel 与分支 ${String(ending.branchId)} 的选项都不一致：${optionLabel}`,
        suggestion: "把 optionLabel 改为该分支某个选项原文",
      });
    }
    const titleOrKeywords = [
      nonEmptyString(ending?.title),
      ...asArray(ending?.endingKeywords).map((item) => nonEmptyString(item)),
    ].filter((item) => item.length > 0);
    const hasIncoming =
      branchOptions.some((option) => {
        const leadsTo = nonEmptyString(option?.leadsTo);
        return titleOrKeywords.some((word) => leadsTo === word || leadsTo.includes(word) || word.includes(leadsTo));
      }) ||
      plotEdges.some((edge) => {
        const to = nonEmptyString(edge?.to);
        if (!to.startsWith("end:")) return false;
        const rest = to.slice(4);
        const endingId = nonEmptyString(ending?.id);
        return rest === endingId || rest === nonEmptyString(ending?.title);
      });
    if (!hasIncoming) {
      issues.push({
        severity: "medium",
        where,
        problem: `结局没有任何分支选项 leadsTo 或 plotEdges end: 边指向它`,
        suggestion: "给对应最终分支的选项 leadsTo 写上结局标题/关键词，或增加一条指向该结局的 end: 边",
      });
    }
  }

  // 3. plotEdges 的 end: 端点必须能落到某个已声明结局。
  for (let edgeIndex = 0; edgeIndex < plotEdges.length; edgeIndex += 1) {
    const edge = plotEdges[edgeIndex];
    const to = nonEmptyString(edge?.to);
    if (!to.startsWith("end:")) continue;
    const rest = to.slice(4);
    const matched = endings.some((ending) => {
      const endingId = nonEmptyString(ending?.id);
      const endingTitle = nonEmptyString(ending?.title);
      return rest === endingId || rest === endingTitle;
    });
    if (!matched) {
      issues.push({
        severity: "high",
        where: `plotEdges[${edgeIndex}].to`,
        problem: `end: 端点没有对应已声明结局：${to}`,
        suggestion: "把 to 改成已声明 endings 的 id 或 title（如 end-1）",
      });
    }
  }

  // 4. 玩家选择型分支不要挂自动落地条件；挂了的必须显式 autoChooseLabel。
  for (let conditionIndex = 0; conditionIndex < branchConditions.length; conditionIndex += 1) {
    const entry = branchConditions[conditionIndex];
    const branch = branchById.get(String(entry?.branchId ?? ""));
    if (branch === undefined) continue;
    const options = asArray(branch.options);
    if (options.length <= 1) continue;
    // 最终抉择分支必须带 scene 门控且禁止 autoChooseLabel（上方有 high 校验），
    // 不再套用普通多选项分支必须显式 autoChooseLabel 的规则。
    if (finalChoiceIds.has(String(entry?.branchId ?? ""))) continue;
    if (nonEmptyString(entry?.autoChooseLabel).length === 0) {
      issues.push({
        severity: "medium",
        where: `branchConditions[${conditionIndex}]`,
        problem: `多选项分支 ${String(entry.branchId)} 挂了 branchCondition 但未给 autoChooseLabel，运行时只会 reached 不代选，容易让玩家失去选择时机`,
        suggestion: "若确为事件驱动分支，补 autoChooseLabel；若为玩家选择分支，删除该 branchCondition",
      });
    }
  }

  // 5. 纯 keyPointIds 链且无 scene 的条件（引擎会自动补 scene，但生成稿最好显式写）。
  const flagSceneMissing = (condition, where) => {
    if (condition === null || condition === undefined || typeof condition !== "object" || Array.isArray(condition)) return;
    if (condition.scene !== undefined && condition.scene !== null) return;
    if (condition.not !== undefined && Object.keys(condition).length === 1) return;
    if (asArray(condition.keyPointIds).length > 0 || asArray(condition.branchChoiceIds).length > 0) {
      issues.push({
        severity: "low",
        where,
        problem: "条件缺少 scene，依赖运行时自动补 scene 门控",
        suggestion: "显式补上 scene 更稳妥",
      });
    }
  };
  for (let conditionIndex = 0; conditionIndex < keyPointConditions.length; conditionIndex += 1) {
    const entry = keyPointConditions[conditionIndex];
    const kp = kpById.get(String(entry?.keyPointId ?? ""));
    flagSceneMissing(entry?.requires, `keyPointConditions[${conditionIndex}].requires`);
    for (const group of asArray(entry?.requiresAnyOf)) {
      flagSceneMissing(group, `keyPointConditions[${conditionIndex}].requiresAnyOf`);
    }
  }

  // 6. 真图可达性粗查：把节点清单 + leadsTo + plotEdges 建成有向图，
  //    以无入边节点为起点做 BFS；关键点/分支/结局不可达则报 high/medium。
  const nodeByTitle = new Map();
  for (const kp of allKp) {
    const title = nonEmptyString(kp?.title);
    if (title.length === 0) continue;
    const id = `kp:${String(kp?.id ?? "")}`;
    if (nodeByTitle.has(title)) nodeByTitle.get(title).push(id);
    else nodeByTitle.set(title, [id]);
  }
  for (const branch of allBranches) {
    const title = nonEmptyString(branch?.title);
    if (title.length === 0) continue;
    const id = `br:${String(branch?.id ?? "")}`;
    if (nodeByTitle.has(title)) nodeByTitle.get(title).push(id);
    else nodeByTitle.set(title, [id]);
  }
  for (const ending of endings) {
    const id = `end:${nonEmptyString(ending?.id)}`;
    for (const title of [nonEmptyString(ending?.title), ...asArray(ending?.endingKeywords).map((item) => nonEmptyString(item))]) {
      if (title.length === 0) continue;
      if (nodeByTitle.has(title)) nodeByTitle.get(title).push(id);
      else nodeByTitle.set(title, [id]);
    }
  }
  const resolveTitleToIds = (text) => {
    const value = nonEmptyString(text);
    if (value.length === 0) return [];
    const exact = nodeByTitle.get(value);
    if (exact !== undefined && exact.length > 0) return exact;
    const matches = [];
    for (const [title, ids] of nodeByTitle.entries()) {
      if (title.includes(value) || value.includes(title)) matches.push(...ids);
    }
    return [...new Set(matches)];
  };

  const adjacency = new Map();
  const addEdge = (from, to) => {
    if (from.length === 0 || to.length === 0 || from === to) return;
    if (adjacency.has(from)) adjacency.get(from).push(to);
    else adjacency.set(from, [to]);
  };

  for (const branch of allBranches) {
    const from = `br:${String(branch?.id ?? "")}`;
    for (const option of asArray(branch?.options)) {
      const leadsTo = nonEmptyString(option?.leadsTo);
      if (leadsTo.length === 0) continue;
      const titleMatches = resolveTitleToIds(leadsTo);
      for (const to of titleMatches) addEdge(from, to);
    }
  }
  for (const edge of plotEdges) {
    const from = nonEmptyString(edge?.from);
    const to = nonEmptyString(edge?.to);
    if (from.length === 0 || to.length === 0) continue;
    addEdge(from, to);
  }

  const nodeIds = new Set([
    ...allKp.map((kp) => `kp:${String(kp?.id ?? "")}`),
    ...allBranches.map((branch) => `br:${String(branch?.id ?? "")}`),
    ...endings.map((ending) => `end:${nonEmptyString(ending?.id)}`).filter((id) => id.length > 3),
  ]);
  const inDegree = new Map();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const targets of adjacency.values()) {
    for (const to of targets) inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }
  const starts = [...nodeIds].filter((id) => (inDegree.get(id) ?? 0) === 0);
  const reachable = new Set();
  const queue = [...starts];
  while (queue.length > 0) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }

  const endingIds = endings.map((ending) => `end:${nonEmptyString(ending?.id)}`);
  for (const ending of endings) {
    const id = `end:${nonEmptyString(ending?.id)}`;
    if (id.length <= 3) continue;
    if (!reachable.has(id)) {
      issues.push({
        severity: "high",
        where: `endings[${endingIds.indexOf(id)}]`,
        problem: `结局在剧情图上不可达（没有从任何入口节点连通的路径）：${nonEmptyString(ending?.title)}`,
        suggestion: "补上通往该结局的分支选项 leadsTo 或 plotEdges",
      });
    }
  }
  const generatedKpIds = new Set(asArray(deepParse?.keyPoints).map((kp) => String(kp?.id ?? "")));
  for (const kp of allKp) {
    const id = `kp:${String(kp?.id ?? "")}`;
    const isGenerated = generatedKpIds.has(String(kp?.id ?? ""));
    if (!reachable.has(id)) {
      const referencedByEnding = endings.some((ending) => asArray(ending?.requires).some((cond) => asArray(cond?.keyPointIds).map(String).includes(String(kp?.id ?? ""))));
      issues.push({
        severity: referencedByEnding ? "high" : "medium",
        where: `keyPoints[${String(kp?.id ?? "")}]`,
        problem: `关键点在剧情图上不可达：${nonEmptyString(kp?.title)}`,
        suggestion: "补上进入该关键点的分支选项 leadsTo 或 plotEdges",
      });
    } else if (isGenerated && (inDegree.get(id) ?? 0) === 0) {
      issues.push({
        severity: "medium",
        where: `keyPoints[${String(kp?.id ?? "")}]`,
        problem: `生成的关键点没有入边，可能无法被正常推进到：${nonEmptyString(kp?.title)}`,
        suggestion: "补上指向它的分支选项 leadsTo 或 plotEdges",
      });
    }
  }
  for (const branch of allBranches) {
    const id = `br:${String(branch?.id ?? "")}`;
    if (reachable.has(id)) continue;
    const referencedByEnding = endings.some((ending) => String(ending?.branchId ?? "") === String(branch?.id ?? ""));
    issues.push({
      severity: referencedByEnding ? "high" : "medium",
      where: `branches[${String(branch?.id ?? "")}]`,
      problem: `分支在剧情图上不可达：${nonEmptyString(branch?.title)}`,
      suggestion: "补上进入该分支的 leadsTo 或 plotEdges",
    });
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return { issues, ...counts, pass: counts.high === 0 && counts.medium === 0 };
}

/**
 * 同步 PlotGraph：先按 flat 剧情结构同步节点/边，再应用已确认 deepParse 的
 * plotEdges 与 endings（D-4 运行时）。deepParse 未确认时不追加。
 *
 * @param {object} plot - PlotGraph 实例
 * @param {object} deepParse - flat.deepParse
 * @param {object} story - { keyPoints, branches }
 * @returns {{ nodes: number, edges: number, edgesAdded: number, endingsAdded: number }}
 */
export function syncPlotGraphFromDeepParse(plot, deepParse, story) {
  plot.syncFromStory(story ?? { keyPoints: [], branches: [] });
  const applied = { nodes: plot.nodes.length, edges: plot.edges.length, edgesAdded: 0, endingsAdded: 0 };
  if (deepParse === null || deepParse === undefined || deepParse?.status !== "confirmed") return applied;

  const branches = asArray(story?.branches);
  const keyPoints = asArray(story?.keyPoints);

  // 边缘一致性修复：分支选项 leadsTo 没有命中任何现有关键点/分支/结局时，
  // 为它创建一个自动关键点节点并补边，避免场景流悬空（D-4 引擎侧修复 2）。
  const findNodeByTitle = (title) => {
    const text = nonEmptyString(title);
    if (text.length === 0) return undefined;
    return plot.nodes.find((node) => {
      if (node.type === "branch") return false;
      const nodeTitle = nonEmptyString(node.title);
      return nodeTitle === text || nodeTitle.includes(text) || text.includes(nodeTitle);
    });
  };
  let autoKpIndex = plot.nodes.filter((node) => String(node.id ?? "").startsWith("kp:auto:")).length + 1;
  for (const branch of branches) {
    for (const option of branch?.options ?? []) {
      const leadsTo = nonEmptyString(option?.leadsTo);
      if (leadsTo.length === 0) continue;
      if (findNodeByTitle(leadsTo) !== undefined) continue;
      const id = `kp:auto:${autoKpIndex}`;
      autoKpIndex += 1;
      plot.addNode({ id, title: leadsTo, type: "keypoint", scene: branch?.scene ?? "" });
      plot.addEdge(`br:${String(branch.id)}`, id, { label: nonEmptyString(option?.label), requires: [], consequences: null });
      applied.edgesAdded += 1;
    }
  }

  // 解析边端点：end:<id> 尽量归一化到已声明结局节点；kp:/br: 引用不存在时跳过。
  const resolveNodeRef = (ref) => {
    const value = nonEmptyString(ref);
    if (value.length === 0) return null;
    if (plot.findNode(value) !== undefined) return value;
    if (value.startsWith("end:")) {
      const rest = value.slice(4);
      const byId = plot.nodes.find((node) => String(node.id ?? "") === rest);
      if (byId !== undefined) return byId.id;
      const byTitle = plot.nodes.find((node) => node.type === "ending" && nonEmptyString(node.title) === rest);
      if (byTitle !== undefined) return byTitle.id;
      return null;
    }
    if (value.startsWith("kp:") || value.startsWith("br:")) {
      return plot.findNode(value) !== undefined ? value : null;
    }
    return plot.findNode(value) !== undefined ? value : null;
  };

  for (const edge of asArray(deepParse?.plotEdges)) {
    const from = resolveNodeRef(edge?.from);
    const to = resolveNodeRef(edge?.to);
    if (from === null || to === null) continue;
    const before = plot.edges.length;
    plot.addEdge(from, to, {
      label: nonEmptyString(edge?.label),
      requires: asArray(edge?.requires),
      consequences: edge?.consequences ?? null,
    });
    if (plot.edges.length > before) applied.edgesAdded += 1;
  }

  for (const ending of asArray(deepParse?.endings)) {
    const branchId = nonEmptyString(ending?.branchId);
    const title = nonEmptyString(ending?.title);
    if (branchId.length === 0 || title.length === 0) continue;
    const branch = branches.find((candidate) => String(candidate?.id ?? "") === branchId);
    const optionLabel = nonEmptyString(ending?.optionLabel);
    const chosen = nonEmptyString(branch?.chosen);
    const shouldComplete =
      branch?.reached === true && chosen.length > 0 && (optionLabel.length === 0 || chosen === optionLabel);
    const id = nonEmptyString(ending?.id) || `end:${branchId}:${plot.nodes.filter((node) => node.type === "ending" && node.branchId === branchId).length + 1}`;
    let node = plot.findNode(id);
    if (node === undefined) {
      node = plot.addNode({ id, title, type: "ending", scene: branch?.scene ?? "", description: optionLabel });
      applied.endingsAdded += 1;
    }
    node.title = title;
    node.branchId = branchId;
    node.optionLabel = optionLabel;
    node.chosen = chosen;
    node.endingKeywords = asArray(ending?.endingKeywords).map((item) => nonEmptyString(item)).filter((item) => item.length > 0);
    node.endingRequires = ending?.requires ?? null;
    node.endingBlockers = asArray(ending?.blockers);
    node.status = shouldComplete ? "completed" : node.status === "completed" ? "completed" : "inactive";
    if (node.consequences === null || node.consequences === undefined) {
      node.consequences = { setFlags: { [`ending:${branchId}:${title}`]: true } };
    }
    plot.addEdge(`br:${branchId}`, node.id, { label: optionLabel, requires: [], consequences: null });
  }

  applied.nodes = plot.nodes.length;
  applied.edges = plot.edges.length;
  return applied;
}

function nextAvailableNodeId(prefix, used) {
  let index = 1;
  while (used.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function remapConditionReferences(condition, kpMap, brMap) {
  if (condition === null || condition === undefined || typeof condition !== "object" || Array.isArray(condition)) {
    return condition;
  }
  const clone = { ...condition };
  if (Array.isArray(clone.keyPointIds)) {
    clone.keyPointIds = clone.keyPointIds.map((id) => kpMap.get(String(id)) ?? id);
  }
  if (Array.isArray(clone.branchChoiceIds)) {
    clone.branchChoiceIds = clone.branchChoiceIds.map((id) => brMap.get(String(id)) ?? id);
  }
  return clone;
}

/**
 * 把 LLM 生成的新关键点/分支合并进 flat（D-2 草稿阶段）。
 *
 * - 生成节点 id 与 flat 既有节点冲突时，分配 `ai-kp-N` / `ai-br-N` 新 id；
 * - 把 keyPointConditions / branchConditions / plotEdges / endings 中的引用
 *   同步重映射到最终 id；
 * - 返回新增数量与重映射后的 deepParse（不修改传入的 deepParse）。
 *
 * @param {object} flat - { keyPoints, branches, scenario? }
 * @param {object} deepParse - normalizeDeepParse 之后的深度解析对象
 * @returns {{ keyPointsAdded: number, branchesAdded: number, deepParse: object }}
 */
export function mergeDeepParseDraft(flat, deepParse) {
  const keyPoints = Array.isArray(flat?.keyPoints) ? flat.keyPoints : (flat.keyPoints = []);
  const branches = Array.isArray(flat?.branches) ? flat.branches : (flat.branches = []);

  const kpMap = new Map();
  const brMap = new Map();
  const usedKpIds = new Set(keyPoints.map((kp) => String(kp?.id ?? "").trim()).filter((id) => id.length > 0));
  const usedBrIds = new Set(branches.map((branch) => String(branch?.id ?? "").trim()).filter((id) => id.length > 0));

  const scenarioName = flat?.scenario?.name ?? flat?.scenarioId ?? "";

  let keyPointsAdded = 0;
  for (const kp of asArray(deepParse?.keyPoints)) {
    const rawId = nonEmptyString(kp?.id);
    let finalId = rawId;
    if (finalId.length === 0) {
      finalId = nextAvailableNodeId("ai-kp", usedKpIds);
    } else if (usedKpIds.has(finalId)) {
      // 与既有/已生成节点同 id：不再重复添加，引用保持指向该 id。
      kpMap.set(rawId, finalId);
      continue;
    }
    usedKpIds.add(finalId);
    keyPoints.push({
      ...kp,
      id: finalId,
      revealed: false,
      scenarioId: scenarioName,
    });
    kpMap.set(rawId, finalId);
    keyPointsAdded += 1;
  }

  let branchesAdded = 0;
  for (const branch of asArray(deepParse?.branches)) {
    const rawId = nonEmptyString(branch?.id);
    let finalId = rawId;
    if (finalId.length === 0) {
      finalId = nextAvailableNodeId("ai-br", usedBrIds);
    } else if (usedBrIds.has(finalId)) {
      // 骨架已存在该分支：保留骨架 options（玩家选择依据），但允许深度解析
      // 修订 scene/title（确定性提取的最终分支 scene 常是“剧情梗概”这类
      // 章节名，LLM 根据结局段落重定位的场景更准确）。
      const existingBranch = branches.find((candidate) => String(candidate?.id ?? "") === finalId);
      if (existingBranch !== undefined) {
        if (nonEmptyString(branch?.scene).length > 0) existingBranch.scene = nonEmptyString(branch.scene);
        if (nonEmptyString(branch?.title).length > 0) existingBranch.title = nonEmptyString(branch.title);
        if (asArray(branch?.options).length > 0 && asArray(existingBranch?.options).length === 0) {
          existingBranch.options = asArray(branch.options);
        }
      }
      brMap.set(rawId, finalId);
      continue;
    }
    usedBrIds.add(finalId);
    branches.push({
      ...branch,
      id: finalId,
      reached: false,
      chosen: null,
      scenarioId: scenarioName,
    });
    brMap.set(rawId, finalId);
    branchesAdded += 1;
  }

  const remapKp = (id) => kpMap.get(String(id)) ?? id;
  const remapBr = (id) => brMap.get(String(id)) ?? id;

  const remapped = {
    ...deepParse,
    keyPoints: asArray(deepParse?.keyPoints).map((kp) => ({ ...kp, id: remapKp(kp?.id) })),
    branches: asArray(deepParse?.branches).map((branch) => ({ ...branch, id: remapBr(branch?.id) })),
    keyPointConditions: asArray(deepParse?.keyPointConditions).map((entry) => ({
      ...entry,
      keyPointId: remapKp(entry?.keyPointId),
      ...(entry?.requires !== undefined ? { requires: remapConditionReferences(entry.requires, kpMap, brMap) } : {}),
      ...(entry?.requiresAnyOf !== undefined ? { requiresAnyOf: asArray(entry.requiresAnyOf).map((group) => remapConditionReferences(group, kpMap, brMap)) } : {}),
    })),
    branchConditions: asArray(deepParse?.branchConditions).map((entry) => ({
      ...entry,
      branchId: remapBr(entry?.branchId),
      ...(entry?.requires !== undefined ? { requires: remapConditionReferences(entry.requires, kpMap, brMap) } : {}),
      ...(entry?.requiresAnyOf !== undefined ? { requiresAnyOf: asArray(entry.requiresAnyOf).map((group) => remapConditionReferences(group, kpMap, brMap)) } : {}),
    })),
    plotEdges: asArray(deepParse?.plotEdges).map((edge) => {
      const clone = { ...edge };
      for (const field of ["from", "to"]) {
        const value = String(clone[field] ?? "");
        if (value.startsWith("kp:")) clone[field] = `kp:${remapKp(value.slice(3))}`;
        else if (value.startsWith("br:")) clone[field] = `br:${remapBr(value.slice(3))}`;
      }
      if (Array.isArray(clone.requires)) {
        clone.requires = clone.requires.map((condition) => remapConditionReferences(condition, kpMap, brMap));
      }
      return clone;
    }),
    endings: asArray(deepParse?.endings).map((ending) => ({
      ...ending,
      branchId: remapBr(ending?.branchId),
      ...(ending?.requires !== undefined ? { requires: remapConditionReferences(ending.requires, kpMap, brMap) } : {}),
      ...(ending?.blockers !== undefined ? { blockers: asArray(ending.blockers).map((blocker) => remapConditionReferences(blocker, kpMap, brMap)) } : {}),
    })),
  };

  return { keyPointsAdded, branchesAdded, deepParse: remapped };
}

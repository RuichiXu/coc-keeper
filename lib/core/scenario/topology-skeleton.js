/**
 * 剧情网络拓扑骨架后处理（网络拓扑保真）。
 *
 * 在 LLM 深度解析草稿合并归一之后、preflight 之前运行：
 * 1. 给关键点提供统一的 reachability 推断（strict/conditional/optional）；
 * 2. 基于结构树补确定性骨架边：
 *    - 同级 main 子节点呈顺序编号 → 按编号顺序补边；
 *    - 否则 hub-and-spoke（辐条出口指向独立虚拟返回点）；
 *    - 幕级并行：全剧 hub → 各幕入口，各幕出口 → 终幕 hub；
 * 3. 确定性补的边一律标记 fallback:true，前端可区分渲染。
 *
 * 零 DSH 依赖，不调用 LLM。
 */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

const SCENE_KINDS = new Set(["scene", "scene_event"]);
const REACHABILITY_VALUES = new Set(["strict", "conditional", "optional"]);

/**
 * 统一的关键点可达性推断。优先级：
 * 1. 显式 kp.reachability；
 * 2. flowRole=main → strict；flowRole=side/clue → conditional；
 * 3. 无 flowRole 时：scene_event 且父节点 flowRole=main → strict；
 *    其余场景类/非场景类节点 → conditional。
 * optional 只来自显式标记（未来结构分析输出附录/长期悬空标记时写）。
 *
 * @param {object} kp
 * @param {Map<string, object>} [kpById] - 可选，用于判断父节点 flowRole
 * @returns {"strict"|"conditional"|"optional"}
 */
export function inferReachability(kp, kpById = null) {
  const explicit = nonEmptyString(kp?.reachability);
  if (REACHABILITY_VALUES.has(explicit)) return explicit;

  const flowRole = nonEmptyString(kp?.flowRole);
  if (flowRole === "main") return "strict";
  if (flowRole === "side" || flowRole === "clue") return "conditional";

  const kind = nonEmptyString(kp?.kind);
  if (kind === "scene_event") {
    const parentId = nonEmptyString(kp?.parentId);
    if (parentId.length > 0 && kpById !== null && kpById !== undefined) {
      const parent = kpById.get(parentId);
      if (parent !== undefined && nonEmptyString(parent?.flowRole) === "main") return "strict";
    }
  }
  return "conditional";
}

export function isSceneLikeKp(kp) {
  return SCENE_KINDS.has(nonEmptyString(kp?.kind));
}

/**
 * 条件组是否只引用“已在可达集中的节点/检定点”。
 * scene/entryEvidence/optionLabel/sanityEventIds 不参与闭包判定（后者不在图节点中）。
 * not 内若引用已可达节点，则该条件不满足。
 *
 * @param {object|null} cond
 * @param {Set<string>} reachSet - 已可达节点 id（kp:1 / br:1 形式）
 * @param {Set<string>} checkpointIds - 全量检定点 id（存在即可）
 * @returns {boolean}
 */
export function conditionRefsSatisfied(cond, reachSet, checkpointIds = new Set()) {
  if (cond === null || cond === undefined || typeof cond !== "object" || Array.isArray(cond)) return true;

  for (const id of asArray(cond.keyPointIds).map(String)) {
    if (id.length === 0) continue;
    if (!reachSet.has(`kp:${id}`)) return false;
  }
  for (const id of asArray(cond.branchChoiceIds).map(String)) {
    if (id.length === 0) continue;
    if (!reachSet.has(`br:${id}`)) return false;
  }
  for (const group of asArray(cond.checkpointGroups)) {
    const ids = asArray(group).map(String);
    if (ids.length > 0 && !ids.some((id) => checkpointIds.has(id))) return false;
  }
  if (cond.not !== undefined && cond.not !== null) {
    const notCond = cond.not;
    // 闭包只评估 not 中的节点引用：not.keyPointIds / not.branchChoiceIds 已可达
    // 时该边被阻断；not.checkpointGroups / not.sanityEventIds 属于运行时检定状态，
    // 闭包阶段无法判定“未通过”，不应因此把边永久判死。
    for (const id of asArray(notCond?.keyPointIds).map(String)) {
      if (id.length > 0 && reachSet.has(`kp:${id}`)) return false;
    }
    for (const id of asArray(notCond?.branchChoiceIds).map(String)) {
      if (id.length > 0 && reachSet.has(`br:${id}`)) return false;
    }
  }
  return true;
}

function requiresRefsSatisfied(requires, reachSet, checkpointIds) {
  const list = asArray(requires);
  if (list.length === 0) return true;
  return list.every((cond) => conditionRefsSatisfied(cond, reachSet, checkpointIds));
}

function requiresAnyOfRefsSatisfied(requiresAnyOf, reachSet, checkpointIds) {
  const groups = asArray(requiresAnyOf);
  if (groups.length === 0) return true;
  return groups.some((group) => requiresRefsSatisfied([group], reachSet, checkpointIds));
}

function branchConditionRefsSatisfied(entry, reachSet, checkpointIds) {
  const requiresOk =
    entry?.requires === undefined || entry?.requires === null
      ? true
      : requiresRefsSatisfied([entry.requires], reachSet, checkpointIds);
  if (!requiresOk) return false;
  return requiresAnyOfRefsSatisfied(entry?.requiresAnyOf, reachSet, checkpointIds);
}

/**
 * 条件可达闭包：从开场节点出发，只有“前置引用已在可达集中”的边才能推进。
 * 同时允许 branchCondition 在条件被满足时激活分支节点。
 *
 * @param {object} options
 * @param {Set<string>} options.openingIds - 开场节点 id 集合（kp:1）
 * @param {Array<{from:string,to:string,requires?:Array<object>}>} options.edges
 * @param {Array<object>} options.branchConditions
 * @param {Set<string>} options.checkpointIds
 * @returns {Set<string>}
 */
export function computeConditionalClosure(options) {
  const openingIds = options.openingIds ?? new Set();
  const edges = asArray(options.edges);
  const branchConditions = asArray(options.branchConditions);
  const checkpointIds = options.checkpointIds ?? new Set();

  const reach = new Set(openingIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of branchConditions) {
      const branchId = nonEmptyString(entry?.branchId);
      if (branchId.length === 0) continue;
      const node = `br:${branchId}`;
      if (reach.has(node)) continue;
      if (branchConditionRefsSatisfied(entry, reach, checkpointIds)) {
        reach.add(node);
        changed = true;
      }
    }
    for (const edge of edges) {
      const from = nonEmptyString(edge?.from);
      const to = nonEmptyString(edge?.to);
      if (from.length === 0 || to.length === 0 || from === to) continue;
      if (!reach.has(from) || reach.has(to)) continue;
      if (!requiresRefsSatisfied(edge?.requires, reach, checkpointIds)) continue;
      reach.add(to);
      changed = true;
    }
  }
  return reach;
}

// ── 确定性骨架后处理 ───────────────────────────────────────

function sanitizeIdPart(value) {
  const text = String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  return text.slice(0, 48);
}

function parseCjkNumber(text) {
  const source = String(text ?? "");
  if (source.length === 0) return null;
  const digitMap = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (source.length === 1 && digitMap[source] !== undefined) return digitMap[source];
  if (source.length === 2 && (source === "十" || source[0] === "十")) {
    const ones = digitMap[source[1]] ?? 0;
    return 10 + ones;
  }
  if (source.length === 2 && source[1] === "十") {
    const tens = digitMap[source[0]] ?? 0;
    return tens * 10;
  }
  if (/^\d+$/.test(source)) return Number(source);
  return null;
}

function sequenceRank(title) {
  const text = nonEmptyString(title);
  if (text.length === 0) return null;
  // 第一幕 / 第二幕 / 第三章 / 第四节
  let match = text.match(/^第\s*([零一二两三四五六七八九十百\d]+)\s*[幕章节回篇]/);
  if (match !== null) return parseCjkNumber(match[1]);
  // 房间1 / 地点二 / 场景3 / 遭遇一 / 事件2
  match = text.match(/^(房间|地点|區域|区域|场景|幕|章|节|階段|阶段|部分|遭遇|事件)\s*([零一二两三四五六七八九十百\d]+)/);
  if (match !== null) return parseCjkNumber(match[2]);
  return null;
}

function hasSequentialTitles(items, titleOf) {
  const list = asArray(items);
  if (list.length < 2) return false;
  const ranks = list.map((item) => sequenceRank(titleOf(item)));
  if (ranks.some((rank) => rank === null)) return false;
  for (let index = 1; index < ranks.length; index += 1) {
    if (ranks[index] === null || ranks[index - 1] === null) return false;
    if (ranks[index] <= ranks[index - 1]) return false;
  }
  return true;
}

function edgeKeyOf(from, to) {
  return `${String(from ?? "")}->${String(to ?? "")}`;
}

function kpNode(kpId) {
  const id = String(kpId ?? "");
  return id.length === 0 ? "" : `kp:${id}`;
}

/**
 * 把结构树骨架补进 deepParse.plotEdges（LLM 边优先，只补缺口）。
 * 所有确定性补边带 fallback:true；虚拟枢纽/返回点写入 deepParse.keyPoints。
 *
 * @param {object} flat - { keyPoints, scenarioStructure }
 * @param {object} deepParse - { plotEdges, keyPoints }
 * @returns {{ nodesAdded:number, edgesAdded:number }}
 */
export function applyTopologySkeleton(flat, deepParse) {
  const dp = deepParse ?? flat?.deepParse;
  if (dp === null || dp === undefined) return { nodesAdded: 0, edgesAdded: 0 };

  const keyPoints = asArray(flat?.keyPoints);
  if (keyPoints.length === 0) return { nodesAdded: 0, edgesAdded: 0 };

  const plotEdges = Array.isArray(dp.plotEdges) ? dp.plotEdges : (dp.plotEdges = []);
  const dpKeyPoints = Array.isArray(dp.keyPoints) ? dp.keyPoints : (dp.keyPoints = []);
  const edgeKeys = new Set(plotEdges.map((edge) => edgeKeyOf(edge?.from, edge?.to)));
  const existingKpIds = new Set(keyPoints.map((kp) => String(kp?.id ?? "")).filter((id) => id.length > 0));
  const dpKpIds = new Set(dpKeyPoints.map((kp) => String(kp?.id ?? "")).filter((id) => id.length > 0));
  let nodesAdded = 0;
  let edgesAdded = 0;

  const kpById = new Map();
  for (const kp of keyPoints) kpById.set(String(kp?.id ?? ""), kp);
  for (const kp of dpKeyPoints) if (!kpById.has(String(kp?.id ?? ""))) kpById.set(String(kp?.id ?? ""), kp);

  const getOrCreateVirtual = (id, title, scene = "") => {
    const finalId = String(id ?? "");
    if (finalId.length === 0) return "";
    if (existingKpIds.has(finalId) || dpKpIds.has(finalId)) return finalId;
    dpKpIds.add(finalId);
    dpKeyPoints.push({
      id: finalId,
      title: nonEmptyString(title) || finalId,
      scene: nonEmptyString(scene),
      desc: "",
      kind: "scene_event",
      flowRole: null,
      reachability: "optional",
      virtual: true,
      parentId: null,
      order: 0,
      level: 0,
    });
    kpById.set(finalId, { id: finalId, title: nonEmptyString(title) || finalId, reachability: "optional", virtual: true });
    nodesAdded += 1;
    return finalId;
  };

  const addFallbackEdge = (from, to, label) => {
    if (from.length === 0 || to.length === 0 || from === to) return;
    const key = edgeKeyOf(from, to);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    plotEdges.push({ from, to, label: nonEmptyString(label) || "继续调查", requires: [], fallback: true });
    edgesAdded += 1;
  };

  const hasIncomingKp = (kpId) => {
    const target = kpNode(kpId);
    return plotEdges.some((edge) => nonEmptyString(edge?.to) === target && nonEmptyString(edge?.from) !== target);
  };
  const hasOutgoingKp = (kpId) => {
    const source = kpNode(kpId);
    return plotEdges.some((edge) => nonEmptyString(edge?.from) === source && nonEmptyString(edge?.to) !== source);
  };
  // 排除“自己的返回点 -> 自己”这种闭环入边：返回点本身不可达时，这条入边
  // 不会让枢纽在条件闭包中可达。
  const hasIncomingKpExcludingReturn = (kpId) => {
    const target = kpNode(kpId);
    const returnId = `${target}-return`;
    return plotEdges.some((edge) => {
      const to = nonEmptyString(edge?.to);
      const from = nonEmptyString(edge?.from);
      return to === target && from !== target && from !== returnId;
    });
  };

  const sections = asArray(flat?.scenarioStructure?.sections);
  const sectionById = new Map(sections.map((section) => [String(section?.id ?? ""), section]));

  // 场景关键点 → section 映射（结构分析产物带 sectionId）
  const sceneKps = keyPoints.filter((kp) => isSceneLikeKp(kp) && String(kp?.id ?? "").length > 0);
  const kpBySectionId = new Map();
  for (const kp of sceneKps) {
    const sectionId = nonEmptyString(kp?.sectionId);
    if (sectionId.length > 0 && sectionById.has(sectionId)) kpBySectionId.set(sectionId, kp);
  }

  // 分组：父 section id（或 root / kp 父节点 id）
  const groups = new Map();
  const assignedKpIds = new Set();
  if (sections.length > 0) {
    for (const section of sections) {
      if (!SCENE_KINDS.has(nonEmptyString(section?.kind))) continue;
      const sectionId = String(section?.id ?? "");
      const kp = kpBySectionId.get(sectionId);
      if (kp === undefined) continue;
      const parentKey = nonEmptyString(section?.parentId) || "root";
      if (!groups.has(parentKey)) groups.set(parentKey, []);
      groups.get(parentKey).push({ section, kp });
      assignedKpIds.add(String(kp?.id ?? ""));
    }
  }
  for (const kp of sceneKps) {
    if (assignedKpIds.has(String(kp?.id ?? ""))) continue;
    const parentKey = nonEmptyString(kp?.parentId) || "root";
    if (!groups.has(parentKey)) groups.set(parentKey, []);
    groups.get(parentKey).push({ section: null, kp });
  }

  const compareGroupItems = (a, b) => {
    const aOrder = Number(a?.section?.order ?? a?.kp?.order ?? 0);
    const bOrder = Number(b?.section?.order ?? b?.kp?.order ?? 0);
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aStart = Number(a?.section?.startLine ?? 0);
    const bStart = Number(b?.section?.startLine ?? 0);
    if (aStart !== bStart) return aStart - bStart;
    return String(a?.kp?.title ?? "").localeCompare(String(b?.kp?.title ?? ""), "zh-Hans-CN");
  };

  const childTitle = (item) => String(item?.kp?.title ?? item?.section?.title ?? "");

  // 1) 组内拓扑：顺序编号链或 hub-and-spoke；conditional 子节点从组内源节点补 hook。
  for (const [parentKey, items] of groups.entries()) {
    const mainItems = items
      .filter((item) => inferReachability(item.kp, kpById) === "strict")
      .sort(compareGroupItems);
    const conditionalItems = items.filter((item) => inferReachability(item.kp, kpById) === "conditional");
    if (mainItems.length === 0 && conditionalItems.length === 0) continue;

    const parentKp = parentKey !== "root" ? kpById.get(parentKey) : undefined;
    const parentIsScene = parentKp !== undefined && isSceneLikeKp(parentKp);

    let hubId = "";
    let hubIsVirtual = false;
    let returnId = "";
    let sourceForConditional = "";

    if (mainItems.length >= 2 && hasSequentialTitles(mainItems, childTitle)) {
      for (let index = 0; index < mainItems.length - 1; index += 1) {
        const current = mainItems[index];
        const next = mainItems[index + 1];
        const fromId = String(current?.kp?.id ?? "");
        const toId = String(next?.kp?.id ?? "");
        if (fromId.length === 0 || toId.length === 0) continue;
        if (!hasOutgoingKp(fromId)) addFallbackEdge(kpNode(fromId), kpNode(toId), "继续调查");
      }
      sourceForConditional = String(mainItems[0]?.kp?.id ?? "");
    } else if (mainItems.length >= 2) {
      // hub-and-spoke：只有非顺序编号时才创建虚拟枢纽/返回点。
      if (parentIsScene) {
        hubId = String(parentKp?.id ?? "");
        returnId = getOrCreateVirtual(`kp-${sanitizeIdPart(hubId) || "parent"}-return`, `${nonEmptyString(parentKp?.title) || "枢纽"}·返回`, nonEmptyString(parentKp?.scene));
      } else {
        const parentSection = parentKey !== "root" ? sectionById.get(parentKey) : undefined;
        const hubTitle = parentSection !== undefined ? `${nonEmptyString(parentSection?.displayName) || nonEmptyString(parentSection?.title) || "章节"}·枢纽` : "全剧枢纽";
        hubId = getOrCreateVirtual(`kp-hub-${sanitizeIdPart(parentKey) || "top"}`, hubTitle, "");
        returnId = getOrCreateVirtual(`kp-hub-${sanitizeIdPart(parentKey) || "top"}-return`, `${nonEmptyString(parentSection?.displayName) || nonEmptyString(parentSection?.title) || "全剧"}·返回`, "");
        hubIsVirtual = true;
      }
      for (const item of mainItems) {
        const childId = String(item?.kp?.id ?? "");
        if (childId.length === 0) continue;
        if (!hasIncomingKp(childId)) addFallbackEdge(kpNode(hubId), kpNode(childId), hubIsVirtual ? "前往" : "进入");
        if (!hasOutgoingKp(childId)) addFallbackEdge(kpNode(childId), kpNode(returnId), "返回枢纽");
      }
      if (hubId.length > 0 && returnId.length > 0) {
        addFallbackEdge(kpNode(returnId), kpNode(hubId), "回到枢纽");
      }
      sourceForConditional = hubId;
    } else if (mainItems.length === 1) {
      sourceForConditional = String(mainItems[0]?.kp?.id ?? "");
    } else if (parentIsScene) {
      sourceForConditional = String(parentKp?.id ?? "");
    } else {
      // 没有 main 子节点且没有场景父节点：给条件节点一个虚拟组枢纽。
      const parentSection = parentKey !== "root" ? sectionById.get(parentKey) : undefined;
      const hubTitle = parentSection !== undefined ? `${nonEmptyString(parentSection?.displayName) || nonEmptyString(parentSection?.title) || "章节"}·枢纽` : "全剧枢纽";
      hubId = getOrCreateVirtual(`kp-hub-${sanitizeIdPart(parentKey) || "top"}`, hubTitle, "");
      sourceForConditional = hubId;
    }

    for (const item of conditionalItems) {
      const childId = String(item?.kp?.id ?? "");
      if (childId.length === 0 || sourceForConditional.length === 0) continue;
      if (!hasIncomingKp(childId)) addFallbackEdge(kpNode(sourceForConditional), kpNode(childId), "关联调查");
    }
  }

  // 2) 幕级并行 / 章间缺口。
  const mainSceneKps = sceneKps
    .filter((kp) => inferReachability(kp, kpById) === "strict")
    .sort((a, b) => {
      const aOrder = Number(a?.order ?? 0);
      const bOrder = Number(b?.order ?? 0);
      if (aOrder !== bOrder) return aOrder - bOrder;
      return String(a?.title ?? "").localeCompare(String(b?.title ?? ""), "zh-Hans-CN");
    });
  if (mainSceneKps.length > 1) {
    const firstMain = mainSceneKps[0];
    const lastMain = mainSceneKps[mainSceneKps.length - 1];
    const chapterSections = sections.filter((section) => nonEmptyString(section?.kind) === "chapter");
    const chaptersWithMain = chapterSections
      .filter((chapter) => mainSceneKps.some((kp) => {
        const section = sectionById.get(String(kp?.sectionId ?? ""));
        if (section === undefined) return false;
        let cursor = section;
        const guard = new Set();
        while (cursor !== null && cursor !== undefined && !guard.has(String(cursor.id))) {
          guard.add(String(cursor.id));
          if (String(cursor.id) === String(chapter.id)) return true;
          const parentId = nonEmptyString(cursor.parentId);
          if (parentId.length === 0 || !sectionById.has(parentId)) break;
          cursor = sectionById.get(parentId);
        }
        return false;
      }))
      .sort((a, b) => Number(a?.order ?? 0) - Number(b?.order ?? 0) || Number(a?.startLine ?? 0) - Number(b?.startLine ?? 0));

    if (chaptersWithMain.length > 1) {
      const chapterEntries = chaptersWithMain.map((chapter) => {
        const members = mainSceneKps.filter((kp) => {
          const section = sectionById.get(String(kp?.sectionId ?? ""));
          if (section === undefined) return false;
          let cursor = section;
          const guard = new Set();
          while (cursor !== null && cursor !== undefined && !guard.has(String(cursor.id))) {
            guard.add(String(cursor.id));
            if (String(cursor.id) === String(chapter.id)) return true;
            const parentId = nonEmptyString(cursor.parentId);
            if (parentId.length === 0 || !sectionById.has(parentId)) break;
            cursor = sectionById.get(parentId);
          }
          return false;
        }).sort((a, b) => Number(a?.order ?? 0) - Number(b?.order ?? 0) || String(a?.title ?? "").localeCompare(String(b?.title ?? ""), "zh-Hans-CN"));
        return { chapter, first: members[0], last: members[members.length - 1] };
      }).filter((entry) => entry.first !== undefined);

      if (hasSequentialTitles(chapterEntries, (entry) => String(entry?.chapter?.title ?? ""))) {
        for (let index = 0; index < chapterEntries.length - 1; index += 1) {
          const current = chapterEntries[index];
          const next = chapterEntries[index + 1];
          if (current?.last !== undefined && next?.first !== undefined) {
            addFallbackEdge(kpNode(current.last.id), kpNode(next.first.id), "进入下一幕");
          }
        }
      } else {
        const topHub = getOrCreateVirtual("kp-hub-top", "全剧枢纽", "");
        const finalHub = getOrCreateVirtual("kp-hub-final", "终幕枢纽", "");
        // 全剧枢纽本身要从开场节点可达，否则闭包无法从开场走到各幕入口。
        if (firstMain !== undefined) {
          addFallbackEdge(kpNode(firstMain.id), kpNode(topHub), "汇入全剧枢纽");
        }
        for (const entry of chapterEntries) {
          const chapterHubId = `kp-hub-${sanitizeIdPart(String(entry.chapter?.id ?? "")) || "chapter"}`;
          const chapterHubExists = dpKpIds.has(chapterHubId) || existingKpIds.has(chapterHubId);
          if (chapterHubExists) {
            addFallbackEdge(kpNode(topHub), kpNode(chapterHubId), "进入本幕");
          } else if (entry?.first !== undefined && !hasIncomingKp(String(entry.first?.id ?? ""))) {
            addFallbackEdge(kpNode(topHub), kpNode(entry.first.id), "进入本幕");
          }
          if (chapterHubExists) {
            addFallbackEdge(kpNode(chapterHubId), kpNode(finalHub), "直接前往终幕");
          } else if (entry?.last !== undefined && !hasOutgoingKp(String(entry.last?.id ?? ""))) {
            addFallbackEdge(kpNode(entry.last.id), kpNode(finalHub), "幕间收束");
          }
        }
      }
    } else if (chaptersWithMain.length <= 1) {
      // 没有多章幕结构时，把首尾主场景与全剧/终幕枢纽连起来（仅缺口）。
      const rootItems = groups.get("root") ?? [];
      const rootMain = rootItems
        .filter((item) => inferReachability(item.kp, kpById) === "strict")
        .sort(compareGroupItems);
      if (rootMain.length > 1 && !hasSequentialTitles(rootMain, childTitle)) {
        const topHub = getOrCreateVirtual("kp-hub-top", "全剧枢纽", "");
        const finalHub = getOrCreateVirtual("kp-hub-final", "终幕枢纽", "");
        if (!hasIncomingKpExcludingReturn(String(firstMain?.id ?? ""))) addFallbackEdge(kpNode(topHub), kpNode(firstMain.id), "进入调查");
        if (!hasOutgoingKp(String(lastMain?.id ?? ""))) addFallbackEdge(kpNode(lastMain.id), kpNode(finalHub), "收束");
      }
      // 唯一 chapter（例如“绿人与锡尔伯里山”）的章节枢纽必须从全剧枢纽可达，
      // 否则其 strict 子节点会被 preflight 判为不可达。只有存在 root 主线场景时才
      // 需要这条外部入口；全剧都在这一个 chapter 内时维持原组内拓扑。
      if (chaptersWithMain.length === 1 && rootMain.length > 0) {
        const chapter = chaptersWithMain[0];
        const members = mainSceneKps
          .filter((kp) => {
            const section = sectionById.get(String(kp?.sectionId ?? ""));
            if (section === undefined) return false;
            let cursor = section;
            const guard = new Set();
            while (cursor !== null && cursor !== undefined && !guard.has(String(cursor.id))) {
              guard.add(String(cursor.id));
              if (String(cursor.id) === String(chapter.id)) return true;
              const parentId = nonEmptyString(cursor.parentId);
              if (parentId.length === 0 || !sectionById.has(parentId)) break;
              cursor = sectionById.get(parentId);
            }
            return false;
          })
          .sort((a, b) => Number(a?.order ?? 0) - Number(b?.order ?? 0) || Number(a?.sectionId ?? "").localeCompare(String(b?.sectionId ?? ""), "zh-Hans-CN"));
        const first = members[0];
        const last = members[members.length - 1];
        const chapterHubId = `kp-hub-${sanitizeIdPart(String(chapter?.id ?? "")) || "chapter"}`;
        const chapterHubExists = dpKpIds.has(chapterHubId) || existingKpIds.has(chapterHubId);
        const topHub = getOrCreateVirtual("kp-hub-top", "全剧枢纽", "");
        const finalHub = getOrCreateVirtual("kp-hub-final", "终幕枢纽", "");
        if (!hasIncomingKpExcludingReturn(topHub)) addFallbackEdge(kpNode(firstMain.id), kpNode(topHub), "汇入全剧枢纽");
        if (chapterHubExists) {
          if (!hasIncomingKpExcludingReturn(chapterHubId)) addFallbackEdge(kpNode(topHub), kpNode(chapterHubId), "进入本幕");
          if (!hasOutgoingKp(chapterHubId)) addFallbackEdge(kpNode(chapterHubId), kpNode(finalHub), "直接前往终幕");
        } else {
          if (first !== undefined && !hasIncomingKpExcludingReturn(String(first?.id ?? ""))) addFallbackEdge(kpNode(topHub), kpNode(first.id), "进入本幕");
          if (last !== undefined && !hasOutgoingKp(String(last?.id ?? ""))) addFallbackEdge(kpNode(last.id), kpNode(finalHub), "幕间收束");
        }
      }
    }
  }

  return { nodesAdded, edgesAdded };
}

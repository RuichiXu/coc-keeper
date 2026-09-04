/**
 * 规则化审校（待办 #4）：用确定性规则替代/补充 LLM 语义审校的波动。
 *
 * 与 runDeepParsePreflight 互补：
 * - preflight 管“结构门禁”：引用节点是否存在、结局是否挂最终分支、是否缺
 *   入边、最终分支是否带 scene 门控、多最终分支互斥缺口；
 * - 本模块管“规则可判定的语义问题”：条件引用存在性、条件自相矛盾、结局
 *   互斥完备性、排除条件过度限制、结局场景与分支场景一致性、结局前置关键
 *   点的循环依赖、入边与结局 requires 一致性。
 *
 * 规则只做客观检查，不做文本理解。所有输出都是结构化 issue，供 loop 的
 * 修订轮次直接回灌模型，也供离线脚本单独审校。
 *
 * 零 DSH 依赖。
 */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

function isObject(value) {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

/**
 * 条件签名：把语义上等价的列表排序后 JSON 化，用于比较两个条件是否相同。
 * @param {object|undefined} cond
 * @returns {string}
 */
export function conditionSignature(cond) {
  if (cond === undefined || cond === null) return JSON.stringify(cond ?? null);
  if (!isObject(cond)) return JSON.stringify(cond);
  const out = {};
  for (const key of Object.keys(cond).sort()) {
    const value = cond[key];
    if (key === "not") {
      out[key] = conditionSignature(value);
    } else if (key === "checkpointGroups") {
      out[key] = asArray(value)
        .map((group) => asArray(group).map((id) => String(id)).sort())
        .sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000"), "zh-Hans-CN"));
    } else if (key === "entryEvidence" || key === "sanityEventIds" || key === "keyPointIds" || key === "branchChoiceIds") {
      out[key] = asArray(value).map((id) => String(id)).sort();
    } else if (key === "optionLabel") {
      out[key] = Array.isArray(value) ? [...value].map((item) => String(item)).sort() : value;
    } else {
      out[key] = value;
    }
  }
  return JSON.stringify(out);
}

function signaturesOf(requiresArray) {
  return asArray(requiresArray).map((condition) => conditionSignature(condition)).sort();
}

/**
 * 递归遍历条件树中的每一个条件对象（含 not 子树）。
 * @param {object|null} cond
 * @param {string} where
 * @param {Function} visit - (cond, where) => void
 */
function walkCondition(cond, where, visit) {
  if (!isObject(cond)) return;
  visit(cond, where);
  if (isObject(cond.not)) walkCondition(cond.not, `${where}.not`, visit);
}

/**
 * 遍历 deepParse 中所有条件对象。
 * @param {object} deepParse
 * @param {Function} visit - (cond, where, kind) => void
 *   kind: "keypoint" | "branch" | "ending-requires" | "ending-blocker" | "edge"
 */
function walkAllConditions(deepParse, visit) {
  for (let index = 0; index < asArray(deepParse?.keyPointConditions).length; index += 1) {
    const entry = deepParse.keyPointConditions[index];
    walkCondition(entry?.requires, `keyPointConditions[${index}].requires`, (cond, where) => visit(cond, where, "keypoint"));
    for (let groupIndex = 0; groupIndex < asArray(entry?.requiresAnyOf).length; groupIndex += 1) {
      walkCondition(entry.requiresAnyOf[groupIndex], `keyPointConditions[${index}].requiresAnyOf[${groupIndex}]`, (cond, where) => visit(cond, where, "keypoint"));
    }
  }
  for (let index = 0; index < asArray(deepParse?.branchConditions).length; index += 1) {
    const entry = deepParse.branchConditions[index];
    walkCondition(entry?.requires, `branchConditions[${index}].requires`, (cond, where) => visit(cond, where, "branch"));
    for (let groupIndex = 0; groupIndex < asArray(entry?.requiresAnyOf).length; groupIndex += 1) {
      walkCondition(entry.requiresAnyOf[groupIndex], `branchConditions[${index}].requiresAnyOf[${groupIndex}]`, (cond, where) => visit(cond, where, "branch"));
    }
  }
  for (let index = 0; index < asArray(deepParse?.endings).length; index += 1) {
    const ending = deepParse.endings[index];
    walkCondition(ending?.requires, `endings[${index}].requires`, (cond, where) => visit(cond, where, "ending-requires"));
    for (let blockerIndex = 0; blockerIndex < asArray(ending?.blockers).length; blockerIndex += 1) {
      walkCondition(ending.blockers[blockerIndex], `endings[${index}].blockers[${blockerIndex}]`, (cond, where) => visit(cond, where, "ending-blocker"));
    }
  }
  for (let index = 0; index < asArray(deepParse?.plotEdges).length; index += 1) {
    const edge = deepParse.plotEdges[index];
    for (let condIndex = 0; condIndex < asArray(edge?.requires).length; condIndex += 1) {
      walkCondition(edge.requires[condIndex], `plotEdges[${index}].requires[${condIndex}]`, (cond, where) => visit(cond, where, "edge"));
    }
  }
}

/**
 * 收集可引用的 id 集合。
 */
function collectReferenceIds(deepParse, flat) {
  const keyPointIds = new Set(asArray(flat?.keyPoints).map((kp) => String(kp?.id ?? "")).filter((id) => id.length > 0));
  const branchIds = new Set(asArray(flat?.branches).map((branch) => String(branch?.id ?? "")).filter((id) => id.length > 0));
  const checkpointIds = new Set(asArray(flat?.scenarioCheckpoints).map((check) => String(check?.id ?? "")).filter((id) => id.length > 0));
  for (const kp of asArray(deepParse?.keyPoints)) {
    const id = nonEmptyString(kp?.id);
    if (id.length > 0) keyPointIds.add(id);
  }
  for (const branch of asArray(deepParse?.branches)) {
    const id = nonEmptyString(branch?.id);
    if (id.length > 0) branchIds.add(id);
  }
  return { keyPointIds, branchIds, checkpointIds };
}

/**
 * 收集最终抉择分支 id 与每个分支的 scene 门控。
 */
function collectFinalBranches(deepParse, flat) {
  const allBranches = [...asArray(flat?.branches), ...asArray(deepParse?.branches)];
  const referencedBranchIds = new Set();
  for (const ending of asArray(deepParse?.endings)) {
    for (const id of asArray(ending?.requires?.branchChoiceIds)) {
      const value = String(id ?? "");
      if (value.length > 0) referencedBranchIds.add(value);
    }
  }
  const finals = allBranches.filter(
    (branch) =>
      branch?.finalChoice === true ||
      /^br-(final|failure|success|ending)/i.test(String(branch?.id ?? "")) ||
      referencedBranchIds.has(String(branch?.id ?? "")) ||
      /最终|结局/.test(String(branch?.title ?? ""))
  );
  const ids = new Set(finals.map((branch) => String(branch?.id ?? "")));
  const branchById = new Map(allBranches.map((branch) => [String(branch?.id ?? ""), branch]));
  const sceneByBranch = new Map();
  for (const branchId of ids) {
    const cond = asArray(deepParse?.branchConditions).find((entry) => String(entry?.branchId ?? "") === branchId);
    const condScene =
      isObject(cond?.requires) && nonEmptyString(cond.requires.scene).length > 0
        ? nonEmptyString(cond.requires.scene)
        : "";
    const branch = branchById.get(branchId);
    const scene = condScene.length > 0 ? condScene : nonEmptyString(branch?.scene);
    sceneByBranch.set(branchId, scene);
  }
  return { ids, branchById, sceneByBranch };
}

/**
 * 收集已知场景名：场景事实 heading/scene + 全部关键点/分支 scene + 最终分支标题。
 */
function collectSceneNames(deepParse, flat, finalBranchById) {
  const names = new Set();
  for (const fact of asArray(flat?.scenarioFacts)) {
    const heading = nonEmptyString(fact?.heading) || nonEmptyString(fact?.scene);
    if (heading.length > 0) names.add(heading);
    const scene = nonEmptyString(fact?.scene);
    if (scene.length > 0) names.add(scene);
  }
  for (const kp of [...asArray(flat?.keyPoints), ...asArray(deepParse?.keyPoints)]) {
    const scene = nonEmptyString(kp?.scene);
    if (scene.length > 0) names.add(scene);
  }
  for (const branch of [...asArray(flat?.branches), ...asArray(deepParse?.branches)]) {
    const scene = nonEmptyString(branch?.scene);
    if (scene.length > 0) names.add(scene);
    const title = nonEmptyString(branch?.title);
    if (title.length > 0) names.add(title);
  }
  for (const branch of finalBranchById.values()) {
    const title = nonEmptyString(branch?.title);
    if (title.length > 0) names.add(title);
  }
  return names;
}

/**
 * 构建剧情有向图并计算可达性（与 preflight 的粗查图同构）。
 * 返回 { reachableFull, reachableWithout } 与节点标题映射。
 */
function buildReachability(deepParse, flat) {
  const allKp = [...asArray(flat?.keyPoints), ...asArray(deepParse?.keyPoints)];
  const allBranches = [...asArray(flat?.branches), ...asArray(deepParse?.branches)];
  const endings = asArray(deepParse?.endings);

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
      for (const to of resolveTitleToIds(leadsTo)) addEdge(from, to);
    }
  }
  for (const edge of asArray(deepParse?.plotEdges)) {
    addEdge(nonEmptyString(edge?.from), nonEmptyString(edge?.to));
  }

  const nodeIds = new Set([
    ...allKp.map((kp) => `kp:${String(kp?.id ?? "")}`),
    ...allBranches.map((branch) => `br:${String(branch?.id ?? "")}`),
    ...endings.map((ending) => `end:${nonEmptyString(ending?.id)}`).filter((id) => id.length > 3),
  ]);
  // 起点始终按“完整图”的入度计算；排除边只影响遍历，不能让被排除边
  // 指向的节点变成起点（否则循环依赖检查会失效）。
  const fullInDegree = new Map();
  for (const id of nodeIds) fullInDegree.set(id, 0);
  for (const targets of adjacency.values()) {
    for (const to of targets) fullInDegree.set(to, (fullInDegree.get(to) ?? 0) + 1);
  }
  const starts = [...nodeIds].filter((id) => (fullInDegree.get(id) ?? 0) === 0);
  const bfs = (excludedFrom) => {
    const reachable = new Set();
    const queue = [...starts];
    while (queue.length > 0) {
      const id = queue.shift();
      if (reachable.has(id)) continue;
      reachable.add(id);
      if (excludedFrom !== undefined && id === excludedFrom) continue;
      for (const next of adjacency.get(id) ?? []) {
        if (!reachable.has(next)) queue.push(next);
      }
    }
    return reachable;
  };

  return {
    nodeByTitle,
    resolveTitleToIds,
    nodeIds,
    reachableFull: bfs(undefined),
    reachableWithout: (branchId) => bfs(`br:${branchId}`),
  };
}

/**
 * 规则化审校主入口。
 *
 * @param {object} deepParse - 已归一化并经过 repairSkeletonWiringDeepParse 的草稿
 * @param {object} flat - { keyPoints, branches, scenarioCheckpoints?, scenarioFacts?, scenario? }
 * @param {{ severityGate?: { high: number, medium: number } }} [options]
 * @returns {{ issues: Array<{severity:string,where:string,problem:string,suggestion:string}>, high:number, medium:number, low:number, pass:boolean }}
 */
export function runDeepParseRuleReview(deepParse, flat, options = {}) {
  const gate = options.severityGate ?? { high: 0, medium: 2 };
  const issues = [];

  if (deepParse === null || deepParse === undefined || typeof deepParse !== "object" || Array.isArray(deepParse)) {
    return { issues, high: 0, medium: 0, low: 0, pass: true };
  }

  const { keyPointIds, branchIds, checkpointIds } = collectReferenceIds(deepParse, flat);
  const final = collectFinalBranches(deepParse, flat);
  const sceneNames = collectSceneNames(deepParse, flat, final.branchById);
  const endings = asArray(deepParse?.endings);
  const plotEdges = asArray(deepParse?.plotEdges);

  // R0：最终接线硬门禁（repair 前移后仍有漏网时兜底）。
  for (let endingIndex = 0; endingIndex < endings.length; endingIndex += 1) {
    const ending = endings[endingIndex];
    if (nonEmptyString(ending?.branchId).length === 0) {
      issues.push({
        severity: "high",
        where: `endings[${endingIndex}].branchId`,
        problem: `结局「${nonEmptyString(ending?.title)}」缺少 branchId，运行时无法挂到最终分支`,
        suggestion: "把 branchId 设为对应玩家选择型最终分支 id",
      });
    }
  }
  for (const branchId of final.ids) {
    const branch = final.branchById.get(branchId);
    if (branch === undefined) continue;
    if (asArray(branch?.options).length === 0) {
      issues.push({
        severity: "high",
        where: `branches[${branchId}].options`,
        problem: `最终分支 ${branchId} 没有选项，玩家无法选择`,
        suggestion: "从结局 requires.optionLabel 反推选项，或改为自动判定型分支",
      });
    }
  }
  for (let edgeIndex = 0; edgeIndex < plotEdges.length; edgeIndex += 1) {
    const edge = plotEdges[edgeIndex];
    const from = String(edge?.from ?? "");
    const to = String(edge?.to ?? "");
    if (from.startsWith("br:") && to.startsWith("end:") && nonEmptyString(edge?.label).length === 0) {
      issues.push({
        severity: "high",
        where: `plotEdges[${edgeIndex}]`,
        problem: `最终分支→结局边 ${from}→${to} 缺少 label，无法按玩家选项路由`,
        suggestion: "补 label 为对应结局 requires.optionLabel",
      });
    }
  }

  // R1：条件引用存在性。条件里引用的 keyPointIds / branchChoiceIds /
  // sanityEventIds 必须是真实存在的 id，否则运行时永远无法满足。
  walkAllConditions(deepParse, (cond, where) => {
    for (const id of asArray(cond?.keyPointIds)) {
      if (nonEmptyString(id).length > 0 && !keyPointIds.has(String(id))) {
        issues.push({
          severity: "high",
          where: `${where}.keyPointIds`,
          problem: `条件引用了不存在的关键点 id：${String(id)}`,
          suggestion: "改为真实关键点 id，或删去该 keyPointIds",
        });
      }
    }
    for (const id of asArray(cond?.branchChoiceIds)) {
      if (nonEmptyString(id).length > 0 && !branchIds.has(String(id))) {
        issues.push({
          severity: "high",
          where: `${where}.branchChoiceIds`,
          problem: `条件引用了不存在的分支 id：${String(id)}`,
          suggestion: "改为真实分支 id，或删去该 branchChoiceIds",
        });
      }
    }
    if (checkpointIds.size > 0) {
      for (const id of asArray(cond?.sanityEventIds)) {
        if (nonEmptyString(id).length > 0 && !checkpointIds.has(String(id))) {
          issues.push({
            severity: "high",
            where: `${where}.sanityEventIds`,
            problem: `条件引用了不存在的 SAN 结算事件 id：${String(id)}（可用检定点 id 作为 SAN 事件 id）`,
            suggestion: "改为真实检定点 id，或改用 keyPointIds/entryEvidence",
          });
        }
      }
    }
  });

  // R2：条件自相矛盾（同一条件对象内同时要求并排除同一目标）。
  walkAllConditions(deepParse, (cond, where) => {
    if (!isObject(cond)) return;
    for (const key of ["keyPointIds", "branchChoiceIds", "sanityEventIds"]) {
      const positive = new Set(asArray(cond[key]).map((id) => String(id)));
      const negative = new Set(isObject(cond.not) ? asArray(cond.not[key]).map((id) => String(id)) : []);
      for (const id of positive) {
        if (negative.has(id)) {
          issues.push({
            severity: "high",
            where: `${where}.${key}`,
            problem: `条件自相矛盾：同时要求 ${key} 包含 ${id}，又被 not 排除`,
            suggestion: "删去其中一侧的引用",
          });
        }
      }
    }
    if (nonEmptyString(cond.scene).length > 0 && isObject(cond.not) && nonEmptyString(cond.not.scene) === nonEmptyString(cond.scene)) {
      issues.push({
        severity: "high",
        where: `${where}.scene`,
        problem: `条件自相矛盾：scene 既要求 ${nonEmptyString(cond.scene)}，又被 not 排除`,
        suggestion: "删去 not.scene 或 scene",
      });
    }
    const positiveGroups = asArray(cond.checkpointGroups).map((group) => asArray(group).map((id) => String(id)).sort().join("\u0000"));
    const negativeGroups = isObject(cond.not) ? asArray(cond.not.checkpointGroups).map((group) => asArray(group).map((id) => String(id)).sort().join("\u0000")) : [];
    for (const group of positiveGroups) {
      if (negativeGroups.includes(group)) {
        issues.push({
          severity: "high",
          where: `${where}.checkpointGroups`,
          problem: `条件自相矛盾：checkpointGroups 中同一检定点组既被要求又被 not 排除`,
          suggestion: "删去其中一侧的检定点组",
        });
      }
    }
  });

  // R3：结局互斥完备性。同一最终分支的多个结局必须能被 optionLabel 区分；
  // 最终分支的每个选项都应有对应结局或明确去向。
  for (const branchId of final.ids) {
    const branch = final.branchById.get(branchId);
    if (branch === undefined) continue;
    const branchOptions = asArray(branch.options);
    const branchEndings = endings.filter((ending) => String(ending?.branchId ?? "") === branchId);

    // 选项覆盖：每个最终选项都应有结局或可解析去向。
    const titleIds = new Map();
    for (const ending of endings) {
      const title = nonEmptyString(ending?.title);
      const id = `end:${nonEmptyString(ending?.id)}`;
      if (title.length > 0) titleIds.set(title, id);
      for (const word of asArray(ending?.endingKeywords).map((item) => nonEmptyString(item))) {
        if (word.length > 0 && !titleIds.has(word)) titleIds.set(word, id);
      }
    }
    for (let optionIndex = 0; optionIndex < branchOptions.length; optionIndex += 1) {
      const option = branchOptions[optionIndex];
      const label = nonEmptyString(option?.label);
      if (label.length === 0) continue;
      const hasMatchingEnding = branchEndings.some((ending) => nonEmptyString(ending?.optionLabel) === label);
      const leadsTo = nonEmptyString(option?.leadsTo);
      const leadsToResolves =
        leadsTo.length > 0 &&
        ([...titleIds.keys()].some((title) => title === leadsTo || title.includes(leadsTo) || leadsTo.includes(title)) ||
          sceneNames.has(leadsTo));
      if (!hasMatchingEnding && !leadsToResolves) {
        issues.push({
          severity: "medium",
          where: `branches[${branchId}].options[${optionIndex}]`,
          problem: `最终抉择选项「${label}」没有对应结局（optionLabel 不匹配）也没有可解析去向`,
          suggestion: "为该选项补一个结局并设 optionLabel，或把 leadsTo 指向已有结局标题/关键词",
        });
      }
    }

    if (branchEndings.length >= 2) {
      // 多结局的最终分支必须为每条结局写 optionLabel。
      for (let endingIndex = 0; endingIndex < branchEndings.length; endingIndex += 1) {
        const ending = branchEndings[endingIndex];
        if (nonEmptyString(ending?.optionLabel).length === 0) {
          issues.push({
            severity: "high",
            where: `endings[${endings.indexOf(ending)}].optionLabel`,
            problem: `最终分支 ${branchId} 有 ${branchEndings.length} 条结局，但结局「${nonEmptyString(ending?.title)}」缺少 optionLabel，运行时无法区分`,
            suggestion: "补 optionLabel 为该最终分支某个选项原文",
          });
        }
      }
      // 两两比较：optionLabel 相同或 requires 完全一致都会互斥失效。
      for (let i = 0; i < branchEndings.length; i += 1) {
        for (let j = i + 1; j < branchEndings.length; j += 1) {
          const a = branchEndings[i];
          const b = branchEndings[j];
          const labelA = nonEmptyString(a?.optionLabel);
          const labelB = nonEmptyString(b?.optionLabel);
          if (labelA.length > 0 && labelA === labelB) {
            issues.push({
              severity: "high",
              where: `endings[${endings.indexOf(a)}]`,
              problem: `同一最终分支 ${branchId} 的两条结局「${nonEmptyString(a?.title)}」与「${nonEmptyString(b?.title)}」optionLabel 相同：${labelA}`,
              suggestion: "为两条结局设置不同的 optionLabel（对应不同分支选项）",
            });
            continue;
          }
          const reqA = isObject(a?.requires) ? a.requires : undefined;
          const reqB = isObject(b?.requires) ? b.requires : undefined;
          if (reqA !== undefined && reqB !== undefined && conditionSignature(reqA) === conditionSignature(reqB)) {
            issues.push({
              severity: "high",
              where: `endings[${endings.indexOf(a)}]`,
              problem: `同一最终分支 ${branchId} 的两条结局「${nonEmptyString(a?.title)}」与「${nonEmptyString(b?.title)}」requires 完全一致，互斥失效`,
              suggestion: "给两条结局各自补上互斥条件（keyPointIds / checkpointGroups / not）",
            });
          }
        }
      }
    }
  }

  // R4：排除条件过度限制。not.keyPointIds 只有在“其它结局/其它最终分支的
  // 结局正向引用该关键点”时才是互斥所需；否则可能就是过度排除，会让结局
  // 永远不可达（或依赖一个本路线根本不会揭示的关键点）。
  // - 结局级：同一分支的兄弟结局正向引用该 key（互斥模式）也算正当；
  // - 分支级：其它最终分支的结局正向引用该 key 才算正当。
  const positiveKeysByEnding = new Map();
  endings.forEach((ending, index) => {
    const keys = new Set();
    if (isObject(ending?.requires)) {
      for (const key of asArray(ending.requires.keyPointIds).map((id) => String(id))) keys.add(key);
    }
    positiveKeysByEnding.set(index, keys);
  });
  const allEndingsPositive = new Set();
  for (const keys of positiveKeysByEnding.values()) for (const key of keys) allEndingsPositive.add(key);

  const positiveKeysByFinalBranch = new Map();
  for (const branchId of final.ids) {
    const keys = new Set();
    for (const ending of endings.filter((ending) => String(ending?.branchId ?? "") === branchId)) {
      if (isObject(ending?.requires)) {
        for (const key of asArray(ending.requires.keyPointIds).map((id) => String(id))) keys.add(key);
      }
    }
    positiveKeysByFinalBranch.set(branchId, keys);
  }

  const flagOverRestrictiveEndingNot = (cond, where, endingIndex) => {
    if (!isObject(cond) || !isObject(cond.not)) return;
    const ownPositive = positiveKeysByEnding.get(endingIndex) ?? new Set();
    for (const key of asArray(cond.not.keyPointIds).map((id) => String(id))) {
      const usedByOtherEnding = allEndingsPositive.has(key) && !ownPositive.has(key);
      if (!usedByOtherEnding) {
        issues.push({
          severity: "medium",
          where: `${where}.not.keyPointIds`,
          problem: `排除条件 not.keyPointIds 中的 ${key} 未被其它结局正向引用，可能过度限制，导致本结局不可达`,
          suggestion: `确认 ${key} 在本路线确实会揭示后再保留；否则删去该 not.keyPointIds`,
        });
      }
    }
  };
  const flagOverRestrictiveBranchNot = (cond, where, branchId) => {
    if (!isObject(cond) || !isObject(cond.not)) return;
    const ownPositive = positiveKeysByFinalBranch.get(branchId) ?? new Set();
    for (const key of asArray(cond.not.keyPointIds).map((id) => String(id))) {
      const usedByOtherBranch = [...final.ids].some((otherId) => otherId !== branchId && (positiveKeysByFinalBranch.get(otherId) ?? new Set()).has(key));
      if (!usedByOtherBranch && !ownPositive.has(key)) {
        issues.push({
          severity: "medium",
          where: `${where}.not.keyPointIds`,
          problem: `排除条件 not.keyPointIds 中的 ${key} 未被其它最终分支的结局正向引用，可能过度限制，导致本分支结局不可达`,
          suggestion: `确认 ${key} 在本路线确实会揭示后再保留；否则删去该 not.keyPointIds`,
        });
      }
    }
  };
  for (const branchId of final.ids) {
    const branchEndings = endings.filter((ending) => String(ending?.branchId ?? "") === branchId);
    for (const ending of branchEndings) {
      flagOverRestrictiveEndingNot(ending?.requires, `endings[${endings.indexOf(ending)}].requires`, endings.indexOf(ending));
    }
    const cond = asArray(deepParse?.branchConditions).find((entry) => String(entry?.branchId ?? "") === branchId);
    flagOverRestrictiveBranchNot(cond?.requires, `branchConditions[${branchId}].requires`, branchId);
  }

  // R5：结局 scene 与最终分支 scene 一致性。最终抉择分支在其 scene reached，
  // 入边要求另一个 scene 会导致“分支已出现但结局永远无法确认”。
  for (const branchId of final.ids) {
    const branchScene = nonEmptyString(final.sceneByBranch.get(branchId));
    const branchEndings = endings.filter((ending) => String(ending?.branchId ?? "") === branchId);

    // R5a：分支门控 not.keyPointIds 不得与本分支结局的正向前置冲突，
    // 否则分支 reached 时结局条件必然不满足（本分支结局全部不可达）。
    const cond = asArray(deepParse?.branchConditions).find((entry) => String(entry?.branchId ?? "") === branchId);
    if (isObject(cond?.requires) && isObject(cond.requires.not)) {
      const ownPositive = positiveKeysByFinalBranch.get(branchId) ?? new Set();
      for (const key of asArray(cond.requires.not.keyPointIds).map((id) => String(id))) {
        if (ownPositive.has(key)) {
          issues.push({
            severity: "high",
            where: `branchConditions[${branchId}].requires.not.keyPointIds`,
            problem: `最终分支 ${branchId} 的门控排除了关键点 ${key}，但本分支结局的正向前置又要求 ${key}，本分支结局永远不可达`,
            suggestion: `删去分支门控中的 not.keyPointIds ${key}，或删去本分支结局 requires 中的 ${key}`,
          });
        }
      }
      // R5b：分支门控 not.keyPointIds 也不得与本分支出边 requires 的正向前置
      // 冲突，否则“从该最终分支去往下一阶段/另一最终分支”的边永远无法满足。
      const branchNotKeys = new Set(asArray(cond.requires.not.keyPointIds).map((id) => String(id)));
      for (const edge of plotEdges.filter((candidate) => String(candidate?.from ?? "") === `br:${branchId}`)) {
        for (const edgeCond of asArray(edge?.requires)) {
          if (!isObject(edgeCond)) continue;
          for (const key of asArray(edgeCond.keyPointIds).map((id) => String(id))) {
            if (branchNotKeys.has(key)) {
              issues.push({
                severity: "high",
                where: `plotEdges[${plotEdges.indexOf(edge)}].requires`,
                problem: `最终分支 ${branchId} 的门控 not.keyPointIds 排除了关键点 ${key}，但从该分支出发的边 ${String(edge?.from ?? "")} → ${String(edge?.to ?? "")} 的 requires 又要求 ${key}，该出边永远无法满足`,
                suggestion: `删去分支门控中的 not.keyPointIds ${key}，或删去该出边 requires 中的 ${key}`,
              });
            }
          }
        }
      }
    }

    if (branchScene.length === 0) continue;
    for (const ending of branchEndings) {
      const where = `endings[${endings.indexOf(ending)}].requires`;
      if (!isObject(ending?.requires)) continue;
      const endingScene = nonEmptyString(ending.requires.scene);
      if (endingScene.length > 0 && endingScene !== branchScene) {
        issues.push({
          severity: "high",
          where: `${where}.scene`,
          problem: `结局 scene（${endingScene}）与最终分支 ${branchId} 的 scene（${branchScene}）不一致，结局入边在分支场景无法满足`,
          suggestion: `把结局 requires.scene 改为 ${branchScene}，或删去 scene（与分支一致即可）`,
        });
      }
      if (isObject(ending.requires.not) && nonEmptyString(ending.requires.not.scene) === branchScene) {
        issues.push({
          severity: "high",
          where: `${where}.not.scene`,
          problem: `结局 requires.not.scene 排除了最终分支自身的 scene（${branchScene}），结局在其分支场景永远无法达成`,
          suggestion: "删去该 not.scene",
        });
      }
    }
  }

  // R6：条件 scene 合法性。场景名只能来自场景事实/节点 scene/最终分支标题；
  // 结局 requires.scene 非法直接 high（永远无法匹配），其余为 low（可能只是
  // 未收录的场景别名，先提示不阻塞）。
  walkAllConditions(deepParse, (cond, where, kind) => {
    const scene = nonEmptyString(cond?.scene);
    if (scene.length === 0 || sceneNames.has(scene)) return;
    const isEndingGate = kind === "ending-requires";
    issues.push({
      severity: isEndingGate ? "high" : "low",
      where: `${where}.scene`,
      problem: `条件 scene「${scene}」不在已知场景名清单中（已知：${[...sceneNames].slice(0, 12).join(" / ")}${sceneNames.size > 12 ? "…" : ""}）`,
      suggestion: "改用已知场景名，或删去 scene 依赖运行时补场景门控",
    });
  });

  // R7：结局前置关键点循环依赖。若结局 requires 的关键点只有在“从该最终
  // 分支出发”之后才能到达，则该前置永远无法在抉择前满足。
  const reach = buildReachability(deepParse, flat);
  for (const branchId of final.ids) {
    const reduced = reach.reachableWithout(branchId);
    const branchEndings = endings.filter((ending) => String(ending?.branchId ?? "") === branchId);
    for (const ending of branchEndings) {
      if (!isObject(ending?.requires)) continue;
      for (const key of asArray(ending.requires.keyPointIds).map((id) => String(id))) {
        const nodeId = `kp:${key}`;
        if (reach.reachableFull.has(nodeId) && !reduced.has(nodeId)) {
          issues.push({
            severity: "high",
            where: `endings[${endings.indexOf(ending)}].requires.keyPointIds`,
            problem: `结局前置关键点 ${key} 只能在最终分支 ${branchId} 的选择之后到达，构成循环依赖；结局章节内部节点不能作前置`,
            suggestion: `把 ${key} 从 requires 移入 endingKeywords / blockers，或改为抉择前可达的关键点`,
          });
        }
      }
    }
  }

  // R8：结局直接入边 requires 与结局 requires 一致（去掉分支选择/选项路由字段）。
  for (const ending of endings) {
    const branchId = String(ending?.branchId ?? "");
    const endingId = nonEmptyString(ending?.id);
    if (branchId.length === 0 || endingId.length === 0) continue;
    const edge = plotEdges.find((candidate) => String(candidate?.from ?? "") === `br:${branchId}` && String(candidate?.to ?? "") === `end:${endingId}`);
    if (edge === undefined) continue; // 缺入边由 preflight 报 high
    const expected = [];
    if (isObject(ending?.requires)) {
      const cond = {};
      for (const key of ["scene", "entryEvidence", "checkpointGroups", "sanityEventIds", "keyPointIds", "not"]) {
        if (ending.requires[key] !== undefined && ending.requires[key] !== null) cond[key] = ending.requires[key];
      }
      if (Object.keys(cond).length > 0) expected.push(cond);
    }
    if (signaturesOf(asArray(edge?.requires)).join("\u0000") !== signaturesOf(expected).join("\u0000")) {
      issues.push({
        severity: "high",
        where: `plotEdges[${plotEdges.indexOf(edge)}].requires`,
        problem: `结局 ${endingId} 的直接入边 requires 与结局 requires 不一致，会出现“边可通过但结局条件不满足”`,
        suggestion: "把入边 requires 同步为结局 requires（去掉 branchChoiceIds / optionLabel）",
      });
    }
  }

  // R9：结局关键词缺失（体验项，不阻塞）。
  for (let index = 0; index < endings.length; index += 1) {
    const ending = endings[index];
    if (asArray(ending?.endingKeywords).length === 0) {
      issues.push({
        severity: "low",
        where: `endings[${index}].endingKeywords`,
        problem: `结局「${nonEmptyString(ending?.title)}」没有 endingKeywords，叙述命中只能靠标题匹配`,
        suggestion: "补 1-3 个结局关键词（结局章节里会稳定出现的短语）",
      });
    }
  }

  // R10：结局 requires 的路由字段必须指向自身分支与自身 optionLabel。
  for (let index = 0; index < endings.length; index += 1) {
    const ending = endings[index];
    if (!isObject(ending?.requires)) continue;
    const branchId = String(ending?.branchId ?? "");
    const branchChoiceIds = asArray(ending.requires.branchChoiceIds).map((id) => String(id));
    if (branchChoiceIds.length > 0 && branchId.length > 0 && !branchChoiceIds.includes(branchId)) {
      issues.push({
        severity: "high",
        where: `endings[${index}].requires.branchChoiceIds`,
        problem: `结局 requires.branchChoiceIds 未包含自身最终分支 ${branchId}，路由不一致`,
        suggestion: `把 branchChoiceIds 改为 ["${branchId}"]`,
      });
    }
    const endingLabel = nonEmptyString(ending?.optionLabel);
    const requiredLabels = Array.isArray(ending.requires.optionLabel)
      ? ending.requires.optionLabel.map((item) => String(item))
      : nonEmptyString(ending.requires.optionLabel).length > 0
        ? [nonEmptyString(ending.requires.optionLabel)]
        : [];
    if (endingLabel.length > 0 && requiredLabels.length > 0 && !requiredLabels.includes(endingLabel)) {
      issues.push({
        severity: "high",
        where: `endings[${index}].requires.optionLabel`,
        problem: `结局 optionLabel（${endingLabel}）与 requires.optionLabel（${requiredLabels.join(" / ")}）不一致`,
        suggestion: `把 requires.optionLabel 改为 ${endingLabel}`,
      });
    }
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  const pass = counts.high <= (gate.high ?? 0) && counts.medium <= (gate.medium ?? 0);
  return { issues, ...counts, pass };
}

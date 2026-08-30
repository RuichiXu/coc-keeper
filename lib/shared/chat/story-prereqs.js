/**
 * 结构化剧情前置条件（Story Prerequisites）
 *
 * B-3：把“关键点/分支何时揭示/落地”从《墨渊》硬编码 ID 映射，替换为挂在
 * keyPoints/branches 上的结构化条件，运行时由通用触发器统一判定。
 *
 * 条件对象（挂在 kp.requires / branch.requires）：
 * {
 *   scene: string,                    // 当前场景必须精确等于该场景
 *   entryEvidence: string[],          // 场景命中后，文本还需出现至少一个进门证据（空文本时豁免）
 *   checkpointGroups: string[][],     // 检定点组：组内 OR，组间 AND
 *   sanityEventIds: string[],         // SAN 结算事件：命中任意一个
 *   keyPointIds: string[],            // 这些关键点必须全部已揭示
 *   branchChoiceIds: string[],        // 这些分支必须全部 reached+chosen
 * }
 * kp.requiresAnyOf / branch.requiresAnyOf：数组，其中任意一组条件满足即可。
 * branch.autoChooseLabel：事件落地时优先选择的选项 label 子串。
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */

// ── 通用判定 ──────────────────────────────────────────────

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
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
 * 判断单个条件组是否满足。
 * @param {object|null} requires
 * @param {{ currentScene?: string, playerText?: string, narration?: string,
 *            passedCheckpointIds?: string[], sanitySettled?: object[],
 *            keyPoints?: object[], branches?: object[] }} ctx
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

  return true;
}

/**
 * 判断 requiresAnyOf：任意一组满足即通过（缺省视为通过）。
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
 * 关键点/分支是否已满足全部结构化前置条件。
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

// ── 结构化查找 ──────────────────────────────────────────────

/**
 * 找“十二字咒文”类关键点（标题含咒文/十二字）。
 * @param {object} flat
 * @returns {object|null}
 */
export function findSpellKeyPoint(flat) {
  const keyPoints = asArray(flat?.keyPoints);
  return keyPoints.find((kp) => /(?:咒文|十二字)/.test(String(kp?.title ?? ""))) ?? null;
}

/**
 * 找最终分支：选项指向结局/END 的分支；有多个时优先标题含最终/结局/仪式/抉择者。
 * @param {object} flat
 * @returns {object|null}
 */
export function findFinalBranch(flat) {
  const branches = asArray(flat?.branches);
  const withEnding = branches.filter((branch) =>
    asArray(branch?.options).some((option) => /(?:结局|END|TE|BE|GE|TRUE)/i.test(String(option?.leadsTo ?? "")))
  );
  if (withEnding.length === 0) return null;
  return withEnding.find((branch) => /(?:最终|结局|仪式|抉择)/.test(String(branch?.title ?? ""))) ?? withEnding[0];
}

/**
 * 找结构化前置条件里引用了指定分支的关键点（用于终局补揭示）。
 * @param {object} flat
 * @param {string} branchId
 * @returns {object[]}
 */
export function findKeyPointsRequiringBranch(flat, branchId) {
  const id = String(branchId ?? "");
  return asArray(flat?.keyPoints).filter((kp) => {
    const reqIds = asArray(kp?.requires?.branchChoiceIds).map(String);
    if (reqIds.includes(id)) return true;
    return asArray(kp?.requiresAnyOf).some((group) => asArray(group?.branchChoiceIds).map(String).includes(id));
  });
}

/**
 * 展开关键点结构化前置条件里的全部检定点 ID。
 * @param {object|null} kp
 * @returns {string[]}
 */
export function requiredCheckpointIdsOf(kp) {
  const ids = [];
  const groups = asArray(kp?.requires?.checkpointGroups);
  for (const group of groups) {
    for (const id of asArray(group)) ids.push(String(id));
  }
  return [...new Set(ids)].filter((id) => id.length > 0);
}

// ── 草拟规则（导入/旧档补算） ────────────────────────────────

const SPATIAL_TITLE_RE = /^(进入|来到|抵达|打开)(.+)$/;
const TITLE_ACTION_PREFIX_RE = /^(?:发现|找到|目睹|拼凑|解读|解开|看到|听见|进入|来到|抵达|打开)/;
const TITLE_SPLIT_RE = /与|和|、|及|以及/;
const SAN_SKILL_RE = /^(SAN|理智)$/i;
const INT_SKILL_RE = /^(智力|灵感)$/;

function stripTitlePrefix(title) {
  return String(title ?? "").replace(TITLE_ACTION_PREFIX_RE, "").trim();
}

function titleTerms(title) {
  const base = stripTitlePrefix(title);
  if (base.length === 0) return [];
  return base.split(TITLE_SPLIT_RE).map((term) => term.trim()).filter((term) => term.length >= 2);
}

function difficultyRank(difficulty) {
  if (difficulty === "extreme") return 3;
  if (difficulty === "hard") return 2;
  return 1;
}

function pickHardest(checkpoints) {
  let best = null;
  for (const check of checkpoints) {
    if (best === null || difficultyRank(check?.difficulty) > difficultyRank(best?.difficulty)) {
      best = check;
    }
  }
  return best;
}

function sceneCompatible(kpScene, checkpoint) {
  const scene = String(kpScene ?? "").trim();
  if (scene.length === 0 || scene === "导入") return true;
  const checkScene = String(checkpoint?.scene ?? "").trim();
  const floor = String(checkpoint?.floor ?? "").trim();
  if (checkScene.length === 0 && floor.length === 0) return true;
  if (checkScene.length > 0 && (scene.includes(checkScene) || checkScene.includes(scene))) return true;
  if (floor.length > 0 && scene.includes(floor)) return true;
  return false;
}

function keysContain(checkpoint, term) {
  return asArray(checkpoint?.keys).some((key) => {
    const word = String(key).trim();
    return word.length >= 2 && (word === term || word.includes(term) || term.includes(word));
  });
}

function triggerContains(checkpoint, term) {
  return String(checkpoint?.trigger ?? "").includes(term);
}

/**
 * 进门证据变体：把“进入书房”扩成常见同义短句，避免 KP 换措辞导致证据缺失。
 * 这是一个有界词表启发式（PATCHES 15 的收窄版），后续由场景切入事件替代。
 * @param {string} verb
 * @param {string} noun
 * @returns {string[]}
 */
export function entryEvidenceVariants(verb, noun) {
  const target = String(noun ?? "").trim();
  if (target.length === 0) return [];
  const table = {
    进入: [`进入${target}`, `进到${target}`, `走进${target}`, `踏进${target}`, `迈入${target}`, `来到${target}内`],
    来到: [`来到${target}`, `抵达${target}`, `走进${target}`],
    抵达: [`抵达${target}`, `来到${target}`],
    打开: [`打开${target}`, `推开了${target}`],
  };
  return (table[verb] ?? [`${verb}${target}`]).filter((phrase) => phrase.length >= 4);
}

/**
 * 草拟单个关键点的结构化前置条件。
 * 保守策略：没有足够结构化证据时返回 null（不生成条件，交给叙述兜底），
 * 绝不生成空条件导致“无条件立即揭示”。
 * @param {object} kp
 * @param {object} flat
 * @returns {object|null} 需要写入 kp 的字段（{ requires } 或 { requiresAnyOf }）
 */
export function draftKeyPointPrerequisites(kp, flat) {
  const title = String(kp?.title ?? "").trim();
  const scene = String(kp?.scene ?? "").trim();
  if (title.length === 0) return null;
  // 开场导入关键点由“开场白后揭示”逻辑处理，不生成事件条件。
  if (scene === "导入") return null;

  const checkpoints = asArray(flat?.scenarioCheckpoints);

  // 1) 空间型标题：进入/来到/抵达/打开某地 → 场景精确切入 + 进门证据。
  const spatial = SPATIAL_TITLE_RE.exec(title);
  if (spatial !== null) {
    const verb = spatial[1];
    const noun = spatial[2].trim();
    if (scene.length >= 4 && !scene.includes("/") && noun.length > 0) {
      return { requires: { scene, entryEvidence: entryEvidenceVariants(verb, noun) } };
    }
    return null;
  }

  const terms = titleTerms(title);
  if (terms.length === 0) return null;

  // 2) SAN 目击型：标题词命中 SAN 检定点 keys 时，由对应 SAN 结算事件驱动。
  const sanHits = [];
  for (const term of terms) {
    for (const check of checkpoints) {
      if (!SAN_SKILL_RE.test(String(check?.skill ?? ""))) continue;
      if (!sceneCompatible(scene, check)) continue;
      if (keysContain(check, term)) sanHits.push({ check, term, score: keysContain(check, term) ? 2 : 0 });
    }
  }
  if (sanHits.length > 0) {
    sanHits.sort((a, b) => b.score - a.score);
    return { requires: { sanityEventIds: [String(sanHits[0].check.id)] } };
  }

  // 3) 咒文解读型：标题含“咒”时，找智力/灵感解读检定点，取最高难度。
  if (/咒/.test(title)) {
    const decodeHits = checkpoints.filter((check) => {
      if (!INT_SKILL_RE.test(String(check?.skill ?? ""))) return false;
      return /(?:咒|字)/.test(String(check?.trigger ?? ""));
    });
    if (decodeHits.length > 0) {
      const hardest = pickHardest(decodeHits);
      return { requires: { checkpointGroups: [[String(hardest.id)]] } };
    }
  }

  // 4) 发现型：标题词（“日记与手稿”→“日记”“手稿”）各自命中检定点时，
  //    组内 OR（同一发现的不同技能）、组间 AND（日记与手稿缺一不可）。
  const groups = [];
  for (const term of terms) {
    const hits = checkpoints.filter((check) => {
      if (SAN_SKILL_RE.test(String(check?.skill ?? ""))) return false;
      if (!sceneCompatible(scene, check)) return false;
      return keysContain(check, term) || triggerContains(check, term);
    });
    if (hits.length === 0) return null;
    groups.push([...new Set(hits.map((check) => String(check.id)))]);
  }
  if (groups.length > 0) {
    return { requires: { checkpointGroups: groups } };
  }
  return null;
}

/**
 * 草拟单个分支的结构化前置条件。
 * 当前只支持“事件落地型分支”：选项 leadsTo 指向某个由 SAN 结算驱动的关键点时，
 * 把该关键点的 SAN 条件复制到分支，并记录应自动选择的选项 label。
 * @param {object} branch
 * @param {object} flat
 * @returns {object|null} 需要写入 branch 的字段
 */
export function draftBranchPrerequisites(branch, flat) {
  const options = asArray(branch?.options);
  if (options.length === 0) return null;
  const keyPoints = asArray(flat?.keyPoints);
  for (const option of options) {
    const leadsTo = String(option?.leadsTo ?? "").trim();
    if (leadsTo.length === 0) continue;
    const kp = keyPoints.find((candidate) => {
      const candidateTitle = String(candidate?.title ?? "").trim();
      if (candidateTitle.length === 0) return false;
      const base = stripTitlePrefix(candidateTitle);
      return candidateTitle === leadsTo || base === leadsTo || candidateTitle.includes(leadsTo) || leadsTo.includes(candidateTitle);
    });
    if (kp?.requires?.sanityEventIds?.length > 0) {
      return {
        requires: { sanityEventIds: asArray(kp.requires.sanityEventIds).slice() },
        autoChooseLabel: String(option?.label ?? ""),
      };
    }
  }
  return null;
}

/**
 * 终局关联草拟（临终提示/最终抉择）：
 * - “临终/最后提示”类关键点：咒文关键点已揭示 或 最终分支已选。
 * - “最终抉择”类关键点：最终分支已选 且 咒文关键点已揭示。
 * 需要同时存在咒文关键点与最终分支才生成，避免任意剧本误配。
 * @param {object} kp
 * @param {object} flat
 * @param {object|null} spellKp
 * @param {object|null} finalBranch
 * @returns {object|null}
 */
export function draftEndingKeyPointPrerequisites(kp, flat, spellKp, finalBranch) {
  const title = String(kp?.title ?? "").trim();
  if (title.length === 0) return null;
  if (spellKp === null || finalBranch === null) return null;
  if (/临终|最后|遗言/.test(title)) {
    return {
      requiresAnyOf: [
        { keyPointIds: [String(spellKp.id)] },
        { branchChoiceIds: [String(finalBranch.id)] },
      ],
    };
  }
  if (/最终|抉择/.test(title)) {
    return {
      requires: {
        keyPointIds: [String(spellKp.id)],
        branchChoiceIds: [String(finalBranch.id)],
      },
    };
  }
  return null;
}

/**
 * 为 flat 里缺少结构化前置条件的关键点/分支草拟并写入（原地修改）。
 * 只填充缺失项；已存在（包括 KP 手工配置）的保持不动。
 * @param {object} flat
 * @returns {object} flat（原地修改后返回）
 */
export function enrichStoryPrerequisites(flat) {
  const spellKp = findSpellKeyPoint(flat);
  const finalBranch = findFinalBranch(flat);

  for (const kp of asArray(flat?.keyPoints)) {
    if (kp?.requires !== undefined || kp?.requiresAnyOf !== undefined) continue;
    const draft = draftKeyPointPrerequisites(kp, flat) ??
      draftEndingKeyPointPrerequisites(kp, flat, spellKp, finalBranch);
    if (draft !== null && draft !== undefined) {
      for (const [key, value] of Object.entries(draft)) {
        kp[key] = Array.isArray(value) ? value.slice() : value;
      }
    }
  }

  for (const branch of asArray(flat?.branches)) {
    if (branch?.requires !== undefined || branch?.requiresAnyOf !== undefined) continue;
    const draft = draftBranchPrerequisites(branch, flat);
    if (draft !== null && draft !== undefined) {
      branch.requires = Array.isArray(draft.requires) ? draft.requires.slice() : { ...draft.requires };
      branch.autoChooseLabel = draft.autoChooseLabel ?? "";
    }
  }

  return flat;
}

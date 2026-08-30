/**
 * 结局事件（Ending Resolved）
 *
 * B-4：把聊天桥里的“终局短路/结局门禁冻结”从内联硬编码，收敛为可测试的
 * 结局事件对象。当前仍由聊天桥在最终仪式轮成功后调用；后续 C 阶段由
 * Rule Engine/PlotGraph 发布同一事件，聊天桥只消费、不再决定结局是否发生。
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */
import { findFinalBranch, findKeyPointsRequiringBranch, findSpellKeyPoint } from "./story-prereqs.js";
import { abandonAllGates } from "./gate-lifecycle.js";

const FINAL_RITE_SKILL_RE = /^(意志|POW|理智|SAN)$/i;

/**
 * 从最终分支选项派生结局关键词（去掉“的结局/END”等尾缀）。
 * @param {object|null} finalBranch
 * @returns {string[]}
 */
export function buildEndingKeywords(finalBranch) {
  return (finalBranch?.options ?? [])
    .map((option) => String(option?.leadsTo ?? "").replace(/(?:的)?(?:坏|好|真|假)?结局$|END$/i, "").trim())
    .filter((keyword) => keyword.length >= 2);
}

/**
 * 结局句兜底：优先按已选分支 option.leadsTo 渲染；无法判定正逆序时用通用句。
 * 仍为《墨渊》特化的固定模板（PATCHES 13），后续由 Narrator/ClueGraph 渲染。
 * @param {object} finalBranch
 * @param {string} chosen
 * @returns {string}
 */
export function endingSentenceFor(finalBranch, chosen) {
  const keyword = buildEndingKeywords(finalBranch)[0] ?? "";
  if (chosen.includes("逆序") || chosen.includes("送神")) {
    return keyword.length > 0 ? `${keyword}。夏拉卡拉布被逐回虚空，书房重新归于寂静。` : "墨渊消散。夏拉卡拉布被逐回虚空，书房重新归于寂静。";
  }
  if (chosen.includes("正序") || chosen.includes("请神")) {
    return keyword.length > 0 ? `${keyword}。仪式完成，整座宅邸沉入不可名状的死寂。` : "夏拉卡拉布降临。仪式完成，整座宅邸沉入不可名状的死寂。";
  }
  return keyword.length > 0 ? keyword : "仪式完成，一切归于寂静。";
}

/**
 * 尝试创建结局事件。仅当最终分支已选且本轮是最终仪式技能成功时返回。
 * @param {object} flat
 * @param {string} narration - 当前叙述
 * @param {{ rolledRaSkill?: string, lastRoll?: { passed?: boolean }, now?: string }} opts
 * @returns {{ event: object, finalBranch: object, narration: string } | null}
 */
export function createEndingResolvedEvent(flat, narration, opts = {}) {
  const finalBranch = opts.finalBranch ?? findFinalBranch(flat);
  if (finalBranch?.reached !== true || String(finalBranch?.chosen ?? "").trim().length === 0) return null;
  if (!FINAL_RITE_SKILL_RE.test(String(opts?.rolledRaSkill ?? ""))) return null;
  if (opts?.lastRoll?.passed !== true) return null;

  const chosen = String(finalBranch.chosen);
  const endingKeywords = buildEndingKeywords(finalBranch);
  const mentioned =
    endingKeywords.some((keyword) => String(narration ?? "").includes(keyword)) ||
    /(?:尾声|后日谈|葬礼)/.test(String(narration ?? ""));
  const sentence = mentioned ? "" : endingSentenceFor(finalBranch, chosen);
  const now = opts?.now ?? new Date().toISOString();

  const event = {
    type: "EndingResolved",
    kind: "ending-resolved",
    branchId: finalBranch.id,
    chosen,
    endingKeywords,
    appendedSentence: sentence,
    at: now,
  };

  return {
    event,
    finalBranch,
    narration: mentioned ? String(narration ?? "") : `${String(narration ?? "").trim()}\n\n${sentence}`,
  };
}

/**
 * 应用结局事件到 flat：提交 endingReached/endedAt/当前场景/当前分支，
 * 补揭示咒文关键点与引用最终分支的关键点，废弃全部门禁。
 * @param {object} flat
 * @param {object} event
 * @param {object} finalBranch
 * @returns {number} 补揭示的关键点数量
 */
export function applyEndingResolvedEvent(flat, event, finalBranch) {
  if (event?.appendedSentence !== undefined && event.appendedSentence.length > 0) {
    // 叙述已在 createEndingResolvedEvent 中拼接完成；这里不重复处理。
  }
  flat.endingReached = true;
  flat.endedAt = event?.at ?? new Date().toISOString();
  if ((flat.currentScene ?? "") !== "三层书房·仪式终结") {
    flat.currentScene = "三层书房·仪式终结";
  }
  if (flat.currentBranchId === undefined || flat.currentBranchId === null || flat.currentBranchId.length === 0) {
    flat.currentBranchId = finalBranch.id;
  }
  const spellKp = findSpellKeyPoint(flat);
  const endingKeyPoints = new Set([
    ...(spellKp !== null ? [spellKp] : []),
    ...findKeyPointsRequiringBranch(flat, finalBranch.id),
  ]);
  let revealed = 0;
  for (const kp of flat.keyPoints ?? []) {
    if (kp?.revealed === true) continue;
    if (endingKeyPoints.has(kp)) {
      kp.revealed = true;
      revealed += 1;
    }
  }
  abandonAllGates(flat, "ending-resolved", event?.at);
  flat.pendingChoice = null;
  return revealed;
}

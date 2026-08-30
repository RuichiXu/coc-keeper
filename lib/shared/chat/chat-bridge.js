/**
 * 面板聊天桥（KP 迷你循环：LLM + coc 新工具调用）
 *
 * Step 4：从 legacy-index.js 迁移而来，内部使用 adapter 新工具（Core → Event → State）。
 * 状态读写统一通过 deps.persistence；每轮工具执行后同步 GameSession 并保存 core。
 */
import {
  buildKpSystemPrompt,
  buildLoopMessages,
  computeStoryFrontier,
  evaluatePrerequisites,
  evaluateRequiresAnyOf,
  extractCheckpoints,
  extractSceneFacts,
  findRoomFloorConflict,
  inferSceneTransition,
  selectSceneFacts,
  parseAssistantBlocks,
  decideNext,
  buildAssistantContent,
  buildToolResultMessages,
  parseToolArguments,
  formatNarration,
  isBusyStale,
  storyFrontierText,
  summarizeReachability,
  ensureScenarioContract,
} from "../../core/index.js";
import { callLlmApi } from "../llm.js";
export { callLlmApi };
import {
  branchLandedEvent,
  checkpointPassedEvent,
  commitSession,
  endingResolvedEvent,
  gateCreatedEvent,
  gateFailedEvent,
  gateResolvedEvent,
  keyPointRevealedEvent,
  nextId,
  nightEventFiredEvent,
  nowIso,
  projectToFlat,
  rollEvent,
  spellShownEvent,
} from "../tools/helpers.js";
import { PANEL_TOOLS } from "../tools/index.js";
import {
  containsResultPhrase,
  formatCheckLine,
  formatRaResultLine,
  parseCheckRequests,
  parseRaCommand,
  performRaRoll,
  resolveRaTarget,
  stripCheckRequests,
  stripResultPhrases,
} from "./check-command.js";
import {
  checkKey,
  gateTargetKey,
  matchActionToGates,
  mergeCheckGates,
  resolvePendingChoice,
  resolveRaCandidateChoice,
  sanitizeGateAction,
} from "./check-gates.js";
import { validateNarrationCandidate } from "./narration-guard.js";
import { evaluateNightEvents, validateCandidateNarration } from "./scenario-contract-validator.js";
import {
  enrichStoryPrerequisites,
  findFinalBranch,
  findSpellKeyPoint,
  requiredCheckpointIdsOf,
} from "./story-prereqs.js";
import { findCheckpointMatch, findCheckpointReveal } from "./checkpoint-match.js";
import { abandonAllGates, expireSceneGates } from "./gate-lifecycle.js";
import { applyEndingResolvedEvent, buildEndingKeywords, createEndingResolvedEvent } from "./ending.js";

// 兼容旧导入路径：这些函数已下沉到共享模块，保持从 chat-bridge 可引用。
export { findCheckpointMatch, findCheckpointReveal } from "./checkpoint-match.js";
export { abandonAllGates, expireSceneGates } from "./gate-lifecycle.js";

// ── 状态摘要 ──────────────────────────────────────────────

export function stateDigest(state) {
  return {
    id: state.id,
    title: state.title,
    kpMode: state.kpMode,
    currentScene: state.currentScene,
    currentBranchId: state.currentBranchId,
    endingReached: state.endingReached === true,
    time: state.time,
    synopsis: state.synopsis,
    rules: state.rules === null ? null : { name: state.rules.name, chars: state.rules.chars },
    scenario: state.scenario === null ? null : { name: state.scenario.name, chars: state.scenario.chars },
    characters: state.characters,
    keyPoints: state.keyPoints,
    branches: state.branches,
    tasks: state.tasks,
    entities: state.entities,
    reminders: state.reminders,
    recentRolls: state.rollHistory.slice(-12).reverse(),
    toolTrace: state.toolTrace.slice(-10).reverse(),
    logLength: state.log.length,
    // KP 调试快照：面板专用只读字段，玩家端不使用。
    debug: {
      busy: state.busy === true,
      pendingChecks: Array.isArray(state.pendingChecks) ? state.pendingChecks : [],
      pendingChoice: state.pendingChoice ?? null,
      resolvedChecks: Array.isArray(state.resolvedChecks) ? state.resolvedChecks : [],
      passedCheckpointIds: Array.isArray(state.passedCheckpointIds) ? state.passedCheckpointIds : [],
      sanitySettled: Array.isArray(state.sanitySettled) ? state.sanitySettled : [],
      skippedChecks: Array.isArray(state.skippedChecks) ? state.skippedChecks : [],
      firedNightEventIds: Array.isArray(state.firedNightEventIds) ? state.firedNightEventIds : [],
      endingReached: state.endingReached === true,
      endedAt: state.endedAt ?? null,
      frontier: storyFrontierText(computeStoryFrontier(state)),
      facts: {
        flags: state.core?.world?.flags ?? state.flags ?? {},
        discoveredClues: state.core?.world?.discoveredClues ?? state.discoveredClues ?? [],
        entityStates: (state.entities ?? []).filter((entity) => String(entity?.state ?? "").length > 0).map((entity) => `${entity.name}:${entity.state}`),
        time: state.time ?? "",
      },
      events: (state.core?.trace ?? []).slice(-40).reverse(),
    },
  };
}

// ── 确定性状态落地（关键点/物品）：不依赖 LLM 自觉调用工具 ──

const KEYPOINT_ACTION_PREFIXES = [
  "发现", "获得", "得到", "进入", "找到", "目睹", "拼凑", "调查",
  "看到", "听见", "触发", "完成", "解读", "解开", "打开", "来到", "抵达",
];
const KEYPOINT_TITLE_SUFFIXES = ["到来", "完成", "结束", "开始", "揭示", "触发", "显现"];
const FULL_FORWARD_SPELL_RE = /启墨渊[、，,\s]*引魂夜[、，,\s]*临神名[、，,\s]*归字主/;
const FULL_INVERSE_SPELL_RE = /归字主[、，,\s]*临神名[、，,\s]*引魂夜[、，,\s]*启墨渊/;

/**
 * 关键点标题变体：去掉常见动作前缀（“发现墨渊”→“墨渊”）与事件后缀
 * （“委托到来”→“委托”），让自动揭示更宽容。
 * @param {string} title
 * @returns {string[]}
 */
export function keypointTitleVariants(title) {
  const source = String(title ?? "").trim();
  const variants = new Set([source]);
  for (const prefix of KEYPOINT_ACTION_PREFIXES) {
    if (source.startsWith(prefix)) {
      const stripped = source.slice(prefix.length).trim();
      // 过短的剥离词（“书房/墨渊/委托”）会命中 NPC 台词导致提前揭示，
      // 至少保留 4 字（“一层墨渍/十二字咒文/日记与手稿”）。
      if (stripped.length >= 4) variants.add(stripped);
    }
  }
  for (const suffix of KEYPOINT_TITLE_SUFFIXES) {
    if (source.endsWith(suffix)) {
      const stripped = source.slice(0, -suffix.length).trim();
      if (stripped.length >= 4) variants.add(stripped);
    }
  }
  return [...variants];
}

/**
 * 判断 phrase 是否在 text 中“肯定地”出现。
 * 前缀 4 字内出现否定词（没/未/不/无/非/别/莫）视为否定语境，不算命中。
 * 例如“并没能进入书房”不应揭示“进入书房”。
 */
export function phraseMatched(text, phrase) {
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

/**
 * 判断叙述是否命中关键点标题（含动作前缀剥离 + “A与B”拆分后全部肯定出现）。
 * 不做 CJK 双字组兜底：太宽泛（“克罗斯”就能命中“克罗斯临终提示”）。
 * @param {string} title
 * @param {string} text
 * @returns {boolean}
 */
export function keypointTitleMatched(title, text) {
  const source = String(text ?? "");
  for (const variant of keypointTitleVariants(title)) {
    if (variant.length >= 2 && phraseMatched(source, variant)) return true;
    const terms = variant
      .split(/与|和|、|及|以及/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length > 1 && terms.every((term) => phraseMatched(source, term))) return true;
  }
  return false;
}

/**
 * 日记核心句提前泄露检测（《墨渊》特化）：日记内容受三层书房检定点保护，
 * 在“发现日记与手稿”关键点揭示前，叙述不得直接写出日记核心句。
 * @param {string} narration
 * @param {object} flat
 * @returns {string[]}
 */
export function findEarlyDiaryLeak(narration, flat) {
  const kp4 = (flat?.keyPoints ?? []).find(
    (kp) => kp?.id === "ai-kp-4" || String(kp?.title ?? "").includes("日记与手稿")
  );
  if (kp4?.revealed === true) return [];
  const text = String(narration ?? "");
  const protectedLines = ["它在梦里给我讲故事", "我必须把它们写下来", "正着念是邀请", "倒着念是告别"];
  return protectedLines
    .filter((line) => text.includes(line))
    .map((line) => `叙述提前泄露日记核心句「${line}」；该线索受三层书房检定点保护，请先给团检，不要直接写出日记内容。`);
}

/**
 * 把 coc_sanity_check 的结算行清洗为玩家可见版本：只保留损失结果，
 * 不展示出目/成功档次（SAN 暗骰隔离）。
 * @param {string} text
 * @returns {string}
 */
export function sanitizeSanityLine(text) {
  const s = String(text ?? "");
  if (!s.includes("【理智检定】")) return s;
  if (/已结算，未重复扣减/.test(s)) return "【理智检定】（已结算，未重复扣减）";
  const loss = s.match(/损失\s*(\d+)\s*SAN/);
  const range = s.match(/（(\d+)\s*→\s*(\d+)）/);
  if (loss !== null && range !== null) {
    return `【理智检定】损失 ${loss[1]} SAN（${range[1]} → ${range[2]}）`;
  }
  return "【理智检定】SAN 损失已结算";
}

/**
 * 已通过门禁的稳定键：同一技能+同一动作文本视为同一门禁。
 * @param {string} skill
 * @param {string} action
 * @returns {string}
 */
export function resolvedCheckKey(skill, action) {
  return `${String(skill ?? "").trim()}::${gateTargetKey(action ?? "")}`;
}

/**
 * 记录一个已通过门禁键（成功 .ra 后调用，供后续去重短路）。
 * @param {object} flat
 * @param {string} skill
 * @param {string} action
 */
export function recordResolvedCheck(flat, skill, action) {
  const key = resolvedCheckKey(skill, action);
  if (key.length === 0) return;
  const resolved = Array.isArray(flat.resolvedChecks) ? flat.resolvedChecks : (flat.resolvedChecks = []);
  if (!resolved.includes(key)) resolved.push(key);
  if (resolved.length > 120) flat.resolvedChecks = resolved.slice(-120);
}

/**
 * 记录一次已通过的剧本检定点 ID（事件驱动落地用）。
 * @param {object} flat
 * @param {string} checkpointId
 */
export function recordPassedCheckpoint(flat, checkpointId) {
  const id = String(checkpointId ?? "").trim();
  if (id.length === 0) return;
  const passed = Array.isArray(flat.passedCheckpointIds) ? flat.passedCheckpointIds : (flat.passedCheckpointIds = []);
  if (!passed.includes(id)) passed.push(id);
}

/**
 * 关键点自动揭示：叙述正文里明确出现未揭示关键点标题（或其去动作前缀变体）时，
 * 视为该剧情点已被玩家知晓，直接揭示。
 * @param {Array<object>} keyPoints
 * @param {string} narration
 * @returns {number} 新揭示数量
 */
export function revealKeyPointsFromNarration(keyPoints, narration) {
  const text = String(narration ?? "");
  let changed = 0;
  for (const kp of keyPoints ?? []) {
    if (kp?.revealed === true) continue;
    const title = String(kp?.title ?? "").trim();
    // 空间/动作型标题（“进入书房”“打开暗门”）交给事件驱动（场景切入/检定点通过），
    // 不靠叙述词面命中，避免 NPC 一句“三楼书房反锁”就提前揭示。
    if (/^(进入|来到|抵达|打开)/.test(title)) continue;
    if (title.length >= 2 && keypointTitleMatched(title, text)) {
      kp.revealed = true;
      changed += 1;
    }
  }
  return changed;
}

/**
 * 分支自动落地：玩家输入或 KP 叙述中出现分支选项原文时，确定性标记
 * reached + chosen。避免 LLM 不调用 coc_branch 导致官方分支 0 落地。
 * 玩家输入优先于叙述：玩家明确说“撞门，不撬锁”时，叙述末尾的
 * “撬锁工具”菜单项不能覆盖玩家选择。
 * @param {object} flat
 * @param {string} playerText - 玩家输入
 * @param {string} [narration] - KP 叙述；缺省时 playerText 视为合并文本（兼容旧调用）
 * @returns {number} 新落地分支数
 */
export function autoLandBranches(flat, playerText, narration = null) {
  const sources =
    narration === null
      ? [String(playerText ?? "")]
      : [String(playerText ?? ""), String(narration ?? "")];
  let changed = 0;
  for (const branch of flat.branches ?? []) {
    if (branch?.reached === true) continue;
    const options = Array.isArray(branch?.options) ? branch.options : [];

    const findBestInSource = (source) => {
      let bestMatch = null;
      let bestPosition = -1;
      let bestLength = -1;
      for (const option of options) {
        const label = String(option?.label ?? "");
        const core = label.replace(/[（(][^）)]*[）)]/g, "").trim();
        const shortCore = core.replace(/(?:查看|调查|进入|尝试)$/u, "").trim();
        const candidates = [...new Set([core, label, shortCore].filter((entry) => entry.length >= 2))];
        for (const candidate of candidates) {
          if (candidate.length < 2) continue;
          let index = source.indexOf(candidate);
          while (index !== -1) {
            const before = source.slice(Math.max(0, index - 4), index);
            const negated = /(?:放弃|没有|不是|不要|别|没|未|不|拒绝|否决)/.test(before);
            if (!negated && (index > bestPosition || (index === bestPosition && candidate.length > bestLength))) {
              bestPosition = index;
              bestLength = candidate.length;
              bestMatch = option;
            }
            index = source.indexOf(candidate, index + 1);
          }
        }
      }
      return bestMatch;
    };

    let bestMatch = null;
    for (const source of sources) {
      bestMatch = findBestInSource(source);
      if (bestMatch !== null) break;
    }
    if (bestMatch === null) continue;
    branch.reached = true;
    branch.chosen = String(bestMatch.label);
    if (flat.currentBranchId === undefined || flat.currentBranchId === null || flat.currentBranchId.length === 0) {
      flat.currentBranchId = branch.id;
    }
    changed += 1;
  }
  return changed;
}

/**
 * 分支选择后揭示同场景/同结局的关键点（如选择最终分支 → 揭示“最终抉择”）。
 * @param {object} flat
 * @returns {number} 新揭示数量
 */
export function revealKeyPointsForBranchChoices(flat) {
  const chosenBranches = (flat.branches ?? []).filter((branch) => branch?.reached === true && String(branch?.chosen ?? "").length > 0);
  if (chosenBranches.length === 0) return 0;
  let changed = 0;
  for (const kp of flat.keyPoints ?? []) {
    if (kp?.revealed === true) continue;
    const scene = String(kp?.scene ?? "");
    const title = String(kp?.title ?? "");
    // 带结构化前置条件的关键点由 applyEventDrivenLanding 统一判定，这里不按
    // branch.leadsTo 提前揭示，避免“最终抉择”先于“十二字咒文”落地。
    if (kp?.requires !== undefined || kp?.requiresAnyOf !== undefined) continue;
    // 旧数据兜底：任何选项指向结局的分支已选时，“最终/抉择”类关键点不再由
    // leadsTo 宽匹配提前揭示（与旧 ai-kp-8 硬编码等效的语义保护）。
    const hasEndingBranchChosen = chosenBranches.some((branch) =>
      (branch?.options ?? []).some((option) => /(?:结局|END|TE|BE|GE|TRUE)/i.test(String(option?.leadsTo ?? "")))
    );
    if (hasEndingBranchChosen && /(?:最终|抉择)/.test(title)) continue;
    for (const branch of chosenBranches) {
      const chosenLabel = String(branch?.chosen ?? "");
      const option = (branch?.options ?? []).find((entry) => String(entry?.label ?? "") === chosenLabel);
      const leadsTo = String(option?.leadsTo ?? "");
      if (leadsTo.length === 0) continue;
      // 只用选项 leadsTo 与关键点标题/场景精确匹配，不用 branch.scene 宽匹配。
      // 否则“掀开地毯”（scene=书房）会把书房内所有后续关键点全部提前揭示。
      const currentScene = String(flat.currentScene ?? "");
      const titleHit =
        title === leadsTo ||
        keypointTitleVariants(title).includes(leadsTo) ||
        title.includes(leadsTo);
      // 场景型 leadsTo（如“三层书房”）必须在 currentScene 真正切入该场景后才揭示，
      // 防止玩家还在门外时就把“进入书房”提前落地。
      const sceneHit = scene === leadsTo && scene === currentScene;
      const endingHit = leadsTo.includes("结局") && scene.includes("结局");
      if (titleHit || sceneHit || endingHit) {
        kp.revealed = true;
        changed += 1;
        break;
      }
    }
  }
  return changed;
}

/**
 * 事件驱动落地：依据已发生的结构化事件（场景切入、检定通过、SAN 结算、分支选择）
 * 确定性揭示关键点与落地分支，替代“叙述里出现某个词”的启发式。
 * @param {object} flat
 * @param {string} [playerText] - 玩家输入（用于“进入书房”需有实际进门证据）
 * @param {string} [narration] - KP 叙述
 * @returns {{ revealed: number, branches: number }}
 */
export function applyEventDrivenLanding(flat, playerText = "", narration = "") {
  const ctx = {
    currentScene: String(flat.currentScene ?? ""),
    playerText: String(playerText ?? ""),
    narration: String(narration ?? ""),
    passedCheckpointIds: Array.isArray(flat.passedCheckpointIds) ? flat.passedCheckpointIds : [],
    sanitySettled: Array.isArray(flat.sanitySettled) ? flat.sanitySettled : [],
    keyPoints: Array.isArray(flat.keyPoints) ? flat.keyPoints : [],
    branches: Array.isArray(flat.branches) ? flat.branches : [],
  };
  let revealed = 0;
  let branches = 0;

  for (const kp of flat.keyPoints ?? []) {
    if (kp?.revealed === true) continue;
    if (kp?.requires === undefined && kp?.requiresAnyOf === undefined) continue;
    const baseHit = kp?.requires === undefined ? true : evaluatePrerequisites(kp.requires, ctx);
    const anyHit = kp?.requiresAnyOf === undefined ? true : evaluateRequiresAnyOf(kp.requiresAnyOf, ctx);
    if (baseHit && anyHit) {
      kp.revealed = true;
      revealed += 1;
    }
  }

  // 分支事件落地：满足结构化前置条件的分支标记 reached+chosen。
  // autoChooseLabel 指定事件落地时优先选择的选项；缺省取第一个选项。
  for (const branch of flat.branches ?? []) {
    if (branch?.reached === true) continue;
    if (branch?.requires === undefined && branch?.requiresAnyOf === undefined) continue;
    const baseHit = branch?.requires === undefined ? true : evaluatePrerequisites(branch.requires, ctx);
    const anyHit = branch?.requiresAnyOf === undefined ? true : evaluateRequiresAnyOf(branch.requiresAnyOf, ctx);
    if (!baseHit || !anyHit) continue;
    const label = String(branch?.autoChooseLabel ?? "").trim();
    const option =
      (label.length > 0 ? (branch.options ?? []).find((entry) => String(entry.label ?? "").includes(label)) : undefined) ??
      (branch.options ?? [])[0];
    branch.reached = true;
    branch.chosen = String(option?.label ?? "");
    if (flat.currentBranchId === undefined || flat.currentBranchId === null || flat.currentBranchId.length === 0) {
      flat.currentBranchId = branch.id;
    }
    branches += 1;
  }

  return { revealed, branches };
}

const ITEM_QUANTIFIER_RE =
  /[一二三四五六七八九十两数几]+[张页份本个叠串枚部台柄根盏支把件]+/g;
const ITEM_QUANTIFIER_TEST_RE =
  /[一二三四五六七八九十两数几]+[张页份本个叠串枚部台柄根盏支把件]+/;
const ITEM_ACQUIRE_RE =
  /(?:拿起|带上|取得|拿到|获得|得到|取出|掏出|拾起|捡起|带走|收起|揣进|装进|装入|收进|放进|放入|收好|携带|随身携带|挎上|提上|拿上|握上|抱上|系上|挂上|别上|放进背包|放入包内|塞进|接过|借到)了?(?:那|这)?(?:[一二三四五六七八九十两数几]+[张份本个叠串枚部台柄根盏支把件])?([^，。；、！？\n]{1,16})/g;
const ITEM_BA_RE =
  /(?:把|将)([^，。；、！？\n]{1,16}?)(?:随身携带|携带|挎在|挎上|挂在|挂上|系在|系上|提在|提上|拿在|握在|抱在|别在|背在|收入|收进|收好|装入|装进|放进|放入|带上|带走|拿起|取出|塞进|塞入|揣进)/g;
// 状态式持有：“结实麻绳盘好斜挎过肩”→ 物品在状态动词之前。
const ITEM_STATE_CARRY_RE =
  /([^，。；、！？\n]{1,12}?)(?:斜挎过肩|斜挎在肩|挎过肩|缠在腰间|盘在腰间|系在腰间|别在腰间|斜挎)/g;
// 容器内容：“装有四张原稿的文件夹”→ 物品是容器里装的东西。
const ITEM_CONTAINED_RE =
  /(?:装有|装着|放着|塞着)([^，。；、！？\n的]{1,12})的(?:文件夹|袋子|背包|箱子|盒子|匣子|信封|皮包|挎包)/g;
const ITEM_ABSTRACT_DENY = /信任|线索|消息|结论|进展|真相|机会|灵感|情报|优势|先机|头绪|眉目|主动权|把握|风声|口风|情况|状况|动静|味道|气味|蛮力/;
const ITEM_CONTAINER_DENY = /文件夹|文件袋|证物袋|纸袋|背包|包内|口袋|衣袋|裤袋|箱子|盒子|抽屉|柜子|书柜|壁橱|行囊|挎包|皮包|提包|匣子/;
const ITEM_PARTICLE_DENY = /从|往|在|被|将|把|它|熟悉|位置/;
const ITEM_STRICT_DENY = /的|那|这|其|些|隔着|传来|凉|冰|并排|摊开|贴身|齐整|收好|纸页|与|及|和|或|以及|放下|叠|空白|仔细|翻看|又|再|仍|继续|了|着|过|手套|抄录纸|皮面册子|之后|隔层|两样|一并|东西/;
const ITEM_JUNK_EXTRA = /隔层|两样|一并|手套|抄录纸|皮面册子|之后/;
const ITEM_ALIASES = { 原稿: "手稿", 稿纸: "手稿", 稿件: "手稿", 纸页: "手稿" };

/**
 * 判断物品栏里是否是从前错误提取器写入的垃圾条目。
 * @param {string} item
 * @returns {boolean}
 */
export function isJunkAutoItem(item) {
  const value = String(item ?? "").trim();
  if (value.length === 0) return true;
  if (ITEM_QUANTIFIER_TEST_RE.test(value)) return true;
  if (ITEM_ABSTRACT_DENY.test(value)) return true;
  if (ITEM_CONTAINER_DENY.test(value)) return true;
  if (ITEM_PARTICLE_DENY.test(value)) return true;
  if (ITEM_JUNK_EXTRA.test(value)) return true;
  return false;
}

/**
 * 把提取出的原始物品名规范化：去数量词、去尾部动词、拒绝抽象/容器/介词短语、套别名。
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeAcquiredItem(raw) {
  let item = String(raw ?? "").trim();
  // 去除所有数量词组（四张/一张张/一叠…），而不是只去前缀。
  item = item.replace(ITEM_QUANTIFIER_RE, "");
  item = item.replace(/^(?:那|这|的)+/, "");
  // “本笔记本/本硬皮笔记本”→ 去掉量词性质的前导“本”。
  item = item.replace(/^本(?=[\u4e00-\u9fa5]{2,})/u, "");
  item = item.replace(/(?:递给|交给|放到|放在|塞到|塞进|递了|给了|拿给)[^，。；、！？]{0,8}$/, "");
  item = item.replace(/(?:按顺序|依次|小心地|轻轻地|慢慢|全部|一起|统统|都|整齐地|盘好|盘着|卷好|卷着|折好|折着|斜挎|过肩|沉甸甸地|沉甸甸|分别)$/, "");
  item = item.replace(/[，。；、！？\s]+$/g, "");
  if (item.length < 2 || item.length > 12) return null;
  if (ITEM_ABSTRACT_DENY.test(item)) return null;
  if (ITEM_CONTAINER_DENY.test(item)) return null;
  if (ITEM_PARTICLE_DENY.test(item)) return null;
  return ITEM_ALIASES[item] ?? item;
}

/**
 * 把候选物品归一到剧本实体物品名：叙述说“纸页/原稿/日记和手稿”时，
 * 若剧本实体里有对应物品，则返回实体名数组。
 * @param {string} item
 * @param {Array<object>} entities
 * @returns {string[]} 命中的实体名（去重）
 */
export function canonicalItemsFromEntities(item, entities) {
  const raw = String(item ?? "").trim();
  if (raw.length === 0) return [];
  const found = [];
  for (const entity of entities ?? []) {
    if (entity?.type !== "item") continue;
    const name = String(entity.name ?? "").trim();
    if (name.length === 0) continue;
    const core = name
      .replace(ITEM_QUANTIFIER_RE, "")
      .replace(/^(?:那|这|的)+/, "");
    const haystacks = [name, core];
    if (core === "手稿") haystacks.push("原稿", "稿纸", "稿件", "纸页");
    if (core === "日记") haystacks.push("日记");
    if (haystacks.some((h) => h.length >= 2 && (raw.includes(h) || h.includes(raw)))) {
      if (!found.includes(name)) found.push(name);
    }
  }
  return found;
}

/**
 * 单实体版便捷函数：有匹配时返回第一个实体名，否则 null。
 * @param {string} item
 * @param {Array<object>} entities
 * @returns {string|null}
 */
export function canonicalItemFromEntities(item, entities) {
  const found = canonicalItemsFromEntities(item, entities);
  return found.length > 0 ? found[0] : null;
}

/**
 * 清理所有角色物品栏中由旧版错误提取器写入的垃圾条目。
 * @param {object} flat
 * @returns {number} 清除的条目数
 */
export function cleanupJunkInventory(flat) {
  let removed = 0;
  for (const character of flat.characters ?? []) {
    const inventory = Array.isArray(character.inventory) ? character.inventory : [];
    const cleaned = [];
    for (const item of inventory) {
      // 先做实体名归一：剧本实体名里合法的数量词（“四张手稿”）不能被
      // 旧版垃圾规则（含数量词即垃圾）误删；“原稿一张张”归一到“四张手稿”。
      const canonical = canonicalItemsFromEntities(item, flat.entities ?? []);
      if (canonical.length > 0) {
        for (const name of canonical) {
          if (!cleaned.includes(name)) cleaned.push(name);
        }
        continue;
      }
      if (!isJunkAutoItem(item)) cleaned.push(item);
    }
    if (cleaned.length !== inventory.length || cleaned.some((entry, index) => inventory[index] !== entry)) {
      character.inventory = cleaned;
      removed += inventory.length - cleaned.length;
    }
  }
  return removed;
}

/**
 * 物品获取自动入栏：从验证后的叙述中保守提取“获得/拿起/装入”物品，
 * 写入第一个非 AI 调查员的物品栏（已存在则跳过）。支持把字句与物品别名。
 * @param {object} flat
 * @param {string} narration
 * @returns {string[]} 新入栏物品
 */
export function autoTrackInventory(flat, narration) {
  const text = String(narration ?? "");
  cleanupJunkInventory(flat);
  const pc =
    (flat.characters ?? []).find((c) => c.aiControlled !== true) ??
    (flat.characters ?? [])[0] ??
    null;
  if (pc === null) return [];
  let inventory = Array.isArray(pc.inventory) ? pc.inventory : (pc.inventory = []);

  const candidates = [];
  let match;

  ITEM_ACQUIRE_RE.lastIndex = 0;
  while ((match = ITEM_ACQUIRE_RE.exec(text)) !== null) {
    const item = normalizeAcquiredItem(match[1]);
    if (item !== null) candidates.push(item);
  }

  // 把字句：“把四张原稿按顺序装入随身文件夹”→ 物品是“四张原稿”，在动词之前。
  ITEM_BA_RE.lastIndex = 0;
  while ((match = ITEM_BA_RE.exec(text)) !== null) {
    const item = normalizeAcquiredItem(match[1]);
    if (item !== null) candidates.push(item);
  }

  // 状态式持有：“结实麻绳盘好斜挎过肩”→ 物品在状态动词之前。
  ITEM_STATE_CARRY_RE.lastIndex = 0;
  while ((match = ITEM_STATE_CARRY_RE.exec(text)) !== null) {
    const item = normalizeAcquiredItem(match[1]);
    if (item !== null) candidates.push(item);
  }

  // 容器内容：“装有四张原稿的文件夹”→ 物品是容器里的东西。
  ITEM_CONTAINED_RE.lastIndex = 0;
  while ((match = ITEM_CONTAINED_RE.exec(text)) !== null) {
    const item = normalizeAcquiredItem(match[1]);
    if (item !== null) candidates.push(item);
  }

  // 别名兜底：叙述出现“四张原稿/稿纸…”且同时存在持有/容器语境时，
  // 即使上面的句式都没命中，也把别名规范物品加入（避免“装有四张原稿的文件夹”漏收）。
  if (/(?:装有|装着|贴着身侧|随身携带|斜挎|挎在|提在|拿在|握在|收入|装入|放进|放入)/.test(text)) {
    for (const raw of text.matchAll(/(?:[一二三四五六七八九十两数几]+[张页])?(原稿|稿纸|稿件)/g)) {
      const item = normalizeAcquiredItem(raw[0]);
      if (item !== null) candidates.push(item);
    }
  }

  const added = [];
  for (const rawItem of candidates) {
    // “克罗斯的日记和四张手稿分别装进…”这类多物品句，先按并列连词拆开，
    // 再逐个归一，避免两个实体名粘在一起导致日记漏收。
    const parts = String(rawItem ?? "")
      .split(/[和与及]/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2);
    const processItems = parts.length > 1 ? parts : [rawItem];
    for (const part of processItems) {
      const canonicalNames = canonicalItemsFromEntities(part, flat.entities ?? []);
      if (canonicalNames.length > 0) {
        // 命中剧本实体名：入栏名一律用实体名（如“四张手稿”“克罗斯的日记”）。
        for (const item of canonicalNames) {
          const alreadyHas = inventory.some(
            (entry) => entry === item || entry.includes(item) || item.includes(entry)
          );
          if (alreadyHas) continue;
          inventory.push(item);
          added.push(item);
        }
        continue;
      }
      const item = part;
      // 未命中剧本实体名的候选必须通过更严格校验，过滤“的那齐整纸页/又放下”等句子残片。
      if (ITEM_STRICT_DENY.test(item)) continue;
      if (item.length < 2 || item.length > 12) continue;
      // 已存在同物时跳过；长名条目（“结实麻绳（船用缆绳，盘好斜挎）”）包含短名也算已存在。
      const alreadyHas = inventory.some(
        (entry) => entry === item || entry.includes(item) || item.includes(entry)
      );
      if (alreadyHas) continue;
      inventory.push(item);
      added.push(item);
    }
  }
  return added;
}

// ── 副作用快照/回滚：SAN/HP/物品等不可逆工具调用，必须在叙事校验与门禁确认后才允许提交 ──

const SIDE_EFFECT_FIELDS = ["characters", "rollHistory", "sanitySettled"];

/**
 * 深拷贝副作用相关字段（characters/rollHistory/sanitySettled）。
 * @param {object} flat
 * @returns {object}
 */
export function snapshotSideEffects(flat) {
  const snapshot = {};
  for (const field of SIDE_EFFECT_FIELDS) {
    snapshot[field] = JSON.parse(JSON.stringify(flat[field] ?? []));
  }
  return snapshot;
}

/**
 * 把副作用相关字段回滚到快照值（保留门禁/场景/剧情结构等本轮推进）。
 * @param {object} flat
 * @param {object} snapshot
 * @returns {boolean} 是否有任何字段被回滚
 */
export function restoreSideEffects(flat, snapshot) {
  let changed = false;
  for (const field of SIDE_EFFECT_FIELDS) {
    const before = JSON.stringify(flat[field] ?? null);
    const after = JSON.stringify(snapshot[field] ?? null);
    if (before !== after) {
      flat[field] = JSON.parse(JSON.stringify(snapshot[field]));
      changed = true;
    }
  }
  return changed;
}

// ── KP 系统提示 / 消息构建：使用 Core ContextBuilder ─────

// ── 日志 ──────────────────────────────────────────────────

function appendLog(state, kind, text, player = "") {
  state.log.push({ seq: state.log.length + 1, at: nowIso(), kind, player, text });
  if (state.log.length > 600) state.log = state.log.slice(-600);
  return state.log[state.log.length - 1];
}

// ── 工具执行辅助 ──────────────────────────────────────────

async function executeToolForLoop(def, args) {
  try {
    const data = await def.execute(args, {});
    const rendered = def.output.render(args, data);
    const text = Array.isArray(rendered) && rendered[0]?.text !== undefined ? rendered[0].text : JSON.stringify(data);
    return { ok: true, text };
  } catch (error) {
    return { ok: false, text: `错误：${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── KP 迷你循环 ───────────────────────────────────────────

/**
 * 创建聊天桥。
 * @param {object} deps - { ctx, dataDir, defaultGame, persistence, session, stateKey, toolDefs, llmProvider, llmModel, maxChatRounds, maxChatLog }
 */
export function createSharedChatBridge(deps) {
  const streamBlocks =
    typeof deps.streamBlocks === "function"
      ? deps.streamBlocks
      : (options) => callLlmApi(deps.dataDir, options.messages, options);
  const touchFlat = (gameId) => {
    const key = deps.stateKey(gameId);
    let flat = deps.persistence.load(key);
    if (flat === null) {
      flat = {
        id: gameId,
        title: gameId,
        updatedAt: nowIso(),
        kpMode: "ai",
        rules: null,
        scenario: null,
        characters: [],
        keyPoints: [],
        branches: [],
        currentScene: "",
        currentBranchId: "",
        time: "",
        synopsis: "",
        tasks: [],
        entities: [],
        log: [],
        toolTrace: [],
        rollHistory: [],
        reminders: [],
        pendingChecks: [],
        skippedChecks: [],
        sanitySettled: [],
        scenarioFacts: [],
        scenarioCheckpoints: [],
        scenarioContract: null,
        firedNightEventIds: [],
        events: [],
      };
      deps.persistence.save(key, flat);
    }
    return flat;
  };

  // 旧场次没有场景事实卡/显式检定点时，用确定性规则从剧本原文补算。
  const enrichScenarioFacts = (flat) => {
    const text = flat.scenario?.text ?? "";
    if (text.trim().length === 0) return flat;
    if (!Array.isArray(flat.scenarioFacts) || flat.scenarioFacts.length === 0) {
      flat.scenarioFacts = extractSceneFacts(text);
    }
    if (!Array.isArray(flat.scenarioCheckpoints)) {
      flat.scenarioCheckpoints = extractCheckpoints(text);
    }
    return flat;
  };

  // 剧本执行契约：非空类别保留（视为已校对），空类别从原文/检定点/实体草拟。
  const enrichScenarioContract = (flat) => {
    const text = flat.scenario?.text ?? "";
    if (text.trim().length === 0) return flat;
    flat.scenarioContract = ensureScenarioContract(flat.scenarioContract ?? null, flat);
    if (!Array.isArray(flat.firedNightEventIds)) flat.firedNightEventIds = [];
    return flat;
  };

  // C-3：每轮用 flat 剧情结构同步 PlotGraph，并重算可达路线集合（frontier）。
  const refreshPlotFrontier = (flat) => {
    const routes = computeStoryFrontier(flat);
    deps.session.plot.syncFromStory({
      keyPoints: flat.keyPoints ?? [],
      branches: flat.branches ?? [],
    });
    deps.session.plot.applyStoryFrontier(routes);
    deps.session.plot.applyCompletedConsequences(deps.session.world);
    flat.core = deps.session.toJSON();
    flat.updatedAt = nowIso();
    return { routes, frontierText: storyFrontierText(routes) };
  };

  const syncSession = (flat) => {
    deps.session.id = flat.id ?? "default";
    deps.session.syncFromFlat(flat);
    // 保留本轮已在内存里累积的 trace / eventLog，不因同步旧 core 而回滚；
    // plot / clues / sceneMode 仍从已保存的 core 恢复。
    const core = flat.core ?? {};
    deps.session.hydrateCore({ ...core, trace: undefined, eventLog: undefined });
  };

  const saveFlat = (gameId, flat) => {
    syncSession(flat);
    flat.core = deps.session.toJSON();
    flat.updatedAt = nowIso();
    deps.persistence.save(deps.stateKey(gameId), flat);
  };

  // C-1：聊天桥副作用事件化入口——先把当前 flat 收进 WorldState，
  // 再应用事件，最后投影回 flat 并保存。
  const commitChatEvents = (gameId, flat, events) => {
    if (events.length === 0) {
      saveFlat(gameId, flat);
      return flat;
    }
    syncSession(flat);
    for (const event of events) {
      const stamped = deps.session.applyEvent(event);
      deps.session.recordTrace({ kind: "event", type: event.type, eventId: stamped.id });
    }
    projectToFlat(deps.session, flat, deps.maxRollHistory);
    flat.core = deps.session.toJSON();
    flat.updatedAt = nowIso();
    deps.persistence.save(deps.stateKey(gameId), flat);
    return flat;
  };

  // 明骰一律由玩家发送 .ra 指令触发，主持循环不再向 KP 暴露 coc_roll。
  const CHAT_KP_TOOLS = PANEL_TOOLS.filter((toolName) => toolName !== "coc_roll");
  const ROLL_TOOL_NAMES = new Set([
    "coc_roll",
    "coc_roll_secret",
    "coc_combat_resolve",
    "coc_sanity_check",
    "coc_skill_growth",
  ]);

  async function runNarrationLoop(gameId, flat, messages, opts = {}) {
    let narration = "";
    let rounds = 0;
    let lastFinish = null;
    // .ra 路径：玩家已掷骰且结果已注入【系统检定】，本轮允许叙述中残留结果词（稍后剥离）。
    let calledRollTool = opts.calledRollTool === true;
    let pendingChecks = [];
    const toolChecks = [];
    const rollToolCalls = [];
    const sanityCheckLines = [];
    let toolOnlyRounds = 0;
    let emptyRounds = 0;

    for (; rounds < deps.maxChatRounds; rounds += 1) {
      // 上一轮只调工具没写正文后，本轮禁止再调工具，强制模型输出剧情叙述。
      // 避免模型连续调用 coc_scene/coc_entity 等状态工具而不推进任何玩家可见剧情。
      const toolsForThisRound =
        toolOnlyRounds >= 1
          ? []
          : CHAT_KP_TOOLS.flatMap((toolName) => {
              const def = deps.toolDefs.get(toolName);
              return def === undefined
                ? []
                : [{ name: def.name, description: def.description, parameters: def.parameters }];
            });
      const response = await streamBlocks({
        system: buildKpSystemPrompt({
          ...flat,
          endingStatus: summarizeReachability(deps.session.plot),
          frontier: storyFrontierText(computeStoryFrontier(flat)),
        }),
        messages,
        tools: toolsForThisRound,
        max_tokens: 1200,
      });
      const blocks = response.blocks;
      lastFinish = response.finish;
      const { textBlocks, calls } = parseAssistantBlocks(blocks);
      messages.push({
        role: "assistant",
        source: { kind: "model" },
        content: buildAssistantContent(textBlocks, calls),
      });

      const decision = decideNext(blocks);
      if (decision.kind === "narrate") {
        pendingChecks = parseCheckRequests(decision.text);
        let text = stripCheckRequests(decision.text);
        if (text.trim().length === 0) emptyRounds += 1; else emptyRounds = 0;

        // 判定词守卫：叙述里出现“困难成功”等词但本轮没调用任何检定工具时，
        // 说明模型在自行编造结果——不落盘，追加纠正消息后重试一轮。
        if (containsResultPhrase(text) && !calledRollTool) {
          messages.push({
            role: "user",
            source: { kind: "system" },
            content: [{
              type: "text",
              text: "（系统）你的叙述里包含检定结果词（如“困难成功”）或骰值，但本轮没有调用任何检定工具。请重新处理：需要玩家明骰时，在叙述结尾给出【团检：技能名】等待玩家发送 .ra 指令；需要暗骰时调用 coc_roll_secret。只写效果，不要出现成功档位词或骰值。",
            }],
          });
          continue;
        }

        // 若本轮调用过检定工具（暗骰等），系统骰行/暗骰记录已存在，剥掉叙述中残留的档位词。
        text = stripResultPhrases(text);

        // 只给了团检标记或空白时，追加纠正并重试，不要把空叙述落盘成“请再说一次”。
        // 连续两轮都空说明模型/上游不稳定：直接结束循环，由外层快速落盘兜底文案，
        // 避免 busy 长时间悬挂。
        if (text.trim().length === 0) {
          if (emptyRounds >= 2) break;
          messages.push({
            role: "user",
            source: { kind: "system" },
            content: [{
              type: "text",
              text: pendingChecks.length > 0
                ? "（系统）你只给出了团检标记，没有输出剧情叙述。请直接输出本轮的剧情叙述，团检标记放在最后一行即可。"
                : "（系统）本轮没有产生剧情叙述文本。请直接输出剧情叙述。",
            }],
          });
          continue;
        }

        narration = text;
        break;
      }

      const outcomes = [];
      const traceEntries = [];
      for (const call of calls) {
        const def = deps.toolDefs.get(call.name);
        // 聊天轮次只能写入当前场次；忽略模型参数中可能出现的其他 game。
        const parsed = { ...parseToolArguments(call.arguments), game: gameId };
        const outcome = def === undefined
          ? { ok: false, text: `未知工具 ${call.name}` }
          : await executeToolForLoop(def, parsed);
        outcomes.push(outcome);
        traceEntries.push({ at: nowIso(), round: rounds + 1, tool: call.name, args: parsed, ok: outcome.ok, text: outcome.text.slice(0, 240) });

        // coc_check 登记的门禁由工具自己落盘；这里再收集一份供返回与测试使用。
        if (call.name === "coc_check" && outcome.ok) {
          const gate = {
            skill: String(parsed.skill ?? "").trim(),
            difficulty: parsed.difficulty === "hard" || parsed.difficulty === "extreme" ? parsed.difficulty : "regular",
            action: String(parsed.action ?? "").trim(),
            hidden: parsed.hidden === true,
          };
          if (gate.skill.length > 0 && !toolChecks.some((check) => checkKey(check) === checkKey(gate))) {
            toolChecks.push(gate);
          }
        }
        // SAN 检定（SC）是明骰：收集渲染文本，稍后写入玩家可见日志。
        if (call.name === "coc_sanity_check" && outcome.ok && outcome.text.trim().length > 0) {
          sanityCheckLines.push(outcome.text.trim());
        }
      }
      if (calls.some((call) => ROLL_TOOL_NAMES.has(call.name))) calledRollTool = true;
      for (const call of calls) {
        if (ROLL_TOOL_NAMES.has(call.name) && !rollToolCalls.includes(call.name)) {
          rollToolCalls.push(call.name);
        }
      }
      messages.push(...buildToolResultMessages(calls, outcomes));
      if (String(decision.text ?? "").trim().length === 0) {
        toolOnlyRounds += 1;
        // 工具执行完仍没写正文：明确要求下一轮直接输出叙述（且下一轮已禁用工具）。
        messages.push({
          role: "user",
          source: { kind: "system" },
          content: [{
            type: "text",
            text: "（系统）工具已执行。现在请立即输出本轮剧情叙述文本，不要再调用任何工具。",
          }],
        });
      } else {
        toolOnlyRounds = 0;
      }

      // 工具已各自持久化状态；重新加载最新 flat，把本轮 trace 并入 core 的 session.trace
      const key = deps.stateKey(gameId);
      flat = deps.persistence.load(key) ?? flat;
      flat.toolTrace.push(...traceEntries);
      if (flat.toolTrace.length > 200) flat.toolTrace = flat.toolTrace.slice(-200);
      syncSession(flat);
      for (const entry of traceEntries) {
        deps.session.recordTrace({ kind: "tool-loop", ...entry });
      }
      flat.core = deps.session.toJSON();
      flat.updatedAt = nowIso();
      deps.persistence.save(key, flat);
    }

    return { narration, lastFinish, rounds, pendingChecks, calledRollTool, toolChecks, rollToolCalls, sanityCheckLines };
  }

  async function runKpTurn(gameId, text, player) {
    let flat = touchFlat(gameId);
    flat = enrichScenarioFacts(flat);
    flat = enrichScenarioContract(flat);
    flat = enrichStoryPrerequisites(flat);
    // C-3：先完整恢复世界/剧情图，再同步故事结构并重算可达路线。
    syncSession(flat);
    const { frontierText } = refreshPlotFrontier(flat);
    if (flat.busy === true) {
      // Narrative Recovery：busy 卡死超过 5 分钟自动恢复
      if (isBusyStale(flat, nowIso())) {
        syncSession(flat);
        deps.session.recordTrace({ kind: "recovery-busy-reset", recoveredAt: nowIso() });
        flat.busy = false;
        flat.core = deps.session.toJSON();
        flat.updatedAt = nowIso();
        deps.persistence.save(deps.stateKey(gameId), flat);
      } else {
        throw new Error("KP 正在回复中，请稍候");
      }
    }
    flat.busy = true;
    // 每次聊天轮开始前，先清除旧版提取器写入的垃圾物品（持久化到盘）。
    cleanupJunkInventory(flat);
    saveFlat(gameId, flat);

    // 理智检定（SC）由 coc_sanity_check 统一明骰结算，不转成普通 .ra 技能门禁
    // （兼容历史数据里的 .ra理智 门禁：移入 skipped 保留审计）。
    {
      const pending = Array.isArray(flat.pendingChecks) ? flat.pendingChecks : (flat.pendingChecks = []);
      const sanityGates = pending.filter(
        (gate) => gate.skill === "理智" || /^SAN$/i.test(String(gate.skill ?? ""))
      );
      if (sanityGates.length > 0) {
        const skipped = Array.isArray(flat.skippedChecks) ? flat.skippedChecks : (flat.skippedChecks = []);
        for (const gate of sanityGates) skipped.push({ ...gate, skippedAt: nowIso(), reason: "sanity-handled-by-tool" });
        flat.pendingChecks = pending.filter(
          (gate) => gate.skill !== "理智" && !/^SAN$/i.test(String(gate.skill ?? ""))
        );
        if (skipped.length > 80) flat.skippedChecks = skipped.slice(-80);
        saveFlat(gameId, flat);
      }
    }

    // 场景失效清理：门禁绑定的场景已切走且互不包含时，旧门禁移入 skipped。
    {
      const expired = expireSceneGates(flat, flat.currentScene ?? "");
      if (expired > 0) {
        syncSession(flat);
        deps.session.recordTrace({ kind: "gate-expired-scene", count: expired, at: nowIso() });
        saveFlat(gameId, flat);
      }
    }

    let ra = parseRaCommand(text);

    // `.ra侦查 2` 在存在候选确认请求时解析为“选择第 2 个候选动作”，
    // 而不是把“侦查 2”当技能名。
    let raChoiceAction = null;
    if (ra !== null && flat.pendingChoice !== null && flat.pendingChoice !== undefined) {
      raChoiceAction = resolveRaCandidateChoice(ra.skill, flat.pendingChoice);
      if (raChoiceAction !== null) ra = null;
    }

    const gatesBeforeKeys = new Set((flat.pendingChecks ?? []).map(checkKey));

    // 把除 exceptGateId 外的门禁记入 skippedChecks（reason=abandoned/superseded），
    // 玩家改做其他动作 = 旧门禁作废，而不是“已跳过检定”。
    const abandonGates = (exceptGateId, reason) => {
      const pending = Array.isArray(flat.pendingChecks) ? flat.pendingChecks : (flat.pendingChecks = []);
      const skipped = Array.isArray(flat.skippedChecks) ? flat.skippedChecks : (flat.skippedChecks = []);
      for (const gate of pending) {
        if (gate.id === exceptGateId) continue;
        skipped.push({ ...gate, skippedAt: nowIso(), reason });
      }
      flat.pendingChecks = pending.filter((gate) => gate.id === exceptGateId);
      if (skipped.length > 80) flat.skippedChecks = skipped.slice(-80);
    };
    const assignGateIds = (gates) => {
      for (const gate of gates) {
        if (typeof gate.id !== "string" || gate.id.length === 0) {
          gate.id = nextId("chk", gates, "id");
        }
      }
    };
    const choiceText = (candidates) =>
      candidates.map((candidate, index) => `${index + 1})「${candidate}」`).join(" ");

    try {
      appendLog(flat, "user", text, player);
      // 先把玩家输入持久化：工具执行后我们会从磁盘重载 flat，
      // 若不落盘，工具重载会把内存里的玩家输入冲掉。
      saveFlat(gameId, flat);

      // 空 .ra：温柔提示，不报错。
      if (ra !== null && ra.skill.length === 0) {
        appendLog(flat, "check", "[提示] 请发送 .ra技能名 进行检定，例如 .ra聆听");
        flat.busy = false;
        saveFlat(gameId, flat);
        return {
          rounds: 0,
          busy: false,
          narration: "",
          finish: null,
          logLength: flat.log.length,
          digest: stateDigest(flat),
          pendingChecks: flat.pendingChecks,
        };
      }

      // 玩家在“多候选确认”后的回复：编号或动作文本。
      let choiceAction = raChoiceAction;
      if (choiceAction === null && ra === null && flat.pendingChoice !== null && flat.pendingChoice !== undefined) {
        choiceAction = resolvePendingChoice(text, flat.pendingChoice);
        if (choiceAction === null) {
          // 没有选择候选动作，而是输入了新动作：旧门禁作废，按新动作继续。
          abandonGates(undefined, "abandoned-choice");
          flat.pendingChoice = null;
          saveFlat(gameId, flat);
        }
      }

      let messages;
      let loopResult;
      let rolledRaSkill = null;
      let lastRoll = null;
      let sideEffectSnapshot = null;
      let sideEffectRollbackNeeded = false;

      if (ra !== null || choiceAction !== null) {
        const skill = ra !== null ? ra.skill : String(flat.pendingChoice?.skill ?? "");
        const difficulty = ra !== null ? ra.difficulty : String(flat.pendingChoice?.difficulty ?? "regular");

        const gates = Array.isArray(flat.pendingChecks) ? flat.pendingChecks : [];
        const skillGates = gates.filter((gate) => gate.skill === skill);

        // 已有候选确认请求时：
        if (flat.pendingChoice !== null && flat.pendingChoice !== undefined) {
          if (ra !== null && flat.pendingChoice.skill === skill) {
            // 玩家又发了同一 .ra：先确认动作，不掷骰。
            appendLog(flat, "check", `[系统] 请先确认要对哪个动作进行 ${skill} 检定：${choiceText(flat.pendingChoice.candidates)}`);
            flat.busy = false;
            saveFlat(gameId, flat);
            return {
              rounds: 0, busy: false, narration: "", finish: null,
              logLength: flat.log.length, digest: stateDigest(flat),
              pendingChecks: flat.pendingChecks,
            };
          }
          if (ra !== null && flat.pendingChoice.skill !== skill) {
            // 玩家改掷其他技能：旧候选作废。
            abandonGates(undefined, "abandoned-choice");
            flat.pendingChoice = null;
            saveFlat(gameId, flat);
          }
        }

        const distinctActions = [...new Set(
          skillGates.map((gate) => String(gate.action ?? "").trim()).filter((action) => action.length > 0)
        )];

        // 最终仪式轮失败后的重试门禁优先：裸 .ra 直接消费该门禁，
        // 不进入候选确认。否则 LLM 额外创建的意志门禁会让一次明骰
        // 卡在“请确认要对哪个动作检定”而不掷骰。
        const retryGate =
          ra !== null && choiceAction === null && distinctActions.length > 1
            ? skillGates.find((gate) => gate.source === "final-rite-retry") ?? null
            : null;

        // 多候选动作：先确认动作，不掷骰。
        if (ra !== null && choiceAction === null && distinctActions.length > 1 && retryGate === null) {
          flat.pendingChoice = { skill, difficulty, candidates: distinctActions, at: nowIso() };
          appendLog(flat, "check", `[系统] 请确认要对哪个动作进行 ${skill} 检定：${choiceText(distinctActions)}`);
          flat.busy = false;
          saveFlat(gameId, flat);
          return {
            rounds: 0, busy: false, narration: "", finish: null,
            logLength: flat.log.length, digest: stateDigest(flat),
            pendingChecks: flat.pendingChecks,
          };
        }

        let selectedGate = null;
        if (retryGate !== null) {
          selectedGate = retryGate;
        } else if (choiceAction !== null) {
          selectedGate = gates.find(
            (gate) => gate.skill === skill && String(gate.action ?? "").trim() === choiceAction
          ) ?? null;
        } else if (skillGates.length === 1) {
          selectedGate = skillGates[0];
        } else {
          const action =
            choiceAction !== null
              ? choiceAction
              : distinctActions.length === 1
                ? distinctActions[0]
                : "";
          if (action.length > 0) {
            selectedGate = skillGates.find((gate) => String(gate.action ?? "").trim() === action) ?? null;
          }
        }
        const action =
          retryGate !== null
            ? String(retryGate.action ?? "").trim()
            : choiceAction !== null
              ? choiceAction
              : distinctActions.length === 1
                ? distinctActions[0]
                : "";

        const { name, target } = resolveRaTarget(flat, player, skill);

        // 无技能值/无默认值时拒绝掷骰，避免出现“D100=62 无目标”却被当作成功续写。
        if (target === null) {
          appendLog(
            flat,
            "check",
            `[系统] 没有找到「${skill}」的技能值，无法自动判定成败。请改投有数值的技能，或先在人物卡补充「${skill}」技能值后再试。`
          );
          flat.busy = false;
          saveFlat(gameId, flat);
          return {
            rounds: 0,
            busy: false,
            narration: "",
            finish: null,
            logLength: flat.log.length,
            digest: stateDigest(flat),
            pendingChecks: flat.pendingChecks,
          };
        }

        const result = performRaRoll(skill, target, difficulty);
        rolledRaSkill = skill;
        lastRoll = result;
        const rollLine = formatRaResultLine(name, skill, result);
        appendLog(flat, "roll", rollLine, name);

        // 先匹配剧本检定点，成功时按 checkpointId 幂等消费（B-2）。
        const checkpointBefore = findCheckpointMatch(flat, skill, difficulty, action);
        if (selectedGate !== null && checkpointBefore?.id !== undefined && checkpointBefore?.id !== null && String(checkpointBefore.id).length > 0) {
          selectedGate.checkpointId = checkpointBefore.id;
        }

        // 本次检定的门禁已解决；同轮其他门禁作废（玩家改做其他动作）。
        if (skillGates.length > 0) {
          abandonGates(selectedGate?.id, "superseded");
          if (selectedGate !== null) {
            flat.pendingChecks = flat.pendingChecks.filter((gate) => gate.id !== selectedGate.id);
          }
        }
        flat.pendingChoice = null;
        if (result.passed !== true && selectedGate !== null) {
          deps.session.recordTrace({ kind: "gate-failed", skill, action, at: nowIso() });
        }

        const raEvents = [
          rollEvent(gameId, {
            kind: "open",
            player: name,
            label: `${skill}检定`,
            skill,
            expression: "d100",
            dice: result.dice,
            rolled: result.rolled,
            total: result.total,
            target: result.target ?? null,
            difficulty,
            tier: result.tier,
            passed: result.passed,
          }),
        ];
        if (selectedGate !== null) {
          if (result.passed) {
            raEvents.push(
              gateResolvedEvent(gameId, selectedGate, {
                resolvedKey: action.length > 0 ? resolvedCheckKey(skill, action) : "",
              })
            );
          } else {
            raEvents.push(gateFailedEvent(gameId, selectedGate));
          }
        }
        const checkpointIdForEvent =
          selectedGate?.checkpointId !== undefined && String(selectedGate.checkpointId).length > 0
            ? String(selectedGate.checkpointId)
            : checkpointBefore?.id !== undefined && checkpointBefore?.id !== null
              ? String(checkpointBefore.id)
              : "";
        if (result.passed && checkpointIdForEvent.length > 0) {
          raEvents.push(checkpointPassedEvent(gameId, checkpointIdForEvent, { skill, action }));
        }
        syncSession(flat);
        commitSession(deps, gameId, deps.session, flat, raEvents);
        flat = deps.persistence.load(deps.stateKey(gameId)) ?? flat;

        // C-4：最终仪式轮的意志/SAN 门禁失败后必须自动重建同门禁，
        // 否则玩家重试成功时没有门禁可消费，EventLog 会缺失 GateResolved。
        const finalBranchForGateRetry = findFinalBranch(flat);
        if (
          result.passed !== true &&
          selectedGate !== null &&
          finalBranchForGateRetry?.reached === true &&
          String(finalBranchForGateRetry?.chosen ?? "").length > 0 &&
          /^(意志|POW|理智|SAN)$/i.test(skill)
        ) {
          const retryGate = {
            id: nextId("chk", flat.pendingChecks ?? [], "id"),
            skill: selectedGate.skill ?? skill,
            difficulty: selectedGate.difficulty ?? "regular",
            action: selectedGate.action ?? "",
            hidden: selectedGate.hidden === true,
            checkpointId: selectedGate.checkpointId ?? "",
            target: selectedGate.target ?? gateTargetKey(String(selectedGate.action ?? "")),
            at: nowIso(),
            scene: selectedGate.scene ?? flat.currentScene ?? "",
            source: "final-rite-retry",
          };
          flat.pendingChecks = [...(flat.pendingChecks ?? []), retryGate];
          commitChatEvents(gameId, flat, [gateCreatedEvent(gameId, retryGate)]);
          flat = deps.persistence.load(deps.stateKey(gameId)) ?? flat;
        }

        // 门禁消费短路：成功检定的 skill+action 写入 resolvedChecks，
        // 后续文本/工具再冒同键门禁时直接丢弃，避免同一门禁反复要求掷骰。
        if (result.passed) {
          if (action.length > 0) {
            recordResolvedCheck(flat, skill, action);
            syncSession(flat);
            deps.session.recordTrace({ kind: "gate-resolved", skill, action, at: nowIso() });
          }
          // 事件驱动落地：成功的检定通过检定点时，记录 passedCheckpointIds。
          // 优先使用门禁绑定的 checkpointId；否则用本轮动作匹配到的检定点。
          const checkpoint = selectedGate?.checkpointId
            ? { id: selectedGate.checkpointId }
            : checkpointBefore;
          if (checkpoint?.id !== undefined && checkpoint?.id !== null && String(checkpoint.id).length > 0) {
            recordPassedCheckpoint(flat, checkpoint.id);
            syncSession(flat);
            deps.session.recordTrace({ kind: "checkpoint-pass", checkpointId: checkpoint.id, skill, action, at: nowIso() });
          }
          // 咒文解读兜底：智力在解谜语境下成功，即使门禁动作与咒文解读检定点的
          // 匹配词不完全一致，只要“日记与手稿”关键点已揭示且咒文关键点的结构化
          // 前置检定点尚未全部通过，就确定性记录这些检定点，驱动咒文关键点揭示。
          // 避免 LLM 在智力大成功后不落地咒文、反而生成错误十二字。
          {
            const baseSkill = String(skill ?? "").replace(/[（(][^）)]*[）)]/g, "").trim();
            const diaryKp = (flat.keyPoints ?? []).find(
              (kp) => String(kp?.title ?? "").includes("日记与手稿") || String(kp?.title ?? "").includes("日记和手稿")
            );
            const spellKp = findSpellKeyPoint(flat);
            const spellCheckpointIds = requiredCheckpointIdsOf(spellKp);
            const decodeContext = /咒|字|规律|演算|验算|推演|行号|字位|手稿|稿纸|日记|日期/.test(`${action} ${text}`);
            const fallbackEvents = [];
            if (
              result.passed === true &&
              (baseSkill === "智力" || baseSkill === "灵感") &&
              diaryKp?.revealed === true &&
              spellKp !== null &&
              spellCheckpointIds.length > 0 &&
              decodeContext &&
              !spellCheckpointIds.every((id) => (flat.passedCheckpointIds ?? []).includes(id))
            ) {
              for (const id of spellCheckpointIds) {
                recordPassedCheckpoint(flat, id);
                fallbackEvents.push(checkpointPassedEvent(gameId, id, { skill, action }));
                deps.session.recordTrace({ kind: "checkpoint-pass", checkpointId: id, skill, action, at: nowIso(), via: "spell-decode-fallback" });
              }
            }
            // 关键：先落盘再进入本轮叙事循环。叙事循环里工具执行后会从磁盘重载 flat，
            // 若不落盘，resolvedChecks / passedCheckpointIds 会被重载覆盖丢失。
            commitChatEvents(gameId, flat, fallbackEvents);
          }
        }

        messages = buildLoopMessages(flat.log ?? [], deps.maxChatLog);
        const revealTrigger = findCheckpointReveal(flat, skill, difficulty, action);
        const revealGuide = result.passed
          ? revealTrigger !== null
            ? `\n该动作成功，可揭示的剧本原文如下，请把它改写成现场叙述（不要照抄“玩家需要/调查员若”等元描述）：${revealTrigger}`
            : ""
          : `\n该动作失败：不要写出成功结果或任何受保护线索，只描述失败的观感与氛围。`;
        let rollSystemText =
          (action.length > 0
            ? `【系统检定】${rollLine}。玩家想对「${action}」进行检定。请据此直接叙述该动作的剧情结果，只写效果，不要出现成功档位词或骰值。`
            : `【系统检定】${rollLine}。请据此继续叙述，只写效果，不要出现成功档位词或骰值。`) + revealGuide;
        // 最终咒文仪式：意志/SAN 成功必须按已选分支推进结局，禁止回退到书房/地毯等更早场景。
        const finalBranch = findFinalBranch(flat);
        if (finalBranch?.reached === true && String(finalBranch?.chosen ?? "").length > 0 && /^(意志|POW|理智|SAN)$/i.test(skill)) {
          rollSystemText += `\n这是最终咒文仪式轮（已选「${String(finalBranch.chosen)}」）。${result.passed ? "检定成功：直接推进到该选择的结局——逆序念诵则墨渊消散、夏拉卡拉布被逐出；正序念诵则夏拉卡拉布降临。不要再回退到掀地毯/书房调查等更早场景。" : "检定失败：按失败后果继续（反噬/重复尝试），不要回退到更早场景。"}`;
        }
        messages.push({
          role: "user",
          source: { kind: "system" },
          content: [{ type: "text", text: rollSystemText }],
        });
        loopResult = await runNarrationLoop(gameId, flat, messages, { calledRollTool: true });
      } else {
        // 动作文本：先看是否命中已登记门禁。
        const matched = matchActionToGates(text, flat.pendingChecks ?? []);
        if (matched.length > 0) {
          // 命中门禁：系统阻止剧情推进，要求先检定。
          const lines = [...new Set(
            matched.map((gate) => formatCheckLine(gate.skill, gate.difficulty)).filter((line) => line.length > 0)
          )];
          appendLog(flat, "check", `[系统] 该动作需要先通过检定：${lines.join("  ")}`);
          flat.busy = false;
          saveFlat(gameId, flat);
          return {
            rounds: 0,
            busy: false,
            narration: "",
            finish: null,
            logLength: flat.log.length,
            digest: stateDigest(flat),
            pendingChecks: flat.pendingChecks,
          };
        }

        // 未命中：保留旧门禁，按自由动作交给 KP。
        // 旧门禁只在 .ra 消费、失败结算、明确跳过或场景失效时删除，
        // 不能因为玩家换了个措辞就清空（v9：同目标改写误删唯一门禁）。
        flat.pendingChoice = null;
        saveFlat(gameId, flat);

        // 自由动作路径：SAN/HP/物品等不可逆工具调用先挂账，等叙事校验通过才真正保留；
        // 若被守卫判定“门禁前泄露线索”，则回滚本轮副作用（门禁/scene 等结构变更保留）。
        sideEffectSnapshot = snapshotSideEffects(flat);
        sideEffectRollbackNeeded = false;

        messages = buildLoopMessages(flat.log ?? [], deps.maxChatLog);
        if (FULL_FORWARD_SPELL_RE.test(text) || FULL_INVERSE_SPELL_RE.test(text)) {
          messages.push({
            role: "user",
            source: { kind: "system" },
            content: [{
              type: "text",
              text: "（系统）玩家刚刚已经完整念出了十二字咒文。请把它视为一次完整的念诵，不要拆成半句或要求补念；直接进入对应的意志/SAN 结算流程。",
            }],
          });
        }
        loopResult = await runNarrationLoop(gameId, flat, messages, { calledRollTool: false });
      }

      let narration = stripResultPhrases(formatNarration(loopResult.narration, loopResult.lastFinish));

      // 场景事实守卫：叙述里出现“二楼的书房”这类楼层-房间冲突时，
      // 追加系统纠正消息并让 LLM 重写一次，冲突叙述不落盘。
      const conflict = findRoomFloorConflict(narration, flat.scenarioFacts ?? []);
      if (conflict !== null) {
        messages.push({
          role: "user",
          source: { kind: "system" },
          content: [{
            type: "text",
            text: `（系统）你的叙述疑似与剧本事实冲突：${conflict.room}应在${conflict.expectedFloor}，但叙述中出现了${conflict.foundFloor}附近的${conflict.room}。请以【当前场景原文】为准重写这一段，不要改变楼层与房间归属。`,
          }],
        });
        const retryResult = await runNarrationLoop(gameId, flat, messages, { calledRollTool: loopResult.calledRollTool });
        const retryNarration = stripResultPhrases(formatNarration(retryResult.narration, retryResult.lastFinish));
        if (retryNarration.trim().length > 0) {
          loopResult = retryResult;
          narration = retryNarration;
        }
      }

      // 循环内工具可能已落盘最新状态（coc_scene/coc_pc/coc_check…），
      // 这里必须从磁盘重载，避免用旧的 flat 覆盖掉循环中的状态变更。
      flat = deps.persistence.load(deps.stateKey(gameId)) ?? flat;

      // 叙事候选校验：旧守卫（线索门禁泄露 + 危险推荐动作）+ 剧本执行契约
      // （线索门禁/NPC 知识/仪式条件/最终分支白名单）。
      // 有问题时追加纠正消息并重写一次；重写仍不合格也接受（避免空转），
      // 但至少阻止了非法叙述直接落盘。
      {
        const rolledSkills = new Set();
        if (rolledRaSkill !== null) rolledSkills.add(rolledRaSkill);
        const sanityChecked = (loopResult.rollToolCalls ?? []).includes("coc_sanity_check");

        const guardIssues = validateNarrationCandidate(narration, {
          currentScene: flat.currentScene ?? "",
          scenarioFacts: flat.scenarioFacts ?? [],
          scenarioCheckpoints: flat.scenarioCheckpoints ?? [],
          rolledSkills,
          sanityChecked,
        }).map((issue) => issue.message);

        const firstPc =
          (flat.characters ?? []).find((character) => character.aiControlled !== true) ??
          (flat.characters ?? [])[0] ??
          null;
        // 契约强制仅在其已确认生效后开启；draft 阶段只观察不拦截（旧数据无 status 视为已生效，保持兼容）。
        const contractEnforced =
          flat.scenarioContract?.status === "confirmed" ||
          flat.scenarioContract?.reviewed === true ||
          (flat.scenarioContract?.status === undefined && flat.scenarioContract?.reviewed === undefined);
        const contractIssues = contractEnforced
          ? validateCandidateNarration(flat.scenarioContract, narration, {
              currentScene: flat.currentScene ?? "",
              time: flat.time ?? "",
              rolledSkills,
              sanityChecked,
              passedGateIds: [],
              revealedKeyPoints: (flat.keyPoints ?? [])
                .filter((keyPoint) => keyPoint?.revealed === true)
                .map((keyPoint) => String(keyPoint.title ?? "")),
              inventory: firstPc?.inventory ?? [],
              knownClues: [],
              participants: (flat.characters ?? []).map((character) => String(character.name ?? "")),
              currentBranchId: flat.currentBranchId ?? "",
              branches: (flat.branches ?? []).map((branch) => ({
                id: branch.id,
                title: branch.title,
                reached: branch.reached === true,
              })),
            }).violations
          : [];

        const diaryLeakIssues = findEarlyDiaryLeak(narration, flat);
        const allIssues = [...guardIssues, ...contractIssues, ...diaryLeakIssues];
        if (allIssues.length > 0 && sideEffectSnapshot !== null) {
          sideEffectRollbackNeeded = true;
        }
        if (allIssues.length > 0) {
          messages.push({
            role: "user",
            source: { kind: "system" },
            content: [{
              type: "text",
              text: `（系统）${allIssues.join(" ")}`,
            }],
          });
          const retryResult = await runNarrationLoop(gameId, flat, messages, {
            calledRollTool: loopResult.calledRollTool,
          });
          const retryNarration = stripResultPhrases(formatNarration(retryResult.narration, retryResult.lastFinish));
          if (retryNarration.trim().length > 0) {
            loopResult = retryResult;
            narration = retryNarration;
          }
          // 重写循环里可能又调用了工具（coc_check/coc_scene…），重载最新状态。
          flat = deps.persistence.load(deps.stateKey(gameId)) ?? flat;
        }
      }

      // 守卫判定“门禁前泄露线索”时，回滚本轮不可逆副作用（SAN/HP/物品/骰点），
      // 门禁登记、场景推进等结构变更保留。对应“受保护动作最终失败，SAN 不能先扣”。
      if (sideEffectRollbackNeeded && sideEffectSnapshot !== null) {
        if (restoreSideEffects(flat, sideEffectSnapshot)) {
          syncSession(flat);
          deps.session.recordTrace({ kind: "side-effect-rollback", at: nowIso(), reason: "narration-guard" });
          flat.core = deps.session.toJSON();
          flat.updatedAt = nowIso();
          deps.persistence.save(deps.stateKey(gameId), flat);
        }
      }

      // 终局短路：最终咒文轮（意志/SAN）成功时，程序确定性提交结局，
      // 防止 LLM 把叙述回退到掀地毯/书房调查等更早场景。
      // 结局先被创建为 EndingResolved 事件，再应用（C 阶段由 Rule Engine/PlotGraph 发布）。
      {
        // C-4：结局由 PlotGraph 结局节点完成时发布——先同步剧情图，
        // 再取已完成的结局节点来构造 EndingResolved 事件。
        deps.session.plot.syncFromStory({ keyPoints: flat.keyPoints ?? [], branches: flat.branches ?? [] });
        const endingNode = deps.session.plot.completedEndingNodes()[0] ?? null;
        const finalBranchFromPlot =
          endingNode !== null
            ? {
                id: endingNode.branchId,
                title: endingNode.title,
                reached: true,
                chosen: endingNode.chosen,
                options: [{ label: endingNode.optionLabel ?? endingNode.chosen, leadsTo: endingNode.title }],
              }
            : null;
        const ending = createEndingResolvedEvent(flat, narration, {
          rolledRaSkill,
          lastRoll,
          now: nowIso(),
          ...(finalBranchFromPlot !== null ? { finalBranch: finalBranchFromPlot } : {}),
        });
        if (ending !== null) {
          narration = ending.narration;
          applyEndingResolvedEvent(flat, ending.event, ending.finalBranch);
          commitChatEvents(gameId, flat, [ending.event]);
          deps.session.recordTrace({ ...ending.event, skill: rolledRaSkill });
        }
      }

      // 场景落地：当前场景为空，或叙述明显进入另一个有事实卡的场景
      // （而当前场景词不再出现）时，从叙述文本确定性推断并写入状态。
      // 修复“开场 currentScene=镇上街道 后走到三层也不更新”的问题。
      // C-4：场景切换需要“新场景词 + 位置转移动作”同时命中；仅提到另一场景
      // 不再把 currentScene 漂走（修复 study 预设下“检查书桌”被叙述里的
      // “一层客厅”带跑的问题）。
      if (flat.endingReached !== true) {
        const inferred = inferSceneTransition(narration, flat.currentScene ?? "", flat.scenarioFacts ?? []);
        if (inferred !== null && inferred.length > 0 && inferred !== flat.currentScene) {
          const currentFact = selectSceneFacts(flat.currentScene ?? "", flat.scenarioFacts ?? []);
          const currentKeywords = currentFact?.keywords ?? [];
          const mentionsCurrent = currentKeywords.some((keyword) => narration.includes(keyword));
          if ((flat.currentScene ?? "") === "" || !mentionsCurrent) {
            flat.currentScene = inferred;
          }
        }
      }

      // 开场前提关键点：scene=导入 的关键点（如“委托到来”）在开场白/首轮叙述后
      // 视为已向玩家交代，确定性揭示；不依赖 LLM 自觉调用 coc_branch reveal。
      let openingRevealed = 0;
      const kpLogCountBefore = (flat.log ?? []).filter((entry) => entry.kind === "kp").length;
      if (kpLogCountBefore <= 1 && narration.trim().length > 0) {
        for (const kp of flat.keyPoints ?? []) {
          if (kp?.revealed === true) continue;
          if (String(kp?.scene ?? "").trim() === "导入") {
            kp.revealed = true;
            openingRevealed += 1;
          }
        }
      }

      // 关键点/分支/物品自动落地：优先事件驱动（场景切入/检定通过/SAN 结算/分支选择），
      // 叙述词面启发式仅作兜底。
      const revealedKpIdsBefore = new Set((flat.keyPoints ?? []).filter((kp) => kp?.revealed === true).map((kp) => String(kp.id)));
      const reachedBranchIdsBefore = new Set((flat.branches ?? []).filter((branch) => branch?.reached === true).map((branch) => String(branch.id)));
      const eventLanded = applyEventDrivenLanding(flat, text, narration);
      const landedBranches = autoLandBranches(flat, text, narration) + eventLanded.branches;
      const branchRevealed = revealKeyPointsForBranchChoices(flat);
      const revealedCount = eventLanded.revealed + revealKeyPointsFromNarration(flat.keyPoints, narration) + openingRevealed + branchRevealed;
      const acquiredItems = autoTrackInventory(flat, narration);
      const landingEvents = [];
      for (const kp of flat.keyPoints ?? []) {
        if (kp?.revealed === true && !revealedKpIdsBefore.has(String(kp.id))) {
          landingEvents.push(keyPointRevealedEvent(gameId, String(kp.id)));
        }
      }
      for (const branch of flat.branches ?? []) {
        if (branch?.reached === true && !reachedBranchIdsBefore.has(String(branch.id))) {
          landingEvents.push(branchLandedEvent(gameId, String(branch.id), String(branch.chosen ?? "")));
        }
      }
      if (landingEvents.length > 0 || acquiredItems.length > 0) {
        commitChatEvents(gameId, flat, landingEvents);
      }
      if (revealedCount > 0 || acquiredItems.length > 0 || landedBranches > 0) {
        if (revealedCount > 0) {
          deps.session.recordTrace({ kind: "auto-reveal", count: revealedCount, at: nowIso() });
        }
        if (landedBranches > 0) {
          deps.session.recordTrace({ kind: "auto-branch-land", count: landedBranches, at: nowIso() });
        }
        if (acquiredItems.length > 0) {
          deps.session.recordTrace({ kind: "auto-inventory", items: acquiredItems, at: nowIso() });
        }
      }

      // 十二字咒文一旦拼出（或最终分支已选），必须把咒文内容确定性展示给玩家，
      // 否则 LLM 可能只写“十二个字已抄下”而始终不给出可核验的原文。
      {
        const spellKp = findSpellKeyPoint(flat);
        const finalBranch = findFinalBranch(flat);
        const finalBranchChosen =
          finalBranch?.reached === true && String(finalBranch?.chosen ?? "").length > 0;
        if (flat.spellShown !== true && (spellKp?.revealed === true || finalBranchChosen)) {
          appendLog(
            flat,
            "check",
            "【系统】已获得十二字咒文：启墨渊、引魂夜、临神名、归字主。倒着念（归字主、临神名、引魂夜、启墨渊）是送神/告别。"
          );
          flat.spellShown = true;
          commitChatEvents(gameId, flat, [spellShownEvent(gameId)]);
        }
      }

      // 夜晚事件：与时钟不严格绑定——调查员入睡后触发剧本事件；
      // 有 onSleep 事件的夜晚若不入睡，按 sleepPolicy 提示 KP 强制入睡/给惩罚。
      {
        const sleepMention =
          /(?:入睡|就寝|睡着|睡下|睡觉|进入梦乡)/.test(text) ||
          /(?:入睡|就寝|睡着|睡下|进入梦乡)/.test(narration);
        const night = evaluateNightEvents(flat.scenarioContract, {
          time: flat.time ?? "",
          sleeping: sleepMention,
          narrationMentionsSleep: sleepMention,
          firedNightEventIds: flat.firedNightEventIds ?? [],
        });
        if (night.forcedSleep !== null && !sleepMention) {
          appendLog(flat, "check", `[系统] ${night.forcedSleep.reason}（${night.forcedSleep.title}）`);
        }
        if (night.fired.length > 0) {
          const firedIds = new Set(Array.isArray(flat.firedNightEventIds) ? flat.firedNightEventIds : []);
          const nightEvents = [];
          for (const event of night.fired) {
            if (!firedIds.has(event.id)) nightEvents.push(nightEventFiredEvent(gameId, String(event.id)));
            firedIds.add(event.id);
            appendLog(flat, "check", `[夜晚事件] ${event.title}（已触发）`);
          }
          flat.firedNightEventIds = [...firedIds];
          if (nightEvents.length > 0) commitChatEvents(gameId, flat, nightEvents);
        }
      }

      // 结局已确认（最终分支已选 + 叙述出现该分支选项指向的结局关键词）后，
      // 不再生成任何新的动作门禁；防止结局叙述里的“手稿/书房”等词又推导出侦查团检。
      const finalBranch = findFinalBranch(flat);
      const endingKeywords = buildEndingKeywords(finalBranch);
      const endingReached =
        finalBranch?.reached === true &&
        String(finalBranch?.chosen ?? "").length > 0 &&
        (endingKeywords.some((keyword) => narration.includes(keyword)) || /(?:尾声|后日谈|葬礼)/.test(narration));
      // C-4：终局短路已发布过 EndingResolved 时不再重复发布（EventLog 去重）。
      if (endingReached && flat.endingReached !== true) {
        abandonAllGates(flat, "ending-reached", nowIso());
        flat.pendingChoice = null;
        flat.endingReached = true;
        flat.endedAt = flat.endedAt ?? nowIso();
        commitChatEvents(gameId, flat, [
          endingResolvedEvent(gameId, String(finalBranch.id), String(finalBranch.chosen), {
            currentScene: flat.currentScene ?? "",
          }),
        ]);
      }

      // 文本 [团检] 标记是旧模型/兜底路径；coc_check 工具已把门禁落盘，
      // 这里只把文本标记合并进去（去重），统一渲染 .ra 提示行。
      let textGates = [];
      if (!endingReached) {
        for (const check of loopResult.pendingChecks ?? []) {
          // 理智检定是暗骰，文本 [团检：理智] 也不得转成玩家明骰门禁。
          if (check.skill === "理智" || /^SAN$/i.test(String(check.skill ?? ""))) continue;
          const hints = Array.isArray(check.hints)
            ? check.hints.filter((hint) => typeof hint === "string" && hint.trim() !== "")
            : (typeof check.hint === "string" && check.hint.trim() !== "" ? [check.hint] : []);
          for (const hint of hints) {
            textGates.push({
              skill: check.skill,
              difficulty: check.difficulty ?? "regular",
              action: hint,
              hidden: false,
              at: nowIso(),
              scene: flat.currentScene ?? "",
              source: "text-marker",
            });
          }
        }
      }
      // 已通过门禁短路：skill+目标键 命中 resolvedChecks，或 checkpointId 已通过的门禁直接丢弃，
      // 不再渲染 .ra 提示，并在日志里明确告知 LLM 该检定已通过。
      {
        const resolvedKeys = new Set(Array.isArray(flat.resolvedChecks) ? flat.resolvedChecks : []);
        const passedIds = new Set(Array.isArray(flat.passedCheckpointIds) ? flat.passedCheckpointIds : []);
        const droppedResolved = [];
        const keepResolved = (gate) => {
          const byResolved = resolvedKeys.has(resolvedCheckKey(gate.skill, gate.action));
          const byCheckpoint = String(gate.checkpointId ?? "").length > 0 && passedIds.has(String(gate.checkpointId));
          if (byResolved || byCheckpoint) {
            droppedResolved.push(gate);
            return false;
          }
          return true;
        };
        flat.pendingChecks = (flat.pendingChecks ?? []).filter(keepResolved);
        textGates = textGates.filter(keepResolved);
        if (droppedResolved.length > 0) {
          appendLog(flat, "check", `[系统] 以下门禁已在此前检定成功，自动忽略：${droppedResolved
            .map((gate) => `${gate.skill}${String(gate.action ?? "").trim().length > 0 ? `（${String(gate.action).trim()}）` : ""}`)
            .join("、")}`);
          deps.session.recordTrace({ kind: "gate-resolved-dropped", count: droppedResolved.length, at: nowIso() });
        }
      }
      flat.pendingChecks = mergeCheckGates(flat.pendingChecks ?? [], textGates);
      assignGateIds(flat.pendingChecks);
      const newGateEvents = [];
      for (const gate of flat.pendingChecks) {
        if (gate.skill === "理智" || /^SAN$/i.test(String(gate.skill ?? ""))) continue;
        if (!gatesBeforeKeys.has(checkKey(gate))) {
          newGateEvents.push(gateCreatedEvent(gameId, gate));
        }
      }

      // SAN 检定（SC）是明骰：把 coc_sanity_check 的结算行写入玩家可见日志。
      // 若叙事校验触发回滚，说明本轮 SAN 不应生效，则不渲染该行（保持状态与日志一致）。
      if (sideEffectRollbackNeeded !== true) {
        for (const line of loopResult.sanityCheckLines ?? []) {
          const playerLine = sanitizeSanityLine(line);
          if (playerLine.length > 0) appendLog(flat, "roll", playerLine, "");
        }
      }

      appendLog(flat, "kp", narration);
      for (const gate of flat.pendingChecks) {
        if (gate.skill === "理智" || /^SAN$/i.test(String(gate.skill ?? ""))) continue;
        if (!gatesBeforeKeys.has(checkKey(gate))) {
          const line = formatCheckLine(gate.skill, gate.difficulty);
          if (line.length > 0) appendLog(flat, "check", line);
        }
      }

      // C-3：同步剧情图节点/边，应用已完成节点的后果（写 flags/线索/实体状态）。
      syncSession(flat);
      deps.session.plot.syncFromStory({ keyPoints: flat.keyPoints ?? [], branches: flat.branches ?? [] });
      deps.session.plot.applyStoryFrontier(computeStoryFrontier(flat));
      deps.session.plot.applyCompletedConsequences(deps.session.world);
      flat.core = deps.session.toJSON();
      flat.updatedAt = nowIso();

      flat.busy = false;
      commitChatEvents(gameId, flat, newGateEvents);

      return {
        rounds: loopResult.rounds,
        busy: false,
        narration,
        finish: loopResult.lastFinish ?? null,
        logLength: flat.log.length,
        digest: stateDigest(flat),
        pendingChecks: flat.pendingChecks,
      };
    } finally {
      const key = deps.stateKey(gameId);
      const latest = deps.persistence.load(key);
      if (latest !== null) {
        latest.busy = false;
        deps.persistence.save(key, latest);
      }
    }
  }

  return { runKpTurn, touchFlat, saveFlat, stateDigest, buildKpSystemPrompt };
}

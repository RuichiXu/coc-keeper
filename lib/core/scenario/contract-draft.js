/**
 * Scenario Contract 草拟（确定性规则提取）
 *
 * 剧本导入后，从 flat 已有的结构化数据（scenarioCheckpoints/entities/branches/keyPoints）
 * 与剧本原文中，确定性草拟 scenarioContract，供 KP 校对。
 *
 * 规则为主、LLM 校对/兜底由后续导入流程完成。纯函数，零 DSH 依赖。
 */
import { createScenarioContract, normalizeScenarioContract } from "./contract.js";

// 夜晚事件里的“仪式/结局/SAN/剧透”行不是可调度事件，确定性草拟一律排除。
const NIGHT_EVENT_SPOILER_RE =
  /(?:咒文|念出|念诵|吟诵|请神|送神|结局|END|SAN|san|巨眼|漩涡|夏拉卡拉布|降临|仪式|正序|逆序|词组|最终)/;
// 只有明确写“夜晚/晚上/当晚/午夜…”且出现夜间事件词的行才视为夜晚事件。
const NIGHT_TIME_RE = /(?:夜里|夜晚|晚上|夜间|当晚|午夜|半夜|子夜|凌晨)/;
const NIGHT_EVENT_VERB_RE = /(?:呓语|梦游|噩梦|惊醒|醒来|拍门|挠门|哭声|响动|异响|低语|鬼影|影子|活跃|追逐)/;
// 背景/回忆/习惯性描述不是“今晚会触发”的事件。
const NIGHT_PAST_HABIT_RE =
  /(?:三个月前|三个月间|近三个月|那天开始|时常|经常|总是|每晚|每天晚上|昨夜|昨晚|昨天|一直|每当|每每|常常|已经|曾经|过去|之前)/;

/**
 * 从 flat 草拟剧本执行契约。
 * @param {object} flat - { scenario:{text}, scenarioText?, scenarioCheckpoints?, entities?, branches?, keyPoints? }
 * @returns {object} 归一化后的 scenarioContract
 */
export function draftScenarioContract(flat) {
  const source = flat ?? {};
  const text = String(source.scenario?.text ?? source.scenarioText ?? "");
  const contract = createScenarioContract();

  // 1) 线索门禁：来自显式检定点。keys 即“未通过检定不得泄露”的线索词。
  const checkpoints = Array.isArray(source.scenarioCheckpoints) ? source.scenarioCheckpoints : [];
  checkpoints.forEach((checkpoint, index) => {
    const clueWords = (checkpoint?.keys ?? [])
      .map((word) => String(word).trim())
      .filter((word) => word.length >= 2 && word.length <= 12);
    if (clueWords.length === 0) return;
    contract.clueGates.push({
      id: `cg-${index + 1}`,
      title: String(checkpoint.trigger ?? checkpoint.id ?? ""),
      skill: String(checkpoint.skill ?? ""),
      gateCheckId: String(checkpoint.id ?? ""),
      clueWords,
      scene: String(checkpoint.scene ?? ""),
      revealWhen: checkpoint.skill === "理智" ? "sanityChecked" : "checkPassed",
    });
  });

  // 2) NPC 知识矩阵：为每个 NPC 建立骨架。unknown 留空（不知道不代表可以随便说，
  //    后续由 LLM/校对填入具体未知线索）。
  const entities = Array.isArray(source.entities) ? source.entities : [];
  entities
    .filter((entity) => entity?.type === "npc" && String(entity.name ?? "").trim().length > 0)
    .forEach((npc, index) => {
      contract.npcKnowledge.push({
        id: `nk-${index + 1}`,
        npcName: String(npc.name).trim(),
        npcIds: typeof npc.id === "string" && npc.id.length > 0 ? [npc.id] : [],
        knows: [],
        unknown: [],
      });
    });

  // 3) 仪式/关键事件前置条件：确定性草拟只做“最终仪式”兜底——当存在最终分支且
  //    能找到咒文/仪式关键点时，构造一条干净的前置条件（关键点已揭示 + 手稿/日记等
  //    物品已入栏）。不从原文逐句正则硬抠，避免把“引魂夜/巨眼/SAN”等剧情行误当仪式。
  const keyPoints = Array.isArray(source.keyPoints) ? source.keyPoints : [];

  // 4) 夜晚事件：默认 onSleep。夜晚事件与时钟不是严格绑定——调查员入睡后触发；
  //    调查员在该夜不入睡时按 sleepPolicy 处理（force=强制入睡/penalty=惩罚）。
  //    确定性草拟只保留“明确夜晚 + 夜间事件词 + 非剧透/非背景”的行，宁缺毋滥。
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    if (!NIGHT_TIME_RE.test(line)) return;
    if (!NIGHT_EVENT_VERB_RE.test(line)) return;
    if (NIGHT_EVENT_SPOILER_RE.test(line)) return;
    if (NIGHT_PAST_HABIT_RE.test(line)) return;
    contract.nightEvents.push({
      id: `ne-${contract.nightEvents.length + 1}`,
      title: line.slice(0, 40),
      scene: "",
      nightLabel: "",
      trigger: "onSleep",
      sleepPolicy: "force",
      penaltyText: "",
      effect: line,
      eventText: line,
    });
  });
  if (contract.nightEvents.length > 12) contract.nightEvents.length = 12;

  // 5) 最终分支白名单：从分支里识别“选项指向结局”的分支。
  //    requires 至少包含“拼出咒文/仪式”关键点与“分支已抵达”，并派生结局关键词。
  const branches = Array.isArray(source.branches) ? source.branches : [];
  const spellKeyPoint = keyPoints.find((keyPoint) => /咒文|仪式|拼凑|抉择/.test(String(keyPoint?.title ?? "")));
  branches.forEach((branch, index) => {
    const options = Array.isArray(branch?.options) ? branch.options : [];
    const endingOptions = options.filter((option) => /(?:结局|END|TE|BE|GE|TRUE)/i.test(String(option?.leadsTo ?? "")));
    if (endingOptions.length === 0) return;
    const requires = [];
    if (spellKeyPoint !== undefined) {
      requires.push({ kind: "keyPoint", value: String(spellKeyPoint.title) });
    }
    requires.push({ kind: "branchReached", value: String(branch.id ?? "") });
    const endingKeywords = endingOptions
      .map((option) =>
        String(option.leadsTo ?? "")
          .replace(/(?:的)?(?:坏|好|真|假)?结局$|END$/i, "")
          .trim()
      )
      .filter((keyword) => keyword.length >= 2);
    contract.finalBranchWhitelist.push({
      id: `fb-${index + 1}`,
      branchId: String(branch.id ?? ""),
      endingId: endingOptions.map((option) => String(option.leadsTo)).join("/"),
      requires,
      endingKeywords,
    });
  });

  // 兜底仪式条件：有最终分支但原文没有可直接提取的前置项时，
  // 从关键点（咒文）与物品实体（手稿/日记）构造最终仪式前置。
  if (contract.ritualConditions.length === 0 && contract.finalBranchWhitelist.length > 0 && spellKeyPoint !== undefined) {
    const requires = [];
    requires.push({ kind: "keyPoint", value: String(spellKeyPoint.title) });
    const itemEntities = entities.filter((entity) => entity?.type === "item" && String(entity.name ?? "").length > 0);
    for (const item of itemEntities) {
      const name = String(item.name);
      if (/手稿|日记|咒文|书|稿|法器|祭品/.test(name)) {
        requires.push({ kind: "item", value: name });
      }
    }
    contract.ritualConditions.push({
      id: "rc-final-ritual",
      name: `最终仪式（${String(spellKeyPoint.title)}）`,
      keywords: ["咒文", "念诵", "念出", "仪式", "请神", "送神", "降临", "墨渊消散", "夏拉卡拉布"],
      requires,
    });
  }

  return normalizeScenarioContract(contract);
}

/**
 * 草拟后合并到既有契约：保留已校对条目，只补缺失类别。
 * @param {object} existingContract
 * @param {object} flat
 * @returns {object}
 */
export function ensureScenarioContract(existingContract, flat) {
  const current = normalizeScenarioContract(existingContract);
  const drafted = draftScenarioContract(flat);
  return normalizeScenarioContract({
    version: current.version,
    status: current.status,
    source: current.source,
    reviewed: current.reviewed,
    clueGates: current.clueGates.length > 0 ? current.clueGates : drafted.clueGates,
    npcKnowledge: current.npcKnowledge.length > 0 ? current.npcKnowledge : drafted.npcKnowledge,
    ritualConditions: current.ritualConditions.length > 0 ? current.ritualConditions : drafted.ritualConditions,
    nightEvents: current.nightEvents.length > 0 ? current.nightEvents : drafted.nightEvents,
    finalBranchWhitelist: current.finalBranchWhitelist.length > 0 ? current.finalBranchWhitelist : drafted.finalBranchWhitelist,
  });
}

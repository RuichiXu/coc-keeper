/**
 * Scenario Contract 草拟（确定性规则提取）
 *
 * 剧本导入后，从 flat 已有的结构化数据（scenarioCheckpoints/entities/branches）
 * 与剧本原文中，确定性草拟 scenarioContract，供 KP 校对。
 *
 * 规则为主、LLM 校对/兜底由后续导入流程完成。纯函数，零 DSH 依赖。
 */
import { createScenarioContract, normalizeScenarioContract } from "./contract.js";
import { classifyFloor } from "./scene-facts.js";

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

  // 3) 仪式/关键事件前置条件：从原文中识别“需要/必须/须”句。
  const ritualPattern = /([^。！？\n]{0,40}(?:仪式|召唤|献祭|降灵|通神|附身)[^。！？\n]{0,40})/g;
  let ritualMatch;
  let ritualIndex = 0;
  while ((ritualMatch = ritualPattern.exec(text)) !== null) {
    const sentence = ritualMatch[1].trim();
    if (sentence.length < 4) continue;
    ritualIndex += 1;
    const requires = [];
    for (const item of sentence.matchAll(/(?:需要|必须|须有|须以|要用|用到)([^，。；、！？]{1,16})/g)) {
      const value = String(item[1]).trim();
      if (value.length >= 2) requires.push({ kind: "item", value });
    }
    contract.ritualConditions.push({
      id: `rc-${ritualIndex}`,
      name: sentence.slice(0, 40),
      keywords: ["仪式", "召唤", "献祭", "降灵", "通神", "附身"].filter((word) => sentence.includes(word)),
      requires,
    });
  }

  // 4) 夜晚事件：默认 onSleep。夜晚事件与时钟不是严格绑定——调查员入睡后触发；
  //    调查员在该夜不入睡时按 sleepPolicy 处理（force=强制入睡/penalty=惩罚）。
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    const isNightLine = /(?:夜|午夜|子夜|凌晨|入睡|睡着|就寝|梦游|梦中|睡眠)/.test(line);
    if (!isNightLine) return;
    const hasEventWord = /(?:触发|发生|出现|惊醒|醒来|哭声|拍门|挠门|呓语|梦游|梦中|门外|走廊|楼梯|响动|异响|鬼影|墨渊|影子|低语)/.test(line);
    if (!hasEventWord) return;
    contract.nightEvents.push({
      id: `ne-${contract.nightEvents.length + 1}`,
      title: line.slice(0, 40),
      scene: classifyFloor(line, line),
      nightLabel: "",
      trigger: "onSleep",
      sleepPolicy: "force",
      penaltyText: "",
      effect: line,
      eventText: line,
    });
  });

  // 5) 最终分支白名单：从分支里识别“选项指向结局”的分支。
  const branches = Array.isArray(source.branches) ? source.branches : [];
  branches.forEach((branch, index) => {
    const options = Array.isArray(branch?.options) ? branch.options : [];
    const endingOptions = options.filter((option) => /(?:结局|END|TE|BE|GE|TRUE)/i.test(String(option?.leadsTo ?? "")));
    if (endingOptions.length === 0) return;
    contract.finalBranchWhitelist.push({
      id: `fb-${index + 1}`,
      branchId: String(branch.id ?? ""),
      endingId: endingOptions.map((option) => String(option.leadsTo)).join("/"),
      requires: [],
    });
  });

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
    clueGates: current.clueGates.length > 0 ? current.clueGates : drafted.clueGates,
    npcKnowledge: current.npcKnowledge.length > 0 ? current.npcKnowledge : drafted.npcKnowledge,
    ritualConditions: current.ritualConditions.length > 0 ? current.ritualConditions : drafted.ritualConditions,
    nightEvents: current.nightEvents.length > 0 ? current.nightEvents : drafted.nightEvents,
    finalBranchWhitelist: current.finalBranchWhitelist.length > 0 ? current.finalBranchWhitelist : drafted.finalBranchWhitelist,
  });
}

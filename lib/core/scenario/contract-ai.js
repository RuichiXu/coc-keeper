/**
 * Scenario Contract AI 生成（Prompt + 解析）
 *
 * 剧本导入时用 LLM 从原文生成契约 JSON；KP 校对确认后才作为强制契约使用。
 * 纯函数，零 DSH 依赖，不直接调用 LLM。
 */
import { normalizeScenarioContract, validateScenarioContract } from "./contract.js";

/**
 * 构建契约生成 Prompt。
 * @param {object} flat - { scenario:{text,name}, scenarioCheckpoints?, entities?, branches?, keyPoints? }
 * @returns {string}
 */
export function buildContractAiPrompt(flat) {
  const text = String(flat?.scenario?.text ?? "");
  const name = String(flat?.scenario?.name ?? "剧本");
  const checkpoints = Array.isArray(flat?.scenarioCheckpoints) ? flat.scenarioCheckpoints : [];
  const entities = Array.isArray(flat?.entities) ? flat.entities : [];
  const branches = Array.isArray(flat?.branches) ? flat.branches : [];
  const keyPoints = Array.isArray(flat?.keyPoints) ? flat.keyPoints : [];

  const grounded = {
    checkpoints: checkpoints.map((item) => ({
      id: item.id ?? "",
      skill: item.skill ?? "",
      trigger: item.trigger ?? "",
      keys: item.keys ?? [],
      scene: item.scene ?? "",
    })),
    entities: entities
      .filter((entity) => entity?.type === "npc")
      .map((entity) => ({ id: entity.id ?? "", name: entity.name ?? "", desc: entity.desc ?? "" })),
    branches: branches.map((branch) => ({
      id: branch.id ?? "",
      title: branch.title ?? "",
      options: (branch.options ?? []).map((option) => option.label ?? ""),
    })),
    keyPoints: keyPoints.map((keyPoint) => ({ id: keyPoint.id ?? "", title: keyPoint.title ?? "", desc: keyPoint.desc ?? "" })),
  };

  return [
    `你是 CoC 跑团剧本的规则结构化专家。请阅读剧本《${name}》的原文，输出该剧本的「执行契约」JSON。`,
    ``,
    `只输出一个 JSON 对象（不要 Markdown 代码块），结构如下：`,
    `{`,
    `  "clueGates": [{"id":"cg-1","title":"线索门禁名","skill":"侦查","gateCheckId":"chk-1","clueWords":["墨渊"],"protectedText":"","scene":"三层：书房","revealWhen":"checkPassed"}],`,
    `  "npcKnowledge": [{"id":"nk-1","npcName":"克罗斯","knows":["手稿"],"unknown":["墨渊"]}],`,
    `  "ritualConditions": [{"id":"rc-1","name":"召回仪式","keywords":["召回仪式","吟唱"],"requires":[{"kind":"item","value":"手稿"},{"kind":"location","value":"书房"},{"kind":"time","value":"午夜"},{"kind":"participant","value":"伊芙琳"},{"kind":"clue","value":"咒文"}]}],`,
    `  "nightEvents": [{"id":"ne-1","title":"午夜梦游","scene":"三层","nightLabel":"午夜","trigger":"onSleep","sleepPolicy":"force","penaltyText":"","effect":"门外响起哭声"}],`,
    `  "finalBranchWhitelist": [{"id":"fb-1","branchId":"br-1","endingId":"结局1","requires":[{"kind":"clue","value":"咒文"}]}]`,
    `}`,
    ``,
    `字段说明与约束：`,
    `- clueGates：线索门禁。clueWords 是「对应检定未通过前 KP 叙述不得说出的受保护词」；skill 为空表示纯剧情门禁。`,
    `- revealWhen：checkPassed（对应检定通过后放行）/ sanityChecked（理智暗骰后放行）/ none（永不自动放行）。`,
    `- npcKnowledge：NPC 知识边界。knows 是该 NPC 可以主动说出的信息；unknown 是该 NPC 不应知晓/不应说出的信息（写成具体线索词）。`,
    `- ritualConditions：仪式/关键事件前置条件。keywords 是叙述中出现即触发校验的词；requires 逐项列出 kind/value。`,
    `- nightEvents：夜晚事件。trigger=onSleep 表示“调查员入睡后触发”，trigger=onTime 才按 nightLabel 匹配游戏内时间。`,
    `- sleepPolicy：force=调查员该夜不入睡时 KP 强制入睡或给大惩罚；penalty=给惩罚；allow=允许不睡不触发。`,
    `- finalBranchWhitelist：最终分支白名单。只有列出的 branchId 允许推进到对应 endingId；requires 为抵达该结局必须满足的条件。`,
    ``,
    `重要：夜晚事件与时钟不是严格绑定。默认一律用 trigger=onSleep；只有剧本明确写“XX 时刻发生”的才用 onTime 并填 nightLabel。`,
    ``,
    `剧本结构化参考（已有草拟，供你校正）：`,
    JSON.stringify(grounded, null, 2),
    ``,
    `剧本原文：`,
    text.slice(0, 30000),
  ].join("\n");
}

/**
 * 解析 LLM 返回的契约 JSON。
 * @param {string} rawText
 * @returns {{ contract: object, issues: string[], raw: string }}
 */
export function parseContractAiResult(rawText) {
  let source = String(rawText ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fenced) source = fenced[1];
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { contract: null, issues: ["LLM 返回中没有 JSON 对象"], raw: source.slice(0, 400) };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    return { contract: null, issues: [`JSON 解析失败：${error.message}`], raw: source.slice(0, 400) };
  }
  const contract = normalizeScenarioContract(parsed);
  const issues = validateScenarioContract(parsed);
  return { contract, issues, raw: source.slice(0, 400) };
}

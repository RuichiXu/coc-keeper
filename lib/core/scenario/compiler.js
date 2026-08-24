/**
 * Scenario Compiler
 *
 * 将剧本原始文本解析为 ScenarioModel（IR）。
 *
 * 两层解析：
 * 1. 快速模式匹配（draftStructure）：正则匹配【场景】/【NPC】/【关键剧情点】等标记
 * 2. LLM 智能解析（aiDraftStructure）：调用 LLM 提取结构化 JSON
 *
 * 编译结果合并为 ScenarioModel。
 */

import { createScenarioModel } from "./model.js";

// ── 开场导入提取 ──────────────────────────────────────────

/**
 * 从剧本正文中提取“故事导入 / 开始冒险”部分，供开场白生成使用。
 *
 * 优先匹配表示冒险开始的独立标题行（“开始冒险 / 冒险开始 / 故事开始 / 导入 / 开场 …”），
 * 取其后的一段正文；找不到标题时，退回匹配“调查员/你们 从/在/来到/收到…”这类故事起始句。
 * 纯函数：输入原始剧本，输出适合喂给开场白 LLM 的导入片段。
 *
 * @param {string} text - 剧本全文
 * @param {number} [maxLength=1600] - 最大返回字符数
 * @returns {string}
 */
export function extractStoryIntro(text, maxLength = 1600) {
  const source = String(text ?? "");
  if (source.trim().length === 0) return "";

  const lines = source.split(/\r?\n/);
  const anchorPattern = /^\s*(?:开始冒险|冒险开始|故事开始|故事导入|导入部分|导入|开场|剧情开始|序章)[：:]?\s*$/i;
  let startLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (anchorPattern.test(lines[i])) {
      startLine = i + 1;
      break;
    }
  }

  if (startLine === -1) {
    // 退而求其次：找到第一句像故事开头的话（“调查员从自己的住处醒来”等）
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^(?:调查员们?|你们|你)(?:从|在|来到|走进|接到|收到|醒来|站在|坐在|抵达)/.test(line)) {
        startLine = i;
        break;
      }
    }
  }

  if (startLine === -1) return "";

  // 跳过锚点后的空行，但保留子标题（如“来自侄女的委托：”）——它有助于 LLM 理解导入类型
  while (startLine < lines.length && lines[startLine].trim().length === 0) {
    startLine++;
  }
  if (startLine >= lines.length) return "";

  // 在“正文已收集到一定量”之后，遇到独立的短标题行（如“惴惴不安的宅邸主人：”）即停止，
  // 避免把后续探索章节（一层/二层/三层）也喂给开场白。
  const headingStopPattern = /^[^。；！？：:\n（）()]{1,20}[：:]\s*$/;
  const out = [];
  let collected = 0;
  let isFirst = true;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (!isFirst && collected > 30 && line.length <= 20 && headingStopPattern.test(line)) {
      break;
    }
    out.push(line);
    collected += line.length;
    isFirst = false;
    if (collected >= maxLength) break;
  }
  return out.join("\n").trim();
}

// ── 快速模式匹配 ──────────────────────────────────────────

/**
 * 用正则匹配剧本文本中的结构标记，提取场景、NPC、地点、物品、关键剧情点、分支。
 * 这是旧 draftStructure 的升级版，输出更接近 ScenarioModel。
 *
 * @param {string} text
 * @param {string} scenarioName
 * @returns {object} ScenarioModel 的部分字段
 */
export function compileByPattern(text, scenarioName) {
  const model = createScenarioModel(scenarioName);
  let currentScene = "";

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    // 场景
    const sceneMatch = /^(?:【场景】|场景|SCENE)[：:\s]*(\d*)[：:\s]*(.*)$/i.exec(line);
    if (sceneMatch && (sceneMatch[1] || sceneMatch[2])) {
      const name = sceneMatch[2] || `场景 ${sceneMatch[1]}`;
      currentScene = name;
      model.scenes.push({
        id: `scene-${model.scenes.length + 1}`,
        name,
        description: "",
        npcIds: [],
        itemIds: [],
        locationIds: [],
        clueIds: [],
        plotNodeIds: [],
        ambientEvents: [],
      });
      continue;
    }

    // 关键剧情点
    const kpMatch = /^(?:【关键剧情点】|关键剧情点|关键点|剧情点|KEY ?POINT)[：:\s]*(\S.+)$/i.exec(line);
    if (kpMatch) {
      model.plotNodes.push({
        id: `pn-${model.plotNodes.length + 1}`,
        title: kpMatch[1].trim(),
        description: "",
        type: "event",
        preconditions: [],
        leadsTo: [],
        scene: currentScene,
      });
      continue;
    }

    // 分支
    const brMatch = /^(?:【剧情分支】|【分支】|剧情分支|分支|选择点|BRANCH)[：:\s]*(\S.+)$/i.exec(line);
    if (brMatch) {
      model.branches.push({
        id: `br-${model.branches.length + 1}`,
        title: brMatch[1].trim(),
        scene: currentScene,
        description: "",
        options: [],
      });
      continue;
    }

    // NPC
    const npcMatch = /^(?:【NPC】|【人物】|NPC|人物)[：:\s]*(\S.+)$/i.exec(line);
    if (npcMatch) {
      model.npcs.push({
        id: `npc-${model.npcs.length + 1}`,
        name: npcMatch[1].trim(),
        role: "minor",
        description: "",
        motivation: "",
        secrets: [],
        clueIds: [],
        initialAttitude: "neutral",
        scenes: currentScene ? [currentScene] : [],
      });
      continue;
    }

    // 地点
    const locMatch = /^(?:【地点】|地点|场所)[：:\s]*(\S.+)$/i.exec(line);
    if (locMatch) {
      model.locations.push({
        id: `loc-${model.locations.length + 1}`,
        name: locMatch[1].trim(),
        description: "",
        connectedTo: [],
        itemIds: [],
        npcIds: [],
      });
      continue;
    }

    // 物品
    const itemMatch = /^(?:【物品】|【道具】|物品|道具)[：:\s]*(\S.+)$/i.exec(line);
    if (itemMatch) {
      model.items.push({
        id: `item-${model.items.length + 1}`,
        name: itemMatch[1].trim(),
        type: "other",
        description: "",
        clueIds: [],
        locationIds: currentScene ? [currentScene] : [],
        isCritical: false,
      });
      continue;
    }
  }

  return model;
}

// ── LLM 智能解析 ──────────────────────────────────────────

/**
 * 构建 LLM 解析用的 prompt。
 * 要求 LLM 返回符合 ScenarioModel 结构的 JSON。
 *
 * @param {string} text - 剧本原文（截取前 8000 字符）
 * @returns {string} prompt
 */
export function buildAiParsePrompt(text) {
  return `你是一个克苏鲁的呼唤跑团剧本分析助手。请分析以下剧本内容，提取出结构化的游戏元素。

请严格按照以下 JSON 格式返回（不要加 Markdown 代码块标记，直接返回纯 JSON）：

{
  "scenes": [
    { "name": "场景名", "description": "场景描述" }
  ],
  "npcs": [
    { "name": "NPC名", "role": "major|minor|background", "description": "描述", "motivation": "动机", "secrets": ["秘密1"], "initialAttitude": "neutral|friendly|hostile" }
  ],
  "items": [
    { "name": "物品名", "type": "clue-item|weapon|tool|document|artifact|other", "description": "描述", "isCritical": false }
  ],
  "locations": [
    { "name": "地点名", "description": "描述" }
  ],
  "clues": [
    { "description": "线索内容", "acquisitionMethods": ["侦查", "聆听"], "isCritical": false, "category": "physical|testimonial|documentary|deductive" }
  ],
  "plotNodes": [
    { "title": "节点标题", "type": "scene|event|revelation|confrontation|climax", "description": "描述", "preconditions": [], "scene": "所属场景" }
  ],
  "branches": [
    { "title": "分支标题", "scene": "所属场景", "description": "描述", "options": [{ "label": "选项1", "leadsTo": "导向场景", "consequences": [] }] }
  ],
  "triggers": [
    { "condition": "触发条件", "conditionType": "flag|time|entity_state|clue|scene", "conditionValue": "值", "action": "动作描述" }
  ],
  "endings": [
    { "title": "结局标题", "type": "true|good|mixed|bad|catastrophic", "description": "描述", "requirements": [], "blockers": [] }
  ],
  "hiddenFacts": [
    { "fact": "秘密事实", "category": "secret|mythos|backstory|twist" }
  ]
}

要求：
1. 如果某个分类没有内容，返回空数组 []
2. 所有字段用中文
3. 不要返回任何额外文字，只返回 JSON
4. clues 尽可能详细，每个线索至少标注获取方式
5. plotNodes 描述剧情推进的关键节点，标注前置条件

剧本内容：
${text.slice(0, 8000)}`;
}

/**
 * 将 LLM 返回的 JSON 解析为 ScenarioModel 字段。
 *
 * @param {object} parsed - LLM 返回的 JSON 对象
 * @param {string} scenarioName
 * @returns {object} ScenarioModel 的部分字段
 */
export function parseAiResult(parsed, scenarioName) {
  const model = createScenarioModel(scenarioName);

  const prefix = (type, i) => `${type}-${i + 1}`;

  model.scenes = (parsed.scenes || []).map((s, i) => ({
    id: `scene-ai-${i + 1}`,
    name: s.name || "未命名",
    description: s.description || "",
    npcIds: [],
    itemIds: [],
    locationIds: [],
    clueIds: [],
    plotNodeIds: [],
    ambientEvents: [],
  }));

  model.npcs = (parsed.npcs || []).map((n, i) => ({
    id: `npc-ai-${i + 1}`,
    name: n.name || "未命名",
    role: n.role || "minor",
    description: n.description || "",
    motivation: n.motivation || "",
    secrets: n.secrets || [],
    clueIds: [],
    initialAttitude: n.initialAttitude || "neutral",
    scenes: [],
  }));

  model.items = (parsed.items || []).map((it, i) => ({
    id: `item-ai-${i + 1}`,
    name: it.name || "未命名",
    type: it.type || "other",
    description: it.description || "",
    clueIds: [],
    locationIds: [],
    isCritical: it.isCritical === true,
  }));

  model.locations = (parsed.locations || []).map((l, i) => ({
    id: `loc-ai-${i + 1}`,
    name: l.name || "未命名",
    description: l.description || "",
    connectedTo: [],
    itemIds: [],
    npcIds: [],
  }));

  model.clues = (parsed.clues || []).map((c, i) => ({
    id: `clue-${i + 1}`,
    description: c.description || "未描述",
    acquisitionMethods: c.acquisitionMethods || [],
    relatedEntityIds: [],
    leadsTo: [],
    fallbackMethods: [],
    isCritical: c.isCritical === true,
    category: c.category || "physical",
  }));

  model.plotNodes = (parsed.plotNodes || []).map((pn, i) => ({
    id: `pn-ai-${i + 1}`,
    title: pn.title || "未命名",
    description: pn.description || "",
    type: pn.type || "event",
    preconditions: pn.preconditions || [],
    leadsTo: [],
    scene: pn.scene || "",
  }));

  model.branches = (parsed.branches || []).map((br, i) => ({
    id: `br-ai-${i + 1}`,
    title: br.title || "未命名",
    scene: br.scene || "",
    description: br.description || "",
    options: (br.options || []).map((o) => ({
      label: o.label || "继续",
      leadsTo: o.leadsTo || "",
      consequences: o.consequences || [],
    })),
  }));

  model.triggers = (parsed.triggers || []).map((t, i) => ({
    id: `trg-${i + 1}`,
    condition: t.condition || "",
    conditionType: t.conditionType || "flag",
    conditionValue: t.conditionValue || "",
    action: t.action || "",
    actionTarget: "",
  }));

  model.endings = (parsed.endings || []).map((e, i) => ({
    id: `end-${i + 1}`,
    title: e.title || "未命名",
    type: e.type || "mixed",
    description: e.description || "",
    requirements: e.requirements || [],
    blockers: e.blockers || [],
  }));

  model.hiddenFacts = (parsed.hiddenFacts || []).map((h, i) => ({
    id: `fact-${i + 1}`,
    fact: h.fact || "",
    category: h.category || "secret",
    revealedBy: [],
    isRevealed: false,
  }));

  return model;
}

// ── 合并 ──────────────────────────────────────────────────

/**
 * 合并两个 ScenarioModel（pattern 优先，AI 补充）。
 * pattern 的结果作为基础，AI 的结果补充 pattern 没有的字段。
 *
 * @param {object} patternModel
 * @param {object} aiModel
 * @returns {object}
 */
export function mergeModels(patternModel, aiModel) {
  const merged = createScenarioModel(patternModel.name || aiModel.name);

  // 优先使用 AI 结果（更丰富），回退到 pattern 结果
  merged.scenes = aiModel.scenes.length > 0 ? aiModel.scenes : patternModel.scenes;
  merged.npcs = aiModel.npcs.length > 0 ? aiModel.npcs : patternModel.npcs;
  merged.items = aiModel.items.length > 0 ? aiModel.items : patternModel.items;
  merged.locations = aiModel.locations.length > 0 ? aiModel.locations : patternModel.locations;
  merged.clues = aiModel.clues.length > 0 ? aiModel.clues : patternModel.clues;
  merged.plotNodes = aiModel.plotNodes.length > 0 ? aiModel.plotNodes : patternModel.plotNodes;
  merged.branches = aiModel.branches.length > 0 ? aiModel.branches : patternModel.branches;
  merged.triggers = aiModel.triggers.length > 0 ? aiModel.triggers : patternModel.triggers;
  merged.endings = aiModel.endings.length > 0 ? aiModel.endings : patternModel.endings;
  merged.hiddenFacts = aiModel.hiddenFacts.length > 0 ? aiModel.hiddenFacts : patternModel.hiddenFacts;

  return merged;
}

/**
 * 将 ScenarioModel 转为旧格式的 keyPoints/branches/entities（兼容旧接口）。
 *
 * @param {object} model
 * @returns {{ keyPoints: Array<object>, branches: Array<object>, entities: Array<object> }}
 */
export function toLegacyFormat(model) {
  const keyPoints = model.plotNodes.map((pn) => ({
    id: pn.id,
    scene: pn.scene,
    title: pn.title,
    desc: pn.description,
    revealed: false,
    scenarioId: model.name,
  }));

  const branches = model.branches.map((br) => ({
    id: br.id,
    scene: br.scene,
    title: br.title,
    desc: br.description,
    options: br.options.map((o) => ({ label: o.label, leadsTo: o.leadsTo })),
    reached: false,
    chosen: null,
    scenarioId: model.name,
  }));

  const entities = [
    ...model.npcs.map((n) => ({
      id: n.id,
      type: "npc",
      name: n.name,
      desc: n.description,
      state: n.initialAttitude || "",
      scene: n.scenes?.[0] || "",
      scenarioId: model.name,
    })),
    ...model.locations.map((l) => ({
      id: l.id,
      type: "location",
      name: l.name,
      desc: l.description,
      state: "",
      scene: "",
      scenarioId: model.name,
    })),
    ...model.items.map((it) => ({
      id: it.id,
      type: "item",
      name: it.name,
      desc: it.description,
      state: "",
      scene: it.locationIds?.[0] || "",
      scenarioId: model.name,
    })),
  ];

  return { keyPoints, branches, entities };
}
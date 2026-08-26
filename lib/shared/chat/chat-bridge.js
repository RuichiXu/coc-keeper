/**
 * 面板聊天桥（KP 迷你循环：LLM + coc 新工具调用）
 *
 * Step 4：从 legacy-index.js 迁移而来，内部使用 adapter 新工具（Core → Event → State）。
 * 状态读写统一通过 deps.persistence；每轮工具执行后同步 GameSession 并保存 core。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildKpSystemPrompt,
  buildLoopMessages,
  extractCheckpoints,
  extractSceneFacts,
  findRoomFloorConflict,
  inferSceneFromText,
  selectSceneFacts,
  parseAssistantBlocks,
  decideNext,
  buildAssistantContent,
  buildToolResultMessages,
  parseToolArguments,
  formatNarration,
  isBusyStale,
  summarizeReachability,
  ensureScenarioContract,
} from "../../core/index.js";
import { commitSession, nextId, nowIso, rollEvent } from "../tools/helpers.js";
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
  matchActionToGates,
  mergeCheckGates,
  resolvePendingChoice,
} from "./check-gates.js";
import { validateNarrationCandidate } from "./narration-guard.js";
import { evaluateNightEvents, validateCandidateNarration } from "./scenario-contract-validator.js";

// ── 状态摘要 ──────────────────────────────────────────────

export function stateDigest(state) {
  return {
    id: state.id,
    title: state.title,
    kpMode: state.kpMode,
    currentScene: state.currentScene,
    currentBranchId: state.currentBranchId,
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
  };
}

// ── 确定性状态落地（关键点/物品）：不依赖 LLM 自觉调用工具 ──

const KEYPOINT_ACTION_PREFIXES = [
  "发现", "获得", "得到", "进入", "找到", "目睹", "拼凑", "调查",
  "看到", "听见", "触发", "完成", "解读", "解开", "打开", "来到", "抵达",
];

/**
 * 关键点标题变体：去掉常见动作前缀（“发现墨渊”→“墨渊”）。
 * @param {string} title
 * @returns {string[]}
 */
export function keypointTitleVariants(title) {
  const source = String(title ?? "").trim();
  const variants = new Set([source]);
  for (const prefix of KEYPOINT_ACTION_PREFIXES) {
    if (source.startsWith(prefix)) {
      const stripped = source.slice(prefix.length).trim();
      if (stripped.length >= 2) variants.add(stripped);
    }
  }
  return [...variants];
}

/**
 * 判断叙述是否命中关键点标题（含动作前缀剥离 + “A与B”拆分后全部出现）。
 * @param {string} title
 * @param {string} text
 * @returns {boolean}
 */
export function keypointTitleMatched(title, text) {
  const source = String(text ?? "");
  for (const variant of keypointTitleVariants(title)) {
    if (variant.length >= 2 && source.includes(variant)) return true;
    const terms = variant
      .split(/与|和|、|及|以及/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length > 1 && terms.every((term) => source.includes(term))) return true;
  }
  return false;
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
    if (title.length >= 2 && keypointTitleMatched(title, text)) {
      kp.revealed = true;
      changed += 1;
    }
  }
  return changed;
}

const ITEM_QUANTIFIER_RE =
  /[一二三四五六七八九十两数几]+[张页份本个叠串枚部台柄根盏支把件]+/g;
const ITEM_QUANTIFIER_TEST_RE =
  /[一二三四五六七八九十两数几]+[张页份本个叠串枚部台柄根盏支把件]+/;
const ITEM_ACQUIRE_RE =
  /(?:拿起|带上|取得|拿到|获得|得到|取出|掏出|拾起|捡起|带走|收起|揣进|装进|装入|收进|放进|放入|收好|携带|随身携带|挎上|提上|拿上|握上|抱上|系上|挂上|别上|放进背包|放入包内|塞进|接过|借到)了?(?:那|这)?(?:[一二三四五六七八九十两数几]+[张份本个叠串枚部台柄根盏支把件])?([^，。；、！？\n]{1,12})/g;
const ITEM_BA_RE =
  /(?:把|将)([^，。；、！？\n]{1,12}?)(?:随身携带|携带|挎在|挎上|挂在|挂上|系在|系上|提在|提上|拿在|握在|抱在|别在|背在|收入|收进|收好|装入|装进|放进|放入|带上|带走|拿起|取出|塞进|塞入|揣进)/g;
// 状态式持有：“结实麻绳盘好斜挎过肩”→ 物品在状态动词之前。
const ITEM_STATE_CARRY_RE =
  /([^，。；、！？\n]{1,12}?)(?:斜挎过肩|斜挎在肩|挎过肩|缠在腰间|盘在腰间|系在腰间|别在腰间|斜挎)/g;
// 容器内容：“装有四张原稿的文件夹”→ 物品是容器里装的东西。
const ITEM_CONTAINED_RE =
  /(?:装有|装着|放着|塞着)([^，。；、！？\n的]{1,12})的(?:文件夹|袋子|背包|箱子|盒子|匣子|信封|皮包|挎包)/g;
const ITEM_ABSTRACT_DENY = /信任|线索|消息|结论|进展|真相|机会|灵感|情报|优势|先机|头绪|眉目|主动权|把握|风声|口风|情况|状况|动静|味道|气味/;
const ITEM_CONTAINER_DENY = /文件夹|证物袋|纸袋|背包|包内|口袋|衣袋|裤袋|箱子|盒子|抽屉|柜子|书柜|壁橱|行囊|挎包|皮包|提包|匣子/;
const ITEM_PARTICLE_DENY = /从|往|在|被|将|把|它|熟悉|位置/;
const ITEM_ALIASES = { 原稿: "手稿", 稿纸: "手稿", 稿件: "手稿" };

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
  item = item.replace(/^(?:那|这)/, "");
  item = item.replace(/(?:递给|交给|放到|放在|塞到|塞进|递了|给了|拿给)[^，。；、！？]{0,8}$/, "");
  item = item.replace(/(?:按顺序|依次|小心地|轻轻地|慢慢|全部|一起|统统|都|整齐地|盘好|盘着|卷好|卷着|折好|折着|斜挎|过肩)$/, "");
  item = item.replace(/[，。；、！？\s]+$/g, "");
  if (item.length < 2 || item.length > 12) return null;
  if (ITEM_ABSTRACT_DENY.test(item)) return null;
  if (ITEM_CONTAINER_DENY.test(item)) return null;
  if (ITEM_PARTICLE_DENY.test(item)) return null;
  return ITEM_ALIASES[item] ?? item;
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
    const cleaned = inventory.filter((item) => !isJunkAutoItem(item));
    if (cleaned.length !== inventory.length) {
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
  for (const item of candidates) {
    // 已存在同物时跳过；长名条目（“结实麻绳（船用缆绳，盘好斜挎）”）包含短名也算已存在。
    const alreadyHas = inventory.some(
      (entry) => entry === item || entry.includes(item) || item.includes(entry)
    );
    if (alreadyHas) continue;
    inventory.push(item);
    added.push(item);
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

// ── LLM 调用 ──────────────────────────────────────────────

function loadLlmConfig(dataDir) {
  const configFile = join(dataDir, "config.json");
  try {
    if (existsSync(configFile)) return JSON.parse(readFileSync(configFile, "utf8"));
  } catch { /* ignore */ }
  return {};
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function toOpenAiMessages(messages, system) {
  const out = [];
  if (typeof system === "string" && system.trim().length > 0) {
    out.push({ role: "system", content: system });
  }
  for (const message of messages ?? []) {
    const toolResult = (message.content ?? []).find(
      (block) => block?.type === "tool-result"
    );
    if (toolResult !== undefined) {
      out.push({
        role: "tool",
        tool_call_id:
          toolResult.toolCallId ?? message.source?.callId ?? "tool-call",
        content: textOf(toolResult.content),
      });
      continue;
    }

    const calls = (message.content ?? []).filter(
      (block) => block?.type === "tool-call"
    );
    const converted = {
      role: message.role === "assistant" ? "assistant" : "user",
      content: textOf(message.content) || (calls.length > 0 ? null : ""),
    };
    if (calls.length > 0) {
      converted.tool_calls = calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments:
            typeof call.arguments === "string"
              ? call.arguments
              : JSON.stringify(call.arguments ?? {}),
        },
      }));
    }
    out.push(converted);
  }
  return out;
}

function toJsonSchema(parameters) {
  if (parameters?.type === "object") return parameters;
  const properties = {};
  const required = [];
  for (const [name, raw] of Object.entries(parameters ?? {})) {
    const { required: isRequired, ...schema } = raw ?? {};
    properties[name] = schema;
    if (isRequired === true) required.push(name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export async function callLlmApi(dataDir, messages, options = {}) {
  const cfg = loadLlmConfig(dataDir);
  const provider = cfg.llmProvider || process.env.COC_LLM_PROVIDER || "deepseek";
  const apiKey = cfg.apiKey || process.env.COC_API_KEY || "";
  const model = cfg.llmModel || process.env.COC_LLM_MODEL || "deepseek-chat";
  const baseUrl =
    cfg.apiBaseUrl ||
    process.env.COC_LLM_BASE_URL ||
    process.env.COC_API_BASE_URL ||
    "";

  let url = baseUrl;
  if (!url) {
    if (provider === "deepseek") url = "https://api.deepseek.com/v1/chat/completions";
    else if (provider === "openai" || provider === "openai-compatible") url = "https://api.openai.com/v1/chat/completions";
    else url = "https://api.deepseek.com/v1/chat/completions";
  }
  if (!apiKey) throw new Error("未配置 API Key，请在设置面板中填写");

  const request = {
    model,
    messages: toOpenAiMessages(messages, options.system),
    temperature: options.temperature ?? 0.3,
    max_tokens: options.max_tokens ?? 4096,
    stream: false,
  };
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    request.tools = options.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toJsonSchema(tool.parameters),
      },
    }));
    request.tool_choice = "auto";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const rawError = await response.text().catch(() => "");
    const errText =
      apiKey.length > 0 ? rawError.split(apiKey).join("[REDACTED]") : rawError;
    throw new Error("LLM API 错误 " + response.status + ": " + errText.slice(0, 200));
  }
  const json = await response.json();
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const blocks = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: "tool-call",
      id: call.id,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    });
  }
  return {
    blocks,
    finish: { kind: choice.finish_reason ?? "complete" },
    usage: json.usage || {},
  };
}

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

  const syncSession = (flat) => {
    deps.session.id = flat.id ?? "default";
    deps.session.syncFromFlat(flat);
    deps.session.hydrateCore(flat.core);
  };

  const saveFlat = (gameId, flat) => {
    syncSession(flat);
    flat.core = deps.session.toJSON();
    flat.updatedAt = nowIso();
    deps.persistence.save(deps.stateKey(gameId), flat);
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

    for (; rounds < deps.maxChatRounds; rounds += 1) {
      const response = await streamBlocks({
        system: buildKpSystemPrompt({ ...flat, endingStatus: summarizeReachability(deps.session.plot) }),
        messages,
        tools: CHAT_KP_TOOLS.flatMap((toolName) => {
          const def = deps.toolDefs.get(toolName);
          return def === undefined
            ? []
            : [{ name: def.name, description: def.description, parameters: def.parameters }];
        }),
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
        if (text.trim().length === 0) {
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
      }
      if (calls.some((call) => ROLL_TOOL_NAMES.has(call.name))) calledRollTool = true;
      for (const call of calls) {
        if (ROLL_TOOL_NAMES.has(call.name) && !rollToolCalls.includes(call.name)) {
          rollToolCalls.push(call.name);
        }
      }
      messages.push(...buildToolResultMessages(calls, outcomes));

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

    return { narration, lastFinish, rounds, pendingChecks, calledRollTool, toolChecks, rollToolCalls };
  }

  async function runKpTurn(gameId, text, player) {
    let flat = touchFlat(gameId);
    flat = enrichScenarioFacts(flat);
    flat = enrichScenarioContract(flat);
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

    // 理智检定是暗骰，不得作为玩家明骰门禁（兼容历史数据里的 .ra理智 门禁）。
    {
      const pending = Array.isArray(flat.pendingChecks) ? flat.pendingChecks : (flat.pendingChecks = []);
      const sanityGates = pending.filter(
        (gate) => gate.skill === "理智" || /^SAN$/i.test(String(gate.skill ?? ""))
      );
      if (sanityGates.length > 0) {
        const skipped = Array.isArray(flat.skippedChecks) ? flat.skippedChecks : (flat.skippedChecks = []);
        for (const gate of sanityGates) skipped.push({ ...gate, skippedAt: nowIso(), reason: "sanity-secret" });
        flat.pendingChecks = pending.filter(
          (gate) => gate.skill !== "理智" && !/^SAN$/i.test(String(gate.skill ?? ""))
        );
        if (skipped.length > 80) flat.skippedChecks = skipped.slice(-80);
        saveFlat(gameId, flat);
      }
    }

    const ra = parseRaCommand(text);
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
      let choiceAction = null;
      if (ra === null && flat.pendingChoice !== null && flat.pendingChoice !== undefined) {
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
      let sideEffectSnapshot = null;
      let sideEffectRollbackNeeded = false;

      if (ra !== null || choiceAction !== null) {
        const skill = ra !== null ? ra.skill : String(flat.pendingChoice?.skill ?? "");
        const difficulty = ra !== null ? ra.difficulty : String(flat.pendingChoice?.difficulty ?? "regular");

        // 理智检定是暗骰：玩家不应通过 .ra理智 公开掷 SAN。
        if (skill === "理智" || /^SAN$/i.test(skill)) {
          appendLog(flat, "check", "[系统] 理智检定是暗骰，由 KP 用 coc_sanity_check 结算，玩家不需要发送 .ra理智。");
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

        // 多候选动作：先确认动作，不掷骰。
        if (ra !== null && choiceAction === null && distinctActions.length > 1) {
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

        const action =
          choiceAction !== null
            ? choiceAction
            : distinctActions.length === 1
              ? distinctActions[0]
              : "";
        let selectedGate = null;
        if (choiceAction !== null) {
          selectedGate = gates.find(
            (gate) => gate.skill === skill && String(gate.action ?? "").trim() === choiceAction
          ) ?? null;
        } else if (skillGates.length === 1) {
          selectedGate = skillGates[0];
        } else if (action.length > 0) {
          selectedGate = skillGates.find((gate) => String(gate.action ?? "").trim() === action) ?? null;
        }

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
        const rollLine = formatRaResultLine(name, skill, result);
        appendLog(flat, "roll", rollLine, name);

        // 本次检定的门禁已解决；同轮其他门禁作废（玩家改做其他动作）。
        if (skillGates.length > 0) {
          abandonGates(selectedGate?.id, "superseded");
          if (selectedGate !== null) {
            flat.pendingChecks = flat.pendingChecks.filter((gate) => gate.id !== selectedGate.id);
          }
        }
        flat.pendingChoice = null;

        syncSession(flat);
        commitSession(deps, gameId, deps.session, flat, [
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
        ]);
        flat = deps.persistence.load(deps.stateKey(gameId)) ?? flat;

        messages = buildLoopMessages(flat.log ?? [], deps.maxChatLog);
        const rollSystemText =
          action.length > 0
            ? `【系统检定】${rollLine}。玩家想对「${action}」进行检定。请据此直接叙述该动作的剧情结果，只写效果，不要出现成功档位词或骰值。`
            : `【系统检定】${rollLine}。请据此继续叙述，只写效果，不要出现成功档位词或骰值。`;
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

        // 未命中：旧门禁作废（玩家改做其他动作），按自由动作交给 KP。
        abandonGates(undefined, "abandoned");
        flat.pendingChoice = null;
        saveFlat(gameId, flat);

        // 自由动作路径：SAN/HP/物品等不可逆工具调用先挂账，等叙事校验通过才真正保留；
        // 若被守卫判定“门禁前泄露线索”，则回滚本轮副作用（门禁/scene 等结构变更保留）。
        sideEffectSnapshot = snapshotSideEffects(flat);
        sideEffectRollbackNeeded = false;

        messages = buildLoopMessages(flat.log ?? [], deps.maxChatLog);
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
        const contractIssues = validateCandidateNarration(flat.scenarioContract, narration, {
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
          branches: (flat.branches ?? []).map((branch) => ({ id: branch.id, title: branch.title })),
        }).violations;

        const allIssues = [...guardIssues, ...contractIssues];
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

      // 场景落地：当前场景为空，或叙述明显进入另一个有事实卡的场景
      // （而当前场景词不再出现）时，从叙述文本确定性推断并写入状态。
      // 修复“开场 currentScene=镇上街道 后走到三层也不更新”的问题。
      {
        const inferred = inferSceneFromText(narration, flat.scenarioFacts ?? []);
        if (inferred !== null && inferred.length > 0 && inferred !== flat.currentScene) {
          const currentFact = selectSceneFacts(flat.currentScene ?? "", flat.scenarioFacts ?? []);
          const currentKeywords = currentFact?.keywords ?? [];
          const mentionsCurrent = currentKeywords.some((keyword) => narration.includes(keyword));
          if ((flat.currentScene ?? "") === "" || !mentionsCurrent) {
            flat.currentScene = inferred;
          }
        }
      }

      // 关键点/物品自动落地：不依赖 LLM 自觉调用 coc_branch / coc_pc。
      const revealedCount = revealKeyPointsFromNarration(flat.keyPoints, narration);
      const acquiredItems = autoTrackInventory(flat, narration);
      if (revealedCount > 0 || acquiredItems.length > 0) {
        syncSession(flat);
        if (revealedCount > 0) {
          deps.session.recordTrace({ kind: "auto-reveal", count: revealedCount, at: nowIso() });
        }
        if (acquiredItems.length > 0) {
          deps.session.recordTrace({ kind: "auto-inventory", items: acquiredItems, at: nowIso() });
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
          for (const event of night.fired) {
            firedIds.add(event.id);
            appendLog(flat, "check", `[夜晚事件] ${event.title}（已触发）`);
          }
          flat.firedNightEventIds = [...firedIds];
        }
      }

      // 文本 [团检] 标记是旧模型/兜底路径；coc_check 工具已把门禁落盘，
      // 这里只把文本标记合并进去（去重），统一渲染 .ra 提示行。
      const textGates = [];
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
      flat.pendingChecks = mergeCheckGates(flat.pendingChecks ?? [], textGates);
      assignGateIds(flat.pendingChecks);

      appendLog(flat, "kp", narration);
      for (const gate of flat.pendingChecks) {
        if (gate.skill === "理智" || /^SAN$/i.test(String(gate.skill ?? ""))) continue;
        if (!gatesBeforeKeys.has(checkKey(gate))) {
          const line = formatCheckLine(gate.skill, gate.difficulty);
          if (line.length > 0) appendLog(flat, "check", line);
        }
      }

      flat.busy = false;
      saveFlat(gameId, flat);

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

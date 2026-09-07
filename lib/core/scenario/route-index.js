/**
 * 地点与路线索引（Location & Route Index）
 *
 * 从结构化剧情数据（keyPoints/branches 的 scene、deepParse plotEdges、location 实体）
 * 确定性生成：
 *   - locationIndex：剧本地点白名单 + 别名
 *   - routeGraph：地点邻接表（哪些地点可以从哪些地点前往）
 *
 * 用途：
 *   1. context-builder 注入「地点清单（白名单）」与「路线约束」，禁止 KP 发明地点/捷径；
 *   2. chat-bridge 依据玩家输入与邻接表确定性更新 currentScene；
 *   3. 路线守卫检测叙述中的未登记地点与路线跳跃。
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */

/**
 * 规范化场景名：去掉项目符号/编号前缀、尾部空白，保留原文用词。
 * @param {string} value
 * @returns {string}
 */
export function normalizeSceneName(value) {
  return String(value ?? "")
    .replace(/^[\s·•*\-–—0-9.、]+/, "")
    .replace(/[：:]\s*$/, "")
    .trim();
}

/**
 * 拆分场景名：支持“A/B”“A：B”两种形态，返回全称与短名别名。
 * @param {string} value
 * @returns {string[]}
 */
export function sceneAliases(value) {
  const source = normalizeSceneName(value);
  if (source.length === 0) return [];
  const aliases = new Set([source]);
  const addParts = (part) => {
    const trimmed = part.trim();
    if (trimmed.length > 0) aliases.add(trimmed);
    const afterColon = trimmed.split(/[：:]/).pop()?.trim() ?? "";
    if (afterColon.length > 0 && afterColon !== trimmed) aliases.add(afterColon);
    const beforeColon = trimmed.split(/[：:]/)[0]?.trim() ?? "";
    if (beforeColon.length > 0 && beforeColon !== trimmed) aliases.add(beforeColon);
    // 去掉“寻找/前往/来到/进入/到达”等动作前缀：
    // “寻找外部控制室”应能解析到“外部控制室”。
    const stripped = trimmed.replace(/^(?:寻找|前往|来到|进入|到达|去往|返回)+/, "");
    if (stripped.length >= 2 && stripped !== trimmed) {
      aliases.add(stripped);
      const strippedAfterColon = stripped.split(/[：:]/).pop()?.trim() ?? "";
      if (strippedAfterColon.length >= 2) aliases.add(strippedAfterColon);
    }
  };
  for (const part of source.split(/[\/／]/)) addParts(part);
  return [...aliases].filter((alias) => alias.length >= 2);
}

function isHubNodeId(id) {
  return /(?:^|-)hub(?:-|$)/.test(String(id ?? ""));
}

function isHubScene(scene) {
  const name = String(scene ?? "");
  return /枢纽|终幕|全剧/.test(name);
}

/**
 * 从 keyPoints/branches/entities 收集地点条目。
 * @param {object} flat
 * @returns {Array<{ name: string, aliases: string[], sources: string[] }>}
 */
export function collectLocationEntries(flat) {
  const entries = [];
  const byName = new Map();

  const add = (scene, source) => {
    const normalized = normalizeSceneName(scene);
    if (normalized.length === 0 || isHubScene(normalized)) return;
    const aliases = sceneAliases(normalized);
    if (aliases.length === 0) return;
    const existing = byName.get(normalized);
    if (existing !== undefined) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    const entry = { name: normalized, aliases, sources: [source] };
    byName.set(normalized, entry);
    entries.push(entry);
  };

  for (const kp of flat?.keyPoints ?? []) {
    if (isHubNodeId(kp?.id)) continue;
    add(kp?.scene, `keyPoint:${kp?.id}`);
  }
  for (const branch of flat?.branches ?? []) {
    if (isHubNodeId(branch?.id)) continue;
    add(branch?.scene, `branch:${branch?.id}`);
  }
  for (const entity of flat?.entities ?? []) {
    if (entity?.type === "location") add(entity?.name, `entity:${entity?.id}`);
  }
  for (const check of flat?.scenarioCheckpoints ?? []) {
    add(check?.scene, `checkpoint:${check?.id}`);
  }
  for (const fact of flat?.scenarioFacts ?? []) {
    add(fact?.heading, "scenarioFact");
  }

  return entries;
}

/**
 * 构建别名→地点名索引。
 * @param {Array<object>} entries
 * @returns {Map<string, string>}
 */
export function buildAliasIndex(entries) {
  const aliasIndex = new Map();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      if (!aliasIndex.has(alias)) aliasIndex.set(alias, entry.name);
    }
  }
  return aliasIndex;
}

/**
 * 解析当前场景/文本中命中的地点名。
 * @param {Map<string, string>} aliasIndex
 * @param {string} scene
 * @returns {string|null}
 */
export function resolveLocation(aliasIndex, scene) {
  const source = normalizeSceneName(scene);
  if (source.length === 0) return null;
  if (aliasIndex.has(source)) return aliasIndex.get(source);
  // 别名互相包含：当前场景包含某别名时命中（如“矿洞-凉爽侧向岔道”命中“矿洞”）。
  let best = null;
  let bestLength = 0;
  for (const [alias, name] of aliasIndex.entries()) {
    if (source.includes(alias) && alias.length > bestLength) {
      best = name;
      bestLength = alias.length;
    }
  }
  return best;
}

/**
 * 构建地点邻接表。
 * 边来源：
 *   1. deepParse.plotEdges：from/to 的 keyPoint/branch 映射到 scene；
 *   2. 同一 keyPoints 数组里相邻的不同 scene（线性兜底）。
 * 邻接为无向图（“可前往”不区分方向；方向性由前置条件在 Trigger 层处理）。
 * @param {object} flat
 * @param {Array<object>} entries
 * @returns {Map<string, Set<string>>}
 */
export function buildRouteAdjacency(flat, entries) {
  const adjacency = new Map();
  for (const entry of entries) {
    adjacency.set(entry.name, new Set());
  }
  const addEdge = (a, b) => {
    if (a === b || a.length === 0 || b.length === 0) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  };

  const keyPointById = new Map((flat?.keyPoints ?? []).map((kp) => [String(kp?.id ?? ""), kp]));
  const branchById = new Map((flat?.branches ?? []).map((branch) => [String(branch?.id ?? ""), branch]));

  const sceneOfNode = (ref) => {
    if (ref === undefined || ref === null) return "";
    if (ref.startsWith("kp:")) return normalizeSceneName(keyPointById.get(ref.slice(3))?.scene ?? "");
    if (ref.startsWith("br:")) return normalizeSceneName(branchById.get(ref.slice(3))?.scene ?? "");
    return "";
  };

  for (const edge of flat?.deepParse?.plotEdges ?? []) {
    const from = String(edge?.from ?? "");
    const to = String(edge?.to ?? "");
    if (from.startsWith("end:")) continue;
    const sceneA = sceneOfNode(from);
    const sceneB = sceneOfNode(to);
    if (sceneA.length > 0 && sceneB.length > 0 && !isHubScene(sceneA) && !isHubScene(sceneB)) {
      addEdge(sceneA, sceneB);
    }
  }

  // 线性兜底：keyPoints 相邻的不同场景。
  const kps = (flat?.keyPoints ?? []).filter((kp) => !isHubNodeId(kp?.id));
  for (let index = 1; index < kps.length; index += 1) {
    const a = normalizeSceneName(kps[index - 1]?.scene ?? "");
    const b = normalizeSceneName(kps[index]?.scene ?? "");
    if (a.length > 0 && b.length > 0 && !isHubScene(a) && !isHubScene(b)) addEdge(a, b);
  }

  return adjacency;
}

/**
 * 构建完整路线索引。
 * @param {object} flat
 * @returns {{ entries: Array<object>, aliasIndex: Map<string, string>, adjacency: Map<string, Set<string>> }}
 */
export function buildRouteIndex(flat) {
  const entries = collectLocationEntries(flat);
  const aliasIndex = buildAliasIndex(entries);
  const adjacency = buildRouteAdjacency(flat, entries);
  return { entries, aliasIndex, adjacency };
}

/**
 * 当前场景可前往的地点列表（已排序）。
 * @param {object} routeIndex
 * @param {string} currentScene
 * @returns {{ current: string|null, neighbors: string[] }}
 */
export function routeNeighbors(routeIndex, currentScene) {
  const current = resolveLocation(routeIndex.aliasIndex, currentScene);
  if (current === null) return { current: null, neighbors: [] };
  const neighbors = [...(routeIndex.adjacency.get(current) ?? [])].sort();
  return { current, neighbors };
}

/**
 * 玩家输入中是否包含“前往某地点”的转移意图。
 * @param {Map<string, string>} aliasIndex
 * @param {string} text
 * @returns {string|null} 目标地点名
 */
// 地点候选后缀：用于从叙述/原文中提取“地点样”的短语。
// 选择标准：出现这些后缀时几乎一定在指称一个地点/结构，
// 而不是普通名词（“门/窗/墙”等过泛后缀故意不收）。
const ROOM_LIKE_SUFFIX_RE =
  /(?:房间|控制室|控制台|档案馆|档案室|办公室|大厅|舱|旋梯|拱道|通道|岔道|走廊|楼层)/g;

/**
 * 提取文本中的地点后缀词（只返回后缀本身，不截取前文）。
 * 旧实现按固定窗口截前缀，会把“装置竖直贯穿房间/们沿环形走廊”等
 * 普通句子片段误判为未登记地点（Codex r4 守卫 26 次误报的根因）。
 * 匹配与白名单比较都只用后缀词，宁可少报不可误报。
 * @param {string} text
 * @returns {string[]}
 */
export function extractRoomLikeTerms(text) {
  const source = String(text ?? "");
  const terms = new Set();
  let match;
  ROOM_LIKE_SUFFIX_RE.lastIndex = 0;
  while ((match = ROOM_LIKE_SUFFIX_RE.exec(source)) !== null) {
    if (match[0].length >= 1) terms.add(match[0]);
  }
  return [...terms];
}

/**
 * 允许的地点词表：结构化地点别名 + 剧本原文里出现过的地点候选短语。
 * 原文里出现过的地点词视为合法（即使未进 keyPoints/branches），
 * 叙述里出现原文没有的地点词才需要守卫拦截。
 * @param {object} flat
 * @param {object} [routeIndex]
 * @returns {Set<string>}
 */
export function collectAllowedLocationTerms(flat, routeIndex = null) {
  const allowed = new Set();
  const index = routeIndex ?? buildRouteIndex(flat);
  for (const entry of index.entries) {
    for (const alias of entry.aliases) allowed.add(alias);
  }
  for (const term of extractRoomLikeTerms(flat?.scenario?.text ?? "")) {
    allowed.add(term);
  }
  return allowed;
}

/**
 * 找出叙述中出现、但剧本原文与结构化地点白名单里都没有的地点词。
 * @param {string} narration
 * @param {Set<string>} allowedTerms
 * @returns {string[]}
 */
export function findUnknownLocationTerms(narration, allowedTerms) {
  const candidates = extractRoomLikeTerms(narration);
  const allowed = allowedTerms instanceof Set ? allowedTerms : new Set(allowedTerms ?? []);
  const unknown = [];
  for (const candidate of candidates) {
    const known = [...allowed].some((term) => term.includes(candidate) || candidate.includes(term));
    if (!known) unknown.push(candidate);
  }
  return [...new Set(unknown)];
}

export function findTravelIntent(aliasIndex, text) {
  const source = String(text ?? "");
  if (source.trim().length === 0) return null;
  const sentences = source.split(/[。！？；\n]/).map((item) => item.trim()).filter((item) => item.length > 0);
  const moveRe = /(?:去|前往|赶去|进入|走进|回到|返回|奔向|赶赴|出发去|朝|往)([^，。；！？\n]{0,24})/g;
  let match;
  while ((match = moveRe.exec(source)) !== null) {
    const target = resolveLocation(aliasIndex, match[1]);
    if (target === null) continue;
    // 跳过“如果/若是/若/假如/要是”条件句，以及“请/让/叫/问…路线/怎么走”的问路请求。
    const sentence = sentences.find((item) => item.includes(match[0])) ?? "";
    const before = sentence.slice(0, Math.max(0, sentence.indexOf(match[0])));
    const after = sentence.slice(sentence.indexOf(match[0]) + match[0].length);
    if (/(?:如果|若是|若|假如|要是)/.test(before)) continue;
    if (/(?:请|让|叫|问|打听)/.test(before) && /(?:路线|怎么走|多远|方向|地图|哪条路|带路)/.test(`${match[0]}${after}`)) continue;
    return target;
  }
  return null;
}

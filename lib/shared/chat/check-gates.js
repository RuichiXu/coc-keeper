/**
 * 检定门禁（Check Gates）
 *
 * 门禁 = 一个“必须由玩家发送 .ra 才能推进对应动作”的检定要求。
 * KP 通过 coc_check 工具登记门禁；程序负责渲染 .ra 提示、匹配玩家动作、
 * 在检定完成前阻止剧情推进。
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */

/**
 * 门禁唯一键：技能·难度·动作文本。
 * @param {{ skill: string, difficulty?: string, action?: string }} check
 * @returns {string}
 */
export function checkKey(check) {
  const skill = String(check?.skill ?? "").trim();
  const difficulty = check?.difficulty === "hard" || check?.difficulty === "extreme" ? check.difficulty : "regular";
  const action = String(check?.action ?? "").trim();
  return `${skill}·${difficulty}·${action}`;
}

/**
 * 合并门禁列表（按 checkKey 去重，保留先出现者）。
 * @param {Array<object>} existing
 * @param {Array<object>} incoming
 * @returns {Array<object>}
 */
export function mergeCheckGates(existing, incoming) {
  const merged = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(merged.map(checkKey));
  for (const check of incoming ?? []) {
    const key = checkKey(check);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(check);
  }
  return merged;
}

/**
 * 规范化动作文本：去掉列表符号、空白与常见语气前缀。
 * @param {string} text
 * @returns {string}
 */
export function normalizeAction(text) {
  return String(text ?? "")
    .replace(/^[-*•\d.、\s]+/, "")
    .replace(/^(?:我(?:们|想要|打算|准备|可以|去)?)/, "")
    .replace(/[\s，,。.!！？?、]+$/g, "")
    .trim();
}

function cjkBigrams(text) {
  const clean = String(text ?? "").replace(/[^\u4e00-\u9fff]/g, "");
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) {
    grams.add(clean.slice(i, i + 2));
  }
  return grams;
}

/**
 * 计算玩家输入与门禁动作的匹配分。
 * 精确/包含优先，其次 CJK 双字组重叠兜底（“我翻出去爬” vs “翻出窗外…攀向屋顶小门”）。
 * @param {string} input
 * @param {string} action
 * @returns {number}
 */
export function scoreActionMatch(input, action) {
  const a = normalizeAction(input);
  const b = normalizeAction(action);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 90;
  const ga = cjkBigrams(a);
  const gb = cjkBigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const gram of ga) {
    if (gb.has(gram)) shared += 1;
  }
  const shorter = Math.min(ga.size, gb.size);
  if (shorter === 0) return 0;
  const coverage = shared / shorter;
  // 需要至少 2 个共享双字组且覆盖率 ≥ 0.5，避免“开门”误匹配“敲门”。
  if (shared < 2 || coverage < 0.5) return 0;
  return Math.round(50 + coverage * 30 + shared);
}

/**
 * 在门禁列表中找出与玩家输入匹配的门禁（按匹配分降序）。
 * @param {string} input
 * @param {Array<object>} gates
 * @returns {Array<object>}
 */
export function matchActionToGates(input, gates) {
  const scored = [];
  for (const gate of gates ?? []) {
    const action = String(gate?.action ?? "").trim();
    if (action.length === 0) continue;
    const score = scoreActionMatch(input, action);
    if (score > 0) scored.push({ gate, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.gate);
}

/**
 * 解析玩家对“候选动作确认”的回复。
 * @param {string} text
 * @param {{ skill: string, candidates: Array<string> } | null} pendingChoice
 * @returns {string | null} 选中的动作文本
 */
/**
 * 解析 `.ra技能 编号` 形式的候选确认（如 `.ra侦查 2`）。
 * @param {string} raSkill parseRaCommand 解析出的技能名（可能带编号）
 * @param {{ skill: string, candidates: Array<string> } | null} pendingChoice
 * @returns {string | null} 选中的候选动作
 */
export function resolveRaCandidateChoice(raSkill, pendingChoice) {
  if (pendingChoice === null || pendingChoice === undefined) return null;
  const candidates = Array.isArray(pendingChoice.candidates) ? pendingChoice.candidates : [];
  if (candidates.length === 0) return null;
  const skillRaw = String(raSkill ?? "").trim();
  const m = skillRaw.match(/^(.+?)\s*([1-9]\d?)$/);
  if (m === null) return null;
  const baseSkill = m[1].trim();
  if (baseSkill !== String(pendingChoice.skill ?? "").trim()) return null;
  const index = Number(m[2]) - 1;
  return index >= 0 && index < candidates.length ? candidates[index] : null;
}

export function resolvePendingChoice(text, pendingChoice) {
  if (pendingChoice === null || pendingChoice === undefined) return null;
  const candidates = Array.isArray(pendingChoice.candidates) ? pendingChoice.candidates : [];
  if (candidates.length === 0) return null;
  const input = String(text ?? "").trim();
  if (/^\d+$/.test(input)) {
    const index = Number(input) - 1;
    return index >= 0 && index < candidates.length ? candidates[index] : null;
  }
  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreActionMatch(input, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length > 0 ? scored[0].candidate : null;
}

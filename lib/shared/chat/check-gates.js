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
 * 清洗门禁动作文本：截掉残缺提示尾（破折号/省略号/“请发送 `”），
 * 截断超长叙事句，避免把“演算完毕，你审视图上那十二个字——”这类
 * 半截叙述当成 `.ra技能 N` 的候选。
 * @param {string} action
 * @returns {string}
 */
export function sanitizeGateAction(action) {
  let s = String(action ?? "").trim();
  if (s.length === 0) return "";
  s = s.replace(/[—–\-…\s]+$/g, "");
  s = s.replace(/(?:请)?发送\s*`[^`]*$/g, "");
  s = s.replace(/[，,。.!！？?、\s]+$/g, "");
  if (s.length > 40) {
    s = s.slice(0, 40).replace(/[，,。.!！？?、\s]+$/g, "");
  }
  return s.trim();
}

/**
 * 门禁动作的稳定目标键：把“查看一层门厅地板与墙脚”“我检查一层门厅地面和墙角”
 * 归一成同一目标，用于去重与匹配，避免同目标换措辞就丢失/重复门禁。
 * 仍然是一个有界启发式（词表 + 同义词），结构化替代方向见 PATCHES。
 * @param {string} action
 * @returns {string}
 */
export function gateTargetKey(action) {
  const original = sanitizeGateAction(action);
  let s = original;
  if (s.length === 0) return "";
  // 去列表符号/语气前缀（normalizeAction），再去“我/想要/继续”等前缀。
  s = s
    .replace(/^[-*•\d.、\s]+/, "")
    .replace(/^(?:我(?:们|想要|打算|准备|可以|去)?|玩家)?/, "")
    .replace(/^(?:想要|打算|准备|尝试|试着|继续|重新|再次|先|去|可以|会|再|仔细|完全|认真|反复|慢慢|快速|立即)/, "");
  // 去掉常见动作动词（按词删除，保留宾语/地点/目标）。
  s = s.replace(
    /(?:观察|检查|查看|搜查|搜索|翻查|翻看|翻阅|阅读|细读|寻找|找到|取出|拿出|带上|携带|收起|收好|翻开|拉开|打开|推|撞|爬|攀|沿|绕|进入|走进|走出|离开|前往|前去|来到|确认|核对|清点|验算|解读|研究|聆听|倾听|插入|撬起|试试|数一数|看一看|听一听|找一找|查一查|读一读|继续|尝试|试着|看|听|找|查|读|数|摸|碰)/g,
    ""
  );
  // 去掉高频功能字（注意：不删“地”，否则“地板”会变成“板”）。
  s = s.replace(/[的得了着过与及和或把将从到向对用给在是有要想让请发送呢吗吧啊哪那这其些个下]/g, "");
  // 常见同义归一。
  s = s
    .replace(/地板/g, "地面")
    .replace(/墙脚/g, "墙角")
    .replace(/卧房/g, "卧室")
    .replace(/原稿|稿纸/g, "手稿");
  s = s.trim();
  if (s.length < 2) return original.slice(0, 24);
  return s.slice(0, 24);
}

/**
 * 难度高低：regular < hard < extreme。
 * @param {string} a
 * @param {string} b
 * @returns {boolean} a 是否比 b 更难
 */
function difficultyHigher(a, b) {
  const rank = (value) => (value === "extreme" ? 3 : value === "hard" ? 2 : 1);
  return rank(a) > rank(b);
}

/**
 * 门禁唯一键：技能·难度·动作文本（动作经 sanitizeGateAction 清洗）。
 * @param {{ skill: string, difficulty?: string, action?: string }} check
 * @returns {string}
 */
export function checkKey(check) {
  const skill = String(check?.skill ?? "").trim();
  const difficulty = check?.difficulty === "hard" || check?.difficulty === "extreme" ? check.difficulty : "regular";
  const action = sanitizeGateAction(check?.action ?? "");
  return `${skill}·${difficulty}·${action}`;
}

/**
 * 合并门禁列表（按 gateTargetKey 语义去重）。
 * 同一目标换措辞：保留旧门禁，把动作文本更新为新措辞，难度取更难者。
 * @param {Array<object>} existing
 * @param {Array<object>} incoming
 * @returns {Array<object>}
 */
export function mergeCheckGates(existing, incoming) {
  const merged = Array.isArray(existing) ? existing.slice() : [];
  const indexByTarget = new Map();
  for (let i = 0; i < merged.length; i += 1) {
    const gate = merged[i];
    const target = gateTargetKey(gate.action);
    gate.target = target;
    indexByTarget.set(target, i);
  }
  for (const check of incoming ?? []) {
    const action = sanitizeGateAction(check.action ?? "");
    const target = gateTargetKey(action);
    if (target.length === 0) continue;
    const existingIndex = indexByTarget.get(target);
    if (existingIndex !== undefined) {
      const old = merged[existingIndex];
      if (action.length > 0) old.action = action;
      if (difficultyHigher(check.difficulty ?? "regular", old.difficulty ?? "regular")) {
        old.difficulty = check.difficulty;
      }
      old.target = target;
      continue;
    }
    const gate = { ...check, action, target };
    merged.push(gate);
    indexByTarget.set(target, merged.length - 1);
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
 * 计算两个目标键的匹配分。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function scoreTargetMatch(a, b) {
  const x = String(a ?? "").trim();
  const y = String(b ?? "").trim();
  if (x.length === 0 || y.length === 0) return 0;
  if (x === y) return 96;
  const shorter = Math.min(x.length, y.length);
  if (x.includes(y) || y.includes(x)) return shorter >= 4 ? 85 : 70;
  const ga = cjkBigrams(x);
  const gb = cjkBigrams(y);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const gram of ga) {
    if (gb.has(gram)) shared += 1;
  }
  const minSize = Math.min(ga.size, gb.size);
  const coverage = shared / minSize;
  if (shared < 2 || coverage < 0.5) return 0;
  return Math.round(55 + coverage * 25 + shared);
}

/**
 * 在门禁列表中找出与玩家输入匹配的门禁（按匹配分降序）。
 * 匹配分 = max(原文动作匹配, 目标键匹配)，目标键匹配用于“同目标换措辞”。
 * @param {string} input
 * @param {Array<object>} gates
 * @returns {Array<object>}
 */
export function matchActionToGates(input, gates) {
  const inputTarget = gateTargetKey(input);
  const scored = [];
  for (const gate of gates ?? []) {
    const action = String(gate?.action ?? "").trim();
    if (action.length === 0) continue;
    const actionScore = scoreActionMatch(input, action);
    const target = gateTargetKey(gate.action);
    const targetScore = inputTarget.length > 0 && target.length > 0 ? scoreTargetMatch(inputTarget, target) : 0;
    const score = Math.max(actionScore, targetScore);
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

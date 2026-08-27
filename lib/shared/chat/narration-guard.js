/**
 * 叙事候选校验（Narration Guard）
 *
 * 在 KP 叙述落盘前，用确定性规则做最后一层审核：
 * 1. 线索门禁泄露：叙述中出现当前场景检定点保护的线索词，但本轮没有对应技能的
 *    .ra 明骰 / 理智暗骰 → 视为“先上车后补票”，要求重写（先给团检，别出线索）。
 * 2. 推荐动作安全：结尾推荐动作里出现破坏线索、让 NPC 暴露于 SAN 源、
 *    或拖延到坏结局时间点的危险选项 → 要求重写推荐。
 *
 * 纯函数，零 DSH 依赖。
 */
import { CHECKPOINT_MATCH_KEYS, selectSceneFacts } from "../../core/index.js";

// 场景通用词（房间/楼层/宅邸总称）不视为“线索词”。
const GENERIC_SCENE_KEYS = new Set([
  "一层", "二层", "三层", "外围", "宅邸", "沃什宅邸", "书房", "卧室", "卧房",
  "门厅", "玄关", "客厅", "餐厅", "会客室", "走廊", "庭院", "花园",
  "阁楼", "酒柜", "楼梯", "窗户", "地毯", "壁炉", "肖像", "钥匙", "宅邸外",
]);

/**
 * 与 context-builder 相同的场景-检定点匹配逻辑（纯函数副本，避免循环依赖）。
 * @param {string} currentScene
 * @param {Array<object>} scenarioFacts
 * @param {Array<object>} scenarioCheckpoints
 * @returns {Array<object>}
 */
export function selectRelevantCheckpoints(currentScene, scenarioFacts, scenarioCheckpoints) {
  const fact = selectSceneFacts(currentScene, scenarioFacts);
  const list = scenarioCheckpoints ?? [];
  // 场景尚未落盘（如开场第一段）时无法匹配具体场景，先按全部检定点保守防护，
  // 避免“还没过侦查就先把宅邸外围线索全写出来”。
  if (fact === null) return list;
  return list.filter((check) => {
    const target = fact.heading;
    const scene = check.scene ?? "";
    if (scene === target || scene === currentScene || scene.includes(target) || target.includes(scene)) return true;
    if (check.floor !== undefined && check.floor !== "导入") {
      return check.floor === fact.floor;
    }
    const factKeys = fact.keywords ?? [];
    const checkKeys = check.keys ?? [];
    return CHECKPOINT_MATCH_KEYS.some((keyword) => factKeys.includes(keyword) && checkKeys.includes(keyword));
  });
}

/**
 * 从检定点 keys 中挑出“线索词”（去掉通用场景词与标题词）。
 * @param {object} checkpoint
 * @returns {string[]}
 */
export function clueWordsForCheckpoint(checkpoint) {
  const keys = Array.isArray(checkpoint?.keys) ? checkpoint.keys : [];
  return keys.filter((key) => {
    const word = String(key ?? "").trim();
    if (word.length < 2) return false;
    if (GENERIC_SCENE_KEYS.has(word)) return false;
    // 标题型 key（“一层：客厅与餐厅”“惴惴不安的宅邸主人”“调查员若对书房…”）不作为线索词
    if (/[：:，。；]/.test(word)) return false;
    return true;
  });
}

/**
 * 检测线索门禁泄露。
 * @param {string} narration
 * @param {object} opts
 * @param {string} opts.currentScene
 * @param {Array<object>} opts.scenarioFacts
 * @param {Array<object>} opts.scenarioCheckpoints
 * @param {Set<string>} [opts.rolledSkills] - 本轮已经明骰通过的技能集合
 * @param {boolean} [opts.sanityChecked=false] - 本轮是否做过理智暗骰
 * @returns {{ skill: string, difficulty: string, words: string[] } | null}
 */
export function findCheckpointClueLeak(narration, opts) {
  const text = String(narration ?? "");
  if (text.trim().length === 0) return null;
  const rolledSkills = opts.rolledSkills instanceof Set ? opts.rolledSkills : new Set();
  const relevant = selectRelevantCheckpoints(
    opts.currentScene,
    opts.scenarioFacts,
    opts.scenarioCheckpoints
  );
  for (const check of relevant) {
    const skill = String(check.skill ?? "").trim();
    if (skill.length === 0) continue;
    if (rolledSkills.has(skill)) continue;
    if (skill === "理智" && opts.sanityChecked === true) continue;
    const clueWords = clueWordsForCheckpoint(check);
    const leaked = clueWords.filter((word) => text.includes(word));
    if (leaked.length > 0) {
      return { skill, difficulty: check.difficulty ?? "regular", words: leaked };
    }
  }
  return null;
}

// 危险推荐动作模式（CoC 通用：破坏线索 / 让 NPC 接触 SAN 源 / 拖延到坏结局时间点）
const UNSAFE_RECOMMENDATION_PATTERNS = [
  {
    reason: "破坏或清除线索",
    re: /(?:擦掉|抹掉|洗掉|刮掉|清除|擦去|洗去)[^。；！？]{0,10}(?:墨|字迹|痕迹|手稿|日记|血|渍)/,
  },
  {
    reason: "让 NPC 暴露于 SAN 源",
    re: /(?:叫|让|带|请)[^。；！？]{0,10}(?:来看|去看|来听|去听|碰|摸)[^。；！？]{0,10}(?:墨渊|墨迹|漩涡|巨眼|鬼影|咒|仪式)/,
  },
  {
    reason: "拖延到坏结局时间点",
    re: /(?:等到明早|等到明天|明早再来|明天再|等天亮)/,
  },
  {
    reason: "让旁人代念咒文（改变仪式条件）",
    re: /(?:让|叫|请)[^。；！？]{0,12}(?:代替|代|帮你|替你)[^。；！？]{0,8}念/,
  },
];

/**
 * 检测叙述结尾的推荐动作是否危险。
 * 只看最后 120 字（推荐行通常在结尾）。
 * @param {string} narration
 * @returns {{ reason: string } | null}
 */
export function findUnsafeRecommendation(narration) {
  const text = String(narration ?? "");
  if (text.trim().length === 0) return null;
  const tail = text.slice(-120);
  for (const pattern of UNSAFE_RECOMMENDATION_PATTERNS) {
    if (pattern.re.test(tail)) {
      return { reason: pattern.reason };
    }
  }
  return null;
}

/**
 * 对候选叙述执行全部确定性校验。
 * @param {string} narration
 * @param {object} opts - 同 findCheckpointClueLeak
 * @returns {Array<{ kind: "clue-leak" | "unsafe-recommendation", message: string }>}
 */
export function validateNarrationCandidate(narration, opts) {
  const issues = [];
  const leak = findCheckpointClueLeak(narration, opts);
  if (leak !== null) {
    issues.push({
      kind: "clue-leak",
      message:
        `叙述疑似在检定前泄露了受「${leak.skill}` +
        `${leak.difficulty === "hard" ? "（困难）" : leak.difficulty === "extreme" ? "（极限）" : ""}` +
        `」保护的线索：${leak.words.join("、")}。请先调用 coc_check 登记该检定（或等待玩家 .ra 后）再叙述线索本身；本段只写氛围与过渡。`,
    });
  }
  const unsafe = findUnsafeRecommendation(narration);
  if (unsafe !== null) {
    issues.push({
      kind: "unsafe-recommendation",
      message: `结尾推荐动作疑似${unsafe.reason}，与剧本机制或调查员安全相悖。请改为安全的可选行动（如观察、聆听、退回安全处、按剧本机制行动）。`,
    });
  }
  return issues;
}

/**
 * Scene Facts & Checkpoint Extraction（确定性规则提取）
 *
 * 从剧本原文中提取：
 * - 场景切分与场景事实卡（楼层、房间、门锁、人物位置等）
 * - 显式检定点（“通过困难难度的侦查检定可以发现…” 等句式）
 * - 供运行时推断当前场景的辅助函数
 *
 * 规则优先，LLM 校对/兜底由导入流程另行完成。
 * 纯函数，零 DSH 依赖。
 */

// ── 常量 ──────────────────────────────────────────────────

const FLOOR_KEYWORDS = {
  三层: ["三层", "三楼", "3楼", "3层", "书房", "屋顶", "阁楼", "天台", "墨渊", "书桌"],
  二层: ["二层", "二楼", "2楼", "2层", "卧室", "卧房", "寝室", "走廊", "肖像", "楼梯间"],
  一层: ["一层", "一楼", "1楼", "1层", "门厅", "玄关", "客厅", "会客室", "起居室", "餐厅", "厨房", "酒柜", "暗门", "壁炉", "沙发", "地毯"],
  外围: ["宅邸外", "院外", "庭院", "花园", "铁栅栏", "铁门", "草坪", "土地", "外墙", "常春藤", "屋顶边缘", "沃什宅邸位于", "沃什宅邸", "宅邸", "河岸"],
};

const SCENE_ALIASES = {
  "一层": ["一层", "一楼", "门厅", "玄关", "客厅", "会客室", "餐厅"],
  "二层": ["二层", "二楼", "卧室", "走廊", "肖像"],
  "三层": ["三层", "三楼", "书房", "屋顶"],
  外围: ["外围", "院外", "庭院", "花园", "宅邸外", "铁栅栏", "沃什宅邸", "宅邸"],
};

// 场景特征词：既参与场景匹配，也参与检定点与场景的关联。
// 数值楼层词（一层/二层…）只从标题取，避免“铺了一层地毯”这类正文误命中。
const FEATURE_KEYWORDS = [
  "书房", "卧室", "门厅", "玄关", "客厅", "餐厅", "会客室", "走廊", "庭院",
  "花园", "屋顶", "阁楼", "酒柜", "暗门", "楼梯", "窗户", "地毯", "壁炉",
  "肖像", "钥匙", "墨渊", "漩涡", "巨眼", "鬼影", "手稿", "日记", "常春藤",
  "铁栅栏", "宅邸", "屋顶边缘",
];

// 检定点与场景做交集匹配时，只用有区分度的场景词。
// 地毯/壁炉/楼梯/窗户/钥匙 等常见陈设词不做交集，避免跨场景误配。
export const CHECKPOINT_MATCH_KEYS = [
  "书房", "卧室", "门厅", "玄关", "客厅", "餐厅", "会客室", "走廊", "庭院",
  "花园", "屋顶", "阁楼", "酒柜", "暗门", "屋顶边缘", "铁栅栏", "常春藤",
  "墨渊", "漩涡", "巨眼", "鬼影", "手稿", "日记", "肖像", "宅邸外", "沃什宅邸",
];

const FACT_LINE_RE =
  /(?:是|有|位于|铺|挂|锁|反锁|半掩|可以|通过|发现|房间|卧室|书房|门|楼梯|窗户|地毯|暗门|酒柜|沙发|壁炉|走廊|肖像|钥匙|翻窗|攀爬|屋顶|常春藤|铁栅栏|土地|草坪|气味|墨水|墨渊|鬼影|梦呓|拍门|挠门|呓语|异响|响动|开关|抽屉|日记|手稿|机关|甬道|石阶|锁匠|开锁|机械维修)/;

const KNOWN_SKILLS = new Set([
  "侦查", "侦察", "聆听", "图书馆", "图书馆使用", "心理学", "潜行", "神秘学",
  "医学", "急救", "克苏鲁神话", "智力", "灵感", "意志", "力量", "敏捷", "教育",
  "外貌", "体质", "体型", "幸运", "妙手", "开锁", "锁匠", "机械维修", "撬锁",
  "话术", "说服", "魅惑", "恐吓", "跳跃", "攀爬", "游泳", "驾驶", "骑术", "会计",
  "估价", "法律", "历史", "博物学", "导航", "占星学", "乔装", "读唇", "催眠",
  "炮术", "格斗", "射击", "投掷", "闪避", "追踪", "驯兽", "人类学", "考古学",
  "美术", "摄影", "伪造", "电气维修", "电子学", "汽车维修", "重型机械", "爆破",
  "定点爆破", "药学", "精神分析", "天文学", "植物学", "化学", "密码学",
  "计算机使用", "潜水", "藏匿", "隐匿", "生物学", "数学", "气象学", "物理",
  "地质学", "地理学", "母语", "外语",
]);

const DIFFICULTY_MAP = {
  "普通": "regular",
  "常规": "regular",
  "困难": "hard",
  "极难": "extreme",
  "极限": "extreme",
};

const SKILL_ALIASES = {
  "侦察": "侦查",
  "图书馆": "图书馆使用",
  "图书馆使用": "图书馆使用",
  "开锁": "开锁",
  "锁匠": "锁匠",
  "妙手": "妙手",
};

// ── 场景切分 ──────────────────────────────────────────────

/**
 * 将剧本原文按“短标题行”切分为场景块。
 * 标题识别：
 * - 以冒号结尾、长度 ≤ 26、且不含逗号/句号/问号/叹号的短行（如“三层：克罗斯的书房：”）
 * - 独立结局行（如“结局1（BE）”）
 * 每个非空行归属到最近一个标题下；标题前的行放入「导入/前置」块。
 *
 * @param {string} text
 * @returns {Array<{ heading: string, lines: string[] }>}
 */
export function splitScenarioSections(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sections = [];
  let current = { heading: "导入/前置", lines: [] };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const colonHeading = /^[^。！？…，,；;]{1,26}[：:]\s*$/.test(line) && line.length <= 26;
    const endingHeading = /^(?:结局\s*[一二三四五六七八九十\d]*|END\s*\d*|BAD\s*END|GOOD\s*END|TRUE\s*END)(?:[（(].*[）)])?$/i.test(line) && line.length <= 20;

    if (colonHeading || endingHeading) {
      if (current.lines.length > 0 || current.heading !== "导入/前置") {
        sections.push(current);
      }
      current = { heading: line, lines: [] };
      continue;
    }

    current.lines.push(line);
  }
  if (current.lines.length > 0 || current.heading !== "导入/前置") {
    sections.push(current);
  }

  return sections.filter((section) => section.lines.length > 0);
}

/**
 * 根据标题与正文关键词判断楼层/区域。
 * @param {string} heading
 * @param {string} body
 * @returns {string}
 */
export function classifyFloor(heading, body) {
  const headingText = heading ?? "";
  const bodyText = String(body ?? "");
  const bodyHead = bodyText.slice(0, 400);

  // 非地点类标题（背景/梗概/结局等）不参与楼层分类，避免污染场景匹配。
  if (!/(?:层|楼|门厅|玄关|客厅|餐厅|会客室|卧室|卧房|书房|走廊|庭院|花园|宅邸|宅|院|屋顶|外围|酒柜|暗门|楼梯)/.test(headingText)) {
    return "导入";
  }

  // 标题里出现强地点词时，只看标题，避免正文提到其他楼层导致误判
  // （如“子夜书房”正文提到“一层客厅”，但标题已明确是书房=三层）。
  const strongHeading = /(?:书房|卧室|卧房|门厅|玄关|客厅|餐厅|会客室|厨房|庭院|花园|屋顶|阁楼|酒柜|暗门|走廊|宅邸|层|楼|院)/.test(headingText);

  const scores = new Map();
  for (const [floor, keywords] of Object.entries(FLOOR_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (headingText.includes(keyword)) score += 3;
      if (!strongHeading && bodyHead.includes(keyword)) score += 1;
    }
    scores.set(floor, score);
  }
  let best = "导入";
  let bestScore = 0;
  for (const [floor, score] of scores.entries()) {
    if (score > bestScore) {
      best = floor;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 为检定点确定所属楼层。
 * 检定点小节标题常常不是地点（如“调查员若对书房进行侦察…”），
 * 此时改用正文关键词推断，保证书房检查点能归入三层、念咒检查点也能归入三层。
 */
export function classifyCheckpointFloor(heading, body) {
  const headingText = heading ?? "";
  if (/(?:层|楼|门厅|玄关|客厅|餐厅|会客室|卧室|卧房|书房|走廊|庭院|花园|宅邸|宅|院|屋顶|外围|酒柜|暗门|楼梯)/.test(headingText)) {
    return classifyFloor(headingText, body);
  }
  const bodyText = String(body ?? "");
  const scores = new Map();
  for (const [floor, keywords] of Object.entries(FLOOR_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (headingText.includes(keyword)) score += 3;
      if (bodyText.includes(keyword)) score += 1;
    }
    scores.set(floor, score);
  }
  let best = "导入";
  let bestScore = 0;
  for (const [floor, score] of scores.entries()) {
    if (score > bestScore) {
      best = floor;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : "导入";
}

/**
 * 从标题与正文提取场景关键词（用于场景匹配/推断）。
 * @param {string} heading
 * @param {string} body
 * @returns {string[]}
 */
export function collectKeywords(heading, body) {
  const headingText = heading ?? "";
  const bodyText = String(body ?? "");
  const numericFloor = /^[一二三四五六七八九\d]+[层楼]$/;
  const keywords = new Set();
  for (const list of [...Object.values(SCENE_ALIASES), FEATURE_KEYWORDS]) {
    for (const keyword of list) {
      if (numericFloor.test(keyword)) {
        if (headingText.includes(keyword)) keywords.add(keyword);
      } else if (headingText.includes(keyword) || bodyText.includes(keyword)) {
        keywords.add(keyword);
      }
    }
  }
  // 从标题中截取核心词
  const titlePart = headingText.replace(/[：:]\s*$/, "");
  if (titlePart.length > 0 && titlePart.length <= 20) keywords.add(titlePart);
  return [...keywords];
}

// ── 场景事实卡 ────────────────────────────────────────────

/**
 * 提取场景事实卡。
 * 每个区块返回：heading（场景名）、floor、keywords、original（原文块）、facts（事实句）。
 *
 * @param {string} text
 * @param {number} [maxOriginal=1600] - 每个场景原文块最大字符数
 * @returns {Array<object>}
 */
export function extractSceneFacts(text, maxOriginal = 1600) {
  const sections = splitScenarioSections(text);
  return sections.map((section) => {
    const body = section.lines.join("\n");
    const heading = section.heading.replace(/[：:]\s*$/, "");
    const floor = classifyFloor(heading, body);
    const keywords = collectKeywords(heading, body);
    const facts = section.lines
      .map((line) => line.trim())
      .filter((line) => line.length >= 6 && line.length <= 120)
      .filter((line) => FACT_LINE_RE.test(line));
    const original = body.length > maxOriginal ? `${body.slice(0, maxOriginal)}\n……[本场景原文过长已截断]` : body;
    return {
      heading,
      floor,
      keywords,
      original,
      facts,
    };
  });
}

// ── 显式检定点提取 ────────────────────────────────────────

/**
 * 从一行文本中提取“技能·难度”检定点。
 * @param {string} line
 * @returns {Array<{ skill: string, difficulty: string, trigger: string }>}
 */
function normalizeSkill(skill) {
  const normalized = SKILL_ALIASES[skill] ?? skill;
  return KNOWN_SKILLS.has(normalized) ? normalized : null;
}

/** 从检定标记（检定/鉴定/判定/检测）前的片段里，取末尾最长的已知技能名。 */
function matchSkillAtEnd(before) {
  let best = null;
  for (const skill of KNOWN_SKILLS) {
    if (before.endsWith(skill)) {
      if (best === null || skill.length > best.length) best = skill;
    }
  }
  return best;
}

/** 从技能名前面的片段里识别难度。 */
function matchDifficultyBefore(prefix) {
  const match = /(普通|困难|极难|极限|常规)\s*(?:难度)?\s*的?\s*$/.exec(prefix);
  return match ? match[1] : null;
}

function parseCheckpointLine(line) {
  const found = [];
  const push = (skill, difficulty, trigger) => {
    const normalized = normalizeSkill(skill);
    if (normalized === null) return;
    found.push({
      skill: normalized,
      difficulty: DIFFICULTY_MAP[difficulty] ?? "regular",
      trigger: trigger.trim().slice(0, 120),
    });
  };
  const pushSan = (trigger, sanLoss) => {
    found.push({
      skill: "理智",
      difficulty: "regular",
      trigger: trigger.trim().slice(0, 120),
      sanLoss: sanLoss || "0/1d3",
    });
  };

  // ① 以“检定/鉴定/判定/检测”为锚点，向前取技能名与难度。
  //    “通过困难难度的侦查检定” → 技能 侦查，难度 困难
  //    “（此时通过困难的侦查鉴定…” → 技能 侦查，难度 困难
  const markerRe = /(?:检定|鉴定|判定|检测)/g;
  let marker;
  while ((marker = markerRe.exec(line)) !== null) {
    const before = line.slice(0, marker.index);
    const skill = matchSkillAtEnd(before);
    if (skill === null) continue;
    const prefix = before.slice(0, -skill.length);
    const difficulty = matchDifficultyBefore(prefix) ?? "普通";
    push(skill, difficulty, line);
  }

  // ② “侦察或者图书馆普通成功：发现…” / “图书馆使用或者侦查困难成功”
  const pattern2 =
    /([\u4e00-\u9fa5A-Za-z]{1,8}?)\s*(?:或者|或)\s*([\u4e00-\u9fa5A-Za-z]{1,8}?)\s*(?:检定|鉴定)?\s*(普通|困难|极难|极限)?\s*成功/g;
  let match;
  while ((match = pattern2.exec(line)) !== null) {
    push(match[1], match[3] ?? "普通", line);
    push(match[2], match[3] ?? "普通", line);
  }

  // ③ “侦察极难成功或仔细摸索地毯” / “侦察极难成功” / “智力鉴定困难通过”
  const pattern3 =
    /([\u4e00-\u9fa5A-Za-z]{1,8}?)\s*(?:鉴定|检定)?\s*(普通|困难|极难|极限)\s*(?:成功|通过)/g;
  while ((match = pattern3.exec(line)) !== null) {
    push(match[1], match[2], line);
  }

  // ④ SAN check：“进行san check，成功-1san，失败-1D3san”
  if (/san\s*check/i.test(line) || /理智\s*(?:检定|判定|check)/i.test(line)) {
    pushSan(line, parseSanLossFromLine(line));
  }

  return found;
}

function parseSanLossFromLine(line) {
  const amount = "\\d+(?:\\s*[dD]\\s*\\d+(?:\\s*\\+\\s*\\d+)?)?";
  const success = new RegExp(`成功\\s*[-−]?\\s*(${amount})\\s*san`, "i").exec(line);
  const failure = new RegExp(`失败\\s*[-−]?\\s*(${amount})\\s*san`, "i").exec(line);
  const clean = (value) => value.toLowerCase().replace(/\s+/g, "");
  if (success && failure) return `${clean(success[1])}/${clean(failure[1])}`;
  if (failure) return `0/${clean(failure[1])}`;
  if (/san\s*check/i.test(line)) return "0/1d3";
  return "";
}

/**
 * 提取全文显式检定点（规则为主）。
 * 返回去重后的结构化数组。
 *
 * @param {string} text
 * @returns {Array<{ id: string, skill: string, difficulty: string, scene: string, trigger: string, optional: boolean, sanLoss?: string }>}
 */
export function extractCheckpoints(text) {
  const sections = splitScenarioSections(text);
  const out = [];
  const seen = new Set();

  for (const section of sections) {
    const heading = section.heading.replace(/[：:]\s*$/, "");
    const lineFound = [];
    for (const raw of section.lines) {
      const line = raw.trim();
      if (line.length === 0 || line.length > 600) continue;
      const found = parseCheckpointLine(line);
      for (const item of found) lineFound.push({ ...item, triggerLine: line });
    }

    // 同一句子里同技能同时命中“普通”与更具体难度时，保留更具体难度。
    // （如“智力鉴定困难通过”会同时被锚点法与句式③命中，锚点法误判为普通。）
    const byTriggerSkill = new Map();
    for (const item of lineFound) {
      const key = `${item.skill}|${item.trigger.slice(0, 20)}`;
      const existing = byTriggerSkill.get(key);
      if (existing === undefined) {
        byTriggerSkill.set(key, item);
      } else {
        const rank = { regular: 0, hard: 1, extreme: 2 };
        if ((rank[item.difficulty] ?? 0) > (rank[existing.difficulty] ?? 0)) {
          byTriggerSkill.set(key, item);
        }
      }
    }

    for (const item of byTriggerSkill.values()) {
      const key = `${heading}|${item.skill}|${item.difficulty}|${item.trigger.slice(0, 20)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `chk-${out.length + 1}`,
        skill: item.skill,
        difficulty: item.difficulty,
        scene: heading,
        floor: classifyCheckpointFloor(heading, section.lines.join("\n")),
        trigger: item.trigger,
        optional: true,
        keys: collectKeywords(heading, item.triggerLine ?? item.trigger),
        ...(item.sanLoss ? { sanLoss: item.sanLoss } : {}),
      });
    }
  }
  return out;
}

// ── 场景匹配与推断 ────────────────────────────────────────

/**
 * 根据当前场景名选择场景事实卡。
 * @param {string} currentScene
 * @param {Array<object>} facts - extractSceneFacts 的结果
 * @returns {object|null}
 */
export function selectSceneFacts(currentScene, facts) {
  const scene = String(currentScene ?? "").trim();
  const list = Array.isArray(facts) ? facts : [];
  if (list.length === 0) return null;
  if (scene.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const fact of list) {
    let score = 0;
    if (scene === fact.heading) score += 10;
    else if (scene.includes(fact.heading) || fact.heading.includes(scene)) score += 8;
    if (scene.includes(fact.floor)) score += 4;
    for (const keyword of fact.keywords ?? []) {
      if (scene.includes(keyword)) score += 2;
    }
    if (score > bestScore) {
      best = fact;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * 从叙述文本推断当前场景（用于 LLM 未调用 coc_scene 时的状态兜底）。
 * @param {string} text
 * @param {Array<object>} facts - extractSceneFacts 的结果
 * @returns {string|null} 场景名（heading），推断不出返回 null
 */
export function inferSceneFromText(text, facts) {
  const source = String(text ?? "");
  const list = Array.isArray(facts) ? facts : [];
  if (source.trim().length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const fact of list) {
    let score = 0;
    // 地点类标题优先（背景/梗概/结局等标题不参与场景推断）
    if (/(?:层|楼|门厅|玄关|客厅|餐厅|会客室|卧室|卧房|书房|走廊|庭院|花园|宅邸|宅|院|屋顶|外围|酒柜|暗门|楼梯)/.test(fact.heading)) {
      score += 6;
    }
    for (const keyword of fact.keywords ?? []) {
      if (source.includes(keyword)) score += 2;
    }
    // 楼层词额外加权（“二楼”“三层”等）
    if (source.includes(fact.floor)) score += 3;
    if (score > bestScore) {
      best = fact;
      bestScore = score;
    }
  }

  if (bestScore >= 2 && best !== null) return best.heading;

  // 无事实卡时的通用兜底
  const generic = [
    { scene: "三层书房", words: ["书房"] },
    { scene: "二层卧室区", words: ["卧室", "二楼", "二层"] },
    { scene: "一层门厅", words: ["门厅", "玄关", "客厅", "会客室", "一楼", "一层"] },
    { scene: "宅邸外围", words: ["院外", "庭院", "花园", "铁栅栏", "宅邸外", "雾", "河岸"] },
  ];
  for (const item of generic) {
    if (item.words.some((word) => source.includes(word))) return item.scene;
  }
  return null;
}

const SCENE_MOVEMENT_PHRASES = [
  "进入", "走进", "迈入", "来到", "走到", "返回", "回到", "前往", "穿过", "爬上", "走下", "下楼", "上楼", "推开", "撞开", "拧开", "拉开",
];

/**
 * 叙述中是否出现「位置转移」动作词。
 * 场景切换必须基于明确动作，而不是仅仅提到另一个场景词（否则“检查书桌”时
 * 顺带回忆/望见“一层客厅”也会把 currentScene 漂走）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasSceneMovementPhrase(text) {
  return SCENE_MOVEMENT_PHRASES.some((phrase) => String(text ?? "").includes(phrase));
}

/**
 * 场景转移推断：只有当前场景为空，或叙述同时命中（新场景 + 转移动作）时才切换。
 * @param {string} text
 * @param {string} currentScene
 * @param {Array<object>} facts
 * @returns {string|null} 新的场景标题；不满足转移条件时返回 null
 */
export function inferSceneTransition(text, currentScene, facts) {
  const source = String(text ?? "").trim();
  if (source.length === 0) return null;
  const inferred = inferSceneFromText(source, facts);
  if (inferred === null) return null;
  const current = String(currentScene ?? "").trim();
  if (current.length === 0) return inferred;
  if (inferred === current) return null;
  // 必须出现位置转移动作，否则保持当前场景。
  if (!hasSceneMovementPhrase(source)) return null;
  return inferred;
}

// ── 房间-楼层规则与冲突检测 ───────────────────────────────

const ROOM_WORDS = ["书房", "卧室", "卧房", "门厅", "玄关", "客厅", "餐厅", "会客室", "厨房", "走廊", "庭院", "花园", "屋顶", "阁楼", "酒柜", "暗门"];

const FLOOR_MARKERS = [
  { floor: "一层", words: ["一层", "一楼", "1楼", "1层"] },
  { floor: "二层", words: ["二层", "二楼", "2楼", "2层"] },
  { floor: "三层", words: ["三层", "三楼", "3楼", "3层"] },
  { floor: "外围", words: ["外围", "院外", "庭院", "花园", "宅邸外"] },
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从场景事实卡中提取「房间 → 楼层」规则（只从标题取房间名，避免正文噪声）。
 * @param {Array<object>} facts
 * @returns {Array<{ room: string, floor: string }>}
 */
export function buildRoomFloorRules(facts) {
  const rules = [];
  for (const fact of facts ?? []) {
    if (fact.floor === "导入") continue;
    for (const room of ROOM_WORDS) {
      if (fact.heading.includes(room)) {
        if (!rules.some((rule) => rule.room === room && rule.floor === fact.floor)) {
          rules.push({ room, floor: fact.floor });
        }
        break;
      }
    }
  }
  return rules;
}

/**
 * 检测叙述文本中「楼层 ↔ 房间」的冲突（如“二楼的书房”，而剧本说书房在三层）。
 * @param {string} text
 * @param {Array<object>} facts
 * @returns {{ room: string, expectedFloor: string, foundFloor: string } | null}
 */
export function findRoomFloorConflict(text, facts) {
  const source = String(text ?? "");
  if (source.trim().length === 0) return null;
  const rules = buildRoomFloorRules(facts);
  for (const rule of rules) {
    if (!source.includes(rule.room)) continue;
    for (const marker of FLOOR_MARKERS) {
      if (marker.floor === rule.floor) continue;
      for (const word of marker.words) {
        if (!source.includes(word)) continue;
        const pattern = new RegExp(
          `${escapeRegExp(word)}[^。！？；]{0,12}${escapeRegExp(rule.room)}|${escapeRegExp(rule.room)}[^。！？；]{0,12}${escapeRegExp(word)}`
        );
        if (pattern.test(source)) {
          return { room: rule.room, expectedFloor: rule.floor, foundFloor: marker.floor };
        }
      }
    }
  }
  return null;
}

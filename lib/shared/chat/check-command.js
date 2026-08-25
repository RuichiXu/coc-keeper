/**
 * 团检指令解析与判定词守卫
 *
 * 玩家明骰流程：
 *   KP 叙述结尾给出 [团检：聆听] 或 [团检：侦查·困难]
 *   → 系统渲染为“[团检：聆听] [.ra聆听]”
 *   → 玩家发送 .ra聆听 / .ra侦查困难 → 系统掷 d100 并把结果行插入会话 → LLM 继续叙述。
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STAT_ALIASES, TIER_LABELS, performRoll } from "../../core/index.js";

// ── 内置技能默认值（从内置规则摘要解析，玩家卡未列技能时回退） ──
let _defaultSkills = null;
function defaultSkills() {
  if (_defaultSkills !== null) return _defaultSkills;
  const map = {};
  try {
    const rulesFile = join(dirname(fileURLToPath(import.meta.url)), "../../rules-content.json");
    const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
    for (const line of String(rules.text ?? "").split(/\r?\n/)) {
      const m = line.match(/^-\s*(.+?)\s+(\d+)%\s*—/);
      if (m !== null) map[m[1]] = Number(m[2]);
    }
  } catch {
    // 解析失败时保持空表，.ra 退化为无目标 d100
  }
  _defaultSkills = map;
  return _defaultSkills;
}

// ── 常量 ──────────────────────────────────────────────────

// 难度别名：中文后缀 → core 难度键
export const DIFFICULTY_ALIASES = Object.freeze({
  常规: "regular",
  普通: "regular",
  困难: "hard",
  极限: "extreme",
});

const DIFFICULTY_LABELS = Object.freeze({
  regular: "常规",
  hard: "困难",
  extreme: "极限",
});

// 判定档位词：KP 叙述中不得出现（系统骰行负责呈现）
const TIER_PHRASES = ["大成功", "极限成功", "困难成功", "常规成功", "大失败"];

const TIER_PHRASE_RE = new RegExp(`(${TIER_PHRASES.join("|")})`, "g");
const TIER_PHRASE_TEST_RE = /大成功|极限成功|困难成功|常规成功|大失败/;
const DICE_RESULT_RE = /(?:掷\s*)?(?:d100|D100|1d100)\s*=\s*\d+[^\s，。；、]*/g;
const DICE_RESULT_TEST_RE = /(?:d100|D100|1d100)\s*=\s*\d+/;

// 【团检：技能】 / [团检：技能] / （团检：技能），内部可含难度后缀（技能·困难）
const CHECK_REQUEST_RE = /[\[【(（]团检[:：]\s*([^\]】)）]+)[\]】)）]/g;

// LLM 偶发的非正式检定提示：如“（需攀爬/敏捷）”“（需锁匠）”。解析为正式团检并清理出叙述。
const INFORMAL_CHECK_RE = /[（(]\s*(?:需|需要)\s*([^（）()\/|、，]{1,12}?)(?:\s*[\/|、]\s*([^（）()]{1,12}?))?\s*[）)]/g;

// KP 叙述中可能混入的 .ra 指令（系统会重新生成，需剥掉）
const RA_INLINE_RE = /\.ra\s*[^\s，。；、\]]*/g;

/**
 * 解析“技能·难度”组合。
 * @param {string} raw 如 “侦查” / “侦查·困难”
 * @returns {{ skill: string, difficulty: string }}
 */
export function parseSkillDifficulty(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(.+?)[·.、:：]?(困难|极限|常规|普通)$/);
  if (m !== null) {
    return { skill: m[1].trim(), difficulty: DIFFICULTY_ALIASES[m[2]] };
  }
  return { skill: s, difficulty: "regular" };
}

/**
 * 解析玩家输入的 .ra 检定指令。
 * 支持：.ra聆听、.ra 聆听、[.ra聆听]、.ra侦查困难、.ra侦查 困难
 * @param {string} text
 * @returns {{ skill: string, difficulty: string } | null}
 *   非 .ra 指令返回 null；.ra 后缺技能名返回 { skill: "", difficulty: "regular" }
 */
export function parseRaCommand(text) {
  const s = String(text ?? "").trim();
  if (!/^[\[【(（]?\.ra(?![\w])/i.test(s)) return null;
  const m = s.match(/^[\[【(（]?\.ra\s*([^\]】)）]*)[\]】)）]?$/i);
  const raw = (m?.[1] ?? "").trim();
  const { skill, difficulty } = parseSkillDifficulty(raw);
  return { skill, difficulty };
}

/**
 * 从 KP 叙述中提取所有团检（按出现顺序去重）。
 * @param {string} text
 * @returns {Array<{ skill: string, difficulty: string }>}
 */
/**
 * 从检定标记所在行提取“玩家可执行的动作选项”，用于 .ra 时绑定到具体剧情。
 * @param {string} source
 * @param {number} index 标记起始位置
 * @returns {string}
 */
function extractHintFromLine(source, index) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const raw = source.slice(lineStart, index);
  return String(raw ?? "")
    .replace(/^[-*•\d.、\s]+/, "")
    .replace(CHECK_REQUEST_RE, "")
    .replace(/^[\s，,：:、]+/, "")
    .replace(/[（(]\s*(?:若想|可以|也可|可)\s*/g, "")
    .replace(/[（(]\s*$/g, "")
    .replace(/[\/|]\s*$/g, "")
    .replace(/[\s，,]+(?:也可|可以|可)\s*$/g, "")
    .replace(/[\s，,：:、]+$/g, "")
    .trim();
}

export function parseCheckRequests(text) {
  const checks = [];
  const seen = new Set();
  const source = String(text ?? "");
  const add = (raw, hint = "") => {
    const { skill, difficulty } = parseSkillDifficulty(raw);
    if (skill.length === 0) return;
    const key = `${skill}·${difficulty}`;
    const existing = checks.find((check) => `${check.skill}·${check.difficulty}` === key);
    if (existing !== undefined) {
      // 去重时保留更有信息的动作选项。
      if ((existing.hint ?? "") === "" && hint !== "") existing.hint = hint;
      return;
    }
    checks.push({ skill, difficulty, ...(hint !== "" ? { hint } : {}) });
  };

  const formalRe = new RegExp(CHECK_REQUEST_RE.source, "g");
  let m;
  while ((m = formalRe.exec(source)) !== null) {
    add(m[1], extractHintFromLine(source, m.index));
  }

  // 非正式提示：“（需攀爬/敏捷）” → 取第一个已知技能，其次属性。
  const informalRe = new RegExp(INFORMAL_CHECK_RE.source, "g");
  while ((m = informalRe.exec(source)) !== null) {
    const candidates = [m[1], m[2]].filter((item) => typeof item === "string" && item.trim().length > 0);
    const chosen =
      candidates.find((item) => defaultSkills()[item] !== undefined) ??
      candidates.find((item) => STAT_ALIASES[item] !== undefined);
    if (chosen !== undefined) add(chosen, extractHintFromLine(source, m.index));
  }

  return checks;
}

/**
 * 从叙述中移除团检标记与混入的 .ra 指令（系统会另行渲染）。
 * @param {string} text
 * @returns {string}
 */
export function stripCheckRequests(text) {
  return String(text ?? "")
    // 先移除“包含团检/.ra 的整段括号”，避免留下“（）”或“（若想…也可 ）”这类残壳。
    .replace(/[（(][^（）()]*团检[:：][^（）()]*[）)]/g, "")
    .replace(/[（(][^（）()]*\.ra[^（）()]*[）)]/g, "")
    .replace(CHECK_REQUEST_RE, "")
    .replace(RA_INLINE_RE, "")
    .replace(INFORMAL_CHECK_RE, "")
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/，{2,}/g, "，")
    .replace(/。{2,}/g, "。")
    .replace(/，。/, "。")
    .replace(/。，/, "。")
    .replace(/^[\s，；、]+|[\s，；、]+$/g, "")
    .trim();
}

/**
 * 检测叙述中是否包含 KP 不该出现的判定结果词/骰值。
 * @param {string} text
 * @returns {boolean}
 */
export function containsResultPhrase(text) {
  const s = String(text ?? "");
  return TIER_PHRASE_TEST_RE.test(s) || DICE_RESULT_TEST_RE.test(s);
}

/**
 * 移除叙述中的判定档位词与骰值（系统骰行已经展示）。
 * @param {string} text
 * @returns {string}
 */
export function stripResultPhrases(text) {
  return String(text ?? "")
    .replace(TIER_PHRASE_RE, "")
    .replace(DICE_RESULT_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/，{2,}/g, "，")
    .replace(/。{2,}/g, "。")
    .replace(/，。/, "。")
    .replace(/。，/, "。")
    .replace(/^[\s，；、]+|[\s，；、]+$/g, "")
    .trim();
}

/**
 * 解析 .ra 技能对应的调查员与目标值。
 * 优先按 player 匹配人物名；否则取第一个非 AI 调查员；否则取第一个人物。
 * 技能优先查人物卡 skills，其次按属性别名查 stats，最后回退内置默认值。
 * @param {object} flat
 * @param {string} player
 * @param {string} skill
 * @returns {{ name: string, target: number|null }}
 */
export function resolveRaTarget(flat, player, skill) {
  const chars = Array.isArray(flat?.characters) ? flat.characters : [];
  const pc =
    chars.find((c) => c.name === player) ??
    chars.find((c) => c.aiControlled !== true) ??
    chars[0] ??
    null;
  const name = pc?.name || player || "调查员";
  const stats = pc?.stats ?? {};
  const skills = pc?.skills ?? {};
  const skillName = String(skill ?? "").trim();

  let target = numberOrNull(skills[skillName]);
  if (target === null) {
    // 兼容全角/半角冒号差异，如「格斗：斗殴」与「格斗:斗殴」
    const swapped = skillName.includes("：")
      ? skillName.replace(/：/g, ":")
      : skillName.replace(/:/g, "：");
    target = numberOrNull(skills[swapped]);
  }
  if (target === null) {
    const statKey = STAT_ALIASES[skillName];
    if (statKey !== undefined) target = numberOrNull(stats[statKey]);
  }
  if (target === null) {
    target = numberOrNull(defaultSkills()[skillName]);
    if (target === null) {
      const swapped = skillName.includes("：")
        ? skillName.replace(/：/g, ":")
        : skillName.replace(/:/g, "：");
      target = numberOrNull(defaultSkills()[swapped]);
    }
  }
  return { name, target };
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * 执行 .ra 明骰（d100，按指令中的难度结算）。
 * @param {string} skill
 * @param {number|null} target
 * @param {string} [difficulty="regular"]
 * @returns {object} performRoll 结果
 */
export function performRaRoll(skill, target, difficulty = "regular") {
  return performRoll("d100", target, difficulty);
}

/**
 * 渲染 .ra 结果行。
 * 格式：伊芙琳进行聆听检定：\nD100=79/60 失败
 * 困难：伊芙琳进行侦查检定（困难）：\nD100=36/60 困难成功 ✓
 * @param {string} name
 * @param {string} skill
 * @param {object} result
 * @returns {string}
 */
export function formatRaResultLine(name, skill, result) {
  const difficultyLabel =
    result.difficulty !== undefined && result.difficulty !== "regular"
      ? `（${DIFFICULTY_LABELS[result.difficulty] ?? result.difficulty}）`
      : "";
  const targetPart = result.target !== null && result.target !== undefined ? `/${result.target}` : "";
  let tierPart = "";
  if (result.tier !== null && result.tier !== undefined && TIER_LABELS[result.tier] !== undefined) {
    tierPart = ` ${TIER_LABELS[result.tier]}`;
    if (result.passed === true) tierPart += " ✓";
    else if (result.passed === false) tierPart += " ✗";
  }
  return `${name}进行${skill}检定${difficultyLabel}：\nD100=${result.rolled}${targetPart}${tierPart}`;
}

/**
 * 渲染团检提示行。
 * 格式：[团检：聆听] [.ra聆听]；困难：[团检：侦查·困难] [.ra侦查困难]
 * @param {string} skill
 * @param {string} [difficulty="regular"]
 * @returns {string}
 */
export function formatCheckLine(skill, difficulty = "regular") {
  const difficultySuffix =
    difficulty !== "regular" ? `·${DIFFICULTY_LABELS[difficulty] ?? difficulty}` : "";
  const raDifficultySuffix =
    difficulty !== "regular" ? `${DIFFICULTY_LABELS[difficulty] ?? difficulty}` : "";
  return `[团检：${skill}${difficultySuffix}] [.ra${skill}${raDifficultySuffix}]`;
}

/**
 * 剧本结算点（Scenario Settlements）
 *
 * 从剧本原文确定性提取“必须结算但旧版检定点提取会漏掉”的 SAN/HP 事件：
 *   - “SC 1/1d6”“SC 1d4/1d10” → 理智结算（调用 coc_sanity_check）
 *   - “房间里的全员HP-1d6” → 无条件 HP 伤害（调用 coc_pc 扣血）
 *   - “承受1/1d4的伤害”紧跟在某条 SC/检定点之后时，附带 linkedGate，
 *     由聊天桥在结算 SC 的同时登记对应的体质/技能门禁。
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */
import { collectKeywords, splitScenarioSections } from "./scene-facts.js";

const CJK_BIGRAM_RE = /[\u4e00-\u9fa5]{2}/g;

/**
 * 提取字符串中的 CJK 二字组（去重）。
 * @param {string} text
 * @returns {string[]}
 */
export function cjkBigrams(text) {
  const source = String(text ?? "");
  const seen = new Set();
  // 手动逐位取二字组，避免全局正则跳过重叠匹配（“泄压阀”需同时得到“泄压”与“压阀”）。
  for (let index = 0; index + 1 < source.length; index += 1) {
    const pair = source.slice(index, index + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(pair)) seen.add(pair);
  }
  return [...seen];
}

/**
 * 提取一行中的 SC 表达式：SC 1/1d6 / SC 1d4/1d10。
 * @param {string} line
 * @returns {Array<{ sanLoss: string, index: number }>}
 */
export function parseScExpressions(line) {
  const out = [];
  const re = /SC\s*(\d+(?:d\d+)?)\s*[\/／]\s*(\d+(?:d\d+)?)/gi;
  let match;
  while ((match = re.exec(line)) !== null) {
    out.push({
      sanLoss: `${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
      index: match.index,
    });
  }
  return out;
}

/**
 * 提取一行中的 HP 伤害表达式：全员HP-1d6 / HP-1d6。
 * @param {string} line
 * @returns {Array<{ damage: string, index: number }>}
 */
export function parseHpExpressions(line) {
  const out = [];
  const re = /(?:HP|hp)\s*[-−]\s*(\d+d\d+)/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    out.push({ damage: match[1].toLowerCase(), index: match.index });
  }
  return out;
}

/**
 * 提取“承受 1/1d4 的伤害”式条件伤害（成功扣左值，失败扣右值）。
 * @param {string} line
 * @returns {{ damage: string, index: number }|null}
 */
export function parseConditionalDamage(line) {
  const match = /承受\s*(\d+)\s*[\/／]\s*(\d+(?:d\d+)?)\s*的伤害/.exec(String(line ?? ""));
  if (match === null) return null;
  return { damage: `${match[1]}/${match[2].toLowerCase()}`, index: match.index };
}

/**
 * 结算点匹配规则：根据触发行内容生成“必要词/语境词”。
 * 触发行较长时优先整句/长片段命中；短行（如“直面沸核SC…”）退化为
 * 必要词 + 语境词组合，避免把教授笔记里仅仅“提到沸核”误判为直面沸核。
 *
 * @param {string} trigger
 * @param {string} kind
 * @returns {{ anyOf: string[], context: string[] }}
 */
export function settlementMatchRules(trigger, kind) {
  const source = String(trigger ?? "");
  const clauses = source
    .split(/[，。；！？：\n]/)
    .map((clause) => clause.replace(/[（(].*?[)）]/g, "").replace(/SC\s*\d+.*$/i, "").trim())
    .filter((clause) => clause.length >= 2);

  if (kind === "san") {
    if (/沸核/.test(source) && source.length <= 16) {
      return {
        anyOf: ["沸核"],
        context: ["观察", "直视", "面对", "高台", "白炽", "光球", "观察窗", "面前", "看向", "看"],
      };
    }
    if (/(?:踏出遗迹|离开矿洞|来到洞口|洞口|外部控制室)/.test(source)) {
      return {
        anyOf: [],
        context: ["出去", "离开", "洞口", "矿洞", "外部", "岩台", "夜风", "山脉侧翼", "踏出", "控制室"],
      };
    }
  }

  if (kind === "hp") {
    return {
      anyOf: ["泄压阀", "圆盘", "转盘", "装置", "房间"],
      context: ["蒸汽", "热浪", "烟雾", "零件", "崩", "烫", "灼", "扑面", "涌来", "喷"],
    };
  }

  return { anyOf: clauses, context: [] };
}

/**
 * 判断结算点是否命中。playerText 与 narration 合并后与触发行做
 * 长片段 / 二字组重叠 / 短行必要词 三层匹配。
 *
 * @param {object} settlement
 * @param {string} text
 * @returns {boolean}
 */
export function settlementMatches(settlement, text) {
  const hay = String(text ?? "");
  if (hay.trim().length === 0) return false;
  const trigger = String(settlement?.trigger ?? "");
  if (trigger.length === 0) return false;

  const rules = settlement?.matchRules ?? settlementMatchRules(trigger, settlement?.kind);
  const anyOf = rules?.anyOf ?? [];
  const context = rules?.context ?? [];

  if (anyOf.length > 0 && !anyOf.some((word) => hay.includes(word))) return false;
  if (context.length > 0 && !context.some((word) => hay.includes(word))) return false;

  // 策展过的语境词（anyOf+context）本身已足够特异（如“沸核+观察”“泄压阀+蒸汽扑面”），
  // 两者同时命中即可结算；未策展的通用规则继续走长片段/二字组重叠。
  if (context.length > 0) return true;

  // 1) 长片段命中：触发行的整句/长片段原样出现在文本里。
  const clauses = trigger
    .split(/[，。；！？：\n]/)
    .map((clause) => clause.replace(/[（(].*?[)）]/g, "").replace(/SC\s*\d+.*$/i, "").trim())
    .filter((clause) => clause.length >= 4);
  if (clauses.some((clause) => hay.includes(clause))) return true;

  // 2) 二字组重叠：>=2 个 CJK 二字组命中。
  const triggerBigrams = cjkBigrams(trigger);
  const hayBigrams = new Set(cjkBigrams(hay));
  const overlap = triggerBigrams.filter((bigram) => hayBigrams.has(bigram)).length;
  if (overlap >= 2) return true;

  // 3) 短触发行（<=12 字）且 anyOf 已命中时，一个二字组重叠即视为命中。
  return trigger.length <= 12 && overlap >= 1;
}

/**
 * 从剧本全文提取结算点。
 * 对 SC 结算点，若同节紧邻行里有“承受X/Y的伤害”的体质/技能检定，
 * 一并挂为 linkedGate，供聊天桥在结算 SC 时登记门禁。
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function extractSettlements(text) {
  const out = [];
  const seen = new Set();
  const sections = splitScenarioSections(text);

  for (const section of sections) {
    const heading = String(section?.heading ?? "").trim();
    const lines = Array.isArray(section?.lines) ? section.lines : [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = String(lines[index] ?? "").trim();
      if (line.length === 0 || line.length > 600) continue;

      const scList = parseScExpressions(line);
      for (const sc of scList) {
        const key = `san|${heading}|${line.slice(0, 30)}|${sc.sanLoss}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const settlement = {
          id: `set-${out.length + 1}`,
          kind: "san",
          scene: heading,
          trigger: line,
          sanLoss: sc.sanLoss,
          keys: collectKeywords(heading, line),
          matchRules: settlementMatchRules(line, "san"),
        };
        // 关联紧邻（或同一行 SC 之后）的“体质检定，随后承受1/1d4的伤害”式门禁。
        const linked = parseLinkedDamageGate(lines, index, sc.index);
        if (linked !== null) settlement.linkedGate = linked;
        out.push(settlement);
      }

      const hpList = parseHpExpressions(line);
      for (const hp of hpList) {
        const key = `hp|${heading}|${line.slice(0, 30)}|${hp.damage}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `set-${out.length + 1}`,
          kind: "hp",
          scene: heading,
          trigger: line,
          damage: hp.damage,
          keys: collectKeywords(heading, line),
          matchRules: settlementMatchRules(line, "hp"),
        });
      }
    }
  }

  return out;
}

/**
 * 从当前行向后找 1-2 行，解析“体质检定，随后承受1/1d4的伤害”，
 * 生成关联门禁描述（skill/difficulty/action/damage）。
 * @param {string[]} lines
 * @param {number} index
 * @returns {object|null}
 */
export function parseLinkedDamageGate(lines, index, scIndex = 0) {
  for (let offset = 0; offset <= 2; offset += 1) {
    const raw = String(lines[index + offset] ?? "");
    if (raw.trim().length === 0) continue;
    const searchFrom = offset === 0 ? Math.max(0, Number(scIndex) || 0) : 0;
    const line = offset === 0 ? raw.slice(searchFrom) : raw;
    const damage = parseConditionalDamage(line);
    if (damage === null) continue;
    const cleanLine = line.replace(/^[\s，。；！？…]+/, "");
    const skillLine = cleanLine.replace(/(?:考虑要求)?(?:极难|极限|困难|普通|常规)/, "");
    const skillMatch = /([\u4e00-\u9fa5A-Za-z]{1,8}?)\s*(?:检定|鉴定)/.exec(skillLine);
    const skill = skillMatch !== null ? skillMatch[1] : "体质";
    const difficulty =
      /(?:极难|极限)/.test(line) ? "extreme" : /困难/.test(line) ? "hard" : "regular";
    return {
      skill,
      difficulty,
      action: line.slice(0, 40),
      damage: damage.damage,
    };
  }
  return null;
}

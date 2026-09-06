/**
 * 咒文文本提取（数据驱动）
 *
 * 替换早期在聊天桥里硬编码《墨渊》十二字咒文的做法：
 *   - 优先读咒文关键点上的结构化字段（spellText / spellGroups）
 *   - 否则从剧本原文“咒”字附近的成组十二字（三字一组、四组）提取
 *   - 提取不到时返回 null，聊天桥跳过咒文展示/念诵识别，绝不注入固定文本
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */

const SPELL_KEYPOINT_TITLE_RE = /(?:咒文|十二字)/;

/**
 * 找“十二字咒文”类关键点（标题含咒文/十二字）。
 * @param {object} flat
 * @returns {object|null}
 */
export function findSpellKeyPointIn(flat) {
  return (flat?.keyPoints ?? []).find((kp) => SPELL_KEYPOINT_TITLE_RE.test(String(kp?.title ?? ""))) ?? null;
}

/**
 * 从字符串中解析“三字一组、四组”的成组咒文。
 * 返回四组词，解析失败返回 null。
 * @param {string} text
 * @returns {string[]|null}
 */
export function parseSpellGroups(text) {
  const source = String(text ?? "");
  const re = /([\u4e00-\u9fa5]{3})\s*[、，,]\s*([\u4e00-\u9fa5]{3})\s*[、，,]\s*([\u4e00-\u9fa5]{3})\s*[、，,]\s*([\u4e00-\u9fa5]{3})/g;
  const match = re.exec(source);
  if (match === null) return null;
  return [match[1], match[2], match[3], match[4]];
}

/**
 * 提取剧本当前可用的咒文四组词。
 * @param {object} flat
 * @returns {{ groups: string[], source: string }|null}
 */
export function extractSpellGroups(flat) {
  const spellKp = findSpellKeyPointIn(flat);
  if (spellKp !== null) {
    const structured = spellKp.spellGroups ?? spellKp.spellText ?? spellKp.spell;
    if (Array.isArray(structured) && structured.length === 4 && structured.every((group) => typeof group === "string" && group.trim().length > 0)) {
      return { groups: structured.map((group) => group.trim()), source: "keypoint" };
    }
    if (typeof structured === "string" && structured.trim().length > 0) {
      const groups = parseSpellGroups(structured);
      if (groups !== null) return { groups, source: "keypoint" };
    }
  }

  const text = String(flat?.scenario?.text ?? "");
  if (text.trim().length === 0) return null;

  // 优先在包含“咒”字的行里找，避免把普通排比句误判成咒文。
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.length > 600) continue;
    if (!/咒/.test(line)) continue;
    const groups = parseSpellGroups(line);
    if (groups !== null) return { groups, source: "scenario" };
  }

  // 兜底：全文扫描（某些 PDF 把咒文单独成段，前后不含“咒”字）。
  const groups = parseSpellGroups(text);
  return groups !== null ? { groups, source: "scenario" } : null;
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 构造“玩家完整念诵咒文”的正向/逆向识别正则。
 * @param {string[]} groups
 * @returns {{ forward: RegExp, inverse: RegExp }|null}
 */
export function buildSpellRecognition(groups) {
  if (!Array.isArray(groups) || groups.length !== 4) return null;
  const separator = "[、，,\\s]*";
  const forward = new RegExp(groups.map(escapeRegExp).join(separator));
  const inverse = new RegExp([...groups].reverse().map(escapeRegExp).join(separator));
  return { forward, inverse };
}

/**
 * 渲染玩家可见的咒文展示行。只陈述咒文与倒序，不做任何剧本专属解读。
 * @param {string[]} groups
 * @returns {string}
 */
export function formatSpellDisplay(groups) {
  const forward = groups.join("、");
  const inverse = [...groups].reverse().join("、");
  return `【系统】已获得十二字咒文：${forward}。倒序：${inverse}。`;
}

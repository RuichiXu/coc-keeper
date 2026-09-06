/**
 * 标题行识别规则（确定性，场景切分与结构分析共用）。
 *
 * 统一 splitScenarioSections（严格切分）与 structure-analysis（宽松候选）的
 * 标题判定，避免两处规则漂移。纯函数，零 DSH 依赖。
 */

export const PAGE_MARKER_RE = /^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/i;

const COLON_KEYWORD_RE =
  /(?:章|幕|节|附录|房间|卧室|书房|走廊|客厅|餐厅|厨房|旅舍|酒店|酒馆|教堂|警局|医院|工厂|码头|仓库|宅邸|城堡|图书馆|书店|商店|古董|森林|湖|桥|塔|楼|层|地区|镇|村|城市|广场|剧院|报社|事务所)/;

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

export function isPageNumberLine(line) {
  const text = nonEmptyString(line);
  return /^\d{1,3}$/.test(text);
}

export function isPageMarkerLine(line) {
  return PAGE_MARKER_RE.test(nonEmptyString(line));
}

/** 目录点线行（如“人物关系图谱----- 11”），不应参与残句合并。 */
export function isDashedTocLine(line) {
  const text = nonEmptyString(line);
  return /-{5,}/.test(text) && /\d{1,3}\s*$/.test(text);
}

/**
 * 编号标题：`5.6 约翰的书斋`、`附录 1.2.2 对手`。
 * strict=true 时排除表格行、年份正文等（用于确定性切分）。
 */
export function looksLikeNumberedHeading(line, options = {}) {
  const text = nonEmptyString(line);
  if (!/^[0-9]+(?:\.[0-9]+)*\s+\S/.test(text)) return false;
  if (/\.{3,}/.test(text)) return false; // 目录点线
  if (/[。！？；，]/.test(text)) return false; // 带句读的是正文（如年份事件行）
  if (/^[0-9]{4}\s*[年月日]/.test(text)) return false; // 1892 年… 是正文
  if (text.length > 40) return false;
  if (options.strict === true) {
    const rest = text.replace(/^[0-9]+(?:\.[0-9]+)*\s+/, "");
    if (rest.length < 2) return false; // 排除“1 轮”“9 8”这类正文短行
    if (/\s/.test(rest)) return false; // 排除“18 祭司之主 轩 辕 …”这类表格行
  }
  return true;
}

/** 附录标题：`附录 1 地图`、`附录 1.2.2 对手`。 */
export function looksLikeAppendixHeading(line, options = {}) {
  const text = nonEmptyString(line);
  if (!/^附录(?:\s*[0-9]+(?:\.[0-9]+)*)?(?:\s+\S+)?$/.test(text)) return false;
  if (text.length > 30) return false;
  if (options.strict === true && /\.{3,}/.test(text)) return false;
  return true;
}

/** 独立结局行（如“结局1（BE）”“END 2”）。 */
export function looksLikeEndingHeading(line) {
  const text = nonEmptyString(line);
  return (
    /^(?:结局\s*[一二三四五六七八九十\d]*|END\s*\d*|BAD\s*END|GOOD\s*END|TRUE\s*END)(?:[（(].*[）)])?$/i.test(text) &&
    text.length <= 20
  );
}

/**
 * 短冒号标题。requireKeyword=true 时只认包含章节/地点类关键词的冒号短行，
 * 供确定性切分使用；结构分析候选可放宽为任意短冒号行。
 */
export function looksLikeColonHeading(line, options = {}) {
  const text = nonEmptyString(line);
  if (!/^[^。！？…，,；;]{1,12}[：:]\s*$/.test(text) || text.length > 13) return false;
  if (options.requireKeyword === true) return COLON_KEYWORD_RE.test(text);
  return true;
}

/**
 * 项目符号式章节标题：`- ◆ 舞动的皮`、`◆ 其他人的船`。
 * 只认实心符号（◆◇●■），不碰 `- z` 这类普通 bullet 条目。
 */
export function looksLikeBulletSectionHeading(line) {
  const text = nonEmptyString(line);
  if (text.length > 30) return false;
  if (!/^[-–—\t ]{0,4}[◆◇●■]\s*\S/.test(text)) return false;
  if (/[。！？；…，,；;]$/.test(text)) return false;
  return true;
}

/**
 * 裸露短标题：2–16 字、含汉字、无句读、非页码/目录线。
 * 仅凭行内容判断，是否真正成节由调用方结合上下文决定。
 */
export function looksLikeBareHeading(line) {
  const text = nonEmptyString(line);
  if (text.length < 2 || text.length > 16) return false;
  if (!/[\u4e00-\u9fa5]/.test(text)) return false;
  if (/[。！？；：…，,；;、]/.test(text)) return false;
  if (/[）)】」』>》]$/.test(text)) return false;
  if (isPageNumberLine(text) || isDashedTocLine(text) || isPageMarkerLine(text)) return false;
  // 常见句首功能词/代词不是标题。
  if (/^(?:如果|当|在|但|而|与|或|及|并|可|让|被|把|由|从|对|向|为|给|和|他|她|它|你|我|这|那|是|有|会|能|要|就|都|也|还|再|又|只|个|些|次|件|份|点|条|位|名|家|这|那|每|各|某|另|该|本|此|其|之|的|得|地|了|着|过|呢|吗|吧|啊|嘛|哦|嗯|呀|啦|哇|哈)$/.test(text)) return false;
  return true;
}

/** 基础标题判定（不含裸露短标题），供结构分析候选/窗口切分使用。 */
export function looksLikeHeadingBasic(line, options = {}) {
  return (
    looksLikeNumberedHeading(line, options) ||
    looksLikeAppendixHeading(line, options) ||
    looksLikeEndingHeading(line) ||
    looksLikeColonHeading(line, options) ||
    looksLikeBulletSectionHeading(line)
  );
}

/**
 * 确定性切分用标题判定：
 * - 基础标题（编号/附录/结局/冒号/◆ 项目符号）总是标题；
 * - 裸露短标题仅在“后随标题、页码、页标记或另一裸露短标题”时视为标题，
 *   避免把正文残句误切成节。
 *
 * @param {string} line 当前行
 * @param {string|null} nextSignificant 下一个非空行（页标记行可传入原文）
 * @param {object} [options]
 * @returns {boolean}
 */
export function looksLikeHeadingForSplit(line, nextSignificant, options = {}) {
  const current = nonEmptyString(line);
  if (looksLikeHeadingBasic(current, options)) return true;
  if (!looksLikeBareHeading(current)) return false;
  if (nextSignificant === null || nextSignificant === undefined) return false;
  const next = nonEmptyString(nextSignificant);
  return (
    looksLikeHeadingBasic(next, options) ||
    looksLikeBareHeading(next) ||
    isPageMarkerLine(next) ||
    isPageNumberLine(next)
  );
}

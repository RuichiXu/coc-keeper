/**
 * 剧本结构分析管线（待办 #1/#2）
 *
 * 流程：确定性清洗 → LLM 输出结构描述（边界/层级/kind/flowRole/displayName/desc）
 * → 按 startLine/endLine 确定性切片（ownLines/bodyLines）→ 层级路由写入 flat。
 *
 * 纯函数，零 DSH 依赖；LLM 调用由导入流程注入结果，本模块不直接调用模型。
 */

import { extractJsonObject } from "./deep-parse.js";
import {
  FACT_LINE_RE,
  classifyFloor,
  collectKeywords,
  extractCheckpointsFromBlocks,
  splitScenarioSections,
} from "./scene-facts.js";
import { buildCheckpointBranches } from "./deterministic-skeleton.js";

// ── 常量 ──────────────────────────────────────────────────

export const STRUCTURE_KINDS = Object.freeze([
  "chapter",
  "scene",
  "scene_event",
  "facts",
  "module_notes",
  "chapter_notes",
  "rules",
  "appendix",
  "meta",
]);

export const FLOW_ROLES = Object.freeze(["main", "side", "clue"]);

const KIND_SET = new Set(STRUCTURE_KINDS);
const FLOW_ROLE_SET = new Set(FLOW_ROLES);
const SCENE_KINDS = new Set(["scene", "scene_event"]);
const ROUTED_NOTE_KINDS = new Set(["module_notes", "chapter_notes", "rules", "appendix"]);

const PAGE_MARKER_RE = /^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/i;

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

/**
 * 与 scene-facts 的标题识别保持一致：候选标题行不参与残句合并，
 * 也用于在显示行上提取结构候选（保留真实行号）。
 */
function looksLikeHeading(line) {
  if (/^[0-9]+(?:\.[0-9]+)*\s+\S/.test(line) && !/[。！？；，]/.test(line) && line.length <= 40) return true;
  if (/^附录(?:\s*[0-9]+(?:\.[0-9]+)*)?(?:\s+\S+)?$/.test(line) && line.length <= 30) return true;
  if (/^(?:结局\s*[一二三四五六七八九十\d]*|END\s*\d*|BAD\s*END|GOOD\s*END|TRUE\s*END)(?:[（(].*[）)])?$/i.test(line) && line.length <= 20) return true;
  if (/^[^。！？…，,；;]{1,12}[：:]\s*$/.test(line) && line.length <= 13) return true;
  return false;
}

function isObject(value) {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

// ── 确定性清洗 ────────────────────────────────────────────

/**
 * 把原文清洗为“保留真实行号”的显示行。
 * - 页码标记行原位置替换为空串（行号不变）。
 * - 短残句（≤6 字且上一行未以句末标点结尾）并入上一显示行，修复 PDF 把
 *   标题/短语拆到行尾的换行残句；显示行行号取首个原始行号。
 * - 空行与页码行不进入显示行（行号跳号），切片时仍按原始 rawLines 完整切。
 *
 * @param {string} text
 * @returns {{ rawLines: string[], displayLines: Array<{lineNo:number,rawFrom:number,rawTo:number,text:string}>, displayLineByNo: Map<number,object>, lineNos: number[], firstLineNo: number, lastLineNo: number, totalRawLines: number }}
 */
export function cleanScenarioText(text) {
  const sourceLines = String(text ?? "").split(/\r?\n/);
  const rawLines = sourceLines.map((line) => {
    const trimmed = line.trim();
    return PAGE_MARKER_RE.test(trimmed) ? "" : trimmed;
  });

  const displayLines = [];
  const displayLineByNo = new Map();
  let pending = null;

  const pushPending = () => {
    if (pending === null) return;
    displayLines.push({ ...pending });
    displayLineByNo.set(pending.lineNo, displayLines[displayLines.length - 1]);
    pending = null;
  };

  for (let index = 0; index < rawLines.length; index += 1) {
    const textLine = rawLines[index].trim();
    if (textLine.length === 0) continue;
    const lineNo = index + 1;

    if (pending === null) {
      pending = { lineNo, rawFrom: lineNo, rawTo: lineNo, text: textLine };
      continue;
    }

    const canMerge =
      textLine.length <= 6 &&
      !looksLikeHeading(pending.text) &&
      !looksLikeHeading(textLine) &&
      !/[。！？；：…]$/.test(pending.text) &&
      pending.text.length + textLine.length <= 120;
    if (canMerge) {
      pending.text = pending.text + textLine;
      pending.rawTo = lineNo;
    } else {
      pushPending();
      pending = { lineNo, rawFrom: lineNo, rawTo: lineNo, text: textLine };
    }
  }
  pushPending();

  const lineNos = displayLines.map((line) => line.lineNo);
  return {
    rawLines,
    displayLines,
    displayLineByNo,
    lineNos,
    firstLineNo: lineNos.length > 0 ? lineNos[0] : 1,
    lastLineNo: lineNos.length > 0 ? lineNos[lineNos.length - 1] : Math.max(1, rawLines.length),
    totalRawLines: rawLines.length,
  };
}

// ── 结构分析 Prompt ───────────────────────────────────────

function headingCandidates(doc, maxSnippetTotal = 120000) {
  const candidates = [];
  let budget = 0;
  for (let index = 0; index < doc.displayLines.length; index += 1) {
    const line = doc.displayLines[index];
    if (!looksLikeHeading(line.text)) continue;
    // 标题后紧跟的显示行作为文首摘要（合并行可能包含正文开头）。
    const snippet = [];
    let snippetLength = 0;
    for (let cursor = index + 1; cursor < doc.displayLines.length && snippetLength < 300; cursor += 1) {
      const nextLine = doc.displayLines[cursor];
      if (looksLikeHeading(nextLine.text)) break;
      snippet.push(nextLine.text);
      snippetLength += nextLine.text.length;
    }
    const heading = line.text.replace(/[：:]\s*$/, "").trim();
    const bodyHead = snippet.join("\n").slice(0, 300);
    const entry = { line: line.lineNo, heading, bodyHead };
    const cost = heading.length + bodyHead.length + 8;
    if (budget + cost > maxSnippetTotal && candidates.length > 0) break;
    candidates.push(entry);
    budget += cost;
  }
  return candidates;
}

/**
 * 构建结构分析 Prompt：LLM 只输出边界与元信息，不复制正文。
 * 小文本直接给带行号的全文；大文本给确定性候选标题 + 文首摘要。
 *
 * @param {object} doc - cleanScenarioText 结果
 * @param {string} scenarioName
 * @returns {string}
 */
export function buildStructureAnalysisPrompt(doc, scenarioName) {
  const name = scenarioName || "剧本";
  const fullText = doc.rawLines
    .map((line, index) => `[${index + 1}] ${line}`)
    .join("\n");

  const schemaExample = {
    format: "numbered|labeled|mixed",
    sections: [
      {
        id: "s1",
        title: "原标题（从原文标题行抄录，去编号）",
        displayName: "概括名（1-8 字，可脱离原文独立存在）",
        kind: "chapter|scene|scene_event|facts|module_notes|chapter_notes|rules|appendix|meta",
        level: 1,
        parentId: null,
        flowRole: "main|side|clue（仅 scene/scene_event 填写，其余为 null）",
        desc: "1-2 句概括描述",
        startLine: 1,
        endLine: 12,
        page: 3,
        order: 1,
        note: "可选：异常说明",
      },
    ],
  };

  const rules = [
    `你是 CoC 跑团剧本的结构分析师。请阅读剧本《${name}》，只输出一个 JSON 对象（不要 Markdown 代码块），字段为 format 与 sections。`,
    `format：剧本结构类型。numbered=编号标题为主（如 5.6 约翰的书斋）；labeled=标签/地点标题为主（如 地点一：码头仓库）；mixed=两者混合。`,
    `kind 定义：`,
    `- chapter：幕/章/部/正文 这类只作容器的章节；`,
    `- scene：具体可进入调查的场景地点；`,
    `- scene_event：场景内的事件节点（接到电话/遭遇/回忆/结局小节等）；`,
    `- facts：背景/世界观/人物设定/线索资料等非场景事实；`,
    `- module_notes：模组级 KP 须知（给守秘人的运行说明）；`,
    `- chapter_notes：章节级 KP 须知（挂所属章节）；`,
    `- rules：特殊机制/规则（理智机制、仪式规则、追逐、机关等）；`,
    `- appendix：附录资料（NPC 数据、表格、地图说明、预生成角色等）；`,
    `- meta：版权/目录/作者信息/版本记录（不进入运行时）。`,
    `flowRole 只允许在 kind=scene / scene_event 上填：main=主线场景，side=支线可选场景，clue=线索调查场景。`,
    `嵌套规则：`,
    `1. 父节 range 必须包含子节 range（startLine/endLine 用下方文本出现的行号）。`,
    `2. 线索/信息/机制等子块必须挂到最近父级，不允许提升为顶级；同名通用标题（如“线索”“信息”）必须用父级前缀消歧（displayName 写“柳屋-线索”）。`,
    `3. 编号剧本若文本顺序与编号语义冲突（如 5.5.1 排在 5.6 之后），按编号语义归父，并在 note 里注明文本顺序异常。`,
    `4. sections 必须覆盖全文：首个 section 的 startLine 必须是第一行行号，末个 section 的 endLine 必须是最后一行行号；相邻 section 不得留空档。`,
    `5. 每个 section 必须有 title（原文标题，去编号）与 displayName（概括名）；desc 写 1-2 句该节内容概括，不要复制正文。`,
    `6. startLine/endLine 只能是下面文本里出现的行号；切片用，宁多勿少。`,
    `7. 输出 sections 数组按阅读顺序排列，order 从 1 递增。`,
  ];

  if (fullText.length <= 40000) {
    return [
      ...rules,
      `下方是带行号的剧本全文：`,
      fullText,
      ``,
      `请输出 JSON：${JSON.stringify(schemaExample)}`,
    ].join("\n");
  }

  const candidates = headingCandidates(doc);
  const candidateText = candidates
    .map((candidate) => `[${candidate.line}] ${candidate.heading}\n    摘要：${candidate.bodyHead.slice(0, 240)}`)
    .join("\n");
  return [
    ...rules,
    `剧本《${name}》文本较长（${doc.totalRawLines} 行），下方是确定性预筛的标题候选与各标题后文首摘要（行号均为真实行号）。`,
    `请基于候选与摘要确定 sections 边界；startLine/endLine 用候选里的行号（或候选附近的真实行号，必须是下方出现的行号）。`,
    `若候选缺少某个标题，可以在合理位置补充一个 section，startLine 用相邻候选行号（仍是真实行号）。`,
    ``,
    candidateText.length > 0 ? candidateText : `（无候选，全文前 40000 字符）\n${fullText.slice(0, 40000)}`,
    ``,
    `请输出 JSON：${JSON.stringify(schemaExample)}`,
  ].join("\n");
}

// ── 解析与归一化 ──────────────────────────────────────────

function clampToDisplayLine(doc, value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  if (doc.displayLineByNo.has(number)) return number;
  const lineNos = doc.lineNos;
  // 起始行向下取邻近显示行（不小于请求值）；结束行向上取邻近显示行。
  let best = lineNos[0] ?? fallback;
  for (const lineNo of lineNos) {
    if (lineNo <= number) best = lineNo;
    else break;
  }
  return best;
}

function clampToDisplayLineEnd(doc, value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  if (doc.displayLineByNo.has(number)) return number;
  const lineNos = doc.lineNos;
  for (const lineNo of lineNos) {
    if (lineNo >= number) return lineNo;
  }
  return lineNos[lineNos.length - 1] ?? fallback;
}

function nextDisplayLineAfter(doc, lineNo) {
  for (const current of doc.lineNos) {
    if (current > lineNo) return current;
  }
  return null;
}

function normalizeSection(raw, index) {
  const kind = KIND_SET.has(raw?.kind) ? raw.kind : "module_notes";
  const isScene = SCENE_KINDS.has(kind);
  const flowRole =
    isScene && FLOW_ROLE_SET.has(raw?.flowRole)
      ? raw.flowRole
      : isScene
        ? "main"
        : null;
  const title = nonEmptyString(raw?.title) || (isScene ? `场景 ${index + 1}` : `区块 ${index + 1}`);
  const displayName = nonEmptyString(raw?.displayName) || title;
  const desc = nonEmptyString(raw?.desc);
  return {
    id: nonEmptyString(raw?.id) || `s${index + 1}`,
    title,
    displayName,
    kind,
    flowRole,
    desc,
    startLine: null,
    endLine: null,
    rawStartLine: Number(raw?.startLine),
    rawEndLine: Number(raw?.endLine),
    parentId: nonEmptyString(raw?.parentId) || null,
    page: Number.isFinite(Number(raw?.page)) ? Number(raw.page) : null,
    order: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : index + 1,
    note: nonEmptyString(raw?.note),
    level: Number.isFinite(Number(raw?.level)) ? Number(raw.level) : 1,
  };
}

/**
 * 解析 LLM 结构描述并归一化为 coverage 完整、父子范围合法的 sections。
 * 不依赖 LLM 输出完美：行号会就近修正，空档会并入前一节；同级重叠会
 * 在不破坏嵌套的前提下后移，父节 range 始终包含子节。
 *
 * @param {string} rawText - LLM 原始输出
 * @param {object} doc - cleanScenarioText 结果
 * @returns {{ format: string, sections: Array<object> }}
 */
export function parseStructureAnalysisResult(rawText, doc) {
  const parsed = extractJsonObject(rawText);
  const format = nonEmptyString(parsed?.format) || "mixed";
  const rawSections = Array.isArray(parsed?.sections)
    ? parsed.sections
    : Array.isArray(parsed)
      ? parsed
      : [];
  if (rawSections.length === 0) return { format, sections: [] };

  const sections = rawSections.map((raw, index) => normalizeSection(raw, index));
  const fallbackStart = doc.firstLineNo;
  const fallbackEnd = doc.lastLineNo;

  sections.sort(
    (a, b) =>
      (Number.isFinite(a.rawStartLine) ? a.rawStartLine : fallbackStart) -
        (Number.isFinite(b.rawStartLine) ? b.rawStartLine : fallbackStart) ||
      (Number.isFinite(b.rawEndLine) ? b.rawEndLine : fallbackEnd) -
        (Number.isFinite(a.rawEndLine) ? a.rawEndLine : fallbackEnd) ||
      a.order - b.order
  );

  for (const section of sections) {
    section.startLine = clampToDisplayLine(doc, section.rawStartLine, fallbackStart);
    section.endLine = clampToDisplayLineEnd(doc, section.rawEndLine, fallbackEnd);
    if (section.endLine < section.startLine) section.endLine = section.startLine;
  }

  if (sections[0] !== undefined) sections[0].startLine = fallbackStart;

  // 先做一轮父子范围校验（范围不相交的父节引用重挂到最近包含祖先）。
  reparentSections(sections);

  // 同级重叠修复：同父的直接子节按阅读顺序后移，不允许重叠；嵌套不受影响。
  repairSiblingOverlaps(sections, doc);

  // 修复后父节 range 可能变化，再次重挂不包含的父子关系。
  reparentSections(sections);

  // 覆盖空档：把未被任何 section 覆盖的显示行并入前一节。
  fillCoverageGaps(sections, doc);
  if (sections[0] !== undefined) sections[0].startLine = fallbackStart;

  // 最后按真实层级重算 level/order。
  const byId = new Map(sections.map((section) => [section.id, section]));
  for (const section of sections) {
    let depth = 0;
    let cursor = section;
    const guard = new Set();
    while (cursor.parentId !== null && byId.has(cursor.parentId) && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      cursor = byId.get(cursor.parentId);
      depth += 1;
      if (depth > 32) break;
    }
    section.level = depth + 1;
    section.order = Number.isFinite(Number(section.order)) ? Number(section.order) : sections.indexOf(section) + 1;
  }

  sections.sort((a, b) => a.startLine - b.startLine || a.order - b.order);
  return { format, sections };
}

// ── 窗口分片结构分析（按行号窗口生成 → 确定性合并）────────────

/**
 * 把显示行划分为若干窗口，窗口边界尽量落在标题行上，避免把 section 从
 * 标题处切断。返回窗口的显示行号范围（真实文件行号）。
 */
export function buildStructureWindowPlan(doc, options = {}) {
  const maxLines = Math.max(60, Number(options.maxLines) || 400);
  const minLines = Math.max(20, Number(options.minLines) || Math.floor(maxLines * 0.6));
  const lines = doc.displayLines;
  const windows = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const idealEnd = Math.min(lines.length - 1, cursor + maxLines - 1);
    let cut = -1;
    for (let index = idealEnd; index >= cursor + minLines; index -= 1) {
      if (looksLikeHeading(lines[index].text)) {
        cut = index - 1;
        break;
      }
    }
    if (cut < cursor) {
      // 后段没有标题时尽量前向找到下一个标题再切，避免把 section 从正文中间切断。
      const forwardLimit = Math.min(lines.length - 1, cursor + Math.floor(maxLines * 1.5));
      for (let index = idealEnd + 1; index <= forwardLimit; index += 1) {
        if (looksLikeHeading(lines[index].text)) {
          cut = index - 1;
          break;
        }
      }
    }
    const end = cut >= cursor ? cut : idealEnd;
    windows.push({
      index: windows.length,
      startLine: lines[cursor].lineNo,
      endLine: lines[end].lineNo,
      startIdx: cursor,
      endIdx: end,
    });
    cursor = end + 1;
  }
  for (const window of windows) window.total = windows.length;
  return windows;
}

/**
 * 单个窗口的结构分析 Prompt。
 */
export function buildStructureWindowPrompt(doc, window, scenarioName, options = {}) {
  const name = scenarioName || "剧本";
  const lines = doc.displayLines.slice(window.startIdx, window.endIdx + 1);
  const compactExample =
    `{"sections":[{"i":"s1","t":"原标题","n":"概括名","k":"sc","l":1,"f":"m","d":"1-2句概括","s":${window.startLine},"e":${window.endLine},"o":1}]}`;
  const rules = [
    `你是 CoC 跑团剧本结构分析师。剧本《${name}》窗口 ${window.index + 1}/${window.total}（行号 ${window.startLine}–${window.endLine}）。只输出一个 JSON 对象（不要 Markdown），格式：`,
    compactExample,
    `字段：i=局部id；t=原标题(去编号)；n=概括名(1-8字)；k=类型；l=层级(1章幕/2子场景房间/3房间内事件)；f=flowRole；d=1-2句概括；s=起始行；e=结束行；o=顺序。`,
    `k 取值：ch=章节容器 sc=场景 se=场景事件 fa=背景设定 mn=模组须知 cn=章节须知 ru=规则 ap=附录 me=版权目录。`,
    `f 仅 sc/se 填写：m=主线 s=支线 c=线索；其余类型省略 f。`,
    `规则：sections 必须覆盖本窗口全部行号（首个 s=${window.startLine}，末个 e=${window.endLine}），相邻不重叠不留空档；s/e 只能是下方出现的行号；同名通用标题 n 用父级前缀消歧。`,
    ...(options.previousSectionTitle
      ? [`上一窗口最后 section 是「${options.previousSectionTitle}」。若本窗口首行不是新标题，把它并入一个与上一 section 同 t 的 section，s 填本窗口首行行号。`]
      : []),
    `本窗口文本：`,
    lines.map((line) => `[${line.lineNo}] ${line.text}`).join("\n"),
    `输出 JSON。`,
  ];
  return rules.join("\n");
}

/**
 * 解析单个窗口的结构描述。
 */
export function parseStructureWindowResult(rawText, doc, window) {
  const parsed = extractJsonObject(rawText);
  const format = nonEmptyString(parsed?.format) || "mixed";
  const rawSections = Array.isArray(parsed?.sections)
    ? parsed.sections
    : Array.isArray(parsed)
      ? parsed
      : [];
  if (rawSections.length === 0) return { format, sections: [] };

  // 兼容紧凑键：i/t/n/k/l/f/d/s/e/o → id/title/displayName/kind/level/flowRole/desc/startLine/endLine/order
  const KIND_ALIASES = { ch: "chapter", sc: "scene", se: "scene_event", fa: "facts", mn: "module_notes", cn: "chapter_notes", ru: "rules", ap: "appendix", me: "meta" };
  const FLOW_ALIASES = { m: "main", s: "side", c: "clue" };
  const sections = rawSections.map((raw, index) => {
    if (raw === null || typeof raw !== "object") return normalizeSection(raw, index);
    const mapped = {
      id: raw.i ?? raw.id,
      title: raw.t ?? raw.title,
      displayName: raw.n ?? raw.displayName,
      kind: KIND_ALIASES[raw.k] ?? raw.k ?? raw.kind,
      level: raw.l ?? raw.level,
      flowRole: FLOW_ALIASES[raw.f] ?? raw.f ?? raw.flowRole,
      desc: raw.d ?? raw.desc,
      startLine: raw.s ?? raw.startLine,
      endLine: raw.e ?? raw.endLine,
      order: raw.o ?? raw.order,
      page: raw.p ?? raw.page,
      note: raw.note,
      parentId: raw.pid ?? raw.parentId,
    };
    return normalizeSection(mapped, index);
  });
  sections.sort((a, b) => (a.rawStartLine || window.startLine) - (b.rawStartLine || window.startLine) || a.order - b.order);

  for (const section of sections) {
    section.startLine = clampToDisplayLine(doc, section.rawStartLine, window.startLine);
    section.endLine = clampToDisplayLineEnd(doc, section.rawEndLine, window.endLine);
    if (section.startLine < window.startLine) section.startLine = window.startLine;
    if (section.endLine > window.endLine) section.endLine = window.endLine;
    if (section.endLine < section.startLine) section.endLine = section.startLine;
  }

  if (sections[0] !== undefined) sections[0].startLine = window.startLine;
  if (sections[sections.length - 1] !== undefined) sections[sections.length - 1].endLine = window.endLine;

  for (let index = 1; index < sections.length; index += 1) {
    const prev = sections[index - 1];
    const current = sections[index];
    if (current.startLine <= prev.endLine) {
      const nextLine = nextDisplayLineAfter(doc, prev.endLine);
      if (nextLine === null || nextLine > window.endLine) {
        sections.splice(index, 1);
        index -= 1;
        continue;
      }
      current.startLine = nextLine;
      if (current.endLine < current.startLine) current.endLine = current.startLine;
    }
  }
  if (sections[sections.length - 1] !== undefined) sections[sections.length - 1].endLine = window.endLine;
  return { format, sections };
}

/**
 * 合并所有窗口的 sections 并做确定性归一。
 */
export function mergeStructureWindowResults(doc, windowResults) {
  const all = [];
  for (const result of windowResults) {
    for (const section of result.sections ?? []) {
      all.push({ ...section, _windowIndex: result._windowIndex });
    }
  }
  if (all.length === 0) return { format: "mixed", sections: [] };

  for (let index = 0; index < all.length; index += 1) {
    const section = all[index];
    const localId = nonEmptyString(section.id) || `s${index + 1}`;
    section.id = `w${section._windowIndex}-${localId}`;
  }
  all.sort((a, b) => a.startLine - b.startLine || a.order - b.order);

  const merged = [];
  for (const section of all) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && sameTitle(prev.title, section.title) && section.startLine <= prev.endLine + 1) {
      prev.endLine = Math.max(prev.endLine, section.endLine);
      if (nonEmptyString(section.desc).length > nonEmptyString(prev.desc).length) prev.desc = section.desc;
      if (nonEmptyString(section.displayName).length > nonEmptyString(prev.displayName).length) prev.displayName = section.displayName;
      continue;
    }
    merged.push(section);
  }

  if (merged[0] !== undefined) merged[0].startLine = doc.firstLineNo;
  if (merged[merged.length - 1] !== undefined) merged[merged.length - 1].endLine = doc.lastLineNo;

  for (let index = 1; index < merged.length; index += 1) {
    const prev = merged[index - 1];
    const current = merged[index];
    if (current.startLine <= prev.endLine) {
      const nextLine = nextDisplayLineAfter(doc, prev.endLine);
      if (nextLine === null) {
        merged.splice(index, 1);
        index -= 1;
        continue;
      }
      current.startLine = nextLine;
      if (current.endLine < current.startLine) current.endLine = current.startLine;
    }
  }
  fillCoverageGaps(merged, doc);
  if (merged[0] !== undefined) merged[0].startLine = doc.firstLineNo;
  if (merged[merged.length - 1] !== undefined) merged[merged.length - 1].endLine = doc.lastLineNo;

  const byId = new Map(merged.map((section) => [section.id, section]));
  const stack = [];
  for (const section of merged) {
    const level = Math.max(1, Math.floor(Number(section.level) || 1));
    while (stack.length >= level) stack.pop();
    let top = stack.length > 0 ? stack[stack.length - 1] : undefined;
    // 防御空洞栈：旧实现用 stack.length=level 会留下空洞，pop 后栈顶可能
    // 是 undefined，导致读取 undefined.id。这里收敛到真正非空栈顶。
    while (top === undefined && stack.length > 0) {
      stack.pop();
      top = stack.length > 0 ? stack[stack.length - 1] : undefined;
    }
    section.parentId = top !== undefined ? top.id : null;
    stack.length = level - 1;
    stack.push(section);
  }

  const childrenOf = new Map();
  for (const section of merged) {
    if (section.parentId === null) continue;
    if (!childrenOf.has(section.parentId)) childrenOf.set(section.parentId, []);
    childrenOf.get(section.parentId).push(section);
  }
  const expand = (section) => {
    let end = section.endLine;
    for (const child of childrenOf.get(section.id) ?? []) {
      const childEnd = expand(child);
      if (childEnd > end) end = childEnd;
    }
    section.endLine = end;
    return end;
  };
  for (const section of [...merged].reverse()) {
    if (section.parentId === null) expand(section);
  }

  reparentSections(merged);
  repairSiblingOverlaps(merged, doc);
  fillCoverageGaps(merged, doc);
  if (merged[0] !== undefined) merged[0].startLine = doc.firstLineNo;
  if (merged[merged.length - 1] !== undefined) merged[merged.length - 1].endLine = doc.lastLineNo;

  for (const section of merged) {
    let depth = 0;
    let cursor = section;
    const guard = new Set();
    while (cursor.parentId !== null && byId.has(cursor.parentId) && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      cursor = byId.get(cursor.parentId);
      depth += 1;
      if (depth > 32) break;
    }
    section.level = depth + 1;
    section.order = Number.isFinite(Number(section.order)) ? Number(section.order) : merged.indexOf(section) + 1;
  }

  const format = windowResults[0]?.format || "mixed";
  merged.sort((a, b) => a.startLine - b.startLine || a.order - b.order);
  return { format, sections: merged };
}

function sameTitle(a, b) {
  const norm = (value) => String(value ?? "").replace(/[\s，。：:；;、·•\-—–_]/g, "").trim();
  const na = norm(a);
  const nb = norm(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}


function reparentSections(sections) {
  const byId = new Map(sections.map((section) => [section.id, section]));
  for (const section of sections) {
    if (section.parentId !== null && byId.has(section.parentId)) {
      const parent = byId.get(section.parentId);
      if (parent !== undefined && parent !== section && parent.startLine <= section.startLine && parent.endLine >= section.endLine) {
        continue;
      }
    }
    section.parentId = findContainingAncestor(section, sections)?.id ?? null;
  }
}

function repairSiblingOverlaps(sections, doc) {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const childrenByParent = new Map();
  for (const section of sections) {
    const key = section.parentId ?? "";
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(section);
  }

  const drop = new Set();
  const visit = (parentId) => {
    const list = childrenByParent.get(parentId ?? "") ?? [];
    list.sort(
      (a, b) => a.startLine - b.startLine || (b.endLine - b.startLine) - (a.endLine - a.startLine) || a.order - b.order
    );
    let prev = null;
    for (const section of list) {
      if (drop.has(section.id)) continue;
      if (prev !== null && !drop.has(prev.id)) {
        if (section.startLine <= prev.endLine) {
          const nextLine = nextDisplayLineAfter(doc, prev.endLine);
          if (nextLine === null) {
            drop.add(section.id);
            continue;
          }
          section.startLine = nextLine;
          if (section.endLine < section.startLine) section.endLine = section.startLine;
        }
      }
      prev = section;
      visit(section.id);
    }
  };
  visit(null);

  if (drop.size > 0) {
    const droppedIds = drop;
    // 子节被丢弃时，其子节上挂到最近仍存在的包含祖先。
    const remaining = sections.filter((section) => !droppedIds.has(section.id));
    for (const section of remaining) {
      if (section.parentId !== null && droppedIds.has(section.parentId)) {
        section.parentId = findContainingAncestor(section, remaining)?.id ?? null;
      }
    }
    sections.splice(0, sections.length, ...remaining);
  }
}

function fillCoverageGaps(sections, doc) {
  if (sections.length === 0) return;
  for (const lineNo of doc.lineNos) {
    const covered = sections.some(
      (section) => section.startLine <= lineNo && section.endLine >= lineNo
    );
    if (covered) continue;
    // 找到 startLine 小于 lineNo 且 endLine 最大的 section（不越过 lineNo）。
    let target = null;
    for (const section of sections) {
      if (section.startLine < lineNo && section.endLine < lineNo) {
        if (target === null || section.endLine > target.endLine) target = section;
      }
    }
    if (target !== null) {
      target.endLine = lineNo;
    } else if (sections[0] !== undefined) {
      sections[0].startLine = lineNo;
    }
  }
}

function prevDisplayLineBefore(doc, lineNo) {
  let best = null;
  for (const current of doc.lineNos) {
    if (current < lineNo) best = current;
    else break;
  }
  return best;
}

function findContainingAncestor(section, sections) {
  let best = null;
  for (const candidate of sections) {
    if (candidate === section) continue;
    if (candidate.startLine <= section.startLine && candidate.endLine >= section.endLine) {
      if (best === null || candidate.endLine - candidate.startLine < best.endLine - best.startLine) {
        best = candidate;
      }
    }
  }
  return best;
}

// ── 确定性切片（ownLines / bodyLines）──────────────────────

function displayLineIndexesOf(doc, section) {
  const indexes = [];
  for (let index = 0; index < doc.displayLines.length; index += 1) {
    const line = doc.displayLines[index];
    if (line.lineNo >= section.startLine && line.lineNo <= section.endLine) indexes.push(index);
  }
  return indexes;
}

function rawIndexesForDisplayLine(doc, displayLine) {
  const indexes = [];
  for (let raw = displayLine.rawFrom; raw <= displayLine.rawTo; raw += 1) {
    indexes.push(raw - 1);
  }
  return indexes;
}

function rangeListToLines(rawLines, ranges) {
  const lines = [];
  for (const [from, to] of ranges) {
    for (let index = from; index <= to; index += 1) {
      const line = rawLines[index].trim();
      if (line.length > 0) lines.push(line);
    }
  }
  return lines;
}

function rangesToText(rawLines, ranges) {
  return rangeListToLines(rawLines, ranges).join("\n");
}

function groupConsecutive(indexes) {
  const sorted = [...indexes].sort((a, b) => a - b);
  const ranges = [];
  for (const index of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && index === last[1] + 1) {
      last[1] = index;
    } else {
      ranges.push([index, index]);
    }
  }
  return ranges;
}

/**
 * 为每个 section 计算 ownLines/bodyLines/ownText/bodyText/rawFrom/rawTo。
 * - bodyLines = 父节完整文本（含子节）
 * - ownLines = 父节减去所有直接子节 range，再减去本节标题显示行
 *   （标题行用于 title，不进入场景事实/节点描述）
 *
 * @param {object} doc
 * @param {Array<object>} sections - parseStructureAnalysisResult 产物
 * @returns {Array<object>}
 */
export function computeSectionTexts(doc, sections) {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const childrenOf = new Map();
  for (const section of sections) {
    if (section.parentId === null) continue;
    if (!childrenOf.has(section.parentId)) childrenOf.set(section.parentId, []);
    childrenOf.get(section.parentId).push(section);
  }

  for (const section of sections) {
    const displayIndexes = displayLineIndexesOf(doc, section);
    if (displayIndexes.length === 0) {
      section.rawFrom = section.startLine;
      section.rawTo = section.endLine;
      section.bodyLines = [];
      section.bodyText = "";
      section.ownLines = [];
      section.ownText = "";
      continue;
    }
    const firstDisplay = doc.displayLines[displayIndexes[0]];
    const lastDisplay = doc.displayLines[displayIndexes[displayIndexes.length - 1]];
    section.rawFrom = firstDisplay.rawFrom;
    section.rawTo = lastDisplay.rawTo;

    const bodyRawIndexes = new Set();
    for (const displayIndex of displayIndexes) {
      for (const rawIndex of rawIndexesForDisplayLine(doc, doc.displayLines[displayIndex])) {
        bodyRawIndexes.add(rawIndex);
      }
    }
    section.bodyLines = rangeListToLines(doc.rawLines, groupConsecutive([...bodyRawIndexes]));
    section.bodyText = section.bodyLines.join("\n");

    // own = body 减去子节 body 减去本节标题显示行（第一行）
    const ownRawIndexes = new Set(bodyRawIndexes);
    for (const rawIndex of rawIndexesForDisplayLine(doc, firstDisplay)) {
      ownRawIndexes.delete(rawIndex);
    }
    for (const child of childrenOf.get(section.id) ?? []) {
      const childIndexes = displayLineIndexesOf(doc, child);
      for (const displayIndex of childIndexes) {
        for (const rawIndex of rawIndexesForDisplayLine(doc, doc.displayLines[displayIndex])) {
          ownRawIndexes.delete(rawIndex);
        }
      }
    }
    section.ownLines = rangeListToLines(doc.rawLines, groupConsecutive([...ownRawIndexes]));
    section.ownText = section.ownLines.join("\n");
  }

  return sections;
}

// ── 层级路由 ──────────────────────────────────────────────

function firstMeaningfulLine(text, exclude = "") {
  const source = String(text ?? "");
  if (source.trim().length === 0) return "";
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length < 6) continue;
    if (exclude.length > 0 && (trimmed.includes(exclude) || exclude.includes(trimmed))) continue;
    return trimmed;
  }
  return "";
}

function buildAncestorMaps(sections) {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const parentOf = new Map(sections.map((section) => [section.id, section.parentId]));

  const nearestAncestorOfKind = (section, kind) => {
    let cursor = section;
    const guard = new Set();
    while (cursor !== null && cursor !== undefined && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      const parentId = parentOf.get(cursor.id) ?? null;
      if (parentId === null || !byId.has(parentId)) return null;
      cursor = byId.get(parentId);
      if (cursor !== undefined && cursor.kind === kind) return cursor;
    }
    return null;
  };

  const nearestAncestorOfKinds = (section, kinds) => {
    let cursor = section;
    const guard = new Set();
    while (cursor !== null && cursor !== undefined && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      const parentId = parentOf.get(cursor.id) ?? null;
      if (parentId === null || !byId.has(parentId)) return null;
      cursor = byId.get(parentId);
      if (cursor !== undefined && kinds.has(cursor.kind)) return cursor;
    }
    return null;
  };

  return { byId, parentOf, nearestAncestorOfKind, nearestAncestorOfKinds };
}

function buildSceneRelations(sections) {
  const relations = [];
  let relationIndex = 0;
  const push = (type, from, to, label) => {
    if (nonEmptyString(from).length === 0 || nonEmptyString(to).length === 0) return;
    relationIndex += 1;
    relations.push({ id: `rel-${relationIndex}`, type, from, to, label: label ?? "" });
  };

  for (const section of sections) {
    if (section.parentId === null) continue;
    push("contains", section.parentId, section.id, "包含");
    const parent = sections.find((item) => item.id === section.parentId);
    if (parent !== undefined && SCENE_KINDS.has(parent.kind) && SCENE_KINDS.has(section.kind)) {
      push("located_in", section.id, parent.id, "位于");
    }
  }

  // 同父、相邻的 scene/scene_event 之间建立 after 顺序边。
  const siblings = new Map();
  for (const section of sections) {
    if (!SCENE_KINDS.has(section.kind)) continue;
    const key = section.parentId ?? "";
    if (!siblings.has(key)) siblings.set(key, []);
    siblings.get(key).push(section);
  }
  for (const list of siblings.values()) {
    list.sort((a, b) => a.startLine - b.startLine || a.order - b.order);
    for (let index = 1; index < list.length; index += 1) {
      push("after", list[index - 1].id, list[index].id, "之后");
    }
  }
  return relations;
}

/**
 * 把结构分析结果写入 flat：
 * keyPoints / scenarioFacts / scenarioCheckpoints / kpNotes / chapterNotes /
 * specialRules / appendix / sceneRelations / scenarioStructure。
 * 返回写入统计。
 *
 * @param {object} flat
 * @param {object} doc - cleanScenarioText 结果
 * @param {{ format: string, sections: Array<object> }} result - parseStructureAnalysisResult 产物
 * @returns {{ keyPoints:number, scenarioFacts:number, checkpoints:number, kpNotes:number, chapterNotes:number, specialRules:number, appendix:number, sceneRelations:number }}
 */
export function applyStructureAnalysis(flat, doc, result) {
  const sections = computeSectionTexts(doc, result.sections ?? []);
  const { byId, nearestAncestorOfKind, nearestAncestorOfKinds } = buildAncestorMaps(sections);

  const stats = {
    keyPoints: 0,
    scenarioFacts: 0,
    checkpoints: 0,
    kpNotes: 0,
    chapterNotes: 0,
    specialRules: 0,
    appendix: 0,
    sceneRelations: 0,
  };

  flat.scenarioStructure = {
    format: result.format ?? "mixed",
    generatedAt: new Date().toISOString(),
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      displayName: section.displayName,
      kind: section.kind,
      flowRole: section.flowRole,
      desc: section.desc,
      level: section.level,
      parentId: section.parentId,
      startLine: section.startLine,
      endLine: section.endLine,
      page: section.page,
      order: section.order,
      note: section.note,
      ownText: section.ownText,
      bodyText: section.bodyText,
    })),
  };

  const kpIdBySectionId = new Map();
  const keyPoints = [];
  for (const section of sections) {
    if (!SCENE_KINDS.has(section.kind)) continue;
    const parentScene = nearestAncestorOfKinds(section, SCENE_KINDS) ?? null;
    const parentKpId = parentScene !== null ? kpIdBySectionId.get(parentScene.id) ?? null : null;
    const kpId = `kp-${keyPoints.length + 1}`;
    kpIdBySectionId.set(section.id, kpId);
    keyPoints.push({
      id: kpId,
      title: section.title,
      displayName: section.displayName || section.title,
      scene: parentScene !== null ? parentScene.title : section.title,
      parentScene: parentScene?.title ?? null,
      desc: section.desc || firstMeaningfulLine(section.ownText, section.title) || section.displayName || section.title,
      kind: section.kind,
      flowRole: section.flowRole,
      parentId: parentKpId,
      sectionId: section.id,
      order: section.order,
      page: section.page,
      level: section.level,
    });
  }
  flat.keyPoints = keyPoints;
  stats.keyPoints = keyPoints.length;

  // 场景事实卡：scene/scene_event 与 facts 都写；facts 不进剧情图（无 keyPoint）。
  const scenarioFacts = [];
  for (const section of sections) {
    if (!SCENE_KINDS.has(section.kind) && section.kind !== "facts") continue;
    const factLines = section.ownLines
      .map((line) => line.trim())
      .filter((line) => line.length >= 6 && line.length <= 240 && FACT_LINE_RE.test(line));
    scenarioFacts.push({
      heading: section.title,
      displayName: section.displayName || section.title,
      kind: section.kind,
      flowRole: section.flowRole,
      floor: classifyFloor(section.title, section.ownText),
      keywords: collectKeywords(section.title, section.ownText),
      original: section.ownText,
      facts: factLines,
      parentId: section.parentId,
      sectionId: section.id,
      order: section.order,
      page: section.page,
      level: section.level,
    });
  }
  flat.scenarioFacts = scenarioFacts;
  stats.scenarioFacts = scenarioFacts.length;

  // 显式检定点：只从场景类 section 的 ownLines 提取，避免重复与跨场景污染。
  flat.scenarioCheckpoints = extractCheckpointsFromBlocks(
    sections
      .filter((section) => SCENE_KINDS.has(section.kind))
      .map((section) => ({ heading: section.title, lines: section.ownLines }))
  );
  stats.checkpoints = flat.scenarioCheckpoints.length;

  // 确定性检定分支（不重建关键点；结构关键点已存在）。
  flat.branches = buildCheckpointBranches(flat);

  const kpNotes = [];
  const chapterNotes = [];
  const specialRules = [];
  const appendix = [];
  for (const section of sections) {
    if (section.kind === "module_notes") {
      kpNotes.push({
        id: `note-${kpNotes.length + 1}`,
        title: section.displayName || section.title,
        body: section.bodyText,
        order: section.order,
        page: section.page,
        sectionId: section.id,
      });
      continue;
    }
    if (section.kind === "chapter_notes") {
      const chapter = nearestAncestorOfKind(section, "chapter") ?? null;
      chapterNotes.push({
        id: `cnote-${chapterNotes.length + 1}`,
        title: section.displayName || section.title,
        chapterId: chapter?.id ?? null,
        chapterTitle: chapter !== null ? chapter.displayName || chapter.title : "全局",
        body: section.bodyText,
        order: section.order,
        page: section.page,
        sectionId: section.id,
      });
      continue;
    }
    if (section.kind === "rules") {
      specialRules.push({
        id: `rule-${specialRules.length + 1}`,
        title: section.displayName || section.title,
        body: section.bodyText,
        order: section.order,
        scope: section.title,
        page: section.page,
        sectionId: section.id,
      });
      continue;
    }
    if (section.kind === "appendix") {
      appendix.push({
        id: `appx-${appendix.length + 1}`,
        title: section.displayName || section.title,
        body: section.bodyText,
        order: section.order,
        page: section.page,
        sectionId: section.id,
      });
    }
  }
  flat.kpNotes = kpNotes;
  flat.chapterNotes = chapterNotes;
  flat.specialRules = specialRules;
  flat.appendix = appendix;
  stats.kpNotes = kpNotes.length;
  stats.chapterNotes = chapterNotes.length;
  stats.specialRules = specialRules.length;
  stats.appendix = appendix.length;

  flat.sceneRelations = buildSceneRelations(sections);
  stats.sceneRelations = flat.sceneRelations.length;

  return stats;
}

/**
 * 校对面板保存结构编辑（#6c）：把编辑后的 sections 同步回
 * flat.keyPoints / flat.scenarioFacts / flat.sceneRelations / flat.scenarioStructure。
 * sections 中缺失的 ownText/bodyText/startLine/endLine 等字段沿用既有结构。
 *
 * @param {object} flat
 * @param {Array<object>} rawSections
 * @returns {{ keyPoints:number, scenarioFacts:number, sceneRelations:number }}
 */
export function applyStructureEdits(flat, rawSections) {
  const existingSections = flat?.scenarioStructure?.sections ?? [];
  const existingById = new Map(existingSections.map((section) => [section.id, section]));
  const edited = asSections(rawSections).map((section) => {
    const previous = existingById.get(section.id) ?? {};
    return {
      ...previous,
      ...section,
      id: nonEmptyString(section.id) || previous.id || `s${Math.random().toString(36).slice(2, 8)}`,
      title: nonEmptyString(section.title) || previous.title || section.id,
      displayName: nonEmptyString(section.displayName) || previous.displayName || nonEmptyString(section.title) || previous.title || section.id,
      kind: KIND_SET.has(section.kind) ? section.kind : previous.kind || "module_notes",
      flowRole: SCENE_KINDS.has(section.kind) ? (FLOW_ROLE_SET.has(section.flowRole) ? section.flowRole : previous.flowRole || "main") : null,
      desc: nonEmptyString(section.desc),
      level: Number.isFinite(Number(section.level)) ? Number(section.level) : previous.level ?? 1,
      parentId: section.parentId === null ? null : nonEmptyString(section.parentId) || (previous.parentId ?? null),
      startLine: Number.isFinite(Number(section.startLine)) ? Number(section.startLine) : previous.startLine ?? 0,
      endLine: Number.isFinite(Number(section.endLine)) ? Number(section.endLine) : previous.endLine ?? 0,
      page: section.page === null ? null : Number.isFinite(Number(section.page)) ? Number(section.page) : (previous.page ?? null),
      order: Number.isFinite(Number(section.order)) ? Number(section.order) : previous.order ?? 0,
      note: nonEmptyString(section.note),
      ownText: section.ownText !== undefined ? section.ownText : previous.ownText ?? "",
      bodyText: section.bodyText !== undefined ? section.bodyText : previous.bodyText ?? "",
    };
  });
  edited.sort((a, b) => a.order - b.order || a.startLine - b.startLine);

  const { byId, nearestAncestorOfKinds } = buildAncestorMaps(edited);
  // 父子引用完整性：不存在的父引用重挂到最近包含祖先。
  for (const section of edited) {
    if (section.parentId !== null && !byId.has(section.parentId)) section.parentId = null;
  }

  const kpIdBySectionId = new Map();
  const previousKpBySectionId = new Map(
    (flat.keyPoints ?? []).map((kp) => [nonEmptyString(kp?.sectionId), kp]).filter(([id]) => id.length > 0)
  );
  const keyPoints = [];
  for (const section of edited) {
    if (!SCENE_KINDS.has(section.kind)) continue;
    const parentScene = nearestAncestorOfKinds(section, SCENE_KINDS) ?? null;
    const parentKpId = parentScene !== null ? kpIdBySectionId.get(parentScene.id) ?? null : null;
    const previous = previousKpBySectionId.get(section.id) ?? {};
    const kpId = nonEmptyString(previous.id) || `kp-${keyPoints.length + 1}`;
    kpIdBySectionId.set(section.id, kpId);
    keyPoints.push({
      ...previous,
      id: kpId,
      title: section.title,
      displayName: section.displayName || section.title,
      scene: parentScene !== null ? parentScene.title : section.title,
      parentScene: parentScene?.title ?? null,
      desc: section.desc || previous.desc || firstMeaningfulLine(section.ownText, section.title) || section.displayName || section.title,
      kind: section.kind,
      flowRole: section.flowRole,
      parentId: parentKpId,
      sectionId: section.id,
      order: section.order,
      page: section.page,
      level: section.level,
    });
  }
  flat.keyPoints = keyPoints;

  const previousFactBySectionId = new Map(
    (flat.scenarioFacts ?? []).map((fact) => [nonEmptyString(fact?.sectionId), fact]).filter(([id]) => id.length > 0)
  );
  const scenarioFacts = [];
  for (const section of edited) {
    if (!SCENE_KINDS.has(section.kind) && section.kind !== "facts") continue;
    const previous = previousFactBySectionId.get(section.id) ?? {};
    scenarioFacts.push({
      ...previous,
      heading: section.title,
      displayName: section.displayName || section.title,
      kind: section.kind,
      flowRole: section.flowRole,
      parentId: section.parentId,
      sectionId: section.id,
      order: section.order,
      page: section.page,
      level: section.level,
      original: section.ownText !== undefined ? section.ownText : previous.original ?? "",
    });
  }
  flat.scenarioFacts = scenarioFacts;

  flat.sceneRelations = buildSceneRelations(edited);
  flat.scenarioStructure = {
    format: flat.scenarioStructure?.format ?? "edited",
    generatedAt: new Date().toISOString(),
    pdfPages: flat.scenarioStructure?.pdfPages ?? [],
    sections: edited,
  };

  return { keyPoints: keyPoints.length, scenarioFacts: scenarioFacts.length, sceneRelations: flat.sceneRelations.length };
}

function asSections(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 结构分析失败时使用的确定性回退结构。
 * 保持原有 extractSceneFacts/extractCheckpoints 行为，并把切分结果封存为
 * 结构描述（sections 为确定性切分），供 #6c 面板至少能看到结构。
 *
 * @param {object} flat
 * @returns {object} stats
 */
export function applyDeterministicStructureFallback(flat) {
  const text = flat?.scenario?.text ?? "";
  const facts = [];
  const sections = splitScenarioSections(text).map((section, index) => {
    facts.push({
      heading: section.heading,
      kind: "scene",
      flowRole: "main",
      floor: classifyFloor(section.heading, section.lines.join("\n")),
      keywords: collectKeywords(section.heading, section.lines.join("\n")),
      original: section.lines.join("\n"),
      facts: section.lines.filter((line) => line.length >= 6 && line.length <= 240 && FACT_LINE_RE.test(line)),
      parentId: null,
      order: index + 1,
      startLine: section.startLine ?? index + 1,
      endLine: section.endLine ?? index + 1,
    });
    return {
      id: `s${index + 1}`,
      title: section.heading,
      displayName: section.heading,
      kind: "scene",
      flowRole: "main",
      desc: "",
      level: 1,
      parentId: null,
      startLine: section.startLine ?? index + 1,
      endLine: section.endLine ?? index + 1,
      page: null,
      order: index + 1,
      note: "确定性回退切分",
      ownText: section.lines.join("\n"),
      bodyText: section.lines.join("\n"),
    };
  });
  flat.scenarioFacts = facts;
  flat.scenarioCheckpoints = extractCheckpointsFromBlocks(
    facts.map((fact) => ({ heading: fact.heading, lines: fact.original.split("\n") }))
  );
  flat.keyPoints = facts.map((fact, index) => ({
    id: `kp-${index + 1}`,
    title: fact.heading,
    displayName: fact.heading,
    scene: fact.heading,
    parentScene: null,
    desc: firstMeaningfulLine(fact.original, fact.heading) || fact.heading,
    kind: "scene",
    flowRole: "main",
    parentId: null,
    order: index + 1,
    page: null,
    level: 1,
  }));
  flat.branches = buildCheckpointBranches(flat);
  flat.kpNotes = [];
  flat.chapterNotes = [];
  flat.specialRules = [];
  flat.appendix = [];
  flat.sceneRelations = buildSceneRelations(sections);
  flat.scenarioStructure = {
    format: "deterministic",
    generatedAt: new Date().toISOString(),
    sections,
  };
  return {
    keyPoints: flat.keyPoints.length,
    scenarioFacts: flat.scenarioFacts.length,
    checkpoints: flat.scenarioCheckpoints.length,
    kpNotes: 0,
    chapterNotes: 0,
    specialRules: 0,
    appendix: 0,
    sceneRelations: flat.sceneRelations.length,
  };
}

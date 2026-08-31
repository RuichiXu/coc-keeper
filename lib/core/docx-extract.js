/**
 * DOCX / DOC 文本提取器
 *
 * 零外部依赖，仅使用 Node.js 内置 fs 和 zlib。
 * 从旧 index.js:282-419 提取，逻辑完全保留。
 */

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// ── 最小 ZIP 读取器 ───────────────────────────────────────

/**
 * 从 ZIP 缓冲区中读取指定条目的内容。
 * 支持 store（method=0）和 deflate（method=8）。
 *
 * @param {Buffer} buffer
 * @param {string} entryName
 * @returns {Buffer}
 */
export function readZipEntry(buffer, entryName) {
  let eocd = -1;
  const minEocd = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= minEocd; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件（EOCD 签名缺失）");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  let pos = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error("ZIP 中央目录损坏");
    }
    const method = buffer.readUInt16LE(pos + 10);
    const compSize = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString("utf8", pos + 46, pos + 46 + nameLen);

    if (name === entryName) {
      const local = localOffset;
      if (buffer.readUInt32LE(local) !== 0x04034b50) {
        throw new Error("ZIP 本地文件头损坏");
      }
      const localNameLen = buffer.readUInt16LE(local + 26);
      const localExtraLen = buffer.readUInt16LE(local + 28);
      const dataStart = local + 30 + localNameLen + localExtraLen;
      const data = buffer.subarray(dataStart, dataStart + compSize);

      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`ZIP 使用不支持的压缩方式（${method}），请用 Word/WPS 另存为后再试`);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP 中缺少 ${entryName}（文件可能已损坏）`);
}

// ── DOCX 文本提取 ─────────────────────────────────────────

/**
 * 提取 DOCX 正文：拼接 word/document.xml 中所有 <w:t> 文本，段落换行。
 * @param {string} filePath
 * @returns {string}
 */
export function extractDocxText(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (error) {
    throw new Error(`读取文件失败：${error.message}`);
  }

  if (buffer.length < 4 || buffer.toString("ascii", 0, 4) !== "PK\u0003\u0004") {
    throw new Error("不是有效的 docx 文件（缺少 ZIP 头，请确认扩展名）");
  }

  let xml;
  try {
    xml = readZipEntry(buffer, "word/document.xml").toString("utf8");
  } catch (error) {
    throw new Error(`docx 解析失败：${error.message}`);
  }

  const paragraphs = xml.split(/<\/w:p>|<\/w:tr>/i);
  const lines = [];

  for (const paragraph of paragraphs) {
    const texts = [];
    const regex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi;
    let match;

    while ((match = regex.exec(paragraph)) !== null) {
      texts.push(
        match[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
      );
    }

    const line = texts.join("").replace(/\s+/g, " ").trim();
    if (line.length > 0) lines.push(line);
  }

  const text = lines.join("\n");
  if (text.trim().length === 0) {
    throw new Error("docx 未提取到可读文本（可能是纯图片文档）");
  }
  return text;
}

// ── DOC 文本提取（尽力而为） ───────────────────────────────

/**
 * 尽力而为提取老版 .doc（OLE 二进制）：扫描 UTF-16LE 可读文本片段。
 * @param {string} filePath
 * @returns {string}
 */
export function extractDocLegacyText(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (error) {
    throw new Error(`读取文件失败：${error.message}`);
  }

  const isAsciiReadable = (code) =>
    code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);

  const isCjk = (code) =>
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3400 && code <= 0x4dbf);

  const isReadable = (code) =>
    isAsciiReadable(code) || isCjk(code) || code === 0x20;

  const runs = [];
  let current = null;

  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const code = buffer.readUInt16LE(i);
    if (isReadable(code)) {
      if (current === null) current = { start: i, chars: [] };
      current.chars.push(code);
    } else if (current !== null) {
      if (current.chars.length >= 2) {
        const chunk = String.fromCharCode(...current.chars);
        const cjkCount = current.chars.filter(isCjk).length;
        const readableRatio = cjkCount > 0 ? cjkCount / current.chars.length : 1;
        if (readableRatio >= 0.5) {
          runs.push({ start: current.start, chunk });
        }
      }
      current = null;
    }
  }

  runs.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && run.start - (last.start + last.chunk.length * 2) < 8) {
      last.chunk += run.chunk;
    } else {
      merged.push({ start: run.start, chunk: run.chunk });
    }
  }

  const blocks = merged
    .filter((m) => m.chunk.length >= 8)
    .sort((a, b) => b.chunk.length - a.chunk.length);

  const best = blocks.slice(0, 12).sort((a, b) => a.start - b.start);
  const text = best.map((b) => b.chunk).join("\n");

  if (text.trim().length === 0) {
    throw new Error(
      "未能从 .doc 提取到可读文本（老版二进制格式）。请用 Word/WPS 另存为 .docx 或 .txt 后再导入"
    );
  }
  return text;
}

// ── 统一入口 ──────────────────────────────────────────────

/**
 * 提取文件文本，自动根据扩展名选择解析方式。
 * 支持 PDF（需 pdf-parse 依赖）、DOCX、DOC、TXT/MD。
 *
 * @param {string} filePath
 * @param {Function} [onProgress] - (phase, message, percent) => void
 * @returns {Promise<string>}
 */
export async function extractFileText(filePath, onProgress) {
  const lower = filePath.toLowerCase();

  if (lower.endsWith(".pdf")) {
    if (onProgress) onProgress("reading", "读取 PDF 文件中…", 10);
    let PDFParse;
    try {
      PDFParse = (await import("pdf-parse")).PDFParse;
    } catch (error) {
      throw new Error(`无法加载 PDF 解析器（pdf-parse）：${error.message}；请确认插件依赖已安装`);
    }

    let parser;
    let text;
    try {
      parser = new PDFParse({ data: readFileSync(filePath) });
      if (onProgress) onProgress("extracting", "PDF 解析中，提取文本…", 40);
      const result = await parser.getText();
      text = result?.text;
    } catch (error) {
      throw new Error(`PDF 解析失败：${error.message}`);
    } finally {
      if (parser !== undefined) await parser.destroy().catch(() => {});
    }

    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("PDF 未提取到可读文本（可能是扫描件/图片型 PDF，暂不支持 OCR）");
    }
    // 扫描件/图片型 PDF 可能只提取到 “-- 1 of 4 --” 这类页码标记：
    // 去掉页码标记后没有任何正文时，按“无文本层”给出明确反馈，而不是导入空剧本。
    const textWithoutPageMarkers = text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, "").trim();
    if (textWithoutPageMarkers.length === 0) {
      throw new Error("该 PDF 没有可提取的文本层（可能是扫描件/图片型 PDF），暂不支持解析；请提供文字版 PDF 或改用 TXT/MD/DOCX");
    }
    if (onProgress) onProgress("done", "PDF 文本提取完成", 60);
    return text;
  }

  if (lower.endsWith(".docx")) {
    if (onProgress) onProgress("reading", "读取 DOCX 文件中…", 10);
    const text = extractDocxText(filePath);
    if (onProgress) onProgress("done", "DOCX 文本提取完成", 60);
    return text;
  }

  if (lower.endsWith(".doc")) {
    if (onProgress) onProgress("reading", "读取 DOC 文件中…", 10);
    const text = extractDocLegacyText(filePath);
    if (onProgress) onProgress("done", "DOC 文本提取完成", 60);
    return text;
  }

  if (onProgress) onProgress("reading", "读取文本文件中…", 30);
  const text = readFileSync(filePath, "utf8");
  if (onProgress) onProgress("done", "文本文件读取完成", 60);
  return text;
}
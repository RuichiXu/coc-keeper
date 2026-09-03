/**
 * PDF 页面图片资产 v1（待办 #3）
 *
 * 用 pdfjs-dist + @napi-rs/canvas 把 PDF 每页渲染为 PNG，
 * 供解析页/资产页浏览。两者都是 npm 依赖，不依赖 DeepSeek Harness。
 *
 * 注意：本模块动态 import 重依赖，只有 PDF 导入时才加载。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 渲染 PDF 全部页面为 PNG。
 *
 * @param {string} filePath - PDF 文件路径
 * @param {string} outputDir - 输出目录（不存在会自动创建）
 * @param {Function} [onProgress] - (phase, message, percent) => void
 * @param {number} [scale=1.5] - 渲染缩放，越大越清晰
 * @returns {Promise<Array<{page:number,file:string,width:number,height:number}>>}
 */
export async function renderPdfPages(filePath, outputDir, onProgress = () => {}, scale = 1.5) {
  let pdfjs;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (error) {
    throw new Error(`无法加载 pdfjs-dist：${error?.message ?? error}`);
  }

  let createCanvas;
  try {
    ({ createCanvas } = await import("@napi-rs/canvas"));
  } catch (error) {
    throw new Error(`无法加载 @napi-rs/canvas：${error?.message ?? error}`);
  }

  const data = new Uint8Array(readFileSync(filePath));
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  } catch (error) {
    throw new Error(`PDF 页面渲染失败（getDocument）：${error?.message ?? error}`);
  }

  const totalPages = Math.max(1, Number(doc.numPages) || 0);
  const pages = [];
  mkdirSync(outputDir, { recursive: true });

  try {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      onProgress("pages", `PDF 页图渲染 ${pageNumber}/${totalPages}…`, 60 + Math.round((pageNumber / totalPages) * 20));
      let page;
      try {
        page = await doc.getPage(pageNumber);
      } catch (error) {
        pages.push({ page: pageNumber, file: "", width: 0, height: 0, error: String(error?.message ?? error) });
        continue;
      }
      const viewport = page.getViewport({ scale: Number(scale) || 1.5 });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      try {
        await page.render({ canvasContext: context, viewport }).promise;
        const file = join(outputDir, `page-${String(pageNumber).padStart(3, "0")}.png`);
        writeFileSync(file, canvas.toBuffer("image/png"));
        pages.push({ page: pageNumber, file, width, height });
      } catch (error) {
        pages.push({ page: pageNumber, file: "", width, height, error: String(error?.message ?? error) });
      }
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  return pages;
}

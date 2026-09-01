/**
 * 深度解析导入 loop（DSH-free，供 coc_import 使用）。
 *
 * 确定性骨架 → 分块生成局部条件 → 最终分支/结局单独生成 → preflight
 * 最多 3 轮；每轮把上一轮 high/medium 问题作为修复上下文回灌；
 * 3 轮后取最优稿（high 最少，其次 medium，再其次 low），永不因 preflight
 * 失败而跳过深度解析——只降级为 draft 并在 quality 里记录问题。
 */
import {
  buildChunkPrompt,
  buildFinalWiringPrompt,
  buildDeterministicSkeleton,
  extractFinalChoiceBranches,
  mergeChunkedDeepParseParts,
  parseDeepParseResult,
  parseSkeletonWiringResult,
  runDeepParsePreflight,
  splitDeepParseChunks,
} from "../../core/index.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textOfLlmResult(llmResult) {
  return asArray(llmResult?.blocks)
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

async function callLlmText(deps, prompt, maxTokens = 8000) {
  const llmResult = await deps.callLlmApi(
    deps.dataDir,
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    { temperature: 0, max_tokens: maxTokens }
  );
  return textOfLlmResult(llmResult);
}

function issuesToRepairText(issues) {
  const lines = asArray(issues)
    .filter((issue) => issue?.severity === "high" || issue?.severity === "medium")
    .slice(0, 20)
    .map((issue) => `- [${issue.severity}] ${issue.where}: ${issue.problem} → ${issue.suggestion ?? ""}`);
  return lines.length > 0
    ? `\n\n上一轮 preflight 发现以下问题，请只修复这些问题（不要重写已正确的部分）：\n${lines.join("\n")}`
    : "";
}

function scoreReport(report) {
  return { high: report.high, medium: report.medium, low: report.low, pass: report.pass, issues: report.issues };
}

function isBetterScore(a, b) {
  if (a.high !== b.high) return a.high < b.high;
  if (a.medium !== b.medium) return a.medium < b.medium;
  return a.low < b.low;
}

/**
 * @param {object} flat
 * @param {object} deps - { callLlmApi, dataDir }
 * @param {Function} [onProgress]
 * @returns {Promise<{deepParse: object|null, quality: object, rounds: number, status: string}>}
 */
export async function runDeepParseGenerationLoop(flat, deps, onProgress = () => {}) {
  const fallback = {
    deepParse: null,
    quality: { rounds: 0, high: 0, medium: 0, low: 0, pass: false, issues: [] },
    status: "skipped",
  };
  if (typeof deps?.callLlmApi !== "function") return fallback;

  // 确定性骨架：compileByPattern 为空时，从场景事实/检定点生成。
  if (asArray(flat?.keyPoints).length === 0 && asArray(flat?.branches).length === 0) {
    const skeleton = buildDeterministicSkeleton(flat);
    flat.keyPoints = skeleton.keyPoints;
    flat.branches = skeleton.branches;
  }
  // 追加玩家选择型最终分支（如果提取到）。
  {
    const finalChoice = extractFinalChoiceBranches(flat);
    const existingIds = new Set(asArray(flat?.branches).map((branch) => String(branch?.id ?? "")));
    for (const kp of finalChoice.keyPoints) {
      const id = String(kp?.id ?? "");
      const kpIds = new Set(asArray(flat?.keyPoints).map((item) => String(item?.id ?? "")));
      if (!kpIds.has(id)) flat.keyPoints.push(kp);
    }
    for (const branch of finalChoice.branches) {
      const id = String(branch?.id ?? "");
      if (!existingIds.has(id)) flat.branches.push(branch);
    }
  }

  const chunks = splitDeepParseChunks(flat);
  const chunkPrompts = chunks.map((chunk) => ({ chunk, prompt: buildChunkPrompt(flat, chunk) }));
  const finalPrompt = buildFinalWiringPrompt(flat, chunks);

  const maxRounds = 3;
  let best = null;
  let repairText = "";
  let passRound = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    onProgress?.("parsing", `LLM 深度解析 第 ${round}/${maxRounds} 轮…`, 80 + round * 5);
    try {
      const chunkResults = new Array(chunkPrompts.length).fill(null);
      const concurrency = 4;
      for (let start = 0; start < chunkPrompts.length; start += concurrency) {
        const batch = chunkPrompts.slice(start, start + concurrency);
        const batchResults = await Promise.all(
          batch.map(async (item, offset) => {
            const raw = await callLlmText(deps, item.prompt + repairText, 12000);
            const parsed = parseDeepParseResult(raw, flat);
            return { index: start + offset, deepParse: parsed.deepParse };
          })
        );
        for (const result of batchResults) chunkResults[result.index] = result.deepParse;
      }
      const finalRaw = await callLlmText(deps, finalPrompt + repairText, 24000);
      const finalParsed = parseSkeletonWiringResult(finalRaw, flat);
      if (finalParsed.deepParse === null) {
        repairText = "\n\n上一轮最终输出无法解析为合法 JSON，请只输出一个 JSON 对象，不要 Markdown 代码块。";
        continue;
      }
      const merged = mergeChunkedDeepParseParts(flat, chunkResults, finalParsed.deepParse);
      if (merged.deepParse === null) continue;
      const report = runDeepParsePreflight(merged.deepParse, flat);
      const score = scoreReport(report);
      if (best === null || isBetterScore(score, best.score)) {
        best = { deepParse: merged.deepParse, score, round };
      }
      if (report.pass) {
        passRound = round;
        break;
      }
      repairText = issuesToRepairText(report.issues);
    } catch (error) {
      onProgress?.("parsing", `深度解析第 ${round} 轮失败：${String(error?.message ?? error)}`, 85);
      repairText = `\n\n上一轮生成失败：${String(error?.message ?? error)}；请缩短输出并只输出合法 JSON。`;
    }
  }

  if (best === null) {
    return {
      deepParse: null,
      quality: { rounds: maxRounds, high: 0, medium: 0, low: 0, pass: false, issues: ["LLM 深度解析不可用"] },
      status: "skipped",
    };
  }

  return {
    deepParse: best.deepParse,
    quality: {
      rounds: passRound > 0 ? passRound : best.round,
      high: best.score.high,
      medium: best.score.medium,
      low: best.score.low,
      pass: best.score.pass,
      issues: best.score.issues,
    },
    status: "draft",
  };
}

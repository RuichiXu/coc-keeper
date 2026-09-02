/**
 * 深度解析导入 loop（DSH-free，供 coc_import 使用）。
 *
 * 确定性骨架 → 分块生成局部条件 → 最终分支/结局单独生成 → 合并归一
 * → preflight（结构门禁）→ 审校模型语义审校 → 针对“最终分支与结局”做修复式修订。
 *
 * 设计目标：模型无关。任何模型输出都先经过 extractJsonObject +
 * canonicalizeDeepParse + repairSkeletonWiringDeepParse 折叠成运行时 schema；
 * 第 2/3 轮不是推倒重写，而是把审校意见与 preflight 问题回灌给模型，
 * 让它只修复最终分支/结局部分（分块条件第 1 轮定稿，避免廉价模型长 prompt
 * 只烧 reasoning token 不出内容）。初始生成可以指定强模型，审校/修订默认走
 * 配置里的廉价模型。
 */
import {
  buildChunkPrompt,
  buildFinalWiringPrompt,
  buildDeterministicSkeleton,
  extractEndingParagraphs,
  extractFinalChoiceBranches,
  extractJsonObject,
  mergeChunkedDeepParseParts,
  parseDeepParseResult,
  parseSkeletonWiringResult,
  runDeepParsePreflight,
  splitDeepParseChunks,
} from "../../core/index.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

function textOfLlmResult(llmResult) {
  return asArray(llmResult?.blocks)
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

async function callLlmText(deps, prompt, options = {}) {
  const requestOptions = {
    temperature: options.temperature ?? 0,
    max_tokens: options.maxTokens ?? 8000,
    ...(options.model !== undefined && options.model !== null && String(options.model).length > 0
      ? { model: options.model }
      : {}),
    ...(options.reasoningEffort !== undefined && options.reasoningEffort !== null && String(options.reasoningEffort).length > 0
      ? { reasoningEffort: options.reasoningEffort }
      : {}),
  };
  // 网络抖动（fetch failed / 5xx）重试一次，避免 27 个分块跑完却因最终
  // 生成一次断连把整轮作废。重试只针对调用错误，不针对解析错误。
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const llmResult = await deps.callLlmApi(
        deps.dataDir,
        [{ role: "user", content: [{ type: "text", text: prompt }] }],
        requestOptions
      );
      return textOfLlmResult(llmResult);
    } catch (error) {
      lastError = error;
      if (attempt >= 2) break;
    }
  }
  throw lastError ?? new Error("LLM 调用失败");
}

/**
 * 审校/修订只关注最终分支与结局，所以骨架参考只给：
 * - 最终抉择分支（含选项原文，用于核对 optionLabel）
 * - 关键点 id:标题 速查表（用于核对 keyPointIds 引用）
 */
function effectiveFinalBranches(flat, deepParse) {
  const flatFinal = asArray(flat?.branches).filter(
    (branch) => branch?.finalChoice === true || String(branch?.id ?? "").startsWith("br-final")
  );
  const dpFinal = asArray(deepParse?.branches).filter(
    (branch) => branch?.finalChoice === true || String(branch?.id ?? "").startsWith("br-final")
  );
  if (flatFinal.length === 0) return dpFinal;
  const dpById = new Map(dpFinal.map((branch) => [String(branch?.id ?? ""), branch]));
  return flatFinal.map((branch) => {
    const dp = dpById.get(String(branch?.id ?? ""));
    // 最终分支 scene 以最终生成器为准（确定性提取的 scene 常是“剧情梗概”），
    // 但 options 以确定性骨架为准（运行时也以骨架 options 为玩家选择依据）。
    const scene = nonEmptyString(dp?.scene).length > 0 ? dp.scene : branch.scene;
    return { ...branch, scene };
  });
}

function summarizeFinalSkeleton(flat, deepParse) {
  const finalBranches = effectiveFinalBranches(flat, deepParse);
  const kpRef = asArray(flat?.keyPoints)
    .slice(0, 120)
    .map((kp) => `${nonEmptyString(kp?.id)}:${nonEmptyString(kp?.title)}`)
    .join("；");
  const sceneHeadingCounts = new Map();
  for (const fact of asArray(flat?.scenarioFacts)) {
    const heading = nonEmptyString(fact?.heading) || nonEmptyString(fact?.scene);
    if (heading.length === 0) continue;
    sceneHeadingCounts.set(heading, (sceneHeadingCounts.get(heading) ?? 0) + 1);
  }
  const sceneHeadings = [...sceneHeadingCounts.entries()]
    .slice(0, 80)
    .map(([heading, count]) => (count > 1 ? `${heading}（出现${count}次）` : heading));
  return {
    finalBranches: finalBranches.map((branch) => ({
      id: nonEmptyString(branch?.id),
      title: nonEmptyString(branch?.title),
      scene: nonEmptyString(branch?.scene),
      options: asArray(branch?.options).map((option) => ({
        label: nonEmptyString(option?.label),
        leadsTo: nonEmptyString(option?.leadsTo),
      })),
    })),
    keyPointRef: kpRef,
    sceneHeadings,
  };
}

function issueLine(issue) {
  return `- [${issue?.severity ?? "medium"}] ${issue?.where ?? "整体"}: ${issue?.problem ?? ""} → ${issue?.suggestion ?? ""}`;
}

function compactPreflight(preflightIssues) {
  const lines = asArray(preflightIssues)
    .filter((issue) => issue?.severity === "high" || issue?.severity === "medium")
    .slice(0, 20)
    .map(issueLine);
  return lines.length > 0 ? lines.join("\n") : "（无）";
}

/**
 * 语义审校 Prompt：只审校最终分支与结局。preflight 已列出的结构问题不重复报告。
 */
export function buildReviewPrompt(flat, deepParse, preflightIssues) {
  const finalBranchIds = new Set(
    [...asArray(flat?.branches), ...asArray(deepParse?.branches)]
      .filter((branch) => branch?.finalChoice === true || String(branch?.id ?? "").startsWith("br-final"))
      .map((branch) => String(branch?.id ?? ""))
  );
  const focusDraft = {
    branches: effectiveFinalBranches(flat, deepParse),
    branchConditions: asArray(deepParse?.branchConditions).filter((entry) => finalBranchIds.has(String(entry?.branchId ?? ""))),
    plotEdges: asArray(deepParse?.plotEdges).filter(
      (edge) => String(edge?.from ?? "").startsWith("br:br-final") || String(edge?.to ?? "").startsWith("end:")
    ),
    endings: asArray(deepParse?.endings),
  };
  return [
    `你是 CoC 跑团剧本深度解析的审校员。请审校下面这份“最终分支与结局”草稿是否忠实于剧本原文：结局是否覆盖完整、互斥是否成立、条件是否可用、选项与结局是否对得上。`,
    `只输出一个 JSON 对象：{"issues":[{"severity":"high","where":"endings[0].requires","problem":"...","suggestion":"..."}]}`,
    `severity 只能是 high / medium / low。`,
    `high = 会导致运行时选错结局、结局互斥失效、条件引用错误、原文结局被遗漏；`,
    `medium = 入边条件空泛、leadsTo 命中模糊、结局关键词缺失等体验问题；`,
    `low = 优化建议。`,
    `preflight 已列出的问题不要重复报告；只报告语义层面的新问题。`,
    `如果没有 high/medium 问题，issues 可以是空数组。`,
    ``,
    `剧本名：${String(flat?.scenario?.name ?? "未命名")}`,
    `最终分支骨架：${JSON.stringify(summarizeFinalSkeleton(flat, deepParse).finalBranches)}`,
    `关键点参考（id:标题）：${summarizeFinalSkeleton(flat, deepParse).keyPointRef}`,
    `场景标题清单（scene 门控只能从这里选；出现次数>1 说明多条路线共用该标题）：${JSON.stringify(summarizeFinalSkeleton(flat, deepParse).sceneHeadings)}`,
    `当前草稿：${JSON.stringify(focusDraft)}`,
    `preflight 问题：${compactPreflight(preflightIssues)}`,
    ``,
    `结局相关原文段落（权威依据）：`,
    extractEndingParagraphs(flat).map((block) => `###\n${block}`).join("\n\n").slice(0, 6000),
  ].join("\n");
}

/**
 * 修复式修订 Prompt：只输出最终分支/结局部分，不重写分块条件。
 */
export function buildRevisionPrompt(flat, deepParse, reviewIssues, preflightIssues, extraNote) {
  return [
    `你是 CoC 跑团剧本的结构化专家。请修复下面“最终分支与结局”草稿中的审校意见与 preflight 问题，输出修正后的 JSON 对象（不要 Markdown 代码块）。`,
    `只允许输出这些字段：branches / branchConditions / plotEdges / endings；不允许生成 keyPoints 或 keyPointConditions。`,
    `条件对象只允许 scene / entryEvidence / checkpointGroups / sanityEventIds / keyPointIds / branchChoiceIds / optionLabel / not。`,
    `每个结局的 requires 必须包含 branchChoiceIds:[<最终分支 id>] 和 optionLabel:<选项 label>；同一最终分支的多个结局必须完全互斥。`,
    `每个结局必须有一条 plotEdges 从 br:<最终分支 id> 指向 end:<endingId>。`,
    `checkpointGroups 只能引用真实检定点 id（chk-*）；没有合适检定点就不要用 checkpointGroups，改用 keyPointIds / not 表达状态。`,
    `如果不同结局发生在完全不同的剧情阶段（如开局拒绝、时间耗尽、最终对决），不要把它们塞进同一个最终抉择分支的并列选项里；为不同阶段分别建立分支，或给每个结局的 requires 写明阶段前置（keyPointIds / entryEvidence）。`,
    `严禁用“结局章节内部的关键点”作为该结局的 requires 前置（如结局后续的苏醒/交流/葬礼等节点），那会造成循环依赖；结局章节内的节点只能放进 endingKeywords 或 blockers。`,
    extraNote.length > 0 ? `补充说明：${extraNote}` : "",
    ``,
    `最终分支骨架：${JSON.stringify(summarizeFinalSkeleton(flat, deepParse).finalBranches)}`,
    `关键点参考（id:标题）：${summarizeFinalSkeleton(flat, deepParse).keyPointRef}`,
    `场景标题清单（scene 门控只能从这里选；出现次数>1 说明多条路线共用该标题）：${JSON.stringify(summarizeFinalSkeleton(flat, deepParse).sceneHeadings)}`,
    `当前草稿：${JSON.stringify(deepParse)}`,
    `审校意见：${reviewIssues}`,
    `preflight 问题：${compactPreflight(preflightIssues)}`,
    ``,
    `结局相关原文段落：`,
    extractEndingParagraphs(flat).map((block) => `###\n${block}`).join("\n\n").slice(0, 6000),
  ].filter((line) => line !== "").join("\n");
}

export function parseReviewResult(rawText) {
  const parsed = extractJsonObject(rawText);
  if (parsed === null || parsed === undefined) return { issues: [] };
  const issues = asArray(parsed.issues)
    .map((issue) => {
      if (issue === null || issue === undefined || typeof issue !== "object") return undefined;
      const severity = ["high", "medium", "low"].includes(issue.severity) ? issue.severity : "medium";
      const problem = nonEmptyString(issue.problem);
      if (problem.length === 0) return undefined;
      return {
        severity,
        where: nonEmptyString(issue.where) || "整体",
        problem,
        suggestion: nonEmptyString(issue.suggestion),
      };
    })
    .filter((issue) => issue !== undefined);
  return { issues };
}

function reviewScore(review) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const issue of review?.issues ?? []) {
    if (issue.severity === "high") counts.high += 1;
    else if (issue.severity === "medium") counts.medium += 1;
    else if (issue.severity === "low") counts.low += 1;
  }
  return counts;
}

function makeScore(preflight, review, reviewGate) {
  const rev = review === null || review === undefined ? null : reviewScore(review);
  return {
    preflightHigh: preflight.high,
    preflightMedium: preflight.medium,
    preflightLow: preflight.low,
    reviewHigh: rev?.high ?? 0,
    reviewMedium: rev?.medium ?? 0,
    reviewLow: rev?.low ?? 0,
    high: rev ? rev.high : preflight.high,
    medium: rev ? rev.medium : preflight.medium,
    low: rev ? rev.low : preflight.low,
    pass:
      preflight.high === 0 &&
      (rev === null || (rev.high === 0 && rev.medium <= reviewGate.medium)),
    reviewIssues: review?.issues ?? [],
    preflightIssues: preflight.issues,
  };
}

function isBetterScore(a, b) {
  if (a.preflightHigh !== b.preflightHigh) return a.preflightHigh < b.preflightHigh;
  if (a.reviewHigh !== b.reviewHigh) return a.reviewHigh < b.reviewHigh;
  if (a.reviewMedium !== b.reviewMedium) return a.reviewMedium < b.reviewMedium;
  if (a.preflightMedium !== b.preflightMedium) return a.preflightMedium < b.preflightMedium;
  return a.reviewLow + a.preflightLow < b.reviewLow + b.preflightLow;
}

function formatReviewForRevision(reviewIssues) {
  const lines = asArray(reviewIssues).map(issueLine);
  return lines.length > 0 ? lines.join("\n") : "（审校未发现语义问题）";
}

function formatPreflightForRevision(preflightIssues) {
  const lines = asArray(preflightIssues)
    .filter((issue) => issue?.severity === "high" || issue?.severity === "medium")
    .slice(0, 20)
    .map(issueLine);
  return lines.length > 0 ? lines.join("\n") : "（preflight 未发现结构问题）";
}

/**
 * @param {object} flat
 * @param {object} deps - { callLlmApi, dataDir }
 * @param {Function} [onProgress]
 * @param {object} [loopOptions]
 *   - chunkModel/chunkTemperature/chunkMaxTokens/chunkConcurrency
 *   - finalModel/finalTemperature/finalMaxTokens（初始最终分支生成）
 *   - reviewModel/reviewTemperature/reviewMaxTokens（语义审校，默认廉价模型）
 *   - revisionModel/revisionTemperature/revisionMaxTokens（第 2/3 轮修复，默认廉价模型）
 *   - maxRounds（默认 3）
 *   - reviewGate（默认 {high:0, medium:2}）
 *   - runReview（默认 true；false 时只做 preflight 三轮修复）
 * @returns {Promise<{deepParse: object|null, quality: object, rounds: number, status: string}>}
 */
export async function runDeepParseGenerationLoop(flat, deps, onProgress = () => {}, loopOptions = {}) {
  const fallback = {
    deepParse: null,
    quality: { rounds: 0, high: 0, medium: 0, low: 0, pass: false, issues: [] },
    status: "skipped",
  };
  if (typeof deps?.callLlmApi !== "function") return fallback;

  const opts = {
    chunkModel: loopOptions.chunkModel,
    chunkTemperature: loopOptions.chunkTemperature ?? 0,
    chunkMaxTokens: loopOptions.chunkMaxTokens ?? 12000,
    chunkConcurrency: loopOptions.chunkConcurrency ?? 4,
    chunkReasoningEffort: loopOptions.chunkReasoningEffort ?? "low",
    finalModel: loopOptions.finalModel,
    finalTemperature: loopOptions.finalTemperature ?? 0,
    finalMaxTokens: loopOptions.finalMaxTokens ?? 24000,
    finalReasoningEffort: loopOptions.finalReasoningEffort ?? "low",
    reviewModel: loopOptions.reviewModel,
    reviewTemperature: loopOptions.reviewTemperature ?? 0,
    reviewMaxTokens: loopOptions.reviewMaxTokens ?? 16000,
    reviewReasoningEffort: loopOptions.reviewReasoningEffort ?? "low",
    revisionModel: loopOptions.revisionModel,
    revisionTemperature: loopOptions.revisionTemperature ?? 0,
    revisionMaxTokens: loopOptions.revisionMaxTokens ?? 24000,
    revisionReasoningEffort: loopOptions.revisionReasoningEffort ?? "low",
    maxRounds: loopOptions.maxRounds ?? 3,
    reviewGate: loopOptions.reviewGate ?? { high: 0, medium: 2 },
    runReview: loopOptions.runReview !== false,
  };

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
    const kpIds = new Set(asArray(flat?.keyPoints).map((item) => String(item?.id ?? "")));
    for (const kp of finalChoice.keyPoints) {
      const id = String(kp?.id ?? "");
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

  let savedChunkResults = null;
  let currentDraft = null;
  let currentReview = null;
  let currentPreflight = null;
  let best = null;
  let extraNote = "";

  for (let round = 1; round <= opts.maxRounds; round += 1) {
    onProgress?.("parsing", `LLM 深度解析 第 ${round}/${opts.maxRounds} 轮…`, 80 + round * 5);

    if (round === 1) {
      // 第 1 轮：分块生成 + 最终分支/结局独立生成（可指定强模型）。
      let chunkResults = null;
      try {
        chunkResults = new Array(chunkPrompts.length).fill(null);
        const concurrency = Math.max(1, opts.chunkConcurrency);
        for (let start = 0; start < chunkPrompts.length; start += concurrency) {
          const batch = chunkPrompts.slice(start, start + concurrency);
          const batchResults = await Promise.all(
            batch.map(async (item, offset) => {
              const raw = await callLlmText(deps, item.prompt, {
                model: opts.chunkModel,
                temperature: opts.chunkTemperature,
                maxTokens: opts.chunkMaxTokens,
                reasoningEffort: opts.chunkReasoningEffort,
              });
              const parsed = parseDeepParseResult(raw, flat);
              return { index: start + offset, deepParse: parsed.deepParse };
            })
          );
          for (const result of batchResults) chunkResults[result.index] = result.deepParse;
          onProgress?.("parsing", `分块 ${Math.min(start + concurrency, chunkPrompts.length)}/${chunkPrompts.length}`, 80 + round * 5);
        }
        const finalRaw = await callLlmText(deps, finalPrompt, {
          model: opts.finalModel,
          temperature: opts.finalTemperature,
          maxTokens: opts.finalMaxTokens,
          reasoningEffort: opts.finalReasoningEffort,
        });
        const finalParsed = parseSkeletonWiringResult(finalRaw, flat);
        const anyChunkParsed = chunkResults.some((part) => part !== null && part !== undefined);
        if (finalParsed.deepParse === null && !anyChunkParsed) {
          extraNote = "上一轮所有 LLM 输出都无法解析为 JSON，请只输出一个 JSON 对象。";
          continue;
        }
        savedChunkResults = chunkResults;
        const merged = mergeChunkedDeepParseParts(flat, chunkResults, finalParsed.deepParse);
        currentDraft = merged.deepParse !== null ? { deepParse: merged.deepParse } : null;
      } catch (error) {
        onProgress?.("parsing", `深度解析第 ${round} 轮生成失败：${String(error?.message ?? error)}`, 85);
        // 最终生成失败但分块有产出时，不要作废整轮：先用分块结果拼一个
        // 无结局草稿，让 preflight/审校标记“未声明结局”，第 2 轮修订补齐。
        const partialChunkResults = new Array(chunkPrompts.length).fill(null);
        for (let index = 0; index < chunkPrompts.length; index += 1) {
          if (typeof chunkResults?.[index] === "object" && chunkResults[index] !== null) {
            partialChunkResults[index] = chunkResults[index];
          }
        }
        if (partialChunkResults.some((part) => part !== null && part !== undefined)) {
          savedChunkResults = partialChunkResults;
          const merged = mergeChunkedDeepParseParts(flat, partialChunkResults, null);
          if (merged.deepParse !== null) {
            currentDraft = { deepParse: merged.deepParse };
            extraNote = `最终生成失败（${String(error?.message ?? error)}），第 2 轮请补齐最终分支与结局。`;
            continue;
          }
        }
        extraNote = `上一轮生成失败：${String(error?.message ?? error)}；请缩短输出并只输出合法 JSON。`;
        continue;
      }
    } else {
      // 第 2/3 轮：只修订最终分支/结局（同一草稿修复式，不是推倒重写），
      // 再与第 1 轮分块结果合并。分块条件不再生成，省 token 且稳定。
      if (currentDraft === null || savedChunkResults === null) break;
      const finalBranchIds = new Set(
        [...asArray(flat?.branches), ...asArray(currentDraft.deepParse?.branches)]
          .filter((branch) => branch?.finalChoice === true || String(branch?.id ?? "").startsWith("br-final"))
          .map((branch) => String(branch?.id ?? ""))
      );
      const effectiveBranches = effectiveFinalBranches(flat, currentDraft.deepParse);
      const effectiveBranchById = new Map(effectiveBranches.map((branch) => [String(branch?.id ?? ""), branch]));
      const finalPart = {
        version: currentDraft.deepParse?.version ?? "1.0",
        keyPoints: [],
        branches: asArray(currentDraft.deepParse?.branches).map((branch) => {
          const skeleton = effectiveBranchById.get(String(branch?.id ?? ""));
          // 最终分支 options 以确定性骨架为准（运行时也以骨架为准）；
          // scene/title 允许模型修订。
          if (skeleton !== undefined) return { ...branch, options: asArray(skeleton.options) };
          return branch;
        }),
        branchConditions: asArray(currentDraft.deepParse?.branchConditions).filter((entry) =>
          finalBranchIds.has(String(entry?.branchId ?? ""))
        ),
        plotEdges: asArray(currentDraft.deepParse?.plotEdges).filter(
          (edge) => String(edge?.from ?? "").startsWith("br:br-final") || String(edge?.to ?? "").startsWith("end:")
        ),
        endings: asArray(currentDraft.deepParse?.endings),
      };
      const revisionPrompt = buildRevisionPrompt(
        flat,
        finalPart,
        formatReviewForRevision(currentReview?.issues ?? []),
        formatPreflightForRevision(currentPreflight?.issues ?? []),
        extraNote
      );
      try {
        const revisionRaw = await callLlmText(deps, revisionPrompt, {
          model: opts.revisionModel,
          temperature: opts.revisionTemperature,
          maxTokens: opts.revisionMaxTokens,
          reasoningEffort: opts.revisionReasoningEffort,
        });
        const revisionParsed = parseSkeletonWiringResult(revisionRaw, flat);
        if (revisionParsed.deepParse === null) {
          extraNote = "上一轮修订输出无法解析为 JSON，请只输出一个 JSON 对象。";
          continue;
        }
        const merged = mergeChunkedDeepParseParts(flat, savedChunkResults, revisionParsed.deepParse);
        if (merged.deepParse === null) {
          extraNote = "上一轮修订结果无法与分块结果合并。";
          continue;
        }
        currentDraft = { deepParse: merged.deepParse };
      } catch (error) {
        extraNote = `上一轮修订失败：${String(error?.message ?? error)}；请缩短输出并只输出合法 JSON。`;
        continue;
      }
    }

    if (currentDraft === null) continue;
    currentPreflight = runDeepParsePreflight(currentDraft.deepParse, flat);
    currentReview = null;
    if (opts.runReview) {
      try {
        const reviewRaw = await callLlmText(deps, buildReviewPrompt(flat, currentDraft.deepParse, currentPreflight.issues), {
          model: opts.reviewModel,
          temperature: opts.reviewTemperature,
          maxTokens: opts.reviewMaxTokens,
          reasoningEffort: opts.reviewReasoningEffort,
        });
        currentReview = parseReviewResult(reviewRaw);
      } catch (error) {
        currentReview = { issues: [{ severity: "medium", where: "审校", problem: `审校调用失败：${String(error?.message ?? error)}`, suggestion: "忽略或下一轮重试" }] };
      }
    }

    const score = makeScore(currentPreflight, currentReview, opts.reviewGate);
    if (best === null || isBetterScore(score, best.score)) {
      best = { deepParse: currentDraft.deepParse, score, round };
    }
    if (score.pass) break;
    extraNote = "";
  }

  if (best === null) {
    return {
      deepParse: null,
      quality: { rounds: opts.maxRounds, high: 0, medium: 0, low: 0, pass: false, issues: ["LLM 深度解析不可用"] },
      status: "skipped",
    };
  }

  return {
    deepParse: best.deepParse,
    quality: {
      rounds: best.round,
      high: best.score.high,
      medium: best.score.medium,
      low: best.score.low,
      pass: best.score.pass,
      preflightHigh: best.score.preflightHigh,
      preflightMedium: best.score.preflightMedium,
      preflightLow: best.score.preflightLow,
      reviewHigh: best.score.reviewHigh,
      reviewMedium: best.score.reviewMedium,
      reviewLow: best.score.reviewLow,
      issues: best.score.reviewIssues.length > 0 ? best.score.reviewIssues : best.score.preflightIssues,
    },
    status: "draft",
  };
}

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
  buildChunkReviewPrompt,
  buildChunkRevisionPrompt,
  buildFinalWiringPrompt,
  buildDeterministicSkeleton,
  extractEndingParagraphs,
  extractFinalChoiceBranches,
  extractJsonObject,
  mergeChunkedDeepParseParts,
  parseDeepParseResult,
  parseSkeletonWiringResult,
  applyTopologySkeleton,
  repairDeepParseConnectivity,
  repairDeepParseFinalWiring,
  runDeepParsePreflight,
  runDeepParseRuleReview,
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

export function shouldRetryLlmError(error, attempt) {
  if (attempt >= 2) return false;
  return !/超时/.test(String(error?.message ?? ""));
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
  const timeoutMs = options.timeoutMs ?? 180000;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const llmResult = await Promise.race([
        deps.callLlmApi(
          deps.dataDir,
          [{ role: "user", content: [{ type: "text", text: prompt }] }],
          requestOptions
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`LLM 调用超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)),
      ]);
      return textOfLlmResult(llmResult);
    } catch (error) {
      lastError = error;
      // 超时不再重试：重试一次等于把超时翻倍，导入体验更差。
      if (!shouldRetryLlmError(error, attempt)) break;
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
  // 最终分支自身的 scene（尤其多分支用标题作 scene 时）也加入可选项，
  // 避免审校把“无力抗争的终局”这类分支标题场景误判为非法。
  for (const branch of finalBranches) {
    const scene = nonEmptyString(branch?.scene);
    if (scene.length > 0 && !sceneHeadingCounts.has(scene)) sceneHeadingCounts.set(scene, 1);
  }
  const sceneHeadings = [...sceneHeadingCounts.entries()]
    .slice(0, 80)
    .map(([heading, count]) => (count > 1 ? `${heading}（出现${count}次）` : heading));
  // 最终分支自身的 scene 必须出现在可选项里，即使它不在前 80 个场景标题中。
  for (const branch of finalBranches) {
    const scene = nonEmptyString(branch?.scene);
    if (scene.length > 0 && !sceneHeadings.some((heading) => String(heading).startsWith(scene))) {
      sceneHeadings.push(scene);
    }
  }
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

function compactRule(ruleIssues) {
  const lines = asArray(ruleIssues)
    .filter((issue) => issue?.severity === "high" || issue?.severity === "medium")
    .slice(0, 20)
    .map(issueLine);
  return lines.length > 0 ? lines.join("\n") : "（无）";
}

/**
 * 语义审校 Prompt：只审校最终分支与结局。preflight / 规则化审校已列出的
 * 问题不重复报告，只报告规则判定不了的语义新问题。
 */
export function buildReviewPrompt(flat, deepParse, preflightIssues, ruleIssues) {
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
    `preflight 与规则化审校已列出的问题不要重复报告；只报告规则判定不了的语义层面的新问题。`,
    `同一最终分支内多个结局可以共享同一组前置条件，只要 optionLabel 与分支选项一一对应（运行时按选项 label 区分），不要判为互斥失效。`,
    `br→end 的 plotEdges（以及对应 ending.requires）里的 keyPointIds 表示“选择该选项后还需经过/完成的中间关键点”，这是合法的推进条件，不是循环依赖；只有把这些关键点放进分支的 branchCondition（选择前）或选项本身的前置时才是 high 问题。`,
    `如果没有 high/medium 问题，issues 可以是空数组。`,
    ``,
    `剧本名：${String(flat?.scenario?.name ?? "未命名")}`,
    `最终分支骨架：${JSON.stringify(summarizeFinalSkeleton(flat, deepParse).finalBranches)}`,
    `关键点参考（id:标题）：${summarizeFinalSkeleton(flat, deepParse).keyPointRef}`,
    `场景标题清单（scene 门控只能从这里选；出现次数>1 说明多条路线共用该标题）：${JSON.stringify(summarizeFinalSkeleton(flat, deepParse).sceneHeadings)}`,
    `当前草稿：${JSON.stringify(focusDraft)}`,
    `preflight 问题：${compactPreflight(preflightIssues)}`,
    `规则化审校问题（确定性已判，不要重复报告）：${compactRule(ruleIssues)}`,
    ``,
    `结局相关原文段落（权威依据）：`,
    extractEndingParagraphs(flat).map((block) => `###\n${block}`).join("\n\n").slice(0, 6000),
  ].join("\n");
}

/**
 * 修复式修订 Prompt：只输出最终分支/结局部分，不重写分块条件。
 */
export function buildRevisionPrompt(flat, deepParse, reviewIssues, preflightIssues, extraNote, ruleIssues) {
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
    `规则化审校问题（确定性已判，必须修复）：${compactRule(ruleIssues)}`,
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

/**
 * 分块审校相关工具。
 */
function chunkPartHasContent(part) {
  return (
    asArray(part?.keyPointConditions).length > 0 ||
    asArray(part?.branchConditions).length > 0 ||
    asArray(part?.plotEdges).length > 0
  );
}

function prefixChunkIssues(chunkIndex, issues) {
  return asArray(issues).map((issue) => ({
    ...issue,
    where: `chunk-${chunkIndex + 1}/${nonEmptyString(issue?.where) || "整体"}`,
  }));
}

function chunkIndexFromIssue(issue) {
  const match = /^chunk-(\d+)(?:\/|$)/.exec(nonEmptyString(issue?.where));
  if (match === null) return -1;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

function groupIssuesByChunk(issues) {
  const byChunk = new Map();
  for (const issue of asArray(issues)) {
    const index = chunkIndexFromIssue(issue);
    if (index < 0) continue;
    if (!byChunk.has(index)) byChunk.set(index, []);
    byChunk.get(index).push(issue);
  }
  return byChunk;
}

function formatChunkIssuesForRevision(chunkIssues) {
  const lines = asArray(chunkIssues)
    .filter((issue) => issue?.severity === "high" || issue?.severity === "medium")
    .slice(0, 8)
    .map((issue) => {
      // 回灌时把 chunk-N/ 前缀去掉，让模型只关注块内定位。
      const where = nonEmptyString(issue?.where).replace(/^chunk-\d+\//, "");
      return `- [${issue?.severity ?? "medium"}] ${where}: ${issue?.problem ?? ""} → ${issue?.suggestion ?? ""}`;
    });
  return lines.length > 0 ? lines.join("\n") : "（该块未发现语义问题）";
}

async function runChunkReviews(deps, flat, chunks, chunkResults, opts, indexesToReview, onProgress) {
  const issues = [];
  const concurrency = Math.max(1, opts.chunkConcurrency);
  const indexes =
    indexesToReview !== undefined
      ? [...indexesToReview].filter((index) => index >= 0 && index < chunks.length)
      : chunks.map((_, index) => index);
  for (let start = 0; start < indexes.length; start += concurrency) {
    const batch = indexes.slice(start, start + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (index) => {
        const chunk = chunks[index];
        const part = chunkResults[index];
        if (chunk === undefined || part === null || part === undefined || !chunkPartHasContent(part)) {
          return { index, issues: [] };
        }
        try {
          const raw = await callLlmText(deps, buildChunkReviewPrompt(flat, chunk, part), {
            model: opts.reviewModel,
            temperature: opts.reviewTemperature,
            maxTokens: opts.chunkReviewMaxTokens,
            reasoningEffort: opts.reviewReasoningEffort,
          });
          const parsed = parseReviewResult(raw);
          return { index, issues: prefixChunkIssues(index, parsed.issues) };
        } catch (error) {
          // 单块审校失败不阻塞 loop：确定性规则审校仍会覆盖引用/矛盾检查。
          onProgress?.("parsing", `分块 ${index + 1}/${chunks.length} 审校失败：${String(error?.message ?? error)}`, 85);
          return { index, issues: [] };
        }
      })
    );
    for (const result of batchResults) issues.push(...result.issues);
  }
  return { issues };
}

function makeScore(preflight, ruleReview, review, chunkReview, reviewGate) {
  const rev = review === null || review === undefined ? null : reviewScore(review);
  const chunk = chunkReview === null || chunkReview === undefined ? null : reviewScore(chunkReview);
  const rule = ruleReview ?? { high: 0, medium: 0, low: 0, issues: [] };
  const reviewHigh = rev?.high ?? 0;
  const reviewMedium = rev?.medium ?? 0;
  const reviewLow = rev?.low ?? 0;
  const chunkHigh = chunk?.high ?? 0;
  const chunkMedium = chunk?.medium ?? 0;
  const chunkLow = chunk?.low ?? 0;
  const high = preflight.high + rule.high + reviewHigh + chunkHigh;
  const medium = preflight.medium + rule.medium + reviewMedium + chunkMedium;
  const low = preflight.low + rule.low + reviewLow + chunkLow;
  return {
    preflightHigh: preflight.high,
    preflightMedium: preflight.medium,
    preflightLow: preflight.low,
    ruleHigh: rule.high,
    ruleMedium: rule.medium,
    ruleLow: rule.low,
    reviewHigh,
    reviewMedium,
    reviewLow,
    chunkHigh,
    chunkMedium,
    chunkLow,
    high,
    medium,
    low,
    pass:
      preflight.high === 0 &&
      rule.high === 0 &&
      rule.medium <= reviewGate.medium &&
      (rev === null || (rev.high === 0 && rev.medium <= reviewGate.medium)) &&
      (chunk === null || (chunk.high === 0 && chunk.medium <= reviewGate.medium)),
    reviewIssues: review?.issues ?? [],
    ruleIssues: rule.issues ?? [],
    chunkIssues: chunkReview?.issues ?? [],
    preflightIssues: preflight.issues,
  };
}

function isBetterScore(a, b) {
  if (a.high !== b.high) return a.high < b.high;
  if (a.medium !== b.medium) return a.medium < b.medium;
  return a.low < b.low;
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
    quality: {
      rounds: 0,
      high: 0,
      medium: 0,
      low: 0,
      pass: false,
      preflightHigh: 0,
      preflightMedium: 0,
      preflightLow: 0,
      ruleHigh: 0,
      ruleMedium: 0,
      ruleLow: 0,
      reviewHigh: 0,
      reviewMedium: 0,
      reviewLow: 0,
      chunkHigh: 0,
      chunkMedium: 0,
      chunkLow: 0,
      issues: [],
    },
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
    chunkReviewMaxTokens: loopOptions.chunkReviewMaxTokens ?? 4000,
    chunkRevisionMaxTokens: loopOptions.chunkRevisionMaxTokens ?? 8000,
    revisionModel: loopOptions.revisionModel,
    revisionTemperature: loopOptions.revisionTemperature ?? 0,
    revisionMaxTokens: loopOptions.revisionMaxTokens ?? 24000,
    revisionReasoningEffort: loopOptions.revisionReasoningEffort ?? "low",
    maxRounds: loopOptions.maxRounds ?? 3,
    reviewGate: loopOptions.reviewGate ?? { high: 0, medium: 2 },
    runReview: loopOptions.runReview !== false,
    runChunkReview: loopOptions.runChunkReview !== false && loopOptions.runReview !== false,
  };

  // 确定性骨架：结构分析管线未产出关键点/分支时，从场景事实/检定点生成。
  // 结构关键点已存在时仍补检定点分支（避免 keyPoints 非空导致分支缺失）。
  {
    const needKeyPoints = asArray(flat?.keyPoints).length === 0;
    const needBranches = asArray(flat?.branches).length === 0;
    if (needKeyPoints || needBranches) {
      const skeleton = buildDeterministicSkeleton(flat);
      if (needKeyPoints) flat.keyPoints = skeleton.keyPoints;
      if (needBranches) flat.branches = skeleton.branches;
    }
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

  // 短剧本（分块少）跑满 3 轮收益不大但很耗时；默认 2 轮，
  // 长剧本保持 3 轮。也可在 deepParse.maxRounds 显式覆盖。
  if (loopOptions.maxRounds === undefined && opts.maxRounds === 3 && chunks.length <= 24) {
    opts.maxRounds = 2;
  }

  let savedChunkResults = null;
  let currentDraft = null;
  let currentReview = null;
  let currentPreflight = null;
  let currentRuleReview = null;
  let currentChunkReview = { issues: [] };
  let best = null;
  let extraNote = "";

  for (let round = 1; round <= opts.maxRounds; round += 1) {
    onProgress?.("parsing", `LLM 深度解析 第 ${round}/${opts.maxRounds} 轮…`, 80 + round * 5);
    let revisedChunkIndexes = new Set();

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
          timeoutMs: loopOptions.finalTimeoutMs ?? 180000,
        });
        const finalParsed = parseSkeletonWiringResult(finalRaw, flat);
        const anyChunkParsed = chunkResults.some((part) => part !== null && part !== undefined);
        if (finalParsed.deepParse === null && !anyChunkParsed) {
          extraNote = "上一轮所有 LLM 输出都无法解析为 JSON，请只输出一个 JSON 对象。";
          continue;
        }
        savedChunkResults = chunkResults;
        const merged = mergeChunkedDeepParseParts(flat, chunkResults, finalParsed.deepParse);
        if (merged.deepParse !== null) {
          repairDeepParseFinalWiring(flat, merged.deepParse);
          applyTopologySkeleton(flat, merged.deepParse);
          repairDeepParseConnectivity(flat, merged.deepParse);
        }
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
            repairDeepParseFinalWiring(flat, merged.deepParse);
            applyTopologySkeleton(flat, merged.deepParse);
          repairDeepParseConnectivity(flat, merged.deepParse);
            currentDraft = { deepParse: merged.deepParse };
            extraNote = `最终生成失败（${String(error?.message ?? error)}），第 2 轮请补齐最终分支与结局。`;
            continue;
          }
        }
        extraNote = `上一轮生成失败：${String(error?.message ?? error)}；请缩短输出并只输出合法 JSON。`;
        continue;
      }
    } else {
      // 第 2/3 轮：修复式修订。分块条件只重新生成“分块审校发现 high/medium
      // 问题的块”（其余块保持第 1 轮定稿）；最终分支/结局照旧整体修订。
      if (currentDraft === null || savedChunkResults === null) break;
      const chunkIssuesByChunk = groupIssuesByChunk(currentChunkReview?.issues ?? []);
      const chunksToRevise = [...chunkIssuesByChunk.keys()].filter((index) =>
        chunkIssuesByChunk.get(index).some((issue) => issue?.severity === "high" || issue?.severity === "medium")
      );
      if (chunksToRevise.length > 0) {
        const concurrency = Math.max(1, opts.chunkConcurrency);
        for (let start = 0; start < chunksToRevise.length; start += concurrency) {
          const batch = chunksToRevise.slice(start, start + concurrency);
          const batchResults = await Promise.all(
            batch.map(async (index) => {
              const chunk = chunks[index];
              const part = savedChunkResults[index];
              const prompt = buildChunkRevisionPrompt(
                flat,
                chunk,
                part,
                formatChunkIssuesForRevision(chunkIssuesByChunk.get(index) ?? [])
              );
              try {
                const raw = await callLlmText(deps, prompt, {
                  model: opts.revisionModel,
                  temperature: opts.revisionTemperature,
                  maxTokens: opts.chunkRevisionMaxTokens,
                  reasoningEffort: opts.revisionReasoningEffort,
                });
                const parsed = parseDeepParseResult(raw, flat);
                return { index, deepParse: parsed.deepParse };
              } catch (error) {
                onProgress?.("parsing", `分块 ${index + 1} 修订失败：${String(error?.message ?? error)}`, 85);
                return { index, deepParse: null };
              }
            })
          );
          for (const result of batchResults) {
            if (result.deepParse !== null && result.deepParse !== undefined) {
              savedChunkResults[result.index] = result.deepParse;
              revisedChunkIndexes.add(result.index);
            }
          }
          onProgress?.("parsing", `分块修订 ${Math.min(start + concurrency, chunksToRevise.length)}/${chunksToRevise.length}`, 85);
        }
      }
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
        extraNote,
        currentRuleReview?.issues ?? []
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
        repairDeepParseFinalWiring(flat, merged.deepParse);
        repairDeepParseConnectivity(flat, merged.deepParse);
        currentDraft = { deepParse: merged.deepParse };
      } catch (error) {
        extraNote = `上一轮修订失败：${String(error?.message ?? error)}；请缩短输出并只输出合法 JSON。`;
        continue;
      }
    }

    if (currentDraft === null) continue;
    currentPreflight = runDeepParsePreflight(currentDraft.deepParse, flat);
    // 规则化审校：确定性语义检查，结果稳定，不受审校模型波动影响。
    currentRuleReview = runDeepParseRuleReview(currentDraft.deepParse, flat, {
      severityGate: { high: 0, medium: opts.reviewGate.medium },
    });
    currentReview = null;
    if (opts.runReview) {
      try {
        const reviewRaw = await callLlmText(
          deps,
          buildReviewPrompt(flat, currentDraft.deepParse, currentPreflight.issues, currentRuleReview.issues),
          {
            model: opts.reviewModel,
            temperature: opts.reviewTemperature,
            maxTokens: opts.reviewMaxTokens,
            reasoningEffort: opts.reviewReasoningEffort,
          }
        );
        currentReview = parseReviewResult(reviewRaw);
      } catch (error) {
        currentReview = { issues: [{ severity: "medium", where: "审校", problem: `审校调用失败：${String(error?.message ?? error)}`, suggestion: "忽略或下一轮重试" }] };
      }
    }

    if (opts.runChunkReview) {
      if (round === 1) {
        // 第 1 轮：审校所有有内容的分块。
        const chunkReviewResult = await runChunkReviews(
          deps,
          flat,
          chunks,
          savedChunkResults ?? [],
          opts,
          undefined,
          onProgress
        );
        currentChunkReview = { issues: chunkReviewResult.issues };
      } else if (revisedChunkIndexes.size > 0) {
        // 第 2/3 轮：只复审本轮重新生成过的分块，其余沿用上一轮审校结论。
        const chunkReviewResult = await runChunkReviews(
          deps,
          flat,
          chunks,
          savedChunkResults ?? [],
          opts,
          revisedChunkIndexes,
          onProgress
        );
        const keptIssues = (currentChunkReview?.issues ?? []).filter((issue) => {
          const chunkIndex = chunkIndexFromIssue(issue);
          return chunkIndex === -1 || !revisedChunkIndexes.has(chunkIndex);
        });
        currentChunkReview = { issues: [...keptIssues, ...chunkReviewResult.issues] };
      }
    } else {
      currentChunkReview = { issues: [] };
    }

    const score = makeScore(currentPreflight, currentRuleReview, currentReview, currentChunkReview, opts.reviewGate);
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
      ruleHigh: best.score.ruleHigh,
      ruleMedium: best.score.ruleMedium,
      ruleLow: best.score.ruleLow,
      reviewHigh: best.score.reviewHigh,
      reviewMedium: best.score.reviewMedium,
      reviewLow: best.score.reviewLow,
      chunkHigh: best.score.chunkHigh,
      chunkMedium: best.score.chunkMedium,
      chunkLow: best.score.chunkLow,
      issues: [
        ...best.score.reviewIssues,
        ...best.score.chunkIssues,
        ...best.score.ruleIssues,
        ...best.score.preflightIssues,
      ],
      reviewIssues: best.score.reviewIssues,
      chunkIssues: best.score.chunkIssues,
      ruleIssues: best.score.ruleIssues,
      preflightIssues: best.score.preflightIssues,
    },
    status: "draft",
  };
}

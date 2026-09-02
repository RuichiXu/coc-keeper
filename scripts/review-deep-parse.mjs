/**
 * 单独评测语义审校：读取场景目录里的 final-wiring.json（或 deep-parse.gen.json），
 * 用配置默认模型（廉价）跑 buildReviewPrompt，输出 review JSON。
 *
 * 用法：
 *   node scripts/review-deep-parse.mjs <场景目录> [dataDir]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  buildDeterministicSkeleton,
  canonicalizeDeepParse,
  extractCheckpoints,
  extractFinalChoiceBranches,
  extractSceneFacts,
  runDeepParsePreflight,
  runDeepParseRuleReview,
  splitDeepParseChunks,
} from "../lib/core/index.js";
import { buildReviewPrompt, parseReviewResult } from "../lib/shared/tools/deep-parse-loop.js";
import { callLlmApi } from "../lib/shared/llm.js";

const dir = resolve(process.argv[2] ?? ".");
const dataDir = resolve(process.argv[3] ?? join(homedir(), ".dsh", "coc"));
const text = readFileSync(join(dir, "original.txt"), "utf8");
const name = dir.split("/").pop();
const flat = {
  scenario: { name, text },
  scenarioCheckpoints: extractCheckpoints(text),
  scenarioFacts: extractSceneFacts(text),
  keyPoints: [],
  branches: [],
  entities: [],
};
const skeleton = buildDeterministicSkeleton(flat);
flat.keyPoints = skeleton.keyPoints;
flat.branches = skeleton.branches;
const finalChoice = extractFinalChoiceBranches(flat);
flat.keyPoints.push(...finalChoice.keyPoints);
flat.branches.push(...finalChoice.branches);

const deepParseFile = (() => {
  try { return JSON.parse(readFileSync(join(dir, "final-wiring.json"), "utf8")); } catch { return null; }
})() ?? (() => {
  try { return JSON.parse(readFileSync(join(dir, "deep-parse.gen.json"), "utf8")); } catch { return null; }
})();
if (deepParseFile === null) {
  console.error("缺少 final-wiring.json / deep-parse.gen.json");
  process.exit(2);
}

const canonical = canonicalizeDeepParse(deepParseFile);
const deepParse = canonical.deepParse;
const preflight = runDeepParsePreflight(deepParse, flat);
const ruleReview = runDeepParseRuleReview(deepParse, flat);
const prompt = buildReviewPrompt(flat, deepParse, preflight.issues, ruleReview.issues);
console.error(
  `[review] prompt=${prompt.length} chars preflight h${preflight.high}/m${preflight.medium}/l${preflight.low} rule h${ruleReview.high}/m${ruleReview.medium}/l${ruleReview.low}`
);

const llmResult = await callLlmApi(
  dataDir,
  [{ role: "user", content: [{ type: "text", text: prompt }] }],
  { temperature: 0, max_tokens: 16000, reasoningEffort: "low" }
);
const raw = (llmResult.blocks ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");
console.error(`[review] raw=${raw.length} chars`);
const review = parseReviewResult(raw);
const countSeverity = (issues, severity) => issues.filter((issue) => issue.severity === severity).length;
const reviewCounts = {
  high: countSeverity(review.issues, "high"),
  medium: countSeverity(review.issues, "medium"),
  low: countSeverity(review.issues, "low"),
};
const summary = {
  preflight: { high: preflight.high, medium: preflight.medium, low: preflight.low },
  rule: { high: ruleReview.high, medium: ruleReview.medium, low: ruleReview.low, issues: ruleReview.issues },
  review: { ...reviewCounts, issues: review.issues },
  high: preflight.high + ruleReview.high + reviewCounts.high,
  medium: preflight.medium + ruleReview.medium + reviewCounts.medium,
  low: preflight.low + ruleReview.low + reviewCounts.low,
  issues: [...review.issues, ...ruleReview.issues, ...preflight.issues],
};
writeFileSync(join(dir, "final-wiring-review2.json"), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    {
      name,
      ...summary,
      pass:
        preflight.high === 0 &&
        ruleReview.high === 0 &&
        ruleReview.medium <= 2 &&
        reviewCounts.high === 0 &&
        reviewCounts.medium <= 2,
    },
    null,
    2
  )
);

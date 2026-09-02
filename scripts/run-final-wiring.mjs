/**
 * 单独评测“最终分支与结局生成”（不跑分块 loop）。
 *
 * 用法：
 *   node scripts/run-final-wiring.mjs <场景目录> [model] [dataDir]
 *
 * 默认 model = kimi-k3；输出 final-wiring.json 与 final-wiring-quality.json。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  buildDeterministicSkeleton,
  buildFinalWiringPrompt,
  extractCheckpoints,
  extractFinalChoiceBranches,
  extractSceneFacts,
  parseSkeletonWiringResult,
  runDeepParsePreflight,
  splitDeepParseChunks,
} from "../lib/core/index.js";
import { callLlmApi } from "../lib/shared/llm.js";

const dir = resolve(process.argv[2] ?? ".");
const model = process.argv[3] ?? "kimi-k3";
const dataDir = resolve(process.argv[4] ?? join(homedir(), ".dsh", "coc"));
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

const chunks = splitDeepParseChunks(flat);
const prompt = buildFinalWiringPrompt(flat, chunks);
console.error(`[final-wiring] model=${model} prompt=${prompt.length} chars`);

const llmResult = await callLlmApi(
  dataDir,
  [{ role: "user", content: [{ type: "text", text: prompt }] }],
  { temperature: 1, max_tokens: 24000, model }
);
const raw = (llmResult.blocks ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");
console.error(`[final-wiring] raw=${raw.length} chars`);
const parsed = parseSkeletonWiringResult(raw, flat);
if (parsed.deepParse === null) {
  console.error(`解析失败：${parsed.issues.join("；")}`);
  process.exit(2);
}
const report = runDeepParsePreflight(parsed.deepParse, flat);
writeFileSync(join(dir, "final-wiring.json"), JSON.stringify(parsed.deepParse, null, 2));
writeFileSync(join(dir, "final-wiring-quality.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ name, model, high: report.high, medium: report.medium, low: report.low, pass: report.pass }, null, 2));

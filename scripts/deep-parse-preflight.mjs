/**
 * 深度解析“生成即校验”CLI（离线实验用）
 *
 * 用法：
 *   node scripts/deep-parse-preflight.mjs <场景目录> [draft文件名]
 *
 * 场景目录需包含 original.txt；脚本会重建 deterministic flat 并读取指定
 * draft JSON（默认 deep-parse.gen.json），输出结构化 issue 报告。
 * 退出码：0 = high=0 且 medium=0（preflight pass）；1 = 存在 high/medium。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildDeterministicSkeleton,
  compileByPattern,
  extractCheckpoints,
  extractFinalChoiceBranches,
  extractSceneFacts,
  parseDeepParseResult,
  runDeepParsePreflight,
  toLegacyFormat,
} from "../lib/core/index.js";

const dir = resolve(process.argv[2] ?? ".");
const draftFile = process.argv[3] ?? "deep-parse.gen.json";
const originalPath = join(dir, "original.txt");
const draftPath = join(dir, draftFile);

let text;
try {
  text = readFileSync(originalPath, "utf8");
} catch {
  console.error(`缺少 original.txt：${originalPath}`);
  process.exit(2);
}
let raw;
try {
  raw = readFileSync(draftPath, "utf8");
} catch {
  console.error(`缺少 draft 文件：${draftPath}`);
  process.exit(2);
}

const name = dir.split("/").pop();
const model = compileByPattern(text, name);
const legacy = toLegacyFormat(model);
const flat = {
  scenario: { name, text },
  scenarioCheckpoints: extractCheckpoints(text),
  scenarioFacts: extractSceneFacts(text),
  keyPoints: legacy.keyPoints,
  branches: legacy.branches,
  entities: legacy.entities,
};
if (flat.keyPoints.length === 0 && flat.branches.length === 0) {
  const skeleton = buildDeterministicSkeleton(flat);
  flat.keyPoints = skeleton.keyPoints;
  flat.branches = skeleton.branches;
}
{
  const finalChoice = extractFinalChoiceBranches(flat);
  for (const kp of finalChoice.keyPoints) flat.keyPoints.push(kp);
  for (const branch of finalChoice.branches) flat.branches.push(branch);
}
const parsed = parseDeepParseResult(raw, flat);
if (parsed.deepParse === null) {
  console.error(`draft 无法解析：${parsed.issues.join("；")}`);
  process.exit(2);
}
if (process.env.SKELETON_LOCKED === "1" && (parsed.deepParse.keyPoints ?? []).length > 0) {
  console.error("skeleton-locked 模式不允许生成 keyPoints");
  process.exit(2);
}
const report = runDeepParsePreflight(parsed.deepParse, flat);
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);

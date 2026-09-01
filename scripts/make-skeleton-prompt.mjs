/**
 * 生成骨架锁定 prompt 文件（离线实验/最终评估用）。
 *
 * 用法：
 *   node scripts/make-skeleton-prompt.mjs <场景目录>
 *
 * 场景目录需包含 original.txt；脚本会写入 <场景目录>/skeleton-prompt.txt。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import {
  buildSkeletonWiringPrompt,
  compileByPattern,
  extractCheckpoints,
  extractSceneFacts,
  toLegacyFormat,
} from "../lib/core/index.js";

const dir = resolve(process.argv[2] ?? ".");
const text = readFileSync(join(dir, "original.txt"), "utf8");
const name = basename(dir);
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
const prompt = buildSkeletonWiringPrompt(flat);
writeFileSync(join(dir, "skeleton-prompt.txt"), prompt);
console.log(`wrote ${join(dir, "skeleton-prompt.txt")} (${prompt.length} chars)`);

/**
 * 生成两段式 deepParse 的 prompt 文件（离线实验/最终评估用）。
 *
 * 用法：
 *   node scripts/make-two-stage-prompts.mjs <场景目录> [inventory.json路径]
 *
 * 场景目录需包含 original.txt。脚本会写入：
 *   <场景目录>/inventory-prompt.txt
 *   <场景目录>/wiring-prompt.txt（若给了 inventory，则为硬约束版本）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import {
  buildDeepParseTwoStagePrompts,
  compileByPattern,
  extractCheckpoints,
  extractSceneFacts,
  toLegacyFormat,
} from "../lib/core/index.js";

const dir = resolve(process.argv[2] ?? ".");
const inventoryPath = process.argv[3] ? resolve(process.argv[3]) : null;
const originalPath = join(dir, "original.txt");

const text = readFileSync(originalPath, "utf8");
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
let inventory = null;
if (inventoryPath !== null) {
  inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
}
const prompts = buildDeepParseTwoStagePrompts(flat, inventory);
writeFileSync(join(dir, "inventory-prompt.txt"), prompts.inventoryPrompt);
writeFileSync(join(dir, "wiring-prompt.txt"), prompts.wiringPrompt);
console.log(`wrote ${join(dir, "inventory-prompt.txt")} (${prompts.inventoryPrompt.length} chars)`);
console.log(`wrote ${join(dir, "wiring-prompt.txt")} (${prompts.wiringPrompt.length} chars)`);

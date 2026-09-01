/**
 * 合并两段式 deepParse 并做 preflight。
 *
 * 用法：
 *   node scripts/combine-deep-parse-parts.mjs <场景目录> <inventory文件> <wiring文件> [输出文件]
 *
 * 默认输出 <场景目录>/deep-parse.gen.json。
 * 退出码：0 = 合并+结构校验+preflight 全通过；1 = 存在 high/medium；2 = 无法解析/合并。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import {
  combineDeepParseParts,
  compileByPattern,
  extractCheckpoints,
  extractSceneFacts,
  parseDeepParseResult,
  runDeepParsePreflight,
  toLegacyFormat,
} from "../lib/core/index.js";

const dir = resolve(process.argv[2] ?? ".");
const inventoryPath = resolve(process.argv[3] ?? join(dir, "inventory.json"));
const wiringPath = resolve(process.argv[4] ?? join(dir, "wiring.json"));
const outPath = process.argv[5] ?? join(dir, "deep-parse.gen.json");

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

const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const wiring = JSON.parse(readFileSync(wiringPath, "utf8"));
const combined = combineDeepParseParts(inventory, wiring, flat);
if (combined.deepParse === null) {
  console.error(JSON.stringify({ issues: combined.issues }, null, 2));
  process.exit(2);
}
writeFileSync(outPath, JSON.stringify(combined.deepParse, null, 2));
const preflight = runDeepParsePreflight(combined.deepParse, flat);
console.log(JSON.stringify({ issues: preflight.issues, high: preflight.high, medium: preflight.medium, low: preflight.low, pass: preflight.pass }, null, 2));
process.exit(preflight.pass ? 0 : 1);

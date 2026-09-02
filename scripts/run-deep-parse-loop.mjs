/**
 * 离线运行真实导入 loop（分块生成 + 最终分支 + 3 轮取最优）。
 *
 * 用法：
 *   node scripts/run-deep-parse-loop.mjs <场景目录> [dataDir]
 *
 * 场景目录需包含 original.txt；使用 dataDir/config.json 的 LLM 配置
 * （默认 ~/.dsh/coc）。输出 deep-parse.gen.json 与 quality.json。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  extractCheckpoints,
  extractSceneFacts,
} from "../lib/core/index.js";
import { runDeepParseGenerationLoop } from "../lib/shared/tools/deep-parse-loop.js";
import { callLlmApi, loadLlmConfig } from "../lib/shared/llm.js";

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

const startedAt = Date.now();
let loopOptions = {};
try {
  loopOptions = loadLlmConfig(dataDir)?.deepParse ?? {};
} catch {
  loopOptions = {};
}
const loop = await runDeepParseGenerationLoop(
  flat,
  { callLlmApi, dataDir },
  (_phase, message, _pct) => console.error(`[loop] ${message}`),
  loopOptions
);
const elapsed = Math.round((Date.now() - startedAt) / 1000);

writeFileSync(join(dir, "deep-parse.gen.json"), JSON.stringify(loop.deepParse ?? {}, null, 2));
writeFileSync(join(dir, "quality.json"), JSON.stringify(loop.quality, null, 2));
console.log(
  JSON.stringify(
    { name, status: loop.status, rounds: loop.quality.rounds, high: loop.quality.high, medium: loop.quality.medium, low: loop.quality.low, pass: loop.quality.pass, elapsedSec: elapsed },
    null,
    2
  )
);

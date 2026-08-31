/**
 * 导出深度解析校对包（D-4 后全量剧本校对用）
 *
 * 对每个剧本执行：
 *   提取文本 → 确定性结构草拟 → buildDeepParsePrompt → callLlmApi
 *   → parseDeepParseResult → mergeDeepParseDraft
 *   并把 original.txt / deterministic.json / deep-parse.json / status.json
 *   写入 artifacts/deep-parse-review/<slug>/。
 *
 * 用法：
 *   node scripts/export-deep-parse-review.mjs
 *
 * 不读/写任何密钥；LLM 配置沿用 ~/.dsh/coc/config.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDeepParsePrompt,
  compileByPattern,
  extractCheckpoints,
  extractFileText,
  extractSceneFacts,
  mergeDeepParseDraft,
  parseDeepParseResult,
  toLegacyFormat,
} from "../lib/core/index.js";
import { callLlmApi } from "../lib/shared/llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const reviewDir = join(root, "artifacts", "deep-parse-review");

function slugify(name) {
  const clean = String(name ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, "-");
  return clean.length > 0 ? clean : "scenario";
}

const SCENARIOS = [
  { name: "墨渊V1.1.docx", file: join(root, "tests", "墨渊V1.1.docx"), textFile: null },
  { name: "两面不是人v2.1.pdf", file: join(root, "tests", "fixtures", "scenarios", "两面不是人v2.1.pdf"), textFile: join(root, "tests", "fixtures", "scenarios", "两面不是人v2.1.txt") },
  { name: "观止-见世之蝶.docx", file: join(root, "tests", "fixtures", "scenarios", "观止-见世之蝶.docx"), textFile: null },
  { name: "淡焱无生-对流.docx", file: join(root, "tests", "fixtures", "scenarios", "淡焱无生-对流.docx"), textFile: null },
  { name: "盲愚之眼_瓦上狸奴译.pdf", file: join(root, "tests", "fixtures", "scenarios", "盲愚之眼_瓦上狸奴译.pdf"), textFile: join(root, "tests", "fixtures", "scenarios", "盲愚之眼_瓦上狸奴译.txt") },
];

async function readScenarioText(entry) {
  if (entry.textFile !== null && existsSync(entry.textFile)) {
    return readFileSync(entry.textFile, "utf8");
  }
  return extractFileText(entry.file);
}

function buildFlat(name, text) {
  const model = compileByPattern(text, name);
  const legacy = toLegacyFormat(model);
  return {
    scenario: { name, text },
    scenarioCheckpoints: extractCheckpoints(text),
    scenarioFacts: extractSceneFacts(text),
    keyPoints: legacy.keyPoints,
    branches: legacy.branches,
    entities: legacy.entities,
  };
}

function extractTextBlocks(llmResult) {
  return (llmResult?.blocks ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

for (const entry of SCENARIOS) {
  const slug = slugify(entry.name);
  const outDir = join(reviewDir, slug);
  mkdirSync(outDir, { recursive: true });
  console.log(`\n=== ${entry.name} → ${outDir}`);

  const text = await readScenarioText(entry);
  writeFileSync(join(outDir, "original.txt"), text, "utf8");

  const flat = buildFlat(entry.name, text);
  writeFileSync(join(outDir, "deterministic.json"), JSON.stringify({
    name: entry.name,
    keyPoints: flat.keyPoints,
    branches: flat.branches,
    entities: flat.entities,
    scenarioCheckpoints: flat.scenarioCheckpoints,
    scenarioFacts: flat.scenarioFacts,
  }, null, 2), "utf8");

  const prompt = buildDeepParsePrompt(flat);
  writeFileSync(join(outDir, "prompt.txt"), prompt, "utf8");

  try {
    const llmResult = await callLlmApi(join(process.env.HOME ?? "", ".dsh", "coc"), [
      { role: "user", content: [{ type: "text", text: prompt }] },
    ], { temperature: 0, max_tokens: 12000, model: "ds v4-flash 0731" });
    const rawText = extractTextBlocks(llmResult);
    const parsed = parseDeepParseResult(rawText, flat);
    if (parsed.deepParse !== null && parsed.issues.length === 0) {
      const merged = mergeDeepParseDraft(flat, parsed.deepParse);
      const deepParse = {
        status: "draft",
        source: "llm",
        reviewed: false,
        generatedAt: new Date().toISOString(),
        ...merged.deepParse,
      };
      writeFileSync(join(outDir, "deep-parse.json"), JSON.stringify(deepParse, null, 2), "utf8");
      writeFileSync(join(outDir, "status.json"), JSON.stringify({
        ok: true,
        name: entry.name,
        status: "draft",
        keyPointsAdded: merged.keyPointsAdded,
        branchesAdded: merged.branchesAdded,
        chars: text.length,
        checkpoints: flat.scenarioCheckpoints.length,
        sceneFacts: flat.scenarioFacts.length,
      }, null, 2), "utf8");
      console.log(`  ok draft: +${merged.keyPointsAdded} kp / +${merged.branchesAdded} br`);
    } else {
      writeFileSync(join(outDir, "status.json"), JSON.stringify({
        ok: false,
        name: entry.name,
        status: "skipped",
        issues: parsed.issues,
        raw: parsed.raw,
      }, null, 2), "utf8");
      console.log(`  skipped: ${parsed.issues.join("；")}`);
    }
  } catch (error) {
    writeFileSync(join(outDir, "status.json"), JSON.stringify({
      ok: false,
      name: entry.name,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    }, null, 2), "utf8");
    console.log(`  error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n完成。输出目录：${reviewDir}`);

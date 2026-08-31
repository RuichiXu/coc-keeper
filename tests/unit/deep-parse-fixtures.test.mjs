/**
 * 深度剧本解析（deep-parse）真实剧本夹具测试
 *
 * 不依赖 LLM、不启动浏览器。用真实剧本文件走确定性链路：
 *   读取文本 → compileByPattern / extractSceneFacts / extractCheckpoints 造 flat
 *   → buildDeepParsePrompt → 解析固定样本 → validateDeepParse。
 *
 * PDF 使用预提取的 .txt 缓存（避免每次测试都跑 pdf-parse），
 * DOCX 直接走 extractFileText（毫秒级）。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  buildDeepParsePrompt,
  compileByPattern,
  extractCheckpoints,
  extractFileText,
  extractSceneFacts,
  normalizeDeepParse,
  parseDeepParseResult,
  toLegacyFormat,
  validateDeepParse,
} from "../../lib/core/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "scenarios");

const TEXT_SCENARIOS = [
  { file: "两面不是人v2.1.pdf", minChars: 5000, minCheckpoints: 1, useCache: true },
  { file: "观止-见世之蝶.docx", minChars: 2000, minCheckpoints: 1, useCache: false },
  { file: "淡焱无生-对流.docx", minChars: 2000, minCheckpoints: 1, useCache: false },
  { file: "盲愚之眼_瓦上狸奴译.pdf", minChars: 5000, minCheckpoints: 1, useCache: true },
];

async function readScenarioText({ file, useCache }) {
  if (useCache) {
    const cacheFile = file.replace(/\.pdf$/i, ".txt");
    return readFileSync(join(FIXTURE_DIR, cacheFile), "utf8");
  }
  return extractFileText(join(FIXTURE_DIR, file));
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

describe("deep-parse 真实剧本夹具", () => {
  for (const { file, minChars, minCheckpoints, useCache } of TEXT_SCENARIOS) {
    it(`${file}：文本读取 → 确定性结构 → Prompt → 解析校验`, async () => {
      const text = await readScenarioText({ file, useCache });
      expect(text.length).toBeGreaterThan(minChars);

      const flat = buildFlat(file, text);
      expect(flat.scenarioCheckpoints.length).toBeGreaterThanOrEqual(minCheckpoints);

      const prompt = buildDeepParsePrompt(flat);
      // Prompt 必须包含剧本名、产物结构与关键字段约束。
      expect(prompt).toContain(file);
      expect(prompt).toContain("keyPointConditions");
      expect(prompt).toContain("branchConditions");
      expect(prompt).toContain("plotEdges");
      expect(prompt).toContain("endings");
      expect(prompt).toContain("blockers");
      // 确定性检定点必须作为结构化参考注入 Prompt。
      for (const check of flat.scenarioCheckpoints.slice(0, 3)) {
        expect(prompt).toContain(check.id);
      }

      // 用“LLM 生成新节点”的样本解析：参考里可能没有关键点/分支，
      // LLM 必须在 deepParse 中自己生成节点，并让条件/边/结局引用这些 id。
      const raw = JSON.stringify({
        keyPoints: [{ id: "kp-1", title: "关键发现", scene: flat.scenarioFacts[0]?.heading ?? "" }],
        branches: [{ id: "br-1", title: "关键抉择", options: [{ label: "继续调查", leadsTo: "关键发现" }] }],
        keyPointConditions: [{ keyPointId: "kp-1", requires: { checkpointGroups: [[flat.scenarioCheckpoints[0].id]] } }],
        branchConditions: [{ branchId: "br-1", requires: { scene: flat.scenarioFacts[0]?.heading ?? "" } }],
        plotEdges: [{ from: "br:br-1", to: "kp:kp-1", label: "继续调查", requires: [], consequences: { setFlags: { "branch:br-1:chosen": "继续调查" } } }],
        endings: [{ branchId: "br-1", title: "调查结局", requires: { branchChoiceIds: ["br-1"] }, blockers: [], endingKeywords: ["调查结局"] }],
      });
      const parsed = parseDeepParseResult(raw, flat);
      expect(parsed.issues).toEqual([]);
      expect(parsed.deepParse.keyPoints).toHaveLength(1);
      expect(parsed.deepParse.branches).toHaveLength(1);
      expect(parsed.deepParse.endings).toHaveLength(1);
      expect(validateDeepParse(normalizeDeepParse(parsed.deepParse), flat)).toEqual([]);
    });
  }
});

const result = await run({ verbose: true });
process.exit(summarize(result, "deep-parse 真实剧本夹具测试"));

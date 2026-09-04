import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { GameSession, AssetStore } from "../../lib/core/index.js";
import { callLlmApi } from "../../lib/shared/llm.js";
import { createImportToolDefs } from "../../lib/shared/tools/import.js";
import { runDeepParsePreflight } from "../../lib/core/scenario/deep-parse.js";
import { runDeepParseRuleReview } from "../../lib/core/scenario/deep-parse-review.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "artifacts", "import-verify", "4scenarios");
const cacheDir = join(outDir, "cache");
const gameDir = join(outDir, "games");
const assetDir = join(outDir, "assets");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(gameDir, { recursive: true });
mkdirSync(assetDir, { recursive: true });

const SCENARIOS = [
  { label: "对流-短", gameId: "verify-对流", file: "tests/fixtures/scenarios/淡焱无生-对流.docx" },
  { label: "两面不是人-中A", gameId: "verify-两面不是人", file: "tests/fixtures/scenarios/两面不是人v2.1.txt" },
  { label: "盲愚之眼-中B", gameId: "verify-盲愚之眼", file: "tests/fixtures/scenarios/盲愚之眼_瓦上狸奴译.txt" },
  { label: "星孩-长", gameId: "verify-星孩", file: "tests/fixtures/hidden_scenarios/星孩v1.0/星孩v1.0（无插图版）.pdf" },
];

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// ── 带缓存的 callLlmApi ───────────────────────────────────
function cacheKey(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}
async function cachedCallLlmApi(_dataDir, messages, options = {}) {
  const key = cacheKey({ messages, options });
  const file = join(cacheDir, key + ".json");
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8"));
    log(`cache hit ${key} model=${options.model || "(default)"} max_tokens=${options.max_tokens ?? "-"}`);
    if (cached.error) throw new Error(cached.error);
    return cached.result;
  }
  const timeoutMs = 360000; // 兜底，内部调用已有 90s/180s/300s 超时
  log(`llm call ${key} model=${options.model || "(default)"} max_tokens=${options.max_tokens ?? "-"}`);
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      callLlmApi(_dataDir, messages, options),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`LLM 兜底超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)),
    ]);
    writeFileSync(file, JSON.stringify({ result }, null, 2));
    const raw = (result.blocks ?? []).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
    log(`llm ok ${key} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s content=${raw.length}B usage=${JSON.stringify(result.usage ?? {}).slice(0, 140)}`);
    return result;
  } catch (error) {
    log(`llm fail ${key} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s error=${String(error?.message ?? error)}`);
    throw error;
  }
}

function countIsolated(preflightIssues) {
  return (preflightIssues ?? []).filter((issue) => {
    if (issue?.severity === "low") return false;
    const where = String(issue?.where ?? "");
    const problem = String(issue?.problem ?? "");
    return where.startsWith("keyPoints[") && (problem.includes("不可达") || problem.includes("没有非自环入边"));
  }).length;
}

function judge(label, pre, rule, quality, isolatedCount) {
  const gate = {
    preflight: pre.high === 0 && pre.medium === 0,
    rule: rule.high === 0 && rule.medium === 0,
    review: (quality?.reviewHigh ?? 0) === 0 && (quality?.reviewMedium ?? 0) <= 2,
    chunk: (quality?.chunkHigh ?? 0) === 0 && (quality?.chunkMedium ?? 0) === 0,
    isolated: isolatedCount === 0,
  };
  gate.pass = gate.preflight && gate.rule && gate.review && gate.chunk && gate.isolated;
  log(`gate ${label} preflight=${gate.preflight}(${pre.high}h/${pre.medium}m) rule=${gate.rule}(${rule.high}h/${rule.medium}m) review=${gate.review}(${quality?.reviewHigh ?? "-"}h/${quality?.reviewMedium ?? "-"}m) chunk=${gate.chunk}(${quality?.chunkHigh ?? "-"}h/${quality?.chunkMedium ?? "-"}m) isolated=${gate.isolated}(${isolatedCount}) => ${gate.pass ? "PASS" : "FAIL"}`);
  return gate;
}

async function runOne(def, scenario) {
  const filePath = join(root, scenario.file);
  log(`══ 开始导入 ${scenario.label} ══ file=${scenario.file}`);
  const t0 = Date.now();
  let importValue = null;
  try {
    importValue = await def.execute(
      { kind: "scenario", source: "file", filePath, name: scenario.label.split("-")[0], game: scenario.gameId, parseStructure: true, overwrite: true },
      { onProgress: (_kind, message, percent) => log(`progress ${String(percent ?? "").padStart(3, " ")}% ${message}`) }
    );
  } catch (error) {
    log(`导入失败 elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
    console.error(error.stack || error);
    return null;
  }
  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  log(`导入完成 elapsed=${elapsedSec}s value=${JSON.stringify(importValue).slice(0, 400)}`);

  const statePath = join(gameDir, scenario.gameId + ".json");
  const flat = JSON.parse(readFileSync(statePath, "utf8"));
  const deepParse = flat.deepParse ?? {};
  const pre = runDeepParsePreflight(deepParse, flat);
  const rule = runDeepParseRuleReview(deepParse, flat, {});
  const quality = deepParse.quality ?? {};
  const isolatedCount = countIsolated(pre.issues);
  const gate = judge(scenario.label, pre, rule, quality, isolatedCount);

  const baseline = {
    label: scenario.label,
    gameId: scenario.gameId,
    file: scenario.file,
    name: flat.scenario?.name ?? "",
    chars: flat.scenario?.chars ?? 0,
    lines: flat.scenario?.lines ?? 0,
    elapsedSec,
    importResult: importValue,
    structureSections: flat.scenarioStructure?.sections?.length ?? 0,
    scenarioFacts: flat.scenarioFacts?.length ?? 0,
    keyPoints: flat.keyPoints?.length ?? 0,
    branches: flat.branches?.length ?? 0,
    endings: deepParse.endings?.length ?? 0,
    plotEdges: deepParse.plotEdges?.length ?? 0,
    deepParseStatus: deepParse.status ?? "none",
    loopQuality: quality,
    preflightRecomputed: pre,
    ruleRecomputed: rule,
    isolatedKeyPointCount: isolatedCount,
    gate,
  };
  const outFile = join(outDir, `${scenario.gameId}.baseline.json`);
  writeFileSync(outFile, JSON.stringify(baseline, null, 2));
  log(`baseline 已写 ${outFile}`);
  return baseline;
}

async function main() {
  const which = process.argv[2];
  const scenarios = which ? SCENARIOS.filter((s) => s.gameId.includes(which) || s.label.includes(which)) : SCENARIOS;
  const baselines = [];
  for (const scenario of scenarios) {
    const dataDir = join(process.env.HOME, ".dsh", "coc");
    const session = new GameSession({ id: scenario.gameId });
    // assetStore 根目录走 proxy 隐藏：保留场景资产写入能力，但跳过 PDF 页图渲染（纯前端资产，不影响解析质量基线）。
    const realAssetStore = new AssetStore(assetDir);
    const assetStore = new Proxy(realAssetStore, {
      get(target, prop, receiver) {
        if (prop === "rootDir") return undefined;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const deps = {
      dataDir,
      defaultGame: scenario.gameId,
      callLlmApi: cachedCallLlmApi,
      session,
      stateKey: (id) => join(gameDir, id + ".json"),
      persistence: {
        load: (path) => {
          try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
        },
        save: (path, flat) => {
          writeFileSync(path, JSON.stringify(flat, null, 2));
        },
      },
      maxRollHistory: 200,
      assetStore,
    };
    const defs = createImportToolDefs(deps);
    const importDef = defs.find((d) => d.name === "coc_import");
    if (!importDef) throw new Error("coc_import def not found");
    const baseline = await runOne(importDef, scenario);
    if (baseline !== null) baselines.push(baseline);
  }
  const summaryFile = join(outDir, "summary.json");
  writeFileSync(summaryFile, JSON.stringify(baselines, null, 2));
  log(`全部完成，共 ${baselines.length}/${scenarios.length} 个成功，summary 已写 ${summaryFile}`);
  const failed = baselines.filter((b) => b.gate.pass !== true);
  if (failed.length > 0) {
    log(`未通过：${failed.map((b) => b.label).join("、")}`);
    process.exitCode = 2;
  } else {
    log("全部通过 ✅");
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});

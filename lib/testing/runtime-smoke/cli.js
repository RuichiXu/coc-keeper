/**
 * Runtime Smoke CLI（在线运行冒烟测试）
 *
 * 用法示例：
 *   node scripts/runtime-smoke.mjs --kp mock --player scripted
 *   node scripts/runtime-smoke.mjs --kp llm --player scripted --scenario-id verify-对流 --max-turns 30
 *   node scripts/runtime-smoke.mjs --kp llm --player llm --scenario-id verify-对流 --evaluator llm
 *   node scripts/runtime-smoke.mjs --kp llm --player http --player-endpoint http://127.0.0.1:8787/next
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHarness, loadGameFlat, makeSyntheticFlat, saveGameFlat, seedInvestigator, runGame, writeReport, resolveScenarioPath, defaultCocDataDir, llmModels, makeMockKpStream, makeLiveKpStream, scenarioPremise } from "./runner.js";
import { createScriptedPlayer, createLlmPlayer, createHttpPlayerDriver } from "./player-driver.js";
import { createThresholdEvaluator, createLlmEvaluator, createHttpEvaluator, applyHardThresholds } from "./evaluator.js";

// ── 默认人物卡 ──────────────────────────────────────────────

const MOCK_INVESTIGATOR = {
  name: "测试调查员",
  occupation: "侦探",
  stats: { STR: 55, CON: 60, SIZ: 60, DEX: 55, INT: 65, POW: 55, APP: 50, EDU: 60, LUCK: 60, HP: 12, SAN: 55, MP: 11 },
  hp: 12, san: 55, mp: 11, luck: 60,
  skills: { "侦查": 70, "聆听": 50, "图书馆使用": 50 },
  inventory: ["笔记本", "手电筒"],
  notes: "runtime smoke 测试调查员",
};

const DUILIU_INVESTIGATOR = {
  name: "林晚",
  occupation: "地质学家",
  stats: { STR: 60, CON: 65, SIZ: 55, DEX: 60, INT: 70, POW: 65, APP: 50, EDU: 70, LUCK: 60, HP: 12, SAN: 65, MP: 13 },
  hp: 12, san: 65, mp: 13, luck: 60,
  skills: { "聆听": 70, "跳跃": 60, "力量": 60, "意志": 65, "体质": 60, "侦查": 70, "图书馆使用": 60, "急救": 50 },
  inventory: ["手电筒", "笔记本", "钢笔", "保温杯"],
  notes: "runtime smoke 测试调查员（对流）",
};

// ── 参数解析 ────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

// ── 主流程 ──────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const kpMode = String(args.kp ?? "mock");
  const playerMode = String(args.player ?? "scripted");
  const evaluatorMode = String(args.evaluator ?? "threshold");
  const maxTurns = Number(args["max-turns"] ?? 25);
  const gameId = String(args["game-id"] ?? (kpMode === "mock" ? "smoke-mock" : "smoke-live"));
  const scenarioRef = args.scenario ?? args["scenario-id"] ?? (kpMode === "mock" ? "fixture" : "verify-对流");
  const outDir = args["out-dir"] ?? join("artifacts", "runtime-smoke", gameId);
  const keepData = args["keep-data"] === true;
  const cocDataDir = defaultCocDataDir();
  const models = llmModels(cocDataDir);
  const kpModel = args["kp-model"] ?? models.kp;
  const playerModel = args["player-model"] ?? models.player;
  const evaluatorModel = args["evaluator-model"] ?? models.evaluator;

  if (playerMode === "http" && typeof args["player-endpoint"] !== "string") {
    throw new Error("--player http 需要 --player-endpoint URL");
  }

  // 1) 数据目录：可复用已有目录继续跑（--data-dir），否则建临时目录。
  //    live 模式需要把真实 config.json（API Key/模型）拷进来，让 callLlmApi 读到配置。
  const resumeDataDir = typeof args["data-dir"] === "string" ? args["data-dir"] : null;
  const createdDataDir = resumeDataDir === null;
  const dataDir = resumeDataDir ?? mkdtempSync(join(tmpdir(), "coc-runtime-smoke-"));
  console.log(`[runtime-smoke] dataDir=${dataDir}${createdDataDir ? "" : "（复用）"}`);
  const realConfig = join(cocDataDir, "config.json");
  if (existsSync(realConfig) && !existsSync(join(dataDir, "config.json"))) {
    copyFileSync(realConfig, join(dataDir, "config.json"));
  }

  try {
    let flat = null;
    if (createdDataDir) {
      // 2) 剧本场次（新目录）。
      const scenarioPath = resolveScenarioPath(scenarioRef, cocDataDir);
      if (scenarioPath !== null) {
        console.log(`[runtime-smoke] 载入剧本 ${scenarioPath}`);
        flat = loadGameFlat(scenarioPath, gameId);
      } else if (scenarioRef === "fixture" || kpMode === "mock") {
        console.log(`[runtime-smoke] 使用合成测试剧本（fixture）`);
        flat = makeSyntheticFlat(gameId);
      } else {
        throw new Error(`找不到剧本 ${scenarioRef}（可用 --scenario 指定本地 JSON 路径，或 --scenario-id 指定 ~/.dsh/coc/games/<id>.json）`);
      }
    } else {
      // 复用目录：读取已有场次状态继续跑；人物卡从场次里取。
      console.log(`[runtime-smoke] 复用已有场次 ${gameId}`);
    }

    // 3) 聊天桥 + 工具。
    const kpExtraSystem = typeof args["kp-extra-system"] === "string" ? args["kp-extra-system"] : "";
    const streamBlocks = kpMode === "mock"
      ? makeMockKpStream()
      : makeLiveKpStream({ dataDir, model: kpModel, extraSystem: kpExtraSystem });
    const harness = createHarness({ dataDir, gameId, streamBlocks });
    if (flat !== null) {
      saveGameFlat(harness, flat);
    } else {
      flat = harness.persistence.load(harness.stateKey) ?? makeSyntheticFlat(gameId);
    }

    // 4) 调查员：新目录时写入；复用目录时若已有角色则沿用。
    const pc = kpMode === "mock" ? MOCK_INVESTIGATOR : DUILIU_INVESTIGATOR;
    const existingCharacters = (flat.characters ?? []);
    if (existingCharacters.length === 0) {
      await seedInvestigator(harness, pc);
      console.log(`[runtime-smoke] 已添加调查员 ${pc.name}`);
    } else {
      const existing = existingCharacters[0];
      console.log(`[runtime-smoke] 复用调查员 ${existing.name}`);
      existingCharacters.forEach((character) => {
        Object.assign(pc, { name: character.name, occupation: character.occupation, skills: character.skills, inventory: character.inventory });
      });
    }

    // 5) 玩家。
    const premise = scenarioPremise(flat, 600) || String(flat?.scenario?.text ?? "").slice(0, 600);
    let player;
    if (playerMode === "scripted") {
      player = createScriptedPlayer({
        actions: kpMode === "mock"
          ? ["开始游戏", "我要搜索房间", "打开暗格"]
          : ["开始游戏，我扮演唯一调查员。"],
        fallbackAction: "继续调查。",
      });
    } else if (playerMode === "llm") {
      const playerExtraSystem = typeof args["player-extra-system"] === "string" ? args["player-extra-system"] : "";
      player = createLlmPlayer({ dataDir, investigator: pc, premise, model: playerModel, extraSystem: playerExtraSystem });
    } else if (playerMode === "http") {
      player = createHttpPlayerDriver(String(args["player-endpoint"]));
    } else {
      throw new Error(`未知 --player ${playerMode}`);
    }
    console.log(`[runtime-smoke] 玩家驱动：${player.id}；KP：${kpMode}；最多 ${maxTurns} 轮`);

    // 6) 跑团。
    const report = await runGame({
      harness,
      player,
      maxTurns,
      playerName: pc.name,
      onTurn: ({ round, input, narration }) => {
        console.log(`\n── 第 ${round} 轮 ─────────────────────────`);
        console.log(`玩家: ${input}`);
        console.log(`KP: ${String(narration ?? "").slice(0, 300)}`);
      },
    });

    // 7) 评审。
    let evaluatorResult = null;
    if (evaluatorMode === "llm") {
      const evaluator = createLlmEvaluator({ dataDir, model: evaluatorModel });
      console.log(`[runtime-smoke] LLM 评审中（model=${evaluatorModel}）...`);
      evaluatorResult = await evaluator.evaluate(report);
    } else if (evaluatorMode === "threshold") {
      evaluatorResult = await createThresholdEvaluator().evaluate(report);
    } else if (evaluatorMode === "none") {
      evaluatorResult = null;
    } else if (evaluatorMode === "http") {
      const evaluatorEndpoint = args["evaluator-endpoint"];
      if (typeof evaluatorEndpoint !== "string") {
        throw new Error("--evaluator http 需要 --evaluator-endpoint URL");
      }
      evaluatorResult = await createHttpEvaluator(String(evaluatorEndpoint)).evaluate(report);
    } else {
      throw new Error(`未知 --evaluator ${evaluatorMode}`);
    }

    // 8) 合成门槛结论（确定性硬门槛；LLM 评分在 evaluator 内已合成）。
    const hardReasons = Array.isArray(evaluatorResult?.overall?.hardReasons)
      ? evaluatorResult.overall.hardReasons
      : applyHardThresholds(report).hard;
    const softReasons = Array.isArray(evaluatorResult?.overall?.softReasons)
      ? evaluatorResult.overall.softReasons
      : applyHardThresholds(report).soft;
    const passed = evaluatorResult === null ? hardReasons.length === 0 : !evaluatorResult.hardFail;

    writeReport(outDir, report, evaluatorResult);

    console.log(`\n[runtime-smoke] 结束原因：${report.stopReason}`);
    console.log(`[runtime-smoke] 轮数：${report.metrics.turns}；内部循环：${report.metrics.totalLoopRounds}；异常：${report.metrics.exceptions}；busy悬挂：${report.metrics.busyHangs}`);
    console.log(`[runtime-smoke] 骰点：${report.metrics.rolls}；检定点通过：${report.metrics.checkpointsPassed}；结局：${report.final.endingReached ? "已抵达" : "未抵达"}`);
    console.log(`[runtime-smoke] 一致性：${report.final.consistency.pass ? "通过" : "问题：" + report.final.consistency.problems.join("；")}`);
    if (hardReasons.length > 0) {
      console.log(`[runtime-smoke] 硬门槛未过：`);
      for (const reason of hardReasons) console.log(`  - ${reason}`);
    }
    if (softReasons.length > 0) {
      console.log(`[runtime-smoke] 软提醒：`);
      for (const reason of softReasons) console.log(`  - ${reason}`);
    }
    if (evaluatorResult?.dimensions?.length > 0) {
      console.log(`[runtime-smoke] 维度评分：`);
      for (const dim of evaluatorResult.dimensions) {
        console.log(`  - ${dim.name}：${dim.score}`);
      }
      console.log(`[runtime-smoke] 总评：${evaluatorResult.overall?.verdict ?? "unknown"} — ${evaluatorResult.overall?.summary ?? ""}`);
    }
    console.log(`[runtime-smoke] 报告目录：${outDir}`);
    console.log(`[runtime-smoke] 结论：${passed ? "PASS" : "NO-GO"}`);
    return passed ? 0 : 1;
  } finally {
    if (createdDataDir && !keepData) {
      rmSync(dataDir, { recursive: true, force: true });
    } else if (createdDataDir) {
      console.log(`[runtime-smoke] 保留临时数据目录：${dataDir}`);
    } else {
      console.log(`[runtime-smoke] 复用数据目录保留：${dataDir}`);
    }
  }
}

/**
 * Runtime Smoke Runner（在线运行冒烟测试）
 *
 * 不启动 DSH host、不做浏览器 E2E，只驱动真实聊天桥：
 * 模拟前端 /coc-api/chat 的输入事件（普通消息 / .ra 检定 / 候选确认）。
 *
 * 职责：
 *   - 搭临时 dataDir + GameSession + toolDefs + createSharedChatBridge
 *   - 载入/重置剧本场次（真实 DB 或合成 fixture）
 *   - 用统一 PlayerDriver 循环跑团
 *   - 采集 metrics / 完整对话 / 一致性检查
 *
 * 零 DSH 依赖，可被外部 agent（Codex）import 或 CLI 调用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AssetStore, GameSession, JsonFilePersistence } from "../../core/index.js";
import { createSharedToolDefs } from "../../shared/tools/index.js";
import { createSharedChatBridge } from "../../shared/chat/index.js";
import { callLlmApi, loadLlmConfig } from "../../shared/llm.js";
import { buildPlayerContext } from "./player-driver.js";

// ── 基础工具 ────────────────────────────────────────────────

export function safeGameId(id) {
  const clean = String(id ?? "smoke")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean.slice(0, 64) : "smoke";
}

export function createStateKey(gameId) {
  return join("games", `${safeGameId(gameId)}.json`);
}

/**
 * 创建聊天桥与工具注册表。
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {string} opts.gameId
 * @param {string} [opts.llmProvider]
 * @param {string} [opts.llmModel]
 * @param {number} [opts.maxChatRounds=4]
 * @param {number} [opts.maxChatLog=120]
 * @param {number} [opts.maxRollHistory=200]
 * @param {Function} [opts.streamBlocks] - 覆盖 KP 的 LLM 流（mock/live 包装器）
 */
export function createHarness(opts = {}) {
  const dataDir = opts.dataDir;
  const gameId = safeGameId(opts.gameId ?? "smoke");
  const stateKeyFor = (id) => createStateKey(id);
  const stateKey = stateKeyFor(gameId);
  const persistence = new JsonFilePersistence(dataDir);
  const assetStore = new AssetStore(join(dataDir, "assets"));
  const session = new GameSession({ id: gameId });
  const deps = {
    session,
    persistence,
    assetStore,
    dataDir,
    defaultGame: gameId,
    maxRollHistory: opts.maxRollHistory ?? 200,
    llmProvider: opts.llmProvider,
    llmModel: opts.llmModel,
    maxChatRounds: opts.maxChatRounds ?? 4,
    maxChatLog: opts.maxChatLog ?? 120,
    callLlmApi,
    stateKey: stateKeyFor,
  };
  deps.toolDefs = createSharedToolDefs(deps);
  const bridge = createSharedChatBridge({
    ...deps,
    streamBlocks:
      typeof opts.streamBlocks === "function"
        ? opts.streamBlocks
        : (options) => callLlmApi(dataDir, options.messages, options),
  });
  return { deps, bridge, persistence, assetStore, stateKey, stateKeyFor, gameId };
}

// ── 剧本场次准备 ────────────────────────────────────────────

/**
 * 载入一个游戏 DB（flat JSON）并重置运行时字段。
 * 保留剧本/关键点/分支/检定点/deepParse/契约等“内容”，清空“进度”。
 * @param {string} sourcePath - 本地游戏 JSON（如 ~/.dsh/coc/games/verify-对流.json）
 * @param {string} gameId
 * @returns {object} flat
 */
export function loadGameFlat(sourcePath, gameId) {
  const raw = JSON.parse(readFileSync(sourcePath, "utf8"));
  const flat = resetRuntime(JSON.parse(JSON.stringify(raw)), gameId);
  return flat;
}

/**
 * 合成的最小单人测试剧本（mock 档用）。
 * @param {string} gameId
 * @returns {object} flat
 */
export function makeSyntheticFlat(gameId) {
  const text = [
    "【场景】测试房间",
    "这是一间积满灰尘的旧房间，书架和书桌靠墙摆放。",
    "【场景】暗格",
    "书架后面藏着一个上锁的暗格。",
    "【关键剧情点】发现暗格",
    "调查员在书架后发现了一个隐藏的暗格。",
    "【分支】是否打开暗格",
    "暗格上了锁，需要决定是否强行打开。",
    "【结局】找到古书",
    "暗格中放着一本古书，记载着不为人知的仪式。",
  ].join("\n");
  return resetRuntime({
    id: safeGameId(gameId),
    title: "合成测试房间",
    kpMode: "ai",
    scenario: { name: "合成测试房间", text, summary: "测试用单人短剧本。", chars: text.length },
    keyPoints: [],
    branches: [{
      id: "br-final-1",
      title: "最终抉择：打开暗格",
      scene: "测试房间",
      reached: true,
      chosen: "打开暗格",
      options: [{ label: "打开暗格", leadsTo: "找到古书结局" }],
    }],
    deepParse: null,
    scenarioFacts: [],
    scenarioCheckpoints: [],
  }, gameId);
}

/**
 * 重置运行时进度字段（保内容，清进度）。
 * @param {object} flat
 * @param {string} gameId
 * @returns {object}
 */
export function resetRuntime(flat, gameId) {
  const next = flat;
  next.id = safeGameId(gameId);
  next.title = String(flat.title ?? gameId);
  next.updatedAt = new Date().toISOString();
  next.kpMode = "ai";
  next.rules = flat.rules ?? null;
  next.scenario = flat.scenario ?? null;
  next.characters = [];
  next.currentScene = "";
  next.currentBranchId = "";
  next.time = "";
  next.synopsis = "";
  next.tasks = [];
  next.entities = [];
  next.log = [];
  next.toolTrace = [];
  next.rollHistory = [];
  next.reminders = [];
  next.pendingChecks = [];
  next.skippedChecks = [];
  next.sanitySettled = [];
  next.events = [];
  next.resolvedChecks = [];
  next.passedCheckpointIds = [];
  next.spellShown = false;
  next.endingReached = false;
  next.endedAt = null;
  next.firedNightEventIds = [];
  next.pendingChoice = null;
  next.busy = false;
  next.core = null;
  return next;
}

/**
 * 把场次写入临时 dataDir。
 * @param {object} harness
 * @param {object} flat
 */
export function saveGameFlat(harness, flat) {
  harness.persistence.save(harness.stateKey, flat);
  return flat;
}

/**
 * 通过 coc_character 工具添加调查员（与前端 KP 面板同路径）。
 * @param {object} harness
 * @param {object} pc - 人物卡
 */
export async function seedInvestigator(harness, pc) {
  const def = harness.deps.toolDefs.get("coc_character");
  if (def === undefined) throw new Error("缺少 coc_character 工具");
  await def.execute({ action: "add", game: harness.gameId, character: pc }, {});
  return harness.persistence.load(harness.stateKey);
}

// ── KP LLM 流 ───────────────────────────────────────────────

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const parts = (message.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "");
    return parts.join("");
  }
  return "";
}

function textBlocks(text) {
  return { blocks: [{ type: "text", text }], finish: { kind: "stop" }, usage: {} };
}

/**
 * Mock KP 流：确定性走完“登记门禁 → 团检 → 叙述”的循环。
 * @param {object} [opts]
 * @param {string} [opts.skill="侦查"]
 * @param {string} [opts.action="搜索房间"]
 * @param {string} [opts.scene="测试房间"]
 */
export function makeMockKpStream(opts = {}) {
  const skill = opts.skill ?? "侦查";
  const action = opts.action ?? "搜索房间";
  const scene = opts.scene ?? "测试房间";
  const state = { gateCreated: false, raSeen: false };
  return async (options) => {
    const last = lastUserText(options.messages);
    if (last.includes("【系统检定】")) {
      state.raSeen = true;
      return textBlocks("你仔细搜索了房间，在书架后发现一个隐藏的暗格。");
    }
    if (last.includes("工具已执行") || last.includes("请立即输出剧情叙述")) {
      // 不在叙述里重复发团检标记：coc_check 工具已把门禁落盘，
      // runKpTurn 会在落盘后统一追加 [团检：技能] [.ra技能] 提示行。
      return textBlocks(`你来到${scene}，这里积满灰尘。你可以搜索一下。`);
    }
    if (!state.gateCreated) {
      state.gateCreated = true;
      return {
        blocks: [{
          type: "tool-call",
          id: "mock-call-1",
          name: "coc_check",
          arguments: JSON.stringify({ skill, action, difficulty: "regular" }),
        }],
        finish: { kind: "tool" },
        usage: {},
      };
    }
    if (state.raSeen) {
      return textBlocks("你打开暗格，里面放着一本古书。找到古书，任务到此结束。");
    }
    return textBlocks("你继续调查，但暂时没有更多发现。");
  };
}

/**
 * Live KP 流：真实 LLM，注入“短叙述”测试约束并压低 max_tokens。
 * 不改生产代码；约束只存在于测试包装层。
 * @param {object} [opts]
 * @param {string} opts.dataDir
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens=500]
 * @param {number} [opts.temperature=0.3]
 */
export function makeLiveKpStream(opts = {}) {
  const dataDir = opts.dataDir;
  const model = opts.model;
  const maxTokens = opts.maxTokens ?? 500;
  const temperature = opts.temperature ?? 0.3;
  const extraSystem = typeof opts.extraSystem === "string" ? opts.extraSystem : "";
  return async (options) => {
    const parts = [
      options.system ?? "",
      "（测试约束）每轮剧情叙述控制在150字以内，不要重复已经交代过的信息，不要输出元分析或旁白。",
      extraSystem,
    ].filter((part) => part.length > 0);
    const system = parts.join("\n");
    return callLlmApi(dataDir, options.messages, {
      ...options,
      system,
      model,
      max_tokens: maxTokens,
      temperature,
      reasoningEffort: "low",
    });
  };
}

// ── 跑团主循环 ──────────────────────────────────────────────

/**
 * 跑完整局。
 * @param {object} opts
 * @param {object} opts.harness
 * @param {object} opts.player - PlayerDriver
 * @param {number} [opts.maxTurns=25]
 * @param {string} [opts.playerName="测试调查员"]
 * @param {Function} [opts.onTurn] - 每轮回调（用于 CLI 打印）
 * @returns {Promise<object>} report
 */
export async function runGame(opts = {}) {
  const harness = opts.harness;
  const player = opts.player;
  const maxTurns = opts.maxTurns ?? 25;
  const playerName = opts.playerName ?? "测试调查员";
  const onTurn = typeof opts.onTurn === "function" ? opts.onTurn : null;

  const metrics = {
    turns: 0,
    exceptions: 0,
    busyHangs: 0,
    emptyNarrations: 0,
    emptyInputs: 0,
    stuckTurns: 0,
    toolSyntaxLeaks: 0,
    toolErrors: 0,
    totalLoopRounds: 0,
    maxLoopRounds: 0,
    endingReached: false,
  };
  const turns = [];
  let lastNarration = "";
  let stopReason = "max-turns";
  const previousInputs = [];

  for (let round = 1; round <= maxTurns; round += 1) {
    let flat = harness.persistence.load(harness.stateKey);
    if (flat?.endingReached === true) {
      stopReason = "already-ended";
      break;
    }
    const ctx = buildPlayerContext(flat ?? {}, { round: round - 1, narration: lastNarration });

    let input;
    try {
      input = String((await player.nextInput(ctx)) ?? "").trim();
    } catch (error) {
      metrics.exceptions += 1;
      stopReason = `player-error: ${error instanceof Error ? error.message : String(error)}`;
      turns.push({ round, input: "", narration: "", error: stopReason });
      break;
    }

    if (input.length === 0) {
      metrics.emptyInputs += 1;
      stopReason = flat?.endingReached === true ? "ended" : "player-done";
      break;
    }

    // 连续 3 轮完全相同的输入视为卡住（保留 .ra 重试的合理空间）。
    previousInputs.push(input);
    if (previousInputs.length > 3) previousInputs.shift();
    if (previousInputs.length === 3 && previousInputs.every((item) => item === input)) {
      metrics.stuckTurns += 1;
      stopReason = "stuck-same-input";
      turns.push({ round, input, narration: "", loopRounds: 0, pendingChecks: flat?.pendingChecks?.length ?? 0, stopReason });
      break;
    }

    let result;
    try {
      result = await harness.bridge.runKpTurn(harness.gameId, input, playerName);
    } catch (error) {
      metrics.exceptions += 1;
      stopReason = `kp-error: ${error instanceof Error ? error.message : String(error)}`;
      turns.push({ round, input, narration: "", error: stopReason });
      break;
    }

    flat = harness.persistence.load(harness.stateKey);
    metrics.turns += 1;
    metrics.totalLoopRounds += result.rounds ?? 0;
    metrics.maxLoopRounds = Math.max(metrics.maxLoopRounds, result.rounds ?? 0);
    if (result.busy !== false) metrics.busyHangs += 1;
    if (result.emptyNarration === true || String(result.narration ?? "").trim().length === 0) metrics.emptyNarrations += 1;
    metrics.toolSyntaxLeaks += result.toolSyntaxLeaks ?? 0;

    turns.push({
      round,
      input,
      narration: result.narration,
      loopRounds: result.rounds ?? 0,
      pendingChecks: Array.isArray(result.pendingChecks) ? result.pendingChecks.length : 0,
      scene: flat?.currentScene ?? "",
      endingReached: flat?.endingReached === true,
    });
    lastNarration = result.narration ?? "";
    if (onTurn !== null) await onTurn({ round, input, narration: lastNarration, flat });

    if (flat?.endingReached === true) {
      stopReason = "ending";
      break;
    }
  }

  const flat = harness.persistence.load(harness.stateKey) ?? {};
  const final = {
    endingReached: flat.endingReached === true,
    currentScene: flat.currentScene ?? "",
    time: flat.time ?? "",
    hp: (flat.characters ?? [])[0]?.hp ?? null,
    san: (flat.characters ?? [])[0]?.san ?? null,
    consistency: verifyConsistency(flat),
  };
  metrics.endingReached = final.endingReached;
  metrics.rolls = (flat.rollHistory ?? []).length;
  metrics.checkpointsPassed = (flat.passedCheckpointIds ?? []).length;
  metrics.gatesResolved = (flat.resolvedChecks ?? []).length;
  metrics.pendingChecksFinal = (flat.pendingChecks ?? []).length;
  metrics.skippedChecks = (flat.skippedChecks ?? []).length;
  metrics.toolsCalled = (flat.toolTrace ?? []).filter((entry) => entry?.tool !== undefined).length;
  metrics.toolErrors = (flat.toolTrace ?? []).filter((entry) => entry?.tool !== undefined && entry?.ok === false).length;
  metrics.sanitySettled = (flat.sanitySettled ?? []).length;
  metrics.keyPointsRevealed = (flat.keyPoints ?? []).filter((kp) => kp?.revealed === true).length;
  metrics.keyPointsTotal = (flat.keyPoints ?? []).length;
  metrics.branchesReached = (flat.branches ?? []).filter((branch) => branch?.reached === true).length;
  metrics.branchesTotal = (flat.branches ?? []).length;
  metrics.userMessages = (flat.log ?? []).filter((entry) => entry?.kind === "user").length;
  metrics.kpMessages = (flat.log ?? []).filter((entry) => entry?.kind === "kp").length;

  if (typeof player.onGameEnd === "function") {
    try {
      await player.onGameEnd({ turns, metrics, final });
    } catch {
      // 玩家收尾失败不影响报告。
    }
  }

  return {
    gameId: harness.gameId,
    scenario: {
      name: flat.scenario?.name ?? flat.title ?? harness.gameId,
      text: flat.scenario?.text ?? "",
      summary: flat.scenario?.summary ?? "",
    },
    playerId: player.id ?? "unknown",
    turns,
    metrics,
    final,
    stopReason,
    transcript: buildTranscript(flat),
  };
}

// ── 剧本前提 ────────────────────────────────────────────────

/**
 * 从剧本摘要中截取“导入信息”作为玩家开场前提（去掉版权/作者等元信息）。
 * @param {object} flat
 * @param {number} [maxChars=600]
 * @returns {string}
 */
export function scenarioPremise(flat, maxChars = 600) {
  const summary = String(flat?.scenario?.summary ?? "");
  const match = /导入信息[:：]?\s*([\s\S]+)/.exec(summary);
  const source = match ? match[1] : summary;
  return source.trim().slice(0, maxChars);
}

// ── 报告辅助 ────────────────────────────────────────────────

const TRANSCRIPT_KINDS = new Set(["user", "kp", "check", "roll"]);

export function buildTranscript(flat) {
  return (flat?.log ?? [])
    .filter((entry) => entry !== null && typeof entry === "object" && TRANSCRIPT_KINDS.has(entry.kind))
    .map((entry) => {
      const who =
        entry.kind === "user" ? "玩家" :
        entry.kind === "kp" ? "KP" :
        entry.kind === "check" ? "系统" : "骰点";
      return `${who}: ${String(entry.text ?? "")}`;
    })
    .join("\n");
}

export function verifyConsistency(flat) {
  const problems = [];
  const core = flat?.core ?? null;
  if (core === null || core === undefined) {
    problems.push("缺少 core 字段");
    return { pass: false, problems };
  }
  if (flat.busy !== false) problems.push(`busy=${flat.busy}`);
  if (flat.currentScene !== core.world?.currentScene) {
    problems.push(`场景不一致：flat=${flat.currentScene ?? ""} core=${core.world?.currentScene ?? ""}`);
  }
  if ((flat.characters?.length ?? 0) !== (core.world?.characters?.length ?? 0)) {
    problems.push(`人物数不一致：flat=${flat.characters?.length ?? 0} core=${core.world?.characters?.length ?? 0}`);
  }
  if ((flat.rollHistory?.length ?? 0) !== (core.world?.rollHistory?.length ?? 0)) {
    problems.push(`骰点历史不一致：flat=${flat.rollHistory?.length ?? 0} core=${core.world?.rollHistory?.length ?? 0}`);
  }
  return { pass: problems.length === 0, problems };
}

export function writeReport(outDir, report, evaluatorResult = null) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(join(outDir, "transcript.txt"), report.transcript ?? "", "utf8");
  writeFileSync(join(outDir, "metrics.json"), JSON.stringify(report.metrics ?? {}, null, 2), "utf8");
  if (evaluatorResult !== null && evaluatorResult !== undefined) {
    writeFileSync(join(outDir, "evaluation.json"), JSON.stringify(evaluatorResult, null, 2), "utf8");
  }
  return outDir;
}

// ── 环境辅助 ────────────────────────────────────────────────

export function resolveScenarioPath(scenarioRef, homeDataDir = null) {
  if (scenarioRef === "fixture" || scenarioRef === "mock") return null;
  if (existsSync(scenarioRef)) return scenarioRef;
  if (homeDataDir !== null && existsSync(join(homeDataDir, "games", `${scenarioRef}.json`))) {
    return join(homeDataDir, "games", `${scenarioRef}.json`);
  }
  return null;
}

export function defaultCocDataDir(home = null) {
  // 与插件一致：DSH_HOME 指向 ~/.dsh 时，数据目录就是 <DSH_HOME>/coc；
  // 未设置 DSH_HOME 时才用 ~/.dsh/coc。
  const base = home ?? process.env.DSH_HOME ?? homedir();
  return process.env.DSH_HOME ? join(process.env.DSH_HOME, "coc") : join(homedir(), ".dsh", "coc");
}

export function llmModels(dataDir) {
  const cfg = loadLlmConfig(dataDir);
  return {
    kp: cfg.llmModel || process.env.COC_LLM_MODEL || "deepseek-chat",
    player: cfg.llmModel || process.env.COC_LLM_MODEL || "deepseek-chat",
    evaluator: cfg.deepParse?.revisionModel || cfg.deepParse?.finalModel || "deepseek-chat",
  };
}

export { callLlmApi };

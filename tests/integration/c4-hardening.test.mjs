/**
 * C-4 后端加固集成测试：不依赖 DSH 服务、不启动浏览器。
 *
 * 覆盖框架大改动后的关键链路：
 * 1. runKpTurn 全链路后 EventLog 因果链 / frontier / PlotGraph / WorldState flags
 * 2. 旧存档迁移（无 core.eventLog / 无 flags）
 * 3. coc_scene / coc_check / coc_sanity_check / coc_combat_resolve 的 WorldState 投影与 flat 一致性
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, mockRandom, randomForDice, run, summarize } from "../runner.js";

import {
  AssetStore,
  GameSession,
  JsonFilePersistence,
} from "../../lib/core/index.js";
import { createSharedToolDefs } from "../../lib/shared/tools/index.js";
import { commitSession, loadSession, rollEvent } from "../../lib/shared/tools/helpers.js";
import { createSharedChatBridge } from "../../lib/shared/chat/index.js";
import { applyStoryPreset } from "../../lib/shared/testing/story-presets.js";

function makeDeps(dataDir) {
  const deps = {
    dataDir,
    defaultGame: "g1",
    persistence: new JsonFilePersistence(dataDir),
    assetStore: new AssetStore(join(dataDir, "assets")),
    session: new GameSession({ id: "g1" }),
    stateKey: (gameId) => join("games", `${gameId}.json`),
    maxRollHistory: 200,
    maxChatRounds: 4,
    maxChatLog: 120,
  };
  deps.toolDefs = createSharedToolDefs(deps);
  return deps;
}

function writeFlat(dataDir, overrides = {}) {
  mkdirSync(join(dataDir, "games"), { recursive: true });
  const flat = {
    id: "g1",
    title: "g1",
    updatedAt: new Date().toISOString(),
    kpMode: "ai",
    rules: null,
    scenario: null,
    characters: [
      {
        name: "伊芙琳",
        occupation: "记者",
        aiControlled: false,
        stats: { STR: 55, DEX: 60, CON: 50, SIZ: 50, INT: 70, POW: 65, HP: 11 },
        skills: { 侦查: 60, 聆听: 40, 意志: 65, "格斗（剑）": 60 },
        hp: 11,
        san: 60,
        mp: 12,
        luck: 55,
        inventory: [],
      },
      {
        name: "深潜者",
        aiControlled: true,
        stats: { STR: 60, DEX: 40, CON: 50, SIZ: 60, HP: 14 },
        skills: { 闪避: 30 },
        hp: 14,
        san: 50,
        mp: 10,
        luck: 50,
        inventory: [],
      },
    ],
    keyPoints: [],
    branches: [],
    currentScene: "",
    currentBranchId: "",
    time: "",
    synopsis: "",
    tasks: [],
    entities: [],
    log: [],
    toolTrace: [],
    rollHistory: [],
    reminders: [],
    events: [],
    busy: false,
    ...overrides,
  };
  writeFileSync(join(dataDir, "games", "g1.json"), JSON.stringify(flat));
}

describe("C-4 后端加固", () => {
  it("runKpTurn 全链路：事件因果链 / frontier / PlotGraph / WorldState flags", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-c4-chain-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      currentScene: "三层书房",
      passedCheckpointIds: [],
      sanitySettled: [],
      keyPoints: [
        { id: "ai-kp-3", title: "进入书房", scene: "三层书房", revealed: false, requires: { scene: "三层书房", entryEvidence: ["进入书房"] } },
        { id: "ai-kp-4", title: "发现日记与手稿", scene: "三层书房", revealed: false, requires: { checkpointGroups: [["chk-3", "chk-4"], ["chk-5", "chk-6"]] } },
      ],
      branches: [],
    });

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "门被撞开，你进入书房，霉味扑面而来。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我进入书房。", "玩家");
    const saved = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));

    // EventLog 因果链：KeyPointRevealed 已记录。
    const eventTypes = (saved.core?.eventLog?.entries ?? []).map((entry) => entry.type);
    expect(eventTypes).toContain("KeyPointRevealed");

    // PlotGraph 有 kp 节点，且已揭示节点 completed。
    const plotNodes = saved.core?.plot?.nodes ?? [];
    expect(plotNodes.some((node) => node.id === "kp:ai-kp-3" && node.status === "completed")).toBeTrue();

    // 已完成关键点后果写入 WorldState flags。
    expect(saved.core?.world?.flags?.["kp:ai-kp-3:revealed"]).toBeTrue();

    // 返回 digest 的 debug.frontier 有可达路线（ai-kp-4 因缺检定点 blocked）。
    expect(result.digest.debug.frontier).toContain("发现日记与手稿");
  });

  it("study 预设下叙述仅提到他处场景不漂移 currentScene", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-c4-scene-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);
    const file = join(dataDir, "games", "g1.json");
    const flat = JSON.parse(readFileSync(file, "utf8"));
    applyStoryPreset(flat, "study-entered");
    writeFileSync(file, JSON.stringify(flat));

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "你检查书桌，想起一层客厅的吊灯与餐厅的壁炉。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const bridge = createSharedChatBridge(deps);
    await bridge.runKpTurn("g1", "我检查书桌", "玩家");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.currentScene).toBe("三层书房");
  });

  it("最终仪式轮失败重试：自动重建门禁，成功后 GateResolved 入账且 EndingResolved 不重复", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-c4-final-retry-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);
    const file = join(dataDir, "games", "g1.json");
    const flat = JSON.parse(readFileSync(file, "utf8"));
    applyStoryPreset(flat, "final-rite");
    writeFileSync(file, JSON.stringify(flat));

    // 第一次 .ra意志：97 失败。
    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "仪式反噬，你咬紧牙关。" }],
      finish: { kind: "complete" },
      usage: {},
    });
    const bridge = createSharedChatBridge(deps);
    let restore = mockRandom(randomForDice([{ sides: 100, value: 97 }]));
    await bridge.runKpTurn("g1", ".ra意志", "玩家");
    restore();
    let saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.pendingChecks.some((gate) => gate.skill === "意志" && gate.source === "final-rite-retry")).toBeTrue();

    // 第二次 .ra意志：17 成功，应消费重建门禁并发布 GateResolved。
    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "墨渊消散，书房归于寂静。" }],
      finish: { kind: "complete" },
      usage: {},
    });
    const bridge2 = createSharedChatBridge(deps);
    restore = mockRandom(randomForDice([{ sides: 100, value: 17 }]));
    await bridge2.runKpTurn("g1", ".ra意志", "玩家");
    restore();
    saved = JSON.parse(readFileSync(file, "utf8"));

    const types = (saved.core?.eventLog?.entries ?? []).map((entry) => entry.type);
    expect(types.filter((type) => type === "GateResolved")).toHaveLength(1);
    expect(types.filter((type) => type === "EndingResolved")).toHaveLength(1);
    expect(saved.endingReached).toBeTrue();
  });

  it("跨场次重置：同名重建后新场次不继承旧 core（eventLog/plot/flags）", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-c4-reset-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);
    const file = join(dataDir, "games", "g1.json");
    const flat = JSON.parse(readFileSync(file, "utf8"));
    applyStoryPreset(flat, "final-rite");
    writeFileSync(file, JSON.stringify(flat));

    // 旧场次：加载并写入 core（事件 / 结局节点 / 世界 flags）。
    const old = loadSession(deps, "g1");
    old.session.plot.syncFromStory({ keyPoints: old.flat.keyPoints ?? [], branches: old.flat.branches ?? [] });
    old.session.plot.applyCompletedConsequences(old.session.world);
    old.session.world.setFlag("old:legacy", true);
    commitSession(deps, "g1", old.session, old.flat, [
      rollEvent("g1", {
        kind: "open",
        player: "伊芙琳",
        label: "旧场次检定",
        skill: "意志",
        expression: "d100",
        rolled: 17,
        target: 65,
        difficulty: "regular",
        tier: "regular",
        passed: true,
      }),
    ]);
    let saved = JSON.parse(readFileSync(file, "utf8"));
    expect((saved.core?.eventLog?.entries ?? []).length).toBeGreaterThan(0);
    expect((saved.core?.plot?.nodes ?? []).some((node) => node.type === "ending")).toBeTrue();
    expect(Object.keys(saved.core?.world?.flags ?? {})).toContain("old:legacy");

    // 模拟删除后同名重建：新 flat 不含 core。
    writeFlat(dataDir);

    const next = loadSession(deps, "g1");
    commitSession(deps, "g1", next.session, next.flat, []);
    saved = JSON.parse(readFileSync(file, "utf8"));

    expect(saved.core?.eventLog?.entries ?? []).toHaveLength(0);
    expect((saved.core?.plot?.nodes ?? []).some((node) => node.type === "ending")).toBeFalse();
    expect(Object.keys(saved.core?.world?.flags ?? {}).length).toBe(0);
  });

  it("最终仪式轮失败后裸 .ra意志 优先消费重试门禁（多候选不卡确认）", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-c4-retry-priority-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);
    const file = join(dataDir, "games", "g1.json");
    const flat = JSON.parse(readFileSync(file, "utf8"));
    applyStoryPreset(flat, "final-rite");
    writeFileSync(file, JSON.stringify(flat));

    // 第一次 .ra意志：78 失败，应自动重建 final-rite-retry 门禁。
    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "仪式反噬，你咬紧牙关。" }],
      finish: { kind: "complete" },
      usage: {},
    });
    const bridge = createSharedChatBridge(deps);
    let restore = mockRandom(randomForDice([{ sides: 100, value: 78 }]));
    await bridge.runKpTurn("g1", ".ra意志", "玩家");
    restore();
    let saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.pendingChecks.some((gate) => gate.skill === "意志" && gate.source === "final-rite-retry")).toBeTrue();

    // 模拟 LLM 又用 coc_check 创建了另一个意志门禁：动作不同，触发多候选。
    saved.pendingChecks.push({
      id: "chk-extra-will",
      skill: "意志",
      difficulty: "regular",
      action: "再念一次咒文",
      hidden: false,
      source: "text-marker",
      at: new Date().toISOString(),
      scene: saved.currentScene ?? "",
      checkpointId: "",
      target: "再念一次咒文",
    });
    writeFileSync(file, JSON.stringify(saved));

    // 第二次裸 .ra意志：17 成功，应直接消费重试门禁并收敛结局。
    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "墨渊消散，书房归于寂静。" }],
      finish: { kind: "complete" },
      usage: {},
    });
    const bridge2 = createSharedChatBridge(deps);
    restore = mockRandom(randomForDice([{ sides: 100, value: 17 }]));
    await bridge2.runKpTurn("g1", ".ra意志", "玩家");
    restore();
    saved = JSON.parse(readFileSync(file, "utf8"));

    const types = (saved.core?.eventLog?.entries ?? []).map((entry) => entry.type);
    expect(saved.endingReached).toBeTrue();
    expect(types.filter((type) => type === "GateResolved")).toHaveLength(1);
    expect(types.filter((type) => type === "EndingResolved")).toHaveLength(1);
    expect(saved.pendingChecks).toHaveLength(0);
  });

  it("旧存档迁移：无 core.eventLog / 无 flags 也能加载并补建 core", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-c4-migrate-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, { currentScene: "一层门厅" });
    // 确保旧档没有 core 字段。
    const raw = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    delete raw.core;
    writeFileSync(join(dataDir, "games", "g1.json"), JSON.stringify(raw));

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "门厅里很安静。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const bridge = createSharedChatBridge(deps);
    await bridge.runKpTurn("g1", "我观察门厅。", "玩家");
    const saved = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));

    expect(saved.core).notToBeUndefined();
    expect(saved.core.eventLog).notToBeUndefined();
    expect(Array.isArray(saved.core.eventLog.entries)).toBeTrue();
    expect(saved.core.world).notToBeUndefined();
    expect(saved.core.world.flags).notToBeUndefined();
    expect(saved.core.plot).notToBeUndefined();
  });

  it("状态/规则工具：WorldState 投影与 flat 一致性 + 事件入账", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-c4-tools-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    const cocScene = deps.toolDefs.get("coc_scene");
    await cocScene.execute({ game: "g1", scene: "三层书房" });
    let flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.currentScene).toBe("三层书房");
    expect(flat.core.world.currentScene).toBe("三层书房");
    expect((flat.core.eventLog.entries ?? []).some((entry) => entry.type === "SceneChanged")).toBeTrue();

    const cocCheck = deps.toolDefs.get("coc_check");
    await cocCheck.execute({ game: "g1", skill: "侦查", difficulty: "regular", action: "检查书桌", hidden: false });
    flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.pendingChecks).toHaveLength(1);
    expect(flat.core.world.pendingChecks).toHaveLength(1);
    expect(flat.core.world.pendingChecks[0].skill).toBe("侦查");
    expect((flat.core.eventLog.entries ?? []).some((entry) => entry.type === "GateCreated")).toBeTrue();

    // SAN 检定：走 SanitySettled 事件投影，flat.sanitySettled 与 core.world.sanitySettled 一致。
    const cocSanity = deps.toolDefs.get("coc_sanity_check");
    await cocSanity.execute({ game: "g1", player: "伊芙琳", sanLoss: "0/1d3", description: "测试", eventId: "hardening-sc" });
    flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.sanitySettled).toHaveLength(1);
    expect(flat.sanitySettled[0].eventId).toBe("hardening-sc");
    expect(flat.core.world.sanitySettled).toHaveLength(1);
    expect((flat.core.eventLog.entries ?? []).some((entry) => entry.type === "SanitySettled")).toBeTrue();

    // 战斗：攻击命中后 flat 与 core.world 的 HP 一致，DamageApplied 事件入账。
    const cocCombat = deps.toolDefs.get("coc_combat_resolve");
    const restore = mockRandom([0.3, 0.99]); // 命中，刀 1d6=6
    await cocCombat.execute({
      game: "g1",
      attacker: "伊芙琳",
      defender: "深潜者",
      weapon: "刀",
      skill: "格斗（剑）",
      defenderDodge: false,
      defenderIsEntity: false,
    });
    restore();
    flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    const defenderFlat = flat.characters.find((character) => character.name === "深潜者");
    const defenderCore = flat.core.world.characters.find((character) => character.name === "深潜者");
    expect(defenderFlat.hp).toBe(8);
    expect(defenderCore.hp).toBe(8);
    expect((flat.core.eventLog.entries ?? []).some((entry) => entry.type === "DamageApplied")).toBeTrue();
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "C-4 后端加固集成测试"));

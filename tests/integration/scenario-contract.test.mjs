/**
 * Scenario Contract 集成测试：
 * - 聊天桥自动草拟契约并落盘
 * - 候选叙述违反线索门禁时被拦截重写（违规文本不落盘）
 * - 入睡触发夜晚事件，firedNightEventIds 持久化
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  AssetStore,
  GameSession,
  JsonFilePersistence,
} from "../../lib/core/index.js";
import { createSharedToolDefs } from "../../lib/shared/tools/index.js";
import { createSharedChatBridge } from "../../lib/shared/chat/index.js";

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
    scenario: { name: "墨渊", text: "三层：克罗斯的书房\n地毯下有墨渊。\n子夜梦游，门外有哭声。", chars: 30 },
    characters: [
      {
        name: "伊芙琳",
        occupation: "记者",
        aiControlled: false,
        stats: { STR: 55, DEX: 60, INT: 60 },
        skills: { 侦查: 60, 聆听: 40 },
        hp: 11,
        san: 60,
        mp: 12,
        luck: 55,
        inventory: [],
      },
    ],
    keyPoints: [],
    branches: [],
    currentScene: "三层：克罗斯的书房",
    currentBranchId: "",
    time: "1925年10月1日 下午3点",
    synopsis: "",
    tasks: [],
    entities: [],
    log: [],
    toolTrace: [],
    rollHistory: [],
    reminders: [],
    events: [],
    busy: false,
    pendingChecks: [],
    skippedChecks: [],
    sanitySettled: [],
    scenarioFacts: [],
    scenarioCheckpoints: [],
    scenarioContract: null,
    firedNightEventIds: [],
    ...overrides,
  };
  writeFileSync(join(dataDir, "games", "g1.json"), JSON.stringify(flat));
}

describe("Scenario Contract 集成", () => {
  it("聊天桥自动草拟契约并拦截线索门禁违规叙述", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-contract-gate-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      scenarioCheckpoints: [
        { id: "chk-1", skill: "侦查", trigger: "侦查发现墨渊", keys: ["地毯", "墨渊"] },
      ],
    });

    let calls = 0;
    deps.streamBlocks = async () => {
      calls += 1;
      return {
        blocks: [
          {
            type: "text",
            text: calls === 1
              ? "你掀起地毯，下面露出一只墨渊的巨眼。"
              : "你掀起地毯，下面的接缝很紧，需要更仔细地摸索。",
          },
        ],
        finish: { kind: "complete" },
        usage: {},
      };
    };

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我检查地毯。", "玩家");

    expect(result.narration).notToContain("墨渊");
    expect(calls > 1).toBe(true);

    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.scenarioContract).notToBeNull();
    expect(flat.scenarioContract.clueGates.length > 0).toBe(true);
    expect(flat.log.map((entry) => entry.kind)).toEqual(["user", "kp"]);
    expect(flat.log[1].text).notToContain("墨渊的巨眼");
  });

  it("入睡触发夜晚事件并持久化 firedNightEventIds", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-contract-night-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      time: "1925年10月1日 晚上11点",
      scenarioContract: {
        nightEvents: [
          { id: "ne-1", title: "子夜梦游", trigger: "onSleep", sleepPolicy: "force" },
        ],
      },
    });

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "你们在客房里沉沉睡去。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const bridge = createSharedChatBridge(deps);
    await bridge.runKpTurn("g1", "我们入睡。", "玩家");

    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.firedNightEventIds).toContain("ne-1");
    expect(flat.log.some((entry) => entry.kind === "check" && entry.text.includes("子夜梦游"))).toBe(true);
  });

  it("draft 契约不拦截叙述；confirmed 契约拦截", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-contract-confirm-"));
    const deps = makeDeps(dataDir);
    const gate = { id: "cg-1", clueWords: ["墨渊"] };
    writeFlat(dataDir, {
      scenarioContract: { status: "draft", clueGates: [gate] },
      scenarioCheckpoints: [],
    });

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "你看见墨渊的巨眼。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const bridge = createSharedChatBridge(deps);
    const draftResult = await bridge.runKpTurn("g1", "我检查地毯。", "玩家");
    expect(draftResult.narration).toContain("墨渊");

    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    flat.scenarioContract.status = "confirmed";
    flat.scenarioContract.reviewed = true;
    writeFileSync(join(dataDir, "games", "g1.json"), JSON.stringify(flat));

    let confirmedCalls = 0;
    deps.streamBlocks = async () => {
      confirmedCalls += 1;
      return {
        blocks: [
          {
            type: "text",
            text: confirmedCalls === 1
              ? "你看见墨渊的巨眼。"
              : "你只看见地毯的接缝。",
          },
        ],
        finish: { kind: "complete" },
        usage: {},
      };
    };
    const confirmedBridge = createSharedChatBridge(deps);
    const confirmedResult = await confirmedBridge.runKpTurn("g1", "我检查地毯。", "玩家");
    expect(confirmedCalls > 1).toBe(true);
    expect(confirmedResult.narration).notToContain("墨渊");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "scenario-contract 集成测试"));

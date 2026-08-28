/**
 * 检定门禁（coc_check + 玩家动作门禁）集成测试：不依赖 DSH 服务。
 *
 * 覆盖：
 * - coc_check 工具登记/去重
 * - 玩家选择带门禁动作时系统阻止推进
 * - 玩家改做其他动作时旧门禁作废
 * - KP 在自由动作中通过 coc_check 登记门禁，系统渲染 .ra 提示
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
    scenario: null,
    characters: [
      {
        name: "伊芙琳",
        occupation: "记者",
        aiControlled: false,
        stats: { STR: 55, DEX: 60 },
        skills: { 侦查: 60, 聆听: 40, 攀爬: 20 },
        hp: 11,
        san: 60,
        mp: 12,
        luck: 55,
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
    pendingChecks: [],
    skippedChecks: [],
    ...overrides,
  };
  writeFileSync(join(dataDir, "games", "g1.json"), JSON.stringify(flat));
}

describe("检定门禁集成", () => {
  it("coc_check 工具登记门禁并去重", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-gate-tool-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    const cocCheck = deps.toolDefs.get("coc_check");
    expect(cocCheck).notToBeNull();
    const args = { game: "g1", skill: "侦查", difficulty: "hard", action: "搜索书房", hidden: false };
    await cocCheck.execute(args);
    await cocCheck.execute(args);

    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.pendingChecks).toHaveLength(1);
    expect(flat.pendingChecks[0].skill).toBe("侦查");
    expect(flat.pendingChecks[0].difficulty).toBe("hard");
    expect(flat.pendingChecks[0].action).toBe("搜索书房");
    expect(flat.pendingChecks[0].source).toBe("kp-tool");
  });

  it("玩家选择带门禁的推荐动作时被阻止，不推进剧情", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-gate-block-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      pendingChecks: [
        { id: "chk-1", skill: "攀爬", difficulty: "regular", action: "翻出窗外，沿窄檐攀向屋顶小门", hidden: false, at: new Date().toISOString(), scene: "", source: "kp-tool" },
      ],
    });

    let llmCalls = 0;
    deps.streamBlocks = async () => {
      llmCalls += 1;
      throw new Error("不应调用 LLM");
    };

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "翻出窗外，沿窄檐攀向屋顶小门", "玩家");

    expect(result.narration).toBe("");
    expect(llmCalls).toBe(0);
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.pendingChecks).toHaveLength(1);
    expect(flat.log[flat.log.length - 1].kind).toBe("check");
    expect(flat.log[flat.log.length - 1].text).toContain("该动作需要先通过检定");
    expect(flat.log[flat.log.length - 1].text).toContain("[团检：攀爬] [.ra攀爬]");
    expect(flat.busy).toBeFalse();
  });

  it("关键词重叠转述也会命中门禁", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-gate-fuzzy-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      pendingChecks: [
        { id: "chk-1", skill: "攀爬", difficulty: "regular", action: "翻出窗外，沿窄檐攀向屋顶小门", hidden: false, at: new Date().toISOString(), scene: "", source: "kp-tool" },
      ],
    });

    let llmCalls = 0;
    deps.streamBlocks = async () => {
      llmCalls += 1;
      throw new Error("不应调用 LLM");
    };

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我翻出窗外爬向屋顶小门", "玩家");

    expect(result.narration).toBe("");
    expect(llmCalls).toBe(0);
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.pendingChecks).toHaveLength(1);
  });

  it("玩家改做其他动作时，旧门禁保留到被消费或明确跳过", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-gate-abandon-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      pendingChecks: [
        { id: "chk-1", skill: "攀爬", difficulty: "regular", action: "翻出窗外，沿窄檐攀向屋顶小门", hidden: false, at: new Date().toISOString(), scene: "", source: "kp-tool" },
      ],
    });

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "你退回屋内，回到二楼的走廊。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我回客厅。", "玩家");

    expect(result.narration).toBe("你退回屋内，回到二楼的走廊。");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.pendingChecks).toHaveLength(1);
    expect(flat.pendingChecks[0].skill).toBe("攀爬");
    expect(flat.skippedChecks).toHaveLength(0);
  });

  it("自由动作需要检定时，KP 通过 coc_check 登记，系统渲染 .ra 提示", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-gate-free-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    let calls = 0;
    deps.streamBlocks = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [
            {
              type: "tool-call",
              id: "call-1",
              name: "coc_check",
              arguments: JSON.stringify({ game: "g1", skill: "侦查", difficulty: "regular", action: "搜索书房", hidden: false }),
            },
          ],
          finish: { kind: "complete" },
          usage: {},
        };
      }
      return {
        blocks: [{ type: "text", text: "你走到书桌前，开始仔细翻找。" }],
        finish: { kind: "complete" },
        usage: {},
      };
    };

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我搜索书房。", "玩家");

    expect(calls).toBe(2);
    expect(result.narration).toBe("你走到书桌前，开始仔细翻找。");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.pendingChecks).toHaveLength(1);
    expect(flat.pendingChecks[0].skill).toBe("侦查");
    expect(flat.pendingChecks[0].action).toBe("搜索书房");
    expect(flat.pendingChecks[0].source).toBe("kp-tool");
    expect(flat.log.map((entry) => entry.kind)).toEqual(["user", "kp", "check"]);
    expect(flat.log[2].text).toBe("[团检：侦查] [.ra侦查]");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "check-gates 集成测试"));

/**
 * Shared 聊天桥集成测试：不依赖 DSH 服务。
 *
 * 明骰新流程：KP 不调用 coc_roll；玩家发送 .ra 指令 → 系统掷骰并写结果行 → KP 续写。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, mockRandom, randomForDice } from "../runner.js";
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

describe("Shared 聊天桥", () => {
  it(".ra 指令：玩家明骰 → 系统结果行 → KP 续写", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-chat-ra-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "你在书架后发现了一道暗门。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const restore = mockRandom(randomForDice([{ sides: 100, value: 36 }]));
    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", ".ra侦查", "玩家");
    restore();

    expect(result.narration).toBe("你在书架后发现了一道暗门。");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.log.map((entry) => entry.kind)).toEqual(["user", "roll", "kp"]);
    expect(flat.log[0].text).toBe(".ra侦查");
    expect(flat.log[1].text).toContain("伊芙琳进行侦查检定：");
    expect(flat.log[1].text).toContain("D100=36/60");
    expect(flat.log[1].text).toContain("常规成功");
    expect(flat.rollHistory).toHaveLength(1);
    expect(flat.rollHistory[0].skill).toBe("侦查");
    expect(flat.busy).toBeFalse();
  });

  it("KP 叙述给出团检标记时，写入 kp 与 check 日志并移除标记", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-chat-check-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "你似乎听见门后有极轻的响动。【团检：聆听】" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我侧耳倾听。", "玩家");

    expect(result.pendingChecks).toHaveLength(1);
    expect(result.pendingChecks[0].skill).toBe("聆听");
    expect(result.pendingChecks[0].action).toBe("你似乎听见门后有极轻的响动");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.log.map((entry) => entry.kind)).toEqual(["user", "kp", "check"]);
    expect(flat.log[1].text).notToContain("团检");
    expect(flat.log[2].text).toBe("[团检：聆听] [.ra聆听]");
    expect(flat.pendingChecks[0].action).toBe("你似乎听见门后有极轻的响动");
    expect(flat.pendingChecks[0].source).toBe("text-marker");
    expect(flat.busy).toBeFalse();
  });

  it(".ra 带难度后缀时按该难度结算", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-chat-ra-hard-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "你找到了那条几乎不可见的楼梯。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const restore = mockRandom(randomForDice([{ sides: 100, value: 24 }]));
    const bridge = createSharedChatBridge(deps);
    await bridge.runKpTurn("g1", ".ra侦查困难", "玩家");
    restore();

    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.log[1].text).toContain("伊芙琳进行侦查检定（困难）：");
    expect(flat.log[1].text).toContain("D100=24/60");
    expect(flat.log[1].text).toContain("困难成功 ✓");
    expect(flat.rollHistory[0].difficulty).toBe("hard");
  });

  it("空 .ra 给出系统提示而不是报错", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-chat-ra-empty-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", ".ra", "玩家");

    expect(result.narration).toBe("");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.log.map((entry) => entry.kind)).toEqual(["user", "check"]);
    expect(flat.log[1].text).toContain("请发送 .ra技能名");
    expect(flat.busy).toBeFalse();
  });

  it(".ra 匹配待处理团检时，把动作选项绑定进后续叙述", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-chat-ra-hint-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    let calls = 0;
    let capturedMessages = null;
    deps.streamBlocks = async (options) => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "text", text: "屋顶边缘很滑。\n- 翻出窗外，沿窄檐攀向屋顶小门（需攀爬/敏捷）\n- 退回屋内" }],
          finish: { kind: "complete" },
          usage: {},
        };
      }
      capturedMessages = options.messages;
      return {
        blocks: [{ type: "text", text: "你翻出窗外，踩上窄檐，向屋顶小门挪去。" }],
        finish: { kind: "complete" },
        usage: {},
      };
    };

    const bridge = createSharedChatBridge(deps);
    await bridge.runKpTurn("g1", "我走到屋顶边缘。", "玩家");
    const mid = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(mid.pendingChecks).toHaveLength(1);
    expect(mid.pendingChecks[0].action).toBe("翻出窗外，沿窄檐攀向屋顶小门");

    const restore = mockRandom(randomForDice([{ sides: 100, value: 30 }]));
    await bridge.runKpTurn("g1", ".ra攀爬", "玩家");
    restore();

    expect(calls).toBe(2);
    const lastSystem = [...capturedMessages].reverse().find((m) => m.role === "user" && m.source && m.source.kind === "system");
    expect(lastSystem.content[0].text).toContain("玩家想对「翻出窗外，沿窄檐攀向屋顶小门」进行检定");
  });

  it(".ra 对应多个动作选项时，先确认动作再掷骰", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-chat-ra-multi-hint-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    let calls = 0;
    let capturedMessages = null;
    deps.streamBlocks = async (options) => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "text", text: "屋顶边缘很滑。\n- 翻出窗外，沿窄檐攀向屋顶小门（需攀爬）\n- 顺排水管爬上屋顶（需攀爬）\n- 退回屋内" }],
          finish: { kind: "complete" },
          usage: {},
        };
      }
      capturedMessages = options.messages;
      return {
        blocks: [{ type: "text", text: "你翻出窗外，踩上窄檐，向屋顶小门挪去。" }],
        finish: { kind: "complete" },
        usage: {},
      };
    };

    const bridge = createSharedChatBridge(deps);
    await bridge.runKpTurn("g1", "我走到屋顶边缘。", "玩家");
    const mid = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(mid.pendingChecks).toHaveLength(2);
    expect(mid.pendingChecks.map((gate) => gate.action)).toEqual(["翻出窗外，沿窄檐攀向屋顶小门", "顺排水管爬上屋顶"]);

    // 多候选：只确认动作，不掷骰。
    await bridge.runKpTurn("g1", ".ra攀爬", "玩家");
    const mid2 = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(mid2.pendingChoice.skill).toBe("攀爬");
    expect(mid2.pendingChoice.candidates).toEqual(["翻出窗外，沿窄檐攀向屋顶小门", "顺排水管爬上屋顶"]);
    expect(mid2.log.filter((entry) => entry.kind === "roll")).toHaveLength(0);
    expect(mid2.log[mid2.log.length - 1].text).toContain("请确认要对哪个动作进行 攀爬 检定");

    // 玩家回复编号 1：此时才掷骰并绑定第一个动作。
    const restore = mockRandom(randomForDice([{ sides: 100, value: 30 }]));
    await bridge.runKpTurn("g1", "1", "玩家");
    restore();

    expect(calls).toBe(2);
    const lastSystem = [...capturedMessages].reverse().find((m) => m.role === "user" && m.source && m.source.kind === "system");
    expect(lastSystem.content[0].text).toContain("玩家想对「翻出窗外，沿窄檐攀向屋顶小门」进行检定");
  });

  it("玩家未发送 .ra 而进行其他行动时，团检标记为已跳过", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-chat-skip-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    let calls = 0;
    deps.streamBlocks = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "text", text: "酒柜后似乎有一道暗门。[团检：开锁]" }],
          finish: { kind: "complete" },
          usage: {},
        };
      }
      return {
        blocks: [{ type: "text", text: "你转身离开酒柜，回到客厅。" }],
        finish: { kind: "complete" },
        usage: {},
      };
    };

    const bridge = createSharedChatBridge(deps);
    await bridge.runKpTurn("g1", "我检查酒柜。", "玩家");
    const mid = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(mid.pendingChecks).toHaveLength(1);

    await bridge.runKpTurn("g1", "先不开，我回客厅。", "玩家");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.pendingChecks).toHaveLength(1);
    expect(flat.pendingChecks[0].skill).toBe("开锁");
    expect(flat.skippedChecks ?? []).toHaveLength(0);
    expect(flat.busy).toBeFalse();
  });

  it("叙述里出现判定词且未调用检定工具时，纠正后重写", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-chat-guard-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    let calls = 0;
    deps.streamBlocks = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "text", text: "你的目光如镜头般聚焦，困难成功，宅邸的细节落入你的眼中。" }],
          finish: { kind: "complete" },
          usage: {},
        };
      }
      return {
        blocks: [{ type: "text", text: "你仔细观察，门框上似乎有新鲜的刮痕。【团检：侦查】" }],
        finish: { kind: "complete" },
        usage: {},
      };
    };

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我观察外观。", "玩家");

    expect(calls).toBe(2);
    expect(result.narration).notToContain("困难成功");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.log.map((entry) => entry.kind)).toEqual(["user", "kp", "check"]);
    expect(flat.log[1].text).notToContain("困难成功");
    expect(flat.log[2].text).toContain(".ra侦查");
    expect(flat.busy).toBeFalse();
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "shared-chat 集成测试"));

/**
 * 端到端审计修复回归测试：
 * - SAN 幂等（eventId + 暗骰可见性）
 * - .ra 无目标值拒绝掷骰
 * - 场景从叙述重推断（不再仅 currentScene==="" 时兜底）
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, mockRandom, run, summarize } from "../runner.js";
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
    sanitySettled: [],
    scenarioFacts: [],
    scenarioCheckpoints: [],
    ...overrides,
  };
  writeFileSync(join(dataDir, "games", "g1.json"), JSON.stringify(flat));
}

describe("审计修复回归", () => {
  it("coc_sanity_check 同一 eventId 只结算一次，且玩家视图看不到 SAN 暗骰", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-san-idem-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    const restore = mockRandom([0.5]); // d100 = 51 ≤ 60 → SAN 检定成功，损失 0
    try {
      const sanity = deps.toolDefs.get("coc_sanity_check");
      expect(sanity).notToBeNull();

      const first = await sanity.execute({
        game: "g1",
        player: "伊芙琳",
        sanLoss: "0/1d3",
        description: "首次目睹墨渊",
        eventId: "墨渊首次目击",
      });
      const second = await sanity.execute({
        game: "g1",
        player: "伊芙琳",
        sanLoss: "0/1d3",
        description: "首次目睹墨渊",
        eventId: "墨渊首次目击",
      });

      expect(second.result).toContain("已结算");
      expect(second.sanLost).toBe(0);

      const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
      expect(flat.sanitySettled).toHaveLength(1);
      expect(flat.rollHistory).toHaveLength(1);
      expect(flat.rollHistory[0].kind).toBe("secret");
      expect(flat.characters[0].san).toBe(60);
    } finally {
      restore();
    }
  });

  it(".ra 技能无目标值时拒绝掷骰并提示补充技能值", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-ra-notarget-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir);

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", ".ra御剑术", "玩家");

    expect(result.narration).toBe("");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.rollHistory).toHaveLength(0);
    expect(flat.log[flat.log.length - 1].kind).toBe("check");
    expect(flat.log[flat.log.length - 1].text).toContain("没有找到「御剑术」的技能值");
  });

  it("叙述进入新场景时，currentScene 从旧场景重推断更新", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-scene-reinfer-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      currentScene: "镇上街道",
      scenarioFacts: [
        {
          heading: "三层：克罗斯的书房",
          floor: "三层",
          keywords: ["三层", "书房", "墨渊", "屋顶"],
          original: "三层：克罗斯的书房\n书房里有书桌与墨渊。",
          facts: ["书房在三层。"],
        },
        {
          heading: "一层：门厅",
          floor: "一层",
          keywords: ["一层", "门厅", "客厅"],
          original: "一层：门厅",
          facts: ["门厅位于一层。"],
        },
      ],
    });

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "你推开三层书房的门，墨渊正在屋顶上缓缓旋转。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我去书房。", "玩家");

    expect(result.narration).toBe("你推开三层书房的门，墨渊正在屋顶上缓缓旋转。");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.currentScene).toBe("三层：克罗斯的书房");
  });

  it("叙述在检定前泄露受保护线索时，系统要求重写且泄露文本不落盘", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-guard-leak-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      currentScene: "三层：克罗斯的书房",
      scenarioFacts: [
        {
          heading: "三层：克罗斯的书房",
          floor: "三层",
          keywords: ["三层", "书房", "墨渊", "日记"],
          original: "三层：克罗斯的书房\n书桌抽屉里有日记与手稿。",
          facts: ["书房在三层。"],
        },
      ],
      scenarioCheckpoints: [
        {
          id: "chk-1",
          skill: "侦查",
          difficulty: "regular",
          scene: "三层：克罗斯的书房",
          floor: "三层",
          trigger: "侦察或者图书馆普通成功：发现书桌抽屉里有一本日记。",
          keys: ["书房", "日记"],
        },
      ],
    });

    let calls = 0;
    deps.streamBlocks = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "text", text: "你打开书桌抽屉，里面有一本日记。" }],
          finish: { kind: "complete" },
          usage: {},
        };
      }
      return {
        blocks: [{ type: "text", text: "你走到书桌前，抽屉紧闭，空气里有旧纸的气味。" }],
        finish: { kind: "complete" },
        usage: {},
      };
    };

    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我翻找书桌抽屉。", "玩家");

    expect(calls).toBe(2);
    expect(result.narration).toBe("你走到书桌前，抽屉紧闭，空气里有旧纸的气味。");
    expect(result.narration).notToContain("日记");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.log[flat.log.length - 1].text).toBe("你走到书桌前，抽屉紧闭，空气里有旧纸的气味。");
    expect(flat.log[flat.log.length - 1].text).notToContain("日记");
  });

  it("SAN 事件映射到剧本检定点规范 ID：不同 eventId/描述 也只结算一次", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-san-canonical-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      scenarioCheckpoints: [
        { id: "chk-1", skill: "理智", difficulty: "regular", scene: "书房", floor: "三层", keys: ["书房", "墨渊"], trigger: "san check" },
        { id: "chk-2", skill: "理智", difficulty: "regular", scene: "书房", floor: "三层", keys: ["墨渊", "漩涡", "巨眼"], trigger: "san check 巨眼" },
        { id: "chk-3", skill: "侦查", difficulty: "extreme", scene: "书房", floor: "三层", keys: ["地毯", "墨渊"], trigger: "侦查极难" },
      ],
    });

    const restore = mockRandom([0.5]); // d100 = 51 ≤ 60 → SAN 成功，损失 0
    try {
      const sanity = deps.toolDefs.get("coc_sanity_check");
      const first = await sanity.execute({
        game: "g1", player: "伊芙琳", sanLoss: "0/1d3",
        description: "墨渊巨眼首次目击", eventId: "墨渊巨眼首次目击",
      });
      const second = await sanity.execute({
        game: "g1", player: "伊芙琳", sanLoss: "0/1d3",
        description: "仪式直视夏拉卡拉布巨眼", eventId: "仪式直视夏拉卡拉布巨眼",
      });

      expect(second.result).toContain("已结算");
      const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
      expect(flat.sanitySettled).toHaveLength(1);
      expect(flat.sanitySettled[0].eventId).toBe("scenario:chk-2");
      expect(flat.rollHistory).toHaveLength(1);
      expect(flat.characters[0].san).toBe(60);
    } finally {
      restore();
    }
  });

  it("门禁前泄露线索被守卫重写时，回滚本轮 SAN 副作用", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-sideeffect-rollback-"));
    const deps = makeDeps(dataDir);
    writeFlat(dataDir, {
      currentScene: "三层：克罗斯的书房",
      scenarioFacts: [
        {
          heading: "三层：克罗斯的书房",
          floor: "三层",
          keywords: ["三层", "书房", "地毯", "墨渊"],
          original: "三层：克罗斯的书房\n地毯下有墨渊。",
          facts: ["书房在三层。"],
        },
      ],
      scenarioCheckpoints: [
        {
          id: "chk-1",
          skill: "侦查",
          difficulty: "extreme",
          scene: "三层：克罗斯的书房",
          floor: "三层",
          trigger: "侦查极难成功或仔细摸索地毯：看到墨渊。",
          keys: ["地毯", "墨渊"],
        },
      ],
    });

    let calls = 0;
    const restore = mockRandom([0.5]); // coc_sanity_check d100=51 → 成功，损失 0
    try {
      deps.streamBlocks = async () => {
        calls += 1;
        if (calls === 1) {
          return {
            blocks: [
              {
                type: "tool-call",
                id: "call-1",
                name: "coc_sanity_check",
                arguments: JSON.stringify({
                  game: "g1", player: "伊芙琳", sanLoss: "1/1d3",
                  description: "直视墨渊", eventId: "直视墨渊",
                }),
              },
            ],
            finish: { kind: "complete" },
            usage: {},
          };
        }
        if (calls === 2) {
          return {
            blocks: [{ type: "text", text: "你掀开地毯，直视下方旋转的墨渊。" }],
            finish: { kind: "complete" },
            usage: {},
          };
        }
        return {
          blocks: [{ type: "text", text: "你掀开地毯，下面只有陈旧的木纹与灰尘。" }],
          finish: { kind: "complete" },
          usage: {},
        };
      };

      const bridge = createSharedChatBridge(deps);
      const result = await bridge.runKpTurn("g1", "我掀开地毯直视墨渊。", "玩家");

      expect(calls).toBe(3);
      expect(result.narration).toBe("你掀开地毯，下面只有陈旧的木纹与灰尘。");
      const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
      expect(flat.characters[0].san).toBe(60);
      expect(flat.sanitySettled).toHaveLength(0);
      expect(flat.rollHistory).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "audit-fixes 集成测试"));

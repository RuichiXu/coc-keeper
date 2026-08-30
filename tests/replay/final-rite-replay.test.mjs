/**
 * Replay 测试：从“最终仪式轮”标准剧情点开始，回放 v8 最后两轮的
 * 关键输入（.ra意志 → 成功），断言程序层收敛到墨渊消散结局。
 *
 * 这里不启动浏览器、不依赖真实 LLM：flat 用 story-presets 的 final-rite
 * 预设构造，LLM 用 stub 回放。后续 E2E 失败现场可用 exportFixture 导出后
 * 按同样方式固化成 replay 测试。
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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

describe("Replay：最终仪式轮", () => {
  it(".ra意志 成功后程序确定性收敛到墨渊消散结局", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-replay-final-"));
    mkdirSync(join(dataDir, "games"), { recursive: true });
    const deps = makeDeps(dataDir);

    // 用与调试面板 gotoPreset 相同的预设构造现场。
    const base = {
      id: "g1",
      title: "墨渊复测",
      updatedAt: new Date().toISOString(),
      kpMode: "ai",
      rules: null,
      scenario: null,
      characters: [
        {
          name: "伊芙琳",
          occupation: "记者",
          aiControlled: false,
          skills: { 侦查: 60, 图书馆使用: 60, 智力: 70, 意志: 65 },
          san: 64,
          hp: 11,
          mp: 13,
          luck: 55,
          inventory: [],
        },
      ],
      keyPoints: [],
      branches: [],
      entities: [],
      log: [],
      toolTrace: [],
      rollHistory: [],
      reminders: [],
      tasks: [],
      events: [],
      busy: false,
    };
    const flat = applyStoryPreset(base, "final-rite");
    writeFileSync(join(dataDir, "games", "g1.json"), JSON.stringify(flat));

    deps.streamBlocks = async () => ({
      blocks: [{ type: "text", text: "咒文最后一个音节落下，书房安静下来，你站在原地确认一切已经结束。" }],
      finish: { kind: "complete" },
      usage: {},
    });

    const restore = mockRandom(randomForDice([{ sides: 100, value: 45 }]));
    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", ".ra意志", "玩家");
    restore();

    const saved = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(result.busy).toBeFalse();
    expect(saved.endingReached).toBeTrue();
    expect(saved.currentScene).toBe("三层书房·仪式终结");
    expect(saved.pendingChecks).toHaveLength(0);
    expect(saved.keyPoints.find((kp) => kp.id === "ai-kp-7").revealed).toBeTrue();
    expect(saved.keyPoints.find((kp) => kp.id === "ai-kp-8").revealed).toBeTrue();

    // C-4：EndingResolved 由 PlotGraph 结局节点驱动，并进入 EventLog 因果链。
    const eventTypes = (saved.core?.eventLog?.entries ?? []).map((entry) => entry.type);
    expect(eventTypes).toContain("RollPerformed");
    expect(eventTypes).toContain("GateResolved");
    expect(eventTypes).toContain("EndingResolved");
    const endingNode = (saved.core?.plot?.nodes ?? []).find((node) => node.type === "ending" && node.status === "completed");
    expect(endingNode).notToBeUndefined();
    expect(endingNode.title).toBe("墨渊消散的结局");

    // C-3：已完成关键点的后果写入 WorldState flags。
    const flags = saved.core?.world?.flags ?? {};
    expect(flags["kp:ai-kp-7:revealed"]).toBeTrue();
    expect(flags["kp:ai-kp-8:revealed"]).toBeTrue();
  });
});

import { run, summarize } from "../runner.js";
const runResult = await run({ verbose: true });
process.exit(summarize(runResult, "replay 回放测试"));

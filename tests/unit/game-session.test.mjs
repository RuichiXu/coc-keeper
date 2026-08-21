/**
 * GameSession 容器单元测试
 */
import { describe, it, expect } from "../runner.js";
import { GameSession } from "../../lib/core/session/game-session.js";
import { SceneMode } from "../../lib/core/interfaces.js";

describe("GameSession 容器", () => {
  it("初始化组装 EventBus / WorldState / PlotGraph / ClueGraph", () => {
    const session = new GameSession({ id: "test" });

    expect(session.id).toBe("test");
    expect(session.eventBus).notToBeUndefined();
    expect(session.world).notToBeUndefined();
    expect(session.plot).notToBeUndefined();
    expect(session.clues).notToBeUndefined();
    expect(session.sceneMode).toBe(SceneMode.FreeRoleplay);
  });

  it("syncFromFlat 将旧 flat 状态镜像到 WorldState", () => {
    const session = new GameSession({ id: "test" });
    session.syncFromFlat({
      id: "test",
      title: "暗黑边缘",
      kpMode: "ai",
      currentScene: "废弃宅邸",
      time: "1925年10月1日 下午3点",
      synopsis: "调查员进入废弃宅邸。",
      characters: [{ name: "张三", hp: 11, san: 50 }],
      entities: [{ id: "ent-1", type: "npc", name: "老管家", state: "", scene: "门厅" }],
      tasks: [{ id: "task-1", title: "调查暗格", status: "open" }],
      rollHistory: [{ rolled: 45, tier: "regular" }],
      events: [],
    });

    expect(session.world.title).toBe("暗黑边缘");
    expect(session.world.currentScene).toBe("废弃宅邸");
    expect(session.world.time).toBe("1925年10月1日 下午3点");
    expect(session.world.characters).toHaveLength(1);
    expect(session.world.entities).toHaveLength(1);
    expect(session.world.tasks).toHaveLength(1);
    expect(session.world.rollHistory).toHaveLength(1);
  });

  it("applyEvent 同时更新 WorldState 并发布到 EventBus", () => {
    const session = new GameSession({ id: "test" });
    session.syncFromFlat({
      id: "test",
      characters: [{ name: "张三", hp: 11, san: 60, stats: { HP: 11, SAN: 60 } }],
    });

    let received = null;
    session.eventBus.subscribe("SanityLost", (e) => { received = e; });

    session.applyEvent({
      type: "SanityLost",
      at: new Date().toISOString(),
      gameId: "test",
      character: "张三",
      amount: 3,
      sanBefore: 60,
      sanAfter: 57,
      cause: "测试",
    });

    expect(received).notToBeNull();
    expect(received.amount).toBe(3);
    expect(session.world.findCharacter("张三").san).toBe(57);
  });

  it("recordTrace 记录轨迹并保留最近条目", () => {
    const session = new GameSession({ id: "test", maxTrace: 3 });
    for (let i = 1; i <= 5; i += 1) {
      session.recordTrace({ kind: "tool", tool: `tool-${i}` });
    }
    expect(session.trace).toHaveLength(3);
    expect(session.trace[0].tool).toBe("tool-3");
    expect(session.trace[2].tool).toBe("tool-5");
  });

  it("digest 汇总 world/plot/clues 摘要", () => {
    const session = new GameSession({ id: "test" });
    session.syncFromFlat({
      id: "test",
      currentScene: "书房",
      characters: [{ name: "张三", hp: 11, san: 50, mp: 10, luck: 50, inventory: [] }],
    });
    session.plot.addNode({ id: "pn-1", title: "调查书房", status: "active" });

    const digest = session.digest();
    expect(digest.sceneMode).toBe(SceneMode.FreeRoleplay);
    expect(digest.world.currentScene).toBe("书房");
    expect(digest.plot.activeCount).toBe(1);
    expect(digest.clues.totalClues).toBe(0);
  });

  it("toJSON / fromJSON 往返保持状态", () => {
    const session = new GameSession({ id: "test" });
    session.syncFromFlat({
      id: "test",
      title: "暗黑边缘",
      characters: [{ name: "张三", hp: 11, san: 50 }],
    });
    session.recordTrace({ kind: "tool", tool: "coc_roll" });

    const restored = GameSession.fromJSON(session.toJSON());
    expect(restored.id).toBe("test");
    expect(restored.world.title).toBe("暗黑边缘");
    expect(restored.world.characters).toHaveLength(1);
    expect(restored.trace).toHaveLength(1);
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "game-session 单元测试"));

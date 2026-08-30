/**
 * WorldState 剧情执行账本字段（C-1）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import { GameSession, WorldState } from "../../lib/core/index.js";

describe("WorldState 剧情执行账本", () => {
  it("hydratePlotFields 从旧 flat 吸收剧情字段", () => {
    const world = new WorldState({ id: "g1" });
    world.hydratePlotFields({
      currentBranchId: "ai-br-1",
      pendingChecks: [{ id: "chk-a", skill: "侦查", action: "检查书桌" }],
      skippedChecks: [],
      resolvedChecks: ["侦查::检查书桌"],
      passedCheckpointIds: ["chk-3"],
      sanitySettled: [{ eventId: "scenario:chk-9", player: "伊芙琳" }],
      keyPoints: [{ id: "ai-kp-3", title: "进入书房", revealed: true }],
      branches: [{ id: "ai-br-1", title: "如何进入书房", reached: true, chosen: "撞门" }],
      spellShown: true,
      endingReached: false,
      endedAt: null,
      firedNightEventIds: ["ne-1"],
    });
    expect(world.pendingChecks).toHaveLength(1);
    expect(world.passedCheckpointIds).toContain("chk-3");
    expect(world.keyPoints[0].revealed).toBeTrue();
    expect(world.branches[0].chosen).toBe("撞门");
    expect(world.spellShown).toBeTrue();
    expect(world.firedNightEventIds).toContain("ne-1");
  });

  it("applyEvent 应用 C-1 新事件目录", () => {
    const world = new WorldState({ id: "g1" });
    world.hydratePlotFields({
      keyPoints: [{ id: "ai-kp-3", title: "进入书房", revealed: false }],
      branches: [{ id: "ai-br-1", title: "如何进入书房", reached: false, chosen: null }],
    });
    world.applyEvent({ type: "GateCreated", gateId: "chk-a", skill: "侦查", action: "检查书桌", at: "2026-08-28T10:00:00.000Z" });
    world.applyEvent({ type: "CheckpointPassed", checkpointId: "chk-3", at: "2026-08-28T10:00:01.000Z" });
    world.applyEvent({ type: "SanitySettled", player: "伊芙琳", eventId: "scenario:chk-9", at: "2026-08-28T10:00:02.000Z" });
    world.applyEvent({ type: "KeyPointRevealed", keyPointId: "ai-kp-3", at: "2026-08-28T10:00:03.000Z" });
    world.applyEvent({ type: "BranchLanded", branchId: "ai-br-1", chosen: "撞门", at: "2026-08-28T10:00:04.000Z" });
    world.applyEvent({ type: "SpellShown", at: "2026-08-28T10:00:05.000Z" });
    world.applyEvent({ type: "NightEventFired", eventId: "ne-1", at: "2026-08-28T10:00:06.000Z" });
    world.applyEvent({ type: "EndingResolved", branchId: "ai-br-3", chosen: "逆序", currentScene: "三层书房·仪式终结", at: "2026-08-28T10:00:07.000Z" });

    expect(world.pendingChecks).toHaveLength(1);
    expect(world.passedCheckpointIds).toContain("chk-3");
    expect(world.sanitySettled[0].eventId).toBe("scenario:chk-9");
    expect(world.keyPoints).toHaveLength(1);
    expect(world.keyPoints[0].revealed).toBeTrue();
    expect(world.branches[0].reached).toBeTrue();
    expect(world.spellShown).toBeTrue();
    expect(world.firedNightEventIds).toContain("ne-1");
    expect(world.endingReached).toBeTrue();
    expect(world.currentScene).toBe("三层书房·仪式终结");
  });

  it("GateResolved 移除门禁并记录 resolvedKey", () => {
    const world = new WorldState({ id: "g1" });
    world.applyEvent({ type: "GateCreated", gateId: "chk-a", skill: "侦查", action: "检查书桌", at: "2026-08-28T10:00:00.000Z" });
    world.applyEvent({ type: "GateResolved", gateId: "chk-a", skill: "侦查", resolvedKey: "侦查::检查书桌", at: "2026-08-28T10:00:01.000Z" });
    expect(world.pendingChecks).toHaveLength(0);
    expect(world.resolvedChecks).toContain("侦查::检查书桌");
  });

  it("toJSON / hydrate 往返包含剧情字段", () => {
    const world = new WorldState({ id: "g1" });
    world.hydratePlotFields({ keyPoints: [{ id: "kp-1", title: "委托到来", revealed: true }], passedCheckpointIds: ["chk-1"] });
    const restored = WorldState.fromJSON(world.toJSON());
    expect(restored.keyPoints[0].title).toBe("委托到来");
    expect(restored.passedCheckpointIds).toContain("chk-1");
  });
});

describe("GameSession 事件流水账", () => {
  it("applyEvent 盖章并写入 EventLog，toJSON/fromJSON 往返", () => {
    const session = new GameSession({ id: "g1" });
    const stamped = session.applyEvent({ type: "CheckpointPassed", checkpointId: "chk-13" });
    expect(stamped.id).toBe("evt-1");
    expect(session.eventLog.query({ type: "CheckpointPassed" })).toHaveLength(1);
    expect(session.world.passedCheckpointIds).toContain("chk-13");

    const restored = GameSession.fromJSON(session.toJSON());
    expect(restored.eventLog.query({ type: "CheckpointPassed" })).toHaveLength(1);
    expect(restored.eventLog.query({ type: "CheckpointPassed" })[0].id).toBe("evt-1");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "world-plot-fields 单元测试"));

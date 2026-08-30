/**
 * 事件目录与 EventLog 单元测试（C-1）
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  EventLog,
  GAME_EVENT_TYPES,
  GAME_EVENT_TYPE_SET,
  createGameEvent,
  validateGameEvent,
} from "../../lib/core/index.js";

describe("事件目录", () => {
  it("包含 C-1 规划的全部事件类型", () => {
    for (const type of [
      "RollPerformed",
      "SanitySettled",
      "CheckpointPassed",
      "GateCreated",
      "GateResolved",
      "GateFailed",
      "GateExpired",
      "SceneChanged",
      "TimeAdvanced",
      "KeyPointRevealed",
      "BranchLanded",
      "ItemAcquired",
      "SpellShown",
      "NightEventFired",
      "EndingResolved",
    ]) {
      expect(GAME_EVENT_TYPE_SET.has(type)).toBeTrue();
    }
    expect(GAME_EVENT_TYPES.length).toBeGreaterThan(14);
  });

  it("validateGameEvent 校验未知类型与必填字段", () => {
    expect(validateGameEvent({})).toHaveLength(1);
    expect(validateGameEvent({ type: "NoSuchEvent" })).toHaveLength(1);
    expect(validateGameEvent({ type: "CheckpointPassed" })).toContain("CheckpointPassed 缺少必填字段 checkpointId");
    expect(validateGameEvent({ type: "CheckpointPassed", checkpointId: "chk-1" })).toHaveLength(0);
  });

  it("createGameEvent 构造合法事件并在非法时抛错", () => {
    const event = createGameEvent("BranchLanded", { branchId: "ai-br-3", chosen: "逆序念诵（送神）" });
    expect(event.type).toBe("BranchLanded");
    expect(() => createGameEvent("BranchLanded", { branchId: "ai-br-3" })).toThrow("缺少必填字段 chosen");
  });
});

describe("EventLog 流水账", () => {
  it("append 自动分配 id/seq/at 并支持按类型查询", () => {
    const log = new EventLog();
    const a = log.append(createGameEvent("GateCreated", { skill: "侦查", gateId: "chk-1" }));
    const b = log.append(createGameEvent("GateResolved", { skill: "侦查", gateId: "chk-1" }));
    expect(a.id).toBe("evt-1");
    expect(a.seq).toBe(1);
    expect(a.at).notToBeUndefined();
    expect(b.seq).toBe(2);
    expect(log.query({ type: "GateCreated" })).toHaveLength(1);
    expect(log.query({ type: "GateCreated" })[0].id).toBe("evt-1");
    expect(log.lastSeq()).toBe(2);
  });

  it("按 correlationId 串联因果链", () => {
    const log = new EventLog();
    log.append(createGameEvent("CheckpointPassed", { checkpointId: "chk-9" }, { at: "2026-08-28T10:00:00.000Z" }));
    log.append({ type: "CheckpointPassed", checkpointId: "chk-9", correlationId: "evt-1" });
    log.append({ type: "KeyPointRevealed", keyPointId: "ai-kp-5", correlationId: "evt-1" });
    expect(log.query({ correlationId: "evt-1" })).toHaveLength(2);
    expect(log.query({ correlationId: "evt-1", type: "KeyPointRevealed" })).toHaveLength(1);
  });

  it("toJSON / fromJSON 往返", () => {
    const log = new EventLog(3);
    log.append(createGameEvent("SpellShown", {}));
    log.append(createGameEvent("NightEventFired", { eventId: "ne-1" }));
    const restored = EventLog.fromJSON(log.toJSON());
    expect(restored.entries()).toHaveLength(2);
    expect(restored.query({ type: "NightEventFired" })[0].eventId).toBe("ne-1");
    expect(restored.lastSeq()).toBe(2);
  });

  it("超过上限截断旧事件", () => {
    const log = new EventLog(2);
    log.append(createGameEvent("SpellShown", {}));
    log.append(createGameEvent("SpellShown", {}));
    log.append(createGameEvent("SpellShown", {}));
    expect(log.entries()).toHaveLength(2);
    expect(log.entries()[0].seq).toBe(2);
    expect(log.lastSeq()).toBe(3);
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "event-log 单元测试"));

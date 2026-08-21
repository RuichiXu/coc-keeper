/**
 * Trigger Engine 单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  TRIGGER_TYPES,
  evaluateTrigger,
  evaluateTriggers,
  remindersToTriggers,
  pendingReminders,
  TriggerEngine,
} from "../../lib/core/index.js";

const state = {
  currentScene: "书房",
  currentBranchId: "br-1",
  keyPoints: [
    { id: "kp1", title: "暗格", revealed: false, scene: "书房" },
    { id: "kp2", title: "古书", revealed: false, scene: "密室" },
  ],
  branches: [
    { id: "br-1", title: "是否撬开暗格", reached: true, chosen: null },
    { id: "br-2", title: "是否进入密室", reached: false, chosen: null },
  ],
  reminders: [
    { id: "r1", scene: "书房", text: "即将发现暗格", fired: false },
    { id: "r2", scene: "密室", text: "密室有动静", fired: false },
  ],
  characters: [{ name: "张三", hp: 5, san: 50 }],
};

describe("Trigger Engine", () => {
  it("scene 触发器匹配当前场景或空场景", () => {
    expect(evaluateTrigger({ id: "t1", type: TRIGGER_TYPES.SCENE, scene: "书房", text: "a" }, state)).toBeTrue();
    expect(evaluateTrigger({ id: "t2", type: TRIGGER_TYPES.SCENE, scene: "", text: "b" }, state)).toBeTrue();
    expect(evaluateTrigger({ id: "t3", type: TRIGGER_TYPES.SCENE, scene: "密室", text: "c" }, state)).toBeFalse();
  });

  it("已 fired 的触发器不再触发", () => {
    expect(evaluateTrigger({ id: "t1", type: TRIGGER_TYPES.SCENE, scene: "书房", text: "a", fired: true }, state)).toBeFalse();
  });

  it("branch-pending：已抵达且未选择才触发", () => {
    expect(evaluateTrigger({ id: "b1", type: TRIGGER_TYPES.BRANCH_PENDING, branchId: "br-1", text: "" }, state)).toBeTrue();
    expect(evaluateTrigger({ id: "b2", type: TRIGGER_TYPES.BRANCH_PENDING, branchId: "br-2", text: "" }, state)).toBeFalse();
  });

  it("keypoint-pending：当前场景未揭示才触发", () => {
    expect(evaluateTrigger({ id: "k1", type: TRIGGER_TYPES.KEYPOINT_PENDING, keyPointId: "kp1", text: "" }, state)).toBeTrue();
    expect(evaluateTrigger({ id: "k2", type: TRIGGER_TYPES.KEYPOINT_PENDING, keyPointId: "kp2", text: "" }, state)).toBeFalse();
  });

  it("state 条件触发器支持数值比较", () => {
    expect(evaluateTrigger({ id: "s1", type: TRIGGER_TYPES.STATE, condition: { path: "characters.0.hp", op: "lte", value: 5 }, text: "" }, state)).toBeTrue();
    expect(evaluateTrigger({ id: "s2", type: TRIGGER_TYPES.STATE, condition: { path: "characters.0.hp", op: "gt", value: 5 }, text: "" }, state)).toBeFalse();
  });

  it("evaluateTriggers 分组返回 fired/pending", () => {
    const triggers = [
      { id: "t1", type: TRIGGER_TYPES.SCENE, scene: "书房", text: "a" },
      { id: "t2", type: TRIGGER_TYPES.SCENE, scene: "密室", text: "b" },
    ];
    const result = evaluateTriggers(triggers, state);
    expect(result.fired).toHaveLength(1);
    expect(result.pending).toHaveLength(1);
  });

  it("pendingReminders 返回当前场景待触发提醒", () => {
    const pending = pendingReminders(state);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("r1");
  });

  it("TriggerEngine.fire 标记已触发", () => {
    const engine = new TriggerEngine([{ id: "t1", type: TRIGGER_TYPES.SCENE, scene: "书房", text: "a" }]);
    const fired = engine.evaluate(state);
    expect(fired).toHaveLength(1);
    engine.fire("t1");
    expect(engine.evaluate(state)).toHaveLength(0);
    expect(engine.history).toHaveLength(1);
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "trigger-engine 单元测试"));

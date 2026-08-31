/**
 * Trigger Engine 单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  TRIGGER_TYPES,
  evaluatePrerequisites,
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

  it("keypoint-prereq：结构化前置条件满足才触发", () => {
    const prereqState = {
      currentScene: "三层书房",
      passedCheckpointIds: ["chk-13"],
      sanitySettled: [],
      keyPoints: [
        { id: "ai-kp-7", title: "拼凑十二字咒文", revealed: false, requires: { checkpointGroups: [["chk-13"]] } },
        { id: "ai-kp-8", title: "最终抉择", revealed: false, requires: { keyPointIds: ["ai-kp-7"], branchChoiceIds: ["ai-br-3"] } },
      ],
      branches: [{ id: "ai-br-3", title: "最终仪式", reached: true, chosen: "逆序" }],
    };
    expect(evaluateTrigger({ id: "t1", type: TRIGGER_TYPES.KEYPOINT_PREREQ, keyPointId: "ai-kp-7", text: "" }, prereqState)).toBeTrue();
    expect(evaluateTrigger({ id: "t2", type: TRIGGER_TYPES.KEYPOINT_PREREQ, keyPointId: "ai-kp-8", text: "" }, prereqState)).toBeFalse();
  });

  it("evaluatePrerequisites 支持 optionLabel 选项级条件", () => {
    const ctx = {
      currentScene: "三层书房",
      playerText: "",
      narration: "",
      passedCheckpointIds: [],
      sanitySettled: [],
      keyPoints: [],
      branches: [
        { id: "ai-br-3", title: "最终仪式", reached: true, chosen: "逆序念诵（送神）" },
      ],
    };
    expect(evaluatePrerequisites({ branchChoiceIds: ["ai-br-3"], optionLabel: "逆序念诵（送神）" }, ctx)).toBeTrue();
    expect(evaluatePrerequisites({ branchChoiceIds: ["ai-br-3"], optionLabel: "正序念诵（请神）" }, ctx)).toBeFalse();
    expect(evaluatePrerequisites({ optionLabel: "逆序念诵（送神）" }, ctx)).toBeFalse();
  });

  it("evaluatePrerequisites 支持 not 否定条件", () => {
    const ctx = {
      currentScene: "三层书房",
      playerText: "",
      narration: "",
      passedCheckpointIds: [],
      sanitySettled: [],
      keyPoints: [{ id: "kp-1", title: "失败", revealed: false }],
      branches: [],
    };
    expect(evaluatePrerequisites({ not: { keyPointIds: ["kp-1"] } }, ctx)).toBeTrue();
    ctx.keyPoints[0].revealed = true;
    expect(evaluatePrerequisites({ not: { keyPointIds: ["kp-1"] } }, ctx)).toBeFalse();
  });

  it("branch-prereq 与 ending 触发器", () => {
    const branchState = {
      currentScene: "三层书房",
      passedCheckpointIds: [],
      sanitySettled: [{ eventId: "scenario:chk-9" }],
      keyPoints: [],
      branches: [
        { id: "ai-br-2", title: "是否掀开地毯", reached: false, chosen: null, requires: { sanityEventIds: ["chk-9"] } },
      ],
      endingReached: false,
    };
    expect(evaluateTrigger({ id: "b1", type: TRIGGER_TYPES.BRANCH_PREREQ, branchId: "ai-br-2", text: "" }, branchState)).toBeTrue();
    expect(evaluateTrigger({ id: "e1", type: TRIGGER_TYPES.ENDING, text: "" }, branchState)).toBeFalse();
    expect(evaluateTrigger({ id: "e2", type: TRIGGER_TYPES.ENDING, text: "" }, { ...branchState, endingReached: true })).toBeTrue();
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "trigger-engine 单元测试"));

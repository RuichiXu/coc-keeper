/**
 * Knowledge 分层单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  KNOWLEDGE_LAYERS,
  filterRolls,
  filterKeyPoints,
  filterBranches,
  filterEntities,
  buildKnowledgeView,
} from "../../lib/core/index.js";

const state = {
  title: "测试团",
  kpMode: "ai",
  currentScene: "书房",
  time: "1925年10月1日",
  synopsis: "调查书房",
  rules: { name: "CoC 7e" },
  scenario: { name: "测试剧本", chars: 10 },
  characters: [{ name: "张三", hp: 11, san: 60, mp: 12, luck: 55, inventory: [] }],
  tasks: [],
  entities: [
    { id: "e1", type: "npc", name: "隐藏NPC", scene: "密室", desc: "秘密" },
    { id: "e2", type: "item", name: "古书", scene: "书房", desc: "书" },
  ],
  keyPoints: [
    { id: "kp1", title: "已揭示", revealed: true },
    { id: "kp2", title: "未揭示", revealed: false },
  ],
  branches: [
    { id: "b1", title: "已抵达", reached: true },
    { id: "b2", title: "未抵达", reached: false },
  ],
  reminders: [{ id: "r1", scene: "书房", text: "提醒", fired: false }],
  rollHistory: [
    { kind: "open", expression: "d100", rolled: 50, player: "张三", label: "侦查", target: 60, tier: "regular" },
    { kind: "secret", expression: "d100", rolled: 99, player: "", label: "潜行", target: 40, tier: "fumble" },
  ],
};

describe("Knowledge 分层", () => {
  it("kp-full 保留暗骰与全部剧情结构", () => {
    const view = buildKnowledgeView(state, KNOWLEDGE_LAYERS.KP_FULL);
    expect(view.recentRolls).toHaveLength(2);
    expect(view.keyPoints).toHaveLength(2);
    expect(view.branches).toHaveLength(2);
    expect(view.entities).toHaveLength(2);
    expect(view.reminders).toHaveLength(1);
  });

  it("player 层隐藏暗骰、未揭示关键点与未抵达分支", () => {
    const view = buildKnowledgeView(state, KNOWLEDGE_LAYERS.PLAYER);
    expect(view.recentRolls).toHaveLength(1);
    expect(view.recentRolls[0].kind).toBe("open");
    expect(view.keyPoints).toHaveLength(1);
    expect(view.keyPoints[0].id).toBe("kp1");
    expect(view.branches).toHaveLength(1);
    expect(view.branches[0].id).toBe("b1");
    expect(view.reminders).toHaveLength(0);
  });

  it("player 层只显示当前场景实体", () => {
    const view = buildKnowledgeView(state, KNOWLEDGE_LAYERS.PLAYER);
    expect(view.entities).toHaveLength(1);
    expect(view.entities[0].id).toBe("e2");
  });

  it("public 层实体只保留名称", () => {
    const view = buildKnowledgeView(state, KNOWLEDGE_LAYERS.PUBLIC);
    expect(view.entities).toHaveLength(2);
    expect(view.entities[0].desc).toBeUndefined();
    expect(view.keyPoints).toHaveLength(1);
    expect(view.keyPoints[0].revealed).toBeTrue();
    expect(view.branches).toHaveLength(0);
  });

  it("filterRolls 限制条数", () => {
    const rolls = filterRolls(state.rollHistory, KNOWLEDGE_LAYERS.KP_FULL, 1);
    expect(rolls).toHaveLength(1);
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "knowledge-layers 单元测试"));

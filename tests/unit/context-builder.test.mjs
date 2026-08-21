/**
 * Context Builder 单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  buildKpSystemPrompt,
  buildLoopMessages,
  buildContext,
  renderStatusText,
  KNOWLEDGE_LAYERS,
} from "../../lib/core/index.js";

const state = {
  title: "测试团",
  kpMode: "ai",
  currentScene: "书房",
  currentBranchId: "br-1",
  time: "1925年10月1日",
  synopsis: "调查",
  rules: { name: "CoC 7e" },
  scenario: { name: "测试剧本", chars: 10 },
  characters: [{ name: "张三", occupation: "侦探", hp: 11, san: 60, mp: 12, luck: 55, inventory: ["手枪"] }],
  tasks: [{ id: "t1", title: "调查暗格", status: "open" }],
  entities: [{ id: "e1", type: "npc", name: "管家", state: "紧张", desc: "老管家", scene: "书房" }],
  keyPoints: [
    { id: "kp1", title: "发现暗格", revealed: false, scene: "书房" },
    { id: "kp2", title: "找到古书", revealed: true, scene: "书房" },
  ],
  branches: [
    { id: "br-1", title: "是否撬开暗格", options: [{ label: "撬开" }, { label: "离开" }], reached: true, chosen: null },
  ],
  reminders: [{ id: "r1", scene: "书房", text: "即将发现古书", fired: false }],
  rollHistory: [
    { kind: "open", expression: "d100", rolled: 30, player: "张三", label: "侦查", target: 60, tier: "hard" },
    { kind: "secret", expression: "d100", rolled: 99, player: "", label: "潜行", target: 40, tier: "fumble" },
  ],
  log: [
    { kind: "user", player: "张三", text: "我搜查书房" },
    { kind: "kp", player: "", text: "你在书架上发现一道暗格。" },
  ],
};

describe("Context Builder", () => {
  it("buildKpSystemPrompt 包含硬性规则与状态快照", () => {
    const system = buildKpSystemPrompt(state);
    expect(system).toContain("检定纪律");
    expect(system).toContain("测试团");
    expect(system).toContain("当前场景：书房");
    expect(system).toContain("张三");
    expect(system).toContain("未揭示关键剧情点：1 个");
    expect(system).toContain("待提醒（当前场景触发）：即将发现古书");
  });

  it("player 层系统提示不包含暗骰与未揭示关键点", () => {
    const system = buildKpSystemPrompt(state, KNOWLEDGE_LAYERS.PLAYER);
    expect(system).notToContain("未揭示关键剧情点");
    expect(system).notToContain("🔒");
  });

  it("buildLoopMessages 构建 user/assistant 消息", () => {
    const messages = buildLoopMessages(state.log, 10);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0].text).toContain("张三：我搜查书房");
    expect(messages[1].role).toBe("assistant");
  });

  it("buildContext 返回 system/messages/view", () => {
    const ctx = buildContext(state, { layer: KNOWLEDGE_LAYERS.KP_FULL, maxLog: 10 });
    expect(ctx.system.length).toBeGreaterThan(0);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.view.layer).toBe(KNOWLEDGE_LAYERS.KP_FULL);
    expect(ctx.view.recentRolls).toHaveLength(2);
  });

  it("renderStatusText 输出面板摘要", () => {
    const text = renderStatusText({
      game: "test",
      title: "测试团",
      kpMode: "ai",
      currentScene: "书房",
      characters: [{ name: "张三" }],
      keyPoints: [{ title: "古书", revealed: false }],
      branches: [{ title: "暗格", reached: false }],
      recentRolls: [{ kind: "open", player: "张三", label: "侦查", expression: "d100", rolled: 30, target: 60, tier: "hard" }],
    });
    expect(text).toContain("测试团");
    expect(text).toContain("未揭示关键剧情点");
    expect(text).toContain("待抵达分支");
    expect(text).toContain("最近骰点");
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "context-builder 单元测试"));

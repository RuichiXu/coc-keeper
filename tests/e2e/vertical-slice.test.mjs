/**
 * E2E Vertical Slice 测试
 *
 * 验证完整的最小闭环：
 * 玩家输入 → Director(模拟) → Skill/Rule Tool → Rule Result →
 * Event → State → Trigger → Clue/Plot → Narrative Recovery → Narrator(模拟)
 *
 * Director 和 Narrator 使用 Mock，不依赖真实 LLM。
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import { WorldState } from "../../lib/core/state/world-state.js";
import { PlotGraph } from "../../lib/core/plot/plot-graph.js";
import { ClueGraph } from "../../lib/core/clue/clue-graph.js";
import { EventBus } from "../../lib/core/events.js";
import { performRoll } from "../../lib/core/dice.js";
import { performSanityCheck } from "../../lib/core/rules/sanity.js";
import { performCombatRound } from "../../lib/core/rules/combat.js";
import { compileByPattern, toLegacyFormat } from "../../lib/core/scenario/compiler.js";
import { parseCharacters, normalizeCharacter } from "../../lib/core/character-parser.js";

// ── Mock Director ──
// 模拟 Director 的决策：判断玩家意图 → 选择技能 → 判定难度
function mockDirector(playerInput, worldState) {
  // 简单规则匹配，无需 LLM
  const input = playerInput.toLowerCase();

  if (input.includes("侦查") || input.includes("搜查") || input.includes("观察")) {
    return { action: "roll", skill: "侦查", difficulty: "regular", label: "侦查" };
  }
  if (input.includes("聆听") || input.includes("听")) {
    return { action: "roll", skill: "聆听", difficulty: "regular", label: "聆听" };
  }
  if (input.includes("攻击") || input.includes("打") || input.includes("战斗")) {
    return { action: "combat", weapon: "格斗（斗殴）" };
  }
  if (input.includes("san") || input.includes("理智") || input.includes("恐惧")) {
    return { action: "sanity", sanLoss: "0/1d3", description: "恐怖场景" };
  }

  return { action: "narrate", text: "你尝试了这个行动，但似乎没有明确的方向。" };
}

// ── Mock Narrator ──
function mockNarrator(ruleResult, worldState, visibleClues) {
  const lines = [];

  if (ruleResult.passed === true) {
    lines.push(`检定成功！你发现了重要的线索。`);
    if (visibleClues && visibleClues.length > 0) {
      lines.push(`你注意到：${visibleClues.map((c) => c.description).join("；")}`);
    }
  } else if (ruleResult.passed === false) {
    lines.push(`检定失败。你没能找到有用的信息。`);
  } else {
    lines.push(`当前场景：${worldState.currentScene}。${worldState.synopsis || ""}`);
  }

  return lines.join("\n");
}

// ── 测试 ──

describe("E2E Vertical Slice", () => {
  it("完整调查闭环：剧本导入 → 玩家调查 → 成功 → 线索 → 剧情推进", () => {
    // ── 1. 剧本导入 ──
    const scenarioText = `
【场景】废弃宅邸
调查员进入这座荒废多年的宅邸，空气中弥漫着霉味。
【NPC】老管家
一位年迈的管家，似乎知道些什么但不愿多说。
【物品】旧怀表
一枚刻有奇怪符号的怀表。
【关键剧情点】书房发现暗格
在书房的书架后面发现了一个隐藏的暗格。
【分支】是否撬开暗格
暗格上了锁，需要决定是否强行撬开。
`;

    const model = compileByPattern(scenarioText, "废弃宅邸");
    const legacy = toLegacyFormat(model);

    // ── 2. 初始化 WorldState ──
    const ws = new WorldState({ id: "test", title: "废弃宅邸" });
    ws.setScene("废弃宅邸");
    ws.setTime("1925年10月1日 下午3点");
    ws.setSynopsis("调查员受邀调查废弃宅邸中的神秘事件。");

    // 添加角色
    const chars = parseCharacters("姓名：张三\n职业：侦探\n力量：50\n敏捷：60\n侦查：70\n聆听：50\n格斗（斗殴）：50\n闪避：50");
    for (const [i, raw] of chars.entries()) {
      ws.addCharacter(normalizeCharacter(raw, i));
    }

    // 添加实体
    for (const ent of legacy.entities) {
      ws.addEntity(ent);
    }

    // ── 3. 初始化 ClueGraph ──
    const cg = new ClueGraph();
    cg.addClue({
      id: "clue-dark-compartment",
      description: "暗格中的古书，记载着召唤仪式",
      acquisitionMethods: ["侦查"],
      fallbackMethods: ["图书馆使用", "灵感"],
      isCritical: true,
    });
    cg.addClue({
      id: "clue-watch",
      description: "旧怀表上的符号与暗格古书中的一致",
      acquisitionMethods: ["侦查", "神秘学"],
      isCritical: false,
    });

    // ── 4. 初始化 PlotGraph ──
    const pg = new PlotGraph();
    pg.addNode({
      id: "pn-enter",
      title: "进入废弃宅邸",
      type: "scene",
      scene: "废弃宅邸",
      preconditions: [],
      leadsTo: ["pn-search-study"],
    });
    pg.addNode({
      id: "pn-search-study",
      title: "调查书房",
      type: "investigation",
      scene: "书房",
      preconditions: ["clue:clue-dark-compartment"],
      leadsTo: ["pn-open-compartment"],
    });
    pg.addNode({
      id: "pn-open-compartment",
      title: "打开暗格",
      type: "event",
      scene: "书房",
      preconditions: [],
    });

    pg.activateNode("pn-enter");
    pg.completeNode("pn-enter", "进入宅邸");

    // ── 5. EventBus 连接 ──
    const bus = new EventBus();
    const trace = [];

    bus.subscribe("RollPerformed", (e) => trace.push({ step: "roll", ...e }));
    bus.subscribe("ClueDiscovered", (e) => {
      trace.push({ step: "clue", ...e });
      ws.applyEvent(e);
      pg.checkPreconditions(ws);
    });
    bus.subscribe("SceneChanged", (e) => {
      trace.push({ step: "scene", ...e });
      ws.applyEvent(e);
    });

    // ── 6. 玩家回合 1：调查书房 ──
    const playerInput1 = "我要侦查书房，看看有没有什么异常";
    const directorDecision1 = mockDirector(playerInput1, ws);

    expect(directorDecision1.action).toBe("roll");
    expect(directorDecision1.skill).toBe("侦查");

    // 执行检定（固定成功）
    const restore1 = mockRandom([0.2]); // 20 → 对 70 困难成功
    const rollResult1 = performRoll("d100", 70, "regular");
    restore1();

    expect(rollResult1.passed).toBeTrue();

    // 发布检定事件
    bus.publish({
      type: "RollPerformed",
      at: new Date().toISOString(),
      gameId: "test",
      kind: "open",
      player: "张三",
      label: "侦查书房",
      skill: "侦查",
      expression: "d100",
      dice: rollResult1.dice,
      rolled: rollResult1.rolled,
      total: rollResult1.total,
      target: 70,
      difficulty: "regular",
      tier: rollResult1.tier,
      passed: true,
    });

    // 检定成功 → 发现线索
    cg.revealClue("clue-dark-compartment", "张三", "侦查");
    bus.publish({
      type: "ClueDiscovered",
      at: new Date().toISOString(),
      gameId: "test",
      clueId: "clue-dark-compartment",
      method: "侦查",
      character: "张三",
      isCritical: true,
    });

    // Narrator 生成叙事
    const visibleClues = cg.getVisibleClues("张三");
    const narration1 = mockNarrator(
      { passed: true },
      ws,
      visibleClues
    );

    // ── 验证 ──
    expect(ws.isClueDiscovered("clue-dark-compartment")).toBeTrue();
    expect(cg.isVisible("clue-dark-compartment", "张三")).toBeTrue();
    expect(pg.findNode("pn-search-study").status).toBe("active");

    const frontier = pg.getFrontier();
    expect(frontier.some((n) => n.id === "pn-search-study")).toBeTrue();

    // Trace 应包含完整链路
    expect(trace.filter((t) => t.step === "roll")).toHaveLength(1);
    expect(trace.filter((t) => t.step === "clue")).toHaveLength(1);

    // ── 7. 玩家回合 2：完成调查 → 推进剧情 ──
    pg.completeNode("pn-search-study", "发现暗格");

    // 场景自动推进
    ws.setScene("书房");
    bus.publish({
      type: "SceneChanged",
      at: new Date().toISOString(),
      gameId: "test",
      from: "废弃宅邸",
      to: "书房",
      reason: "发现暗格",
    });

    expect(pg.findNode("pn-open-compartment").status).toBe("active");
    expect(ws.currentScene).toBe("书房");

    // ── 最终验证：完整链路全部通过 ──
    // 剧本导入 → 状态初始化 → 角色创建 → 实体注册 → 玩家调查 →
    // 检定成功 → 线索发现 → Plot 推进 → 场景切换
    expect(ws.characters).toHaveLength(1);
    expect(ws.entities.length).toBeGreaterThanOrEqual(1);
    expect(ws.isClueDiscovered("clue-dark-compartment")).toBeTrue();
    expect(pg.getFrontier().map((n) => n.title)).toContain("打开暗格");
    expect(trace.length).toBeGreaterThanOrEqual(3);
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "vertical-slice E2E 测试"));
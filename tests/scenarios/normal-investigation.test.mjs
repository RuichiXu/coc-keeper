/**
 * 场景测试：正常调查推进
 *
 * 合理调查 → 检定成功 → 获得线索 → Trigger → Plot 推进
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import { WorldState } from "../../lib/core/state/world-state.js";
import { PlotGraph } from "../../lib/core/plot/plot-graph.js";
import { ClueGraph } from "../../lib/core/clue/clue-graph.js";
import { EventBus } from "../../lib/core/events.js";
import { performRoll } from "../../lib/core/dice.js";

describe("场景：正常调查推进", () => {
  it("玩家调查书房 → 侦查成功 → 发现线索 → 剧情推进", () => {
    // ── 初始化场景 ──
    const ws = new WorldState({ id: "test", title: "废弃宅邸调查" });
    ws.setScene("书房");
    ws.setTime("1925年10月1日 下午3点");
    ws.addCharacter({
      name: "张三",
      occupation: "侦探",
      hp: 11,
      san: 60,
      skills: { "侦查": 70, "图书馆使用": 50 },
      inventory: [],
    });

    // 剧本预置线索
    const cg = new ClueGraph();
    cg.addClue({
      id: "clue-gushu",
      description: "暗格中的古书，记载着祭祀仪式",
      acquisitionMethods: ["侦查"],
      fallbackMethods: ["图书馆使用"],
      isCritical: true,
    });

    // 剧情节点
    const pg = new PlotGraph();
    pg.addNode({
      id: "pn-enter",
      title: "进入废弃宅邸",
      type: "scene",
      scene: "废弃宅邸",
      preconditions: [],
      leadsTo: ["pn-investigate"],
    });
    pg.addNode({
      id: "pn-investigate",
      title: "调查书房线索",
      type: "investigation",
      scene: "书房",
      preconditions: ["clue:clue-gushu"],
      leadsTo: ["pn-confront"],
    });
    pg.addNode({
      id: "pn-confront",
      title: "面对真相",
      type: "confrontation",
      scene: "地下室",
      preconditions: [],
    });

    pg.activateNode("pn-enter");
    pg.completeNode("pn-enter", "进入成功");

    const bus = new EventBus();

    // ── 玩家行动：侦查书房 ──
    // 固定骰子：出目 30 → 技能 70 的困难成功
    const restore = mockRandom([0.29]); // 0.29 * 100 + 1 ≈ 30
    const roll = performRoll("d100", 70, "regular");
    restore();

    // 检定成功
    expect(roll.passed).toBeTrue();
    expect(roll.tier).toBe("hard");

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
      dice: roll.dice,
      rolled: roll.rolled,
      total: roll.total,
      target: 70,
      difficulty: "regular",
      tier: roll.tier,
      passed: true,
    });

    // ── 检定成功 → 发现线索 ──
    cg.revealClue("clue-gushu", "张三", "侦查");
    ws.discoverClue({
      clueId: "clue-gushu",
      method: "侦查",
      character: "张三",
      isCritical: true,
    });

    // ── 线索发现触发 Plot 更新 ──
    pg.checkPreconditions(ws);

    // ── 验证状态 ──
    expect(ws.isClueDiscovered("clue-gushu")).toBeTrue();
    expect(cg.isVisible("clue-gushu", "张三")).toBeTrue();

    // 调查节点应该被激活
    const investigateNode = pg.findNode("pn-investigate");
    expect(investigateNode.status).toBe("active");

    // Frontier 应该包含调查节点
    const frontier = pg.getFrontier();
    expect(frontier.some((n) => n.id === "pn-investigate")).toBeTrue();

    // 完成调查节点 → 推进到面对真相
    pg.completeNode("pn-investigate", "发现关键线索");
    expect(pg.findNode("pn-confront").status).toBe("active");

    // 验证整条链路：玩家行为 → 成功 → 线索 → 剧情推进
    expect(pg.getFrontier().map((n) => n.title)).toContain("面对真相");
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "normal-investigation 场景测试"));
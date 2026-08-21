/**
 * 场景测试：随机失败 →
 *
 * 合理调查 → 连续骰点失败 → 原线索未获得 → 替代路径出现 → 剧情仍可推进
 *
 * 当前阶段：Narrative Recovery 模块尚未实现，本测试验证"失败不破坏状态"。
 * 后续 Narrative Recovery 实现后，将补充替代路径自动激活的验证。
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import { WorldState } from "../../lib/core/state/world-state.js";
import { PlotGraph } from "../../lib/core/plot/plot-graph.js";
import { ClueGraph } from "../../lib/core/clue/clue-graph.js";
import { performRoll } from "../../lib/core/dice.js";

describe("场景：随机失败 + 恢复", () => {
  it("侦查失败 → 线索未获得 → 替代路径可用", () => {
    const ws = new WorldState({ id: "test" });
    ws.setScene("书房");
    ws.addCharacter({
      name: "张三",
      skills: { "侦查": 70, "图书馆使用": 50 },
      inventory: [],
    });

    const cg = new ClueGraph();
    cg.addClue({
      id: "clue-gushu",
      description: "暗格中的古书",
      acquisitionMethods: ["侦查"],
      fallbackMethods: ["图书馆使用", "NPC对话:老管家"],
      isCritical: true,
    });

    const pg = new PlotGraph();
    pg.addNode({
      id: "pn-investigate",
      title: "调查书房",
      preconditions: ["clue:clue-gushu"],
    });

    // ── 第一次侦查：失败 ──
    const restore1 = mockRandom([0.8]); // 80 → 对 70 失败
    const roll1 = performRoll("d100", 70, "regular");
    restore1();
    expect(roll1.passed).toBeFalse();

    // 线索未获得
    expect(cg.isVisible("clue-gushu", "张三")).toBeFalse();

    // ── 第二次侦查：再次失败 ──
    const restore2 = mockRandom([0.9]); // 90 → 失败
    const roll2 = performRoll("d100", 70, "regular");
    restore2();
    expect(roll2.passed).toBeFalse();

    // ── 验证：线索仍未获得，但替代路径存在 ──
    expect(cg.isVisible("clue-gushu", "张三")).toBeFalse();
    const fallbacks = cg.getFallbackMethods("clue-gushu");
    expect(fallbacks).toHaveLength(2);
    expect(fallbacks).toContain("图书馆使用");
    expect(fallbacks).toContain("NPC对话:老管家");

    // ── 玩家使用替代技能：图书馆使用（50）成功 ──
    const restore3 = mockRandom([0.4]); // 40 → 对 50 成功
    const roll3 = performRoll("d100", 50, "regular");
    restore3();
    expect(roll3.passed).toBeTrue();

    // 通过替代方式获得线索
    cg.revealClue("clue-gushu", "张三", "图书馆使用");
    ws.discoverClue({ clueId: "clue-gushu", method: "图书馆使用", character: "张三", isCritical: true });
    pg.checkPreconditions(ws);

    expect(cg.isVisible("clue-gushu", "张三")).toBeTrue();
    expect(pg.findNode("pn-investigate").status).toBe("active");

    // 验证：即使是替代路径，剧情仍然推进
    expect(ws.isClueDiscovered("clue-gushu")).toBeTrue();
  });

  it("关键线索有替代路径不会导致剧情卡死", () => {
    const cg = new ClueGraph();
    cg.addClue({
      id: "clue-critical",
      description: "关键线索",
      acquisitionMethods: ["侦查"],
      fallbackMethods: ["聆听", "心理学", "NPC对话"],
      isCritical: true,
    });

    // 即使主要获取方式失败，替代路径仍然存在
    expect(cg.getFallbackMethods("clue-critical")).toHaveLength(3);
  });

  it("动态添加替代路径", () => {
    const cg = new ClueGraph();
    cg.addClue({
      id: "clue-1",
      description: "线索",
      acquisitionMethods: ["侦查"],
      isCritical: true,
    });

    // 运行时添加替代路径（模拟 Director 的 Narrative Recovery 行为）
    cg.addFallbackMethod("clue-1", "灵感");
    cg.addFallbackMethod("clue-1", "神秘学");

    expect(cg.getFallbackMethods("clue-1")).toContain("灵感");
    expect(cg.getFallbackMethods("clue-1")).toContain("神秘学");
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "random-failure-recovery 场景测试"));
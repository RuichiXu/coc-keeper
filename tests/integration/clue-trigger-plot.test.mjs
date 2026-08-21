/**
 * 集成测试：Clue → Trigger → Plot Frontier 链路
 */
import { describe, it, expect } from "../runner.js";
import { WorldState } from "../../lib/core/state/world-state.js";
import { PlotGraph } from "../../lib/core/plot/plot-graph.js";
import { ClueGraph } from "../../lib/core/clue/clue-graph.js";
import { EventBus } from "../../lib/core/events.js";

describe("Clue → Trigger → Plot 集成", () => {
  it("发现线索 → Plot 前置条件满足 → 节点激活", () => {
    // 初始化
    const ws = new WorldState({ id: "test" });
    ws.setScene("书房");

    const pg = new PlotGraph();
    pg.addNode({
      id: "pn-1",
      title: "分析古书",
      type: "investigation",
      scene: "书房",
      preconditions: ["clue:clue-gushu"],
    });

    const cg = new ClueGraph();
    cg.addClue({
      id: "clue-gushu",
      description: "暗格中的古书",
      acquisitionMethods: ["侦查"],
      isCritical: true,
    });

    // 玩家发现线索
    cg.revealClue("clue-gushu", "张三", "侦查");
    ws.discoverClue({
      clueId: "clue-gushu",
      method: "侦查",
      character: "张三",
      isCritical: true,
    });

    // 验证 WorldState 记录线索
    expect(ws.isClueDiscovered("clue-gushu")).toBeTrue();

    // Plot 检查前置条件
    pg.checkPreconditions(ws);

    // 验证节点激活
    expect(pg.findNode("pn-1").status).toBe("active");
  });

  it("线索未发现 → Plot 节点保持 inactive", () => {
    const ws = new WorldState({ id: "test" });
    const pg = new PlotGraph();
    pg.addNode({
      id: "pn-1",
      title: "分析古书",
      preconditions: ["clue:clue-gushu"],
    });

    pg.checkPreconditions(ws);
    expect(pg.findNode("pn-1").status).toBe("inactive");
  });

  it("多条线索发现 → 多个节点激活 → Frontier 更新", () => {
    const ws = new WorldState({ id: "test" });
    ws.setScene("废弃宅邸");

    const pg = new PlotGraph();
    pg.addNode({
      id: "pn-1",
      title: "分析古书",
      preconditions: ["clue:clue-1"],
      leadsTo: ["pn-2"],
    });
    pg.addNode({
      id: "pn-2",
      title: "质问管家",
      preconditions: ["clue:clue-2"],
    });
    pg.addNode({
      id: "pn-3",
      title: "探索地下室",
      preconditions: ["flag:basement_found"],
    });

    const cg = new ClueGraph();
    cg.addClue({ id: "clue-1", description: "古书", isCritical: true });
    cg.addClue({ id: "clue-2", description: "管家举止异常", isCritical: false });

    // 发现线索 1
    cg.revealClue("clue-1", "张三", "侦查");
    ws.discoverClue({ clueId: "clue-1", method: "侦查", character: "张三", isCritical: true });

    pg.checkPreconditions(ws);
    expect(pg.getFrontier()).toHaveLength(1);
    expect(pg.getFrontier()[0].title).toBe("分析古书");

    // 完成分析古书 → 自动激活后继？不，n2 需要 clue-2
    pg.completeNode("pn-1", "分析完成");
    // completeNode 会激活后继，但后继的 precondition 检查由 checkPreconditions 负责
    // 这里手动将 n2 重置为 inactive（模拟前置条件阻止）
    pg.findNode("pn-2").status = "inactive";
    pg.checkPreconditions(ws);
    expect(pg.findNode("pn-2").status).toBe("inactive"); // 仍需 clue-2

    // 发现线索 2
    cg.revealClue("clue-2", "张三", "心理学");
    ws.discoverClue({ clueId: "clue-2", method: "心理学", character: "张三", isCritical: false });

    pg.checkPreconditions(ws);
    expect(pg.findNode("pn-2").status).toBe("active");
  });

  it("通过 EventBus 连接 Clue → Plot", () => {
    const ws = new WorldState({ id: "test" });
    const pg = new PlotGraph();
    const bus = new EventBus();

    pg.addNode({
      id: "pn-discover",
      title: "发现秘密",
      preconditions: ["clue:clue-secret"],
    });

    // 订阅 ClueDiscovered 事件 → 自动更新 WorldState 并检查 Plot
    bus.subscribe("ClueDiscovered", (event) => {
      ws.applyEvent(event);
      pg.checkPreconditions(ws);
    });

    // 发布线索发现事件
    bus.publish({
      type: "ClueDiscovered",
      at: new Date().toISOString(),
      gameId: "test",
      clueId: "clue-secret",
      method: "侦查",
      character: "张三",
      isCritical: true,
    });

    expect(ws.isClueDiscovered("clue-secret")).toBeTrue();
    expect(pg.findNode("pn-discover").status).toBe("active");
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "clue-trigger-plot 集成测试"));
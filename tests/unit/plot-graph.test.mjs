/**
 * Plot Graph 单元测试
 */
import { describe, it, expect } from "../runner.js";
import { PlotGraph } from "../../lib/core/plot/plot-graph.js";
import { WorldState } from "../../lib/core/state/world-state.js";

describe("PlotGraph", () => {
  describe("节点操作", () => {
    it("添加节点", () => {
      const pg = new PlotGraph();
      const node = pg.addNode({ title: "测试节点", type: "scene" });
      expect(node.id).toMatch(/pn-/);
      expect(pg.findNode(node.id)).notToBeUndefined();
    });
    it("重复 ID 抛出异常", () => {
      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A" });
      expect(() => pg.addNode({ id: "n1", title: "B" })).toThrow("已存在");
    });
  });

  describe("激活/完成/阻塞", () => {
    it("激活节点", () => {
      const pg = new PlotGraph();
      const node = pg.addNode({ id: "n1", title: "测试" });
      pg.activateNode("n1");
      expect(pg.findNode("n1").status).toBe("active");
    });
    it("完成节点自动激活后继", () => {
      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A", leadsTo: ["n2", "n3"] });
      pg.addNode({ id: "n2", title: "B" });
      pg.addNode({ id: "n3", title: "C" });
      pg.activateNode("n1");
      pg.completeNode("n1");
      expect(pg.findNode("n2").status).toBe("active");
      expect(pg.findNode("n3").status).toBe("active");
    });
    it("已完成节点不再激活", () => {
      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A" });
      pg.activateNode("n1");
      pg.completeNode("n1");
      pg.activateNode("n1");
      expect(pg.findNode("n1").status).toBe("completed");
    });
    it("阻塞节点", () => {
      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A" });
      pg.blockNode("n1", "条件不满足");
      expect(pg.findNode("n1").status).toBe("blocked");
    });
  });

  describe("Frontier", () => {
    it("获取活跃节点", () => {
      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A" });
      pg.addNode({ id: "n2", title: "B" });
      pg.activateNode("n1");
      pg.activateNode("n2");
      expect(pg.getFrontier()).toHaveLength(2);
    });
    it("按场景过滤 Frontline", () => {
      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A", scene: "书房" });
      pg.addNode({ id: "n2", title: "B", scene: "门厅" });
      pg.addNode({ id: "n3", title: "C", scene: "" });
      pg.activateNode("n1");
      pg.activateNode("n2");
      pg.activateNode("n3");
      expect(pg.getFrontierInScene("书房")).toHaveLength(2); // n1 + n3
    });
  });

  describe("前置条件检查", () => {
    it("flag 条件满足时激活", () => {
      const ws = new WorldState();
      ws.setFlag("door_unlocked", true);

      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A", preconditions: ["flag:door_unlocked"] });
      pg.checkPreconditions(ws);
      expect(pg.findNode("n1").status).toBe("active");
    });
    it("flag 条件不满足时不激活", () => {
      const ws = new WorldState();

      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A", preconditions: ["flag:door_unlocked"] });
      pg.checkPreconditions(ws);
      expect(pg.findNode("n1").status).toBe("inactive");
    });
    it("clue 条件满足时激活", () => {
      const ws = new WorldState();
      ws.discoverClue({ clueId: "clue-1", method: "侦查", character: "张三", isCritical: true });

      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A", preconditions: ["clue:clue-1"] });
      pg.checkPreconditions(ws);
      expect(pg.findNode("n1").status).toBe("active");
    });
    it("scene 条件检查", () => {
      const ws = new WorldState();
      ws.setScene("书房");

      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A", preconditions: ["scene:书房"] });
      pg.addNode({ id: "n2", title: "B", preconditions: ["scene:地下室"] });
      pg.checkPreconditions(ws);
      expect(pg.findNode("n1").status).toBe("active");
      expect(pg.findNode("n2").status).toBe("inactive");
    });
    it("无前置条件立即激活", () => {
      const ws = new WorldState();
      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A", preconditions: [] });
      pg.checkPreconditions(ws);
      expect(pg.findNode("n1").status).toBe("active");
    });
  });

  describe("摘要", () => {
    it("digest 返回正确统计", () => {
      const pg = new PlotGraph();
      pg.addNode({ id: "n1", title: "A" });
      pg.addNode({ id: "n2", title: "B" });
      pg.activateNode("n1");
      pg.completeNode("n1");

      const d = pg.digest();
      expect(d.totalNodes).toBe(2);
      expect(d.activeCount).toBe(0);
      expect(d.completedCount).toBe(1);
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "plot-graph 单元测试"));
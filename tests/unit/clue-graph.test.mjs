/**
 * Clue Graph 单元测试
 */
import { describe, it, expect } from "../runner.js";
import { ClueGraph } from "../../lib/core/clue/clue-graph.js";

describe("ClueGraph", () => {
  describe("线索管理", () => {
    it("添加线索", () => {
      const cg = new ClueGraph();
      const clue = cg.addClue({ description: "古书", acquisitionMethods: ["侦查"] });
      expect(clue.id).toMatch(/clue-/);
      expect(cg.findClue(clue.id)).notToBeUndefined();
    });
    it("重复 ID 抛出异常", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "A" });
      expect(() => cg.addClue({ id: "c1", description: "B" })).toThrow("已存在");
    });
    it("获取关键线索", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "关键", isCritical: true });
      cg.addClue({ id: "c2", description: "非关键", isCritical: false });
      expect(cg.getCriticalClues()).toHaveLength(1);
    });
  });

  describe("可见性", () => {
    it("揭示线索", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "A" });
      cg.revealClue("c1", "张三", "侦查");
      expect(cg.isVisible("c1", "张三")).toBeTrue();
      expect(cg.isVisible("c1", "李四")).toBeFalse();
    });
    it("无角色名检查是否已被任何人揭示", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "A" });
      cg.revealClue("c1", "张三");
      expect(cg.isVisible("c1")).toBeTrue();
    });
    it("获取可见/隐藏线索", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "A" });
      cg.addClue({ id: "c2", description: "B" });
      cg.revealClue("c1", "张三");
      expect(cg.getVisibleClues("张三")).toHaveLength(1);
      expect(cg.getHiddenClues("张三")).toHaveLength(1);
    });
  });

  describe("推导关系", () => {
    it("揭示线索自动揭示推导线索", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "A" });
      cg.addClue({ id: "c2", description: "B" });
      cg.setRevelation("c1", ["c2"]);
      cg.revealClue("c1", "张三");
      expect(cg.isVisible("c2", "张三")).toBeTrue();
    });
  });

  describe("替代路径", () => {
    it("获取替代获取方式", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "A", acquisitionMethods: ["侦查"], fallbackMethods: ["聆听", "NPC对话"] });
      expect(cg.getFallbackMethods("c1")).toContain("聆听");
      expect(cg.getFallbackMethods("c1")).toContain("NPC对话");
    });
    it("动态添加替代方式", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "A", acquisitionMethods: ["侦查"] });
      cg.addFallbackMethod("c1", "心理学");
      expect(cg.getFallbackMethods("c1")).toContain("心理学");
    });
  });

  describe("摘要", () => {
    it("digest 返回正确统计", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "A", isCritical: true });
      cg.addClue({ id: "c2", description: "B", isCritical: false });
      cg.revealClue("c1", "张三");
      const d = cg.digest("张三");
      expect(d.totalClues).toBe(2);
      expect(d.visibleCount).toBe(1);
      expect(d.hiddenCount).toBe(1);
      expect(d.criticalTotal).toBe(1);
      expect(d.criticalHidden).toBe(0);
    });
  });

  describe("toJSON / fromJSON", () => {
    it("序列化与反序列化", () => {
      const cg = new ClueGraph();
      cg.addClue({ id: "c1", description: "A" });
      cg.revealClue("c1", "张三");
      const json = cg.toJSON();
      const restored = ClueGraph.fromJSON(json);
      expect(restored.isVisible("c1", "张三")).toBeTrue();
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "clue-graph 单元测试"));
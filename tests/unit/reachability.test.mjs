/**
 * Ending Reachability 单元测试
 */
import { describe, it, expect } from "../runner.js";
import { PlotGraph, analyzeReachability, summarizeReachability } from "../../lib/core/index.js";

function buildPlot() {
  const plot = new PlotGraph();
  plot.addNode({ id: "start", title: "开始", leadsTo: ["mid"] });
  plot.addNode({ id: "mid", title: "中段", leadsTo: ["ending-a", "ending-b"] });
  plot.addNode({ id: "ending-a", title: "结局A", leadsTo: [] });
  plot.addNode({ id: "ending-b", title: "结局B", leadsTo: [] });
  plot.activateNode("start", "test");
  return plot;
}

describe("Ending Reachability", () => {
  it("结局候选 = 叶子节点", () => {
    const plot = buildPlot();
    const analysis = analyzeReachability(plot);
    expect(analysis.endings).toHaveLength(2);
  });

  it("从活跃节点可达的叶子结局可达", () => {
    const plot = buildPlot();
    const analysis = analyzeReachability(plot);
    expect(analysis.anyEndingReachable).toBeTrue();
    expect(analysis.reachableEndings).toHaveLength(2);
  });

  it("未激活节点导致结局不可达", () => {
    const plot = new PlotGraph();
    plot.addNode({ id: "start", title: "开始", leadsTo: ["ending"] });
    plot.addNode({ id: "ending", title: "结局", leadsTo: [] });
    // 不激活 start
    const analysis = analyzeReachability(plot);
    expect(analysis.anyEndingReachable).toBeFalse();
    expect(analysis.unreachableIds).toContain("start");
    expect(analysis.unreachableIds).toContain("ending");
  });

  it("summarizeReachability 生成摘要", () => {
    const plot = buildPlot();
    const text = summarizeReachability(plot);
    expect(text).toContain("结局可达");
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "reachability 单元测试"));

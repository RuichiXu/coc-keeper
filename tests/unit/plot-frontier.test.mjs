/**
 * C-3 多线剧情图 / 可达路线集合（frontier）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  PlotGraph,
  computeStoryFrontier,
  storyFrontierText,
} from "../../lib/core/index.js";

describe("computeStoryFrontier 可达路线", () => {
  it("场景型关键点：当前场景匹配时可达", () => {
    const flat = {
      currentScene: "三层书房",
      passedCheckpointIds: [],
      sanitySettled: [],
      keyPoints: [
        { id: "ai-kp-3", title: "进入书房", scene: "三层书房", revealed: false, requires: { scene: "三层书房", entryEvidence: ["进入书房"] } },
      ],
      branches: [],
    };
    const routes = computeStoryFrontier(flat);
    expect(routes).toHaveLength(1);
    expect(routes[0].status).toBe("active");
    expect(routes[0].missing).toHaveLength(0);
  });

  it("检定点组：缺任一组时 blocked 并列出缺失", () => {
    const flat = {
      currentScene: "三层书房",
      passedCheckpointIds: ["chk-3"],
      sanitySettled: [],
      keyPoints: [
        { id: "ai-kp-4", title: "发现日记与手稿", scene: "三层书房", revealed: false, requires: { checkpointGroups: [["chk-3", "chk-4"], ["chk-5", "chk-6"]] } },
      ],
      branches: [],
    };
    const routes = computeStoryFrontier(flat);
    expect(routes[0].status).toBe("blocked");
    expect(routes[0].missing).toContain("检定点：chk-5 或 chk-6");
  });

  it("SAN 结算与关键点/分支选择组合条件", () => {
    const flat = {
      currentScene: "三层书房·仪式终结",
      passedCheckpointIds: [],
      sanitySettled: [{ eventId: "scenario:chk-9", player: "伊芙琳" }],
      keyPoints: [
        { id: "ai-kp-5", title: "发现墨渊", scene: "三层书房", revealed: false, requires: { sanityEventIds: ["chk-9"] } },
        { id: "ai-kp-7", title: "拼凑十二字咒文", scene: "三层书房", revealed: true, requires: { checkpointGroups: [["chk-13"]] } },
        { id: "ai-kp-8", title: "最终抉择", scene: "三层书房/结局", revealed: false, requires: { keyPointIds: ["ai-kp-7"], branchChoiceIds: ["ai-br-3"] } },
      ],
      branches: [
        { id: "ai-br-3", title: "最终咒文念诵方式", scene: "三层书房/结局", reached: true, chosen: "逆序念诵（送神）", options: [] },
      ],
    };
    const routes = computeStoryFrontier(flat);
    expect(routes.find((route) => route.id === "ai-kp-5").status).toBe("active");
    expect(routes.find((route) => route.id === "ai-kp-8").status).toBe("active");
  });

  it("requiresAnyOf：任一满足即可达", () => {
    const flat = {
      currentScene: "三层书房",
      passedCheckpointIds: [],
      sanitySettled: [],
      keyPoints: [
        { id: "ai-kp-6", title: "克罗斯临终提示", scene: "三层书房", revealed: false, requiresAnyOf: [{ keyPointIds: ["ai-kp-7"] }, { branchChoiceIds: ["ai-br-3"] }] },
      ],
      branches: [
        { id: "ai-br-3", title: "最终咒文念诵方式", scene: "三层书房", reached: true, chosen: "逆序", options: [] },
      ],
    };
    const routes = computeStoryFrontier(flat);
    expect(routes[0].status).toBe("active");
  });

  it("无结构化前置条件的关键点不进路线集合", () => {
    const flat = {
      currentScene: "一层门厅",
      passedCheckpointIds: [],
      sanitySettled: [],
      keyPoints: [{ id: "ai-kp-2", title: "发现一层墨渍", scene: "一层门厅", revealed: false }],
      branches: [],
    };
    expect(computeStoryFrontier(flat)).toHaveLength(0);
  });
});

describe("storyFrontierText", () => {
  it("渲染路线与缺失条件", () => {
    const routes = [
      { id: "kp-1", title: "进入书房", scene: "三层书房", status: "active", missing: [] },
      { id: "kp-2", title: "发现日记与手稿", scene: "三层书房", status: "blocked", missing: ["检定点：chk-5 或 chk-6"] },
    ];
    const text = storyFrontierText(routes);
    expect(text).toContain("进入书房");
    expect(text).toContain("✓可推进");
    expect(text).toContain("✗未解锁");
    expect(text).toContain("chk-5 或 chk-6");
  });
});

describe("PlotGraph 故事结构同步", () => {
  it("syncFromStory 建立节点与边，applyStoryFrontier 写回状态", () => {
    const graph = new PlotGraph();
    graph.syncFromStory({
      keyPoints: [{ id: "ai-kp-5", title: "发现墨渊", scene: "三层书房", revealed: false }],
      branches: [{ id: "ai-br-2", title: "是否掀开地毯", scene: "三层书房", reached: true, chosen: null, options: [{ label: "掀开地毯查看", leadsTo: "发现墨渊" }] }],
    });
    expect(graph.findNode("kp:ai-kp-5")).notToBeUndefined();
    expect(graph.findNode("br:ai-br-2")).notToBeUndefined();
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].from).toBe("br:ai-br-2");
    expect(graph.edges[0].to).toBe("kp:ai-kp-5");

    graph.applyStoryFrontier([{ id: "ai-kp-5", title: "发现墨渊", scene: "三层书房", status: "active", missing: [] }]);
    expect(graph.findNode("kp:ai-kp-5").status).toBe("active");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "plot-frontier 单元测试"));

/**
 * 网络拓扑骨架后处理与条件可达闭包测试。
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  applyTopologySkeleton,
  computeConditionalClosure,
  inferReachability,
  runDeepParsePreflight,
} from "../../lib/core/index.js";

function edgeSet(deepParse) {
  return new Set((deepParse.plotEdges ?? []).map((edge) => `${edge.from}->${edge.to}`));
}

describe("网络拓扑骨架（topology-skeleton）", () => {
  it("inferReachability：main→strict，side/clue→conditional，父节点 main 的 scene_event→strict", () => {
    expect(inferReachability({ kind: "scene", flowRole: "main" })).toBe("strict");
    expect(inferReachability({ kind: "scene", flowRole: "side" })).toBe("conditional");
    expect(inferReachability({ kind: "scene", flowRole: "clue" })).toBe("conditional");
    const parentMap = new Map([["kp-1", { flowRole: "main" }]]);
    expect(inferReachability({ kind: "scene_event", parentId: "kp-1" }, parentMap)).toBe("strict");
    expect(inferReachability({ kind: "scene_event", parentId: "kp-2" }, parentMap)).toBe("conditional");
    expect(inferReachability({ kind: "scene_event" })).toBe("conditional");
    expect(inferReachability({ kind: "scene", reachability: "optional" })).toBe("optional");
  });

  it("hub-and-spoke：同级 main 场景不串链，补虚拟枢纽与 fallback 边", () => {
    const flat = {
      keyPoints: [
        { id: "kp-1", title: "书房", scene: "书房", kind: "scene", flowRole: "main", parentId: null, sectionId: "s1", order: 1, level: 2 },
        { id: "kp-2", title: "厨房", scene: "厨房", kind: "scene", flowRole: "main", parentId: null, sectionId: "s2", order: 2, level: 2 },
        { id: "kp-3", title: "庭院", scene: "庭院", kind: "scene", flowRole: "main", parentId: null, sectionId: "s3", order: 3, level: 2 },
      ],
      branches: [],
      scenarioStructure: {
        sections: [
          { id: "s0", title: "宅邸", displayName: "宅邸", kind: "chapter", flowRole: null, parentId: null, order: 1, level: 1, startLine: 1, endLine: 9 },
          { id: "s1", title: "书房", displayName: "书房", kind: "scene", flowRole: "main", parentId: "s0", order: 1, level: 2, startLine: 1, endLine: 3 },
          { id: "s2", title: "厨房", displayName: "厨房", kind: "scene", flowRole: "main", parentId: "s0", order: 2, level: 2, startLine: 4, endLine: 6 },
          { id: "s3", title: "庭院", displayName: "庭院", kind: "scene", flowRole: "main", parentId: "s0", order: 3, level: 2, startLine: 7, endLine: 9 },
        ],
      },
    };
    const deepParse = { plotEdges: [], endings: [], keyPoints: [], branches: [], branchConditions: [], keyPointConditions: [] };
    const result = applyTopologySkeleton(flat, deepParse);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(7);
    const keys = edgeSet(deepParse);
    expect(keys.has("kp:kp-hub-s0->kp:kp-1")).toBeTrue();
    expect(keys.has("kp:kp-hub-s0->kp:kp-2")).toBeTrue();
    expect(keys.has("kp:kp-hub-s0->kp:kp-3")).toBeTrue();
    expect(keys.has("kp:kp-1->kp:kp-hub-s0-return")).toBeTrue();
    expect(keys.has("kp:kp-2->kp:kp-hub-s0-return")).toBeTrue();
    expect(keys.has("kp:kp-3->kp:kp-hub-s0-return")).toBeTrue();
    expect(keys.has("kp:kp-hub-s0-return->kp:kp-hub-s0")).toBeTrue();
    expect([...deepParse.plotEdges].every((edge) => edge.fallback === true)).toBeTrue();
    expect(deepParse.keyPoints.some((kp) => kp.virtual === true && kp.reachability === "optional")).toBeTrue();
  });

  it("顺序编号：房间1/房间2/房间3 按编号补边，不生成虚拟枢纽", () => {
    const flat = {
      keyPoints: [
        { id: "kp-1", title: "房间1", scene: "房间1", kind: "scene", flowRole: "main", parentId: null, order: 1 },
        { id: "kp-2", title: "房间2", scene: "房间2", kind: "scene", flowRole: "main", parentId: null, order: 2 },
        { id: "kp-3", title: "房间3", scene: "房间3", kind: "scene", flowRole: "main", parentId: null, order: 3 },
      ],
      branches: [],
      scenarioStructure: { sections: [] },
    };
    const deepParse = { plotEdges: [], endings: [], keyPoints: [], branches: [], branchConditions: [], keyPointConditions: [] };
    const result = applyTopologySkeleton(flat, deepParse);
    expect(result.nodesAdded).toBe(0);
    const keys = edgeSet(deepParse);
    expect(keys.has("kp:kp-1->kp:kp-2")).toBeTrue();
    expect(keys.has("kp:kp-2->kp:kp-3")).toBeTrue();
    expect([...deepParse.plotEdges].every((edge) => edge.fallback === true)).toBeTrue();
  });

  it("条件闭包：requires 引用未达节点时不能推进，引用可达后推进", () => {
    const opening = new Set(["kp:kp-1"]);
    const checkpointIds = new Set(["chk-1"]);
    const edges = [
      { from: "kp:kp-1", to: "kp:kp-2", requires: [] },
      { from: "kp:kp-2", to: "kp:kp-3", requires: [{ keyPointIds: ["kp-4"] }] },
    ];
    const first = computeConditionalClosure({ openingIds: opening, edges, branchConditions: [], checkpointIds });
    expect(first.has("kp:kp-2")).toBeTrue();
    expect(first.has("kp:kp-3")).toBeFalse();

    const edges2 = [...edges, { from: "kp:kp-1", to: "kp:kp-4", requires: [] }];
    const second = computeConditionalClosure({ openingIds: opening, edges: edges2, branchConditions: [], checkpointIds });
    expect(second.has("kp:kp-4")).toBeTrue();
    expect(second.has("kp:kp-3")).toBeTrue();
  });

  it("preflight 分级：conditional 闭包不可达报 medium，hook 可达后 pass", () => {
    const baseFlat = {
      scenario: { name: "测试" },
      keyPoints: [
        { id: "kp-1", title: "开场", scene: "开场", kind: "scene", flowRole: "main", parentId: null, order: 1 },
        { id: "kp-2", title: "支线", scene: "支线", kind: "scene", flowRole: "side", parentId: null, order: 2 },
      ],
      branches: [],
      scenarioCheckpoints: [],
    };
    const deepParse = {
      version: "1.0",
      keyPoints: [],
      branches: [],
      keyPointConditions: [],
      branchConditions: [],
      plotEdges: [],
      endings: [],
    };
    const report = runDeepParsePreflight(deepParse, baseFlat);
    expect(report.medium).toBeGreaterThan(0);
    expect(report.issues.some((issue) => issue.problem.includes("条件闭包下不可达"))).toBeTrue();
    expect(report.pass).toBeFalse();

    const hooked = {
      ...baseFlat,
      keyPoints: [...baseFlat.keyPoints],
    };
    const hookedDp = {
      ...deepParse,
      plotEdges: [{ from: "kp:kp-1", to: "kp:kp-2", label: "前往支线", requires: [] }],
    };
    const hookedReport = runDeepParsePreflight(hookedDp, hooked);
    expect(hookedReport.high).toBe(0);
    expect(hookedReport.medium).toBe(0);
    expect(hookedReport.pass).toBeTrue();
  });
});

run().then(summarize);

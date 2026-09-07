/**
 * 地点与路线索引单元测试
 *
 * 覆盖：地点白名单/别名收集、邻接图、玩家转移意图识别、
 * 地点候选提取与未登记地点检测。
 */
import { describe, it, expect } from "../runner.js";
import {
  buildRouteIndex,
  collectAllowedLocationTerms,
  extractRoomLikeTerms,
  findTravelIntent,
  findUnknownLocationTerms,
  resolveLocation,
  routeNeighbors,
} from "../../lib/core/scenario/route-index.js";

function liulangFlat() {
  return {
    keyPoints: [
      { id: "kp-1", scene: "镇广场", title: "镇广场" },
      { id: "kp-2", scene: "酒馆", title: "酒馆" },
      { id: "kp-3", scene: "矿洞", title: "矿洞" },
      { id: "kp-4", scene: "遗迹入口", title: "遗迹入口" },
      { id: "kp-5", scene: "房间1：能量分流室", title: "房间1" },
      { id: "kp-6", scene: "房间2：泄压阀控制室", title: "房间2" },
      { id: "kp-7", scene: "外部控制室", title: "外部控制室" },
      { id: "kp-hub-top", scene: "", title: "全剧枢纽" },
    ],
    branches: [{ id: "br-final-1", scene: "房间2：泄压阀控制室", title: "最终抉择" }],
    deepParse: {
      plotEdges: [
        { from: "kp:kp-2", to: "kp:kp-3" },
        { from: "kp:kp-3", to: "kp:kp-4" },
        { from: "kp:kp-4", to: "kp:kp-5" },
        { from: "kp:kp-4", to: "kp:kp-6" },
        { from: "kp:kp-6", to: "kp:kp-7" },
      ],
    },
    scenario: { text: "房间1：能量分流室\n房间2：泄压阀控制室\n走廊很长。" },
  };
}

describe("地点与路线索引", () => {
  it("收集地点白名单并解析别名", () => {
    const index = buildRouteIndex(liulangFlat());
    const names = index.entries.map((entry) => entry.name);
    expect(names).toContain("酒馆");
    expect(names).toContain("房间1：能量分流室");
    expect(resolveLocation(index.aliasIndex, "能量分流室")).toBe("房间1：能量分流室");
    expect(resolveLocation(index.aliasIndex, "矿洞-凉爽侧向岔道")).toBe("矿洞");
  });

  it("邻接图：遗迹入口可前往房间1/房间2，不可直接到外部控制室", () => {
    const index = buildRouteIndex(liulangFlat());
    const route = routeNeighbors(index, "遗迹入口");
    expect(route.current).toBe("遗迹入口");
    expect(route.neighbors.includes("房间1：能量分流室")).toBe(true);
    expect(route.neighbors.includes("房间2：泄压阀控制室")).toBe(true);
    expect(route.neighbors.includes("外部控制室")).toBe(false);
  });

  it("findTravelIntent 识别玩家前往意图", () => {
    const index = buildRouteIndex(liulangFlat());
    expect(findTravelIntent(index.aliasIndex, "我走进酒馆")).toBe("酒馆");
    expect(findTravelIntent(index.aliasIndex, "我前往能量分流室")).toBe("房间1：能量分流室");
    expect(findTravelIntent(index.aliasIndex, "我站在原地")).toBeNull();
  });

  it("findTravelIntent 跳过条件句与问路请求", () => {
    const flat = liulangFlat();
    const index = buildRouteIndex(flat);
    expect(findTravelIntent(index.aliasIndex, "如果确实空无一物，就转去矿洞")).toBeNull();
    expect(findTravelIntent(index.aliasIndex, "请镇长提供去矿洞的路线")).toBeNull();
    expect(findTravelIntent(index.aliasIndex, "我前往矿洞")).toBe("矿洞");
  });

  it("提取地点候选并检测未登记地点", () => {
    const flat = liulangFlat();
    const index = buildRouteIndex(flat);
    const allowed = collectAllowedLocationTerms(flat, index);
    expect(extractRoomLikeTerms("你看到下层阀门舱和旋梯").includes("旋梯")).toBe(true);
    expect(extractRoomLikeTerms("你看到下层阀门舱和旋梯").includes("舱")).toBe(true);
    const unknown = findUnknownLocationTerms("你穿过旋梯，进入下层阀门舱", allowed);
    expect(unknown.includes("旋梯")).toBe(true);
    expect(unknown.includes("舱")).toBe(true);
    expect(findUnknownLocationTerms("你沿走廊进入能量分流室", allowed)).toEqual([]);
  });

  it("原文出现过的地点词视为允许", () => {
    const flat = liulangFlat();
    flat.scenario.text += "\n你沿着旋梯向上。";
    const allowed = collectAllowedLocationTerms(flat);
    expect(findUnknownLocationTerms("你沿着旋梯向上", allowed)).toEqual([]);
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "route-index 单元测试"));

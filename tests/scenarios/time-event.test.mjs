/**
 * 场景测试：时间事件
 *
 * 时间推进 → 到达触发时间 → Event/Trigger → 世界状态与剧情变化
 */
import { describe, it, expect } from "../runner.js";
import { WorldState } from "../../lib/core/state/world-state.js";
import { PlotGraph } from "../../lib/core/plot/plot-graph.js";
import { advanceGameTime, parseGameTime, isAfter } from "../../lib/core/clock.js";

describe("场景：时间事件", () => {
  it("时间推进触发剧情节点", () => {
    const ws = new WorldState({ id: "test" });
    ws.setTime("1925年10月1日 下午2点");
    ws.setScene("废弃宅邸");

    const pg = new PlotGraph();
    pg.addNode({
      id: "pn-ritual",
      title: "午夜仪式开始",
      type: "event",
      preconditions: ["flag:time_midnight"],
    });

    // 下午2点 → 仪式节点未激活
    pg.checkPreconditions(ws);
    expect(pg.findNode("pn-ritual").status).toBe("inactive");

    // ── 时间推进到午夜 ──
    let time = ws.time;
    for (let i = 0; i < 10; i++) {
      time = advanceGameTime(time, "hour");
    }
    ws.setTime(time);

    // 判断是否到达夜晚（22点后到凌晨6点前都算午夜时段）
    const parsed = parseGameTime(ws.time);
    if (parsed && (parsed.hour >= 22 || parsed.hour < 6)) {
      ws.setFlag("time_midnight", true);
    }

    // 重新检查条件
    pg.checkPreconditions(ws);

    // 仪式节点应该激活
    expect(ws.hasFlag("time_midnight")).toBeTrue();
    expect(pg.findNode("pn-ritual").status).toBe("active");
  });

  it("NPC 定时离开", () => {
    const ws = new WorldState({ id: "test" });
    ws.setTime("1925年10月1日 下午8点");
    ws.setFlag("npc_present", true);

    // 推进到 22:00 — NPC 离开的时间
    let time = ws.time;
    time = advanceGameTime(time, "hour");
    time = advanceGameTime(time, "hour");
    ws.setTime(time);

    const parsed = parseGameTime(ws.time);
    if (parsed && parsed.hour >= 22) {
      ws.setFlag("npc_present", false);
      ws.setFlag("npc_left", true);
    }

    // 下午8点 + 2小时 = 下午10点 = 22:00
    expect(ws.hasFlag("npc_present")).toBeFalse();
    expect(ws.hasFlag("npc_left")).toBeTrue();
  });

  it("时间推进不丢失信息", () => {
    let time = "1925年10月1日 下午3点";
    const original = parseGameTime(time);

    // 推进 24 小时
    for (let i = 0; i < 24; i++) {
      time = advanceGameTime(time, "hour");
    }

    const result = parseGameTime(time);
    expect(result.year).toBe(original.year);
    expect(result.month).toBe(original.month);
    expect(result.day).toBe(original.day + 1);
    expect(result.hour).toBe(original.hour);
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "time-event 场景测试"));
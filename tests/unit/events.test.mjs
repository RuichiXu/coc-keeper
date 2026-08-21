/**
 * EventBus 单元测试
 */
import { describe, it, expect } from "../runner.js";
import { EventBus } from "../../lib/core/events.js";

describe("EventBus", () => {
  it("发布事件后 history 包含该事件", () => {
    const bus = new EventBus();
    const event = { type: "RollPerformed", rolled: 45 };
    bus.publish(event);
    expect(bus.history()).toHaveLength(1);
    expect(bus.history()[0].rolled).toBe(45);
  });

  it("订阅者收到事件", () => {
    const bus = new EventBus();
    let received = null;
    bus.subscribe("RollPerformed", (e) => { received = e; });
    bus.publish({ type: "RollPerformed", rolled: 60 });
    expect(received).notToBeNull();
    expect(received.rolled).toBe(60);
  });

  it("取消订阅后不再收到事件", () => {
    const bus = new EventBus();
    let count = 0;
    const unsubscribe = bus.subscribe("RollPerformed", () => { count++; });
    bus.publish({ type: "RollPerformed", rolled: 1 });
    unsubscribe();
    bus.publish({ type: "RollPerformed", rolled: 2 });
    expect(count).toBe(1);
  });

  it("historyOf 按类型过滤", () => {
    const bus = new EventBus();
    bus.publish({ type: "RollPerformed", rolled: 1 });
    bus.publish({ type: "DamageApplied", amount: 5 });
    bus.publish({ type: "RollPerformed", rolled: 2 });
    expect(bus.historyOf("RollPerformed")).toHaveLength(2);
    expect(bus.historyOf("DamageApplied")).toHaveLength(1);
    expect(bus.historyOf("SanityLost")).toHaveLength(0);
  });

  it("超过 maxHistory 时截断", () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i++) bus.publish({ type: "Test", n: i });
    expect(bus.history()).toHaveLength(3);
    expect(bus.history()[0].n).toBe(2);
  });

  it("handler 异常不阻止其他 handler", () => {
    const bus = new EventBus();
    let called = false;
    bus.subscribe("Test", () => { throw new Error("boom"); });
    bus.subscribe("Test", () => { called = true; });
    // 不应抛出
    bus.publish({ type: "Test" });
    expect(called).toBeTrue();
  });

  it("clearHistory 清空历史", () => {
    const bus = new EventBus();
    bus.publish({ type: "Test" });
    bus.clearHistory();
    expect(bus.history()).toHaveLength(0);
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "events 单元测试"));
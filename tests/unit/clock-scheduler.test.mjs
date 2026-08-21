/**
 * Game Clock 定时事件单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  isTimeReached,
  evaluateScheduledEvents,
  createScheduledEvent,
  fireScheduledEvent,
  formatScheduledEvent,
} from "../../lib/core/index.js";

describe("Game Clock 定时事件", () => {
  it("isTimeReached 判断时间到达", () => {
    expect(isTimeReached("1925年10月1日 下午3点", "1925年10月1日 下午3点")).toBeTrue();
    expect(isTimeReached("1925年10月1日 下午4点", "1925年10月1日 下午3点")).toBeTrue();
    expect(isTimeReached("1925年10月1日 下午2点", "1925年10月1日 下午3点")).toBeFalse();
    expect(isTimeReached("", "1925年10月1日 下午3点")).toBeFalse();
  });

  it("evaluateScheduledEvents 分组 fired/pending", () => {
    const events = [
      createScheduledEvent("e1", "1925年10月1日 下午2点", "旧事件"),
      createScheduledEvent("e2", "1925年10月1日 下午5点", "未来事件"),
    ];
    const { fired, pending } = evaluateScheduledEvents(events, "1925年10月1日 下午3点");
    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe("e1");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("e2");
  });

  it("fireScheduledEvent 标记已触发", () => {
    const events = [createScheduledEvent("e1", "1925年10月1日 下午2点", "事件")];
    const firedEvent = fireScheduledEvent(events, "e1");
    expect(firedEvent.fired).toBeTrue();
    expect(evaluateScheduledEvents(events, "1925年10月1日 下午3点").fired).toHaveLength(0);
  });

  it("formatScheduledEvent 输出可读文本", () => {
    const text = formatScheduledEvent(createScheduledEvent("e1", "1925年10月1日 下午3点", "钟声响起"));
    expect(text).toContain("钟声响起");
    expect(text).toContain("1925年10月1日 下午3点");
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "clock-scheduler 单元测试"));

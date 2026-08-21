/**
 * Game Clock 单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  parseGameTime,
  formatGameTime,
  advanceGameTime,
  minutesBetween,
  isAfter,
  isBefore,
} from "../../lib/core/clock.js";

describe("Game Clock", () => {
  describe("parseGameTime", () => {
    it("解析完整时间", () => {
      const gt = parseGameTime("1925年10月1日 下午3点");
      expect(gt.year).toBe(1925);
      expect(gt.month).toBe(10);
      expect(gt.day).toBe(1);
      expect(gt.hour).toBe(15);
    });
    it("解析上午时间", () => {
      const gt = parseGameTime("1925年1月15日 上午9点");
      expect(gt.hour).toBe(9);
    });
    it("解析晚上时间", () => {
      const gt = parseGameTime("1925年12月25日 晚上8点");
      expect(gt.hour).toBe(20);
    });
    it("无时间部分默认上午9点", () => {
      const gt = parseGameTime("1925年6月1日");
      expect(gt.hour).toBe(9);
    });
    it("无效文本返回 null", () => {
      expect(parseGameTime("abc")).toBeNull();
      expect(parseGameTime("")).toBeNull();
    });
  });

  describe("formatGameTime", () => {
    it("格式化下午时间", () => {
      expect(formatGameTime({ year: 1925, month: 10, day: 1, hour: 15 }))
        .toBe("1925年10月1日 下午3点");
    });
    it("格式化晚上时间", () => {
      expect(formatGameTime({ year: 1925, month: 10, day: 1, hour: 21 }))
        .toBe("1925年10月1日 晚上9点");
    });
    it("格式化上午时间", () => {
      expect(formatGameTime({ year: 1925, month: 10, day: 1, hour: 8 }))
        .toBe("1925年10月1日 上午8点");
    });
    it("12点处理", () => {
      expect(formatGameTime({ year: 1925, month: 10, day: 1, hour: 12 }))
        .toBe("1925年10月1日 下午12点");
    });
  });

  describe("advanceGameTime", () => {
    it("+1小时", () => {
      expect(advanceGameTime("1925年10月1日 下午3点", "hour"))
        .toBe("1925年10月1日 下午4点");
    });
    it("+1天", () => {
      expect(advanceGameTime("1925年10月1日 下午3点", "day"))
        .toBe("1925年10月2日 下午3点");
    });
    it("到夜晚", () => {
      expect(advanceGameTime("1925年10月1日 下午3点", "night"))
        .toBe("1925年10月1日 晚上9点");
    });
    it("空时间推进", () => {
      expect(advanceGameTime("", "night"))
        .toBe("1925年10月1日 晚上9点");
    });
    it("无效文本追加标注", () => {
      const result = advanceGameTime("未知时间", "hour");
      expect(result).toMatch(/未知时间/);
      expect(result).toMatch(/\+1小时/);
    });
  });

  describe("minutesBetween", () => {
    it("计算时间差", () => {
      const t1 = { year: 1925, month: 10, day: 1, hour: 14 };
      const t2 = { year: 1925, month: 10, day: 1, hour: 16 };
      expect(minutesBetween(t1, t2)).toBe(120);
    });
    it("跨天计算", () => {
      const t1 = { year: 1925, month: 10, day: 1, hour: 22 };
      const t2 = { year: 1925, month: 10, day: 2, hour: 2 };
      expect(minutesBetween(t1, t2)).toBe(240);
    });
  });

  describe("isAfter / isBefore", () => {
    it("isAfter 正确", () => {
      const t1 = { year: 1925, month: 10, day: 1, hour: 16 };
      const t2 = { year: 1925, month: 10, day: 1, hour: 14 };
      expect(isAfter(t1, t2)).toBeTrue();
      expect(isAfter(t2, t1)).toBeFalse();
    });
    it("isBefore 正确", () => {
      const t1 = { year: 1925, month: 10, day: 1, hour: 14 };
      const t2 = { year: 1925, month: 10, day: 1, hour: 16 };
      expect(isBefore(t1, t2)).toBeTrue();
      expect(isBefore(t2, t1)).toBeFalse();
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "clock 单元测试"));
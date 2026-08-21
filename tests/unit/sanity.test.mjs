/**
 * SAN 检定引擎单元测试
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import { performSanityCheck, parseSanLoss, rollExpr } from "../../lib/core/rules/sanity.js";

describe("SAN 检定", () => {
  describe("parseSanLoss", () => {
    it("解析 0/1d3", () => {
      expect(parseSanLoss("0/1d3")).toEqual({ successExpr: "0", failExpr: "1d3" });
    });
    it("解析 1/1d6+1", () => {
      expect(parseSanLoss("1/1d6+1")).toEqual({ successExpr: "1", failExpr: "1d6+1" });
    });
    it("解析固定值 1d3", () => {
      expect(parseSanLoss("1d3")).toEqual({ successExpr: "0", failExpr: "1d3" });
    });
  });

  describe("rollExpr", () => {
    it("掷 1d3 在 1-3 范围内", () => {
      const restore = mockRandom([0.5]); // 0.5 * 3 + 1 = 2
      expect(rollExpr("1d3")).toBe(2);
      restore();
    });
    it("掷 1d6+1", () => {
      const restore = mockRandom([0.5]); // 0.5 * 6 + 1 + 1 = 5
      expect(rollExpr("1d6+1")).toBe(5);
      restore();
    });
    it("空表达式返回 0", () => {
      expect(rollExpr("")).toBe(0);
    });
  });

  describe("performSanityCheck", () => {
    it("成功时损失 successExpr", () => {
      const restore = mockRandom([0.01]); // 1/100 → critical, 成功
      const result = performSanityCheck({
        characterName: "张三",
        currentSan: 60,
        intValue: 70,
        sanLoss: "0/1d3",
        description: "测试",
      });
      expect(result.passed).toBeTrue();
      expect(result.sanLost).toBe(0);
      expect(result.events).toHaveLength(2);
      restore();
    });

    it("失败时损失 failExpr", () => {
      const restore = mockRandom([0.9]); // 90/100 → fail
      const result = performSanityCheck({
        characterName: "张三",
        currentSan: 60,
        intValue: 70,
        sanLoss: "0/1d3",
        description: "测试",
      });
      expect(result.passed).toBeFalse();
      expect(result.sanLost).toBeGreaterThanOrEqual(1);
      restore();
    });

    it("SAN 不低于 0", () => {
      const restore = mockRandom([0.9]); // fail
      const result = performSanityCheck({
        characterName: "张三",
        currentSan: 1,
        sanLoss: "0/1d6",
        description: "测试",
      });
      expect(result.sanAfter).toBe(0);
      restore();
    });

    it("永久性疯狂判定", () => {
      const restore = mockRandom([0.9]); // fail
      const result = performSanityCheck({
        characterName: "张三",
        currentSan: 1,
        sanLoss: "0/1d6",
        description: "测试",
      });
      expect(result.madness).toMatch(/永久性疯狂/);
      restore();
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "sanity 单元测试"));
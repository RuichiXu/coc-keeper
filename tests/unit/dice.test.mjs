/**
 * 骰点引擎单元测试
 */
import { describe, it, expect, mockRandom, randomForDice } from "../runner.js";
import {
  parseDiceExpression,
  rollDice,
  roll,
  evaluateCoC,
  passedFor,
  performRoll,
  renderRollLine,
  TIER_LABELS,
} from "../../lib/core/dice.js";

describe("骰点引擎", () => {
  // ── parseDiceExpression ──
  describe("parseDiceExpression", () => {
    it("解析 d100", () => {
      expect(parseDiceExpression("d100")).toEqual({ count: 1, sides: 100, mod: 0 });
    });
    it("解析 3d6", () => {
      expect(parseDiceExpression("3d6")).toEqual({ count: 3, sides: 6, mod: 0 });
    });
    it("解析 d20+2", () => {
      expect(parseDiceExpression("d20+2")).toEqual({ count: 1, sides: 20, mod: 2 });
    });
    it("解析 2d10-1", () => {
      expect(parseDiceExpression("2d10-1")).toEqual({ count: 2, sides: 10, mod: -1 });
    });
    it("拒绝无效骰式", () => {
      expect(() => parseDiceExpression("abc")).toThrow("无法解析");
    });
  });

  // ── rollDice ──
  describe("rollDice", () => {
    it("返回正确数组长度", () => {
      const restore = mockRandom([0.5, 0.5, 0.5]);
      const dice = rollDice(3, 6);
      expect(dice).toHaveLength(3);
      restore();
    });
    it("骰值在合理范围内", () => {
      const restore = mockRandom([0.0, 0.99]);
      const dice = rollDice(2, 100);
      expect(dice[0]).toBe(1);
      expect(dice[1]).toBe(100);
      restore();
    });
  });

  // ── evaluateCoC ──
  describe("evaluateCoC", () => {
    it("非百分骰：≤ 目标为 pass", () => {
      expect(evaluateCoC(10, 8, false).tier).toBe("pass");
    });
    it("非百分骰：> 目标为 fail", () => {
      expect(evaluateCoC(10, 12, false).tier).toBe("fail");
    });
    it("01 大成功", () => {
      expect(evaluateCoC(60, 1, true).tier).toBe("critical");
    });
    it("技能 ≥ 50 时 01-05 大成功", () => {
      expect(evaluateCoC(60, 5, true).tier).toBe("critical");
    });
    it("技能 < 50 时仅 01 大成功（05 不为大成功）", () => {
      expect(evaluateCoC(30, 1, true).tier).toBe("critical");
      expect(evaluateCoC(30, 3, true).tier).toBe("extreme");
    });
    it("≤ 1/5 极限成功", () => {
      expect(evaluateCoC(60, 12, true).tier).toBe("extreme");
    });
    it("≤ 1/2 困难成功", () => {
      expect(evaluateCoC(60, 30, true).tier).toBe("hard");
    });
    it("≤ 技能值 常规成功", () => {
      expect(evaluateCoC(60, 55, true).tier).toBe("regular");
    });
    it("> 技能值 失败", () => {
      expect(evaluateCoC(60, 70, true).tier).toBe("fail");
    });
    it("技能 ≥ 50 时 96-99 为普通失败（非大失败）", () => {
      expect(evaluateCoC(50, 96, true).tier).toBe("fail");
      expect(evaluateCoC(75, 99, true).tier).toBe("fail");
    });
    it("技能 ≥ 50 时 00(=100) 为大失败", () => {
      expect(evaluateCoC(50, 100, true).tier).toBe("fumble");
    });
    it("技能 < 50 时 96-00 大失败", () => {
      expect(evaluateCoC(30, 96, true).tier).toBe("fumble");
      expect(evaluateCoC(30, 100, true).tier).toBe("fumble");
    });
  });

  // ── passedFor ──
  describe("passedFor", () => {
    it("critical 总是通过", () => {
      expect(passedFor("critical", "regular", true)).toBeTrue();
      expect(passedFor("critical", "extreme", true)).toBeTrue();
    });
    it("extreme 总是通过", () => {
      expect(passedFor("extreme", "regular", true)).toBeTrue();
      expect(passedFor("extreme", "extreme", true)).toBeTrue();
    });
    it("hard 通过 regular 和 hard", () => {
      expect(passedFor("hard", "regular", true)).toBeTrue();
      expect(passedFor("hard", "hard", true)).toBeTrue();
      expect(passedFor("hard", "extreme", true)).toBeFalse();
    });
    it("regular 仅通过 regular", () => {
      expect(passedFor("regular", "regular", true)).toBeTrue();
      expect(passedFor("regular", "hard", true)).toBeFalse();
    });
    it("fail 不通过", () => {
      expect(passedFor("fail", "regular", true)).toBeFalse();
    });
    it("fumble 不通过", () => {
      expect(passedFor("fumble", "regular", true)).toBeFalse();
    });
  });

  // ── performRoll ──
  describe("performRoll", () => {
    it("有 target 时返回 tier 和 passed", () => {
      const restore = mockRandom([0.5]); // 0.5 * 100 + 1 ≈ 51
      const result = performRoll("d100", 60, "regular");
      expect(result.rolled).toBe(51);
      expect(result.tier).toBe("regular");
      expect(result.passed).toBeTrue();
      restore();
    });
    it("无 target 时 tier 和 passed 为 null", () => {
      const result = performRoll("3d6");
      expect(result.tier).toBeNull();
      expect(result.passed).toBeNull();
    });
    it("难度 extreme 时，regular 不通过", () => {
      const restore = mockRandom([0.5]); // 51, regular 对 60
      const result = performRoll("d100", 60, "extreme");
      expect(result.passed).toBeFalse();
      restore();
    });
  });

  // ── renderRollLine ──
  describe("renderRollLine", () => {
    it("渲染基础骰点", () => {
      const line = renderRollLine({
        expression: "d100",
        rolled: 45,
        target: 60,
        difficulty: "regular",
        tier: "regular",
        passed: true,
      });
      expect(line).toMatch(/掷 d100 = 45/);
      expect(line).toMatch(/目标 60/);
      expect(line).toMatch(/常规成功/);
    });
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "dice 单元测试"));
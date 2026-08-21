/**
 * 战斗规则引擎单元测试
 *
 * 覆盖：
 * - DB 表达式计算（CoC 7e 标准表）
 * - DB 掷骰（负数常量 / 正数骰式）
 * - 战斗回合结算（命中、伤害、重伤判定、事件产出）
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import {
  dbExpression,
  rollDb,
  performCombatRound,
} from "../../lib/core/rules/combat.js";

describe("战斗规则引擎", () => {
  // ── DB 表达式 ──
  describe("dbExpression", () => {
    it("STR+SIZ 2-64 → -2", () => {
      expect(dbExpression(30, 30)).toBe("-2");
    });
    it("STR+SIZ 65-84 → -1", () => {
      expect(dbExpression(35, 40)).toBe("-1");
    });
    it("STR+SIZ 85-124 → 0", () => {
      expect(dbExpression(50, 50)).toBe("0");
    });
    it("STR+SIZ 125-164 → 1d4", () => {
      expect(dbExpression(60, 70)).toBe("1d4");
    });
    it("STR+SIZ 165-204 → 1d6", () => {
      expect(dbExpression(80, 90)).toBe("1d6");
    });
    it("STR+SIZ 205-284 → 2d6", () => {
      expect(dbExpression(100, 110)).toBe("2d6");
    });
    it("STR+SIZ 285+ → 3d6", () => {
      expect(dbExpression(140, 150)).toBe("3d6");
    });
  });

  // ── DB 掷骰 ──
  describe("rollDb", () => {
    it("掷负数常量", () => {
      expect(rollDb("-2")).toBe(-2);
      expect(rollDb("-1")).toBe(-1);
    });
    it("掷 0", () => {
      expect(rollDb("0")).toBe(0);
    });
    it("掷 1d4", () => {
      const restore = mockRandom([0.5]); // 0.5 * 4 + 1 = 3
      expect(rollDb("1d4")).toBe(3);
      restore();
    });
    it("掷 2d6", () => {
      const restore = mockRandom([0.0, 0.99]); // 1 + 6 = 7
      expect(rollDb("2d6")).toBe(7);
      restore();
    });
  });

  // ── 战斗回合结算 ──
  describe("performCombatRound", () => {
    it("命中后造成武器伤害，DamageApplied 事件携带正确 HP", () => {
      // 攻击检定 31（对 60 困难成功），刀 1d6 掷出 6，DB=0
      const restore = mockRandom([0.3, 0.99]);
      const result = performCombatRound({
        attackerName: "张三",
        defenderName: "深潜者",
        attacker: { skills: { "格斗（剑）": 60 }, stats: { STR: 50, SIZ: 50 } },
        defender: { skills: { "闪避": 40 }, hp: 15, stats: { HP: 15 } },
        weapon: "刀",
        defenderDodge: false,
        defenderIsEntity: true,
      });
      restore();

      expect(result.hit).toBeTrue();
      expect(result.damage).toBe(6);
      expect(result.hpBefore).toBe(15);
      expect(result.hpAfter).toBe(9);

      const damageEvent = result.events.find((e) => e.type === "DamageApplied");
      expect(damageEvent).notToBeUndefined();
      expect(damageEvent.target).toBe("entity:深潜者");
      expect(damageEvent.hpBefore).toBe(15);
      expect(damageEvent.hpAfter).toBe(9);
      expect(damageEvent.amount).toBe(6);
    });

    it("重伤判定：单次伤害 ≥ 最大 HP 的一半", () => {
      // 攻击命中，刀 1d6 掷出 6，最大 HP 10 → 6 ≥ 5 重伤
      const restore = mockRandom([0.3, 0.99]);
      const result = performCombatRound({
        attackerName: "张三",
        defenderName: "深潜者",
        attacker: { skills: { "格斗（剑）": 60 }, stats: { STR: 50, SIZ: 50 } },
        defender: { skills: { "闪避": 40 }, hp: 10, stats: { HP: 10 } },
        weapon: "刀",
        defenderDodge: false,
        defenderIsEntity: true,
      });
      restore();

      const damageEvent = result.events.find((e) => e.type === "DamageApplied");
      expect(damageEvent.isMajorWound).toBeTrue();
    });

    it("轻伤不触发重伤判定", () => {
      // 攻击命中，刀 1d6 掷出 2，最大 HP 10 → 2 < 5 非重伤
      const restore = mockRandom([0.3, 0.2]); // 0.2 * 6 + 1 = 2
      const result = performCombatRound({
        attackerName: "张三",
        defenderName: "深潜者",
        attacker: { skills: { "格斗（剑）": 60 }, stats: { STR: 50, SIZ: 50 } },
        defender: { skills: { "闪避": 40 }, hp: 10, stats: { HP: 10 } },
        weapon: "刀",
        defenderDodge: false,
        defenderIsEntity: true,
      });
      restore();

      const damageEvent = result.events.find((e) => e.type === "DamageApplied");
      expect(damageEvent.isMajorWound).toBeFalse();
    });

    it("DB 为负时伤害不低于 0", () => {
      // 攻击命中，刀 1d6 掷出 1，DB=-2 → 最终伤害 0，不产生 DamageApplied
      const restore = mockRandom([0.3, 0.0]);
      const result = performCombatRound({
        attackerName: "张三",
        defenderName: "深潜者",
        attacker: { skills: { "格斗（剑）": 60 }, stats: { STR: 30, SIZ: 30 } },
        defender: { skills: { "闪避": 40 }, hp: 15, stats: { HP: 15 } },
        weapon: "刀",
        defenderDodge: false,
        defenderIsEntity: true,
      });
      restore();

      expect(result.damage).toBe(0);
      expect(result.events.find((e) => e.type === "DamageApplied")).toBeUndefined();
    });

    it("攻击未命中时不产生伤害事件", () => {
      // 攻击检定 91（对 60 失败）
      const restore = mockRandom([0.9]);
      const result = performCombatRound({
        attackerName: "张三",
        defenderName: "深潜者",
        attacker: { skills: { "格斗（剑）": 60 }, stats: { STR: 50, SIZ: 50 } },
        defender: { skills: { "闪避": 40 }, hp: 15, stats: { HP: 15 } },
        weapon: "刀",
        defenderDodge: false,
        defenderIsEntity: true,
      });
      restore();

      expect(result.hit).toBeFalse();
      expect(result.events.find((e) => e.type === "DamageApplied")).toBeUndefined();
    });
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "combat 单元测试"));

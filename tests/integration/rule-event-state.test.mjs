/**
 * 集成测试：Rule Engine → Event → WorldState 链路
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import { WorldState } from "../../lib/core/state/world-state.js";
import { EventBus } from "../../lib/core/events.js";
import { performSanityCheck } from "../../lib/core/rules/sanity.js";
import { performCombatRound } from "../../lib/core/rules/combat.js";
import { performSkillGrowth } from "../../lib/core/rules/skill-growth.js";

describe("Rule → Event → State 集成", () => {
  describe("SAN 检定链路", () => {
    it("完整 SAN 检定 → Event → WorldState 更新", () => {
      const ws = new WorldState({ id: "test" });
      ws.addCharacter({
        name: "张三",
        hp: 11,
        san: 60,
        stats: { HP: 11, SAN: 60, INT: 70 },
        inventory: [],
      });

      const restore = mockRandom([0.9]); // 90 → fail
      const result = performSanityCheck({
        characterName: "张三",
        currentSan: 60,
        intValue: 70,
        sanLoss: "0/1d3",
        description: "目睹深潜者",
      });
      restore();

      // 验证 Rule Engine 返回结果
      expect(result.passed).toBeFalse();
      expect(result.events).toHaveLength(2); // RollPerformed + SanityLost

      // 通过 EventBus 传播事件
      const bus = new EventBus();
      let sanityLost = false;
      bus.subscribe("SanityLost", () => { sanityLost = true; });
      for (const evt of result.events) {
        bus.publish(evt);
        ws.applyEvent(evt);
      }

      // 验证 WorldState 正确更新
      expect(sanityLost).toBeTrue();
      expect(ws.findCharacter("张三").san).toBeLessThan(60);
      expect(ws.findCharacter("张三").san).toBe(result.sanAfter);
    });
  });

  describe("战斗链路", () => {
    it("战斗 → DamageApplied → WorldState 更新", () => {
      const ws = new WorldState({ id: "test" });
      ws.addCharacter({
        name: "张三",
        hp: 11,
        stats: { STR: 50, SIZ: 55, HP: 11 },
        skills: { "格斗（斗殴）": 60 },
        inventory: [],
      });
      ws.addEntity({ type: "npc", name: "深潜者", state: "hp=15" });

      const restore = mockRandom([0.3]); // 30 → hard success
      const result = performCombatRound({
        attackerName: "张三",
        defenderName: "深潜者",
        attacker: { skills: { "格斗（斗殴）": 60, "格斗（剑）": 60 }, stats: { STR: 50, SIZ: 55 } },
        defender: { skills: { "闪避": 40 }, hp: 15, stats: { HP: 15 } },
        weapon: "刀",
        defenderDodge: false,
        defenderIsEntity: true,
      });
      restore();

      // 验证 Rule Engine 返回
      expect(result.hit).toBeTrue();
      expect(result.events.length).toBeGreaterThanOrEqual(1);

      const bus = new EventBus();
      let damageApplied = false;
      bus.subscribe("DamageApplied", () => { damageApplied = true; });

      for (const evt of result.events) {
        bus.publish(evt);
        ws.applyEvent(evt);
      }

      expect(damageApplied).toBeTrue();
    });
  });

  describe("技能成长链路", () => {
    it("技能成长 → SkillGrown → 角色技能更新", () => {
      const ws = new WorldState({ id: "test" });
      ws.addCharacter({
        name: "张三",
        skills: { "侦查": 70 },
        inventory: [],
      });

      const restore = mockRandom([0.8]); // 80 > 70 → 成长
      const result = performSkillGrowth({
        characterName: "张三",
        skillName: "侦查",
        currentValue: 70,
      });
      restore();

      expect(result.grown).toBeTrue();
      expect(result.events).toHaveLength(2); // RollPerformed + SkillGrown

      const bus = new EventBus();
      let skillGrown = false;
      bus.subscribe("SkillGrown", () => { skillGrown = true; });
      for (const evt of result.events) {
        bus.publish(evt);
        ws.applyEvent(evt);
      }

      expect(skillGrown).toBeTrue();
      expect(result.after).toBeGreaterThan(70);
      // 事件必须真正写入结构化状态
      expect(ws.findCharacter("张三").skills["侦查"]).toBe(result.after);
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "rule-event-state 集成测试"));
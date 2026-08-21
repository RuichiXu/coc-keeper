/**
 * 技能成长规则引擎单元测试
 *
 * 规则：掷 d100，若大于当前技能值则增加 1d10。
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import { performSkillGrowth } from "../../lib/core/rules/skill-growth.js";
import { WorldState } from "../../lib/core/state/world-state.js";

describe("技能成长规则引擎", () => {
  describe("performSkillGrowth", () => {
    it("掷骰 > 当前值 → 成长，产出 RollPerformed + SkillGrown 事件", () => {
      const restore = mockRandom([0.8, 0.5]); // d100=81 > 70；1d10=6
      const result = performSkillGrowth({
        characterName: "张三",
        skillName: "侦查",
        currentValue: 70,
      });
      restore();

      expect(result.grown).toBeTrue();
      expect(result.rolled).toBe(81);
      expect(result.gain).toBe(6);
      expect(result.after).toBe(76);
      expect(result.events).toHaveLength(2);

      const [rollEvent, growEvent] = result.events;
      expect(rollEvent.type).toBe("RollPerformed");
      expect(rollEvent.tier).toBe("pass");
      expect(growEvent.type).toBe("SkillGrown");
      expect(growEvent.character).toBe("张三");
      expect(growEvent.skill).toBe("侦查");
      expect(growEvent.before).toBe(70);
      expect(growEvent.after).toBe(76);
    });

    it("掷骰 ≤ 当前值 → 不成长，只产出 RollPerformed", () => {
      const restore = mockRandom([0.5]); // d100=51 ≤ 70
      const result = performSkillGrowth({
        characterName: "张三",
        skillName: "侦查",
        currentValue: 70,
      });
      restore();

      expect(result.grown).toBeFalse();
      expect(result.gain).toBe(0);
      expect(result.after).toBe(70);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe("RollPerformed");
    });

    it("SkillGrown 事件可被 WorldState 正确应用", () => {
      const ws = new WorldState({ id: "test" });
      ws.addCharacter({
        name: "张三",
        skills: { 侦查: 70 },
        inventory: [],
      });

      const restore = mockRandom([0.8, 0.5]);
      const result = performSkillGrowth({
        characterName: "张三",
        skillName: "侦查",
        currentValue: 70,
      });
      restore();

      for (const evt of result.events) {
        ws.applyEvent(evt);
      }

      expect(ws.findCharacter("张三").skills["侦查"]).toBe(result.after);
      expect(ws.findCharacter("张三").skills["侦查"]).toBe(76);
    });
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "skill-growth 单元测试"));

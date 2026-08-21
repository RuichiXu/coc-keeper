/**
 * Character Parser 单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  parseCharacters,
  normalizeCharacter,
  STAT_ALIASES,
} from "../../lib/core/character-parser.js";

describe("Character Parser", () => {
  describe("parseCharacters", () => {
    it("解析行式文本", () => {
      const chars = parseCharacters(
        "姓名：张三\n职业：侦探\n力量：50\n敏捷：60\n侦查：70\n物品：手枪、笔记本"
      );
      expect(chars).toHaveLength(1);
      expect(chars[0].name).toBe("张三");
      expect(chars[0].occupation).toBe("侦探");
      expect(chars[0].stats.STR).toBe(50);
      expect(chars[0].stats.DEX).toBe(60);
      expect(chars[0].skills["侦查"]).toBe(70);
      expect(chars[0].inventory).toContain("手枪");
      expect(chars[0].inventory).toContain("笔记本");
    });

    it("解析 JSON 数组", () => {
      const chars = parseCharacters(
        '[{"name":"李四","occupation":"记者","stats":{"STR":40}}]'
      );
      expect(chars).toHaveLength(1);
      expect(chars[0].name).toBe("李四");
    });

    it("解析 JSON 对象", () => {
      const chars = parseCharacters(
        '{"name":"王五","occupation":"医生"}'
      );
      expect(chars).toHaveLength(1);
      expect(chars[0].name).toBe("王五");
    });

    it("解析多个人物", () => {
      const chars = parseCharacters(
        "姓名：张三\n职业：侦探\n\n姓名：李四\n职业：记者"
      );
      expect(chars).toHaveLength(2);
      expect(chars[0].name).toBe("张三");
      expect(chars[1].name).toBe("李四");
    });

    it("解析属性别名", () => {
      const chars = parseCharacters("姓名：测试\n生命值：12\n理智：60\n灵感：70");
      expect(chars[0].stats.HP).toBe(12);
      expect(chars[0].stats.SAN).toBe(60);
      expect(chars[0].stats.INT).toBe(70);
    });
  });

  describe("normalizeCharacter", () => {
    it("标准化空人物", () => {
      const norm = normalizeCharacter({}, 0);
      expect(norm.name).toMatch(/人物/);
      expect(norm.hp).toBe(0);
      expect(norm.san).toBe(0);
    });
    it("标准化完整人物", () => {
      const raw = {
        name: "张三",
        player: "玩家1",
        occupation: "侦探",
        stats: { STR: 50, CON: 60, SIZ: 55 },
        hp: 11,
        san: 60,
        mp: 12,
        luck: 50,
        skills: { "侦查": 70, "潜行": 40 },
        inventory: ["手枪", "笔记本"],
        notes: "退伍军人",
      };
      const norm = normalizeCharacter(raw, 0);
      expect(norm.name).toBe("张三");
      expect(norm.player).toBe("玩家1");
      expect(norm.occupation).toBe("侦探");
      expect(norm.stats.STR).toBe(50);
      expect(norm.stats.CON).toBe(60);
      expect(norm.hp).toBe(11);
      expect(norm.san).toBe(60);
      expect(norm.skills["侦查"]).toBe(70);
      expect(norm.inventory).toContain("手枪");
    });
    it("生成稳定 ID", () => {
      const norm = normalizeCharacter({ name: "测试" }, 5);
      expect(norm.id).toMatch(/pc-/);
      expect(norm.id).toMatch(/-5$/);
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "character-parser 单元测试"));
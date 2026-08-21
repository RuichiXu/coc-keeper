/**
 * WorldState 单元测试
 */
import { describe, it, expect } from "../runner.js";
import { WorldState } from "../../lib/core/state/world-state.js";

describe("WorldState", () => {
  describe("角色操作", () => {
    it("添加角色", () => {
      const ws = new WorldState();
      ws.addCharacter({ name: "张三", occupation: "侦探", hp: 11, san: 60 });
      expect(ws.findCharacter("张三")).notToBeUndefined();
      expect(ws.findCharacter("张三").hp).toBe(11);
    });
    it("同名角色合并更新", () => {
      const ws = new WorldState();
      ws.addCharacter({ name: "张三", hp: 11 });
      ws.addCharacter({ name: "张三", san: 60 });
      const pc = ws.findCharacter("张三");
      expect(pc.hp).toBe(11);
      expect(pc.san).toBe(60);
    });
    it("更新角色属性", () => {
      const ws = new WorldState();
      ws.addCharacter({ name: "张三", hp: 11, san: 60, stats: { HP: 11, SAN: 60 } });
      ws.updateCharacter("张三", { hp: 8, san: 55 });
      expect(ws.findCharacter("张三").hp).toBe(8);
      expect(ws.findCharacter("张三").san).toBe(55);
      expect(ws.findCharacter("张三").stats.HP).toBe(8);
    });
    it("不存在的角色抛出异常", () => {
      const ws = new WorldState();
      expect(() => ws.updateCharacter("不存在", { hp: 1 })).toThrow("不存在");
    });
    it("物品栏操作", () => {
      const ws = new WorldState();
      ws.addCharacter({ name: "张三", inventory: [] });
      ws.addInventoryItem("张三", "手枪");
      ws.addInventoryItem("张三", "笔记本");
      expect(ws.findCharacter("张三").inventory).toContain("手枪");
      expect(ws.findCharacter("张三").inventory).toContain("笔记本");
      ws.removeInventoryItem("张三", "手枪");
      expect(ws.findCharacter("张三").inventory).notToContain("手枪");
    });
  });

  describe("实体操作", () => {
    it("添加实体", () => {
      const ws = new WorldState();
      const entity = ws.addEntity({ type: "npc", name: "老管家", source: "authored" });
      expect(entity.id).toMatch(/ent-/);
      expect(ws.findEntityByName("老管家")).notToBeUndefined();
    });
    it("重复 ID 抛出异常", () => {
      const ws = new WorldState();
      ws.addEntity({ id: "e1", type: "npc", name: "A" });
      expect(() => ws.addEntity({ id: "e1", type: "npc", name: "B" })).toThrow("已存在");
    });
    it("更新实体", () => {
      const ws = new WorldState();
      ws.addEntity({ id: "e1", type: "npc", name: "老管家", state: "neutral" });
      ws.updateEntity("e1", { state: "friendly" });
      expect(ws.findEntity("e1").state).toBe("friendly");
    });
    it("按类型查找", () => {
      const ws = new WorldState();
      ws.addEntity({ type: "npc", name: "A" });
      ws.addEntity({ type: "npc", name: "B" });
      ws.addEntity({ type: "location", name: "C" });
      expect(ws.findEntitiesByType("npc")).toHaveLength(2);
      expect(ws.findEntitiesByType("location")).toHaveLength(1);
    });
    it("按场景查找", () => {
      const ws = new WorldState();
      ws.setScene("书房");
      ws.addEntity({ type: "npc", name: "A", scene: "书房" });
      ws.addEntity({ type: "npc", name: "B", scene: "门厅" });
      ws.addEntity({ type: "item", name: "C", scene: "" });
      expect(ws.findEntitiesInScene()).toHaveLength(2); // A + C
    });
  });

  describe("Flag 操作", () => {
    it("设置和获取 Flag", () => {
      const ws = new WorldState();
      ws.setFlag("door_unlocked", true);
      ws.setFlag("ritual_progress", 3);
      expect(ws.hasFlag("door_unlocked")).toBeTrue();
      expect(ws.getFlag("ritual_progress")).toBe(3);
      expect(ws.hasFlag("nonexistent")).toBeFalse();
    });
  });

  describe("线索操作", () => {
    it("发现线索", () => {
      const ws = new WorldState();
      ws.discoverClue({ clueId: "clue-1", method: "侦查", character: "张三", isCritical: true });
      expect(ws.isClueDiscovered("clue-1")).toBeTrue();
      expect(ws.isClueDiscovered("clue-2")).toBeFalse();
    });
  });

  describe("关系操作", () => {
    it("设置和获取关系", () => {
      const ws = new WorldState();
      ws.setRelationship("老管家", "张三", "friendly", "帮过忙");
      expect(ws.getRelationship("老管家", "张三")).toBe("friendly");
      ws.setRelationship("老管家", "张三", "hostile");
      expect(ws.getRelationship("老管家", "张三")).toBe("hostile");
    });
  });

  describe("applyEvent", () => {
    it("应用 DamageApplied 事件", () => {
      const ws = new WorldState();
      ws.addCharacter({ name: "张三", hp: 11, san: 60, stats: { HP: 11, SAN: 60 } });
      ws.applyEvent({ type: "DamageApplied", at: new Date().toISOString(), gameId: "test", target: "张三", amount: 5, source: "攻击", hpBefore: 11, hpAfter: 6, isMajorWound: false });
      expect(ws.findCharacter("张三").hp).toBe(6);
    });
    it("应用 SanityLost 事件", () => {
      const ws = new WorldState();
      ws.addCharacter({ name: "张三", hp: 11, san: 60, stats: { HP: 11, SAN: 60 } });
      ws.applyEvent({ type: "SanityLost", at: new Date().toISOString(), gameId: "test", character: "张三", amount: 10, sanBefore: 60, sanAfter: 50, cause: "测试", madnessTriggered: "无" });
      expect(ws.findCharacter("张三").san).toBe(50);
    });
    it("应用 SceneChanged 事件", () => {
      const ws = new WorldState();
      ws.applyEvent({ type: "SceneChanged", at: new Date().toISOString(), gameId: "test", from: "书房", to: "地下室", reason: "打开暗门" });
      expect(ws.currentScene).toBe("地下室");
    });
    it("应用 TimeAdvanced 事件", () => {
      const ws = new WorldState();
      ws.applyEvent({ type: "TimeAdvanced", at: new Date().toISOString(), gameId: "test", from: "下午3点", to: "下午4点", mode: "hour" });
      expect(ws.time).toBe("下午4点");
    });
    it("应用 DamageApplied 到实体", () => {
      const ws = new WorldState();
      ws.addEntity({ type: "npc", name: "深潜者", state: "hp=15" });
      ws.applyEvent({ type: "DamageApplied", at: new Date().toISOString(), gameId: "test", target: "entity:深潜者", amount: 5, source: "攻击", hpBefore: 15, hpAfter: 10, isMajorWound: false });
      expect(ws.findEntityByName("深潜者").state).toBe("hp=10");
    });
  });

  describe("toJSON / fromJSON", () => {
    it("序列化与反序列化", () => {
      const ws = new WorldState({ id: "test", title: "测试" });
      ws.addCharacter({ name: "张三", hp: 11 });
      ws.setFlag("key", "value");
      const json = ws.toJSON();
      const restored = WorldState.fromJSON(json);
      expect(restored.id).toBe("test");
      expect(restored.findCharacter("张三").hp).toBe(11);
      expect(restored.hasFlag("key")).toBeTrue();
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "world-state 单元测试"));
/**
 * C-2 规则补全单元测试：SAN 疯狂/恢复、战斗先攻/伤情/护甲
 */
import { describe, it, expect, mockRandom, run, summarize } from "../runner.js";
import {
  evaluateIndefiniteMadness,
  evaluateTemporaryMadness,
  learnCthulhuMythos,
  recoverSanity,
  rollInitiative,
  evaluateWoundState,
  resolveArmor,
  performCombatRound,
} from "../../lib/core/index.js";

describe("SAN 疯狂与恢复（C-2）", () => {
  it("临时性疯狂：损失≥5 且 INT 失败 → 触发", () => {
    const restore = mockRandom([0.9]); // INT 出目 91
    const result = evaluateTemporaryMadness({ loss: 6, sanAfter: 50, intValue: 70 });
    expect(result.triggered).toBeTrue();
    expect(result.summary).toContain("临时性疯狂");
    restore();
  });

  it("临时性疯狂：损失≥5 但 INT 成功 → 不触发", () => {
    const restore = mockRandom([0.2]); // INT 出目 21
    const result = evaluateTemporaryMadness({ loss: 6, sanAfter: 50, intValue: 70 });
    expect(result.triggered).toBeFalse();
    expect(result.summary).toContain("暂未陷入疯狂");
    restore();
  });

  it("不定性疯狂：24h 累计损失 ≥ 当前 SAN 的 20%", () => {
    expect(evaluateIndefiniteMadness({ loss: 12, currentSan: 50 }).triggered).toBeTrue();
    expect(evaluateIndefiniteMadness({ loss: 8, currentSan: 50 }).triggered).toBeFalse();
    // 本次 6 + 24h 内已累计 5 = 11 ≥ 10
    expect(evaluateIndefiniteMadness({ loss: 6, recentLoss: 5, currentSan: 50 }).triggered).toBeTrue();
  });

  it("学习克苏鲁神话：+1d6 神话技能并 -1d6 SAN", () => {
    const restore = mockRandom([0.5, 0.5]); // 神话 +4，SAN -4
    const result = learnCthulhuMythos({ characterName: "张三", currentSan: 60, currentMythos: 0 });
    expect(result.mythosGain).toBe(4);
    expect(result.mythosAfter).toBe(4);
    expect(result.sanLoss).toBe(4);
    expect(result.sanAfter).toBe(56);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe("SanityLost");
    expect(result.events[1].type).toBe("SkillGrown");
    restore();
  });

  it("理智恢复：精神分析 1d3 / 冒险奖励 1d6+4 / 神话胜利 1d10", () => {
    let restore = mockRandom([0.5]); // 0.5*3=1.5→1 +1 =2
    expect(recoverSanity({ characterName: "张三", currentSan: 50, method: "psychoanalysis" }).recovered).toBe(2);
    restore();
    restore = mockRandom([0.5]); // 0.5*6=3→3 +1+4 =8
    expect(recoverSanity({ characterName: "张三", currentSan: 50, method: "adventure" }).recovered).toBe(8);
    restore();
    restore = mockRandom([0.5]); // 0.5*10=5→5 +1 =6
    expect(recoverSanity({ characterName: "张三", currentSan: 50, method: "mythos-victory" }).recovered).toBe(6);
    restore();
  });
});

describe("战斗先攻与伤情（C-2）", () => {
  it("先攻：成功者按出目升序排在失败者之前", () => {
    // 角色A DEX50 出目 51（成功），角色B DEX50 出目 11（成功），角色C DEX5 出目 91（失败）
    const restore = mockRandom([0.5, 0.1, 0.9]);
    const result = rollInitiative([
      { name: "A", dex: 50 },
      { name: "B", dex: 50 },
      { name: "C", dex: 5 },
    ]);
    restore();
    expect(result.order.map((entry) => entry.name)).toEqual(["B", "A", "C"]);
    expect(result.rolls).toHaveLength(3);
  });

  it("伤情判定：重伤 / 濒死 / 死亡", () => {
    expect(evaluateWoundState({ damage: 5, hpAfter: 5, maxHp: 10 }).majorWound).toBeTrue();
    expect(evaluateWoundState({ damage: 5, hpAfter: 0, maxHp: 10 })).toEqual({
      majorWound: true,
      dying: true,
      dead: false,
      status: "dying",
    });
    expect(evaluateWoundState({ damage: 15, hpAfter: -10, maxHp: 10 }).dead).toBeTrue();
  });

  it("护甲解析：数字直接使用，骰式掷骰", () => {
    expect(resolveArmor(2)).toBe(2);
    expect(resolveArmor("2")).toBe(2);
    const restore = mockRandom([0.5]); // 0.5*10=5 +1 =6
    expect(resolveArmor("1d10")).toBe(6);
    restore();
    expect(resolveArmor("")).toBe(0);
  });

  it("护甲减免：伤害被护甲扣减但至少保留 1 点", () => {
    // 攻击命中（出目 31，对 60 成功），刀 1d6=6，护甲 3 → 实际 3
    const restore = mockRandom([0.3, 0.99]);
    const result = performCombatRound({
      attackerName: "张三",
      defenderName: "深潜者",
      attacker: { skills: { "格斗（剑）": 60 }, stats: { STR: 50, SIZ: 50 } },
      defender: { skills: { "闪避": 40 }, hp: 15, stats: { HP: 15 } },
      weapon: "刀",
      defenderDodge: false,
      defenderIsEntity: true,
      armor: 3,
    });
    restore();
    expect(result.hit).toBeTrue();
    expect(result.damage).toBe(3);
    expect(result.hpAfter).toBe(12);
    const damageEvent = result.events.find((event) => event.type === "DamageApplied");
    expect(damageEvent.amount).toBe(3);
    expect(damageEvent.status).toBe("alive");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "rules-c2 单元测试"));

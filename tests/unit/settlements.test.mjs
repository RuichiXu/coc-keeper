/**
 * 剧本结算点提取与匹配单元测试
 *
 * 覆盖：SC/HP 表达式解析、条件伤害解析、匹配规则（沸核/外出/阀门），
 * 以及《对流》式“SC + 紧邻体质 1/1d4 伤害”的 linkedGate 提取。
 */
import { describe, it, expect } from "../runner.js";
import {
  cjkBigrams,
  extractSettlements,
  parseConditionalDamage,
  parseHpExpressions,
  parseLinkedDamageGate,
  parseScExpressions,
  settlementMatches,
} from "../../lib/core/scenario/settlements.js";

describe("剧本结算点", () => {
  describe("表达式解析", () => {
    it("解析 SC 1/1d6", () => {
      const [entry] = parseScExpressions("踏出遗迹……SC1/1D6");
      expect(entry.sanLoss).toBe("1/1d6");
      expect(typeof entry.index).toBe("number");
    });
    it("解析 SC 1d4/1d10", () => {
      const [entry] = parseScExpressions("直面沸核SC 1d4/1d10。");
      expect(entry.sanLoss).toBe("1d4/1d10");
      expect(typeof entry.index).toBe("number");
    });
    it("解析 HP-1d6", () => {
      const [entry] = parseHpExpressions("房间里的全员HP-1d6。");
      expect(entry.damage).toBe("1d6");
      expect(typeof entry.index).toBe("number");
    });
    it("解析承受 1/1d4 的伤害", () => {
      const entry = parseConditionalDamage("体质检定，随后承受1/1d4的伤害。");
      expect(entry.damage).toBe("1/1d4");
      expect(typeof entry.index).toBe("number");
    });
  });

  describe("匹配规则", () => {
    it("直面沸核 SC：只在观察语境命中，笔记里的沸核不命中", () => {
      const settlement = { id: "set-x", kind: "san", trigger: "直面沸核SC 1d4/1d10", matchRules: { anyOf: ["沸核"], context: ["观察", "直视", "面对", "高台", "白炽", "光球", "观察窗", "面前", "看向", "看"] } };
      expect(settlementMatches(settlement, "先观察高台上翻涌的沸核，判断当前状态")).toBe(true);
      expect(settlementMatches(settlement, "他把高温之物称作沸核")).toBe(false);
    });

    it("外出 SC：识别离开矿洞/外部控制室的行动", () => {
      const settlement = { id: "set-y", kind: "san", trigger: "踏出遗迹，一路离开矿洞……SC1/1D6", matchRules: { anyOf: [], context: ["出去", "离开", "洞口", "矿洞", "外部", "岩台", "夜风", "山脉侧翼", "踏出", "控制室"] } };
      expect(settlementMatches(settlement, "寻找外部控制室并按键发射，带教授一起出去")).toBe(true);
      expect(settlementMatches(settlement, "你们已站到山脉侧翼的一处岩台上")).toBe(true);
    });

    it("阀门 HP 伤害：只在泄压阀蒸汽喷发语境命中", () => {
      const settlement = { id: "set-z", kind: "hp", trigger: "零件分崩离析……房间里的全员HP-1d6", matchRules: { anyOf: ["泄压阀", "圆盘", "转盘", "装置", "房间"], context: ["蒸汽", "热浪", "烟雾", "零件", "崩", "烫", "灼", "扑面", "涌来", "喷"] } };
      expect(settlementMatches(settlement, "泄压阀缝隙红光暴涨，高温蒸汽扑面涌来，烫得你退开")).toBe(true);
      expect(settlementMatches(settlement, "泄压阀正在震颤")).toBe(false);
    });
  });

  describe("提取", () => {
    it("从迷你剧本提取 SC 结算点并挂接紧邻的体质伤害门禁", () => {
      const text = `5.6 房间四
直面沸核SC 1d4/1d10。
5.7 外部控制台完成手操
踏出遗迹，一路离开矿洞……SC1/1D6。
在到达外部控制室前……体质检定，随后承受1/1d4的伤害。`;
      const settlements = extractSettlements(text);
      const sanList = settlements.filter((item) => item.kind === "san");
      expect(sanList.length).toBe(2);
      const outside = sanList.find((item) => item.sanLoss === "1/1d6");
      expect(outside !== undefined).toBe(true);
      expect(outside.linkedGate).toEqual({
        skill: "体质",
        difficulty: "regular",
        action: "在到达外部控制室前……体质检定，随后承受1/1d4的伤害。",
        damage: "1/1d4",
      });
    });

    it("linkedGate 只取紧邻行，且解析困难难度", () => {
      const lines = [
        "某 SC 行 SC1/1D6",
        "体质检定，随后承受1/1d4的伤害。",
        "困难体质检定，随后承受1/1d4的伤害。",
      ];
      expect(parseLinkedDamageGate(lines, 0)).toEqual({
        skill: "体质",
        difficulty: "regular",
        action: "体质检定，随后承受1/1d4的伤害。",
        damage: "1/1d4",
      });
      expect(parseLinkedDamageGate(["SC行", "跳行无伤害", "极难体质检定，随后承受1/1d4的伤害。"], 0)).toEqual({
        skill: "体质",
        difficulty: "extreme",
        action: "极难体质检定，随后承受1/1d4的伤害。",
        damage: "1/1d4",
      });
    });

    it("cjkBigrams 提取去重二字组", () => {
      expect(cjkBigrams("沸核")).toEqual(["沸核"]);
      expect(cjkBigrams("泄压阀")).toContain("泄压");
      expect(cjkBigrams("泄压阀")).toContain("压阀");
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "settlements 单元测试"));

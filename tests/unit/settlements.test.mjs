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
  resolveSettlementScene,
  sceneTokensFor,
  settlementMatches,
  splitSentences,
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

  describe("r3 误触发回归", () => {
    it("set-4 外出结算：选项里的“矿洞”不触发，前往外部控制室才触发", () => {
      const settlement = { id: "set-4", kind: "san", scene: "外部控制室", trigger: "踏出遗迹，一路离开矿洞……SC1/1D6", sanLoss: "1/1d6", matchRules: { anyOf: ["踏出遗迹", "离开矿洞", "来到洞口", "走出", "出去", "前往", "到达", "来到", "站到", "岩台", "山脉侧翼", "夜风"], context: ["外部控制室", "洞口", "矿洞", "岩台", "山脉侧翼", "夜风", "出去"] } };
      expect(settlementMatches(settlement, "先观察镇口周边环境（如山坡、矿洞方向）", "极光镇·镇口")).toBe(false);
      expect(settlementMatches(settlement, "寻找外部控制室并按键发射，带上教授一起出去", "遗迹")).toBe(true);
    });

    it("set-4 外出结算：读地图/计划里提到外部控制室不触发（r4 第 52 轮）", () => {
      const settlement = { id: "set-4", kind: "san", scene: "外部控制室", trigger: "踏出遗迹，一路离开矿洞……SC1/1D6", sanLoss: "1/1d6", matchRules: { anyOf: ["踏出遗迹", "离开矿洞", "来到洞口", "走出", "出去", "前往", "到达", "来到", "站到", "岩台", "山脉侧翼", "夜风"], context: ["外部控制室", "洞口", "矿洞", "岩台", "山脉侧翼", "夜风", "出去"] } };
      expect(settlementMatches(settlement, "教授说：外部控制室……标注在这儿了。", "房间5：档案馆")).toBe(false);
    });

    it("set-3 直面沸核：读便条里的沸核不触发，观察高台上的沸核才触发", () => {
      const settlement = { id: "set-3", kind: "san", scene: "房间4：静滞力场控制室", trigger: "直面沸核SC 1d4/1d10。", sanLoss: "1d4/1d10", matchRules: { anyOf: ["沸核"], context: ["观察窗", "直视", "面对", "高台", "白炽", "光球", "直面", "看向", "观察", "看"] } };
      expect(settlementMatches(settlement, "我捡起落地的纸翻看工整的字迹，并检查桌子抽屉是否有地图或教授留下的简短便条。你捡起纸，上面写着：皆源自山中之物，我称之为沸核。", "矿洞")).toBe(false);
      expect(settlementMatches(settlement, "先观察高台上翻涌的沸核，判断当前状态", "房间4：静滞力场控制室")).toBe(true);
    });

    it("set-2 阀门事故：靠近热源不触发，泄压阀蒸汽喷发才触发", () => {
      const settlement = { id: "set-2", kind: "hp", scene: "房间2：泄压阀控制室", trigger: "（转动圆盘）……零件分崩离析……房间里的全员HP-1d6。", damage: "1d6", matchRules: { anyOf: ["泄压阀", "圆盘", "转盘", "分崩离析", "零件", "蒸汽", "烟雾", "充斥"], context: ["蒸汽", "热浪", "烟雾", "零件", "崩", "烫", "灼", "扑面", "涌来", "喷", "充斥"] } };
      expect(settlementMatches(settlement, "你一靠近，那灼人的热浪便扑面而来。", "矿洞-凉爽侧向岔道")).toBe(false);
      expect(settlementMatches(settlement, "泄压阀缝隙红光暴涨，高温蒸汽扑面涌来，烫得你退开。", "房间2：泄压阀控制室")).toBe(true);
    });

    it("sceneTokensFor 提取有区分度的场景词", () => {
      expect(sceneTokensFor("房间2：泄压阀控制室")).toContain("泄压阀控制室");
      expect(sceneTokensFor("房间2：泄压阀控制室")).toContain("房间2");
      expect(sceneTokensFor("外部控制室")).toContain("外部控制");
      expect(sceneTokensFor("守秘人信息")).toEqual([]);
    });

    it("splitSentences 只按句末标点切分", () => {
      expect(splitSentences("泄压阀缝隙红光暴涨，高温蒸汽扑面而来。")).toEqual(["泄压阀缝隙红光暴涨，高温蒸汽扑面而来"]);
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

    it("resolveSettlementScene 从最近的房间标记确定归属", () => {
      const lines = [
        "考虑要求图书馆",
        "房间2：泄压阀控制室这个房间与其他规模相仿",
        "（转动圆盘）……房间里的全员HP-1d6。",
      ];
      expect(resolveSettlementScene(lines, 2, "考虑要求图书馆")).toBe("房间2：泄压阀控制室");
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

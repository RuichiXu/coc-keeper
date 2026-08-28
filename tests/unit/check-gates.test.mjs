/**
 * 检定门禁（check gates）纯函数单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  checkKey,
  gateTargetKey,
  matchActionToGates,
  mergeCheckGates,
  normalizeAction,
  resolvePendingChoice,
  scoreActionMatch,
  scoreTargetMatch,
} from "../../lib/shared/chat/index.js";

describe("检定门禁", () => {
  it("checkKey 按技能·难度·动作生成唯一键", () => {
    expect(checkKey({ skill: "侦查", difficulty: "hard", action: "搜索书房" })).toBe("侦查·hard·搜索书房");
    expect(checkKey({ skill: "侦查", action: "搜索书房" })).toBe("侦查·regular·搜索书房");
    expect(checkKey({ skill: "侦查" })).toBe("侦查·regular·");
  });

  it("normalizeAction 去掉列表符号与语气前缀", () => {
    expect(normalizeAction("- 翻出窗外，沿窄檐攀向屋顶小门")).toBe("翻出窗外，沿窄檐攀向屋顶小门");
    expect(normalizeAction("我打算翻出窗外")).toBe("翻出窗外");
  });

  it("scoreActionMatch 精确/包含匹配", () => {
    const action = "翻出窗外，沿窄檐攀向屋顶小门";
    expect(scoreActionMatch("翻出窗外，沿窄檐攀向屋顶小门", action)).toBe(100);
    expect(scoreActionMatch("翻出窗外", action)).toBe(90);
    expect(scoreActionMatch("先不开，我回客厅", action)).toBe(0);
  });

  it("scoreActionMatch 关键词重叠兜底", () => {
    const action = "翻出窗外，沿窄檐攀向屋顶小门";
    expect(scoreActionMatch("我翻出窗外爬向屋顶小门", action)).toBeGreaterThan(0);
    expect(scoreActionMatch("敲门试试", action)).toBe(0);
  });

  it("matchActionToGates 只返回命中门禁", () => {
    const gates = [
      { skill: "攀爬", difficulty: "regular", action: "翻出窗外，沿窄檐攀向屋顶小门" },
      { skill: "侦查", difficulty: "regular", action: "搜索书房" },
    ];
    const matched = matchActionToGates("我翻出窗外，沿窄檐攀向屋顶小门", gates);
    expect(matched.length).toBe(1);
    expect(matched[0].skill).toBe("攀爬");
  });

  it("mergeCheckGates 去重", () => {
    const existing = [{ skill: "侦查", difficulty: "regular", action: "搜索书房" }];
    const merged = mergeCheckGates(existing, [
      { skill: "侦查", difficulty: "regular", action: "搜索书房" },
      { skill: "攀爬", difficulty: "regular", action: "翻出窗外" },
    ]);
    expect(merged.length).toBe(2);
  });

  it("gateTargetKey 把同目标换措辞归一（v9 门厅案例）", () => {
    expect(gateTargetKey("查看一层门厅地板与墙脚")).toBe(gateTargetKey("我检查一层门厅地面和墙角"));
    expect(gateTargetKey("查看一层门厅地板与墙脚")).toBe("一层门厅地面墙角");
  });

  it("scoreTargetMatch 目标键匹配高于原文匹配", () => {
    const targetA = gateTargetKey("查看一层门厅地板与墙脚");
    const targetB = gateTargetKey("我检查一层门厅地面和墙角");
    expect(scoreTargetMatch(targetA, targetB)).toBeGreaterThan(0);
    expect(scoreTargetMatch(targetA, "屋顶小门")).toBe(0);
  });

  it("matchActionToGates 同目标换措辞也能命中旧门禁", () => {
    const gates = [{ skill: "侦查", difficulty: "regular", action: "查看一层门厅地板与墙脚" }];
    const matched = matchActionToGates("我检查一层门厅地面和墙角", gates);
    expect(matched.length).toBe(1);
    expect(matched[0].skill).toBe("侦查");
  });

  it("mergeCheckGates 同目标换措辞保留一条并更新动作文本", () => {
    const merged = mergeCheckGates(
      [{ skill: "侦查", difficulty: "regular", action: "查看一层门厅地板与墙脚" }],
      [{ skill: "侦查", difficulty: "hard", action: "我检查一层门厅地面和墙角" }]
    );
    expect(merged.length).toBe(1);
    expect(merged[0].action).toBe("我检查一层门厅地面和墙角");
    expect(merged[0].difficulty).toBe("hard");
  });

  it("mergeCheckGates 同目标合并时保留 checkpointId", () => {
    const merged = mergeCheckGates(
      [{ skill: "侦查", difficulty: "regular", action: "查看一层门厅地板" }],
      [{ skill: "侦查", difficulty: "regular", action: "检查一层门厅地面", checkpointId: "chk-1" }]
    );
    expect(merged.length).toBe(1);
    expect(merged[0].checkpointId).toBe("chk-1");
  });

  it("resolvePendingChoice 支持编号与动作文本", () => {
    const choice = { skill: "攀爬", candidates: ["翻出窗外，沿窄檐攀向屋顶小门", "顺排水管爬上屋顶"] };
    expect(resolvePendingChoice("1", choice)).toBe("翻出窗外，沿窄檐攀向屋顶小门");
    expect(resolvePendingChoice("2", choice)).toBe("顺排水管爬上屋顶");
    expect(resolvePendingChoice("顺排水管爬上屋顶", choice)).toBe("顺排水管爬上屋顶");
    expect(resolvePendingChoice("我不做了", choice)).toBeNull();
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "check-gates 单元测试"));

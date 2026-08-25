/**
 * 检定门禁（check gates）纯函数单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  checkKey,
  matchActionToGates,
  mergeCheckGates,
  normalizeAction,
  resolvePendingChoice,
  scoreActionMatch,
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

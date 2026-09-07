/**
 * 结算点语义裁决器单元测试
 *
 * 覆盖：prompt 构造、宽容 JSON 解析、verdict 归一化、候选上限。
 */
import { describe, it, expect } from "../runner.js";
import {
  buildSettlementJudgePrompt,
  buildSettlementJudgeSystem,
  normalizeSettlementVerdicts,
  parseSettlementJudgeOutput,
  SETTLEMENT_JUDGE_MAX_CANDIDATES,
} from "../../lib/shared/chat/settlement-judge.js";

describe("结算点语义裁决器", () => {
  it("构建裁决输入包含结算点、玩家输入、叙述与当前场景", () => {
    const prompt = buildSettlementJudgePrompt({
      settlements: [{ id: "set-2", kind: "hp", scene: "房间2：泄压阀控制室", trigger: "零件分崩离析……HP-1d6", damage: "1d6" }],
      playerText: "我转动圆盘",
      narration: "泄压阀崩裂，蒸汽涌出",
      currentScene: "房间2：泄压阀控制室",
      pcName: "林晚",
    });
    expect(prompt.includes("set-2")).toBe(true);
    expect(prompt.includes("泄压阀崩裂")).toBe(true);
    expect(prompt.includes("林晚")).toBe(true);
    expect(prompt.includes("房间2：泄压阀控制室")).toBe(true);
    expect(prompt.includes("verdicts")).toBe(true);
  });

  it("系统提示要求只输出 JSON 并区分计划与已发生", () => {
    const system = buildSettlementJudgeSystem();
    expect(system.includes("已经真实发生")).toBe(true);
    expect(system.includes("计划、讨论、阅读、提问、回忆")).toBe(true);
    expect(system.includes("JSON")).toBe(true);
  });

  it("解析纯 JSON 输出", () => {
    const parsed = parseSettlementJudgeOutput('{"verdicts":[{"id":"set-2","happened":true,"subject":"pc","confidence":0.9,"evidence":"泄压阀崩裂"}]}');
    expect(parsed !== null).toBe(true);
    expect(parsed.verdicts[0].id).toBe("set-2");
    expect(parsed.verdicts[0].happened).toBe(true);
  });

  it("解析带围栏与前后缀的输出", () => {
    const text = '好的，判定如下：\n```json\n{"verdicts":[{"id":"set-4","happened":false,"subject":"none","confidence":0.95,"evidence":"把沸核发射出去"}]}\n```';
    const parsed = parseSettlementJudgeOutput(text);
    expect(parsed !== null).toBe(true);
    expect(parsed.verdicts[0].happened).toBe(false);
  });

  it("非法输出返回 null", () => {
    expect(parseSettlementJudgeOutput("抱歉我无法判断")).toBe(null);
  });

  it("归一化补齐缺失 verdict 的候选为未发生", () => {
    const candidates = [{ id: "set-2" }, { id: "set-3" }];
    const parsed = { verdicts: [{ id: "set-2", happened: true, subject: "pc", confidence: 0.8, evidence: "蒸汽涌出" }] };
    const verdicts = normalizeSettlementVerdicts(parsed, candidates);
    expect(verdicts.get("set-2").happened).toBe(true);
    expect(verdicts.get("set-3").happened).toBe(false);
    expect(verdicts.get("set-3").subject).toBe("none");
  });

  it("候选上限为 12（控制单次调用成本）", () => {
    expect(SETTLEMENT_JUDGE_MAX_CANDIDATES).toBe(12);
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "settlement-judge 单元测试"));

/**
 * 结算点语义裁决器单元测试
 *
 * 覆盖：prompt 构造、宽容 JSON 解析、verdict 归一化、候选上限、
 * 以及一次带 mock fetch 的 judgeSettlements 通路（r6 在 HTTP 前失败的回归）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "../runner.js";
import {
  buildSettlementJudgeMessages,
  buildSettlementJudgePrompt,
  buildSettlementJudgeSystem,
  judgeSettlements,
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

  it("消息必须是块式 content（修复 r6 judge 在 HTTP 前失败）", () => {
    const messages = buildSettlementJudgeMessages("判定文本");
    expect(Array.isArray(messages)).toBe(true);
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content[0].type).toBe("text");
    expect(messages[0].content[0].text).toBe("判定文本");
  });

  it("judgeSettlements 通过 mock fetch 走完整通路", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-judge-test-"));
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.COC_API_KEY;
    const previousBase = process.env.COC_LLM_BASE_URL;
    process.env.COC_API_KEY = "test-key";
    process.env.COC_LLM_BASE_URL = "http://judge.invalid/v1/chat/completions";
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: '{"verdicts":[{"id":"set-2","happened":true,"subject":"pc","confidence":0.9,"evidence":"泄压阀崩裂"}]}' },
          finish_reason: "stop",
        }],
        usage: {},
      }),
    });
    try {
      const result = await judgeSettlements(
        { dataDir },
        {
          settlements: [{ id: "set-2", kind: "hp", scene: "房间2", trigger: "泄压阀崩裂 HP-1d6", damage: "1d6" }],
          playerText: "我转动圆盘",
          narration: "泄压阀崩裂，蒸汽涌出",
          currentScene: "房间2",
          pcName: "林晚",
        },
      );
      expect(result.ok).toBe(true);
      expect(result.verdicts.get("set-2").happened).toBe(true);
      expect(result.verdicts.get("set-2").subject).toBe("pc");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.COC_API_KEY; else process.env.COC_API_KEY = previousKey;
      if (previousBase === undefined) delete process.env.COC_LLM_BASE_URL; else process.env.COC_LLM_BASE_URL = previousBase;
    }
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "settlement-judge 单元测试"));

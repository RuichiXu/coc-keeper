/**
 * 结局语义裁决器单元测试
 *
 * 覆盖：prompt 构造、宽容 JSON 解析、块式消息、mock fetch 全通路。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "../runner.js";
import {
  buildEndingJudgeMessages,
  buildEndingJudgePrompt,
  buildEndingJudgeSystem,
  judgeEndingReached,
  parseEndingJudgeOutput,
} from "../../lib/shared/chat/ending-judge.js";

describe("结局语义裁决器", () => {
  const finalBranch = {
    title: "最终抉择：应对沸核与寒星",
    chosen: "寻找外部控制室并按键发射",
    options: [
      { label: "寻找外部控制室并按键发射", leadsTo: "外部控制台完成手操" },
    ],
  };

  it("构建裁决输入包含已选分支与结局", () => {
    const prompt = buildEndingJudgePrompt({
      finalBranch,
      playerText: "就此画下句点，结束本次跑团",
      narration: "幕落。极光镇迎来了平静的黎明。",
      currentScene: "外部控制室",
      pcName: "林晚",
    });
    expect(prompt.includes("寻找外部控制室并按键发射")).toBe(true);
    expect(prompt.includes("外部控制台完成手操")).toBe(true);
    expect(prompt.includes("就此画下句点")).toBe(true);
    expect(prompt.includes("ended")).toBe(true);
  });

  it("系统提示要求只输出 JSON 并区分过程与结局", () => {
    const system = buildEndingJudgeSystem();
    expect(system.includes("已经实际描述")).toBe(true);
    expect(system.includes("讨论、计划")).toBe(true);
    expect(system.includes("JSON")).toBe(true);
  });

  it("解析纯 JSON 输出", () => {
    expect(parseEndingJudgeOutput('{"ended":true,"confidence":0.9,"evidence":"幕落"}').ended).toBe(true);
    expect(parseEndingJudgeOutput('{"ended":false}').ended).toBe(false);
  });

  it("非法输出返回 null", () => {
    expect(parseEndingJudgeOutput("无法判断")).toBe(null);
  });

  it("消息必须是块式 content", () => {
    const messages = buildEndingJudgeMessages("判定文本");
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content[0].type).toBe("text");
    expect(messages[0].content[0].text).toBe("判定文本");
  });

  it("judgeEndingReached 通过 mock fetch 走完整通路", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-ending-judge-test-"));
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.COC_API_KEY;
    const previousBase = process.env.COC_LLM_BASE_URL;
    process.env.COC_API_KEY = "test-key";
    process.env.COC_LLM_BASE_URL = "http://ending-judge.invalid/v1/chat/completions";
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: '{"ended":true,"confidence":0.95,"evidence":"幕落"}' },
          finish_reason: "stop",
        }],
        usage: {},
      }),
    });
    try {
      const result = await judgeEndingReached(
        { dataDir },
        { finalBranch, playerText: "结束行动", narration: "幕落。", currentScene: "外部控制室", pcName: "林晚" },
      );
      expect(result.ok).toBe(true);
      expect(result.ended).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.COC_API_KEY; else process.env.COC_API_KEY = previousKey;
      if (previousBase === undefined) delete process.env.COC_LLM_BASE_URL; else process.env.COC_LLM_BASE_URL = previousBase;
    }
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "ending-judge 单元测试"));

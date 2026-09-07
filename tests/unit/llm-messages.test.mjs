/**
 * 公共 LLM 消息转换单元测试
 *
 * 覆盖：块式 content 转换、字符串 content 兼容（r6 judge 在 HTTP 前失败根因）。
 */
import { describe, it, expect } from "../runner.js";
import { toOpenAiMessages } from "../../lib/shared/llm.js";

describe("公共 LLM 消息转换", () => {
  it("转换块式用户消息", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "你好" }] }];
    const out = toOpenAiMessages(messages, "");
    expect(out.length).toBe(1);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toBe("你好");
  });

  it("兼容字符串 content（不再抛 .find is not a function）", () => {
    const messages = [{ role: "user", content: "你好" }];
    const out = toOpenAiMessages(messages, "");
    expect(out.length).toBe(1);
    expect(out[0].content).toBe("你好");
  });

  it("系统提示写入 system 角色", () => {
    const out = toOpenAiMessages([{ role: "user", content: [{ type: "text", text: "x" }] }], "系统提示");
    expect(out[0].role).toBe("system");
    expect(out[0].content).toBe("系统提示");
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "llm-messages 单元测试"));

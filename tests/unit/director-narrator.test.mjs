/**
 * Director / Narrator 单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  parseAssistantBlocks,
  decideNext,
  buildToolResultMessages,
  parseToolArguments,
  buildAssistantContent,
  formatNarration,
  clampNarration,
  makeKpLogEntry,
  makeUserLogEntry,
} from "../../lib/core/index.js";

describe("Director", () => {
  it("parseAssistantBlocks 分离文本与工具调用", () => {
    const blocks = [
      { type: "text", text: "我先看看" },
      { type: "tool-call", id: "c1", name: "coc_roll", arguments: "{}" },
      { type: "text", text: "然后行动" },
    ];
    const { textBlocks, calls } = parseAssistantBlocks(blocks);
    expect(textBlocks).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("coc_roll");
  });

  it("decideNext 无工具调用时返回 narrate", () => {
    const decision = decideNext([{ type: "text", text: " 你推开大门。 " }]);
    expect(decision.kind).toBe("narrate");
    expect(decision.text).toBe("你推开大门。");
  });

  it("decideNext 有工具调用时返回 tools", () => {
    const decision = decideNext([
      { type: "tool-call", id: "c1", name: "coc_roll", arguments: "{}" },
    ]);
    expect(decision.kind).toBe("tools");
    expect(decision.calls).toHaveLength(1);
  });

  it("buildToolResultMessages 组装 isError 标记", () => {
    const calls = [{ id: "c1", name: "coc_roll", arguments: "{}" }];
    const messages = buildToolResultMessages(calls, [{ ok: false, text: "错误：未找到人物" }]);
    expect(messages).toHaveLength(1);
    expect(messages[0].content[0].toolCallId).toBe("c1");
    expect(messages[0].content[0].isError).toBeTrue();
  });

  it("parseToolArguments 容错", () => {
    expect(parseToolArguments('{"expression":"d100"}').expression).toBe("d100");
    expect(parseToolArguments("not json").expression).toBeUndefined();
  });

  it("buildAssistantContent 输出文本与工具调用块", () => {
    const content = buildAssistantContent(
      [{ type: "text", text: "好" }],
      [{ id: "c1", name: "coc_roll", arguments: "{}" }]
    );
    expect(content).toHaveLength(2);
    expect(content[1].type).toBe("tool-call");
    expect(content[1].name).toBe("coc_roll");
  });
});

describe("Narrator", () => {
  it("formatNarration 正常文本原样返回", () => {
    expect(formatNarration(" 你推开门。 ")).toBe("你推开门。");
  });

  it("formatNarration 空文本用兜底", () => {
    expect(formatNarration("", null)).toBe("（本轮未产生叙述，请再说一次你的行动）");
  });

  it("formatNarration finish.error 输出失败信息", () => {
    expect(formatNarration("", { kind: "error", failure: { message: "超时" } })).toBe("（模型调用失败：超时）");
  });

  it("clampNarration 截断过长文本", () => {
    expect(clampNarration("a".repeat(5000), 100)).toHaveLength(101); // 100 + …
  });

  it("makeKpLogEntry / makeUserLogEntry 结构正确", () => {
    const kp = makeKpLogEntry(1, "2025-01-01T00:00:00Z", "叙述");
    expect(kp.kind).toBe("kp");
    expect(kp.seq).toBe(1);
    const user = makeUserLogEntry(2, "2025-01-01T00:00:00Z", "行动", "张三");
    expect(user.kind).toBe("user");
    expect(user.player).toBe("张三");
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "director-narrator 单元测试"));

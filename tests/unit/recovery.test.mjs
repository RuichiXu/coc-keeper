/**
 * Narrative Recovery 单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  isBusyStale,
  buildRecoveryPrompt,
  hasMissingNarration,
  summarizeToolTrace,
} from "../../lib/core/index.js";

describe("Narrative Recovery", () => {
  it("isBusyStale 检测过期 busy", () => {
    expect(isBusyStale({ busy: true, updatedAt: "2025-01-01T00:00:00Z" }, "2025-01-01T00:10:00Z")).toBeTrue();
    expect(isBusyStale({ busy: true, updatedAt: "2025-01-01T00:09:00Z" }, "2025-01-01T00:10:00Z")).toBeFalse();
    expect(isBusyStale({ busy: false, updatedAt: "2025-01-01T00:00:00Z" }, "2025-01-01T00:10:00Z")).toBeFalse();
  });

  it("buildRecoveryPrompt 基于最后 user 日志续写", () => {
    const state = {
      log: [
        { seq: 1, kind: "user", player: "张三", text: "我推开门" },
        { seq: 2, kind: "kp", player: "", text: "门吱呀打开。" },
        { seq: 3, kind: "user", player: "张三", text: "我走进去" },
      ],
    };
    const prompt = buildRecoveryPrompt(state);
    expect(prompt).toContain("张三：我走进去");
    expect(prompt).toContain("系统恢复");
  });

  it("buildRecoveryPrompt 无中断时返回通用提示", () => {
    const prompt = buildRecoveryPrompt({ log: [{ seq: 1, kind: "kp", text: "好" }] });
    expect(prompt).toContain("系统恢复");
  });

  it("hasMissingNarration 最后一条是 user 则 true", () => {
    expect(hasMissingNarration({ log: [{ kind: "user", text: "行动" }] })).toBeTrue();
    expect(hasMissingNarration({ log: [{ kind: "kp", text: "叙述" }] })).toBeFalse();
    expect(hasMissingNarration({ log: [] })).toBeFalse();
  });

  it("summarizeToolTrace 输出最近工具摘要", () => {
    const trace = [
      { tool: "coc_roll", ok: true, text: "d100=30 成功" },
      { tool: "coc_pc", ok: false, text: "未找到人物" },
    ];
    const lines = summarizeToolTrace(trace, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("失败");
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "recovery 单元测试"));

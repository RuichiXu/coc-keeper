/**
 * 叙述状态数值声明守卫单元测试
 *
 * 覆盖：查找 HP/SAN 数值声明、删除括号式状态声明（r7 房间2 HP -3 不一致）。
 */
import { describe, it, expect } from "../runner.js";
import { findPcStateClaim, stripPcStateClaims } from "../../lib/shared/chat/chat-bridge.js";

describe("叙述状态数值声明守卫", () => {
  it("识别 HP/SAN 数值声明", () => {
    expect(findPcStateClaim("（林晚 HP -3）房间2因你方才的试探，已暂时无法进入。")).toBe("HP -3");
    expect(findPcStateClaim("你感到 SAN -1 的冲击")).toBe("SAN -1");
    expect(findPcStateClaim("你只是有些疲惫")).toBe(null);
  });

  it("删除括号式 HP/SAN 声明，保留括号外正文", () => {
    const text = "（林晚 HP -3）房间2因你方才的试探，已暂时无法进入。";
    const stripped = stripPcStateClaims(text);
    expect(stripped.includes("HP -3")).toBe(false);
    expect(stripped.includes("房间2因你方才的试探")).toBe(true);
  });

  it("不误删普通括号内容", () => {
    const text = "你听见（或许只是风）低语";
    expect(stripPcStateClaims(text)).toBe(text);
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "narration-state-claim 单元测试"));

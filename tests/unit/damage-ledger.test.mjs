/**
 * HP 扣损账本单元测试
 *
 * 覆盖：记录损失、窗口期内等额损失查找、窗口过期后放行。
 */
import { describe, it, expect } from "../runner.js";
import { findRecentHpLoss, recordHpLoss } from "../../lib/shared/chat/damage-ledger.js";

describe("HP 扣损账本", () => {
  it("记录并找到窗口期内的等额损失", () => {
    const flat = {};
    recordHpLoss(flat, "林晚", 1, "settlement:set-4");
    expect(flat.hpLossLedger.length).toBe(1);
    const recent = findRecentHpLoss(flat, "林晚", 1);
    expect(recent !== null).toBe(true);
    expect(recent.source).toBe("settlement:set-4");
  });

  it("不同角色/不同金额不匹配", () => {
    const flat = {};
    recordHpLoss(flat, "林晚", 1, "settlement:set-4");
    expect(findRecentHpLoss(flat, "张三", 1)).toBeNull();
    expect(findRecentHpLoss(flat, "林晚", 2)).toBeNull();
  });

  it("超出窗口期后放行", () => {
    const flat = {};
    recordHpLoss(flat, "林晚", 1, "settlement:set-4");
    const old = flat.hpLossLedger[0];
    old.at = new Date(Date.now() - 121000).toISOString();
    expect(findRecentHpLoss(flat, "林晚", 1)).toBeNull();
  });

  it("账本上限 40 条", () => {
    const flat = {};
    for (let i = 0; i < 45; i += 1) recordHpLoss(flat, "林晚", 1, `test:${i}`);
    expect(flat.hpLossLedger.length).toBe(40);
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "damage-ledger 单元测试"));

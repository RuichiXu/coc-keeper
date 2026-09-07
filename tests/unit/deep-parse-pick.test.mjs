/**
 * pickBetterDeepParse：资产/场次同步时的深度解析择优。
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import { pickBetterDeepParse } from "../../lib/core/index.js";

function dpWithCategories(high = 0, medium = 0, low = 0, generatedAt = "2026-09-06T10:00:00.000Z") {
  return {
    status: "draft",
    source: "llm",
    generatedAt,
    quality: {
      preflightHigh: high,
      preflightMedium: medium,
      preflightLow: low,
      ruleHigh: 0,
      ruleMedium: 0,
      ruleLow: 0,
      reviewHigh: 0,
      reviewMedium: 0,
      reviewLow: 0,
      chunkHigh: 0,
      chunkMedium: 0,
      chunkLow: 0,
    },
  };
}

describe("pickBetterDeepParse", () => {
  it("空值处理：一方为空返回另一方，都为空返回 null", () => {
    const dp = dpWithCategories();
    expect(pickBetterDeepParse(null, null)).toBeNull();
    expect(pickBetterDeepParse(null, dp)).toBe(dp);
    expect(pickBetterDeepParse(dp, null)).toBe(dp);
    expect(pickBetterDeepParse(undefined, dp)).toBe(dp);
  });

  it("门禁计数更优者胜出（坏资产不会覆盖好场次）", () => {
    const good = dpWithCategories(0, 0, 0);
    const bad = dpWithCategories(2, 3, 0);
    expect(pickBetterDeepParse(bad, good)).toBe(good);
    expect(pickBetterDeepParse(good, bad)).toBe(good);
  });

  it("high 优先于 medium 比较", () => {
    const highButFewMedium = dpWithCategories(1, 0, 0);
    const noHighButManyMedium = dpWithCategories(0, 99, 0);
    expect(pickBetterDeepParse(highButFewMedium, noHighButManyMedium)).toBe(noHighButManyMedium);
  });

  it("没有分类计数时回退到 quality.high/medium/low", () => {
    const withCategories = dpWithCategories(0, 1, 0);
    const overallOnly = {
      status: "draft",
      generatedAt: "2026-09-06T10:00:00.000Z",
      quality: { high: 0, medium: 5, low: 0, pass: false },
    };
    expect(pickBetterDeepParse(overallOnly, withCategories)).toBe(withCategories);
    expect(pickBetterDeepParse(withCategories, overallOnly)).toBe(withCategories);
  });

  it("缺少 quality 视为最差", () => {
    const withQuality = dpWithCategories(0, 0, 0);
    const noQuality = { status: "draft", generatedAt: "2026-09-07T10:00:00.000Z" };
    expect(pickBetterDeepParse(noQuality, withQuality)).toBe(withQuality);
    expect(pickBetterDeepParse(withQuality, noQuality)).toBe(withQuality);
  });

  it("门禁平手时 generatedAt 更新者胜出", () => {
    const older = dpWithCategories(0, 0, 0, "2026-09-05T10:00:00.000Z");
    const newer = dpWithCategories(0, 0, 0, "2026-09-06T10:00:00.000Z");
    expect(pickBetterDeepParse(older, newer)).toBe(newer);
    expect(pickBetterDeepParse(newer, older)).toBe(newer);
  });
});

const result = await run();
summarize(result);

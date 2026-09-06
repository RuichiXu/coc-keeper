/**
 * 咒文文本提取单元测试
 *
 * 验证共享代码不再硬编码《墨渊》咒文：咒文四组词从剧本原文/关键点字段提取，
 * 提取不到时不注入任何文本，倒序展示为纯数据行为。
 */
import { describe, it, expect } from "../runner.js";
import {
  buildSpellRecognition,
  extractSpellGroups,
  findSpellKeyPointIn,
  formatSpellDisplay,
  parseSpellGroups,
} from "../../lib/shared/chat/spell-text.js";

describe("咒文文本提取", () => {
  it("从剧本原文中提取三字一组、四组的咒文", () => {
    const flat = {
      scenario: { text: "你看到祭坛上刻着：启墨渊、引魂夜、临神名、归字主。" },
    };
    const spell = extractSpellGroups(flat);
    expect(spell.groups).toEqual(["启墨渊", "引魂夜", "临神名", "归字主"]);
    expect(spell.source).toBe("scenario");
  });

  it("关键点 spellGroups 字段优先于剧本原文", () => {
    const flat = {
      keyPoints: [{ id: "kp-spell", title: "拼凑十二字咒文", spellGroups: ["甲甲甲", "乙乙乙", "丙丙丙", "丁丁丁"] }],
      scenario: { text: "启墨渊、引魂夜、临神名、归字主" },
    };
    expect(extractSpellGroups(flat).groups).toEqual(["甲甲甲", "乙乙乙", "丙丙丙", "丁丁丁"]);
  });

  it("剧本没有咒文时返回 null，不注入任何固定文本", () => {
    expect(extractSpellGroups({ scenario: { text: "这是对流剧本，没有十二字咒文。" } })).toBeNull();
    expect(extractSpellGroups({})).toBeNull();
  });

  it("识别玩家正向/逆向念诵", () => {
    const recognition = buildSpellRecognition(["启墨渊", "引魂夜", "临神名", "归字主"]);
    expect(recognition.forward.test("我念：启墨渊、引魂夜、临神名、归字主")).toBe(true);
    expect(recognition.inverse.test("归字主、临神名、引魂夜、启墨渊")).toBe(true);
    expect(recognition.forward.test("我随便说了四个词")).toBe(false);
  });

  it("展示行只陈述咒文与倒序", () => {
    const line = formatSpellDisplay(["启墨渊", "引魂夜", "临神名", "归字主"]);
    expect(line).toContain("启墨渊、引魂夜、临神名、归字主");
    expect(line).toContain("归字主、临神名、引魂夜、启墨渊");
  });

  it("parseSpellGroups 支持顿号/逗号分隔", () => {
    expect(parseSpellGroups("甲甲甲，乙乙乙，丙丙丙，丁丁丁")).toEqual(["甲甲甲", "乙乙乙", "丙丙丙", "丁丁丁"]);
    expect(parseSpellGroups("没有咒文")).toBeNull();
  });

  it("findSpellKeyPointIn 只按标题找咒文关键点", () => {
    const flat = { keyPoints: [{ id: "kp-1", title: "发现日记与手稿" }, { id: "kp-2", title: "拼凑十二字咒文" }] };
    expect(findSpellKeyPointIn(flat).id).toBe("kp-2");
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "spell-text 单元测试"));

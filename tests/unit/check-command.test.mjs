/**
 * 团检指令解析与判定词守卫单元测试
 */
import { describe, it, expect, mockRandom, randomForDice } from "../runner.js";
import {
  containsResultPhrase,
  formatCheckLine,
  formatRaResultLine,
  parseCheckRequests,
  parseRaCommand,
  parseSkillDifficulty,
  performRaRoll,
  resolveRaTarget,
  stripCheckRequests,
  stripResultPhrases,
} from "../../lib/shared/chat/check-command.js";

describe("团检指令", () => {
  describe("parseRaCommand", () => {
    it("解析 .ra聆听", () => {
      expect(parseRaCommand(".ra聆听")).toEqual({ skill: "聆听", difficulty: "regular" });
    });
    it("解析 .ra 聆听（带空格）", () => {
      expect(parseRaCommand(".ra 聆听")).toEqual({ skill: "聆听", difficulty: "regular" });
    });
    it("解析 [.ra聆听]（复制整条指令）", () => {
      expect(parseRaCommand("[.ra聆听]")).toEqual({ skill: "聆听", difficulty: "regular" });
    });
    it("解析 .ra侦查困难（连写难度）", () => {
      expect(parseRaCommand(".ra侦查困难")).toEqual({ skill: "侦查", difficulty: "hard" });
    });
    it("解析 .ra侦查极限", () => {
      expect(parseRaCommand(".ra侦查极限")).toEqual({ skill: "侦查", difficulty: "extreme" });
    });
    it("解析 .ra侦查普通", () => {
      expect(parseRaCommand(".ra侦查普通")).toEqual({ skill: "侦查", difficulty: "regular" });
    });
    it(".ra 后缺技能名返回空 skill", () => {
      expect(parseRaCommand(".ra")).toEqual({ skill: "", difficulty: "regular" });
    });
    it("普通文本不是 .ra 指令", () => {
      expect(parseRaCommand("我观察外观")).toBeNull();
    });
  });

  describe("parseSkillDifficulty", () => {
    it("无难度后缀默认常规", () => {
      expect(parseSkillDifficulty("侦查")).toEqual({ skill: "侦查", difficulty: "regular" });
    });
    it("识别困难", () => {
      expect(parseSkillDifficulty("侦查·困难")).toEqual({ skill: "侦查", difficulty: "hard" });
    });
    it("识别极限", () => {
      expect(parseSkillDifficulty("侦查·极限")).toEqual({ skill: "侦查", difficulty: "extreme" });
    });
  });

  describe("parseCheckRequests", () => {
    it("提取单个团检（含动作选项）", () => {
      expect(parseCheckRequests("你侧耳倾听。【团检：聆听】")).toEqual([{ skill: "聆听", difficulty: "regular", hint: "你侧耳倾听。" }]);
    });
    it("提取带难度的团检", () => {
      expect(parseCheckRequests("屋顶边缘似乎有异样。[团检：侦查·困难]")).toEqual([{ skill: "侦查", difficulty: "hard", hint: "屋顶边缘似乎有异样。" }]);
    });
    it("支持半角方括号与去重（保留动作选项）", () => {
      expect(parseCheckRequests("[团检：侦查] 再看一眼【团检：侦查】")).toEqual([{ skill: "侦查", difficulty: "regular", hint: "再看一眼" }]);
    });
    it("无标记返回空数组", () => {
      expect(parseCheckRequests("周围很安静。")).toEqual([]);
    });
    it("解析非正式提示（需攀爬/敏捷）取已知技能", () => {
      expect(parseCheckRequests("你翻出窗外，沿窄檐攀向屋顶小门（需攀爬/敏捷）")).toEqual([{ skill: "攀爬", difficulty: "regular", hint: "你翻出窗外，沿窄檐攀向屋顶小门" }]);
    });
    it("解析非正式提示（需锁匠）", () => {
      expect(parseCheckRequests("取出工具撬锁（需锁匠）")).toEqual([{ skill: "锁匠", difficulty: "regular", hint: "取出工具撬锁" }]);
    });
  });

  describe("stripCheckRequests", () => {
    it("移除团检标记与混入的 .ra 指令", () => {
      const text = stripCheckRequests("你似乎听见响动。【团检：聆听】请回复 .ra聆听 再行动。");
      expect(text).toContain("你似乎听见响动。");
      expect(text).notToContain("团检");
      expect(text).notToContain(".ra");
    });
    it("移除括号内团检时不留空括号", () => {
      const text = stripCheckRequests("再试一次，把插销拨开（[团检：锁匠]）");
      expect(text).toBe("再试一次，把插销拨开");
    });
    it("移除整段团检括号说明", () => {
      const text = stripCheckRequests("（若想翻查书桌与抽屉，也可 [团检：侦查] / [团检：图书馆使用]）");
      expect(text.trim()).toBe("");
    });
    it("移除非正式检定提示", () => {
      const text = stripCheckRequests("沿窄檐攀向屋顶小门（需攀爬/敏捷）");
      expect(text).toBe("沿窄檐攀向屋顶小门");
    });
  });

  describe("containsResultPhrase / stripResultPhrases", () => {
    it("检测到困难成功", () => {
      expect(containsResultPhrase("你的目光扫过，困难成功，细节落入眼中。")).toBeTrue();
    });
    it("检测到骰值", () => {
      expect(containsResultPhrase("你掷出 d100 = 36。")).toBeTrue();
    });
    it("普通叙述不误报", () => {
      expect(containsResultPhrase("门后传来窸窣声。")).toBeFalse();
    });
    it("剥离档位词并清理标点", () => {
      expect(stripResultPhrases("你的目光扫过，困难成功，细节落入眼中。")).toBe("你的目光扫过，细节落入眼中。");
    });
  });

  describe("resolveRaTarget", () => {
    const flat = {
      characters: [
        {
          name: "伊芙琳",
          aiControlled: false,
          stats: { STR: 55, DEX: 60 },
          skills: { 侦查: 70, "格斗：斗殴": 50 },
        },
        { name: "艾伦", aiControlled: true, stats: { STR: 50 }, skills: { 侦查: 65 } },
      ],
    };
    it("优先匹配 player 名", () => {
      expect(resolveRaTarget(flat, "艾伦", "侦查")).toEqual({ name: "艾伦", target: 65 });
    });
    it("player 不匹配时取第一个非 AI 调查员", () => {
      expect(resolveRaTarget(flat, "玩家", "侦查")).toEqual({ name: "伊芙琳", target: 70 });
    });
    it("技能不存在时回退属性别名", () => {
      expect(resolveRaTarget(flat, "玩家", "力量")).toEqual({ name: "伊芙琳", target: 55 });
    });
    it("兼容全角/半角冒号技能名", () => {
      expect(resolveRaTarget(flat, "玩家", "格斗:斗殴")).toEqual({ name: "伊芙琳", target: 50 });
    });
    it("无人物时回退内置技能默认值（聆听 20）", () => {
      expect(resolveRaTarget({ characters: [] }, "玩家", "聆听")).toEqual({ name: "玩家", target: 20 });
    });
    it("未知技能且非属性时 target 为 null", () => {
      expect(resolveRaTarget({ characters: [] }, "玩家", "不存在技能")).toEqual({ name: "玩家", target: null });
    });
  });

  describe("performRaRoll / formatRaResultLine", () => {
    it("输出 D100=79/60 失败 格式", () => {
      const restore = mockRandom(randomForDice([{ sides: 100, value: 79 }]));
      const result = performRaRoll("聆听", 60, "regular");
      restore();
      expect(result.rolled).toBe(79);
      expect(result.tier).toBe("fail");
      expect(formatRaResultLine("伊芙琳", "聆听", result)).toBe("伊芙琳进行聆听检定：\nD100=79/60 失败 ✗");
    });
    it("困难难度 24/60 为困难成功", () => {
      const restore = mockRandom(randomForDice([{ sides: 100, value: 24 }]));
      const result = performRaRoll("侦查", 60, "hard");
      restore();
      expect(result.tier).toBe("hard");
      expect(result.passed).toBe(true);
      expect(formatRaResultLine("伊芙琳", "侦查", result)).toBe("伊芙琳进行侦查检定（困难）：\nD100=24/60 困难成功 ✓");
    });
    it("无目标时省略 /目标", () => {
      const restore = mockRandom(randomForDice([{ sides: 100, value: 50 }]));
      const result = performRaRoll("侦查", null, "regular");
      restore();
      expect(formatRaResultLine("伊芙琳", "侦查", result)).toBe("伊芙琳进行侦查检定：\nD100=50");
    });
  });

  describe("formatCheckLine", () => {
    it("常规输出可复制指令", () => {
      expect(formatCheckLine("聆听")).toBe("[团检：聆听] [.ra聆听]");
    });
    it("困难输出连写难度", () => {
      expect(formatCheckLine("侦查", "hard")).toBe("[团检：侦查·困难] [.ra侦查困难]");
    });
    it("极限输出连写难度", () => {
      expect(formatCheckLine("侦查", "extreme")).toBe("[团检：侦查·极限] [.ra侦查极限]");
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "check-command 单元测试"));

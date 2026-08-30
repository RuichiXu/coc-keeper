/**
 * 结局事件（ending）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  applyEndingResolvedEvent,
  buildEndingKeywords,
  createEndingResolvedEvent,
} from "../../lib/shared/chat/index.js";

function finalRiteFlat(overrides = {}) {
  return {
    currentScene: "三层书房",
    currentBranchId: "",
    endingReached: false,
    endedAt: null,
    passedCheckpointIds: [],
    pendingChecks: [
      { id: "chk-a", skill: "侦查", action: "检查书桌", scene: "三层书房" },
    ],
    skippedChecks: [],
    keyPoints: [
      { id: "ai-kp-6", title: "克罗斯临终提示", requiresAnyOf: [{ branchChoiceIds: ["ai-br-3"] }] },
      { id: "ai-kp-7", title: "拼凑十二字咒文", requires: { checkpointGroups: [["chk-13"]] } },
      { id: "ai-kp-8", title: "最终抉择", requires: { keyPointIds: ["ai-kp-7"], branchChoiceIds: ["ai-br-3"] } },
    ],
    branches: [
      {
        id: "ai-br-3",
        title: "最终咒文念诵方式",
        scene: "三层书房/结局",
        reached: true,
        chosen: "逆序念诵（送神）",
        options: [{ label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" }],
      },
    ],
    ...overrides,
  };
}

describe("createEndingResolvedEvent 结局事件创建", () => {
  it("最终仪式技能成功且最终分支已选 → 创建事件并补结局句", () => {
    const flat = finalRiteFlat();
    const ending = createEndingResolvedEvent(flat, "你念出最后一个字。", {
      rolledRaSkill: "意志",
      lastRoll: { passed: true },
      now: "2026-08-28T10:00:00.000Z",
    });
    expect(ending).notToBeNull();
    expect(ending.event.type).toBe("EndingResolved");
    expect(ending.event.branchId).toBe("ai-br-3");
    expect(ending.event.appendedSentence).toContain("墨渊消散");
    expect(ending.narration).toContain("墨渊消散");
  });

  it("叙述已出现结局关键词时不重复追加", () => {
    const flat = finalRiteFlat();
    const ending = createEndingResolvedEvent(flat, "墨渊消散，书房恢复寂静。", {
      rolledRaSkill: "意志",
      lastRoll: { passed: true },
    });
    expect(ending.event.appendedSentence).toBe("");
    expect(ending.narration).toBe("墨渊消散，书房恢复寂静。");
  });

  it("非最终仪式技能或失败不创建结局事件", () => {
    const flat = finalRiteFlat();
    expect(createEndingResolvedEvent(flat, "x", { rolledRaSkill: "侦查", lastRoll: { passed: true } })).toBeNull();
    expect(createEndingResolvedEvent(flat, "x", { rolledRaSkill: "意志", lastRoll: { passed: false } })).toBeNull();
  });
});

describe("applyEndingResolvedEvent 结局事件应用", () => {
  it("提交结局状态、补揭示关键点、废弃全部门禁", () => {
    const flat = finalRiteFlat();
    const ending = createEndingResolvedEvent(flat, "你念出最后一个字。", {
      rolledRaSkill: "意志",
      lastRoll: { passed: true },
      now: "2026-08-28T10:00:00.000Z",
    });
    const revealed = applyEndingResolvedEvent(flat, ending.event, ending.finalBranch);
    expect(flat.endingReached).toBeTrue();
    expect(flat.endedAt).toBe("2026-08-28T10:00:00.000Z");
    expect(flat.currentScene).toBe("三层书房·仪式终结");
    expect(flat.currentBranchId).toBe("ai-br-3");
    expect(flat.pendingChecks).toHaveLength(0);
    expect(flat.skippedChecks[0].reason).toBe("ending-resolved");
    expect(flat.keyPoints[0].revealed).toBeTrue();
    expect(flat.keyPoints[1].revealed).toBeTrue();
    expect(flat.keyPoints[2].revealed).toBeTrue();
    expect(revealed).toBe(3);
  });
});

describe("buildEndingKeywords 结局关键词", () => {
  it("从选项 leadsTo 去掉结局尾缀", () => {
    const finalBranch = {
      options: [
        { label: "逆序", leadsTo: "墨渊消散的结局" },
        { label: "正序", leadsTo: "夏拉卡拉布降临的结局" },
      ],
    };
    expect(buildEndingKeywords(finalBranch)).toEqual(["墨渊消散", "夏拉卡拉布降临"]);
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "ending 单元测试"));

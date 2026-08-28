/**
 * 标准剧情点预设单元测试
 *
 * 验证 gotoPreset 使用的同一份预设数据在纯函数层行为正确，
 * 且 exportStoryFixture 能导出可复用夹具。
 */
import { describe, it, expect } from "../runner.js";
import {
  applyStoryPreset,
  exportStoryFixture,
  firstPlayerCharacter,
  STORY_PRESET_NAMES,
} from "../../lib/shared/testing/story-presets.js";

function makeFlat() {
  return {
    id: "g1",
    title: "墨渊",
    currentScene: "",
    currentBranchId: "",
    endingReached: false,
    endedAt: null,
    spellShown: false,
    pendingChecks: [],
    pendingChoice: null,
    resolvedChecks: [],
    passedCheckpointIds: [],
    sanitySettled: [],
    skippedChecks: [],
    firedNightEventIds: [],
    keyPoints: [
      { id: "ai-kp-1", title: "委托到来", scene: "导入", revealed: false },
      { id: "ai-kp-3", title: "进入书房", scene: "三层书房", revealed: false },
    ],
    branches: [
      { id: "ai-br-1", title: "如何进入书房", scene: "三层书房", reached: false, chosen: null, options: [{ label: "撞门", leadsTo: "三层书房" }] },
      { id: "ai-br-2", title: "是否掀开地毯", scene: "三层书房", reached: false, chosen: null, options: [{ label: "掀开地毯查看", leadsTo: "发现墨渊" }] },
      { id: "ai-br-3", title: "最终咒文念诵方式", scene: "三层书房/结局", reached: false, chosen: null, options: [] },
    ],
    characters: [
      { name: "伊芙琳", aiControlled: false, san: 65, inventory: [] },
    ],
  };
}

describe("story presets", () => {
  it("STORY_PRESET_NAMES 与预设工厂一一对应", () => {
    for (const name of STORY_PRESET_NAMES) {
      expect(typeof name).toBe("string");
      expect(Boolean(applyStoryPreset(makeFlat(), name))).toBeTrue();
    }
  });

  it("door 预设：门外场景 + 撞门分支已选 + 力量门禁", () => {
    const flat = applyStoryPreset(makeFlat(), "door");
    expect(flat.currentScene).toBe("三层书房门外");
    expect(flat.currentBranchId).toBe("ai-br-1");
    expect(flat.branches.find((branch) => branch.id === "ai-br-1").chosen).toBe("撞门");
    expect(flat.pendingChecks).toHaveLength(1);
    expect(flat.pendingChecks[0].skill).toBe("力量");
    expect(flat.keyPoints.find((kp) => kp.id === "ai-kp-3").revealed).toBeFalse();
  });

  it("diary-found 预设：日记手稿关键点揭示 + chk-3/4/5/6 已过 + 物品入栏", () => {
    const flat = applyStoryPreset(makeFlat(), "diary-found");
    expect(flat.currentScene).toBe("三层书房");
    expect(flat.keyPoints.find((kp) => kp.id === "ai-kp-4").revealed).toBeTrue();
    expect(flat.passedCheckpointIds).toEqual(["chk-3", "chk-4", "chk-5", "chk-6"]);
    expect(flat.characters[0].inventory).toEqual(["克罗斯的日记", "四张手稿"]);
  });

  it("rug-revealed 预设：chk-7 已过但 ai-kp-5 未揭示、ai-br-2 未落地", () => {
    const flat = applyStoryPreset(makeFlat(), "rug-revealed");
    expect(flat.passedCheckpointIds).toContain("chk-7");
    expect(flat.keyPoints.find((kp) => kp.id === "ai-kp-5").revealed).toBeFalse();
    expect(flat.branches.find((branch) => branch.id === "ai-br-2").reached).toBeFalse();
  });

  it("spell-decoded 预设：chk-13 已过 + ai-kp-6/7 揭示 + spellShown", () => {
    const flat = applyStoryPreset(makeFlat(), "spell-decoded");
    expect(flat.passedCheckpointIds).toContain("chk-13");
    expect(flat.keyPoints.find((kp) => kp.id === "ai-kp-6").revealed).toBeTrue();
    expect(flat.keyPoints.find((kp) => kp.id === "ai-kp-7").revealed).toBeTrue();
    expect(flat.spellShown).toBeTrue();
  });

  it("final-rite 预设：最终分支已选 + ai-kp-5/8 揭示 + 意志门禁", () => {
    const flat = applyStoryPreset(makeFlat(), "final-rite");
    expect(flat.currentBranchId).toBe("ai-br-3");
    expect(flat.branches.find((branch) => branch.id === "ai-br-3").chosen).toBe("逆序念诵（送神）");
    expect(flat.keyPoints.find((kp) => kp.id === "ai-kp-8").revealed).toBeTrue();
    expect(flat.keyPoints.find((kp) => kp.id === "ai-kp-5").revealed).toBeTrue();
    expect(flat.pendingChecks).toHaveLength(1);
    expect(flat.pendingChecks[0].skill).toBe("意志");
    expect(flat.sanitySettled[0].eventId).toBe("scenario:chk-9");
  });

  it("exportStoryFixture 导出可复用夹具且不修改原状态", () => {
    const flat = applyStoryPreset(makeFlat(), "spell-decoded");
    const fixture = exportStoryFixture(flat);
    expect(fixture.currentScene).toBe("三层书房");
    expect(fixture.passedCheckpointIds).toContain("chk-13");
    expect(fixture.inventory).toEqual(["克罗斯的日记", "四张手稿"]);
    expect(fixture.keyPoints.find((kp) => kp.id === "ai-kp-7").revealed).toBeTrue();
    expect(fixture.pendingChecks).toHaveLength(0);
    expect(flat.keyPoints.length).toBe(8);
  });

  it("firstPlayerCharacter 在没有角色时创建默认调查员", () => {
    const flat = { characters: [] };
    const pc = firstPlayerCharacter(flat);
    expect(pc.name).toBe("伊芙琳");
    expect(flat.characters).toHaveLength(1);
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "story-presets 单元测试"));

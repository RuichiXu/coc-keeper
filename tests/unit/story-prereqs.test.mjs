/**
 * 结构化剧情前置条件（story-prereqs）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  draftBranchPrerequisites,
  draftEndingKeyPointPrerequisites,
  draftKeyPointPrerequisites,
  enrichStoryPrerequisites,
  entryEvidenceVariants,
  evaluatePrerequisites,
  evaluateRequiresAnyOf,
  findFinalBranch,
  findKeyPointsRequiringBranch,
  findSpellKeyPoint,
  prerequisitesSatisfied,
  requiredCheckpointIdsOf,
} from "../../lib/shared/chat/index.js";

const MOYUAN_CHECKPOINTS = [
  { id: "chk-3", skill: "侦查", difficulty: "regular", scene: "调查员若对书房进行侦察或者图书馆检定", floor: "三层", trigger: "侦察或者图书馆普通成功：发现书桌抽屉里有一本日记", keys: ["书房", "日记"] },
  { id: "chk-4", skill: "图书馆使用", difficulty: "regular", scene: "调查员若对书房进行侦察或者图书馆检定", floor: "三层", trigger: "侦察或者图书馆普通成功：发现书桌抽屉里有一本日记", keys: ["书房", "日记"] },
  { id: "chk-5", skill: "侦查", difficulty: "hard", scene: "调查员若对书房进行侦察或者图书馆检定", floor: "三层", trigger: "侦察或者图书馆困难成功：发现书桌抽屉里有四张手稿", keys: ["书房", "手稿"] },
  { id: "chk-6", skill: "图书馆使用", difficulty: "hard", scene: "调查员若对书房进行侦察或者图书馆检定", floor: "三层", trigger: "侦察或者图书馆困难成功：发现书桌抽屉里有四张手稿", keys: ["书房", "手稿"] },
  { id: "chk-8", skill: "理智", difficulty: "regular", scene: "调查员若对书房进行侦察或者图书馆检定", floor: "三层", trigger: "CG播放完毕，进行san check", keys: ["书房"] },
  { id: "chk-9", skill: "理智", difficulty: "regular", scene: "调查员必须在此刻开始念诵逆咒", floor: "三层", trigger: "调查员继续念出第四个词组，此时漩涡中逐渐睁开一只巨眼", keys: ["墨渊", "漩涡", "巨眼"] },
  { id: "chk-11", skill: "智力", difficulty: "regular", scene: "结局3（BE 克罗斯之死）", floor: "二层", trigger: "智力鉴定普通通过：将发现手稿上的时间和文章的内容是有联系的。", keys: ["手稿"] },
  { id: "chk-12", skill: "智力", difficulty: "hard", scene: "结局3（BE 克罗斯之死）", floor: "二层", trigger: "智力鉴定困难通过：将发现手稿上12个月和日的时间分别对应手稿文章里的第几行和第几个字。", keys: ["手稿"] },
  { id: "chk-13", skill: "智力", difficulty: "extreme", scene: "结局3（BE 克罗斯之死）", floor: "二层", trigger: "智力鉴定极难通过：将发现手稿上12个字是正序请神术的念咒顺序，每三个字为一个词。", keys: ["手稿"] },
];

describe("evaluatePrerequisites 条件判定", () => {
  it("scene 条件：当前场景精确相等才通过", () => {
    const requires = { scene: "三层书房" };
    expect(evaluatePrerequisites(requires, { currentScene: "三层书房" })).toBeTrue();
    expect(evaluatePrerequisites(requires, { currentScene: "三层书房门外" })).toBeFalse();
  });

  it("entryEvidence：文本为空时豁免，文本非空时必须有证据且排除否定语境", () => {
    const requires = { scene: "三层书房", entryEvidence: ["进入书房"] };
    expect(evaluatePrerequisites(requires, { currentScene: "三层书房", playerText: "", narration: "" })).toBeTrue();
    expect(evaluatePrerequisites(requires, { currentScene: "三层书房", playerText: "", narration: "你进入书房，霉味扑面而来。" })).toBeTrue();
    expect(evaluatePrerequisites(requires, { currentScene: "三层书房", playerText: "", narration: "你站在门外，门依然反锁。" })).toBeFalse();
    expect(evaluatePrerequisites(requires, { currentScene: "三层书房", playerText: "", narration: "你并没能进入书房。" })).toBeFalse();
  });

  it("checkpointGroups：组内 OR、组间 AND", () => {
    const requires = { checkpointGroups: [["chk-3", "chk-4"], ["chk-5", "chk-6"]] };
    expect(evaluatePrerequisites(requires, { passedCheckpointIds: ["chk-3", "chk-5"] })).toBeTrue();
    expect(evaluatePrerequisites(requires, { passedCheckpointIds: ["chk-4", "chk-6"] })).toBeTrue();
    expect(evaluatePrerequisites(requires, { passedCheckpointIds: ["chk-3"] })).toBeFalse();
  });

  it("sanityEventIds：eventId 含 id 或等于 scenario:id", () => {
    const requires = { sanityEventIds: ["chk-9"] };
    expect(evaluatePrerequisites(requires, { sanitySettled: [{ eventId: "scenario:chk-9" }] })).toBeTrue();
    expect(evaluatePrerequisites(requires, { sanitySettled: [{ eventId: "墨渊首次目击chk-9" }] })).toBeTrue();
    expect(evaluatePrerequisites(requires, { sanitySettled: [{ eventId: "scenario:chk-8" }] })).toBeFalse();
  });

  it("keyPointIds 与 branchChoiceIds：需全部揭示/已选", () => {
    const ctx = {
      keyPoints: [{ id: "ai-kp-7", title: "拼凑十二字咒文", revealed: true }],
      branches: [{ id: "ai-br-3", title: "最终仪式", reached: true, chosen: "逆序念诵（送神）" }],
    };
    expect(evaluatePrerequisites({ keyPointIds: ["ai-kp-7"], branchChoiceIds: ["ai-br-3"] }, ctx)).toBeTrue();
    expect(evaluatePrerequisites({ keyPointIds: ["ai-kp-7"], branchChoiceIds: ["ai-br-3"] }, {
      ...ctx,
      keyPoints: [{ id: "ai-kp-7", title: "拼凑十二字咒文", revealed: false }],
    })).toBeFalse();
    expect(evaluatePrerequisites({ branchChoiceIds: ["ai-br-3"] }, {
      ...ctx,
      branches: [{ id: "ai-br-3", title: "最终仪式", reached: true, chosen: null }],
    })).toBeFalse();
  });

  it("evaluateRequiresAnyOf：任意一组满足即通过", () => {
    const anyOf = [{ keyPointIds: ["ai-kp-7"] }, { branchChoiceIds: ["ai-br-3"] }];
    const ctx = {
      keyPoints: [{ id: "ai-kp-7", title: "拼凑十二字咒文", revealed: false }],
      branches: [{ id: "ai-br-3", title: "最终仪式", reached: true, chosen: "逆序" }],
    };
    expect(evaluateRequiresAnyOf(anyOf, ctx)).toBeTrue();
    expect(evaluateRequiresAnyOf(anyOf, {
      keyPoints: [{ id: "ai-kp-7", title: "拼凑十二字咒文", revealed: false }],
      branches: [{ id: "ai-br-3", title: "最终仪式", reached: false, chosen: null }],
    })).toBeFalse();
  });

  it("prerequisitesSatisfied：没有结构化条件时视为不满足", () => {
    expect(prerequisitesSatisfied({}, {})).toBeFalse();
    expect(prerequisitesSatisfied({ requires: {} }, {})).toBeTrue();
  });
});

describe("draftKeyPointPrerequisites 草拟规则", () => {
  it("空间型标题生成场景+进门证据", () => {
    const kp = { id: "ai-kp-3", title: "进入书房", scene: "三层书房" };
    const draft = draftKeyPointPrerequisites(kp, { scenarioCheckpoints: MOYUAN_CHECKPOINTS });
    expect(draft.requires.scene).toBe("三层书房");
    expect(draft.requires.entryEvidence).toContain("进入书房");
    expect(draft.requires.entryEvidence).toContain("走进书房");
  });

  it("发现日记与手稿：按标题词生成检定点组", () => {
    const kp = { id: "ai-kp-4", title: "发现日记与手稿", scene: "三层书房" };
    const draft = draftKeyPointPrerequisites(kp, { scenarioCheckpoints: MOYUAN_CHECKPOINTS });
    expect(draft.requires.checkpointGroups).toEqual([["chk-3", "chk-4"], ["chk-5", "chk-6"]]);
  });

  it("发现墨渊：只匹配 keys 含墨渊的 SAN 检定点（chk-9）", () => {
    const kp = { id: "ai-kp-5", title: "发现墨渊", scene: "三层书房" };
    const draft = draftKeyPointPrerequisites(kp, { scenarioCheckpoints: MOYUAN_CHECKPOINTS });
    expect(draft.requires.sanityEventIds).toEqual(["chk-9"]);
  });

  it("拼凑十二字咒文：智力解读检定点取最高难度 chk-13", () => {
    const kp = { id: "ai-kp-7", title: "拼凑十二字咒文", scene: "三层书房" };
    const draft = draftKeyPointPrerequisites(kp, { scenarioCheckpoints: MOYUAN_CHECKPOINTS });
    expect(draft.requires.checkpointGroups).toEqual([["chk-13"]]);
  });

  it("没有足够证据时不生成条件", () => {
    const kp = { id: "ai-kp-2", title: "发现一层墨渍", scene: "一层门厅" };
    expect(draftKeyPointPrerequisites(kp, { scenarioCheckpoints: MOYUAN_CHECKPOINTS })).toBeNull();
  });
});

describe("draftBranchPrerequisites 草拟规则", () => {
  it("选项 leadsTo 指向 SAN 关键点时复制条件并记录自动选项", () => {
    const flat = {
      keyPoints: [{ id: "ai-kp-5", title: "发现墨渊", scene: "三层书房", requires: { sanityEventIds: ["chk-9"] } }],
    };
    const branch = { id: "ai-br-2", title: "是否掀开地毯", options: [{ label: "掀开地毯查看", leadsTo: "发现墨渊" }] };
    const draft = draftBranchPrerequisites(branch, flat);
    expect(draft.requires.sanityEventIds).toEqual(["chk-9"]);
    expect(draft.autoChooseLabel).toBe("掀开地毯查看");
  });
});

describe("draftEndingKeyPointPrerequisites 终局关联", () => {
  const spellKp = { id: "ai-kp-7", title: "拼凑十二字咒文" };
  const finalBranch = { id: "ai-br-3", title: "最终咒文念诵方式" };

  it("临终提示：咒文关键点已揭示 或 最终分支已选", () => {
    const draft = draftEndingKeyPointPrerequisites({ title: "克罗斯临终提示" }, {}, spellKp, finalBranch);
    expect(draft.requiresAnyOf).toEqual([
      { keyPointIds: ["ai-kp-7"] },
      { branchChoiceIds: ["ai-br-3"] },
    ]);
  });

  it("最终抉择：咒文关键点已揭示 且 最终分支已选", () => {
    const draft = draftEndingKeyPointPrerequisites({ title: "最终抉择" }, {}, spellKp, finalBranch);
    expect(draft.requires).toEqual({ keyPointIds: ["ai-kp-7"], branchChoiceIds: ["ai-br-3"] });
  });
});

describe("enrichStoryPrerequisites 批量补写", () => {
  it("为缺少条件的关键点/分支补写，且不覆盖已有条件", () => {
    const flat = {
      keyPoints: [
        { id: "ai-kp-3", title: "进入书房", scene: "三层书房" },
        { id: "ai-kp-4", title: "发现日记与手稿", scene: "三层书房" },
        { id: "ai-kp-5", title: "发现墨渊", scene: "三层书房" },
        { id: "ai-kp-6", title: "克罗斯临终提示", scene: "三层书房" },
        { id: "ai-kp-7", title: "拼凑十二字咒文", scene: "三层书房" },
        { id: "ai-kp-8", title: "最终抉择", scene: "三层书房/结局" },
        { id: "ai-kp-1", title: "委托到来", scene: "导入", requires: { keyPointIds: ["custom"] } },
      ],
      branches: [
        { id: "ai-br-2", title: "是否掀开地毯", scene: "三层书房", options: [{ label: "掀开地毯查看", leadsTo: "发现墨渊" }] },
        { id: "ai-br-3", title: "最终咒文念诵方式", scene: "三层书房/结局", options: [{ label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" }] },
      ],
      scenarioCheckpoints: MOYUAN_CHECKPOINTS,
    };
    enrichStoryPrerequisites(flat);
    expect(flat.keyPoints[0].requires.entryEvidence).toContain("进入书房");
    expect(flat.keyPoints[1].requires.checkpointGroups).toEqual([["chk-3", "chk-4"], ["chk-5", "chk-6"]]);
    expect(flat.keyPoints[2].requires.sanityEventIds).toEqual(["chk-9"]);
    expect(flat.keyPoints[3].requiresAnyOf).toHaveLength(2);
    expect(flat.keyPoints[4].requires.checkpointGroups).toEqual([["chk-13"]]);
    expect(flat.keyPoints[5].requires.keyPointIds).toEqual(["ai-kp-7"]);
    expect(flat.keyPoints[5].requires.branchChoiceIds).toEqual(["ai-br-3"]);
    // 开场关键点已手工配置，不覆盖。
    expect(flat.keyPoints[6].requires).toEqual({ keyPointIds: ["custom"] });
    // 分支补写。
    expect(flat.branches[0].requires.sanityEventIds).toEqual(["chk-9"]);
    expect(flat.branches[0].autoChooseLabel).toBe("掀开地毯查看");
  });
});

describe("结构化查找", () => {
  it("findSpellKeyPoint / findFinalBranch", () => {
    const flat = {
      keyPoints: [
        { id: "ai-kp-7", title: "拼凑十二字咒文" },
        { id: "ai-kp-1", title: "委托到来" },
      ],
      branches: [
        { id: "ai-br-1", title: "如何进入书房", options: [{ label: "撞门", leadsTo: "三层书房" }] },
        { id: "ai-br-3", title: "最终咒文念诵方式", options: [{ label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" }] },
      ],
    };
    expect(findSpellKeyPoint(flat).id).toBe("ai-kp-7");
    expect(findFinalBranch(flat).id).toBe("ai-br-3");
  });

  it("findKeyPointsRequiringBranch 返回引用指定分支的关键点", () => {
    const flat = {
      keyPoints: [
        { id: "ai-kp-6", title: "克罗斯临终提示", requiresAnyOf: [{ branchChoiceIds: ["ai-br-3"] }] },
        { id: "ai-kp-8", title: "最终抉择", requires: { branchChoiceIds: ["ai-br-3"] } },
        { id: "ai-kp-7", title: "拼凑十二字咒文", requires: { checkpointGroups: [["chk-13"]] } },
      ],
    };
    const ids = findKeyPointsRequiringBranch(flat, "ai-br-3").map((kp) => kp.id);
    expect(ids).toEqual(["ai-kp-6", "ai-kp-8"]);
  });

  it("requiredCheckpointIdsOf 展开所有检定点组", () => {
    const kp = { requires: { checkpointGroups: [["chk-13"], ["chk-3", "chk-4"]] } };
    expect(requiredCheckpointIdsOf(kp)).toEqual(["chk-13", "chk-3", "chk-4"]);
  });

  it("entryEvidenceVariants 生成同义进门短语", () => {
    expect(entryEvidenceVariants("进入", "书房")).toContain("进入书房");
    expect(entryEvidenceVariants("进入", "书房")).toContain("踏进书房");
    expect(entryEvidenceVariants("打开", "暗门")).toContain("打开暗门");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "story-prereqs 单元测试"));

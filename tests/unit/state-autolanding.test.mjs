/**
 * 关键点/物品自动落地（确定性启发式）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  applyEventDrivenLanding,
  autoTrackInventory,
  autoLandBranches,
  canonicalItemFromEntities,
  cleanupJunkInventory,
  recordResolvedCheck,
  resolvedCheckKey,
  revealKeyPointsForBranchChoices,
  revealKeyPointsFromNarration,
} from "../../lib/shared/chat/index.js";
import { resolveRaCandidateChoice } from "../../lib/shared/chat/check-gates.js";

describe("关键点自动揭示", () => {
  it("叙述完整出现未揭示关键点标题时揭示", () => {
    const keyPoints = [
      { id: "kp-1", title: "墨渊", desc: "屋顶的墨色深渊", revealed: false },
      { id: "kp-2", title: "十二字咒文", desc: "四组三字", revealed: false },
    ];
    const changed = revealKeyPointsFromNarration(keyPoints, "你看到屋顶上有一片墨渊在缓慢旋转。");
    expect(changed).toBe(1);
    expect(keyPoints[0].revealed).toBeTrue();
    expect(keyPoints[1].revealed).toBeFalse();
  });

  it("不误揭示未出现的标题", () => {
    const keyPoints = [{ id: "kp-1", title: "鬼影", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "你走进空无一人的书房。");
    expect(changed).toBe(0);
    expect(keyPoints[0].revealed).toBeFalse();
  });

  it("忽略长度不足 2 的标题", () => {
    const keyPoints = [{ id: "kp-1", title: "墨", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "墨迹在纸上晕开。");
    expect(changed).toBe(0);
  });

  it("过短的剥离词（墨渊）不再通过正文命中，交由事件驱动", () => {
    const keyPoints = [{ id: "kp-1", title: "发现墨渊", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "墨渊正在屋顶上缓缓旋转。");
    expect(changed).toBe(0);
    expect(keyPoints[0].revealed).toBeFalse();
  });

  it("标题为「A与B」时，正文同时出现 A、B 即命中", () => {
    const keyPoints = [{ id: "kp-1", title: "发现日记与手稿", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "抽屉里有一本日记和四张手稿。");
    expect(changed).toBe(1);
    expect(keyPoints[0].revealed).toBeTrue();
  });

  it("过短的事件后缀剥离词（委托）不再通过正文命中，交由开场揭示", () => {
    const keyPoints = [{ id: "kp-1", title: "委托到来", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "艾茜向你们说明了这份委托，请你们调查宅邸怪事。");
    expect(changed).toBe(0);
    expect(keyPoints[0].revealed).toBeFalse();
  });

  it("否定语境不揭示关键点：没能进入书房", () => {
    const keyPoints = [{ id: "kp-1", title: "进入书房", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "你并没能进入书房，门依然锁着。");
    expect(changed).toBe(0);
    expect(keyPoints[0].revealed).toBeFalse();
  });
});

describe("事件驱动落地", () => {
  it("SAN 结算墨渊首次目击 → 揭示发现墨渊并落地掀开地毯分支", () => {
    const flat = {
      currentScene: "三层书房",
      passedCheckpointIds: [],
      sanitySettled: [{ eventId: "scenario:chk-8", player: "伊芙琳" }],
      keyPoints: [
        { id: "ai-kp-5", title: "发现墨渊", scene: "书房", revealed: false },
      ],
      branches: [
        { id: "ai-br-2", title: "是否掀开地毯", scene: "书房", reached: false, chosen: null, options: [{ label: "掀开地毯查看", leadsTo: "发现墨渊" }] },
      ],
    };
    const result = applyEventDrivenLanding(flat);
    expect(result.revealed).toBe(1);
    expect(result.branches).toBe(1);
    expect(flat.keyPoints[0].revealed).toBeTrue();
    expect(flat.branches[0].reached).toBeTrue();
    expect(flat.branches[0].chosen).toBe("掀开地毯查看");
  });

  it("日记与手稿检定点通过 → 揭示发现日记与手稿", () => {
    const flat = {
      currentScene: "三层书房",
      passedCheckpointIds: ["chk-3", "chk-5"],
      sanitySettled: [],
      keyPoints: [
        { id: "ai-kp-4", title: "发现日记与手稿", scene: "书房", revealed: false },
      ],
      branches: [],
    };
    const result = applyEventDrivenLanding(flat);
    expect(result.revealed).toBe(1);
    expect(flat.keyPoints[0].revealed).toBeTrue();
  });

  it("当前场景精确切入三层书房才揭示进入书房", () => {
    const flat = {
      currentScene: "三层书房",
      passedCheckpointIds: [],
      sanitySettled: [],
      keyPoints: [
        { id: "ai-kp-3", title: "进入书房", scene: "三层书房", revealed: false },
      ],
      branches: [],
    };
    const result = applyEventDrivenLanding(flat);
    expect(result.revealed).toBe(1);
    expect(flat.keyPoints[0].revealed).toBeTrue();
  });

  it("最终分支已选但咒文未揭示 → 不揭示最终抉择", () => {
    const flat = {
      currentScene: "三层书房·仪式终结",
      passedCheckpointIds: [],
      sanitySettled: [],
      keyPoints: [
        { id: "ai-kp-7", title: "拼凑十二字咒文", scene: "书房", revealed: false },
        { id: "ai-kp-8", title: "最终抉择", scene: "书房/结局", revealed: false },
      ],
      branches: [
        { id: "ai-br-3", title: "最终仪式", scene: "书房", reached: true, chosen: "逆序念诵（送神）", options: [{ label: "逆序念诵（送神）", leadsTo: "结局" }] },
      ],
    };
    const result = applyEventDrivenLanding(flat);
    expect(result.revealed).toBe(0);
    expect(flat.keyPoints[1].revealed).toBeFalse();
  });

  it("最终分支已选且咒文已揭示 → 揭示最终抉择", () => {
    const flat = {
      currentScene: "三层书房·仪式终结",
      passedCheckpointIds: [],
      sanitySettled: [],
      keyPoints: [
        { id: "ai-kp-7", title: "拼凑十二字咒文", scene: "书房", revealed: true },
        { id: "ai-kp-8", title: "最终抉择", scene: "书房/结局", revealed: false },
      ],
      branches: [
        { id: "ai-br-3", title: "最终仪式", scene: "书房", reached: true, chosen: "逆序念诵（送神）", options: [{ label: "逆序念诵（送神）", leadsTo: "结局" }] },
      ],
    };
    const result = applyEventDrivenLanding(flat);
    expect(result.revealed).toBe(1);
    expect(flat.keyPoints[1].revealed).toBeTrue();
  });
});

describe("门禁短路与候选解析", () => {
  it(".ra侦查 2 解析为第二个候选动作", () => {
    const pending = { skill: "侦查", difficulty: "regular", candidates: ["拉开书桌抽屉", "数清稿纸"] };
    expect(resolveRaCandidateChoice("侦查 2", pending)).toBe("数清稿纸");
    expect(resolveRaCandidateChoice("侦查2", pending)).toBe("数清稿纸");
    expect(resolveRaCandidateChoice("侦查 3", pending)).toBeNull();
  });

  it("recordResolvedCheck 记录稳定键并去重", () => {
    const flat = {};
    recordResolvedCheck(flat, "侦查", "数清稿纸");
    recordResolvedCheck(flat, "侦查", "数清稿纸");
    expect(flat.resolvedChecks).toHaveLength(1);
    expect(flat.resolvedChecks[0]).toBe(resolvedCheckKey("侦查", "数清稿纸"));
  });
});

describe("分支自动落地", () => {
  it("玩家输入命中选项原文时标记 reached + chosen", () => {
    const flat = {
      currentBranchId: "",
      branches: [
        { id: "ai-br-1", title: "如何进入书房", scene: "三层书房", reached: false, chosen: null, options: [{ label: "撞门", leadsTo: "三层书房" }] },
      ],
    };
    const changed = autoLandBranches(flat, "我上到三层，直接撞门进入书房。");
    expect(changed).toBe(1);
    expect(flat.branches[0].reached).toBeTrue();
    expect(flat.branches[0].chosen).toBe("撞门");
    expect(flat.currentBranchId).toBe("ai-br-1");
  });

  it("否定语境不落地分支：放弃撬锁、选择撞门 → chosen=撞门", () => {
    const flat = {
      currentBranchId: "",
      branches: [
        { id: "ai-br-1", title: "如何进入书房", scene: "三层书房", reached: false, chosen: null, options: [{ label: "撬锁", leadsTo: "三层书房" }, { label: "撞门", leadsTo: "三层书房" }] },
      ],
    };
    const changed = autoLandBranches(flat, "我放弃撬锁，决定直接撞门。");
    expect(changed).toBe(1);
    expect(flat.branches[0].chosen).toBe("撞门");
  });

  it("最终分支选择后不直接揭示「最终抉择」，交由事件驱动判定", () => {
    const flat = {
      currentScene: "结局",
      branches: [
        { id: "ai-br-3", title: "最终咒文念诵方式", scene: "结局", reached: true, chosen: "逆序念诵（送神）", options: [{ label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" }] },
      ],
      keyPoints: [
        { id: "ai-kp-8", title: "最终抉择", scene: "书房/结局", revealed: false },
        { id: "ai-kp-7", title: "拼凑十二字咒文", scene: "书房", revealed: false },
      ],
    };
    const changed = revealKeyPointsForBranchChoices(flat);
    expect(changed).toBe(0);
    expect(flat.keyPoints[0].revealed).toBeFalse();
    expect(flat.keyPoints[1].revealed).toBeFalse();
  });

  it("玩家还在书房门外时，撞门分支不揭示「进入书房」", () => {
    const flat = {
      currentScene: "三层书房门外",
      branches: [
        { id: "ai-br-1", title: "如何进入书房", scene: "三层书房", reached: true, chosen: "撞门", options: [{ label: "撞门", leadsTo: "三层书房" }] },
      ],
      keyPoints: [
        { id: "ai-kp-3", title: "进入书房", scene: "三层书房", revealed: false },
      ],
    };
    const changed = revealKeyPointsForBranchChoices(flat);
    expect(changed).toBe(0);
    expect(flat.keyPoints[0].revealed).toBeFalse();
  });

  it("叙述只出现「掀开地毯」也能落地 ai-br-2", () => {
    const flat = {
      currentBranchId: "",
      branches: [
        { id: "ai-br-2", title: "是否掀开地毯", scene: "书房", reached: false, chosen: null, options: [{ label: "掀开地毯查看", leadsTo: "发现墨渊" }] },
      ],
    };
    const changed = autoLandBranches(flat, "你掀开地毯，看到下面不是地板。");
    expect(changed).toBe(1);
    expect(flat.branches[0].reached).toBeTrue();
    expect(flat.branches[0].chosen).toBe("掀开地毯查看");
  });
});

describe("物品实体归一", () => {
  it("纸页归一到剧本实体「四张手稿」", () => {
    const entities = [{ type: "item", name: "四张手稿" }];
    expect(canonicalItemFromEntities("手稿", entities)).toBe("四张手稿");
    expect(canonicalItemFromEntities("纸页", entities)).toBe("四张手稿");
  });

  it("清理物品栏时保留实体名「四张手稿」并归一「原稿一张张」", () => {
    const flat = {
      entities: [{ type: "item", name: "四张手稿" }],
      characters: [
        { name: "伊芙琳", aiControlled: false, inventory: ["四张手稿", "原稿一张张", "纸从它熟悉的位置"] },
      ],
    };
    const removed = cleanupJunkInventory(flat);
    expect(removed).toBe(2);
    expect(flat.characters[0].inventory).toEqual(["四张手稿"]);
  });

  it("叙述残片中的纸页归一到「四张手稿」，且不带句子残片入栏", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
      entities: [{ type: "item", name: "四张手稿" }],
    };
    const added = autoTrackInventory(flat, "你把那些齐整纸页贴身收好，纸页隔着衣物传来凉意。");
    expect(added).toEqual(["四张手稿"]);
    expect(flat.characters[0].inventory).toEqual(["四张手稿"]);
  });
});

describe("物品自动入栏", () => {
  it("从叙述中提取获得的实体物品", () => {
    const flat = {
      characters: [
        { name: "伊芙琳", aiControlled: false, inventory: [] },
      ],
    };
    const added = autoTrackInventory(flat, "艾茜从衣袋里取出一把备用钥匙递给你。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("备用钥匙");
    expect(flat.characters[0].inventory).toContain("备用钥匙");
  });

  it("不把抽象概念误入物品栏", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你得到了一条重要线索。");
    expect(added).toHaveLength(0);
    expect(flat.characters[0].inventory).toHaveLength(0);
  });

  it("已存在的物品不重复入栏", () => {
    const flat = {
      characters: [
        { name: "伊芙琳", aiControlled: false, inventory: ["手稿"] },
      ],
    };
    const added = autoTrackInventory(flat, "你拿起手稿。");
    expect(added).toHaveLength(0);
    expect(flat.characters[0].inventory).toHaveLength(1);
  });

  it("把字句提取持有物品，并套用别名（四张原稿→手稿）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你把四张原稿按顺序装入随身文件夹。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("手稿");
    expect(flat.characters[0].inventory).toContain("手稿");
  });

  it("把字句清理叠词数量（原稿一张张→手稿），不误收证物袋", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你将四张原稿一张张放进新的证物袋。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("手稿");
    expect(flat.characters[0].inventory).toContain("手稿");
    expect(flat.characters[0].inventory).notToContain("证物袋");
  });

  it("拒绝抽象词（蛮力）与容器（文件袋）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你收起蛮力，把稿纸装进文件袋。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("手稿");
    expect(flat.characters[0].inventory.includes("蛮力")).toBeFalse();
    expect(flat.characters[0].inventory.includes("文件袋")).toBeFalse();
  });

  it("清洗句子残片（手枪沉甸甸地别在腰间 → 手枪）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你挎上相机，手枪沉甸甸地别在腰间。");
    expect(added.includes("手枪")).toBeTrue();
    expect(added.includes("手枪沉甸甸地")).toBeFalse();
  });

  it("拒绝介词短语（纸从它熟悉的位置）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "纸从它熟悉的位置滑落出来。");
    expect(added).toHaveLength(0);
    expect(flat.characters[0].inventory).toHaveLength(0);
  });

  it("把字句+提/挎动词（黄铜汽灯/结实麻绳）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你把黄铜汽灯提在手里，又将结实麻绳挎在肩头。");
    expect(added).toHaveLength(2);
    expect(flat.characters[0].inventory).toContain("黄铜汽灯");
    expect(flat.characters[0].inventory).toContain("结实麻绳");
  });

  it("将字句+随身携带", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你将四张原稿随身携带。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("手稿");
  });

  it("状态式持有（结实麻绳盘好斜挎过肩）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "结实麻绳盘好斜挎过肩，绳结压在肩胛侧。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("结实麻绳");
  });

  it("容器内容（装有四张原稿的文件夹）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "装有四张原稿的文件夹贴着身侧。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("手稿");
  });

  it("清理旧版垃圾条目并保留正常物品", () => {
    const flat = {
      characters: [
        { name: "伊芙琳", aiControlled: false, inventory: ["原稿一张张", "纸从它熟悉的位置", "手稿"] },
      ],
    };
    const added = autoTrackInventory(flat, "你把黄铜汽灯提在左手。");
    expect(added).toHaveLength(1);
    expect(flat.characters[0].inventory).toContain("手稿");
    expect(flat.characters[0].inventory).toContain("黄铜汽灯");
    expect(flat.characters[0].inventory).notToContain("原稿一张张");
    expect(flat.characters[0].inventory).notToContain("纸从它熟悉的位置");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "state-autolanding 单元测试"));

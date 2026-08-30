/**
 * 标准剧情点预设（Story Presets）
 *
 * 供两处共用：
 * 1. KP 调试面板 `/coc-api/debug` 的 gotoPreset：把场次直接推进到指定剧情点，简化 E2E。
 * 2. 单元/回放测试：用同一份数据构造 flat 初始状态，保证“测试状态”与“生产状态”一致。
 *
 * 纯数据 + 纯函数，零 DSH 依赖。预设只覆盖“剧情/门禁/关键点/分支/物品/场景”等
 * 测试相关字段，不覆盖角色属性、剧本、规则等既有数据。
 */

export const STORY_PRESET_NAMES = [
  "arrival",
  "door",
  "study-entered",
  "diary-found",
  "rug-revealed",
  "spell-decoded",
  "final-rite",
];

/**
 * 预设状态：keyPoints / branches 的每个元素只写 id/revealed/reached/chosen，
 * 其它字段（title/scene/options）保留 flat 原值；若 flat 没有对应条目，
 * 用《墨渊》标准标题补一个最小条目。
 */
function keyPointPatch(id, title, scene, revealed) {
  return { id, title, scene, revealed };
}

function branchPatch(id, title, scene, reached, chosen, options = []) {
  return { id, title, scene, reached, chosen: chosen ?? null, options };
}

/**
 * 与生产导入草拟（story-prereqs.enrichStoryPrerequisites）保持一致的结构化前置条件。
 * 预设按 id 挂接；未知 id 不动。
 */
const PRESET_PREREQS = Object.freeze({
  "ai-kp-3": {
    requires: {
      scene: "三层书房",
      entryEvidence: ["进入书房", "进到书房", "走进书房", "踏进书房", "迈入书房", "来到书房内"],
    },
  },
  "ai-kp-4": {
    requires: { checkpointGroups: [["chk-3", "chk-4"], ["chk-5", "chk-6"]] },
  },
  "ai-kp-5": {
    requires: { sanityEventIds: ["chk-9"] },
  },
  "ai-kp-6": {
    requiresAnyOf: [
      { keyPointIds: ["ai-kp-7"] },
      { branchChoiceIds: ["ai-br-3"] },
    ],
  },
  "ai-kp-7": {
    requires: { checkpointGroups: [["chk-13"]] },
  },
  "ai-kp-8": {
    requires: { keyPointIds: ["ai-kp-7"], branchChoiceIds: ["ai-br-3"] },
  },
  "ai-br-2": {
    requires: { sanityEventIds: ["chk-9"] },
    autoChooseLabel: "掀开地毯查看",
  },
});

/**
 * 给预设里的关键点/分支按 id 挂接结构化前置条件（原地修改 patch）。
 * @param {object} patch
 * @returns {object} patch
 */
export function attachPresetPrerequisites(patch) {
  for (const kp of patch.keyPoints ?? []) {
    const prereq = PRESET_PREREQS[kp?.id];
    if (prereq === undefined || prereq === null) continue;
    if (prereq.requires !== undefined) kp.requires = structuredCloneSafe(prereq.requires);
    if (prereq.requiresAnyOf !== undefined) kp.requiresAnyOf = prereq.requiresAnyOf.map((group) => structuredCloneSafe(group));
  }
  for (const branch of patch.branches ?? []) {
    const prereq = PRESET_PREREQS[branch?.id];
    if (prereq === undefined || prereq === null) continue;
    if (prereq.requires !== undefined) branch.requires = structuredCloneSafe(prereq.requires);
    if (prereq.autoChooseLabel !== undefined) branch.autoChooseLabel = prereq.autoChooseLabel;
  }
  return patch;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 取第一个非 AI 调查员（没有则创建最小调查员）。
 * @param {object} flat
 * @returns {object}
 */
export function firstPlayerCharacter(flat) {
  const chars = Array.isArray(flat.characters) ? flat.characters : (flat.characters = []);
  let pc =
    chars.find((character) => character.aiControlled !== true) ??
    chars[0] ??
    null;
  if (pc === null) {
    pc = {
      name: "伊芙琳",
      occupation: "记者",
      aiControlled: false,
      stats: { STR: 55, DEX: 60, CON: 50, APP: 60, POW: 65, SIZ: 50, INT: 70, EDU: 65 },
      skills: { 侦查: 60, 图书馆使用: 60, 智力: 70, 意志: 65 },
      hp: 11,
      san: 65,
      mp: 13,
      luck: 55,
      inventory: [],
    };
    chars.push(pc);
  }
  return pc;
}

/**
 * 设置第一个调查员的物品栏（原地替换）。
 * @param {object} flat
 * @param {string[]} inventory
 */
function setInventory(flat, inventory) {
  const pc = firstPlayerCharacter(flat);
  pc.inventory = inventory.slice();
  return pc.inventory;
}

/**
 * 各剧情点预设：返回需要覆盖到 flat 的字段。
 * 数组字段整体替换，不合并。
 */
export const STORY_PRESETS = Object.freeze({
  /** 开场：一层门厅，委托已接，尚未发现墨渍/书房。 */
  arrival: () => ({
    currentScene: "一层门厅",
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
      keyPointPatch("ai-kp-1", "委托到来", "导入", true),
      keyPointPatch("ai-kp-2", "发现一层墨渍", "一层门厅", false),
      keyPointPatch("ai-kp-3", "进入书房", "三层书房", false),
      keyPointPatch("ai-kp-4", "发现日记与手稿", "三层书房", false),
      keyPointPatch("ai-kp-5", "发现墨渊", "三层书房", false),
      keyPointPatch("ai-kp-6", "克罗斯临终提示", "三层书房", false),
      keyPointPatch("ai-kp-7", "拼凑十二字咒文", "三层书房", false),
      keyPointPatch("ai-kp-8", "最终抉择", "三层书房/结局", false),
    ],
    branches: [
      branchPatch("ai-br-1", "如何进入书房", "三层书房", false, null, [
        { label: "撞门", leadsTo: "三层书房" },
        { label: "撬锁", leadsTo: "三层书房" },
        { label: "寻找备用钥匙", leadsTo: "三层书房" },
      ]),
      branchPatch("ai-br-2", "是否掀开地毯", "三层书房", false, null, [
        { label: "掀开地毯查看", leadsTo: "发现墨渊" },
      ]),
      branchPatch("ai-br-3", "最终咒文念诵方式", "三层书房/结局", false, null, [
        { label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" },
        { label: "正序念诵（请神）", leadsTo: "夏拉卡拉布降临的结局" },
      ]),
    ],
    inventory: [],
  }),

  /** 三层书房门外：撞门分支已选，等待力量门禁。 */
  door: () => ({
    currentScene: "三层书房门外",
    currentBranchId: "ai-br-1",
    endingReached: false,
    endedAt: null,
    spellShown: false,
    pendingChecks: [
      { id: "preset-door-str", skill: "力量", difficulty: "regular", action: "继续撞门，直到撞开为止", hidden: false, source: "story-preset" },
    ],
    pendingChoice: null,
    resolvedChecks: [],
    passedCheckpointIds: [],
    sanitySettled: [],
    skippedChecks: [],
    firedNightEventIds: [],
    keyPoints: [
      keyPointPatch("ai-kp-1", "委托到来", "导入", true),
      keyPointPatch("ai-kp-2", "发现一层墨渍", "一层门厅", false),
      keyPointPatch("ai-kp-3", "进入书房", "三层书房", false),
      keyPointPatch("ai-kp-4", "发现日记与手稿", "三层书房", false),
      keyPointPatch("ai-kp-5", "发现墨渊", "三层书房", false),
      keyPointPatch("ai-kp-6", "克罗斯临终提示", "三层书房", false),
      keyPointPatch("ai-kp-7", "拼凑十二字咒文", "三层书房", false),
      keyPointPatch("ai-kp-8", "最终抉择", "三层书房/结局", false),
    ],
    branches: [
      branchPatch("ai-br-1", "如何进入书房", "三层书房", true, "撞门", [
        { label: "撞门", leadsTo: "三层书房" },
        { label: "撬锁", leadsTo: "三层书房" },
        { label: "寻找备用钥匙", leadsTo: "三层书房" },
      ]),
      branchPatch("ai-br-2", "是否掀开地毯", "三层书房", false, null, [
        { label: "掀开地毯查看", leadsTo: "发现墨渊" },
      ]),
      branchPatch("ai-br-3", "最终咒文念诵方式", "三层书房/结局", false, null, [
        { label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" },
        { label: "正序念诵（请神）", leadsTo: "夏拉卡拉布降临的结局" },
      ]),
    ],
    inventory: [],
  }),

  /** 已进入三层书房：ai-kp-3 已揭示，门禁清空。 */
  "study-entered": () => ({
    currentScene: "三层书房",
    currentBranchId: "ai-br-1",
    endingReached: false,
    endedAt: null,
    spellShown: false,
    pendingChecks: [],
    pendingChoice: null,
    resolvedChecks: ["力量::继续撞门，直到撞开为止"],
    passedCheckpointIds: [],
    sanitySettled: [],
    skippedChecks: [],
    firedNightEventIds: [],
    keyPoints: [
      keyPointPatch("ai-kp-1", "委托到来", "导入", true),
      keyPointPatch("ai-kp-2", "发现一层墨渍", "一层门厅", false),
      keyPointPatch("ai-kp-3", "进入书房", "三层书房", true),
      keyPointPatch("ai-kp-4", "发现日记与手稿", "三层书房", false),
      keyPointPatch("ai-kp-5", "发现墨渊", "三层书房", false),
      keyPointPatch("ai-kp-6", "克罗斯临终提示", "三层书房", false),
      keyPointPatch("ai-kp-7", "拼凑十二字咒文", "三层书房", false),
      keyPointPatch("ai-kp-8", "最终抉择", "三层书房/结局", false),
    ],
    branches: [
      branchPatch("ai-br-1", "如何进入书房", "三层书房", true, "撞门", [
        { label: "撞门", leadsTo: "三层书房" },
        { label: "撬锁", leadsTo: "三层书房" },
        { label: "寻找备用钥匙", leadsTo: "三层书房" },
      ]),
      branchPatch("ai-br-2", "是否掀开地毯", "三层书房", false, null, [
        { label: "掀开地毯查看", leadsTo: "发现墨渊" },
      ]),
      branchPatch("ai-br-3", "最终咒文念诵方式", "三层书房/结局", false, null, [
        { label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" },
        { label: "正序念诵（请神）", leadsTo: "夏拉卡拉布降临的结局" },
      ]),
    ],
    inventory: [],
  }),

  /** 已找到日记与四张手稿：ai-kp-4 揭示，日记/手稿检定点通过。 */
  "diary-found": () => ({
    currentScene: "三层书房",
    currentBranchId: "ai-br-1",
    endingReached: false,
    endedAt: null,
    spellShown: false,
    pendingChecks: [],
    pendingChoice: null,
    resolvedChecks: [
      "图书馆使用::完全拉开书桌抽屉，取出并清点其中的日记与成套纸张",
    ],
    passedCheckpointIds: ["chk-3", "chk-4", "chk-5", "chk-6"],
    sanitySettled: [],
    skippedChecks: [],
    firedNightEventIds: [],
    keyPoints: [
      keyPointPatch("ai-kp-1", "委托到来", "导入", true),
      keyPointPatch("ai-kp-2", "发现一层墨渍", "一层门厅", false),
      keyPointPatch("ai-kp-3", "进入书房", "三层书房", true),
      keyPointPatch("ai-kp-4", "发现日记与手稿", "三层书房", true),
      keyPointPatch("ai-kp-5", "发现墨渊", "三层书房", false),
      keyPointPatch("ai-kp-6", "克罗斯临终提示", "三层书房", false),
      keyPointPatch("ai-kp-7", "拼凑十二字咒文", "三层书房", false),
      keyPointPatch("ai-kp-8", "最终抉择", "三层书房/结局", false),
    ],
    branches: [
      branchPatch("ai-br-1", "如何进入书房", "三层书房", true, "撞门", [
        { label: "撞门", leadsTo: "三层书房" },
        { label: "撬锁", leadsTo: "三层书房" },
        { label: "寻找备用钥匙", leadsTo: "三层书房" },
      ]),
      branchPatch("ai-br-2", "是否掀开地毯", "三层书房", false, null, [
        { label: "掀开地毯查看", leadsTo: "发现墨渊" },
      ]),
      branchPatch("ai-br-3", "最终咒文念诵方式", "三层书房/结局", false, null, [
        { label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" },
        { label: "正序念诵（请神）", leadsTo: "夏拉卡拉布降临的结局" },
      ]),
    ],
    inventory: ["克罗斯的日记", "四张手稿"],
  }),

  /** 已确认地毯接缝（chk-7 通过），但尚未掀开/目击墨渊。 */
  "rug-revealed": () => ({
    currentScene: "三层书房",
    currentBranchId: "ai-br-1",
    endingReached: false,
    endedAt: null,
    spellShown: false,
    pendingChecks: [],
    pendingChoice: null,
    resolvedChecks: [
      "图书馆使用::完全拉开书桌抽屉，取出并清点其中的日记与成套纸张",
      "侦查::用尺边从书房门槛处插入地毯边缘，撬起一角查看下面",
    ],
    passedCheckpointIds: ["chk-3", "chk-4", "chk-5", "chk-6", "chk-7"],
    sanitySettled: [],
    skippedChecks: [],
    firedNightEventIds: [],
    keyPoints: [
      keyPointPatch("ai-kp-1", "委托到来", "导入", true),
      keyPointPatch("ai-kp-2", "发现一层墨渍", "一层门厅", false),
      keyPointPatch("ai-kp-3", "进入书房", "三层书房", true),
      keyPointPatch("ai-kp-4", "发现日记与手稿", "三层书房", true),
      keyPointPatch("ai-kp-5", "发现墨渊", "三层书房", false),
      keyPointPatch("ai-kp-6", "克罗斯临终提示", "三层书房", false),
      keyPointPatch("ai-kp-7", "拼凑十二字咒文", "三层书房", false),
      keyPointPatch("ai-kp-8", "最终抉择", "三层书房/结局", false),
    ],
    branches: [
      branchPatch("ai-br-1", "如何进入书房", "三层书房", true, "撞门", [
        { label: "撞门", leadsTo: "三层书房" },
        { label: "撬锁", leadsTo: "三层书房" },
        { label: "寻找备用钥匙", leadsTo: "三层书房" },
      ]),
      branchPatch("ai-br-2", "是否掀开地毯", "三层书房", false, null, [
        { label: "掀开地毯查看", leadsTo: "发现墨渊" },
      ]),
      branchPatch("ai-br-3", "最终咒文念诵方式", "三层书房/结局", false, null, [
        { label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" },
        { label: "正序念诵（请神）", leadsTo: "夏拉卡拉布降临的结局" },
      ]),
    ],
    inventory: ["克罗斯的日记", "四张手稿"],
  }),

  /** 已拼出十二字咒文（chk-13 通过）：ai-kp-6/7 揭示，咒文已展示。 */
  "spell-decoded": () => ({
    currentScene: "三层书房",
    currentBranchId: "ai-br-1",
    endingReached: false,
    endedAt: null,
    spellShown: true,
    pendingChecks: [],
    pendingChoice: null,
    resolvedChecks: [
      "图书馆使用::完全拉开书桌抽屉，取出并清点其中的日记与成套纸张",
      "侦查::用尺边从书房门槛处插入地毯边缘，撬起一角查看下面",
      "智力::翻出日记与手稿，尝试解读其中日期与字位的规律",
    ],
    passedCheckpointIds: ["chk-3", "chk-4", "chk-5", "chk-6", "chk-7", "chk-13"],
    sanitySettled: [],
    skippedChecks: [],
    firedNightEventIds: [],
    keyPoints: [
      keyPointPatch("ai-kp-1", "委托到来", "导入", true),
      keyPointPatch("ai-kp-2", "发现一层墨渍", "一层门厅", false),
      keyPointPatch("ai-kp-3", "进入书房", "三层书房", true),
      keyPointPatch("ai-kp-4", "发现日记与手稿", "三层书房", true),
      keyPointPatch("ai-kp-5", "发现墨渊", "三层书房", false),
      keyPointPatch("ai-kp-6", "克罗斯临终提示", "三层书房", true),
      keyPointPatch("ai-kp-7", "拼凑十二字咒文", "三层书房", true),
      keyPointPatch("ai-kp-8", "最终抉择", "三层书房/结局", false),
    ],
    branches: [
      branchPatch("ai-br-1", "如何进入书房", "三层书房", true, "撞门", [
        { label: "撞门", leadsTo: "三层书房" },
        { label: "撬锁", leadsTo: "三层书房" },
        { label: "寻找备用钥匙", leadsTo: "三层书房" },
      ]),
      branchPatch("ai-br-2", "是否掀开地毯", "三层书房", false, null, [
        { label: "掀开地毯查看", leadsTo: "发现墨渊" },
      ]),
      branchPatch("ai-br-3", "最终咒文念诵方式", "三层书房/结局", false, null, [
        { label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" },
        { label: "正序念诵（请神）", leadsTo: "夏拉卡拉布降临的结局" },
      ]),
    ],
    inventory: ["克罗斯的日记", "四张手稿"],
  }),

  /** 最终仪式轮：最终分支已选，等待意志门禁。 */
  "final-rite": () => ({
    currentScene: "三层书房",
    currentBranchId: "ai-br-3",
    endingReached: false,
    endedAt: null,
    spellShown: true,
    pendingChecks: [
      { id: "preset-final-will", skill: "意志", difficulty: "regular", action: "在巨眼的注视下继续吟诵咒文", hidden: false, source: "story-preset" },
    ],
    pendingChoice: null,
    resolvedChecks: [
      "图书馆使用::完全拉开书桌抽屉，取出并清点其中的日记与成套纸张",
      "侦查::用尺边从书房门槛处插入地毯边缘，撬起一角查看下面",
      "智力::翻出日记与手稿，尝试解读其中日期与字位的规律",
    ],
    passedCheckpointIds: ["chk-3", "chk-4", "chk-5", "chk-6", "chk-7", "chk-13"],
    sanitySettled: [{ eventId: "scenario:chk-9", player: "伊芙琳" }],
    skippedChecks: [],
    firedNightEventIds: [],
    keyPoints: [
      keyPointPatch("ai-kp-1", "委托到来", "导入", true),
      keyPointPatch("ai-kp-2", "发现一层墨渍", "一层门厅", false),
      keyPointPatch("ai-kp-3", "进入书房", "三层书房", true),
      keyPointPatch("ai-kp-4", "发现日记与手稿", "三层书房", true),
      keyPointPatch("ai-kp-5", "发现墨渊", "三层书房", true),
      keyPointPatch("ai-kp-6", "克罗斯临终提示", "三层书房", true),
      keyPointPatch("ai-kp-7", "拼凑十二字咒文", "三层书房", true),
      keyPointPatch("ai-kp-8", "最终抉择", "三层书房/结局", true),
    ],
    branches: [
      branchPatch("ai-br-1", "如何进入书房", "三层书房", true, "撞门", [
        { label: "撞门", leadsTo: "三层书房" },
        { label: "撬锁", leadsTo: "三层书房" },
        { label: "寻找备用钥匙", leadsTo: "三层书房" },
      ]),
      branchPatch("ai-br-2", "是否掀开地毯", "三层书房", true, "掀开地毯查看", [
        { label: "掀开地毯查看", leadsTo: "发现墨渊" },
      ]),
      branchPatch("ai-br-3", "最终咒文念诵方式", "三层书房/结局", true, "逆序念诵（送神）", [
        { label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" },
        { label: "正序念诵（请神）", leadsTo: "夏拉卡拉布降临的结局" },
      ]),
    ],
    inventory: ["克罗斯的日记", "四张手稿"],
  }),
});

/**
 * 应用剧情点预设到 flat（原地修改，并返回 flat）。
 * 数组字段整体替换；角色属性、剧本、规则等字段保留。
 * @param {object} flat
 * @param {string} presetName
 * @returns {object} flat
 */
export function applyStoryPreset(flat, presetName) {
  const factory = STORY_PRESETS[presetName];
  if (factory === undefined) {
    throw new Error(`未知剧情点预设：${presetName}（可用：${STORY_PRESET_NAMES.join(" / ")}）`);
  }
  const patch = attachPresetPrerequisites(factory());
  for (const [key, value] of Object.entries(patch)) {
    flat[key] = Array.isArray(value) ? value.slice() : value;
  }
  // 物品栏写入第一个调查员，并保留其它角色不动。
  if (patch.inventory !== undefined) {
    setInventory(flat, patch.inventory);
  }
  flat.updatedAt = new Date().toISOString();
  return flat;
}

/**
 * 把当前 flat 导出为可复用的测试夹具（与预设同一批字段），
 * 便于把 E2E 失败现场固化成 unit/replay 测试的初始状态。
 * @param {object} flat
 * @returns {object}
 */
export function exportStoryFixture(flat) {
  const pc = firstPlayerCharacter(flat);
  return {
    exportedAt: new Date().toISOString(),
    currentScene: flat.currentScene ?? "",
    currentBranchId: flat.currentBranchId ?? "",
    endingReached: flat.endingReached === true,
    endedAt: flat.endedAt ?? null,
    spellShown: flat.spellShown === true,
    pendingChecks: (flat.pendingChecks ?? []).map((gate) => ({ ...gate })),
    pendingChoice: flat.pendingChoice === null || flat.pendingChoice === undefined ? null : { ...flat.pendingChoice },
    resolvedChecks: (flat.resolvedChecks ?? []).slice(),
    passedCheckpointIds: (flat.passedCheckpointIds ?? []).slice(),
    sanitySettled: (flat.sanitySettled ?? []).map((entry) => ({ ...entry })),
    skippedChecks: (flat.skippedChecks ?? []).map((entry) => ({ ...entry })),
    firedNightEventIds: (flat.firedNightEventIds ?? []).slice(),
    keyPoints: (flat.keyPoints ?? []).map((kp) => ({
      id: kp.id,
      title: kp.title,
      scene: kp.scene,
      revealed: kp.revealed === true,
      ...(kp.requires !== undefined ? { requires: structuredCloneSafe(kp.requires) } : {}),
      ...(kp.requiresAnyOf !== undefined ? { requiresAnyOf: structuredCloneSafe(kp.requiresAnyOf) } : {}),
    })),
    branches: (flat.branches ?? []).map((branch) => ({
      id: branch.id,
      title: branch.title,
      scene: branch.scene,
      reached: branch.reached === true,
      chosen: branch.chosen ?? null,
      options: (branch.options ?? []).map((option) => ({ ...option })),
      ...(branch.requires !== undefined ? { requires: structuredCloneSafe(branch.requires) } : {}),
      ...(branch.requiresAnyOf !== undefined ? { requiresAnyOf: structuredCloneSafe(branch.requiresAnyOf) } : {}),
      ...(branch.autoChooseLabel !== undefined ? { autoChooseLabel: branch.autoChooseLabel } : {}),
    })),
    inventory: Array.isArray(pc?.inventory) ? pc.inventory.slice() : [],
  };
}

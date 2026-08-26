/**
 * Scenario IR（中间表示）数据结构
 *
 * 剧本导入后解析为 ScenarioModel，供 Plot Graph、Clue Graph、
 * Director 和 Trigger Engine 使用。
 *
 * 设计原则：
 * - 不是固定顺序的章节列表
 * - 场景、NPC、物品、线索、分支、Trigger 都是独立的一级对象
 * - 通过 preconditions / leadsTo / relatedTo 连接
 * - 支持多种结局
 */

/**
 * 创建一个空的 ScenarioModel
 * @param {string} name - 剧本名称
 * @returns {object}
 */
export function createScenarioModel(name) {
  return {
    name: name ?? "未命名剧本",
    source: "unknown", // "file" | "text" | "builtin"
    rawText: "",
    summary: "",
    chars: 0,
    lines: 0,

    /** @type {Array<ScenarioScene>} */
    scenes: [],

    /** @type {Array<ScenarioNPC>} */
    npcs: [],

    /** @type {Array<ScenarioItem>} */
    items: [],

    /** @type {Array<ScenarioLocation>} */
    locations: [],

    /** @type {Array<ScenarioOrg>} */
    orgs: [],

    /** @type {Array<ScenarioClue>} */
    clues: [],

    /** @type {Array<ScenarioPlotNode>} */
    plotNodes: [],

    /** @type {Array<ScenarioBranch>} */
    branches: [],

    /** @type {Array<ScenarioTrigger>} */
    triggers: [],

    /** @type {Array<ScenarioEnding>} */
    endings: [],

    /** @type {Array<ScenarioHiddenFact>} */
    hiddenFacts: [],
  };
}

// ── 子结构 ────────────────────────────────────────────────

/**
 * 场景
 * @typedef {object} ScenarioScene
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} npcIds - 此场景出现的 NPC
 * @property {string[]} itemIds - 此场景中的物品
 * @property {string[]} locationIds - 子地点
 * @property {string[]} clueIds - 可在此场景发现的线索
 * @property {string[]} plotNodeIds - 关联的剧情节点
 * @property {string[]} ambientEvents - 环境描述/事件
 */

/**
 * NPC
 * @typedef {object} ScenarioNPC
 * @property {string} id
 * @property {string} name
 * @property {string} role - "major"|"minor"|"background"
 * @property {string} description
 * @property {string} motivation - NPC 动机
 * @property {string[]} secrets - NPC 知道的秘密
 * @property {string[]} clueIds - NPC 掌握的线索
 * @property {string} initialAttitude - 初始态度
 * @property {string[]} scenes - 出现场景
 */

/**
 * 物品
 * @typedef {object} ScenarioItem
 * @property {string} id
 * @property {string} name
 * @property {string} type - "clue-item"|"weapon"|"tool"|"document"|"artifact"|"other"
 * @property {string} description
 * @property {string[]} clueIds - 物品关联的线索
 * @property {string[]} locationIds - 物品所在位置
 * @property {boolean} isCritical - 是否关键物品
 */

/**
 * 地点
 * @typedef {object} ScenarioLocation
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} connectedTo - 连接的地点 ID
 * @property {string[]} itemIds - 地点中的物品
 * @property {string[]} npcIds - 地点中的 NPC
 */

/**
 * 组织
 * @typedef {object} ScenarioOrg
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} role - 组织在剧情中的角色
 */

/**
 * 线索
 * @typedef {object} ScenarioClue
 * @property {string} id
 * @property {string} description - 线索内容
 * @property {string[]} acquisitionMethods - 获取方式 ["侦查", "聆听", "NPC对话:老管家", ...]
 * @property {string[]} relatedEntityIds - 关联实体
 * @property {string[]} leadsTo - 能推导出的线索 ID
 * @property {string[]} fallbackMethods - 替代获取方式
 * @property {boolean} isCritical - 是否关键线索
 * @property {string} category - "physical"|"testimonial"|"documentary"|"deductive"
 */

/**
 * 剧情节点
 * @typedef {object} ScenarioPlotNode
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} type - "scene"|"event"|"revelation"|"confrontation"|"climax"
 * @property {string[]} preconditions - 前置条件（Flag 或线索 ID）
 * @property {string[]} leadsTo - 激活后解锁的节点 ID
 * @property {string} scene - 所属场景
 * @property {string} [timeConstraint] - 时间限制
 */

/**
 * 分支
 * @typedef {object} ScenarioBranch
 * @property {string} id
 * @property {string} title
 * @property {string} scene
 * @property {string} description
 * @property {Array<{label: string, leadsTo: string, consequences: string[]}>} options
 */

/**
 * Trigger
 * @typedef {object} ScenarioTrigger
 * @property {string} id
 * @property {string} condition - 触发条件描述
 * @property {string} conditionType - "flag"|"time"|"entity_state"|"clue"|"scene"
 * @property {string} conditionValue - 条件值
 * @property {string} action - 触发动作
 * @property {string} actionTarget - 动作目标 ID
 */

/**
 * 结局
 * @typedef {object} ScenarioEnding
 * @property {string} id
 * @property {string} title
 * @property {string} type - "true"|"good"|"mixed"|"bad"|"catastrophic"
 * @property {string} description
 * @property {string[]} requirements - 达成条件
 * @property {string[]} blockers - 阻止条件
 */

/**
 * 隐藏事实
 * @typedef {object} ScenarioHiddenFact
 * @property {string} id
 * @property {string} fact - 事实内容
 * @property {string} category - "secret"|"mythos"|"backstory"|"twist"
 * @property {string[]} revealedBy - 揭示条件（线索 ID 或剧情节点 ID）
 * @property {boolean} isRevealed - 是否已揭示
 */
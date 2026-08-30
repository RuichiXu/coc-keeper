/**
 * CoC Core 层统一导出
 *
 * 所有 Core 模块均不依赖 DeepSeek Harness。
 * 可在任何 JS 环境中使用。
 */

// 接口
export { SceneMode } from "./interfaces.js";

// 事件系统
export {
  EventBus,
  EventLog,
  EVENT_REQUIRED_FIELDS,
  GAME_EVENT_TYPES,
  GAME_EVENT_TYPE_SET,
  createGameEvent,
  validateGameEvent,
} from "./events.js";

// 骰点引擎
export {
  TIER_LABELS,
  DIFFICULTY_LABELS,
  parseDiceExpression,
  rollDice,
  roll,
  evaluateCoC,
  passedFor,
  performRoll,
  renderRollLine,
} from "./dice.js";

// 文档提取
export {
  readZipEntry,
  extractDocxText,
  extractDocLegacyText,
  extractFileText,
} from "./docx-extract.js";

// 人物解析
export {
  STAT_ALIASES,
  STAT_KEYS,
  parseCharacters,
  normalizeCharacter,
} from "./character-parser.js";

// 游戏时钟
export {
  parseGameTime,
  formatGameTime,
  advanceGameTime,
  minutesBetween,
  isAfter,
  isBefore,
} from "./clock.js";

// 世界状态
export { WorldState } from "./state/index.js";

// 规则引擎
export {
  performSanityCheck,
  parseSanLoss,
  rollExpr,
  evaluateTemporaryMadness,
  evaluateIndefiniteMadness,
  learnCthulhuMythos,
  recoverSanity,
  performCombatRound,
  dbExpression,
  rollDb,
  rollInitiative,
  evaluateWoundState,
  resolveArmor,
  performSkillGrowth,
} from "./rules/index.js";

// 剧本编译器
export {
  createScenarioModel,
  compileByPattern,
  extractStoryIntro,
  buildAiParsePrompt,
  parseAiResult,
  mergeModels,
  toLegacyFormat,
  splitScenarioSections,
  classifyFloor,
  classifyCheckpointFloor,
  collectKeywords,
  extractSceneFacts,
  extractCheckpoints,
  selectSceneFacts,
  inferSceneFromText,
  CHECKPOINT_MATCH_KEYS,
  buildRoomFloorRules,
  findRoomFloorConflict,
  SCENARIO_CONTRACT_VERSION,
  createScenarioContract,
  normalizeScenarioContract,
  validateScenarioContract,
  draftScenarioContract,
  ensureScenarioContract,
  buildContractAiPrompt,
  parseContractAiResult,
} from "./scenario/index.js";

// 剧情图
export { PlotGraph, applyConsequences, computeStoryFrontier, storyFrontierText } from "./plot/index.js";

// 线索图
export { ClueGraph } from "./clue/index.js";

// 会话容器与持久化
export { GameSession, JsonFilePersistence } from "./session/index.js";

// Knowledge 分层
export {
  KNOWLEDGE_LAYERS,
  isRollVisible,
  filterRolls,
  filterKeyPoints,
  filterBranches,
  filterReminders,
  filterEntities,
  sanitizeMetaText,
  buildKnowledgeView,
} from "./knowledge/index.js";

// Context Builder
export {
  buildKpSystemPrompt,
  buildLoopMessages,
  buildContext,
  renderStatusText,
  renderRollLineForState,
} from "./context/index.js";

// Trigger Engine
export {
  TRIGGER_TYPES,
  evaluateTrigger,
  evaluateTriggers,
  evaluatePrerequisites,
  evaluateRequiresAnyOf,
  prerequisitesSatisfied,
  prerequisiteContextFromState,
  remindersToTriggers,
  pendingReminders,
  TriggerEngine,
} from "./trigger/index.js";

// Director
export {
  parseAssistantBlocks,
  decideNext,
  buildToolResultMessages,
  parseToolArguments,
  buildAssistantContent,
} from "./director/index.js";

// Narrator
export {
  isNarrationComplete,
  formatNarration,
  clampNarration,
  makeKpLogEntry,
  makeUserLogEntry,
} from "./narrator/index.js";

// Game Clock 定时事件
export {
  isTimeReached,
  evaluateScheduledEvents,
  createScheduledEvent,
  fireScheduledEvent,
  formatScheduledEvent,
} from "./clock-scheduler.js";

// 结局可达性
export {
  reachableNodes,
  endingCandidates,
  analyzeReachability,
  summarizeReachability,
} from "./plot/reachability.js";

// Narrative Recovery
export {
  isBusyStale,
  buildRecoveryPrompt,
  hasMissingNarration,
  summarizeToolTrace,
} from "./recovery/index.js";

// 全局资产库
export { ASSET_KINDS, AssetStore, slugify, assetIdFor } from "./assets/index.js";
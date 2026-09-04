/**
 * Scenario 模块统一导出
 */
export { createScenarioModel } from "./model.js";
export {
  compileByPattern,
  extractStoryIntro,
  buildAiParsePrompt,
  parseAiResult,
  mergeModels,
  toLegacyFormat,
} from "./compiler.js";
export {
  splitScenarioSections,
  classifyFloor,
  classifyCheckpointFloor,
  collectKeywords,
  extractSceneFacts,
  extractCheckpoints,
  selectSceneFacts,
  inferSceneFromText,
  hasSceneMovementPhrase,
  inferSceneTransition,
  CHECKPOINT_MATCH_KEYS,
  buildRoomFloorRules,
  findRoomFloorConflict,
} from "./scene-facts.js";
export {
  SCENARIO_CONTRACT_VERSION,
  createScenarioContract,
  normalizeScenarioContract,
  validateScenarioContract,
} from "./contract.js";
export {
  draftScenarioContract,
  ensureScenarioContract,
} from "./contract-draft.js";
export {
  buildContractAiPrompt,
  parseContractAiResult,
} from "./contract-ai.js";
export {
  DEEP_PARSE_VERSION,
  applyConfirmedDeepParse,
  buildDeepParsePrompt,
  buildDeepParseTwoStagePrompts,
  buildSkeletonWiringPrompt,
  canonicalizeCondition,
  canonicalizeDeepParse,
  collectDeepParseTargets,
  combineDeepParseParts,
  detectDeadEndScenes,
  extractJsonObject,
  mergeDeepParseDraft,
  normalizeDeepParse,
  parseDeepParseResult,
  parseSkeletonWiringResult,
  repairSkeletonWiringDeepParse,
  runDeepParsePreflight,
  syncPlotGraphFromDeepParse,
  validateConditionObject,
  validateDeepParse,
  validatePrerequisitePair,
} from "./deep-parse.js";

export {
  buildCheckpointBranches,
  buildDeterministicSkeleton,
} from "./deterministic-skeleton.js";

export {
  STRUCTURE_KINDS,
  FLOW_ROLES,
  cleanScenarioText,
  buildStructureAnalysisPrompt,
  parseStructureAnalysisResult,
  computeSectionTexts,
  applyStructureAnalysis,
  applyStructureEdits,
  applyDeterministicStructureFallback,
  buildStructureWindowPlan,
  buildStructureWindowPrompt,
  parseStructureWindowResult,
  mergeStructureWindowResults,
} from "./structure-analysis.js";

export { renderPdfPages } from "./pdf-pages.js";

export { extractFinalChoiceBranches } from "./final-branch-extractor.js";

export {
  splitDeepParseChunks,
  buildChunkPrompt,
  buildChunkReviewPrompt,
  buildChunkRevisionPrompt,
  buildFinalWiringPrompt,
  extractEndingParagraphs,
  mergeChunkedDeepParseParts,
} from "./chunked-deep-parse.js";

export { conditionSignature, runDeepParseRuleReview } from "./deep-parse-review.js";

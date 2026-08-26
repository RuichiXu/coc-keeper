/**
 * Rule Engine 统一导出
 *
 * 所有规则引擎模块均返回事件，不直接修改状态。
 */
export { performSanityCheck, parseSanLoss, rollExpr } from "./sanity.js";
export { performCombatRound, dbExpression, rollDb } from "./combat.js";
export { performSkillGrowth } from "./skill-growth.js";
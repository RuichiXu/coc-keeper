/**
 * CoC Core 层接口定义
 *
 * 使用 JSDoc 标注类型，实际为纯 JS 模块。
 * 所有接口均不依赖 DeepSeek Harness 的任何包。
 *
 * 原则：
 * - Core 不 import 任何 DSH 包
 * - Core 通过接口表达外部依赖
 * - Adapter 是 Core 和 DSH 之间的唯一桥梁
 */

// ── 场景模式 ──────────────────────────────────────────────

/** @enum {string} */
export const SceneMode = Object.freeze({
  FreeRoleplay: "free-roleplay",
  Investigation: "investigation",
  Combat: "combat",
  Chase: "chase",
  Downtime: "downtime",
  InsanityEpisode: "insanity-episode",
  SpecialScene: "special-scene",
});
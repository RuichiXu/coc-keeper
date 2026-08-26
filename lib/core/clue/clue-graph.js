/**
 * Clue Graph 模块
 *
 * 线索是 CoC 调查玩法的核心，应作为一级游戏对象管理。
 *
 * 职责：
 * - 线索定义与存储
 * - 线索获取方式管理
 * - 线索之间的推导关系
 * - 关键线索的替代获取路径
 * - 线索对不同角色的可见性
 *
 * 核心原则：
 * - 关键剧情信息应允许存在多个合理获得路径
 * - 一次侦查失败不应导致唯一关键线索永久丢失
 * - 线索可见性可区分不同角色
 */

// ── ClueGraph 类 ──────────────────────────────────────────

export class ClueGraph {
  /** @type {Array<Clue>} */
  clues;
  /** @type {Map<string, string[]>} */ // clueId → [prerequisite clueIds]
  dependencies;
  /** @type {Map<string, string[]>} */ // clueId → [deducible info]
  revelations;

  /**
   * @param {object} [opts]
   */
  constructor(opts = {}) {
    this.clues = opts.clues ?? [];
    this.dependencies = new Map(Object.entries(opts.dependencies ?? {}));
    this.revelations = new Map(Object.entries(opts.revelations ?? {}));
  }

  // ── 线索管理 ──────────────────────────────────────────

  /**
   * 添加线索定义
   * @param {object} clue
   * @returns {object}
   */
  addClue(clue) {
    const id = clue.id ?? `clue-${this.clues.length + 1}`;
    if (this.clues.some((c) => c.id === id)) {
      throw new Error(`线索 ${id} 已存在`);
    }
    const entry = {
      id,
      description: clue.description ?? "",
      acquisitionMethods: clue.acquisitionMethods ?? [],
      relatedEntities: clue.relatedEntities ?? [],
      isCritical: clue.isCritical === true,
      visibility: new Map(), // characterName → "hidden"|"revealed"|"known"
      leadsTo: clue.leadsTo ?? [],
      fallbackMethods: clue.fallbackMethods ?? [],
      category: clue.category ?? "physical",
      revealedAt: null,
      revealedBy: null,
    };
    this.clues.push(entry);
    return entry;
  }

  /**
   * 查找线索
   * @param {string} id
   * @returns {object|undefined}
   */
  findClue(id) {
    return this.clues.find((c) => c.id === id);
  }

  /**
   * 获取所有关键线索
   * @returns {Array<object>}
   */
  getCriticalClues() {
    return this.clues.filter((c) => c.isCritical);
  }

  // ── 可见性 ────────────────────────────────────────────

  /**
   * 揭示线索（对指定角色）
   * @param {string} clueId
   * @param {string} characterName - 发现者
   * @param {string} method - 获取方式
   */
  revealClue(clueId, characterName, method = "") {
    const clue = this.findClue(clueId);
    if (!clue) throw new Error(`线索 ${clueId} 不存在`);

    clue.visibility.set(characterName, "revealed");
    if (!clue.revealedAt) {
      clue.revealedAt = new Date().toISOString();
      clue.revealedBy = characterName;
    }

    // 如果线索能推导出其他线索，自动揭示
    const derived = this.revelations.get(clueId) ?? [];
    for (const derivedId of derived) {
      const derivedClue = this.findClue(derivedId);
      if (derivedClue && !derivedClue.visibility.has(characterName)) {
        derivedClue.visibility.set(characterName, "revealed");
      }
    }

    return clue;
  }

  /**
   * 标记线索为已知（角色已理解线索含义）
   * @param {string} clueId
   * @param {string} characterName
   */
  markKnown(clueId, characterName) {
    const clue = this.findClue(clueId);
    if (!clue) throw new Error(`线索 ${clueId} 不存在`);
    clue.visibility.set(characterName, "known");
    return clue;
  }

  /**
   * 检查线索对某角色是否可见
   * @param {string} clueId
   * @param {string} [characterName] - 不传则检查是否已被任何人揭示
   * @returns {boolean}
   */
  isVisible(clueId, characterName) {
    const clue = this.findClue(clueId);
    if (!clue) return false;
    if (!characterName) return clue.revealedAt !== null;
    const vis = clue.visibility.get(characterName);
    return vis === "revealed" || vis === "known";
  }

  /**
   * 获取某角色可见的所有线索
   * @param {string} characterName
   * @returns {Array<object>}
   */
  getVisibleClues(characterName) {
    return this.clues.filter((c) => {
      const vis = c.visibility.get(characterName);
      return vis === "revealed" || vis === "known";
    });
  }

  /**
   * 获取某角色尚未发现的线索
   * @param {string} characterName
   * @returns {Array<object>}
   */
  getHiddenClues(characterName) {
    return this.clues.filter((c) => {
      const vis = c.visibility.get(characterName);
      return vis !== "revealed" && vis !== "known";
    });
  }

  // ── 替代路径 ──────────────────────────────────────────

  /**
   * 为关键线索获取替代获取方式。
   * 当主获取方式失败时，Director 可调用此方法获得备选方案。
   *
   * @param {string} clueId
   * @returns {Array<string>} 替代获取方式列表
   */
  getFallbackMethods(clueId) {
    const clue = this.findClue(clueId);
    if (!clue) return [];
    return clue.fallbackMethods ?? [];
  }

  /**
   * 为关键线索添加替代获取方式（运行时动态添加）。
   * @param {string} clueId
   * @param {string} method
   */
  addFallbackMethod(clueId, method) {
    const clue = this.findClue(clueId);
    if (!clue) throw new Error(`线索 ${clueId} 不存在`);
    if (!clue.fallbackMethods) clue.fallbackMethods = [];
    if (!clue.fallbackMethods.includes(method)) {
      clue.fallbackMethods.push(method);
    }
    return clue;
  }

  // ── 推导关系 ──────────────────────────────────────────

  /**
   * 设置线索推导关系：发现 clueId 后自动揭示 derivedClueIds
   * @param {string} clueId
   * @param {string[]} derivedClueIds
   */
  setRevelation(clueId, derivedClueIds) {
    this.revelations.set(clueId, derivedClueIds);
  }

  /**
   * 设置线索前置依赖：必须先发现 prerequisiteIds 才能发现 clueId
   * @param {string} clueId
   * @param {string[]} prerequisiteIds
   */
  setDependency(clueId, prerequisiteIds) {
    this.dependencies.set(clueId, prerequisiteIds);
  }

  // ── 摘要 ──────────────────────────────────────────────

  /**
   * 生成 Clue Graph 摘要（用于 LLM Context）
   * @param {string} [characterName] - 按角色过滤可见性
   * @returns {object}
   */
  digest(characterName) {
    const visible = characterName ? this.getVisibleClues(characterName) : this.clues;
    const hidden = characterName ? this.getHiddenClues(characterName) : [];

    return {
      totalClues: this.clues.length,
      visibleCount: visible.length,
      hiddenCount: hidden.length,
      criticalTotal: this.getCriticalClues().length,
      criticalHidden: this.getCriticalClues().filter(
        (c) => !characterName || !this.isVisible(c.id, characterName)
      ).length,
      revealed: visible.map((c) => ({
        id: c.id,
        description: c.description,
        category: c.category,
        isCritical: c.isCritical,
      })),
    };
  }

  /**
   * 导出为纯对象
   * @returns {object}
   */
  toJSON() {
    return {
      clues: this.clues.map((c) => ({
        ...c,
        visibility: Array.from(c.visibility.entries()),
      })),
      dependencies: Object.fromEntries(this.dependencies),
      revelations: Object.fromEntries(this.revelations),
    };
  }

  /**
   * 从纯对象恢复
   * @param {object} data
   * @returns {ClueGraph}
   */
  static fromJSON(data) {
    const clues = (data.clues ?? []).map((c) => {
      const { visibility, ...rest } = c;
      return {
        ...rest,
        visibility: new Map(visibility ?? []),
      };
    });
    return new ClueGraph({
      clues,
      dependencies: data.dependencies ?? {},
      revelations: data.revelations ?? {},
    });
  }
}
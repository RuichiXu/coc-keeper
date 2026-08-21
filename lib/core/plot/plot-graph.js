/**
 * Plot Graph 模块
 *
 * 职责：
 * - 维护剧情节点图（节点 + 边）
 * - 计算 Plot Frontier（当前可达但未完成的节点集）
 * - 管理节点的激活、完成、阻塞状态
 * - 处理分支选择和场景推进
 *
 * 核心概念：
 * - Plot Frontier ≠ 单一"下一个剧情点"
 * - Frontier 是当前情况下合理可达的多个剧情方向
 * - 玩家即使偏离预设路线，游戏仍可继续运行
 */

// ── PlotGraph 类 ──────────────────────────────────────────

export class PlotGraph {
  /** @type {Array<PlotNode>} */
  nodes;
  /** @type {Array<PlotEdge>} */
  edges;
  /** @type {string} */
  currentBranchId;

  /**
   * @param {object} [opts]
   */
  constructor(opts = {}) {
    this.nodes = opts.nodes ?? [];
    this.edges = opts.edges ?? [];
    this.currentBranchId = opts.currentBranchId ?? "";
  }

  // ── 节点操作 ──────────────────────────────────────────

  /**
   * 添加剧情节点
   * @param {object} node
   */
  addNode(node) {
    const id = node.id ?? `pn-${this.nodes.length + 1}`;
    if (this.nodes.some((n) => n.id === id)) {
      throw new Error(`剧情节点 ${id} 已存在`);
    }
    const entry = {
      id,
      title: node.title ?? "未命名",
      type: node.type ?? "event",
      description: node.description ?? "",
      scene: node.scene ?? "",
      preconditions: node.preconditions ?? [],
      timeConstraint: node.timeConstraint ?? null,
      status: node.status ?? "inactive", // inactive | active | completed | blocked
      leadsTo: node.leadsTo ?? [],
      activatedAt: node.activatedAt ?? null,
      completedAt: node.completedAt ?? null,
      outcome: node.outcome ?? null,
    };
    this.nodes.push(entry);
    return entry;
  }

  /**
   * 查找节点
   * @param {string} id
   * @returns {object|undefined}
   */
  findNode(id) {
    return this.nodes.find((n) => n.id === id);
  }

  /**
   * 激活节点（标记为可达）
   * @param {string} id
   * @param {string} [activatedBy=""] - 激活原因
   * @returns {object}
   */
  activateNode(id, activatedBy = "") {
    const node = this.findNode(id);
    if (!node) throw new Error(`剧情节点 ${id} 不存在`);
    if (node.status === "completed") {
      // 已完成节点不再激活
      return node;
    }
    node.status = "active";
    node.activatedAt = new Date().toISOString();
    node.activatedBy = activatedBy;
    return node;
  }

  /**
   * 完成节点
   * @param {string} id
   * @param {string} [outcome=""] - 完成结果
   * @returns {object}
   */
  completeNode(id, outcome = "") {
    const node = this.findNode(id);
    if (!node) throw new Error(`剧情节点 ${id} 不存在`);
    node.status = "completed";
    node.completedAt = new Date().toISOString();
    node.outcome = outcome;

    // 激活后继节点
    for (const nextId of node.leadsTo) {
      const next = this.findNode(nextId);
      if (next && next.status === "inactive") {
        this.activateNode(nextId, `完成节点「${node.title}」`);
      }
    }

    return node;
  }

  /**
   * 阻塞节点（条件不满足）
   * @param {string} id
   * @param {string} [reason=""]
   * @returns {object}
   */
  blockNode(id, reason = "") {
    const node = this.findNode(id);
    if (!node) throw new Error(`剧情节点 ${id} 不存在`);
    node.status = "blocked";
    node.blockedReason = reason;
    return node;
  }

  // ── Frontier 计算 ─────────────────────────────────────

  /**
   * 获取 Plot Frontier：当前活跃（可达但未完成）的节点。
   * @returns {Array<object>}
   */
  getFrontier() {
    return this.nodes.filter((n) => n.status === "active");
  }

  /**
   * 获取当前场景中的 Frontline 节点。
   * @param {string} currentScene
   * @returns {Array<object>}
   */
  getFrontierInScene(currentScene) {
    return this.nodes.filter(
      (n) =>
        n.status === "active" &&
        (n.scene === currentScene || n.scene === "")
    );
  }

  /**
   * 获取所有未完成节点。
   * @returns {Array<object>}
   */
  getIncomplete() {
    return this.nodes.filter((n) => n.status !== "completed");
  }

  /**
   * 获取所有被阻塞节点。
   * @returns {Array<object>}
   */
  getBlocked() {
    return this.nodes.filter((n) => n.status === "blocked");
  }

  // ── 条件检查 ──────────────────────────────────────────

  /**
   * 根据 World State 检查节点前置条件。
   * 如果条件满足，自动激活节点。
   *
   * @param {object} worldState - WorldState 实例
   * @returns {Array<object>} 新激活的节点
   */
  checkPreconditions(worldState) {
    const newlyActivated = [];

    for (const node of this.nodes) {
      if (node.status !== "inactive") continue;

      const allMet = this._checkPreconditions(node, worldState);
      if (allMet) {
        this.activateNode(node.id, "前置条件满足");
        newlyActivated.push(node);
      }
    }

    return newlyActivated;
  }

  /**
   * 检查单个节点的前置条件
   * @param {object} node
   * @param {object} worldState
   * @returns {boolean}
   * @private
   */
  _checkPreconditions(node, worldState) {
    if (!node.preconditions || node.preconditions.length === 0) {
      return true;
    }

    for (const cond of node.preconditions) {
      if (typeof cond === "string") {
        // 字符串条件：检查 Flag 或线索
        if (cond.startsWith("flag:")) {
          const flagKey = cond.slice(5);
          if (!worldState.hasFlag(flagKey)) return false;
        } else if (cond.startsWith("clue:")) {
          const clueId = cond.slice(5);
          if (!worldState.isClueDiscovered(clueId)) return false;
        } else if (cond.startsWith("scene:")) {
          const sceneName = cond.slice(6);
          if (worldState.currentScene !== sceneName) return false;
        } else {
          // 默认作为 Flag 检查
          if (!worldState.hasFlag(cond)) return false;
        }
      } else if (typeof cond === "object" && cond !== null) {
        // 对象条件：{ type: "flag"|"clue"|"scene"|"entity_state", key, value }
        if (cond.type === "flag" && !worldState.hasFlag(cond.key)) return false;
        if (cond.type === "clue" && !worldState.isClueDiscovered(cond.key)) return false;
        if (cond.type === "scene" && worldState.currentScene !== cond.key) return false;
      }
    }

    return true;
  }

  // ── 分支操作 ──────────────────────────────────────────

  /**
   * 标记抵达分支
   * @param {string} branchId
   */
  reachedBranch(branchId) {
    this.currentBranchId = branchId;
  }

  /**
   * 在分支中选择选项
   * @param {string} branchId
   * @param {string} optionLabel
   * @param {string} [nextScene=""]
   */
  chooseBranch(branchId, optionLabel, nextScene = "") {
    this.currentBranchId = "";
    return { branchId, optionLabel, nextScene };
  }

  // ── 摘要 ──────────────────────────────────────────────

  /**
   * 生成 Plot Graph 摘要（用于 LLM Context）
   * @returns {object}
   */
  digest() {
    return {
      totalNodes: this.nodes.length,
      activeCount: this.getFrontier().length,
      completedCount: this.nodes.filter((n) => n.status === "completed").length,
      blockedCount: this.getBlocked().length,
      frontier: this.getFrontier().map((n) => ({
        id: n.id,
        title: n.title,
        type: n.type,
        scene: n.scene,
      })),
      currentBranchId: this.currentBranchId,
    };
  }

  /**
   * 导出为纯对象
   * @returns {object}
   */
  toJSON() {
    return {
      nodes: this.nodes,
      edges: this.edges,
      currentBranchId: this.currentBranchId,
    };
  }

  /**
   * 从纯对象恢复
   * @param {object} data
   * @returns {PlotGraph}
   */
  static fromJSON(data) {
    return new PlotGraph(data);
  }
}
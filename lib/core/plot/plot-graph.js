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
      requires: node.requires ?? [],
      consequences: node.consequences ?? null,
      timeConstraint: node.timeConstraint ?? null,
      status: node.status ?? "inactive", // inactive | active | completed | blocked
      leadsTo: node.leadsTo ?? [],
      activatedAt: node.activatedAt ?? null,
      completedAt: node.completedAt ?? null,
      outcome: node.outcome ?? null,
      missing: node.missing ?? [],
    };
    this.nodes.push(entry);
    return entry;
  }

  /**
   * 添加一条有向边（带进入条件与后果）。
   * @param {string} fromId
   * @param {string} toId
   * @param {object} [opts]
   * @param {string} [opts.label]
   * @param {Array<object|string>} [opts.requires]
   * @param {object|null} [opts.consequences]
   * @returns {object}
   */
  addEdge(fromId, toId, opts = {}) {
    const id = opts.id ?? `e-${this.edges.length + 1}`;
    if (this.edges.some((edge) => edge.id === id)) {
      return this.edges.find((edge) => edge.id === id);
    }
    // 同向同目标去重（如同一分支选项重复同步）。
    const duplicate = this.edges.find((edge) => edge.from === fromId && edge.to === toId && edge.label === (opts.label ?? ""));
    if (duplicate !== undefined) return duplicate;
    const entry = {
      id,
      from: fromId,
      to: toId,
      label: opts.label ?? "",
      requires: opts.requires ?? [],
      consequences: opts.consequences ?? null,
    };
    this.edges.push(entry);
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

  /**
   * 从 flat 剧情结构同步节点与边（关键点 → keypoint 节点，分支 → branch 节点，
   * 分支选项指向关键点的 leadsTo → 边）。不删除已存在节点，只更新状态与标题。
   * @param {object} story - { keyPoints, branches }
   * @returns {{ nodes: number, edges: number }}
   */
  syncFromStory(story) {
    const keyPoints = story?.keyPoints ?? [];
    const branches = story?.branches ?? [];

    for (const kp of keyPoints) {
      const id = `kp:${kp.id}`;
      let node = this.findNode(id);
      if (node === undefined) {
        node = this.addNode({ id, title: kp.title, type: "keypoint", scene: kp.scene ?? "" });
      }
      node.title = kp.title ?? node.title;
      node.scene = kp.scene ?? node.scene;
      node.kpId = kp.id;
      node.status = kp.revealed === true ? "completed" : node.status === "completed" ? "completed" : "inactive";
    }

    for (const branch of branches) {
      const id = `br:${branch.id}`;
      let node = this.findNode(id);
      if (node === undefined) {
        node = this.addNode({ id, title: branch.title, type: "branch", scene: branch.scene ?? "" });
      }
      node.title = branch.title ?? node.title;
      node.scene = branch.scene ?? node.scene;
      node.branchId = branch.id;
      node.status =
        String(branch.chosen ?? "").length > 0 ? "completed" :
        branch.reached === true ? "active" : "inactive";
    }

    for (const branch of branches) {
      for (const option of branch.options ?? []) {
        const leadsTo = String(option?.leadsTo ?? "").trim();
        if (leadsTo.length === 0) continue;
        const targetKp = keyPoints.find((kp) =>
          String(kp.title ?? "").trim() === leadsTo ||
          String(kp.title ?? "").trim().includes(leadsTo) ||
          leadsTo.includes(String(kp.title ?? "").trim())
        );
        if (targetKp !== undefined) {
          this.addEdge(`br:${branch.id}`, `kp:${targetKp.id}`, {
            label: option.label ?? "",
            requires: [],
          });
        }
      }
    }

    return { nodes: this.nodes.length, edges: this.edges.length };
  }

  /**
   * 把可达路线集合写回节点状态（active=可达，blocked=缺条件）。
   * @param {Array<object>} routes - computeStoryFrontier 的结果
   * @returns {PlotGraph}
   */
  applyStoryFrontier(routes) {
    for (const route of routes ?? []) {
      const node = this.findNode(`kp:${route.id}`);
      if (node === undefined) continue;
      node.status = route.status === "active" ? "active" : "blocked";
      node.missing = route.missing ?? [];
      node.requiresSummary = route.requiresSummary ?? "";
    }
    return this;
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

// ── 可达路线集合（C-3：程序算“哪条路通、缺什么”）──────────

function sanitySettledFor(sanitySettled, checkpointId) {
  const id = String(checkpointId ?? "");
  if (id.length === 0) return false;
  return (sanitySettled ?? []).some((entry) => {
    const eventId = String(entry?.eventId ?? "");
    return eventId.includes(id) || eventId === `scenario:${id}`;
  });
}

/**
 * 检查单个条件组是否满足，并把缺失项写入 missing。
 * 供 frontier 计算使用（不处理 entryEvidence：进门证据是回合级条件，不属于路线级）。
 * @param {object|undefined} group
 * @param {object} ctx
 * @param {string[]} missing
 * @returns {boolean}
 */
function checkFrontierGroup(group, ctx, missing) {
  if (group === undefined || group === null || typeof group !== "object") return true;
  const ok = true;

  if (group.scene !== undefined && group.scene !== null) {
    const scene = String(group.scene ?? "").trim();
    if (scene.length > 0 && String(ctx.currentScene ?? "").trim() !== scene) {
      missing.push(`场景：${scene}`);
      return false;
    }
  }

  const checkpointGroups = Array.isArray(group.checkpointGroups) ? group.checkpointGroups : [];
  if (checkpointGroups.length > 0) {
    const passed = new Set((ctx.passedCheckpointIds ?? []).map(String));
    let allGroupsOk = true;
    for (const rawGroup of checkpointGroups) {
      const ids = Array.isArray(rawGroup) ? rawGroup : [rawGroup];
      if (ids.length > 0 && !ids.some((id) => passed.has(String(id)))) {
        missing.push(`检定点：${ids.join(" 或 ")}`);
        allGroupsOk = false;
      }
    }
    if (!allGroupsOk) return false;
  }

  const sanityEventIds = Array.isArray(group.sanityEventIds) ? group.sanityEventIds : [];
  if (sanityEventIds.length > 0 && !sanityEventIds.some((id) => sanitySettledFor(ctx.sanitySettled, id))) {
    missing.push(`SAN 结算：${sanityEventIds.join(" 或 ")}`);
    return false;
  }

  const keyPointIds = Array.isArray(group.keyPointIds) ? group.keyPointIds : [];
  if (keyPointIds.length > 0) {
    const revealed = new Set((ctx.keyPoints ?? []).filter((kp) => kp?.revealed === true).map((kp) => String(kp.id)));
    for (const id of keyPointIds) {
      if (!revealed.has(String(id))) {
        missing.push(`关键点：${id}`);
        return false;
      }
    }
  }

  const branchChoiceIds = Array.isArray(group.branchChoiceIds) ? group.branchChoiceIds : [];
  if (branchChoiceIds.length > 0) {
    const chosen = new Set(
      (ctx.branches ?? []).filter((branch) => branch?.reached === true && String(branch?.chosen ?? "").length > 0).map((branch) => String(branch.id))
    );
    for (const id of branchChoiceIds) {
      if (!chosen.has(String(id))) {
        missing.push(`分支选择：${id}`);
        return false;
      }
    }
  }

  return ok;
}

/**
 * 计算当前可达路线集合（frontier）。
 * 只包含带结构化前置条件且未揭示的关键点；无结构条件的关键点走叙述兜底，不进路线集合。
 * @param {object} flat - { keyPoints, branches, currentScene, passedCheckpointIds, sanitySettled }
 * @returns {Array<object>} 路线：{ id, title, scene, status, missing, requiresSummary }
 */
export function computeStoryFrontier(flat) {
  const ctx = {
    keyPoints: flat?.keyPoints ?? [],
    branches: flat?.branches ?? [],
    currentScene: flat?.currentScene ?? "",
    passedCheckpointIds: flat?.passedCheckpointIds ?? [],
    sanitySettled: flat?.sanitySettled ?? [],
  };
  const routes = [];
  for (const kp of ctx.keyPoints) {
    if (kp?.revealed === true) continue;
    if (kp?.requires === undefined && kp?.requiresAnyOf === undefined) continue;

    const missing = [];
    const baseOk = checkFrontierGroup(kp.requires, ctx, missing);
    let anyOk = true;
    if (kp.requiresAnyOf !== undefined) {
      anyOk = false;
      const anyMissing = [];
      for (const group of kp.requiresAnyOf ?? []) {
        const groupMissing = [];
        if (checkFrontierGroup(group, ctx, groupMissing)) {
          anyOk = true;
          break;
        }
        anyMissing.push(groupMissing.join("、"));
      }
      if (!anyOk) {
        missing.push(`任一：${anyMissing.join("；")}`);
      }
    }

    const status = baseOk && anyOk ? "active" : "blocked";
    routes.push({
      id: kp.id,
      title: kp.title ?? "",
      scene: kp.scene ?? "",
      status,
      missing,
      requiresSummary: `${status === "active" ? "可推进" : `缺 ${missing.join("；")}`}`,
    });
  }
  return routes;
}

/**
 * 把路线集合渲染成可注入 KP 提示 / 调试面板的文本。
 * @param {Array<object>} routes
 * @param {number} [limit=6]
 * @returns {string}
 */
export function storyFrontierText(routes, limit = 6) {
  const list = routes ?? [];
  if (list.length === 0) return "";
  const shown = list.slice(0, limit);
  const lines = shown.map((route) => {
    const scene = route.scene ? `（${route.scene}）` : "";
    const state = route.status === "active" ? "✓可推进" : "✗未解锁";
    return `- ${route.title}${scene} ${state}${route.missing.length > 0 ? `：缺 ${route.missing.join("；")}` : ""}`;
  });
  if (list.length > limit) lines.push(`（另有 ${list.length - limit} 条路线未列出）`);
  return lines.join("\n");
}
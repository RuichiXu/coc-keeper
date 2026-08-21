/**
 * Ending Reachability（结局可达性分析）
 *
 * 纯函数，零 DSH 依赖。
 * 结局候选 = 没有 leadsTo 的剧情节点（叶子节点）。
 * 可达 = 从当前活跃节点沿 leadsTo 边可以到达的节点集合。
 */

/**
 * 计算从起始节点可达的节点 id 集合（BFS）。
 * @param {object} plot - PlotGraph 实例（或 { nodes, edges } 兼容对象）
 * @param {Array<string>} startIds
 * @returns {Set<string>}
 */
export function reachableNodes(plot, startIds) {
  const nodes = plot?.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    for (const nextId of node?.leadsTo ?? []) {
      if (!seen.has(nextId) && byId.has(nextId)) queue.push(nextId);
    }
  }
  return seen;
}

/**
 * 找出结局候选节点（叶子节点）。
 * @param {object} plot
 * @returns {Array<object>}
 */
export function endingCandidates(plot) {
  return (plot?.nodes ?? []).filter((node) => (node.leadsTo ?? []).length === 0);
}

/**
 * 分析结局可达性。
 * @param {object} plot - PlotGraph 实例
 * @returns {{
 *   totalNodes: number,
 *   activeNodes: Array<object>,
 *   reachableIds: Set<string>,
 *   unreachableIds: Array<string>,
 *   endings: Array<object>,
 *   reachableEndings: Array<object>,
 *   anyEndingReachable: boolean,
 *   blockedEndings: Array<object>
 * }}
 */
export function analyzeReachability(plot) {
  const nodes = plot?.nodes ?? [];
  const activeNodes = nodes.filter((n) => n.status === "active");
  const reachableIds = reachableNodes(plot, activeNodes.map((n) => n.id));
  const endings = endingCandidates(plot);
  const reachableEndings = endings.filter((e) => reachableIds.has(e.id));
  const blockedEndings = endings.filter((e) => e.status === "blocked");
  const unreachableIds = nodes.filter((n) => !reachableIds.has(n.id) && n.status !== "completed").map((n) => n.id);

  return {
    totalNodes: nodes.length,
    activeNodes,
    reachableIds,
    unreachableIds,
    endings,
    reachableEndings,
    anyEndingReachable: reachableEndings.length > 0,
    blockedEndings,
  };
}

/**
 * 生成结局可达性的人话摘要。
 * @param {object} plot
 * @returns {string}
 */
export function summarizeReachability(plot) {
  const analysis = analyzeReachability(plot);
  if (analysis.totalNodes === 0) return "（无剧情节点）";
  const parts = [];
  if (analysis.reachableEndings.length > 0) {
    parts.push(`结局可达：${analysis.reachableEndings.map((e) => e.title).join("、")}`);
  } else if (analysis.blockedEndings.length > 0) {
    parts.push(`结局全部被阻塞：${analysis.blockedEndings.map((e) => e.title).join("、")}`);
  } else if (analysis.endings.length > 0) {
    parts.push(`结局尚未可达：${analysis.endings.map((e) => e.title).join("、")}`);
  } else {
    parts.push("未定义结局节点（剧情图没有叶子节点）");
  }
  if (analysis.unreachableIds.length > 0) {
    parts.push(`${analysis.unreachableIds.length} 个节点当前不可达`);
  }
  return parts.join("；");
}

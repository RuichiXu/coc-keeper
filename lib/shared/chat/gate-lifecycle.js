/**
 * 门禁生命周期（Gate Lifecycle）
 *
 * 门禁的清理规则集中在这里，供聊天桥与状态工具（coc_scene）共用：
 * - 场景失效：门禁登记时绑定的 scene 已切走时移入 skippedChecks。
 * - 全量废弃：结局达成等场景下废弃全部待处理门禁。
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */

function nowDefault() {
  return new Date().toISOString();
}

/**
 * 场景失效门禁清理（前缀精确匹配版）。
 *
 * 规则：门禁 scene 为空或“导入”时永不因场景失效；当前场景与门禁 scene 必须
 * 互为前缀（“三层书房”保留“三层书房·仪式终结”，但“三层书房门外”在进入
 * “三层书房”后失效）。旧的 includes 双向包含会误保留“三层书房门外”这种
 * 子串关系，已废弃。
 *
 * 纯函数（不落盘），返回移除数量。
 * @param {object} flat
 * @param {string} currentScene
 * @param {string} [now] - ISO 时间，默认当前时间
 * @returns {number}
 */
export function expireSceneGates(flat, currentScene, now = nowDefault()) {
  const scene = String(currentScene ?? "").trim();
  if (scene.length === 0) return 0;
  const pending = Array.isArray(flat.pendingChecks) ? flat.pendingChecks : (flat.pendingChecks = []);
  if (pending.length === 0) return 0;
  const skipped = Array.isArray(flat.skippedChecks) ? flat.skippedChecks : (flat.skippedChecks = []);
  let removed = 0;
  flat.pendingChecks = pending.filter((gate) => {
    const gateScene = String(gate?.scene ?? "").trim();
    if (gateScene.length === 0 || gateScene === "导入") return true;
    if (gateScene === scene) return true;
    // 当前场景是门禁场景的子场景（“三层书房”→“三层书房·仪式终结”）时保留；
    // 但“三层书房门外”不是“三层书房”的子场景（门外/门口/外 后缀），
    // 旧的 includes 双向包含会把“门外”误保留。
    if (scene.startsWith(gateScene)) {
      const rest = scene.slice(gateScene.length);
      if (!/^(?:门外|门口|外部|外面|外)/.test(rest)) return true;
    }
    skipped.push({ ...gate, skippedAt: now, reason: "scene-invalid" });
    removed += 1;
    return false;
  });
  if (skipped.length > 80) flat.skippedChecks = skipped.slice(-80);
  else flat.skippedChecks = skipped;
  return removed;
}

/**
 * 废弃全部待处理门禁（结局达成/终局短路等场景）。
 * @param {object} flat
 * @param {string} reason - 废弃原因
 * @param {string} [now] - ISO 时间，默认当前时间
 * @returns {number}
 */
export function abandonAllGates(flat, reason, now = nowDefault()) {
  const pending = Array.isArray(flat.pendingChecks) ? flat.pendingChecks : (flat.pendingChecks = []);
  if (pending.length === 0) return 0;
  const skipped = Array.isArray(flat.skippedChecks) ? flat.skippedChecks : (flat.skippedChecks = []);
  for (const gate of pending) skipped.push({ ...gate, skippedAt: now, reason });
  flat.pendingChecks = [];
  if (skipped.length > 80) flat.skippedChecks = skipped.slice(-80);
  else flat.skippedChecks = skipped;
  return pending.length;
}

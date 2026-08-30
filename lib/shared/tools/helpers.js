/**
 * Adapter 工具共享 helpers
 *
 * 每个新工具都遵循：
 *   loadSession(deps, gameId) → { session, flat }
 *   ... 操作 session.world / session.plot / session.clues ...
 *   commitSession(deps, gameId, session, flat, events?)
 *
 * WorldState 是运行期唯一事实来源；flat 字段是给旧前端/聊天桥的兼容投影。
 */

// ── 基础工具 ──────────────────────────────────────────────

export function safeGameId(id) {
  const clean = String(id)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean.slice(0, 64) : "default";
}

export function gameIdOf(args, defaultGame) {
  return typeof args?.game === "string" && args.game.trim().length > 0
    ? args.game.trim()
    : defaultGame;
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * 生成工具内部 ID（如 entity / task）。
 * @param {string} prefix
 * @param {Array<object>} existing
 * @param {string} [idField="id"]
 * @returns {string}
 */
export function nextId(prefix, existing, idField = "id") {
  let max = 0;
  for (const item of existing) {
    const id = String(item[idField] ?? "");
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

// ── Session 加载 / 提交 ───────────────────────────────────

/**
 * 从持久化加载 GameSession。
 * flat 为 null 时创建空状态（首次运行）。
 * @param {object} deps - { session, persistence, stateKey, defaultGame, maxRollHistory }
 * @param {string} gameId
 * @returns {{ session: object, flat: object }}
 */
export function loadSession(deps, gameId) {
  const key = deps.stateKey(gameId);
  let flat = deps.persistence.load(key);
  if (flat === null) {
    flat = {
      id: safeGameId(gameId),
      title: gameId,
      updatedAt: nowIso(),
      kpMode: "ai",
      rules: null,
      scenario: null,
      characters: [],
      keyPoints: [],
      branches: [],
      currentScene: "",
      currentBranchId: "",
      time: "",
      synopsis: "",
      tasks: [],
      entities: [],
      log: [],
      toolTrace: [],
      rollHistory: [],
      reminders: [],
      pendingChecks: [],
      skippedChecks: [],
      sanitySettled: [],
      scenarioFacts: [],
      scenarioCheckpoints: [],
      events: [],
    };
  }

  deps.session.id = safeGameId(gameId);
  deps.session.syncFromFlat(flat);
  deps.session.hydrateCore(flat.core);
  return { session: deps.session, flat };
}

/**
 * 提交 GameSession：应用事件 → 投影 WorldState 到 flat 兼容字段 → 保存 core。
 * @param {object} deps
 * @param {string} gameId
 * @param {object} session
 * @param {object} flat
 * @param {Array<object>} [events=[]]
 * @returns {object} flat
 */
export function commitSession(deps, gameId, session, flat, events = []) {
  // C-1：先把旧工具/聊天桥直接改在 flat 上的剧情执行账本收进 WorldState，
  // 再应用本轮事件，最后统一投影回 flat，保证 WorldState 是持久化的唯一账本。
  session.world.hydratePlotFields(flat);
  for (const event of events) {
    const stamped = session.applyEvent(event);
    session.recordTrace({ kind: "event", type: event.type, eventId: stamped.id });
  }

  projectToFlat(session, flat, deps.maxRollHistory ?? 200);
  flat.core = session.toJSON();
  flat.updatedAt = nowIso();
  deps.persistence.save(deps.stateKey(gameId), flat);
  return flat;
}

/**
 * 将 WorldState 投影到旧 flat 字段（兼容旧前端 / 聊天桥）。
 * @param {object} session
 * @param {object} flat
 * @param {number} maxRollHistory
 */
export function projectToFlat(session, flat, maxRollHistory = 200) {
  const world = session.world;
  flat.id = world.id;
  flat.title = world.title;
  flat.kpMode = world.kpMode;
  flat.scenarioId = session.scenarioId ?? null;
  flat.currentScene = world.currentScene;
  flat.time = world.time;
  flat.synopsis = world.synopsis;
  flat.characters = world.characters;
  flat.entities = world.entities;
  flat.tasks = world.tasks;
  flat.rollHistory = world.rollHistory.slice(-maxRollHistory);
  flat.scheduledEvents = world.scheduledEvents ?? [];
  flat.events = world.events.slice(-2000);
  // C-1：剧情执行账本字段从 WorldState 投影（flat 不再单独维护这些字段）。
  flat.currentBranchId = world.currentBranchId ?? "";
  flat.pendingChecks = world.pendingChecks ?? [];
  flat.skippedChecks = world.skippedChecks ?? [];
  flat.resolvedChecks = world.resolvedChecks ?? [];
  flat.passedCheckpointIds = world.passedCheckpointIds ?? [];
  flat.sanitySettled = world.sanitySettled ?? [];
  flat.keyPoints = world.keyPoints ?? [];
  flat.branches = world.branches ?? [];
  flat.spellShown = world.spellShown === true;
  flat.endingReached = world.endingReached === true;
  flat.endedAt = world.endedAt ?? null;
  flat.firedNightEventIds = world.firedNightEventIds ?? [];
  // reminders/log/toolTrace 仍由旧前端维护（WorldState 暂不接管）
  return flat;
}

// ── 事件构造 ──────────────────────────────────────────────

/**
 * 构造 RollPerformed 事件。
 */
export function rollEvent(gameId, opts) {
  return {
    type: "RollPerformed",
    at: nowIso(),
    gameId,
    kind: opts.kind ?? "open",
    player: opts.player ?? "",
    label: opts.label ?? "",
    skill: opts.skill ?? "",
    expression: opts.expression ?? "d100",
    dice: opts.dice ?? [],
    rolled: opts.rolled ?? 0,
    total: opts.total ?? opts.rolled ?? 0,
    target: opts.target ?? null,
    difficulty: opts.difficulty ?? "regular",
    tier: opts.tier ?? null,
    passed: opts.passed ?? null,
  };
}

/**
 * 构造 StateChanged 事件（角色状态）。
 */
export function characterStateEvent(gameId, characterName, changes) {
  return {
    type: "StateChanged",
    at: nowIso(),
    gameId,
    target: characterName,
    changes,
  };
}

// ── C-1 事件目录构造器 ────────────────────────────────────

export function checkpointPassedEvent(gameId, checkpointId, opts = {}) {
  return {
    type: "CheckpointPassed",
    at: opts.at ?? nowIso(),
    gameId,
    checkpointId,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
    ...(opts.skill !== undefined ? { skill: opts.skill } : {}),
    ...(opts.action !== undefined ? { action: opts.action } : {}),
  };
}

export function gateCreatedEvent(gameId, gate, opts = {}) {
  return {
    type: "GateCreated",
    at: opts.at ?? nowIso(),
    gameId,
    gateId: gate.id,
    skill: gate.skill,
    difficulty: gate.difficulty ?? "regular",
    action: gate.action ?? "",
    hidden: gate.hidden === true,
    checkpointId: gate.checkpointId ?? "",
    target: gate.target ?? "",
    scene: gate.scene ?? "",
    source: gate.source ?? "kp-tool",
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function gateResolvedEvent(gameId, gate, opts = {}) {
  return {
    type: "GateResolved",
    at: opts.at ?? nowIso(),
    gameId,
    gateId: gate?.id ?? "",
    skill: gate?.skill ?? "",
    action: gate?.action ?? "",
    checkpointId: gate?.checkpointId ?? "",
    resolvedKey: opts.resolvedKey ?? "",
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function gateFailedEvent(gameId, gate, opts = {}) {
  return {
    type: "GateFailed",
    at: opts.at ?? nowIso(),
    gameId,
    gateId: gate?.id ?? "",
    skill: gate?.skill ?? "",
    action: gate?.action ?? "",
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function gateExpiredEvent(gameId, gate, reason, opts = {}) {
  return {
    type: "GateExpired",
    at: opts.at ?? nowIso(),
    gameId,
    gateId: gate?.id ?? "",
    reason: reason ?? "scene-invalid",
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function keyPointRevealedEvent(gameId, keyPointId, opts = {}) {
  return {
    type: "KeyPointRevealed",
    at: opts.at ?? nowIso(),
    gameId,
    keyPointId,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function branchLandedEvent(gameId, branchId, chosen, opts = {}) {
  return {
    type: "BranchLanded",
    at: opts.at ?? nowIso(),
    gameId,
    branchId,
    chosen,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function spellShownEvent(gameId, opts = {}) {
  return {
    type: "SpellShown",
    at: opts.at ?? nowIso(),
    gameId,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function nightEventFiredEvent(gameId, eventId, opts = {}) {
  return {
    type: "NightEventFired",
    at: opts.at ?? nowIso(),
    gameId,
    eventId,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function endingResolvedEvent(gameId, branchId, chosen, opts = {}) {
  return {
    type: "EndingResolved",
    at: opts.at ?? nowIso(),
    gameId,
    branchId,
    chosen,
    currentScene: opts.currentScene ?? "",
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function sanitySettledEvent(gameId, player, opts = {}) {
  return {
    type: "SanitySettled",
    at: opts.at ?? nowIso(),
    gameId,
    player,
    eventId: opts.eventId ?? "",
    loss: opts.loss,
    sanBefore: opts.sanBefore,
    sanAfter: opts.sanAfter,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}

export function itemAcquiredEvent(gameId, character, item, opts = {}) {
  return {
    type: "ItemAcquired",
    at: opts.at ?? nowIso(),
    gameId,
    character,
    item,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  };
}



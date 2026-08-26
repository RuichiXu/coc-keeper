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
  for (const event of events) {
    session.applyEvent(event);
    session.recordTrace({ kind: "event", type: event.type });
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
  // keyPoints/branches/reminders/log/toolTrace 仍由旧工具/旧前端维护
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

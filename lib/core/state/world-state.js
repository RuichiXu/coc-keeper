/**
 * World State 模块
 *
 * 管理所有会长期影响游戏世界的结构化状态。
 * 这是游戏世界的唯一事实来源（区别于 LLM 的自然语言上下文）。
 *
 * 职责：
 * - 角色状态（HP/SAN/MP/LUCK/技能/装备/状态效果）
 * - 实体状态（NPC/地点/物品/组织）
 * - 当前场景与游戏时间
 * - 世界 Flag（任意键值对，用于标记世界事实）
 * - 关系（NPC 对玩家的态度等）
 * - 已发现线索
 * - 已触发事件
 *
 * 原则：
 * - 所有状态变化通过 applyEvent(event) 进行
 * - 不直接暴露可变引用
 * - 查询方法返回快照或只读视图
 */

// ── 默认值 ────────────────────────────────────────────────

const DEFAULT_STATS = {
  STR: 50, CON: 50, SIZ: 50, DEX: 50,
  INT: 50, POW: 50, APP: 50, EDU: 50,
  LUCK: 50, HP: 10, SAN: 50, MP: 10,
};

// ── WorldState 类 ─────────────────────────────────────────

export class WorldState {
  /** @type {string} */
  id;
  /** @type {string} */
  title;
  /** @type {"ai"|"human"} */
  kpMode;
  /** @type {string} */
  currentScene;
  /** @type {string} */
  time;
  /** @type {string} */
  synopsis;
  /** @type {Array<object>} */
  characters;
  /** @type {Array<object>} */
  entities;
  /** @type {Array<object>} */
  tasks;
  /** @type {Map<string, any>} */
  flags;
  /** @type {Array<object>} */
  discoveredClues;
  /** @type {Array<object>} */
  relationships;
  /** @type {Array<object>} */
  rollHistory;
  /** @type {Array<object>} */
  events;
  // ── C-1：剧情执行账本（原聊天桥 flat 散装字段） ──────────
  /** @type {string} */
  currentBranchId;
  /** @type {Array<object>} */
  pendingChecks;
  /** @type {Array<object>} */
  skippedChecks;
  /** @type {Array<string>} */
  resolvedChecks;
  /** @type {Array<string>} */
  passedCheckpointIds;
  /** @type {Array<object>} */
  sanitySettled;
  /** @type {Array<object>} */
  keyPoints;
  /** @type {Array<object>} */
  branches;
  /** @type {boolean} */
  spellShown;
  /** @type {boolean} */
  endingReached;
  /** @type {string|null} */
  endedAt;
  /** @type {Array<string>} */
  firedNightEventIds;

  /**
   * @param {object} [opts]
   */
  constructor(opts = {}) {
    this.id = opts.id ?? "default";
    this.title = opts.title ?? "default";
    this.kpMode = opts.kpMode ?? "ai";
    this.currentScene = opts.currentScene ?? "";
    this.time = opts.time ?? "";
    this.synopsis = opts.synopsis ?? "";
    this.characters = opts.characters ?? [];
    this.entities = opts.entities ?? [];
    this.tasks = opts.tasks ?? [];
    this.flags = new Map(Object.entries(opts.flags ?? {}));
    this.discoveredClues = opts.discoveredClues ?? [];
    this.relationships = opts.relationships ?? [];
    this.rollHistory = opts.rollHistory ?? [];
    this.scheduledEvents = opts.scheduledEvents ?? [];
    this.events = opts.events ?? [];
    this.currentBranchId = opts.currentBranchId ?? "";
    this.pendingChecks = opts.pendingChecks ?? [];
    this.skippedChecks = opts.skippedChecks ?? [];
    this.resolvedChecks = opts.resolvedChecks ?? [];
    this.passedCheckpointIds = opts.passedCheckpointIds ?? [];
    this.sanitySettled = opts.sanitySettled ?? [];
    this.keyPoints = opts.keyPoints ?? [];
    this.branches = opts.branches ?? [];
    this.spellShown = opts.spellShown === true;
    this.endingReached = opts.endingReached === true;
    this.endedAt = opts.endedAt ?? null;
    this.firedNightEventIds = opts.firedNightEventIds ?? [];
  }

  // ── 角色操作 ──────────────────────────────────────────

  /**
   * 查找角色（按姓名）
   * @param {string} name
   * @returns {object|undefined}
   */
  findCharacter(name) {
    return this.characters.find((c) => c.name === name);
  }

  /**
   * 查找角色（按 ID）
   * @param {string} id
   * @returns {object|undefined}
   */
  findCharacterById(id) {
    return this.characters.find((c) => c.id === id);
  }

  /**
   * 添加角色
   * @param {object} character
   */
  addCharacter(character) {
    const existing = this.findCharacter(character.name);
    if (existing) {
      // 合并更新
      Object.assign(existing, character);
      return existing;
    }
    this.characters.push(character);
    return character;
  }

  /**
   * 更新角色属性
   * @param {string} name - 角色名
   * @param {object} changes - 变更字段 { hp: 10, san: 50, ... }
   */
  updateCharacter(name, changes) {
    const pc = this.findCharacter(name);
    if (!pc) throw new Error(`角色「${name}」不存在`);
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) {
        pc[key] = value;
        // 同步 stats 中的值
        if (["hp", "san", "mp", "luck"].includes(key) && pc.stats) {
          pc.stats[key.toUpperCase()] = value;
        }
      }
    }
    return pc;
  }

  /**
   * 添加物品到角色物品栏
   * @param {string} name
   * @param {string} item
   */
  addInventoryItem(name, item) {
    const pc = this.findCharacter(name);
    if (!pc) throw new Error(`角色「${name}」不存在`);
    if (!pc.inventory) pc.inventory = [];
    if (!pc.inventory.includes(item)) pc.inventory.push(item);
    return pc;
  }

  /**
   * 从角色物品栏移除物品
   * @param {string} name
   * @param {string} item
   */
  removeInventoryItem(name, item) {
    const pc = this.findCharacter(name);
    if (!pc) throw new Error(`角色「${name}」不存在`);
    if (!pc.inventory) return pc;
    const idx = pc.inventory.indexOf(item);
    if (idx >= 0) pc.inventory.splice(idx, 1);
    return pc;
  }

  // ── 实体操作 ──────────────────────────────────────────

  /**
   * 查找实体（按 ID）
   * @param {string} id
   * @returns {object|undefined}
   */
  findEntity(id) {
    return this.entities.find((e) => e.id === id);
  }

  /**
   * 按名称查找实体
   * @param {string} name
   * @returns {object|undefined}
   */
  findEntityByName(name) {
    return this.entities.find((e) => e.name === name);
  }

  /**
   * 按类型查找实体
   * @param {string} type - "npc"|"location"|"item"|"org"|"other"
   * @returns {Array<object>}
   */
  findEntitiesByType(type) {
    return this.entities.filter((e) => e.type === type);
  }

  /**
   * 查找当前场景中的实体
   * @returns {Array<object>}
   */
  findEntitiesInScene() {
    return this.entities.filter(
      (e) => e.scene === this.currentScene || e.scene === ""
    );
  }

  /**
   * 添加实体
   * @param {object} entity - { id, type, name, desc, state, scene, source, revealed, playerDesc, playerState }
   */
  addEntity(entity) {
    const id = entity.id ?? `ent-${this.entities.length + 1}`;
    if (this.entities.some((e) => e.id === id)) {
      throw new Error(`实体 ${id} 已存在`);
    }
    const entry = {
      id,
      type: entity.type ?? "other",
      name: entity.name ?? "未命名",
      desc: entity.desc ?? "",
      state: entity.state ?? "",
      scene: entity.scene ?? this.currentScene,
      source: entity.source ?? "emergent", // authored | inferred | emergent
      revealed: entity.revealed === true,
      playerDesc: entity.playerDesc ?? "",
      playerState: entity.playerState ?? "",
    };
    this.entities.push(entry);
    return entry;
  }

  /**
   * 更新实体
   * @param {string} id
   * @param {object} changes
   */
  updateEntity(id, changes) {
    const entity = this.findEntity(id);
    if (!entity) throw new Error(`实体 ${id} 不存在`);
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) entity[key] = value;
    }
    return entity;
  }

  /**
   * 删除实体
   * @param {string} id
   */
  removeEntity(id) {
    const idx = this.entities.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(`实体 ${id} 不存在`);
    return this.entities.splice(idx, 1)[0];
  }

  // ── 场景与时间 ────────────────────────────────────────

  /**
   * 设置当前场景
   * @param {string} scene
   * @returns {{ from: string, to: string }}
   */
  setScene(scene) {
    const from = this.currentScene;
    this.currentScene = scene;
    return { from, to: scene };
  }

  /**
   * 设置游戏时间
   * @param {string} time
   */
  setTime(time) {
    this.time = time;
  }

  /**
   * 设置剧情概述
   * @param {string} synopsis
   */
  setSynopsis(synopsis) {
    this.synopsis = synopsis;
  }

  // ── Flag 操作 ─────────────────────────────────────────

  /**
   * 设置世界 Flag
   * @param {string} key
   * @param {any} value
   */
  setFlag(key, value) {
    this.flags.set(key, value);
  }

  /**
   * 移除世界 Flag
   * @param {string} key
   */
  removeFlag(key) {
    this.flags.delete(key);
  }

  /**
   * 获取世界 Flag
   * @param {string} key
   * @returns {any}
   */
  getFlag(key) {
    return this.flags.get(key);
  }

  /**
   * 检查 Flag 是否存在
   * @param {string} key
   * @returns {boolean}
   */
  hasFlag(key) {
    return Boolean(this.flags.get(key));
  }

  // ── 线索 ──────────────────────────────────────────────

  /**
   * 记录已发现线索
   * @param {object} clue - { clueId, method, character, isCritical }
   */
  discoverClue(clue) {
    if (!this.discoveredClues.some((c) => c.clueId === clue.clueId)) {
      this.discoveredClues.push({
        ...clue,
        at: new Date().toISOString(),
      });
    }
  }

  /**
   * 检查线索是否已被发现
   * @param {string} clueId
   * @returns {boolean}
   */
  isClueDiscovered(clueId) {
    return this.discoveredClues.some((c) => c.clueId === clueId);
  }

  // ── 关系 ──────────────────────────────────────────────

  /**
   * 设置 NPC 对某角色的关系
   * @param {string} npcName
   * @param {string} characterName
   * @param {string} attitude - "hostile"|"neutral"|"friendly"|"trusting"
   * @param {string} [note]
   */
  setRelationship(npcName, characterName, attitude, note = "") {
    const existing = this.relationships.find(
      (r) => r.npc === npcName && r.character === characterName
    );
    if (existing) {
      existing.attitude = attitude;
      if (note) existing.note = note;
    } else {
      this.relationships.push({
        npc: npcName,
        character: characterName,
        attitude,
        note,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * 获取 NPC 对某角色的态度
   * @param {string} npcName
   * @param {string} characterName
   * @returns {string|undefined}
   */
  getRelationship(npcName, characterName) {
    const rel = this.relationships.find(
      (r) => r.npc === npcName && r.character === characterName
    );
    return rel?.attitude;
  }

  // ── C-1：剧情执行账本操作 ──────────────────────────────

  /**
   * 从旧 flat 兼容字段吸收剧情执行账本（原地浅拷贝，不覆盖其他世界字段）。
   * 供 commitSession 在投影前调用：聊天桥/旧工具仍可直接改 flat，提交时收进 WorldState。
   * @param {object} flat
   * @returns {WorldState}
   */
  hydratePlotFields(flat) {
    if (flat === null || typeof flat !== "object") return this;
    if (flat.currentBranchId !== undefined) this.currentBranchId = flat.currentBranchId;
    if (flat.pendingChecks !== undefined) this.pendingChecks = [...flat.pendingChecks];
    if (flat.skippedChecks !== undefined) this.skippedChecks = [...flat.skippedChecks];
    if (flat.resolvedChecks !== undefined) this.resolvedChecks = [...flat.resolvedChecks];
    if (flat.passedCheckpointIds !== undefined) this.passedCheckpointIds = [...flat.passedCheckpointIds];
    if (flat.sanitySettled !== undefined) this.sanitySettled = [...flat.sanitySettled];
    if (flat.keyPoints !== undefined) this.keyPoints = [...flat.keyPoints];
    if (flat.branches !== undefined) this.branches = [...flat.branches];
    if (flat.spellShown !== undefined) this.spellShown = flat.spellShown === true;
    if (flat.endingReached !== undefined) this.endingReached = flat.endingReached === true;
    if (flat.endedAt !== undefined) this.endedAt = flat.endedAt ?? null;
    if (flat.firedNightEventIds !== undefined) this.firedNightEventIds = [...flat.firedNightEventIds];
    return this;
  }

  /** 添加待处理门禁（按 id 去重）。 */
  addPendingGate(gate) {
    const id = String(gate?.id ?? "");
    if (id.length > 0 && this.pendingChecks.some((entry) => entry.id === id)) return null;
    this.pendingChecks.push(gate);
    return gate;
  }

  /** 移除待处理门禁。 */
  removePendingGate(gateId) {
    const before = this.pendingChecks.length;
    this.pendingChecks = this.pendingChecks.filter((gate) => gate.id !== gateId);
    return before - this.pendingChecks.length;
  }

  /** 把门禁移入 skipped。 */
  skipGate(gate, reason, at = new Date().toISOString()) {
    this.removePendingGate(gate?.id);
    this.skippedChecks.push({ ...gate, skippedAt: at, reason });
    if (this.skippedChecks.length > 80) this.skippedChecks = this.skippedChecks.slice(-80);
  }

  /** 记录已通过门禁键。 */
  recordResolvedCheck(key) {
    if (!this.resolvedChecks.includes(key)) this.resolvedChecks.push(key);
    if (this.resolvedChecks.length > 120) this.resolvedChecks = this.resolvedChecks.slice(-120);
  }

  /** 记录已通过检定点。 */
  recordPassedCheckpoint(checkpointId) {
    if (!this.passedCheckpointIds.includes(checkpointId)) this.passedCheckpointIds.push(checkpointId);
  }

  /** 记录 SAN 结算。 */
  recordSanitySettled(entry) {
    this.sanitySettled.push(entry);
  }

  /** 揭示关键点。 */
  revealKeyPoint(keyPointId) {
    const kp = this.keyPoints.find((entry) => entry.id === keyPointId);
    if (kp) kp.revealed = true;
    return kp ?? null;
  }

  /** 落地分支。 */
  landBranch(branchId, chosen) {
    const branch = this.branches.find((entry) => entry.id === branchId);
    if (!branch) return null;
    branch.reached = true;
    branch.chosen = chosen ?? branch.chosen ?? "";
    if (this.currentBranchId === undefined || this.currentBranchId === null || this.currentBranchId.length === 0) {
      this.currentBranchId = branch.id;
    }
    return branch;
  }

  /** 展示咒文。 */
  markSpellShown() {
    this.spellShown = true;
  }

  /** 记录夜晚事件已触发。 */
  recordNightEventFired(eventId) {
    if (!this.firedNightEventIds.includes(eventId)) this.firedNightEventIds.push(eventId);
  }

  /** 提交结局。 */
  markEndingResolved(event) {
    this.endingReached = true;
    this.endedAt = event?.at ?? this.endedAt ?? new Date().toISOString();
    if (event?.currentScene) this.currentScene = event.currentScene;
    if (event?.branchId) this.currentBranchId = event.branchId;
  }

  // ── 事件应用 ──────────────────────────────────────────

  /**
   * 根据 GameEvent 更新 World State。
   * 这是状态变化的唯一入口。
   *
   * @param {object} event - GameEvent（必须包含 type 字段）
   */
  applyEvent(event) {
    this.events.push(event);

    switch (event.type) {
      case "RollPerformed":
        this.rollHistory.push({
          at: event.at,
          kind: event.kind,
          player: event.player,
          label: event.label,
          skill: event.skill,
          expression: event.expression,
          rolled: event.rolled,
          target: event.target,
          difficulty: event.difficulty,
          tier: event.tier,
        });
        break;

      case "DamageApplied": {
        const target = event.target ?? "";
        // 伤害目标可能是角色，也可能是实体（如 NPC 怪物）
        if (target.startsWith("entity:")) {
          const entityName = target.slice(7);
          const entity = this.findEntityByName(entityName);
          if (entity) {
            entity.state = `hp=${event.hpAfter}`;
          }
        } else {
          const pc = this.findCharacter(target);
          if (pc) {
            this.updateCharacter(target, { hp: event.hpAfter });
          }
        }
        break;
      }

      case "SanityLost": {
        const pc = this.findCharacter(event.character);
        if (pc) {
          this.updateCharacter(event.character, { san: event.sanAfter });
        }
        break;
      }

      case "StateChanged": {
        const target = event.target ?? "";
        if (target.startsWith("entity:")) {
          const entityId = target.slice(7);
          const entity = this.findEntity(entityId);
          if (entity) {
            Object.assign(entity, event.changes ?? {});
          }
        } else {
          const pc = this.findCharacter(target);
          if (pc) {
            this.updateCharacter(target, event.changes ?? {});
          }
        }
        break;
      }

      case "ClueDiscovered":
        this.discoverClue({
          clueId: event.clueId,
          method: event.method,
          character: event.character,
          isCritical: event.isCritical,
        });
        break;

      case "EntityCreated":
        this.addEntity({
          id: event.entityId,
          type: event.entityType,
          name: event.name,
          scene: event.scene,
          source: event.source,
        });
        break;

      case "EntityUpdated":
        this.updateEntity(event.entityId, event.changes);
        break;

      case "SceneChanged":
        this.setScene(event.to);
        break;

      case "TimeAdvanced":
        this.setTime(event.to);
        break;

      case "GateCreated":
        this.addPendingGate({
          id: event.gateId,
          skill: event.skill,
          difficulty: event.difficulty ?? "regular",
          action: event.action ?? "",
          hidden: event.hidden === true,
          checkpointId: event.checkpointId ?? "",
          target: event.target ?? "",
          at: event.at,
          scene: event.scene ?? "",
          source: event.source ?? "event",
        });
        break;

      case "GateResolved":
        this.removePendingGate(event.gateId);
        if (event.resolvedKey) this.recordResolvedCheck(event.resolvedKey);
        break;

      case "GateFailed":
        this.removePendingGate(event.gateId);
        break;

      case "GateExpired":
        this.skipGate({ id: event.gateId }, event.reason ?? "expired", event.at);
        break;

      case "CheckpointPassed":
        this.recordPassedCheckpoint(event.checkpointId);
        break;

      case "SanitySettled":
        this.recordSanitySettled({
          eventId: event.eventId ?? "",
          player: event.player,
          loss: event.loss,
          sanBefore: event.sanBefore,
          sanAfter: event.sanAfter,
          at: event.at,
        });
        break;

      case "KeyPointRevealed":
        this.revealKeyPoint(event.keyPointId);
        break;

      case "BranchLanded":
        this.landBranch(event.branchId, event.chosen);
        break;

      case "ItemAcquired":
        if (event.character && event.item) this.addInventoryItem(event.character, event.item);
        break;

      case "SpellShown":
        this.markSpellShown();
        break;

      case "NightEventFired":
        this.recordNightEventFired(event.eventId);
        break;

      case "EndingResolved":
        this.markEndingResolved(event);
        break;

      case "SkillGrown": {
        const pc = this.findCharacter(event.character);
        if (pc) {
          if (!pc.skills) pc.skills = {};
          pc.skills[event.skill] = event.after;
        }
        break;
      }

      case "CharacterCreated":
        // 角色已在外部添加，这里只记录事件
        break;

      case "ScenarioImported":
        // 仅记录，不做额外操作
        break;

      default:
        // 未知事件类型，静默忽略
        break;
    }
  }

  // ── 快照导出 ──────────────────────────────────────────

  /**
   * 导出为可序列化的纯对象（用于持久化）
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      title: this.title,
      kpMode: this.kpMode,
      currentScene: this.currentScene,
      time: this.time,
      synopsis: this.synopsis,
      characters: this.characters,
      entities: this.entities,
      tasks: this.tasks,
      flags: Object.fromEntries(this.flags),
      discoveredClues: this.discoveredClues,
      relationships: this.relationships,
      rollHistory: this.rollHistory.slice(-200),
      scheduledEvents: this.scheduledEvents,
      events: this.events.slice(-2000),
      currentBranchId: this.currentBranchId,
      pendingChecks: this.pendingChecks,
      skippedChecks: this.skippedChecks,
      resolvedChecks: this.resolvedChecks,
      passedCheckpointIds: this.passedCheckpointIds,
      sanitySettled: this.sanitySettled,
      keyPoints: this.keyPoints,
      branches: this.branches,
      spellShown: this.spellShown,
      endingReached: this.endingReached,
      endedAt: this.endedAt,
      firedNightEventIds: this.firedNightEventIds,
    };
  }

  /**
   * 从纯对象恢复 WorldState
   * @param {object} data
   * @returns {WorldState}
   */
  static fromJSON(data) {
    return new WorldState({
      ...data,
      flags: data.flags ?? {},
    });
  }

  /**
   * 用纯对象数据原地更新 WorldState（保留实例引用，供 GameSession 同步用）。
   * @param {object} data
   * @returns {WorldState}
   */
  hydrate(data) {
    if (data.id !== undefined) this.id = data.id;
    if (data.title !== undefined) this.title = data.title;
    if (data.kpMode !== undefined) this.kpMode = data.kpMode;
    if (data.currentScene !== undefined) this.currentScene = data.currentScene;
    if (data.time !== undefined) this.time = data.time;
    if (data.synopsis !== undefined) this.synopsis = data.synopsis;
    // 数组字段做浅拷贝，避免与外部对象共享引用（如旧 flat JSON）
    if (data.characters !== undefined) this.characters = [...data.characters];
    if (data.entities !== undefined) this.entities = [...data.entities];
    if (data.tasks !== undefined) this.tasks = [...data.tasks];
    if (data.flags !== undefined) {
      this.flags =
        data.flags instanceof Map
          ? new Map(data.flags)
          : new Map(Object.entries(data.flags));
    }
    if (data.discoveredClues !== undefined) this.discoveredClues = [...data.discoveredClues];
    if (data.relationships !== undefined) this.relationships = [...data.relationships];
    if (data.rollHistory !== undefined) this.rollHistory = [...data.rollHistory];
    if (data.scheduledEvents !== undefined) this.scheduledEvents = [...data.scheduledEvents];
    if (data.events !== undefined) this.events = [...data.events];
    if (data.currentBranchId !== undefined) this.currentBranchId = data.currentBranchId;
    if (data.pendingChecks !== undefined) this.pendingChecks = [...data.pendingChecks];
    if (data.skippedChecks !== undefined) this.skippedChecks = [...data.skippedChecks];
    if (data.resolvedChecks !== undefined) this.resolvedChecks = [...data.resolvedChecks];
    if (data.passedCheckpointIds !== undefined) this.passedCheckpointIds = [...data.passedCheckpointIds];
    if (data.sanitySettled !== undefined) this.sanitySettled = [...data.sanitySettled];
    if (data.keyPoints !== undefined) this.keyPoints = [...data.keyPoints];
    if (data.branches !== undefined) this.branches = [...data.branches];
    if (data.spellShown !== undefined) this.spellShown = data.spellShown === true;
    if (data.endingReached !== undefined) this.endingReached = data.endingReached === true;
    if (data.endedAt !== undefined) this.endedAt = data.endedAt ?? null;
    if (data.firedNightEventIds !== undefined) this.firedNightEventIds = [...data.firedNightEventIds];
    return this;
  }

  /**
   * 生成轻量摘要（用于注入 LLM Context）
   * @returns {object}
   */
  digest() {
    return {
      id: this.id,
      title: this.title,
      kpMode: this.kpMode,
      currentScene: this.currentScene,
      time: this.time,
      synopsis: this.synopsis,
      characters: this.characters.map((c) => ({
        name: c.name,
        occupation: c.occupation,
        hp: c.hp,
        san: c.san,
        mp: c.mp,
        luck: c.luck,
        inventory: c.inventory,
      })),
      entitiesInScene: this.findEntitiesInScene().map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        state: e.state,
        desc: e.desc,
      })),
      tasks: this.tasks,
      discoveredClues: this.discoveredClues,
      recentRolls: this.rollHistory.slice(-4),
    };
  }
}
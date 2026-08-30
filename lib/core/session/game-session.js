/**
 * GameSession 容器
 *
 * 一次跑团的运行时容器，负责组装：
 * - EventBus（事件总线）
 * - WorldState（结构化世界状态）
 * - PlotGraph（剧情图）
 * - ClueGraph（线索图）
 * - Trace（简版 Turn Trace，未来拆分到 session/trace.js）
 *
 * 职责：
 * - applyEvent(event)：把事件应用到 WorldState 并发布到 EventBus
 * - syncFromFlat(flatState)：从旧 flat JSON 状态同步镜像到 WorldState
 * - recordTrace(entry)：记录运行轨迹（Tool 调用、Director 决策等）
 * - digest()：生成注入 LLM 的轻量摘要
 *
 * 原则：
 * - Core 零 DSH 依赖
 * - GameSession 是 Adapter 装配 Core 模块的入口
 */
import { EventBus, EventLog } from "../events.js";
import { WorldState } from "../state/world-state.js";
import { PlotGraph } from "../plot/plot-graph.js";
import { ClueGraph } from "../clue/clue-graph.js";
import { SceneMode } from "../interfaces.js";

export class GameSession {
  /** @type {string} */
  id;
  /** @type {EventBus} */
  eventBus;
  /** @type {EventLog} */
  eventLog;
  /** @type {WorldState} */
  world;
  /** @type {PlotGraph} */
  plot;
  /** @type {ClueGraph} */
  clues;
  /** @type {string} */
  sceneMode;
  /** @type {Array<object>} */
  trace;
  /** @type {string|null} */
  scenarioId;

  /**
   * @param {object} [opts]
   * @param {string} [opts.id="default"] 游戏 ID
   * @param {string} [opts.sceneMode] 当前 Scene Mode
   * @param {string} [opts.scenarioId] 关联的全局剧本资产 ID（可为 null）
   * @param {number} [opts.maxEvents=2000] EventBus 历史上限
   * @param {number} [opts.maxTrace=2000] Trace 上限
   */
  constructor(opts = {}) {
    this.id = opts.id ?? "default";
    this.sceneMode = opts.sceneMode ?? SceneMode.FreeRoleplay;
    this.scenarioId = opts.scenarioId ?? null;
    this.eventBus = new EventBus(opts.maxEvents ?? 2000);
    this.eventLog = new EventLog(opts.maxEvents ?? 4000);
    this.world = new WorldState({ id: this.id });
    this.plot = new PlotGraph();
    this.clues = new ClueGraph();
    this.trace = [];
    this.maxTrace = opts.maxTrace ?? 2000;
  }

  /**
   * 应用事件：盖章（seq/id/at）→ 更新 WorldState → 发布到 EventBus。
   * 这是运行期状态变化的唯一入口。
   * @param {object} event
   * @returns {object} 已盖章的事件
   */
  applyEvent(event) {
    const stamped = this.eventLog.append(event);
    this.world.applyEvent(stamped);
    this.eventBus.publish(stamped);
    return stamped;
  }

  /**
   * 记录运行轨迹。
   * @param {object} entry - { kind, tool?, args?, summary?, ... }
   */
  recordTrace(entry) {
    this.trace.push({ at: new Date().toISOString(), ...entry });
    if (this.trace.length > this.maxTrace) {
      this.trace = this.trace.slice(-this.maxTrace);
    }
  }

  /**
   * 从旧 flat JSON 状态同步镜像数据到 WorldState。
   * 注意：Step 1 阶段 WorldState 是镜像；Step 2 起将改为唯一事实来源。
   *
   * @param {object} flat - 旧 GameState 结构
   */
  syncFromFlat(flat) {
    this.id = flat.id ?? this.id;
    if (flat.scenarioId !== undefined) this.scenarioId = flat.scenarioId ?? null;
    this.world.hydrate({
      id: this.id,
      title: flat.title ?? this.id,
      kpMode: flat.kpMode ?? "ai",
      currentScene: flat.currentScene ?? "",
      time: flat.time ?? "",
      synopsis: flat.synopsis ?? "",
      characters: flat.characters ?? [],
      entities: flat.entities ?? [],
      tasks: flat.tasks ?? [],
      flags: {},
      discoveredClues: flat.discoveredClues ?? [],
      relationships: flat.relationships ?? [],
      rollHistory: flat.rollHistory ?? [],
      events: flat.events ?? [],
    });
    // C-1：剧情执行账本字段也从旧 flat 同步进 WorldState。
    this.world.hydratePlotFields(flat);
  }

  /**
   * 用已持久化的 core 数据恢复 PlotGraph / ClueGraph / Trace / SceneMode。
   * 注意：不恢复 world——world 始终由 syncFromFlat(flat) 以旧 flat 字段为准同步，
   * 保证旧工具（HTTP API / 聊天桥）与新工具之间的状态一致。
   * @param {object} coreData - toJSON() 产出的 core 数据
   * @returns {GameSession}
   */
  hydrateCore(coreData) {
    if (coreData === undefined || coreData === null) return this;
    if (coreData.sceneMode !== undefined) this.sceneMode = coreData.sceneMode;
    if (coreData.scenarioId !== undefined) this.scenarioId = coreData.scenarioId ?? null;
    if (coreData.plot !== undefined) this.plot = PlotGraph.fromJSON(coreData.plot);
    if (coreData.clues !== undefined) this.clues = ClueGraph.fromJSON(coreData.clues);
    if (coreData.trace !== undefined) this.trace = coreData.trace;
    if (coreData.eventLog !== undefined) this.eventLog = EventLog.fromJSON(coreData.eventLog);
    return this;
  }

  /**
   * 从 ScenarioModel 导入 PlotGraph 与 ClueGraph。
   * @param {object} model - ScenarioModel（来自 Scenario Compiler）
   * @param {object} [opts]
   * @param {boolean} [opts.replace=true] - 是否清空旧图后重建
   * @param {boolean} [opts.activateInitial=true] - 是否自动激活无前置条件的节点
   * @returns {GameSession}
   */
  importScenarioModel(model, opts = {}) {
    const replace = opts.replace !== false;
    const activateInitial = opts.activateInitial !== false;

    if (replace) {
      this.plot = new PlotGraph();
      this.clues = new ClueGraph();
    }

    for (const pn of model.plotNodes ?? []) {
      try {
        this.plot.addNode({
          id: pn.id,
          title: pn.title,
          type: pn.type,
          description: pn.description,
          scene: pn.scene,
          preconditions: pn.preconditions,
          timeConstraint: pn.timeConstraint,
          leadsTo: pn.leadsTo,
        });
      } catch (error) {
        this.recordTrace({ kind: "scenario-import", warn: error.message });
      }
    }

    for (const clue of model.clues ?? []) {
      try {
        this.clues.addClue({
          id: clue.id,
          description: clue.description,
          acquisitionMethods: clue.acquisitionMethods,
          relatedEntities: clue.relatedEntityIds,
          isCritical: clue.isCritical,
          leadsTo: clue.leadsTo,
          fallbackMethods: clue.fallbackMethods,
          category: clue.category,
        });
      } catch (error) {
        this.recordTrace({ kind: "scenario-import", warn: error.message });
      }
    }

    if (activateInitial) {
      for (const node of this.plot.nodes) {
        if (node.status === "inactive" && (node.preconditions ?? []).length === 0) {
          this.plot.activateNode(node.id, "scenario-import");
        }
      }
    }

    return this;
  }

  /**
   * 生成轻量摘要（用于 LLM Context 与调试）。
   * @returns {object}
   */
  digest() {
    return {
      id: this.id,
      sceneMode: this.sceneMode,
      world: this.world.digest(),
      plot: this.plot.digest(),
      clues: this.clues.digest(),
      traceTail: this.trace.slice(-6),
    };
  }

  /**
   * 导出容器状态（不含 EventBus 订阅）。
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      sceneMode: this.sceneMode,
      scenarioId: this.scenarioId,
      world: this.world.toJSON(),
      plot: this.plot.toJSON(),
      clues: this.clues.toJSON(),
      trace: this.trace,
      eventLog: this.eventLog.toJSON(),
    };
  }

  /**
   * 从纯对象恢复容器（EventBus 历史不恢复）。
   * @param {object} data
   * @returns {GameSession}
   */
  static fromJSON(data) {
    const session = new GameSession({ id: data.id ?? "default" });
    session.sceneMode = data.sceneMode ?? SceneMode.FreeRoleplay;
    session.world = WorldState.fromJSON(data.world ?? {});
    session.plot = PlotGraph.fromJSON(data.plot ?? {});
    session.clues = ClueGraph.fromJSON(data.clues ?? {});
    session.trace = data.trace ?? [];
    session.eventLog = EventLog.fromJSON(data.eventLog ?? {});
    return session;
  }
}

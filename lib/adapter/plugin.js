/**
 * dsh-coc-keeper 插件入口（Harness Adapter 层）
 *
 * Step 7 策略：
 * - 模型可见的 17 个 coc_* 工具全部来自 lib/adapter/tools/*（Tool → Event → State）
 * - /coc-api 与面板聊天桥在 lib/adapter/api + chat（Director/Narrator 纯函数驱动）
 * - 规则域 Skills 注册到 ctx.skills（coc-rule-dice/combat/sanity/growth）
 * - legacy-index.js 只保留：旧工具 defs（供 import 类工具委托复用）、
 *   systemPrompt 注入、内置规则自动导入
 * - GameSession 持久化在旧 flat JSON 的 `core` 字段；
 *   WorldState 是新工具运行期唯一事实来源，flat 字段是兼容投影
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { GameSession, JsonFilePersistence } from "../core/index.js";
import { registerAllTools } from "./tools/index.js";
import { registerCocApi } from "./api/coc-api.js";
import { registerRuleSkills } from "./skills/rule-skills.js";
import {
  apply as legacyApply,
  Config as LegacyConfig,
  name as legacyName,
} from "../legacy-index.js";

// ── 插件元信息 ────────────────────────────────────────────

export const name = legacyName;
export const inject = ["tools", "systemPrompt", "skills"];
export const Config = LegacyConfig;

// ── 基础工具函数 ──────────────────────────────────────────

function dshHome() {
  const env = process.env.DSH_HOME;
  return env !== undefined && env.length > 0 ? env : join(homedir(), ".dsh");
}

function safeGameId(id) {
  const clean = String(id)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean.slice(0, 64) : "default";
}

function stateKey(gameId) {
  return `${safeGameId(gameId)}.json`;
}

// ── 插件主体 apply() ──────────────────────────────────────

export function apply(ctx, config) {
  const dataDir =
    config.dataDir && config.dataDir.length > 0
      ? config.dataDir
      : join(dshHome(), "coc");
  const defaultGame = config.defaultGame ?? "default";
  const persistence = new JsonFilePersistence(dataDir);
  const session = new GameSession({ id: safeGameId(defaultGame) });

  // 1) 先装配 legacy：systemPrompt 注入 + 内置规则自动导入。
  //    旧工具定义收集到 legacyDefs（不注册到模型上下文），供 import 类工具委托复用。
  const legacyDefs = new Map();
  const legacyTools = Object.assign(Object.create(ctx.tools), {
    register(def) {
      legacyDefs.set(def.name, def);
    },
  });
  // Cordis Context 通过 Proxy/原型链解析 systemPrompt、get、inject 等服务；
  // 对 ctx 使用对象展开会把它降级为普通对象并丢失这些动态服务。
  const legacyCtx = typeof ctx.extend === "function"
    ? ctx.extend({ tools: legacyTools })
    : Object.assign(Object.create(ctx), { tools: legacyTools });
  legacyApply(legacyCtx, config);

  // 2) 注册模型可见的新工具，同时收集 adapter 工具 defs 供 /coc-api 与聊天桥使用。
  const toolDefs = new Map();
  const collectingTools = Object.assign(Object.create(ctx.tools), {
    register(def) {
      toolDefs.set(def.name, def);
      return ctx.tools.register(def);
    },
  });
  const toolCtx = typeof ctx.extend === "function"
    ? ctx.extend({ tools: collectingTools })
    : Object.assign(Object.create(ctx), { tools: collectingTools });

  const deps = {
    ctx,
    session,
    persistence,
    dataDir,
    defaultGame,
    maxRollHistory: config.maxRollHistory ?? 200,
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    maxChatRounds: config.maxChatRounds ?? 4,
    maxChatLog: config.maxChatLog ?? 120,
    stateKey,
    legacyDefs,
    toolDefs,
  };
  registerAllTools(toolCtx, deps);

  // 3) 注册规则域 Skills（模型可按需 skill 工具加载）。
  registerRuleSkills(ctx);

  // 4) 注册 /coc-api 与面板聊天桥（契约不变，内部走 adapter 新工具）。
  registerCocApi(ctx, deps);

  // 5) 恢复 defaultGame 的 Core 容器；旧存档首次加载自动补写 core 字段。
  const initialFlat = persistence.load(stateKey(defaultGame));
  if (initialFlat !== null) {
    session.syncFromFlat(initialFlat);
    session.hydrateCore(initialFlat.core);
    if (initialFlat.core === undefined || initialFlat.core === null) {
      initialFlat.core = session.toJSON();
      initialFlat.updatedAt = new Date().toISOString();
      persistence.save(stateKey(defaultGame), initialFlat);
    }
  }

  console.log("[coc-keeper] Step 7 已装配：17 工具 + Skills + /coc-api + 聊天桥 + Clock/Recovery/Reachability");
  console.log(`[coc-keeper] 数据目录：${dataDir}`);
  console.log(`[coc-keeper] 默认游戏：${defaultGame}`);
  console.log(
    `[coc-keeper] GameSession：${session.world.characters.length} 角色 / ${session.world.entities.length} 实体 / ${session.world.rollHistory.length} 骰点 / ${session.plot.nodes.length} 剧情节点`
  );
}

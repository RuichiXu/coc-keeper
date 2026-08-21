/**
 * dsh-coc-keeper 插件入口（Harness Adapter 层）
 *
 * Step 8 策略（全局资产库 + 场次分离）：
 * - 数据布局：assets/（剧本/调查员/实体模板）+ games/（单场游戏数据）
 * - 删除剧本级联删除引用它的所有场次；游戏内数据为资产副本
 * - 模型可见的 17 个 coc_* 工具全部来自 lib/adapter/tools/*（Tool → Event → State）
 * - /coc-api 与面板聊天桥在 lib/adapter/api + chat（Director/Narrator 纯函数驱动）
 * - 规则域 Skills 注册到 ctx.skills；内置规则自动导入可用 Config 关闭
 * - GameSession 持久化在 games/<id>.json 的 `core` 字段；
 *   WorldState 是新工具运行期唯一事实来源，flat 字段是兼容投影
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { AssetStore, ASSET_KINDS, GameSession, JsonFilePersistence } from "../core/index.js";
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
  return join("games", `${safeGameId(gameId)}.json`);
}

/**
 * 旧布局迁移：dataDir/*.json（每场游戏内嵌剧本/角色/实体）
 * → games/<id>.json + assets/<kind>/<id>.json（模板）。
 * 迁移后删除根目录旧文件，避免重复迁移。
 */
function migrateLegacyLayout(dataDir, persistence, assetStore) {
  const gamesDir = join(dataDir, "games");
  const legacyFiles = existsSync(dataDir)
    ? readdirSync(dataDir).filter((f) => f.endsWith(".json") && f !== "config.json")
    : [];
  if (legacyFiles.length === 0) return { migrated: 0 };

  let migrated = 0;
  for (const file of legacyFiles) {
    const oldPath = join(dataDir, file);
    const flat = persistence.load(oldPath);
    if (flat === null) continue;

    const gameId = flat.id ?? file.slice(0, -5);
    const target = join(gamesDir, `${safeGameId(gameId)}.json`);

    // 剧本 → 全局资产，场次留引用
    if (flat.scenario !== null && flat.scenario !== undefined && typeof flat.scenario === "object" && flat.scenario.name) {
      const asset = assetStore.save(ASSET_KINDS.SCENARIO, {
        name: flat.scenario.name,
        text: flat.scenario.text ?? "",
        summary: flat.scenario.summary ?? "",
        source: flat.scenario.source ?? "legacy-migration",
        chars: flat.scenario.chars ?? String(flat.scenario.text ?? "").length,
        lines: flat.scenario.lines ?? 0,
        legacyGameId: gameId,
      });
      flat.scenarioId = asset.id;
    } else {
      flat.scenarioId = null;
    }

    // 角色 → 通用调查员卡（游戏内副本保留；旧数据可能只在 core.world 里）
    const legacyCharacters = flat.characters ?? flat.core?.world?.characters ?? [];
    for (const pc of legacyCharacters) {
      if (pc?.name) {
        assetStore.save(ASSET_KINDS.INVESTIGATOR, {
          name: pc.name,
          player: pc.player ?? "",
          occupation: pc.occupation ?? "",
          stats: pc.stats ?? {},
          skills: pc.skills ?? {},
          inventory: pc.inventory ?? [],
          notes: pc.notes ?? "",
          source: "legacy-migration",
          legacyGameId: gameId,
        });
      }
    }

    // 实体 → 通用实体（游戏内副本保留；旧数据可能只在 core.world 里）
    const legacyEntities = flat.entities ?? flat.core?.world?.entities ?? [];
    for (const entity of legacyEntities) {
      if (entity?.name) {
        assetStore.save(ASSET_KINDS.ENTITY, {
          name: entity.name,
          type: entity.type ?? "npc",
          desc: entity.desc ?? "",
          state: entity.state ?? "",
          scene: entity.scene ?? "",
          source: "legacy-migration",
          legacyGameId: gameId,
        });
      }
    }

    persistence.save(target, flat);
    try {
      unlinkSync(oldPath);
    } catch {
      // 忽略删除失败（下次启动会再次尝试，但 target 已存在时按 id 覆盖写，安全）
    }
    migrated += 1;
  }
  return { migrated };
}

// ── 插件主体 apply() ──────────────────────────────────────

export function apply(ctx, config) {
  const dataDir =
    config.dataDir && config.dataDir.length > 0
      ? config.dataDir
      : join(dshHome(), "coc");
  const defaultGame = config.defaultGame ?? "default";
  const persistence = new JsonFilePersistence(dataDir);
  const assetStore = new AssetStore(join(dataDir, "assets"));
  const session = new GameSession({ id: safeGameId(defaultGame) });

  // 0) 旧布局迁移：dataDir/*.json → games/<id>.json + assets/**。
  const migration = migrateLegacyLayout(dataDir, persistence, assetStore);
  if (migration.migrated > 0) {
    console.log(`[coc-keeper] 已迁移 ${migration.migrated} 个旧场次文件到 games/ + assets/`);
  }

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
    assetStore,
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

  console.log("[coc-keeper] Step 8 已装配：资产库 + 场次分离 + 17 工具 + Skills + /coc-api + 聊天桥");
  console.log(`[coc-keeper] 数据目录：${dataDir}`);
  console.log(`[coc-keeper] 默认游戏：${defaultGame}`);
  console.log(
    `[coc-keeper] GameSession：${session.world.characters.length} 角色 / ${session.world.entities.length} 实体 / ${session.world.rollHistory.length} 骰点 / ${session.plot.nodes.length} 剧情节点`
  );
}

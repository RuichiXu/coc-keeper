/**
 * 导入/阅读/查询工具：coc_import / coc_read / coc_query_rule
 *
 * 这三个工具逻辑复杂（文件提取、AI 解析、内置规则查询），
 * 暂时委托旧实现执行，执行后统一走 Core 收尾（同步 + 保存 core）。
 * 后续 Scenario Compiler / Importer 成熟后再完全迁移。
 */
import { compileByPattern, ASSET_KINDS } from "../../core/index.js";
import { loadSession, commitSession, gameIdOf } from "./helpers.js";

/**
 * @param {object} ctx
 * @param {object} deps - 需包含 legacyDefs Map
 */
export function registerImportTools(ctx, deps) {
  const legacyDefs = deps.legacyDefs;

  const wrapLegacy = (toolName) => {
    const legacyDef = legacyDefs.get(toolName);
    if (!legacyDef) throw new Error(`旧工具 ${toolName} 未装配`);

    ctx.tools.register({
      ...legacyDef,
      async execute(args, execCtx) {
        const result = await legacyDef.execute(args, execCtx);
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        const assets = deps.assetStore;

        if (toolName === "coc_import") {
          // 剧本 → 全局资产库（场次仅保留 scenarioId 引用；重复导入同名剧本则更新资产）
          const scenarioText = flat.scenario?.text ?? "";
          if (scenarioText.trim().length > 0) {
            const existing = assets.findByName(ASSET_KINDS.SCENARIO, flat.scenario.name);
            let asset = existing;
            if (existing !== null) {
              asset = assets.update(ASSET_KINDS.SCENARIO, existing.id, {
                text: flat.scenario.text,
                summary: flat.scenario.summary ?? "",
                chars: flat.scenario.chars,
                lines: flat.scenario.lines,
                source: flat.scenario.source ?? "import",
                keyPoints: flat.keyPoints ?? [],
                branches: flat.branches ?? [],
                entities: flat.entities ?? [],
              });
            } else {
              asset = assets.save(ASSET_KINDS.SCENARIO, {
                name: flat.scenario.name,
                text: flat.scenario.text,
                summary: flat.scenario.summary ?? "",
                source: flat.scenario.source ?? "import",
                chars: flat.scenario.chars,
                lines: flat.scenario.lines,
                keyPoints: flat.keyPoints ?? [],
                branches: flat.branches ?? [],
                entities: flat.entities ?? [],
              });
            }
            session.scenarioId = asset.id;
            // 用 Scenario Compiler 重建 PlotGraph / ClueGraph
            const model = compileByPattern(scenarioText, flat.scenario.name ?? "剧本");
            session.importScenarioModel(model, { replace: true, activateInitial: true });
            session.recordTrace({
              kind: "scenario-compile",
              scenarioId: asset.id,
              plotNodes: model.plotNodes.length,
              clues: model.clues.length,
            });
          }

          // 人物 → 通用调查员卡（按规范化姓名去重，不重复建卡）
          if (args.kind === "characters" || args.kind === "auto") {
            for (const pc of flat.characters ?? []) {
              if (pc?.name && assets.findByNameLoose(ASSET_KINDS.INVESTIGATOR, pc.name) === null) {
                assets.save(ASSET_KINDS.INVESTIGATOR, {
                  name: pc.name,
                  player: pc.player ?? "",
                  occupation: pc.occupation ?? "",
                  stats: pc.stats ?? {},
                  hp: pc.hp ?? pc.stats?.HP ?? 0,
                  san: pc.san ?? pc.stats?.SAN ?? 0,
                  mp: pc.mp ?? pc.stats?.MP ?? 0,
                  luck: pc.luck ?? pc.stats?.LUCK ?? 0,
                  skills: pc.skills ?? {},
                  inventory: pc.inventory ?? [],
                  notes: pc.notes ?? "",
                });
              }
            }
          }

          // 注意：剧本草拟实体（flat.entities）属于剧本、保留在场次内，
          // 不自动进入全局实体资产。用户可在「调试 → 实体」逐个手动加入资产库。
        }

        commitSession(deps, gameId, session, flat);
        return result;
      },
    });
  };

  wrapLegacy("coc_import");
  wrapLegacy("coc_read");
  wrapLegacy("coc_query_rule");
}

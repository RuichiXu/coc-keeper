/**
 * 导入/阅读/查询工具：coc_import / coc_read / coc_query_rule
 *
 * 这三个工具逻辑复杂（文件提取、AI 解析、内置规则查询），
 * 暂时委托旧实现执行，执行后统一走 Core 收尾（同步 + 保存 core）。
 * 后续 Scenario Compiler / Importer 成熟后再完全迁移。
 */
import { compileByPattern } from "../../core/index.js";
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

        // 剧本导入后：用 Scenario Compiler 重建 PlotGraph / ClueGraph
        if (toolName === "coc_import" && args.kind === "scenario") {
          const scenarioText = flat.scenario?.text ?? "";
          if (scenarioText.trim().length > 0) {
            const model = compileByPattern(scenarioText, flat.scenario?.name ?? "剧本");
            session.importScenarioModel(model, { replace: true, activateInitial: true });
            session.recordTrace({
              kind: "scenario-compile",
              plotNodes: model.plotNodes.length,
              clues: model.clues.length,
            });
          }
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

import { createRollToolDefs } from "./roll.js";
import { createRuleToolDefs } from "./rules.js";
import { createStateToolDefs } from "./state-tools.js";
import { createPlotToolDefs } from "./plot-tools.js";
import { createImportToolDefs } from "./import.js";

export const PANEL_TOOLS = Object.freeze([
  "coc_roll",
  "coc_roll_secret",
  "coc_scene",
  "coc_check",
  "coc_task",
  "coc_entity",
  "coc_pc",
  "coc_branch",
  "coc_remind",
  "coc_kp",
  "coc_query_rule",
  "coc_sanity_check",
  "coc_combat_resolve",
  "coc_skill_growth",
  "coc_status",
]);

function normalizeSharedDef(def) {
  const render = def.render ?? def.output?.render;
  if (typeof render !== "function") {
    throw new Error(`共享工具 ${def.name} 缺少 render(args, result)`);
  }
  return {
    ...def,
    render,
    output: {
      ...def.output,
      render,
    },
  };
}

/**
 * 创建不依赖 DSH 的工具注册表。
 * Stage A 暂不包含 coc_import / coc_read / coc_query_rule。
 */
export function createSharedToolDefs(deps, options = {}) {
  const includeImport = options.includeImport !== false;
  const defs = [
    ...createRollToolDefs(deps),
    ...createRuleToolDefs(deps),
    ...createStateToolDefs(deps),
    ...createPlotToolDefs(deps),
    ...(includeImport ? createImportToolDefs(deps) : []),
  ].map(normalizeSharedDef);
  return new Map(defs.map((def) => [def.name, def]));
}

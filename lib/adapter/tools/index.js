/**
 * Adapter 工具总注册入口
 *
 * Step 3：所有模型可见工具来自本文件。
 * 旧工具仍由 legacy 装配给 /coc-api 与聊天桥（通过 legacyDefs），
 * 但不再注册到模型上下文。
 */
import { registerRollTools } from "./roll.js";
import { registerRuleTools } from "./rules.js";
import { registerStateTools } from "./state-tools.js";
import { registerPlotTools } from "./plot-tools.js";
import { registerImportTools } from "./import.js";

/**
 * 注册全部 coc_* 工具到模型可见 ctx.tools。
 * @param {object} ctx
 * @param {object} deps
 */
export function registerAllTools(ctx, deps) {
  registerRollTools(ctx, deps);
  registerRuleTools(ctx, deps);
  registerStateTools(ctx, deps);
  registerPlotTools(ctx, deps);
  registerImportTools(ctx, deps);
}

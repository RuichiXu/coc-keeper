/**
 * Adapter 工具总注册入口
 *
 * Step 3：所有模型可见工具来自本文件。
 * 旧工具仍由 legacy 装配给 /coc-api 与聊天桥（通过 legacyDefs），
 * 但不再注册到模型上下文。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createSharedToolDefs } from "../../shared/tools/index.js";
import { registerImportTools } from "./import.js";

/**
 * 注册全部 coc_* 工具到模型可见 ctx.tools。
 * @param {object} ctx
 * @param {object} deps
 */
export function registerAllTools(ctx, deps) {
  const sharedDefs = createSharedToolDefs(deps, { includeImport: false });
  for (const def of sharedDefs.values()) {
    const { render: _render, ...config } = def;
    ctx.tools.register(defineTool(config));
  }
  registerImportTools(ctx, deps);
}

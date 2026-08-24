/**
 * Adapter 工具总注册入口
 *
 * Step 3：所有模型可见工具来自本文件。
 * 所有模型/API/聊天可见工具均来自 lib/shared/tools。
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

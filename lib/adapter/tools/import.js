/**
 * DSH 导入工具薄壳（Stage C）。
 *
 * 实现位于 lib/shared/tools/import.js；本文件只把 shared 定义转换为
 * dsh-tools 的注册格式。保留 registerImportTools 签名供旧调用方兼容。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createSharedToolDefs } from "../../shared/tools/index.js";

const IMPORT_TOOLS = ["coc_import", "coc_read", "coc_query_rule"];

export function registerImportTools(ctx, deps) {
  const defs = createSharedToolDefs(deps);
  for (const name of IMPORT_TOOLS) {
    const def = defs.get(name);
    const { render: _render, ...config } = def;
    ctx.tools.register(defineTool(config));
  }
}

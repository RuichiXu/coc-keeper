/**
 * dsh-coc-keeper 入口
 *
 * Step 1：入口已切换到新版 Harness Adapter。
 * 旧实现保留在 lib/legacy-index.js，由 adapter/plugin.js 过渡装配。
 */
export { apply, Config, inject, name } from "./adapter/plugin.js";

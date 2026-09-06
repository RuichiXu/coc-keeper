#!/usr/bin/env node
/**
 * dsh-coc-keeper 在线运行冒烟测试 CLI。
 *
 * 用法见 lib/testing/runtime-smoke/cli.js 顶部注释。
 */
import { main } from "../lib/testing/runtime-smoke/cli.js";

try {
  const code = await main(process.argv.slice(2));
  process.exit(code);
} catch (error) {
  console.error(`[runtime-smoke] 失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
}

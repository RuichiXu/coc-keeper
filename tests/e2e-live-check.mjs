#!/usr/bin/env node
/**
 * dsh-coc-keeper 真实环境 E2E 检查脚本
 *
 * 用法：
 *   node tests/e2e-live-check.mjs
 *
 * 环境变量：
 *   DSH_HOME   — 默认 ~/.dsh
 *   COC_API    — 默认 http://127.0.0.1:3080/coc-api
 *
 * 检查项：
 *   1. 新入口装配（lib/index.js → adapter/plugin.js）
 *   2. adapter/tools/* 七个文件齐全
 *   3. /coc-api/status 可访问（dsh web 运行时）
 *   4. 状态文件包含 core 字段（WorldState 持久化）
 *   5. 最近的游戏状态文件中 flat 与 core.world 关键字段一致
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const COC_DIR = join(DSH_HOME, "coc");
const API_BASE = process.env.COC_API ?? "http://127.0.0.1:3080/coc-api";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. 入口装配 ──────────────────────────────────────────
console.log("\n[1] 入口装配");
const indexSrc = readFileSync(join(root, "lib", "index.js"), "utf8");
check(
  "lib/index.js re-export adapter/plugin.js",
  indexSrc.includes("./adapter/plugin.js")
);
check(
  "adapter/plugin.js 存在",
  existsSync(join(root, "lib", "adapter", "plugin.js"))
);
check(
  "legacy-index.js 存在（兼容层）",
  existsSync(join(root, "lib", "legacy-index.js"))
);

// ── 2. adapter/tools 文件齐全 ─────────────────────────────
console.log("\n[2] adapter/tools 文件");
const toolFiles = [
  "index.js",
  "helpers.js",
  "roll.js",
  "rules.js",
  "state-tools.js",
  "plot-tools.js",
  "import.js",
];
for (const file of toolFiles) {
  check(`adapter/tools/${file}`, existsSync(join(root, "lib", "adapter", "tools", file)));
}

// ── 3. /coc-api 可访问 ────────────────────────────────────
console.log("\n[3] /coc-api（需要 dsh web 运行中）");
try {
  const res = await fetch(`${API_BASE}/status`, { signal: AbortSignal.timeout(4000) });
  if (res.ok) {
    const json = await res.json();
    check("/coc-api/status 返回 200", true, JSON.stringify(json).slice(0, 120));
  } else {
    check("/coc-api/status 返回 200", false, `HTTP ${res.status}`);
  }
} catch (error) {
  check("/coc-api/status 返回 200", false, `不可访问（${error.message}）。请先启动 dsh web 后重试本脚本`);
}

// ── 4. 状态文件 core 字段（新布局 games/） ─────────────────
console.log("\n[4] 状态文件与 core 持久化");
if (!existsSync(COC_DIR)) {
  check(`数据目录存在（${COC_DIR}）`, false, "目录不存在（尚未跑过团？）");
} else {
  const gamesDir = join(COC_DIR, "games");
  const legacyFiles = readdirSync(COC_DIR).filter((f) => f.endsWith(".json") && f !== "config.json");
  if (legacyFiles.length > 0) {
    console.log(`  ! 根目录仍有 ${legacyFiles.length} 个旧布局文件（${legacyFiles.join(", ")}）；重启 dsh web 后会自动迁移到 games/ + assets/`);
  }
  const files = existsSync(gamesDir)
    ? readdirSync(gamesDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(gamesDir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];

  check(`数据目录存在（${COC_DIR}）`, true, `games/ 下 ${files.length} 个场次文件`);
  const recent = files.slice(0, 3);
  if (recent.length === 0) {
    check("至少有一个场次文件", false, "请先重启 dsh web 触发旧数据迁移，或通过面板/工具跑一次团");
  } else {
    for (const file of recent) {
      try {
        const flat = JSON.parse(readFileSync(file, "utf8"));
        const hasCore = flat.core !== undefined && flat.core !== null;
        const name = file.split("/").pop();
        if (hasCore) {
          check(
            `${name} 含 core 字段`,
            true,
            `plot nodes=${flat.core?.plot?.nodes?.length ?? 0}, trace=${flat.core?.trace?.length ?? 0}`
          );
          const sameScene = flat.currentScene === flat.core.world.currentScene;
          const sameChars = (flat.characters?.length ?? 0) === (flat.core.world.characters?.length ?? 0);
          check(
            `  flat 与 core.world 投影一致`,
            sameScene && sameChars,
            `scene=${flat.currentScene ?? ""}, chars=${flat.characters?.length ?? 0}/${flat.core.world.characters?.length ?? 0}`
          );
          check(
            `  scenarioId 引用`,
            typeof flat.scenarioId === "string" || flat.scenarioId === null,
            `${flat.scenarioId ?? "无剧本"}`
          );
        } else {
          console.log(`  ! ${name} 无 core 字段（旧存档；重启 dsh web 后首次加载会自动补写）`);
        }
      } catch (error) {
        check(`${file.split("/").pop()} 可解析`, false, error.message);
      }
    }
  }
}

// ── 汇总 ──────────────────────────────────────────────────
console.log(`\n=== E2E 检查完成：通过 ${pass}，失败 ${fail} ===`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * dsh-coc-keeper 测试运行器
 *
 * 用法：
 *   node tests/run-tests.mjs              # 运行所有测试
 *   node tests/run-tests.mjs unit         # 运行单元测试
 *   node tests/run-tests.mjs integration  # 运行集成测试
 *   node tests/run-tests.mjs scenarios    # 运行场景测试
 *   node tests/run-tests.mjs e2e          # 运行 E2E 测试
 *   node tests/run-tests.mjs unit/dice    # 运行指定测试文件
 */

import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TESTS = {
  unit: [
    "unit/dice.test.mjs",
    "unit/events.test.mjs",
    "unit/event-log.test.mjs",
    "unit/clock.test.mjs",
    "unit/character-parser.test.mjs",
    "unit/check-command.test.mjs",
    "unit/check-gates.test.mjs",
    "unit/gate-lifecycle.test.mjs",
    "unit/ending.test.mjs",
    "unit/game-session.test.mjs",
    "unit/persistence.test.mjs",
    "unit/world-state.test.mjs",
    "unit/world-plot-fields.test.mjs",
    "unit/sanity.test.mjs",
    "unit/combat.test.mjs",
    "unit/rules-c2.test.mjs",
    "unit/skill-growth.test.mjs",
    "unit/plot-graph.test.mjs",
    "unit/plot-frontier.test.mjs",
    "unit/clue-graph.test.mjs",
    "unit/scenario-compiler.test.mjs",
    "unit/scene-facts.test.mjs",
    "unit/structure-analysis.test.mjs",
    "unit/knowledge-layers.test.mjs",
    "unit/context-builder.test.mjs",
    "unit/trigger-engine.test.mjs",
    "unit/director-narrator.test.mjs",
    "unit/clock-scheduler.test.mjs",
    "unit/reachability.test.mjs",
    "unit/recovery.test.mjs",
    "unit/asset-store.test.mjs",
    "unit/state-autolanding.test.mjs",
    "unit/story-prereqs.test.mjs",
    "unit/narration-guard.test.mjs",
    "unit/scenario-contract.test.mjs",
    "unit/story-presets.test.mjs",
    "unit/deep-parse.test.mjs",
    "unit/deep-parse-fixtures.test.mjs",
    "unit/deep-parse-repair.test.mjs",
  ],
  integration: [
    "integration/rule-event-state.test.mjs",
    "integration/clue-trigger-plot.test.mjs",
    "integration/scenario-init.test.mjs",
    "integration/adapter-tools.test.mjs",
    "integration/coc-api.test.mjs",
    "integration/shared-chat.test.mjs",
    "integration/check-gates.test.mjs",
    "integration/c4-hardening.test.mjs",
    "integration/shared-import.test.mjs",
    "integration/import-parity.test.mjs",
    "integration/audit-fixes.test.mjs",
    "integration/scenario-contract.test.mjs",
  ],
  scenarios: [
    "scenarios/normal-investigation.test.mjs",
    "scenarios/random-failure-recovery.test.mjs",
    "scenarios/decision-failure.test.mjs",
    "scenarios/time-event.test.mjs",
  ],
  e2e: [
    "e2e/vertical-slice.test.mjs",
  ],
  replay: [
    "replay/final-rite-replay.test.mjs",
  ],
};

/**
 * 运行单个测试文件
 * @param {string} file
 * @returns {Promise<{ file: string, exitCode: number, stdout: string, stderr: string }>}
 */
function runTest(file) {
  return new Promise((resolve) => {
    const child = spawn("node", [join(__dirname, file)], {
      cwd: join(__dirname, ".."),
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (exitCode) => {
      resolve({ file, exitCode, stdout, stderr });
    });
  });
}

/**
 * 运行一组测试
 */
async function runSuite(files) {
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const file of files) {
    if (!existsSync(join(__dirname, file))) {
      console.log(`  ⚠ ${file} — 文件不存在，跳过`);
      continue;
    }

    process.stdout.write(`  ${file} ... `);
    const result = await runTest(file);

    if (result.exitCode === 0) {
      console.log("✓");
      passed += 1;
    } else {
      console.log("✗");
      failed += 1;
      failures.push({ file, stdout: result.stdout, stderr: result.stderr });

      // 打印失败详情（从 stdout 中提取失败信息）
      const output = result.stdout;
      if (output) {
        const failLines = output.split("\n").filter((l) => l.includes("✗"));
        for (const line of failLines.slice(0, 3)) {
          console.log(`    ${line.trim()}`);
        }
      }
    }
  }

  return { passed, failed, failures };
}

// ── 主入口 ──

const target = process.argv[2] ?? "all";

async function main() {
  console.log("=== dsh-coc-keeper 测试 ===\n");

  const start = Date.now();
  let totalPassed = 0;
  let totalFailed = 0;
  const allFailures = [];

  if (target === "all") {
    for (const [suite, files] of Object.entries(TESTS)) {
      console.log(`\n## ${suite} 测试`);
      const result = await runSuite(files);
      totalPassed += result.passed;
      totalFailed += result.failed;
      allFailures.push(...result.failures);
    }
  } else if (TESTS[target]) {
    console.log(`\n## ${target} 测试`);
    const result = await runSuite(TESTS[target]);
    totalPassed += result.passed;
    totalFailed += result.failed;
    allFailures.push(...result.failures);
  } else {
    // 模糊匹配：看是否包含路径片段
    const allFiles = Object.values(TESTS).flat();
    const matched = allFiles.filter((f) => f.includes(target));
    if (matched.length > 0) {
      console.log(`\n## 匹配 "${target}" 的测试`);
      const result = await runSuite(matched);
      totalPassed += result.passed;
      totalFailed += result.failed;
      allFailures.push(...result.failures);
    } else {
      console.error(`未找到匹配 "${target}" 的测试`);
      console.log(`可用层级: ${Object.keys(TESTS).join(", ")}`);
      console.log(`可用文件: ${allFiles.join(", ")}`);
      process.exit(1);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);

  console.log(`\n=== 测试完成 [${elapsed}s] ===`);
  console.log(`通过: ${totalPassed}  失败: ${totalFailed}`);

  if (allFailures.length > 0) {
    console.log("\n失败详情:");
    for (const f of allFailures) {
      console.log(`  ✗ ${f.file}`);
      if (f.stderr) {
        const lines = f.stderr.trim().split("\n");
        for (const line of lines.slice(-5)) {
          console.log(`    ${line}`);
        }
      }
    }
  }

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("测试运行器异常:", err);
  process.exit(1);
});

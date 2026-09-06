/**
 * Runtime Smoke（mock 档）集成测试
 *
 * 验证统一 PlayerDriver 跑团器 + mock KP + 脚本玩家 + 确定性门槛
 * 的完整链路：登记门禁 → .ra 明骰 → 门禁消费 → 叙述 → 结局结算。
 * 不依赖真实 LLM。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "../runner.js";
import {
  createHarness,
  makeMockKpStream,
  makeSyntheticFlat,
  saveGameFlat,
  seedInvestigator,
  runGame,
} from "../../lib/testing/runtime-smoke/runner.js";
import { createScriptedPlayer } from "../../lib/testing/runtime-smoke/player-driver.js";
import { createThresholdEvaluator, applyHardThresholds } from "../../lib/testing/runtime-smoke/evaluator.js";

describe("Runtime Smoke Mock Chain", () => {
  it("mock KP + 脚本玩家完整跑通并抵达结局", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-rs-test-"));
    try {
      const harness = createHarness({
        dataDir,
        gameId: "smoke-mock",
        streamBlocks: makeMockKpStream(),
      });
      saveGameFlat(harness, makeSyntheticFlat("smoke-mock"));
      await seedInvestigator(harness, {
        name: "测试调查员",
        occupation: "侦探",
        stats: { STR: 55, CON: 60, SIZ: 60, DEX: 55, INT: 65, POW: 55, APP: 50, EDU: 60, LUCK: 60, HP: 12, SAN: 55, MP: 11 },
        hp: 12, san: 55, mp: 11, luck: 60,
        skills: { "侦查": 70 },
        inventory: ["笔记本"],
      });

      const player = createScriptedPlayer({
        actions: ["开始游戏", "我要搜索房间", "打开暗格"],
        fallbackAction: "继续调查。",
      });
      const report = await runGame({ harness, player, maxTurns: 6, playerName: "测试调查员" });

      expect(report.metrics.exceptions).toBe(0);
      expect(report.metrics.busyHangs).toBe(0);
      expect(report.final.endingReached).toBeTrue();
      expect(report.metrics.rolls).toBeGreaterThan(0);
      expect(report.final.consistency.pass).toBeTrue();

      const evaluator = createThresholdEvaluator();
      const evalResult = await evaluator.evaluate(report);
      expect(evalResult.hardFail).toBeFalse();
      expect(evalResult.overall.verdict).toBe("go");

      const hardGate = applyHardThresholds(report);
      expect(hardGate.pass).toBeTrue();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "runtime-smoke-mock 集成测试"));

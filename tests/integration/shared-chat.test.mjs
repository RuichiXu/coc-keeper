/**
 * Shared 聊天桥集成测试：不依赖 DSH 服务。
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, mockRandom } from "../runner.js";
import {
  AssetStore,
  GameSession,
  JsonFilePersistence,
} from "../../lib/core/index.js";
import { createSharedToolDefs } from "../../lib/shared/tools/index.js";
import { createSharedChatBridge } from "../../lib/shared/chat/index.js";

describe("Shared 聊天桥", () => {
  it("工具循环保持 user → roll → kp 日志顺序", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-chat-"));
    const persistence = new JsonFilePersistence(dataDir);
    const deps = {
      dataDir,
      defaultGame: "g1",
      persistence,
      assetStore: new AssetStore(join(dataDir, "assets")),
      session: new GameSession({ id: "g1" }),
      stateKey: (gameId) => join("games", `${gameId}.json`),
      maxRollHistory: 200,
      maxChatRounds: 4,
      maxChatLog: 120,
    };
    deps.toolDefs = createSharedToolDefs(deps);

    let calls = 0;
    deps.streamBlocks = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{
            type: "tool-call",
            id: "roll-1",
            name: "coc_roll",
            arguments: JSON.stringify({
              expression: "d100",
              target: 60,
              difficulty: "regular",
              player: "张三",
              label: "侦查",
              game: "other-game",
            }),
          }],
          finish: { kind: "complete" },
          usage: {},
        };
      }
      return {
        blocks: [{ type: "text", text: "你在书架后发现了一道暗门。" }],
        finish: { kind: "complete" },
        usage: {},
      };
    };

    const restore = mockRandom([0.5]);
    const bridge = createSharedChatBridge(deps);
    const result = await bridge.runKpTurn("g1", "我调查书架。", "张三");
    restore();

    expect(result.narration).toBe("你在书架后发现了一道暗门。");
    const flat = JSON.parse(
      readFileSync(join(dataDir, "games", "g1.json"), "utf8")
    );
    expect(flat.log.map((entry) => entry.kind)).toEqual(["user", "roll", "kp"]);
    expect(flat.log[1].text).toContain("🎲【明骰】");
    expect(flat.toolTrace).toHaveLength(1);
    expect(flat.busy).toBeFalse();
    expect(
      existsSync(join(dataDir, "games", "other-game.json"))
    ).toBeFalse();
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "shared-chat 集成测试"));

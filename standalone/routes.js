import { join } from "node:path";
import {
  AssetStore,
  GameSession,
  JsonFilePersistence,
} from "../lib/core/index.js";
import { createCocApiHandler } from "../lib/shared/api/index.js";
import { createSharedChatBridge } from "../lib/shared/chat/index.js";
import { safeGameId } from "../lib/shared/tools/helpers.js";
import { createSharedToolDefs } from "../lib/shared/tools/index.js";

function stateKey(gameId) {
  return join("games", `${safeGameId(gameId)}.json`);
}

function mockStreamBlocks() {
  return async () => ({
    blocks: [{
      type: "text",
      text: "夜色笼罩着街道，远处的钟声提醒你：调查才刚刚开始。",
    }],
    finish: { kind: "stop" },
    usage: {},
  });
}

export function createStandaloneDeps(options) {
  const dataDir = options.dataDir;
  const defaultGame = options.defaultGame ?? "default";
  const deps = {
    dataDir,
    defaultGame,
    persistence: new JsonFilePersistence(dataDir),
    assetStore: new AssetStore(join(dataDir, "assets")),
    session: new GameSession({ id: safeGameId(defaultGame) }),
    stateKey,
    maxRollHistory: 200,
    maxChatRounds: 4,
    maxChatLog: 120,
    hideApiKey: true,
  };
  deps.toolDefs = createSharedToolDefs(deps);
  deps.chatBridge = createSharedChatBridge({
    ...deps,
    ...(options.mockLlm ? { streamBlocks: mockStreamBlocks() } : {}),
  });
  return deps;
}

export function registerCocRoutes(app, options) {
  const deps = createStandaloneDeps(options);
  const handler = createCocApiHandler(deps);
  app.use("/coc-api", handler);
  return deps;
}

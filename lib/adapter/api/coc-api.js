/**
 * DSH /coc-api 薄壳：注入 webServer 与 DSH 聊天流。
 */
import { createCocApiHandler } from "../../shared/api/index.js";
import { createChatBridge } from "../chat/chat-bridge.js";

export function registerCocApi(ctx, deps) {
  const chatBridge = createChatBridge({
    ctx,
    dataDir: deps.dataDir,
    defaultGame: deps.defaultGame,
    persistence: deps.persistence,
    session: deps.session,
    stateKey: deps.stateKey,
    toolDefs: deps.toolDefs,
    llmProvider: deps.llmProvider,
    llmModel: deps.llmModel,
    maxChatRounds: deps.maxChatRounds,
    maxChatLog: deps.maxChatLog,
  });
  deps.chatBridge = chatBridge;
  const handler = createCocApiHandler({ ...deps, chatBridge });

  ctx.inject(["webServer"], (serverCtx) =>
    serverCtx.webServer.register({
      kind: "prefix",
      path: "/coc-api",
      handler,
    })
  );
}

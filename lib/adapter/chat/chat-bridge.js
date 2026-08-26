/**
 * DSH 面板聊天桥薄壳。
 *
 * 主持循环和 HTTP LLM 回退位于 lib/shared/chat；此处只负责把
 * Cordis 的 llm 服务与 BlockAssembler 适配成 shared streamBlocks。
 */
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import {
  callLlmApi,
  createSharedChatBridge,
  stateDigest,
} from "../../shared/chat/index.js";

async function streamDshBlocks(deps, options) {
  const ctx = deps.ctx;
  const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
  if (llm === undefined) {
    return callLlmApi(deps.dataDir, options.messages, options);
  }

  let model = deps.llmModel;
  let provider = deps.llmProvider;
  const defaultModel =
    typeof ctx.get === "function" ? ctx.get("agentDefaultModel") : undefined;
  if (
    defaultModel !== undefined &&
    typeof defaultModel.currentSelection === "function"
  ) {
    const selection = defaultModel.currentSelection();
    if (selection?.provider) provider = selection.provider;
    if (selection?.model) model = selection.model;
  }

  const assembler = new BlockAssembler();
  for await (const chunk of llm.stream({ provider, model, ...options })) {
    assembler.push(chunk);
  }
  return {
    blocks: assembler.blocks(),
    finish: assembler.finish,
    usage: assembler.usage,
  };
}

export function createChatBridge(deps) {
  return createSharedChatBridge({
    ...deps,
    streamBlocks: (options) => streamDshBlocks(deps, options),
  });
}

export { callLlmApi, stateDigest };

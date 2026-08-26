/**
 * Director（AI KP 大脑）—— 纯决策辅助
 *
 * 真正的“决策”由 LLM 完成；本模块负责解析 LLM 输出块、
 * 构造工具结果消息、决定循环是否继续。零 DSH 依赖。
 */

/**
 * 从 LLM 响应块中分离文本块与工具调用块。
 * @param {Array<object>} blocks - dsh-llm BlockAssembler 输出的 blocks
 * @returns {{ textBlocks: Array<object>, calls: Array<object> }}
 */
export function parseAssistantBlocks(blocks) {
  const textBlocks = [];
  const calls = [];
  for (const block of blocks ?? []) {
    if (block.type === "text") textBlocks.push(block);
    else if (block.type === "tool-call") calls.push(block);
  }
  return { textBlocks, calls };
}

/**
 * 决定本轮循环的下一步。
 * @param {Array<object>} blocks
 * @returns {{ kind: "narrate", text: string } | { kind: "tools", calls: Array<object>, text: string }}
 */
export function decideNext(blocks) {
  const { textBlocks, calls } = parseAssistantBlocks(blocks);
  const text = textBlocks.map((block) => block.text ?? "").join("").trim();
  if (calls.length === 0) {
    return { kind: "narrate", text };
  }
  return { kind: "tools", calls, text };
}

/**
 * 将工具调用结果组装为 LLM 工具结果消息。
 * @param {Array<object>} calls - LLM 工具调用块
 * @param {Array<{ ok: boolean, text: string }>} outcomes - 与 calls 等长的执行结果
 * @returns {Array<object>}
 */
export function buildToolResultMessages(calls, outcomes) {
  const messages = [];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const outcome = outcomes[i] ?? { ok: false, text: "（无执行结果）" };
    messages.push({
      role: "user",
      source: { kind: "tool", callId: call.id },
      content: [
        {
          type: "tool-result",
          toolCallId: call.id,
          content: [{ type: "text", text: outcome.text }],
          isError: !outcome.ok,
        },
      ],
    });
  }
  return messages;
}

/**
 * 解析 LLM 返回的 tool-call 参数 JSON。
 * @param {string} rawArguments
 * @returns {object}
 */
export function parseToolArguments(rawArguments) {
  try {
    return JSON.parse(rawArguments || "{}");
  } catch {
    return {};
  }
}

/**
 * 把工具调用块组装为 assistant 消息内容。
 * @param {Array<object>} textBlocks
 * @param {Array<object>} calls
 * @returns {Array<object>}
 */
export function buildAssistantContent(textBlocks, calls) {
  return [
    ...textBlocks.map((block) => ({ type: "text", text: block.text ?? "" })),
    ...calls.map((block) => ({
      type: "tool-call",
      id: block.id,
      name: block.name,
      arguments: block.arguments,
    })),
  ];
}

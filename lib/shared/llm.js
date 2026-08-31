/**
 * LLM HTTP 调用（DSH-free）
 *
 * 从 chat-bridge 中抽出的共享实现：config.json 读取 + OpenAI 兼容 API 调用。
 * 聊天桥与导入工具共用同一实现，避免重复与循环依赖。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadLlmConfig(dataDir) {
  const configFile = join(dataDir, "config.json");
  try {
    if (existsSync(configFile)) return JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    // ignore
  }
  return {};
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function toOpenAiMessages(messages, system) {
  const out = [];
  if (typeof system === "string" && system.trim().length > 0) {
    out.push({ role: "system", content: system });
  }
  for (const message of messages ?? []) {
    const toolResult = (message.content ?? []).find(
      (block) => block?.type === "tool-result"
    );
    if (toolResult !== undefined) {
      out.push({
        role: "tool",
        tool_call_id:
          toolResult.toolCallId ?? message.source?.callId ?? "tool-call",
        content: textOf(toolResult.content),
      });
      continue;
    }

    const calls = (message.content ?? []).filter(
      (block) => block?.type === "tool-call"
    );
    const converted = {
      role: message.role === "assistant" ? "assistant" : "user",
      content: textOf(message.content) || (calls.length > 0 ? null : ""),
    };
    if (calls.length > 0) {
      converted.tool_calls = calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments:
            typeof call.arguments === "string"
              ? call.arguments
              : JSON.stringify(call.arguments ?? {}),
        },
      }));
    }
    out.push(converted);
  }
  return out;
}

function toJsonSchema(parameters) {
  if (parameters?.type === "object") return parameters;
  const properties = {};
  const required = [];
  for (const [name, raw] of Object.entries(parameters ?? {})) {
    const { required: isRequired, ...schema } = raw ?? {};
    properties[name] = schema;
    if (isRequired === true) required.push(name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * 调用 OpenAI 兼容 Chat Completions API（非流式）。
 * @param {string} dataDir - 数据目录（读取 config.json）
 * @param {Array} messages - 对话消息
 * @param {object} [options]
 * @returns {Promise<{blocks: object[], finish: object, usage: object}>}
 */
export async function callLlmApi(dataDir, messages, options = {}) {
  const cfg = loadLlmConfig(dataDir);
  const provider = options.provider || cfg.llmProvider || process.env.COC_LLM_PROVIDER || "deepseek";
  const apiKey = cfg.apiKey || process.env.COC_API_KEY || "";
  const model = options.model || cfg.llmModel || process.env.COC_LLM_MODEL || "deepseek-chat";
  const baseUrl =
    cfg.apiBaseUrl ||
    process.env.COC_LLM_BASE_URL ||
    process.env.COC_API_BASE_URL ||
    "";

  let url = baseUrl;
  if (!url) {
    if (provider === "deepseek") url = "https://api.deepseek.com/v1/chat/completions";
    else if (provider === "openai" || provider === "openai-compatible") url = "https://api.openai.com/v1/chat/completions";
    else url = "https://api.deepseek.com/v1/chat/completions";
  }
  if (!apiKey) throw new Error("未配置 API Key，请在设置面板中填写");

  const request = {
    model,
    messages: toOpenAiMessages(messages, options.system),
    temperature: options.temperature ?? 0.3,
    max_tokens: options.max_tokens ?? 4096,
    stream: false,
  };
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    request.tools = options.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toJsonSchema(tool.parameters),
      },
    }));
    request.tool_choice = "auto";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const rawError = await response.text().catch(() => "");
    const errText =
      apiKey.length > 0 ? rawError.split(apiKey).join("[REDACTED]") : rawError;
    throw new Error("LLM API 错误 " + response.status + ": " + errText.slice(0, 200));
  }
  const json = await response.json();
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const blocks = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: "tool-call",
      id: call.id,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    });
  }
  return {
    blocks,
    finish: { kind: choice.finish_reason ?? "complete" },
    usage: json.usage || {},
  };
}

/**
 * 面板聊天桥（KP 迷你循环：LLM + coc 新工具调用）
 *
 * Step 4：从 legacy-index.js 迁移而来，内部使用 adapter 新工具（Core → Event → State）。
 * 状态读写统一通过 deps.persistence；每轮工具执行后同步 GameSession 并保存 core。
 */
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildKpSystemPrompt,
  buildLoopMessages,
  parseAssistantBlocks,
  decideNext,
  buildAssistantContent,
  buildToolResultMessages,
  parseToolArguments,
  formatNarration,
  isBusyStale,
  summarizeReachability,
} from "../../core/index.js";
import { loadSession, commitSession, nowIso } from "../tools/helpers.js";

// ── 状态摘要 ──────────────────────────────────────────────

export function stateDigest(state) {
  return {
    id: state.id,
    title: state.title,
    kpMode: state.kpMode,
    currentScene: state.currentScene,
    currentBranchId: state.currentBranchId,
    time: state.time,
    synopsis: state.synopsis,
    rules: state.rules === null ? null : { name: state.rules.name, chars: state.rules.chars },
    scenario: state.scenario === null ? null : { name: state.scenario.name, chars: state.scenario.chars },
    characters: state.characters,
    keyPoints: state.keyPoints,
    branches: state.branches,
    tasks: state.tasks,
    entities: state.entities,
    reminders: state.reminders,
    recentRolls: state.rollHistory.slice(-12).reverse(),
    toolTrace: state.toolTrace.slice(-10).reverse(),
    logLength: state.log.length,
  };
}

// ── KP 系统提示 / 消息构建：使用 Core ContextBuilder ─────

// ── LLM 调用 ──────────────────────────────────────────────

function loadLlmConfig(dataDir) {
  const configFile = join(dataDir, "config.json");
  try {
    if (existsSync(configFile)) return JSON.parse(readFileSync(configFile, "utf8"));
  } catch { /* ignore */ }
  return {};
}

export async function callLlmApi(dataDir, messages, options = {}) {
  const cfg = loadLlmConfig(dataDir);
  const provider = cfg.llmProvider || process.env.COC_LLM_PROVIDER || "deepseek";
  const apiKey = cfg.apiKey || process.env.COC_API_KEY || "";
  const model = cfg.llmModel || process.env.COC_LLM_MODEL || "deepseek-chat";
  const baseUrl = cfg.apiBaseUrl || process.env.COC_API_BASE_URL || "";

  let url = baseUrl;
  if (!url) {
    if (provider === "deepseek") url = "https://api.deepseek.com/v1/chat/completions";
    else if (provider === "openai" || provider === "openai-compatible") url = "https://api.openai.com/v1/chat/completions";
    else url = "https://api.deepseek.com/v1/chat/completions";
  }
  if (!apiKey) throw new Error("未配置 API Key，请在设置面板中填写");

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.max_tokens ?? 4096,
      stream: false,
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error("LLM API 错误 " + response.status + ": " + errText.slice(0, 200));
  }
  const json = await response.json();
  const text = json.choices?.[0]?.message?.content || "";
  return { blocks: [{ type: "text", text }], finish: { kind: "complete" }, usage: json.usage || {} };
}

async function streamBlocks(deps, options) {
  const ctx = deps.ctx;
  const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
  if (llm === undefined) return callLlmApi(deps.dataDir, options.messages, options);

  let model = deps.llmModel;
  let provider = deps.llmProvider;
  const defaultModel = typeof ctx.get === "function" ? ctx.get("agentDefaultModel") : undefined;
  if (defaultModel !== undefined && typeof defaultModel.currentSelection === "function") {
    const selection = defaultModel.currentSelection();
    if (selection?.provider) provider = selection.provider;
    if (selection?.model) model = selection.model;
  }
  const assembler = new BlockAssembler();
  for await (const chunk of llm.stream({ provider, model, ...options })) assembler.push(chunk);
  return { blocks: assembler.blocks(), finish: assembler.finish, usage: assembler.usage };
}

// ── 日志 ──────────────────────────────────────────────────

function appendLog(state, kind, text, player = "") {
  state.log.push({ seq: state.log.length + 1, at: nowIso(), kind, player, text });
  if (state.log.length > 600) state.log = state.log.slice(-600);
  return state.log[state.log.length - 1];
}

// ── 工具执行辅助 ──────────────────────────────────────────

async function executeToolForLoop(def, args) {
  try {
    const data = await def.execute(args, {});
    const rendered = def.output.render(args, data);
    const text = Array.isArray(rendered) && rendered[0]?.text !== undefined ? rendered[0].text : JSON.stringify(data);
    return { ok: true, text };
  } catch (error) {
    return { ok: false, text: `错误：${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── KP 迷你循环 ───────────────────────────────────────────

const PANEL_TOOLS = [
  "coc_roll", "coc_roll_secret", "coc_scene", "coc_task", "coc_entity", "coc_pc",
  "coc_branch", "coc_remind", "coc_kp", "coc_query_rule", "coc_sanity_check",
  "coc_combat_resolve", "coc_skill_growth", "coc_status",
];

/**
 * 创建聊天桥。
 * @param {object} deps - { ctx, dataDir, defaultGame, persistence, session, stateKey, toolDefs, llmProvider, llmModel, maxChatRounds, maxChatLog }
 */
export function createChatBridge(deps) {
  const touchFlat = (gameId) => {
    const key = deps.stateKey(gameId);
    let flat = deps.persistence.load(key);
    if (flat === null) {
      flat = {
        id: gameId,
        title: gameId,
        updatedAt: nowIso(),
        kpMode: "ai",
        rules: null,
        scenario: null,
        characters: [],
        keyPoints: [],
        branches: [],
        currentScene: "",
        currentBranchId: "",
        time: "",
        synopsis: "",
        tasks: [],
        entities: [],
        log: [],
        toolTrace: [],
        rollHistory: [],
        reminders: [],
        events: [],
      };
      deps.persistence.save(key, flat);
    }
    return flat;
  };

  const syncSession = (flat) => {
    deps.session.id = flat.id ?? "default";
    deps.session.syncFromFlat(flat);
    deps.session.hydrateCore(flat.core);
  };

  const saveFlat = (gameId, flat) => {
    syncSession(flat);
    flat.core = deps.session.toJSON();
    flat.updatedAt = nowIso();
    deps.persistence.save(deps.stateKey(gameId), flat);
  };

  async function runKpTurn(gameId, text, player) {
    let flat = touchFlat(gameId);
    if (flat.busy === true) {
      // Narrative Recovery：busy 卡死超过 5 分钟自动恢复
      if (isBusyStale(flat, nowIso())) {
        syncSession(flat);
        deps.session.recordTrace({ kind: "recovery-busy-reset", recoveredAt: nowIso() });
        flat.busy = false;
        flat.core = deps.session.toJSON();
        flat.updatedAt = nowIso();
        deps.persistence.save(deps.stateKey(gameId), flat);
      } else {
        throw new Error("KP 正在回复中，请稍候");
      }
    }
    flat.busy = true;
    saveFlat(gameId, flat);

    try {
      appendLog(flat, "user", text, player);
      // 先把玩家输入持久化：工具执行后我们会从磁盘重载 flat，
      // 若不落盘，工具重载会把内存里的玩家输入冲掉。
      saveFlat(gameId, flat);
      const messages = buildLoopMessages(flat.log ?? [], deps.maxChatLog);
      let narration = "";
      let rounds = 0;
      let lastFinish = null;

      for (; rounds < deps.maxChatRounds; rounds += 1) {
        const response = await streamBlocks(deps, {
          system: buildKpSystemPrompt({ ...flat, endingStatus: summarizeReachability(deps.session.plot) }),
          messages,
          tools: PANEL_TOOLS.map((toolName) => {
            const def = deps.toolDefs.get(toolName);
            return { name: def.name, description: def.description, parameters: def.parameters };
          }),
        });
        const blocks = response.blocks;
        lastFinish = response.finish;
        const { textBlocks, calls } = parseAssistantBlocks(blocks);
        messages.push({
          role: "assistant",
          source: { kind: "model" },
          content: buildAssistantContent(textBlocks, calls),
        });

        const decision = decideNext(blocks);
        if (decision.kind === "narrate") {
          narration = decision.text;
          break;
        }

        const outcomes = [];
        const traceEntries = [];
        for (const call of calls) {
          const def = deps.toolDefs.get(call.name);
          const parsed = parseToolArguments(call.arguments);
          const outcome = def === undefined
            ? { ok: false, text: `未知工具 ${call.name}` }
            : await executeToolForLoop(def, parsed);
          outcomes.push(outcome);
          traceEntries.push({ at: nowIso(), round: rounds + 1, tool: call.name, args: parsed, ok: outcome.ok, text: outcome.text.slice(0, 240) });
        }
        messages.push(...buildToolResultMessages(calls, outcomes));

        // 工具已各自持久化状态；重新加载最新 flat，把本轮 trace 并入 core 的 session.trace
        const key = deps.stateKey(gameId);
        flat = deps.persistence.load(key) ?? flat;
        flat.toolTrace.push(...traceEntries);
        if (flat.toolTrace.length > 200) flat.toolTrace = flat.toolTrace.slice(-200);
        syncSession(flat);
        for (const entry of traceEntries) {
          deps.session.recordTrace({ kind: "tool-loop", ...entry });
        }
        flat.core = deps.session.toJSON();
        flat.updatedAt = nowIso();
        deps.persistence.save(key, flat);
      }

      narration = formatNarration(narration, lastFinish);
      appendLog(flat, "kp", narration);
      flat.busy = false;
      saveFlat(gameId, flat);

      return {
        rounds,
        busy: false,
        narration,
        finish: lastFinish ?? null,
        logLength: flat.log.length,
        digest: stateDigest(flat),
      };
    } finally {
      const key = deps.stateKey(gameId);
      const latest = deps.persistence.load(key);
      if (latest !== null) {
        latest.busy = false;
        deps.persistence.save(key, latest);
      }
    }
  }

  return { runKpTurn, touchFlat, saveFlat, stateDigest, buildKpSystemPrompt };
}

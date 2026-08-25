/**
 * 面板聊天桥（KP 迷你循环：LLM + coc 新工具调用）
 *
 * Step 4：从 legacy-index.js 迁移而来，内部使用 adapter 新工具（Core → Event → State）。
 * 状态读写统一通过 deps.persistence；每轮工具执行后同步 GameSession 并保存 core。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildKpSystemPrompt,
  buildLoopMessages,
  extractCheckpoints,
  extractSceneFacts,
  findRoomFloorConflict,
  inferSceneFromText,
  parseAssistantBlocks,
  decideNext,
  buildAssistantContent,
  buildToolResultMessages,
  parseToolArguments,
  formatNarration,
  isBusyStale,
  summarizeReachability,
} from "../../core/index.js";
import { commitSession, nextId, nowIso, rollEvent } from "../tools/helpers.js";
import { PANEL_TOOLS } from "../tools/index.js";
import {
  containsResultPhrase,
  formatCheckLine,
  formatRaResultLine,
  parseCheckRequests,
  parseRaCommand,
  performRaRoll,
  resolveRaTarget,
  stripCheckRequests,
  stripResultPhrases,
} from "./check-command.js";
import {
  checkKey,
  matchActionToGates,
  mergeCheckGates,
  resolvePendingChoice,
} from "./check-gates.js";

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

export async function callLlmApi(dataDir, messages, options = {}) {
  const cfg = loadLlmConfig(dataDir);
  const provider = cfg.llmProvider || process.env.COC_LLM_PROVIDER || "deepseek";
  const apiKey = cfg.apiKey || process.env.COC_API_KEY || "";
  const model = cfg.llmModel || process.env.COC_LLM_MODEL || "deepseek-chat";
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

/**
 * 创建聊天桥。
 * @param {object} deps - { ctx, dataDir, defaultGame, persistence, session, stateKey, toolDefs, llmProvider, llmModel, maxChatRounds, maxChatLog }
 */
export function createSharedChatBridge(deps) {
  const streamBlocks =
    typeof deps.streamBlocks === "function"
      ? deps.streamBlocks
      : (options) => callLlmApi(deps.dataDir, options.messages, options);
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
        pendingChecks: [],
        skippedChecks: [],
        scenarioFacts: [],
        scenarioCheckpoints: [],
        events: [],
      };
      deps.persistence.save(key, flat);
    }
    return flat;
  };

  // 旧场次没有场景事实卡/显式检定点时，用确定性规则从剧本原文补算。
  const enrichScenarioFacts = (flat) => {
    const text = flat.scenario?.text ?? "";
    if (text.trim().length === 0) return flat;
    if (!Array.isArray(flat.scenarioFacts) || flat.scenarioFacts.length === 0) {
      flat.scenarioFacts = extractSceneFacts(text);
    }
    if (!Array.isArray(flat.scenarioCheckpoints)) {
      flat.scenarioCheckpoints = extractCheckpoints(text);
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

  // 明骰一律由玩家发送 .ra 指令触发，主持循环不再向 KP 暴露 coc_roll。
  const CHAT_KP_TOOLS = PANEL_TOOLS.filter((toolName) => toolName !== "coc_roll");
  const ROLL_TOOL_NAMES = new Set([
    "coc_roll",
    "coc_roll_secret",
    "coc_combat_resolve",
    "coc_sanity_check",
    "coc_skill_growth",
  ]);

  async function runNarrationLoop(gameId, flat, messages, opts = {}) {
    let narration = "";
    let rounds = 0;
    let lastFinish = null;
    // .ra 路径：玩家已掷骰且结果已注入【系统检定】，本轮允许叙述中残留结果词（稍后剥离）。
    let calledRollTool = opts.calledRollTool === true;
    let pendingChecks = [];
    const toolChecks = [];

    for (; rounds < deps.maxChatRounds; rounds += 1) {
      const response = await streamBlocks({
        system: buildKpSystemPrompt({ ...flat, endingStatus: summarizeReachability(deps.session.plot) }),
        messages,
        tools: CHAT_KP_TOOLS.flatMap((toolName) => {
          const def = deps.toolDefs.get(toolName);
          return def === undefined
            ? []
            : [{ name: def.name, description: def.description, parameters: def.parameters }];
        }),
        max_tokens: 1200,
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
        pendingChecks = parseCheckRequests(decision.text);
        let text = stripCheckRequests(decision.text);

        // 判定词守卫：叙述里出现“困难成功”等词但本轮没调用任何检定工具时，
        // 说明模型在自行编造结果——不落盘，追加纠正消息后重试一轮。
        if (containsResultPhrase(text) && !calledRollTool) {
          messages.push({
            role: "user",
            source: { kind: "system" },
            content: [{
              type: "text",
              text: "（系统）你的叙述里包含检定结果词（如“困难成功”）或骰值，但本轮没有调用任何检定工具。请重新处理：需要玩家明骰时，在叙述结尾给出【团检：技能名】等待玩家发送 .ra 指令；需要暗骰时调用 coc_roll_secret。只写效果，不要出现成功档位词或骰值。",
            }],
          });
          continue;
        }

        // 若本轮调用过检定工具（暗骰等），系统骰行/暗骰记录已存在，剥掉叙述中残留的档位词。
        text = stripResultPhrases(text);

        // 只给了团检标记或空白时，追加纠正并重试，不要把空叙述落盘成“请再说一次”。
        if (text.trim().length === 0) {
          messages.push({
            role: "user",
            source: { kind: "system" },
            content: [{
              type: "text",
              text: pendingChecks.length > 0
                ? "（系统）你只给出了团检标记，没有输出剧情叙述。请直接输出本轮的剧情叙述，团检标记放在最后一行即可。"
                : "（系统）本轮没有产生剧情叙述文本。请直接输出剧情叙述。",
            }],
          });
          continue;
        }

        narration = text;
        break;
      }

      const outcomes = [];
      const traceEntries = [];
      for (const call of calls) {
        const def = deps.toolDefs.get(call.name);
        // 聊天轮次只能写入当前场次；忽略模型参数中可能出现的其他 game。
        const parsed = { ...parseToolArguments(call.arguments), game: gameId };
        const outcome = def === undefined
          ? { ok: false, text: `未知工具 ${call.name}` }
          : await executeToolForLoop(def, parsed);
        outcomes.push(outcome);
        traceEntries.push({ at: nowIso(), round: rounds + 1, tool: call.name, args: parsed, ok: outcome.ok, text: outcome.text.slice(0, 240) });

        // coc_check 登记的门禁由工具自己落盘；这里再收集一份供返回与测试使用。
        if (call.name === "coc_check" && outcome.ok) {
          const gate = {
            skill: String(parsed.skill ?? "").trim(),
            difficulty: parsed.difficulty === "hard" || parsed.difficulty === "extreme" ? parsed.difficulty : "regular",
            action: String(parsed.action ?? "").trim(),
            hidden: parsed.hidden === true,
          };
          if (gate.skill.length > 0 && !toolChecks.some((check) => checkKey(check) === checkKey(gate))) {
            toolChecks.push(gate);
          }
        }
      }
      if (calls.some((call) => ROLL_TOOL_NAMES.has(call.name))) calledRollTool = true;
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

    return { narration, lastFinish, rounds, pendingChecks, calledRollTool, toolChecks };
  }

  async function runKpTurn(gameId, text, player) {
    let flat = touchFlat(gameId);
    flat = enrichScenarioFacts(flat);
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

    const ra = parseRaCommand(text);
    const gatesBeforeKeys = new Set((flat.pendingChecks ?? []).map(checkKey));

    // 把除 exceptGateId 外的门禁记入 skippedChecks（reason=abandoned/superseded），
    // 玩家改做其他动作 = 旧门禁作废，而不是“已跳过检定”。
    const abandonGates = (exceptGateId, reason) => {
      const pending = Array.isArray(flat.pendingChecks) ? flat.pendingChecks : (flat.pendingChecks = []);
      const skipped = Array.isArray(flat.skippedChecks) ? flat.skippedChecks : (flat.skippedChecks = []);
      for (const gate of pending) {
        if (gate.id === exceptGateId) continue;
        skipped.push({ ...gate, skippedAt: nowIso(), reason });
      }
      flat.pendingChecks = pending.filter((gate) => gate.id === exceptGateId);
      if (skipped.length > 80) flat.skippedChecks = skipped.slice(-80);
    };
    const assignGateIds = (gates) => {
      for (const gate of gates) {
        if (typeof gate.id !== "string" || gate.id.length === 0) {
          gate.id = nextId("chk", gates, "id");
        }
      }
    };
    const choiceText = (candidates) =>
      candidates.map((candidate, index) => `${index + 1})「${candidate}」`).join(" ");

    try {
      appendLog(flat, "user", text, player);
      // 先把玩家输入持久化：工具执行后我们会从磁盘重载 flat，
      // 若不落盘，工具重载会把内存里的玩家输入冲掉。
      saveFlat(gameId, flat);

      // 空 .ra：温柔提示，不报错。
      if (ra !== null && ra.skill.length === 0) {
        appendLog(flat, "check", "[提示] 请发送 .ra技能名 进行检定，例如 .ra聆听");
        flat.busy = false;
        saveFlat(gameId, flat);
        return {
          rounds: 0,
          busy: false,
          narration: "",
          finish: null,
          logLength: flat.log.length,
          digest: stateDigest(flat),
          pendingChecks: flat.pendingChecks,
        };
      }

      // 玩家在“多候选确认”后的回复：编号或动作文本。
      let choiceAction = null;
      if (ra === null && flat.pendingChoice !== null && flat.pendingChoice !== undefined) {
        choiceAction = resolvePendingChoice(text, flat.pendingChoice);
        if (choiceAction === null) {
          // 没有选择候选动作，而是输入了新动作：旧门禁作废，按新动作继续。
          abandonGates(undefined, "abandoned-choice");
          flat.pendingChoice = null;
          saveFlat(gameId, flat);
        }
      }

      let messages;
      let loopResult;

      if (ra !== null || choiceAction !== null) {
        const skill = ra !== null ? ra.skill : String(flat.pendingChoice?.skill ?? "");
        const difficulty = ra !== null ? ra.difficulty : String(flat.pendingChoice?.difficulty ?? "regular");
        const gates = Array.isArray(flat.pendingChecks) ? flat.pendingChecks : [];
        const skillGates = gates.filter((gate) => gate.skill === skill);

        // 已有候选确认请求时：
        if (flat.pendingChoice !== null && flat.pendingChoice !== undefined) {
          if (ra !== null && flat.pendingChoice.skill === skill) {
            // 玩家又发了同一 .ra：先确认动作，不掷骰。
            appendLog(flat, "check", `[系统] 请先确认要对哪个动作进行 ${skill} 检定：${choiceText(flat.pendingChoice.candidates)}`);
            flat.busy = false;
            saveFlat(gameId, flat);
            return {
              rounds: 0, busy: false, narration: "", finish: null,
              logLength: flat.log.length, digest: stateDigest(flat),
              pendingChecks: flat.pendingChecks,
            };
          }
          if (ra !== null && flat.pendingChoice.skill !== skill) {
            // 玩家改掷其他技能：旧候选作废。
            abandonGates(undefined, "abandoned-choice");
            flat.pendingChoice = null;
            saveFlat(gameId, flat);
          }
        }

        const distinctActions = [...new Set(
          skillGates.map((gate) => String(gate.action ?? "").trim()).filter((action) => action.length > 0)
        )];

        // 多候选动作：先确认动作，不掷骰。
        if (ra !== null && choiceAction === null && distinctActions.length > 1) {
          flat.pendingChoice = { skill, difficulty, candidates: distinctActions, at: nowIso() };
          appendLog(flat, "check", `[系统] 请确认要对哪个动作进行 ${skill} 检定：${choiceText(distinctActions)}`);
          flat.busy = false;
          saveFlat(gameId, flat);
          return {
            rounds: 0, busy: false, narration: "", finish: null,
            logLength: flat.log.length, digest: stateDigest(flat),
            pendingChecks: flat.pendingChecks,
          };
        }

        const action =
          choiceAction !== null
            ? choiceAction
            : distinctActions.length === 1
              ? distinctActions[0]
              : "";
        let selectedGate = null;
        if (choiceAction !== null) {
          selectedGate = gates.find(
            (gate) => gate.skill === skill && String(gate.action ?? "").trim() === choiceAction
          ) ?? null;
        } else if (skillGates.length === 1) {
          selectedGate = skillGates[0];
        } else if (action.length > 0) {
          selectedGate = skillGates.find((gate) => String(gate.action ?? "").trim() === action) ?? null;
        }

        const { name, target } = resolveRaTarget(flat, player, skill);
        const result = performRaRoll(skill, target, difficulty);
        const rollLine = formatRaResultLine(name, skill, result);
        appendLog(flat, "roll", rollLine, name);

        // 本次检定的门禁已解决；同轮其他门禁作废（玩家改做其他动作）。
        if (skillGates.length > 0) {
          abandonGates(selectedGate?.id, "superseded");
          if (selectedGate !== null) {
            flat.pendingChecks = flat.pendingChecks.filter((gate) => gate.id !== selectedGate.id);
          }
        }
        flat.pendingChoice = null;

        syncSession(flat);
        commitSession(deps, gameId, deps.session, flat, [
          rollEvent(gameId, {
            kind: "open",
            player: name,
            label: `${skill}检定`,
            skill,
            expression: "d100",
            dice: result.dice,
            rolled: result.rolled,
            total: result.total,
            target: result.target ?? null,
            difficulty,
            tier: result.tier,
            passed: result.passed,
          }),
        ]);
        flat = deps.persistence.load(deps.stateKey(gameId)) ?? flat;

        messages = buildLoopMessages(flat.log ?? [], deps.maxChatLog);
        const rollSystemText =
          action.length > 0
            ? `【系统检定】${rollLine}。玩家想对「${action}」进行检定。请据此直接叙述该动作的剧情结果，只写效果，不要出现成功档位词或骰值。`
            : `【系统检定】${rollLine}。请据此继续叙述，只写效果，不要出现成功档位词或骰值。`;
        messages.push({
          role: "user",
          source: { kind: "system" },
          content: [{ type: "text", text: rollSystemText }],
        });
        loopResult = await runNarrationLoop(gameId, flat, messages, { calledRollTool: true });
      } else {
        // 动作文本：先看是否命中已登记门禁。
        const matched = matchActionToGates(text, flat.pendingChecks ?? []);
        if (matched.length > 0) {
          // 命中门禁：系统阻止剧情推进，要求先检定。
          const lines = [...new Set(matched.map((gate) => formatCheckLine(gate.skill, gate.difficulty)))];
          appendLog(flat, "check", `[系统] 该动作需要先通过检定：${lines.join("  ")}`);
          flat.busy = false;
          saveFlat(gameId, flat);
          return {
            rounds: 0,
            busy: false,
            narration: "",
            finish: null,
            logLength: flat.log.length,
            digest: stateDigest(flat),
            pendingChecks: flat.pendingChecks,
          };
        }

        // 未命中：旧门禁作废（玩家改做其他动作），按自由动作交给 KP。
        abandonGates(undefined, "abandoned");
        flat.pendingChoice = null;
        saveFlat(gameId, flat);

        messages = buildLoopMessages(flat.log ?? [], deps.maxChatLog);
        loopResult = await runNarrationLoop(gameId, flat, messages, { calledRollTool: false });
      }

      let narration = stripResultPhrases(formatNarration(loopResult.narration, loopResult.lastFinish));

      // 场景事实守卫：叙述里出现“二楼的书房”这类楼层-房间冲突时，
      // 追加系统纠正消息并让 LLM 重写一次，冲突叙述不落盘。
      const conflict = findRoomFloorConflict(narration, flat.scenarioFacts ?? []);
      if (conflict !== null) {
        messages.push({
          role: "user",
          source: { kind: "system" },
          content: [{
            type: "text",
            text: `（系统）你的叙述疑似与剧本事实冲突：${conflict.room}应在${conflict.expectedFloor}，但叙述中出现了${conflict.foundFloor}附近的${conflict.room}。请以【当前场景原文】为准重写这一段，不要改变楼层与房间归属。`,
          }],
        });
        const retryResult = await runNarrationLoop(gameId, flat, messages, { calledRollTool: loopResult.calledRollTool });
        const retryNarration = stripResultPhrases(formatNarration(retryResult.narration, retryResult.lastFinish));
        if (retryNarration.trim().length > 0) {
          loopResult = retryResult;
          narration = retryNarration;
        }
      }

      // 循环内工具可能已落盘最新状态（coc_scene/coc_pc/coc_check…），
      // 这里必须从磁盘重载，避免用旧的 flat 覆盖掉循环中的状态变更。
      flat = deps.persistence.load(deps.stateKey(gameId)) ?? flat;

      // 场景落地兜底：若 LLM 没有调用 coc_scene 设置当前场景，
      // 由系统从叙述文本中确定性推断并写入状态（不打扰玩家）。
      if ((flat.currentScene ?? "") === "") {
        const inferred = inferSceneFromText(narration, flat.scenarioFacts ?? []);
        if (inferred !== null && inferred.length > 0) {
          flat.currentScene = inferred;
        }
      }

      // 文本 [团检] 标记是旧模型/兜底路径；coc_check 工具已把门禁落盘，
      // 这里只把文本标记合并进去（去重），统一渲染 .ra 提示行。
      const textGates = [];
      for (const check of loopResult.pendingChecks ?? []) {
        const hints = Array.isArray(check.hints)
          ? check.hints.filter((hint) => typeof hint === "string" && hint.trim() !== "")
          : (typeof check.hint === "string" && check.hint.trim() !== "" ? [check.hint] : []);
        for (const hint of hints) {
          textGates.push({
            skill: check.skill,
            difficulty: check.difficulty ?? "regular",
            action: hint,
            hidden: false,
            at: nowIso(),
            scene: flat.currentScene ?? "",
            source: "text-marker",
          });
        }
      }
      flat.pendingChecks = mergeCheckGates(flat.pendingChecks ?? [], textGates);
      assignGateIds(flat.pendingChecks);

      appendLog(flat, "kp", narration);
      for (const gate of flat.pendingChecks) {
        if (!gatesBeforeKeys.has(checkKey(gate))) {
          appendLog(flat, "check", formatCheckLine(gate.skill, gate.difficulty));
        }
      }

      flat.busy = false;
      saveFlat(gameId, flat);

      return {
        rounds: loopResult.rounds,
        busy: false,
        narration,
        finish: loopResult.lastFinish ?? null,
        logLength: flat.log.length,
        digest: stateDigest(flat),
        pendingChecks: flat.pendingChecks,
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

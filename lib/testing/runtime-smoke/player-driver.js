/**
 * PlayerDriver 统一玩家接口（runtime smoke / 上线评审用）
 *
 * 所有玩家实现同一个接口，runner 不关心玩家是脚本、LLM 还是外部 agent：
 *
 *   {
 *     id: string,
 *     // 每轮收到“玩家可见”上下文，返回前端输入框会发送的内容（纯字符串）
 *     nextInput(ctx) -> Promise<string>,
 *     // 可选：游戏结束时回调
 *     onGameEnd?(report) -> Promise<void>,
 *   }
 *
 * ctx 只包含玩家可见信息（叙述/系统检定行/公开 log/场景/时间），
 * 不包含 pendingChecks、debug 等 KP 底牌，保证 LLM 玩家测试诚实。
 *
 * 外部 agent（如 Codex）既可以 import 本模块传入自定义 driver，
 * 也可以用 CLI 的 --player-endpoint 走 HTTP JSON 接口。
 */
import { callLlmApi, loadLlmConfig } from "../../shared/llm.js";

// ── 公开可见 log 行 ─────────────────────────────────────────

const PLAYER_VISIBLE_KINDS = new Set(["user", "kp", "check", "roll"]);

/**
 * 从 flat.log 中截取玩家可见的尾部日志。
 * @param {object} flat
 * @param {number} [lastN=14]
 * @returns {Array<{kind: string, text: string, at?: string, player?: string}>}
 */
export function playerVisibleLog(flat, lastN = 14) {
  const log = Array.isArray(flat?.log) ? flat.log : [];
  return log
    .filter((entry) => entry !== null && typeof entry === "object" && PLAYER_VISIBLE_KINDS.has(entry.kind))
    .slice(-lastN)
    .map((entry) => ({
      kind: entry.kind,
      text: String(entry.text ?? ""),
      at: entry.at ?? "",
      player: entry.player ?? "",
    }));
}

/**
 * 构建玩家可见上下文。
 * @param {object} flat - 最新场次状态（上一轮之后）
 * @param {object} [lastTurn] - 上一轮 runKpTurn 返回
 * @returns {object}
 */
export function buildPlayerContext(flat, lastTurn = null) {
  return {
    round: lastTurn?.round ?? 0,
    narration: String(lastTurn?.narration ?? ""),
    currentScene: String(flat?.currentScene ?? ""),
    time: String(flat?.time ?? ""),
    synopsis: String(flat?.synopsis ?? ""),
    endingReached: flat?.endingReached === true,
    log: playerVisibleLog(flat, 14),
  };
}

// ── 脚本玩家 ────────────────────────────────────────────────

/**
 * 确定性脚本玩家：看到团检提示就发 .ra，看到候选确认就选 1，
 * 否则按 actionQueue 依次行动；队列耗尽后发送 fallbackAction。
 * @param {object} opts
 * @param {string[]} [opts.actions] - 预设动作队列
 * @param {string} [opts.fallbackAction="继续调查。"]
 * @param {string} [opts.name="测试调查员"]
 * @returns {PlayerDriver}
 */
export function createScriptedPlayer(opts = {}) {
  const actions = [...(opts.actions ?? [])];
  const fallbackAction = opts.fallbackAction ?? "继续调查。";
  const name = opts.name ?? "测试调查员";
  let ended = false;

  const checkLinePattern = /\[团检[:：]([^\]】]+)\][^\n]*\[\.ra([^\]】\s]+)/;
  const candidatePattern = /请确认要对哪个动作进行/;

  // 只取“本轮新出现”的提示：位于最后一条 user 条目之后（玩家自己的输入之后）。
  function freshPromptEntries(lastLog) {
    let lastUserIndex = -1;
    for (let i = lastLog.length - 1; i >= 0; i -= 1) {
      if (lastLog[i]?.kind === "user") {
        lastUserIndex = i;
        break;
      }
    }
    return lastLog.slice(lastUserIndex + 1);
  }

  return {
    id: "scripted",
    async nextInput(ctx) {
      if (ctx.endingReached) {
        ended = true;
        return "";
      }
      const lastLog = ctx.log ?? [];
      const fresh = freshPromptEntries(lastLog);
      // 1) 本轮新系统行要求确认候选动作 → 选 1（前端点击第一个候选）。
      for (let i = fresh.length - 1; i >= 0; i -= 1) {
        const text = String(fresh[i]?.text ?? "");
        if (candidatePattern.test(text)) return "1";
      }
      // 2) 最新 KP 叙述或本轮新系统行给出团检提示 → 发 .ra技能（含难度）。
      const narration = String(ctx.narration ?? "");
      const narrationMatch = checkLinePattern.exec(narration);
      if (narrationMatch !== null) {
        return `.ra${narrationMatch[1].trim()}`;
      }
      for (let i = fresh.length - 1; i >= 0; i -= 1) {
        const text = String(fresh[i]?.text ?? "");
        const match = checkLinePattern.exec(text);
        if (match !== null) {
          return `.ra${match[1].trim()}`;
        }
      }
      // 3) 预设动作队列。
      if (actions.length > 0) return actions.shift();
      return fallbackAction;
    },
    async onGameEnd() {
      ended = true;
    },
    name,
  };
}

// ── LLM 玩家 ────────────────────────────────────────────────

/**
 * 真实 LLM 玩家：扮演调查员，只输出下一步输入。
 * 只接收玩家可见上下文，不接触 KP 底牌。
 * @param {object} opts
 * @param {string} opts.dataDir - 读取 config.json 的数据目录
 * @param {object} opts.investigator - 人物卡（name/occupation/skills/inventory）
 * @param {string} [opts.premise] - 剧本导入信息/开场前提（一两句）
 * @param {string} [opts.model] - 默认用 config.llmModel
 * @param {number} [opts.maxTokens=80]
 * @returns {PlayerDriver}
 */
export function createLlmPlayer(opts = {}) {
  const dataDir = opts.dataDir;
  const investigator = opts.investigator ?? {};
  const premise = String(opts.premise ?? "").trim();
  const model = opts.model;
  const maxTokens = opts.maxTokens ?? 300;
  const extraSystem = typeof opts.extraSystem === "string" ? opts.extraSystem : "";

  const skillList = Object.entries(investigator.skills ?? {})
    .map(([skill, value]) => `${skill} ${value}`)
    .join("、");
  const inventoryList = (Array.isArray(investigator.inventory) ? investigator.inventory : []).join("、");

  const system = [
    "你是一个跑团测试玩家，负责扮演一位 CoC 调查员，推动游戏进行。",
    `你扮演：${investigator.name ?? "调查员"}${investigator.occupation ? `（${investigator.occupation}）` : ""}。`,
    skillList.length > 0 ? `你的技能：${skillList}。` : "",
    inventoryList.length > 0 ? `随身物品：${inventoryList}。` : "",
    premise.length > 0 ? `剧本背景：${premise}` : "",
    "",
    "规则：",
    "1) 只输出你下一步要做/说的一句话，不要输出解释、括号备注或多个选项。",
    "2) 如果 KP 的叙述或系统行出现 [团检：技能] [.ra技能]，只输出对应的 .ra技能 命令。",
    "3) 如果系统行提示“请确认要对哪个动作进行”，只输出数字 1。",
    "4) 优先按照剧情推进：从 KP 给出的可选行动中选一个，选最能推进主线的那一项；不要发呆或重复上一轮。",
    "5) 同一地点/线索只调查一轮，之后立刻前往下一个地点或推进剧情；当你已经掌握足够信息时，果断做出关键选择并推进到结局。",
    "6) 不要提出开放性问题，不要反复检查同一物品；如果游戏已经结束，输出空字符串。",
    extraSystem,
  ].filter((line) => line !== "").join("\n");

  return {
    id: "llm-player",
    async nextInput(ctx) {
      if (ctx.endingReached) return "";
      const logLines = (ctx.log ?? []).map((entry) => {
        const who = entry.kind === "user" ? "玩家" : entry.kind === "kp" ? "KP" : entry.kind === "check" ? "系统" : "骰点";
        return `${who}: ${entry.text}`;
      });
      const transcript = logLines.join("\n");
      const current = [
        `当前场景：${ctx.currentScene || "（未知）"}`,
        ctx.time ? `当前时间：${ctx.time}` : "",
        `上一轮 KP 叙述：${ctx.narration || "（游戏刚开始，请发出第一个行动）"}`,
      ].filter((line) => line !== "").join("\n");
      const user = `${transcript}\n\n${current}\n\n请输出你作为玩家的下一步输入。`;
      const messages = [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: user }] },
      ];
      let text = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await callLlmApi(dataDir, messages, {
          model,
          temperature: 0.3,
          max_tokens: maxTokens,
          reasoningEffort: "low",
        });
        text = (result.blocks ?? [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text ?? "")
          .join("")
          .trim();
        const normalized = normalizePlayerInput(text);
        const tooShort =
          normalized.length < 2 &&
          !/^1$/.test(normalized) &&
          !/^\.ra/i.test(normalized);
        if (normalized.length > 0 && !tooShort) break;
        // flash 有时把全部 completion 花在 reasoning 上导致空/截断正文：追问一次。
        messages.push({
          role: "user",
          content: [{ type: "text", text: "（系统）你刚才没有输出完整的玩家行动。请只输出你下一步要做/说的一句话，至少 5 个字；需要检定时输出 .ra技能。" }],
        });
      }
      return normalizePlayerInput(text);
    },
  };
}

/**
 * 规范化 LLM 玩家输出：去引号/句号前缀，保留 .ra 命令。
 * @param {string} raw
 * @returns {string}
 */
export function normalizePlayerInput(raw) {
  let text = String(raw ?? "").trim();
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  text = text.replace(/^[（(]|[）)]$/g, "").trim();
  if (/^\.ra/i.test(text)) {
    const m = text.match(/^\.ra\s*([^\s，。]+)/i);
    if (m) return `.ra${m[1]}`;
  }
  return text;
}

// ── HTTP 外部玩家（Codex 等 agent） ─────────────────────────

/**
 * 通过 HTTP JSON 调用外部 agent 玩家。
 * 请求体 = ctx（玩家可见上下文）；响应体 = { "input": "..." } 或 { "text": "..." }。
 * @param {string} endpoint
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {PlayerDriver}
 */
export function createHttpPlayerDriver(endpoint, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  return {
    id: `http-player:${endpoint}`,
    async nextInput(ctx) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ctx),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`HTTP 玩家接口返回 ${res.status}`);
      }
      const data = await res.json();
      const text = String(data?.input ?? data?.text ?? "").trim();
      return normalizePlayerInput(text);
    },
  };
}

export { loadLlmConfig };

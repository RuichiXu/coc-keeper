/**
 * 结算点语义裁决器（Settlement Semantic Judge）
 *
 * 固定字段匹配只能回答“文本里有没有这些词”，无法回答“事件是否真的发生了”。
 * 本模块用一次非流式 LLM 小调用做语义裁决：给模型看结算点原文、玩家输入、
 * 去菜单后的叙述与当前场景，让它判断每个候选结算点是否已真实发生并作用于 PC。
 *
 * 裁决只回答“发生与否”，骰点与数值变化仍由 coc_sanity_check / coc_pc 确定性执行。
 *
 * 零 DSH 依赖；仅在启用语义结算（deps.enableSemanticSettlement === true）时使用。
 */
import { callLlmApi } from "../llm.js";

/** 单次裁决最多携带的候选结算点数（控制 token 与延迟）。 */
export const SETTLEMENT_JUDGE_MAX_CANDIDATES = 12;

export function buildSettlementJudgeSystem() {
  return [
    "你是 CoC 跑团的结算判定器。你会收到若干剧本结算点（SC 理智损失 / HP 伤害）与一回合的实际游戏文本。",
    "对每个结算点判断：该结算点描述的事件是否已经真实发生，并且由调查员（PC）本人承受。",
    "判定标准：",
    "1. 事件必须已经发生（动作已执行、后果已出现）。计划、讨论、阅读、提问、回忆、转述、选项菜单、他人描述都不算发生。",
    "2. subject 表示事件作用于谁：pc=调查员本人承受；npc=只有 NPC 承受；none=未发生或无人承受。",
    "3. 发生但只是擦伤、被救、未命中、未破防等没有实际损失时，happened 仍为 false。",
    "4. evidence 必须从玩家输入或叙述中逐字摘录最能证明事件发生的短句（不超过 40 字），不要改写。",
    "只输出 JSON，不要输出任何解释或代码块标记。",
  ].join("\n");
}

/**
 * 构造裁决输入。
 * @param {Array<object>} settlements
 * @param {string} playerText
 * @param {string} narration 已剔除菜单行
 * @param {string} currentScene
 * @param {string} pcName
 * @returns {string}
 */
export function buildSettlementJudgePrompt({ settlements, playerText, narration, currentScene, pcName }) {
  const items = settlements.map((settlement) => ({
    id: String(settlement.id ?? ""),
    kind: settlement.kind === "hp" ? "hp" : "san",
    scene: String(settlement.scene ?? ""),
    trigger: String(settlement.trigger ?? "").slice(0, 220),
    loss: String(settlement.damage ?? settlement.sanLoss ?? ""),
  }));
  const context = {
    调查员: pcName,
    当前场景: currentScene,
    玩家输入: String(playerText ?? "").slice(0, 500),
    KP叙述: String(narration ?? "").slice(0, 1600),
    待判定结算点: items,
  };
  return (
    "请判定以下结算点是否已发生：\n" +
    JSON.stringify(context, null, 2) +
    '\n输出格式：{"verdicts":[{"id":"结算点id","happened":true,"subject":"pc","confidence":0.9,"evidence":"原句摘录"}]}'
  );
}

/**
 * 宽容解析裁决输出：兼容围栏、前后缀文本。
 * @param {string} text
 * @returns {{ verdicts?: Array<object> }|null}
 */
export function parseSettlementJudgeOutput(text) {
  const source = String(text ?? "").trim();
  if (source.length === 0) return null;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    if (Array.isArray(parsed?.verdicts)) return parsed;
    if (Array.isArray(parsed)) return { verdicts: parsed };
  } catch {
    // fallthrough to a tolerant verdicts-array extraction
  }
  const verdictsMatch = source.slice(start, end + 1).match(/"verdicts"\s*:\s*(\[[\s\S]*\])/);
  if (verdictsMatch === null) return null;
  try {
    return { verdicts: JSON.parse(verdictsMatch[1]) };
  } catch {
    return null;
  }
}

/**
 * 归一化裁决结果。
 * @param {object|null} parsed
 * @param {Array<object>} candidates
 * @returns {Map<string, {happened:boolean, subject:string, confidence:number, evidence:string}>}
 */
export function normalizeSettlementVerdicts(parsed, candidates) {
  const verdicts = new Map();
  const byId = new Map((parsed?.verdicts ?? []).map((item) => [String(item?.id ?? ""), item]));
  for (const candidate of candidates) {
    const id = String(candidate.id ?? "");
    const item = byId.get(id) ?? {};
    verdicts.set(id, {
      happened: item.happened === true,
      subject: String(item.subject ?? "none").toLowerCase(),
      confidence: Number(item.confidence ?? 0),
      evidence: String(item.evidence ?? "").slice(0, 120),
    });
  }
  return verdicts;
}

/**
 * 构造发送给 callLlmApi 的块式消息（content 必须是 text 块数组）。
 * @param {string} prompt
 * @returns {Array<{role:string, content: Array<{type:string, text:string}>}>}
 */
export function buildSettlementJudgeMessages(prompt) {
  return [{ role: "user", content: [{ type: "text", text: prompt }] }];
}

/**
 * 调用 LLM 对候选结算点做语义裁决。
 * @param {object} deps - chat bridge deps（需要 dataDir）
 * @param {object} input
 * @returns {Promise<{ok:boolean, verdicts?: Map, raw?: string, error?: string, durationMs?: number}>}
 */
export async function judgeSettlements(deps, { settlements, playerText, narration, currentScene, pcName }) {
  const candidates = (Array.isArray(settlements) ? settlements : []).slice(0, SETTLEMENT_JUDGE_MAX_CANDIDATES);
  if (candidates.length === 0) return { ok: true, verdicts: new Map(), durationMs: 0 };
  const prompt = buildSettlementJudgePrompt({
    settlements: candidates,
    playerText,
    narration,
    currentScene,
    pcName,
  });
  const startedAt = Date.now();
  try {
    const response = await callLlmApi(deps.dataDir, buildSettlementJudgeMessages(prompt), {
      system: buildSettlementJudgeSystem(),
      temperature: 0.1,
      max_tokens: 800,
      reasoningEffort: "low",
    });
    const durationMs = Date.now() - startedAt;
    const raw = (response.blocks ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const parsed = parseSettlementJudgeOutput(raw);
    if (parsed === null) return { ok: false, error: "empty-parse", raw, durationMs };
    const verdicts = normalizeSettlementVerdicts(parsed, candidates);
    return { ok: true, verdicts, raw, durationMs };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt };
  }
}

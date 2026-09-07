/**
 * 结局语义裁决器（Ending Semantic Judge）
 *
 * 终局是否成立不再依赖“幕落/本次跑团到此”等固定收束语词表：
 * 当最终分支已 reached+chosen 后，每轮用一次非流式 LLM 小调用判断
 * “玩家所选结局是否已经在叙述/玩家输入中被确认”。
 *
 * 裁决只回答 ended 与否；endingReached 仍由聊天桥落盘，结局事件与
 * 数值状态仍走确定性路径。零 DSH 依赖。
 */
import { callLlmApi } from "../llm.js";

export function buildEndingJudgeSystem() {
  return [
    "你是 CoC 跑团的结局判定器。你会收到最终分支的候选选项、当前场景、玩家输入和 KP 叙述。",
    "判断：本回合中，冒险是否已经实际落幕（某个最终分支的结局已经成立）。",
    "判定标准：",
    "1. ended=true 仅当：KP 叙述已经实际描述了某个最终分支的最终结果与收束（行动完成、事件落幕、后续或尾声），或玩家明确要求以该选择结束/结算结局。",
    "2. ended=false：只是讨论、计划、确认选择但尚未执行，或叙述仍在过程之中、尚未抵达最终结果。",
    "3. 选择本身被提及、或结局标题出现，不等于结局已成立。",
    "4. endingLabel 表示成立的结局对应哪个最终分支选项：优先填选项的 leadsTo（如“寒星降临”），无法对应时填空字符串。",
    "5. evidence 必须从玩家输入或 KP 叙述中逐字摘录最能证明结局已成立的短句（不超过 40 字），不要改写。",
    "只输出 JSON，不要输出任何解释或代码块标记。",
  ].join("\n");
}

/**
 * 构造结局裁决输入。
 * @param {object} input
 * @returns {string}
 */
export function buildEndingJudgePrompt({ finalBranch, playerText, narration, currentScene, pcName }) {
  const chosen = String(finalBranch?.chosen ?? "");
  const options = (finalBranch?.options ?? []).map((option) => ({
    label: String(option?.label ?? ""),
    leadsTo: String(option?.leadsTo ?? ""),
  }));
  const chosenOption = options.find((option) => option.label === chosen) ?? null;
  const context = {
    调查员: pcName,
    当前场景: currentScene,
    最终分支: String(finalBranch?.title ?? ""),
    候选选项: options,
    已选选项: chosen.length > 0 ? chosen : "（尚未显式标记）",
    已选结局: String(chosenOption?.leadsTo ?? ""),
    玩家输入: String(playerText ?? "").slice(0, 500),
    KP叙述: String(narration ?? "").slice(0, 1600),
  };
  return (
    "请判定本回合冒险是否已实际落幕，并指出对应哪个最终分支选项：\n" +
    JSON.stringify(context, null, 2) +
    '\n输出格式：{"ended":true,"endingLabel":"寒星降临","confidence":0.9,"evidence":"原句摘录"}'
  );
}

/**
 * 宽容解析结局裁决输出。
 * @param {string} text
 * @returns {{ ended?: boolean, endingLabel?: string, confidence?: number, evidence?: string }|null}
 */
export function parseEndingJudgeOutput(text) {
  const source = String(text ?? "").trim();
  if (source.length === 0) return null;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    if (typeof parsed?.ended === "boolean") return parsed;
  } catch {
    // fallthrough
  }
  const ended = source.slice(start, end + 1).match(/"ended"\s*:\s*(true|false)/);
  if (ended === null) return null;
  const label = source.slice(start, end + 1).match(/"endingLabel"\s*:\s*"([^"]*)"/);
  return { ended: ended[1] === "true", endingLabel: label !== null ? label[1] : "" };
}

/**
 * 构造发送给 callLlmApi 的块式消息。
 * @param {string} prompt
 * @returns {Array<{role:string, content: Array<{type:string, text:string}>}>}
 */
export function buildEndingJudgeMessages(prompt) {
  return [{ role: "user", content: [{ type: "text", text: prompt }] }];
}

/**
 * 调用 LLM 判断所选结局是否已成立。
 * @param {object} deps
 * @param {object} input
 * @returns {Promise<{ok:boolean, ended?:boolean, confidence?:number, evidence?:string, error?:string, durationMs?:number}>}
 */
export async function judgeEndingReached(deps, { finalBranch, playerText, narration, currentScene, pcName }) {
  const prompt = buildEndingJudgePrompt({ finalBranch, playerText, narration, currentScene, pcName });
  const startedAt = Date.now();
  try {
    const response = await callLlmApi(deps.dataDir, buildEndingJudgeMessages(prompt), {
      system: buildEndingJudgeSystem(),
      temperature: 0.1,
      max_tokens: 300,
      reasoningEffort: "low",
    });
    const durationMs = Date.now() - startedAt;
    const raw = (response.blocks ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const parsed = parseEndingJudgeOutput(raw);
    if (parsed === null) return { ok: false, error: "empty-parse", durationMs };
    return {
      ok: true,
      ended: parsed.ended === true,
      endingLabel: String(parsed.endingLabel ?? ""),
      confidence: Number(parsed.confidence ?? 0),
      evidence: String(parsed.evidence ?? "").slice(0, 120),
      durationMs,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt };
  }
}

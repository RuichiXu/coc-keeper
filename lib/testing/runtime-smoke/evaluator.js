/**
 * Evaluator 统一评审接口（runtime smoke / 上线评审用）
 *
 *   {
 *     id: string,
 *     evaluate(report) -> Promise<object>   // { dimensions:[...], overall:{...}, hardFail }
 *   }
 *
 * report 由 runner 产出，包含：
 *   - scenario: { name, text, summary }
 *   - metrics: { turns, exceptions, busyHangs, emptyNarrations, ... }
 *   - transcript: 完整玩家可见对话（user/kp/check/roll）
 *   - final: { endingReached, currentScene, consistency }
 *
 * 提供：
 *   - createThresholdEvaluator：确定性门槛评审（CI / 快速检查）
 *   - createLlmEvaluator：真实 LLM 多维评审（最终门禁）
 *   - applyPassThresholds：把 LLM 评分 + 硬指标合成 go/no-go
 */
import { callLlmApi } from "../../shared/llm.js";
import { extractJsonObject } from "../../core/index.js";

// ── 维度与门槛 ──────────────────────────────────────────────

export const EVAL_DIMENSIONS = [
  { id: "plot", name: "剧情还原", hard: false, minScore: 3, description: "是否沿剧本关键点推进、结局是否来自剧本选项" },
  { id: "rules", name: "规则与检定", hard: true, minScore: 4, description: "团检是否真实掷骰、成功/失败叙述是否符合 CoC 7e" },
  { id: "state", name: "状态一致", hard: true, minScore: 4, description: "场景/HP/SAN/物品与叙述是否一致，flat 与 core 投影是否一致" },
  { id: "experience", name: "玩家体验", hard: false, minScore: 3, description: "叙事质量、选择自由、有无卡死/重复/空转" },
  { id: "safety", name: "守门安全", hard: true, minScore: 4, description: "有无提前泄露线索、编造结果词、门禁悬挂、busy 卡死" },
  { id: "ending", name: "结局质量", hard: false, minScore: 3, description: "结局触发条件是否正确、收束是否完整" },
];

/**
 * 确定性硬门槛。
 * @param {object} report
 * @returns {{ pass: boolean, hard: string[], soft: string[] }}
 */
export function applyHardThresholds(report) {
  const metrics = report?.metrics ?? {};
  const final = report?.final ?? {};
  const hard = [];
  const soft = [];

  if ((metrics.exceptions ?? 0) > 0) hard.push(`存在 ${metrics.exceptions} 个运行时异常`);
  if ((metrics.busyHangs ?? 0) > 0) hard.push(`存在 ${metrics.busyHangs} 次 busy 悬挂`);
  if ((metrics.toolErrors ?? 0) > 0) hard.push(`存在 ${metrics.toolErrors} 次工具调用失败`);
  if ((metrics.toolSyntaxLeaks ?? 0) > 0) hard.push(`存在 ${metrics.toolSyntaxLeaks} 次工具标记泄漏`);
  if (final.endingReached !== true) hard.push("未在轮数上限内抵达结局");
  if (final.consistency?.pass === false) {
    hard.push(`状态一致性问题：${(final.consistency?.problems ?? []).join("；")}`);
  }
  if ((metrics.emptyNarrations ?? 0) > 0) soft.push(`${metrics.emptyNarrations} 轮空叙述`);
  if ((metrics.stuckTurns ?? 0) > 0) soft.push(`${metrics.stuckTurns} 轮疑似卡住`);

  return { pass: hard.length === 0, hard, soft };
}

/**
 * 把 LLM 维度评分与硬门槛合成最终结论。
 * @param {object} report
 * @param {object|null} llmEval - LLM 评审输出（dimensions/overall）
 * @param {object} [opts]
 * @param {Array<{id:string,name:string,hard:boolean,minScore:number}>} [opts.dimensions]
 * @returns {{ pass: boolean, hard: string[], soft: string[], dimensions: Array, overall: object }}
 */
export function applyPassThresholds(report, llmEval, opts = {}) {
  const dimensions = opts.dimensions ?? EVAL_DIMENSIONS;
  const hard = [];
  const soft = [];
  const hardGate = applyHardThresholds(report);
  hard.push(...hardGate.hard);
  soft.push(...hardGate.soft);

  const scored = (llmEval?.dimensions ?? []).map((item) => {
    const spec = dimensions.find((dim) => dim.id === item.id) ?? { hard: false, minScore: 3, name: item.name };
    const score = Number(item.score ?? 0);
    return { ...spec, ...item, score };
  });

  for (const dim of scored) {
    if (dim.score < dim.minScore) {
      const message = `维度「${dim.name}」${dim.score}/${dim.minScore}`;
      if (dim.hard) hard.push(message);
      else soft.push(message);
    }
  }

  const missingHard = dimensions
    .filter((dim) => dim.hard)
    .filter((dim) => !scored.some((item) => item.id === dim.id))
    .map((dim) => `缺少硬维度「${dim.name}」评分`);
  hard.push(...missingHard);

  const overall = {
    ...(llmEval?.overall ?? {}),
    pass: hard.length === 0,
    hardReasons: hard,
    softReasons: soft,
    verdict: hard.length === 0 ? (llmEval?.overall?.verdict ?? "go") : "no-go",
  };
  return { pass: hard.length === 0, hard, soft, dimensions: scored, overall };
}

// ── 确定性门槛评审 ──────────────────────────────────────────

export function createThresholdEvaluator(opts = {}) {
  return {
    id: "threshold",
    async evaluate(report) {
      const hardGate = applyHardThresholds(report);
      return {
        dimensions: [],
        overall: {
          verdict: hardGate.pass ? "go" : "no-go",
          summary: hardGate.pass ? "确定性门槛通过" : `确定性门槛未通过：${hardGate.hard.join("；")}`,
          hardReasons: hardGate.hard,
          softReasons: hardGate.soft,
        },
        hardFail: !hardGate.pass,
      };
    },
  };
}

// ── HTTP 外部评审（Codex 等 agent） ─────────────────────────

/**
 * 通过 HTTP JSON 调用外部 agent 评审。
 * 请求体 = { report }；响应体 = 评审结果 JSON（dimensions/overall/hardFail）。
 * @param {string} endpoint
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=120000]
 * @returns {Evaluator}
 */
export function createHttpEvaluator(endpoint, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120000;
  return {
    id: `http-evaluator:${endpoint}`,
    async evaluate(report) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`HTTP 评审接口返回 ${res.status}`);
      }
      const data = await res.json();
      const parsed = data?.evaluation ?? data ?? {};
      const applied = applyPassThresholds(report, parsed);
      return { ...parsed, dimensions: applied.dimensions, overall: applied.overall, hardFail: !applied.pass };
    },
  };
}

// ── LLM 评审 ───────────────────────────────────────────────

/**
 * 真实 LLM 评审：原始剧本 + 完整对话 + 指标 → 多维评分 JSON。
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {string} [opts.model] - 默认用 config.deepParse.revisionModel
 * @param {number} [opts.maxTokens=16000]
 * @returns {Evaluator}
 */
export function createLlmEvaluator(opts = {}) {
  const dataDir = opts.dataDir;
  const model = opts.model;
  const maxTokens = opts.maxTokens ?? 16000;

  const dimensionSpec = EVAL_DIMENSIONS.map((dim) =>
    `- ${dim.id} ${dim.name}：${dim.description}`
  ).join("\n");

  const system = [
    "你是一位严格的 CoC 7e 跑团质量评审。",
    "你会收到：原始剧本、完整游戏对话（玩家/KP/系统检定/骰点）、运行时指标。",
    "请基于证据评分，不要凭印象。每项给 1-5 整数分，并引用对话原文作为 evidence。",
    "",
    "评审维度：",
    dimensionSpec,
    "",
    "硬维度（rules、state、safety）任一低于 4 分，或运行时存在异常/未抵达结局，总评必须为 no-go。",
    "只输出 JSON，不要输出 markdown 代码围栏或解释文字。",
  ].join("\n");

  return {
    id: "llm",
    async evaluate(report) {
      const scenarioText = String(report?.scenario?.text ?? "").slice(0, 30000);
      const summary = String(report?.scenario?.summary ?? "").slice(0, 2000);
      const transcript = String(report?.transcript ?? "").slice(0, 30000);
      const metrics = JSON.stringify(report?.metrics ?? {}, null, 2);
      const final = JSON.stringify(report?.final ?? {}, null, 2);

      const user = [
        "【原始剧本】",
        summary ? `（摘要）${summary}` : "",
        scenarioText,
        "",
        "【运行时指标】",
        metrics,
        "",
        "【最终状态】",
        final,
        "",
        "【完整游戏对话】",
        transcript,
        "",
        '请输出 JSON（结构：{"dimensions":[{"id":"plot","name":"剧情还原","score":4,"evidence":"...","comment":"..."}],"hardFail":false,"overall":{"score":4,"verdict":"go","summary":"...","risks":["..."]}}）',
      ].join("\n");

      const result = await callLlmApi(dataDir, [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: user }] },
      ], { model, temperature: 0, max_tokens: maxTokens, reasoningEffort: "low" });

      const rawText = (result.blocks ?? [])
        .filter((block) => block?.type === "text")
        .map((block) => block.text ?? "")
        .join("")
        .trim();
      const parsed = extractJsonObject(rawText);
      if (parsed === null) {
        return {
          dimensions: [],
          overall: {
            verdict: "no-go",
            summary: "LLM 评审未能输出可解析的 JSON",
            rawText: rawText.slice(0, 800),
          },
          hardFail: true,
        };
      }
      const applied = applyPassThresholds(report, parsed);
      return { ...parsed, dimensions: applied.dimensions, overall: applied.overall, hardFail: !applied.pass };
    },
  };
}

export { callLlmApi };

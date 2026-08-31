/**
 * 深度剧本解析（deep-parse）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  DEEP_PARSE_VERSION,
  buildDeepParsePrompt,
  mergeDeepParseDraft,
  normalizeDeepParse,
  parseDeepParseResult,
  validateConditionObject,
  validateDeepParse,
  validatePrerequisitePair,
} from "../../lib/core/index.js";

const FLAT = {
  scenario: { name: "墨渊", text: "三层书房里有一本日记。最终抉择在午夜进行。" },
  scenarioCheckpoints: [
    { id: "chk-3", skill: "侦查", trigger: "发现日记", keys: ["书房", "日记"], scene: "三层书房", floor: "三层" },
    { id: "chk-9", skill: "理智", trigger: "巨眼睁开", keys: ["墨渊", "巨眼"], scene: "三层书房", floor: "三层" },
  ],
  keyPoints: [
    { id: "ai-kp-3", title: "进入书房", scene: "三层书房" },
    { id: "ai-kp-7", title: "拼凑十二字咒文", scene: "三层书房" },
  ],
  branches: [
    {
      id: "ai-br-3",
      title: "最终咒文念诵方式",
      scene: "三层书房/结局",
      options: [
        { label: "逆序念诵（送神）", leadsTo: "墨渊消散的结局" },
        { label: "正序念诵（请神）", leadsTo: "夏拉卡拉布降临的结局" },
      ],
    },
  ],
};

describe("deep-parse 深度剧本解析", () => {
  it("buildDeepParsePrompt：包含剧本名、结构化参考与字段约束", () => {
    const prompt = buildDeepParsePrompt(FLAT);
    expect(prompt).toContain("墨渊");
    expect(prompt).toContain("keyPointConditions");
    expect(prompt).toContain("plotEdges");
    expect(prompt).toContain("chk-3");
    expect(prompt).toContain("ai-kp-3");
    expect(prompt).toContain("ai-br-3");
    expect(prompt).toContain("blockers");
  });

  it("parseDeepParseResult：剥离代码围栏并解析 JSON", () => {
    const raw = '```json\n{"keyPointConditions":[{"keyPointId":"ai-kp-3","requires":{"scene":"三层书房","entryEvidence":["进入书房"]}}],"endings":[{"id":"end-1","branchId":"ai-br-3","title":"墨渊消散的结局","endingKeywords":["墨渊消散"]}]}\n```';
    const result = parseDeepParseResult(raw, FLAT);
    expect(result.issues).toEqual([]);
    expect(result.deepParse.version).toBe(DEEP_PARSE_VERSION);
    expect(result.deepParse.keyPointConditions).toHaveLength(1);
    expect(result.deepParse.keyPointConditions[0].requires.entryEvidence).toEqual(["进入书房"]);
  });

  it("parseDeepParseResult：JSON 解析失败时返回问题", () => {
    const result = parseDeepParseResult("不是 JSON", FLAT);
    expect(result.deepParse).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("normalizeDeepParse：补齐默认字段并过滤未知字段", () => {
    const normalized = normalizeDeepParse({
      version: "1.0",
      keyPointConditions: [{ keyPointId: "ai-kp-3", requiresAnyOf: [{ keyPointIds: ["ai-kp-7"] }], extra: "drop" }],
      branchConditions: [{ branchId: "ai-br-3", requires: { keyPointIds: ["ai-kp-7"] }, autoChooseLabel: "逆序念诵（送神）" }],
      plotEdges: [{ from: "br:ai-br-3", to: "end:ai-br-3:1", label: "逆序念诵（送神）", requires: [], consequences: { setFlags: { ending: true } } }],
      endings: [{ id: "end-1", branchId: "ai-br-3", title: "墨渊消散的结局", endingKeywords: ["墨渊消散"] }],
      unknown: true,
    });
    expect(normalized.version).toBe("1.0");
    expect(normalized.keyPointConditions[0].requiresAnyOf).toHaveLength(1);
    expect(normalized.keyPointConditions[0].extra).toBeUndefined();
    expect(normalized.branchConditions[0].autoChooseLabel).toBe("逆序念诵（送神）");
    expect(normalized.plotEdges[0].from).toBe("br:ai-br-3");
    expect(normalized.endings[0].title).toBe("墨渊消散的结局");
    expect(normalized.unknown).toBeUndefined();
  });

  it("parseDeepParseResult：flat 无关键点/分支时，LLM 生成新节点并通过校验", () => {
    const emptyFlat = { keyPoints: [], branches: [] };
    const raw = JSON.stringify({
      keyPoints: [{ id: "kp-1", title: "关键发现", scene: "书房" }],
      branches: [{ id: "br-1", title: "关键抉择", options: [{ label: "继续调查", leadsTo: "关键发现" }] }],
      keyPointConditions: [{ keyPointId: "kp-1", requires: { scene: "书房" } }],
      branchConditions: [{ branchId: "br-1", requires: { scene: "书房" } }],
      plotEdges: [{ from: "br:br-1", to: "kp:kp-1", label: "继续调查", requires: [], consequences: { setFlags: { "branch:br-1:chosen": "继续调查" } } }],
      endings: [{ branchId: "br-1", title: "调查结局", requires: { branchChoiceIds: ["br-1"] }, blockers: [], endingKeywords: ["调查结局"] }],
    });
    const result = parseDeepParseResult(raw, emptyFlat);
    expect(result.issues).toEqual([]);
    expect(result.deepParse.keyPoints).toHaveLength(1);
    expect(result.deepParse.branches).toHaveLength(1);
  });

  it("validateDeepParse：生成的节点缺 id / 分支缺 options 时报告问题", () => {
    const deepParse = normalizeDeepParse({
      keyPoints: [{ title: "没 id 的关键点" }],
      branches: [{ id: "br-1", title: "没 options 的分支" }],
    });
    const issues = validateDeepParse(deepParse, { keyPoints: [], branches: [] });
    expect(issues.some((issue) => issue.includes("keyPoints[0].id"))).toBeTrue();
    expect(issues.some((issue) => issue.includes("options"))).toBeTrue();
  });

  it("validateDeepParse：合法产物通过", () => {
    const deepParse = {
      keyPointConditions: [
        { keyPointId: "ai-kp-3", requires: { scene: "三层书房", entryEvidence: ["进入书房"] } },
        { keyPointId: "ai-kp-7", requires: { checkpointGroups: [["chk-13"]] } },
      ],
      branchConditions: [{ branchId: "ai-br-3", requires: { keyPointIds: ["ai-kp-7"] }, autoChooseLabel: "逆序念诵（送神）" }],
      plotEdges: [{ from: "br:ai-br-3", to: "end:ai-br-3:1", label: "逆序念诵（送神）", requires: [], consequences: { setFlags: { "ending:ai-br-3:墨渊消散的结局": true } } }],
      endings: [{ id: "end-1", branchId: "ai-br-3", title: "墨渊消散的结局", optionLabel: "逆序念诵（送神）", requires: { branchChoiceIds: ["ai-br-3"] }, blockers: [{ branchChoiceIds: ["ai-br-1"] }], endingKeywords: ["墨渊消散"] }],
    };
    expect(validateDeepParse(normalizeDeepParse(deepParse), FLAT)).toEqual([]);
  });

  it("validateDeepParse：ID 引用不存在时报告问题", () => {
    const deepParse = normalizeDeepParse({
      keyPointConditions: [{ keyPointId: "no-such-kp", requires: { scene: "三层书房" } }],
      branchConditions: [{ branchId: "no-such-br", requires: { scene: "三层书房" } }],
      endings: [{ branchId: "no-such-br", title: "坏结局" }],
    });
    const issues = validateDeepParse(deepParse, FLAT);
    expect(issues.some((issue) => issue.includes("no-such-kp"))).toBeTrue();
    expect(issues.some((issue) => issue.includes("no-such-br"))).toBeTrue();
  });

  it("validateDeepParse：空条件对象与未知字段被拒绝", () => {
    const issues = validateDeepParse(normalizeDeepParse({
      keyPointConditions: [{ keyPointId: "ai-kp-3", requires: {} }],
    }), FLAT);
    expect(issues.some((issue) => issue.includes("不能为空对象"))).toBeTrue();

    const unknown = validateConditionObject({ foo: "bar" }, "test");
    expect(unknown.some((issue) => issue.includes("未知字段"))).toBeTrue();
  });

  it("mergeDeepParseDraft：新节点并入 flat 并保持引用一致", () => {
    const flat = {
      scenario: { name: "墨渊" },
      keyPoints: [{ id: "kp-9", title: "旧节点", revealed: false, scenarioId: "墨渊" }],
      branches: [{ id: "br-9", title: "旧分支", reached: false, chosen: null, scenarioId: "墨渊" }],
    };
    const deepParse = normalizeDeepParse({
      keyPoints: [{ id: "kp-1", title: "进入书房", scene: "三层书房" }],
      branches: [{ id: "br-1", title: "如何进入书房", options: [{ label: "撞门", leadsTo: "三层书房" }] }],
      keyPointConditions: [{ keyPointId: "kp-1", requires: { scene: "三层书房" } }],
      branchConditions: [{ branchId: "br-1", requires: { keyPointIds: ["kp-1"] } }],
      plotEdges: [{ from: "br:br-1", to: "kp:kp-1", label: "撞门", requires: [] }],
      endings: [{ branchId: "br-1", title: "墨渊消散的结局", requires: { branchChoiceIds: ["br-1"] }, blockers: [], endingKeywords: ["消散"] }],
    });
    const merged = mergeDeepParseDraft(flat, deepParse);
    expect(merged.keyPointsAdded).toBe(1);
    expect(merged.branchesAdded).toBe(1);
    expect(flat.keyPoints).toHaveLength(2);
    expect(flat.branches).toHaveLength(2);
    expect(flat.keyPoints[1].revealed).toBeFalse();
    expect(merged.deepParse.keyPointConditions[0].keyPointId).toBe("kp-1");
    expect(merged.deepParse.plotEdges[0].from).toBe("br:br-1");
    expect(merged.deepParse.endings[0].branchId).toBe("br-1");
  });

  it("mergeDeepParseDraft：生成节点 id 与既有节点冲突时重映射", () => {
    const flat = {
      scenario: { name: "墨渊" },
      keyPoints: [{ id: "kp-1", title: "旧节点", revealed: false, scenarioId: "墨渊" }],
      branches: [{ id: "br-1", title: "旧分支", reached: false, chosen: null, scenarioId: "墨渊" }],
    };
    const deepParse = normalizeDeepParse({
      keyPoints: [{ id: "kp-1", title: "LLM 新节点", scene: "三层书房" }],
      branches: [{ id: "br-1", title: "LLM 新分支", options: [{ label: "撞门", leadsTo: "三层书房" }] }],
      keyPointConditions: [{ keyPointId: "kp-1", requires: { scene: "三层书房" } }],
      branchConditions: [{ branchId: "br-1", requires: { keyPointIds: ["kp-1"] } }],
      plotEdges: [{ from: "br:br-1", to: "kp:kp-1", label: "撞门", requires: [] }],
      endings: [{ branchId: "br-1", title: "结局", requires: { branchChoiceIds: ["br-1"] }, blockers: [], endingKeywords: ["结局"] }],
    });
    const merged = mergeDeepParseDraft(flat, deepParse);
    expect(merged.keyPointsAdded).toBe(0);
    expect(merged.branchesAdded).toBe(0);
    expect(flat.keyPoints).toHaveLength(1);
    expect(flat.branches).toHaveLength(1);
    // 冲突 id 不新增节点，引用保持指向既有 id。
    expect(merged.deepParse.keyPointConditions[0].keyPointId).toBe("kp-1");
    expect(merged.deepParse.plotEdges[0].to).toBe("kp:kp-1");
  });

  it("validatePrerequisitePair：requires 与 requiresAnyOf 至少要有一个", () => {
    expect(validatePrerequisitePair({}, "test").length).toBeGreaterThan(0);
    expect(validatePrerequisitePair({ requires: { scene: "三层书房" } }, "test")).toEqual([]);
    expect(validatePrerequisitePair({ requiresAnyOf: [{ scene: "三层书房" }] }, "test")).toEqual([]);
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "deep-parse 单元测试"));

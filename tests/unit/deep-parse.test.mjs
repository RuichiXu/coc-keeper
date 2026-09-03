/**
 * 深度剧本解析（deep-parse）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  DEEP_PARSE_VERSION,
  PlotGraph,
  applyConfirmedDeepParse,
  buildDeepParsePrompt,
  buildDeepParseTwoStagePrompts,
  buildChunkReviewPrompt,
  buildChunkRevisionPrompt,
  buildDeterministicSkeleton,
  buildSkeletonWiringPrompt,
  canonicalizeDeepParse,
  collectDeepParseTargets,
  combineDeepParseParts,
  detectDeadEndScenes,
  extractFinalChoiceBranches,
  extractJsonObject,
  mergeChunkedDeepParseParts,
  mergeDeepParseDraft,
  normalizeDeepParse,
  parseDeepParseResult,
  parseSkeletonWiringResult,
  repairSkeletonWiringDeepParse,
  runDeepParsePreflight,
  runDeepParseRuleReview,
  conditionSignature,
  syncPlotGraphFromDeepParse,
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

  it("buildDeepParseTwoStagePrompts：第一段只生成节点，第二段有封闭词表与节点清单", () => {
    const inventory = {
      keyPoints: [{ id: "kp-1", title: "进入书房", scene: "三层书房" }],
      branches: [{ id: "br-1", title: "如何进入书房", scene: "三层书房", options: [{ label: "撞门" }] }],
      endings: [{ id: "end-1", branchId: "br-1", title: "墨渊消散的结局", optionLabel: "撞门", mutexGroup: "最终结局", endingKeywords: ["墨渊消散"] }],
    };
    const prompts = buildDeepParseTwoStagePrompts(FLAT, inventory);
    expect(prompts.inventoryPrompt).toContain("节点清单");
    expect(prompts.inventoryPrompt).toContain("不要生成 plotEdges");
    expect(prompts.wiringPrompt).toContain("branchOptionLeadsTo");
    expect(prompts.wiringPrompt).toContain("endingConditions");
    expect(prompts.wiringPrompt).toContain("墨渊消散的结局");
    expect(prompts.wiringPrompt).toContain("三层书房");
  });

  it("combineDeepParseParts：灌回 leadsTo 与结局条件并通过校验", () => {
    const inventory = {
      keyPoints: [{ id: "kp-1", title: "进入书房", scene: "三层书房" }],
      branches: [{ id: "br-1", title: "如何进入书房", scene: "三层书房", options: [{ label: "撞门" }] }],
      endings: [{ id: "end-1", branchId: "br-1", title: "进入书房", optionLabel: "撞门", mutexGroup: "最终结局", endingKeywords: ["书房"] }],
    };
    const wiring = {
      branchOptionLeadsTo: [{ branchId: "br-1", optionIndex: 0, leadsTo: "进入书房" }],
      keyPointConditions: [],
      branchConditions: [],
      plotEdges: [{ from: "br:br-1", to: "kp:kp-1", label: "撞门", requires: [] }],
      endingConditions: [{ endingId: "end-1", requires: { branchChoiceIds: ["br-1"], optionLabel: "撞门" }, blockers: [] }],
    };
    const result = combineDeepParseParts(inventory, wiring, FLAT);
    expect(result.issues).toEqual([]);
    expect(result.deepParse.branches[0].options[0].leadsTo).toBe("进入书房");
    expect(result.deepParse.endings[0].requires.optionLabel).toBe("撞门");
  });

  it("buildSkeletonWiringPrompt：禁止生成节点，只标注条件/边/结局", () => {
    const prompt = buildSkeletonWiringPrompt(FLAT);
    expect(prompt).toContain("不要生成任何新节点");
    expect(prompt).toContain("确定性节点骨架");
    expect(prompt).toContain("ai-br-3");
    expect(prompt).toContain("keyPointConditions");
  });

  it("parseSkeletonWiringResult：生成新节点时报错并剥离节点", () => {
    const raw = JSON.stringify({
      keyPoints: [{ id: "kp-99", title: "新节点" }],
      keyPointConditions: [],
      branchConditions: [],
      plotEdges: [],
      endings: [],
    });
    const parsed = parseSkeletonWiringResult(raw, FLAT);
    expect(parsed.deepParse.keyPoints).toEqual([]);
    expect(parsed.issues.some((issue) => issue.includes("不允许生成 keyPoints"))).toBeTrue();
  });

  it("extractFinalChoiceBranches：从最终抉择段落提取玩家选择分支", () => {
    const flat = {
      scenario: { name: "测试", text: "此时，调查员们面临最终抉择：若调查员们正序念诵，则墨渊降临；若调查员们逆序念诵，则墨渊消散。" },
      scenarioFacts: [{ heading: "最终抉择", floor: "结局", keywords: ["最终抉择"], original: "此时，调查员们面临最终抉择：若调查员们正序念诵，则墨渊降临；若调查员们逆序念诵，则墨渊消散。" }],
    };
    const result = extractFinalChoiceBranches(flat);
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0].id).toBe("br-final-1");
    expect(result.branches[0].options.map((option) => option.label)).toEqual(["正序念诵", "逆序念诵"]);
    expect(result.keyPoints.length).toBe(2);
  });

  it("collectDeepParseTargets：词表包含节点标题、结局关键词与场景名", () => {
    const inventory = {
      keyPoints: [{ id: "kp-1", title: "进入书房", scene: "三层书房" }],
      branches: [],
      endings: [{ id: "end-1", branchId: "br-1", title: "墨渊消散", endingKeywords: ["送神"] }],
    };
    const targets = collectDeepParseTargets(FLAT, inventory);
    expect(targets).toContain("进入书房");
    expect(targets).toContain("三层书房");
    expect(targets).toContain("墨渊消散");
    expect(targets).toContain("送神");
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

  it("applyConfirmedDeepParse：确认稿覆盖节点条件，未覆盖节点保留确定性条件", () => {
    const flat = {
      deepParse: {
        status: "confirmed",
        keyPointConditions: [{ keyPointId: "kp-1", requires: { scene: "书房" } }],
        branchConditions: [{ branchId: "br-1", requires: { keyPointIds: ["kp-1"] }, autoChooseLabel: "进入" }],
      },
      keyPoints: [
        { id: "kp-1", title: "发现暗门", requires: { checkpointGroups: [["chk-1"]] } },
        { id: "kp-2", title: "保留兜底", requires: { scene: "门厅" } },
      ],
      branches: [{ id: "br-1", title: "是否进入", options: [] }],
    };
    const result = applyConfirmedDeepParse(flat);
    expect(result.keyPointsApplied).toBe(1);
    expect(result.branchesApplied).toBe(1);
    expect(flat.keyPoints[0].requires).toEqual({ scene: "书房" });
    expect(flat.keyPoints[0].deepParseApplied).toBeTrue();
    expect(flat.keyPoints[1].requires).toEqual({ scene: "门厅" });
    expect(flat.branches[0].autoChooseLabel).toBe("进入");
  });

  it("applyConfirmedDeepParse：无 scene 条件自动补目标节点 scene 门控", () => {
    const flat = {
      deepParse: {
        status: "confirmed",
        keyPointConditions: [{ keyPointId: "kp-2", requires: { keyPointIds: ["kp-1"] } }],
        branchConditions: [{ branchId: "br-1", requires: { keyPointIds: ["kp-1"] } }],
      },
      keyPoints: [
        { id: "kp-1", title: "进入书房", scene: "书房", revealed: false },
        { id: "kp-2", title: "发现日记", scene: "书房", revealed: false },
      ],
      branches: [{ id: "br-1", title: "是否翻看", scene: "书房", options: [] }],
    };
    applyConfirmedDeepParse(flat);
    expect(flat.keyPoints[1].requires.scene).toBe("书房");
    expect(flat.branches[0].requires.scene).toBe("书房");
  });

  it("detectDeadEndScenes：无出口分支的场景被标记", () => {
    const issues = detectDeadEndScenes({
      keyPoints: [{ id: "kp-1", title: "宅邸门厅", scene: "宅邸" }],
      branches: [
        { id: "br-1", title: "进入宅邸", scene: "宅邸", options: [] },
        { id: "br-2", title: "是否离开", scene: "街道", options: [{ label: "离开", leadsTo: "宅邸" }] },
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({ scene: "宅邸", issue: "no_exit" });
  });

  it("runDeepParsePreflight：捕获 end 悬空、结局无入边、leadsTo 未命中", () => {
    const flat = {
      scenario: { name: "测试" },
      keyPoints: [{ id: "kp-1", title: "书房", scene: "书房" }],
      branches: [
        { id: "br-1", title: "是否进入", scene: "书房", options: [{ label: "进入", leadsTo: "不存在的地方" }] },
      ],
    };
    const deepParse = normalizeDeepParse({
      branches: [],
      endings: [{ id: "end-1", branchId: "br-1", title: "进入结局", optionLabel: "进入", endingKeywords: ["结局"] }],
      plotEdges: [{ from: "br:br-1", to: "end:end-9", label: "进入", requires: [] }],
    });
    const report = runDeepParsePreflight(deepParse, flat);
    expect(report.high).toBeGreaterThanOrEqual(1);
    expect(report.medium).toBeGreaterThanOrEqual(1);
    expect(report.pass).toBeFalse();
    expect(report.issues.some((issue) => issue.problem.includes("end: 端点没有对应已声明结局"))).toBeTrue();
    expect(report.issues.some((issue) => issue.problem.includes("没有任何分支选项 leadsTo"))).toBeTrue();
    expect(report.issues.some((issue) => issue.problem.includes("leadsTo 未命中"))).toBeTrue();
  });

  it("runDeepParsePreflight：结构合法且入边完整时 pass", () => {
    const flat = {
      scenario: { name: "测试" },
      keyPoints: [],
      branches: [
        { id: "br-1", title: "最终抉择", scene: "书房", options: [{ label: "进入", leadsTo: "进入结局" }] },
      ],
    };
    const deepParse = normalizeDeepParse({
      endings: [{ id: "end-1", branchId: "br-1", title: "进入结局", optionLabel: "进入", endingKeywords: ["结局"] }],
      plotEdges: [{ from: "br:br-1", to: "end:end-1", label: "进入", requires: [] }],
    });
    const report = runDeepParsePreflight(deepParse, flat);
    expect(report.high).toBe(0);
    expect(report.medium).toBe(0);
    expect(report.pass).toBeTrue();
  });

  it("runDeepParsePreflight：结局错挂技能分支且存在最终分支时报 high", () => {
    const flat = {
      scenario: { name: "测试" },
      keyPoints: [],
      branches: [
        { id: "br-1", title: "技能检定", scene: "书房", options: [{ label: "聆听", leadsTo: "书房" }] },
        { id: "br-final-1", title: "最终抉择", scene: "书房", finalChoice: true, options: [{ label: "离开", leadsTo: "结局" }] },
      ],
    };
    const deepParse = normalizeDeepParse({
      endings: [{ id: "end-1", branchId: "br-1", title: "结局", optionLabel: "聆听", endingKeywords: ["结局"] }],
      plotEdges: [{ from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [] }],
    });
    const report = runDeepParsePreflight(deepParse, flat);
    expect(report.high).toBeGreaterThan(0);
    expect(report.issues.some((issue) => issue.problem.includes("最终分支"))).toBeTrue();
  });

  it("runDeepParsePreflight：最终抉择分支带 scene branchCondition 且无 autoChooseLabel 时 pass", () => {
    const flat = {
      scenario: { name: "测试" },
      keyPoints: [],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "书房", finalChoice: true, options: [{ label: "离开", leadsTo: "结局" }, { label: "留下", leadsTo: "结局2" }] },
      ],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "书房" } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "结局", optionLabel: "离开", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "离开" }, endingKeywords: ["结局"] },
        { id: "end-2", branchId: "br-final-1", title: "结局2", optionLabel: "留下", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "留下" }, endingKeywords: ["结局2"] },
      ],
      plotEdges: [
        { from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [] },
        { from: "br:br-final-1", to: "end:end-2", label: "留下", requires: [] },
      ],
    });
    const report = runDeepParsePreflight(deepParse, flat);
    expect(report.high).toBe(0);
    expect(report.medium).toBe(0);
    expect(report.pass).toBeTrue();
  });

  it("syncPlotGraphFromDeepParse：确认稿追加边与结局节点，未确认不追加", () => {
    const plot = new PlotGraph();
    const story = {
      keyPoints: [{ id: "kp-1", title: "发现暗门", revealed: false }],
      branches: [{ id: "br-1", title: "是否进入", reached: true, chosen: "进入", options: [{ label: "进入", leadsTo: "发现暗门" }] }],
    };
    const deepParse = {
      status: "confirmed",
      plotEdges: [{ from: "br:br-1", to: "kp:kp-1", label: "进入", requires: [], consequences: { setFlags: { "branch:br-1:chosen": "进入" } } }],
      endings: [{ id: "end-1", branchId: "br-1", title: "暗门结局", optionLabel: "进入", requires: { branchChoiceIds: ["br-1"] }, blockers: [], endingKeywords: ["暗门"] }],
    };
    const result = syncPlotGraphFromDeepParse(plot, deepParse, story);
    expect(result.endingsAdded).toBe(1);
    expect(plot.findNode("end-1").status).toBe("completed");
    expect(plot.findNode("end-1").endingKeywords).toEqual(["暗门"]);
    expect(plot.edges.some((edge) => edge.from === "br:br-1" && edge.to === "kp:kp-1")).toBeTrue();

    const plot2 = new PlotGraph();
    const draft = syncPlotGraphFromDeepParse(plot2, { status: "draft", plotEdges: [], endings: [] }, story);
    expect(draft.edgesAdded).toBe(0);
    expect(draft.endingsAdded).toBe(0);
  });

  it("syncPlotGraphFromDeepParse：分支选项 leadsTo 无节点时自动补关键点与边", () => {
    const plot = new PlotGraph();
    const story = {
      keyPoints: [],
      branches: [{ id: "br-5", title: "前往七星旅店", options: [{ label: "前往", leadsTo: "七星旅店" }] }],
    };
    const deepParse = { status: "confirmed", plotEdges: [], endings: [] };
    const result = syncPlotGraphFromDeepParse(plot, deepParse, story);
    expect(result.edgesAdded).toBe(1);
    expect(plot.nodes.some((node) => node.type === "keypoint" && node.title === "七星旅店")).toBeTrue();
    expect(plot.edges.some((edge) => edge.from === "br:br-5" && edge.to === "kp:auto:1")).toBeTrue();
  });

  it("validateDeepParse：optionLabel / not / mutexGroup 合法时通过", () => {
    const deepParse = normalizeDeepParse({
      keyPointConditions: [{ keyPointId: "ai-kp-3", requires: { scene: "三层书房", not: { entryEvidence: ["没能进入"] } } }],
      branchConditions: [{ branchId: "ai-br-3", requires: { branchChoiceIds: ["ai-br-3"], optionLabel: "逆序念诵（送神）" } }],
      endings: [{ branchId: "ai-br-3", title: "墨渊消散的结局", mutexGroup: "最终结局", endingKeywords: ["墨渊消散"] }],
    });
    expect(validateDeepParse(deepParse, FLAT)).toEqual([]);
  });

  it("validateConditionObject：optionLabel 缺 branchChoiceIds 或 not 非对象时报错", () => {
    const missingBranch = validateConditionObject({ optionLabel: "逆序" }, "test");
    expect(missingBranch.some((issue) => issue.includes("必须与 branchChoiceIds 搭配"))).toBeTrue();
    const badNot = validateConditionObject({ not: "不是对象" }, "test");
    expect(badNot.some((issue) => issue.includes("not 必须是条件对象"))).toBeTrue();
  });

  it("validateConditionObject：not 内无 branchChoiceIds 的 optionLabel 是冗余条件，不判 high（归一化时剥掉）", () => {
    const nested = validateConditionObject({ not: { optionLabel: ["撞门", "砸门"] } }, "test");
    expect(nested.some((issue) => issue.includes("必须与 branchChoiceIds 搭配"))).toBeFalse();
    const topLevel = validateConditionObject({ optionLabel: "撞门" }, "test");
    expect(topLevel.some((issue) => issue.includes("必须与 branchChoiceIds 搭配"))).toBeTrue();
    const normalized = canonicalizeDeepParse({
      endings: [{
        id: "end-1",
        branchId: "br-1",
        title: "结局",
        optionLabel: "撞门",
        requires: { branchChoiceIds: ["br-1"], optionLabel: "撞门", not: { optionLabel: ["砸门"] } },
        endingKeywords: ["结局"],
      }],
    }).deepParse;
    expect(normalized.endings[0].requires.not).toBeUndefined();
    expect(normalized.endings[0].requires.optionLabel).toBe("撞门");
  });

  it("validatePrerequisitePair：requires 与 requiresAnyOf 至少要有一个", () => {
    expect(validatePrerequisitePair({}, "test").length).toBeGreaterThan(0);
    expect(validatePrerequisitePair({ requires: { scene: "三层书房" } }, "test")).toEqual([]);
    expect(validatePrerequisitePair({ requiresAnyOf: [{ scene: "三层书房" }] }, "test")).toEqual([]);
  });

  it("buildDeterministicSkeleton：desc 不再截断，空事实回退到标题", () => {
    const flat = {
      scenarioFacts: [
        { heading: "长场景", facts: ["这是一段超过一百二十个字符的场景事实描述".repeat(10)] },
        { heading: "空场景", facts: [] },
      ],
      scenarioCheckpoints: [{ scene: "长场景", skill: "侦查", trigger: "触发".repeat(80) }],
    };
    const skeleton = buildDeterministicSkeleton(flat);
    const longKp = skeleton.keyPoints.find((kp) => kp.title === "长场景");
    expect(longKp.desc.length).toBeGreaterThan(120);
    expect(longKp.desc.endsWith("…")).toBeFalse();
    const emptyKp = skeleton.keyPoints.find((kp) => kp.title === "空场景");
    expect(emptyKp.desc).toBe("空场景");
    const br = skeleton.branches[0];
    expect(br.desc.length).toBeGreaterThan(120);
    expect(br.desc.endsWith("…")).toBeFalse();
  });

  it("extractJsonObject：围栏/尾逗号/deepParse 外壳都能解出", () => {
    expect(extractJsonObject('```json\n{"keyPoints":[],"endings":[],}\n```').endings).toEqual([]);
    const wrapped = extractJsonObject('结果如下：{"deepParse":{"keyPoints":[],"plotEdges":[{"from":"br:br-1","to":"kp:kp-1","requires":[],}]}}');
    expect(wrapped.plotEdges).toHaveLength(1);
    expect(extractJsonObject("没有 JSON")).toBeNull();
  });

  it("canonicalizeDeepParse：折叠各模型形态变体并剥离未知字段", () => {
    const canonical = canonicalizeDeepParse({
      deepParse: {
        keyPointConditions: [{ keyPointId: "kp-1", requires: { checkpointGroups: "chk-1", not: "禁止入内" }, conditions: undefined }],
        branchConditions: [{ branchId: "br-1", conditions: [{ scene: "书房" }, { keyPointIds: ["kp-1"] }] }],
        plotEdges: [{ from: "br:br-1", to: "end:end-1", label: "进", requires: { keyPointIds: ["kp-1"] }, extra: "drop" }],
        endings: [{ id: "end-1", branchId: "br-1", title: "结局", conditions: [{ branchChoiceIds: ["br-1"] }], blockers: "不能带火" }],
        unknownTop: true,
      },
    }).deepParse;
    expect(canonical.keyPointConditions[0].requires.checkpointGroups).toEqual([["chk-1"]]);
    expect(canonical.keyPointConditions[0].requires.not).toEqual({ entryEvidence: ["禁止入内"] });
    expect(canonical.branchConditions[0].requiresAnyOf).toEqual([{ scene: "书房" }, { keyPointIds: ["kp-1"] }]);
    expect(canonical.plotEdges[0].requires).toEqual([{ keyPointIds: ["kp-1"] }]);
    expect(canonical.endings[0].blockers).toEqual([{ entryEvidence: ["不能带火"] }]);
    expect(canonical.unknownTop).toBeUndefined();
    expect(canonical.plotEdges[0].extra).toBeUndefined();
  });

  it("canonicalizeDeepParse：skeletonLocked 剥离 keyPoints", () => {
    const canonical = canonicalizeDeepParse({ keyPoints: [{ id: "kp-x", title: "新" }], endings: [] }, { skeletonLocked: true });
    expect(canonical.deepParse.keyPoints).toEqual([]);
    expect(canonical.issues.some((issue) => issue.includes("不允许生成 keyPoints"))).toBeTrue();
  });

  it("repairSkeletonWiringDeepParse：补最终分支 scene 门控并去掉代选", () => {
    const flatWithFinal = {
      keyPoints: [],
      branches: [{ id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "离开" }] }],
    };
    const deepParse = {
      version: "1.0",
      keyPoints: [],
      branches: [],
      keyPointConditions: [],
      branchConditions: [{ branchId: "br-final-1", requires: {}, autoChooseLabel: "离开" }],
      plotEdges: [],
      endings: [],
    };
    const repaired = repairSkeletonWiringDeepParse(deepParse, flatWithFinal);
    expect(repaired.repairs.some((item) => item.includes("scene 门控"))).toBeTrue();
    const cond = repaired.deepParse.branchConditions.find((entry) => entry.branchId === "br-final-1");
    expect(cond.requires.scene).toBe("结局");
    expect(cond.autoChooseLabel).toBeUndefined();
  });

  it("repairSkeletonWiringDeepParse：为结局补 requires 与直接入边", () => {
    const flatWithFinal = {
      keyPoints: [],
      branches: [{ id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "离开" }, { label: "留下", leadsTo: "留下" }] }],
    };
    const deepParse = {
      version: "1.0",
      keyPoints: [],
      branches: [],
      keyPointConditions: [],
      branchConditions: [],
      plotEdges: [],
      endings: [{ id: "end-1", branchId: "br-final-1", title: "离开结局", optionLabel: "离开", requires: {}, endingKeywords: ["离开"] }],
    };
    const repaired = repairSkeletonWiringDeepParse(deepParse, flatWithFinal);
    const ending = repaired.deepParse.endings[0];
    expect(ending.requires.branchChoiceIds).toEqual(["br-final-1"]);
    expect(ending.requires.optionLabel).toBe("离开");
    expect(repaired.deepParse.plotEdges.some((edge) => edge.from === "br:br-final-1" && edge.to === "end:end-1")).toBeTrue();
  });

  it("repairSkeletonWiringDeepParse：多最终分支自动补互斥 not.keyPointIds", () => {
    const flatWithTwoFinal = {
      keyPoints: [],
      scenarioFacts: [{ heading: "结局" }, { heading: "逃亡" }],
      branches: [],
    };
    const deepParse = {
      version: "1.0",
      keyPoints: [],
      branches: [
        { id: "br-final-1", title: "革命抉择", scene: "结局", finalChoice: true, options: [{ label: "人之城", leadsTo: "人之城" }, { label: "亘古黑暗", leadsTo: "亘古黑暗" }] },
        { id: "br-final-2", title: "逃亡", scene: "逃亡", finalChoice: true, options: [{ label: "远方讯息", leadsTo: "远方讯息" }] },
      ],
      keyPointConditions: [],
      branchConditions: [
        { branchId: "br-final-1", requires: { scene: "结局" } },
        { branchId: "br-final-2", requires: { scene: "逃亡" } },
      ],
      plotEdges: [],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "人之城", optionLabel: "人之城", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "人之城", keyPointIds: ["kp-39"] } },
        { id: "end-2", branchId: "br-final-1", title: "亘古黑暗", optionLabel: "亘古黑暗", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "亘古黑暗", keyPointIds: ["kp-38", "kp-39"] } },
        { id: "end-3", branchId: "br-final-2", title: "远方讯息", optionLabel: "远方讯息", requires: { branchChoiceIds: ["br-final-2"], optionLabel: "远方讯息", keyPointIds: ["kp-38"], not: { keyPointIds: ["kp-39"] } } },
      ],
    };
    const repaired = repairSkeletonWiringDeepParse(deepParse, flatWithTwoFinal);
    const cond1 = repaired.deepParse.branchConditions.find((entry) => entry.branchId === "br-final-1");
    const cond2 = repaired.deepParse.branchConditions.find((entry) => entry.branchId === "br-final-2");
    expect(cond1.requires.not).toBeUndefined();
    expect(cond2.requires.not.keyPointIds).toEqual(["kp-39"]);
    expect(repaired.repairs.some((item) => item.includes("互斥 not.keyPointIds"))).toBeTrue();
  });

  it("repairSkeletonWiringDeepParse：多最终分支已排除时不再重复补", () => {
    const flatWithTwoFinal = {
      keyPoints: [],
      scenarioFacts: [{ heading: "结局" }, { heading: "逃亡" }],
      branches: [],
    };
    const deepParse = {
      version: "1.0",
      keyPoints: [],
      branches: [
        { id: "br-final-1", title: "革命抉择", scene: "结局", finalChoice: true, options: [{ label: "人之城", leadsTo: "人之城" }] },
        { id: "br-final-2", title: "逃亡", scene: "逃亡", finalChoice: true, options: [{ label: "远方讯息", leadsTo: "远方讯息" }] },
      ],
      keyPointConditions: [],
      branchConditions: [
        { branchId: "br-final-1", requires: { scene: "结局" } },
        { branchId: "br-final-2", requires: { scene: "逃亡", not: { keyPointIds: ["kp-39"] } } },
      ],
      plotEdges: [],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "人之城", optionLabel: "人之城", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "人之城", keyPointIds: ["kp-39"] } },
        { id: "end-2", branchId: "br-final-2", title: "远方讯息", optionLabel: "远方讯息", requires: { branchChoiceIds: ["br-final-2"], optionLabel: "远方讯息", keyPointIds: ["kp-38"], not: { keyPointIds: ["kp-39"] } } },
      ],
    };
    const repaired = repairSkeletonWiringDeepParse(deepParse, flatWithTwoFinal);
    const cond1 = repaired.deepParse.branchConditions.find((entry) => entry.branchId === "br-final-1");
    const cond2 = repaired.deepParse.branchConditions.find((entry) => entry.branchId === "br-final-2");
    // br-final-2 已排除 kp-39，不再补；br-final-1 还需排除 br-final-2 的共同前置 kp-38。
    expect(cond2.requires.not.keyPointIds).toEqual(["kp-39"]);
    expect(cond1.requires.not.keyPointIds).toEqual(["kp-38"]);
  });

  it("parseSkeletonWiringResult：Kimi 式形态漂移被折叠且 preflight 归零", () => {
    const raw = `{
      "branches": [{"id":"br-final-1","title":"最终抉择","scene":"结局","finalChoice":true,"options":[{"label":"正序念诵","leadsTo":"夏拉卡拉布降临的结局"},{"label":"逆序念诵","leadsTo":"墨渊消散的结局"}]}],
      "branchConditions": [{"branchId":"br-final-1","requires":{"scene":"结局"}}],
      "plotEdges": [
        {"from":"br:br-final-1","to":"end:end-1","label":"正序念诵","requires":[]},
        {"from":"br:br-final-1","to":"end:end-2","label":"逆序念诵","requires":[]}
      ],
      "endings": [
        {"id":"end-1","branchId":"br-final-1","title":"夏拉卡拉布降临的结局","optionLabel":"正序念诵","mutexGroup":"最终结局","requires":{"branchChoiceIds":["br-final-1"],"optionLabel":"正序念诵"},"blockers":[],"endingKeywords":["降临"]},
        {"id":"end-2","branchId":"br-final-1","title":"墨渊消散的结局","optionLabel":"逆序念诵","mutexGroup":"最终结局","requires":{"branchChoiceIds":["br-final-1"],"optionLabel":"逆序念诵"},"blockers":[],"endingKeywords":["消散"]}
      ]
    }`;
    const flat = {
      keyPoints: [],
      branches: [{ id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "正序念诵", leadsTo: "夏拉卡拉布降临的结局" }, { label: "逆序念诵", leadsTo: "墨渊消散的结局" }] }],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
    };
    const parsed = parseSkeletonWiringResult(raw, flat);
    const report = runDeepParsePreflight(parsed.deepParse, flat);
    expect(report.high).toBe(0);
    expect(parsed.deepParse.endings).toHaveLength(2);
  });

  it("canonicalizeDeepParse：丢弃归一后既无条件又无 autoChooseLabel 的空条目", () => {
    const canonical = canonicalizeDeepParse({
      keyPointConditions: [{ keyPointId: "kp-1", requires: {} }],
      branchConditions: [{ branchId: "br-1", requires: { unknownField: true } }, { branchId: "br-2", requires: { scene: "书房" } }],
    }).deepParse;
    expect(canonical.keyPointConditions).toEqual([]);
    expect(canonical.branchConditions).toEqual([{ branchId: "br-2", requires: { scene: "书房" } }]);
  });

  it("canonicalizeDeepParse：边端点归一化为 br:/kp:/end: 前缀并去重", () => {
    const canonical = canonicalizeDeepParse({
      plotEdges: [
        { from: "br-final-x", to: "end-1", label: "人之城" },
        { from: "br:br-final-x", to: "end:end-1", label: "人之城" },
        { from: "br-final-x", to: "end-2", label: "星星之国" },
      ],
    }).deepParse;
    expect(canonical.plotEdges).toEqual([
      { from: "br:br-final-x", to: "end:end-1", label: "人之城" },
      { from: "br:br-final-x", to: "end:end-2", label: "星星之国" },
    ]);
  });

  it("mergeChunkedDeepParseParts：最终抉择分支的边与条件由最终生成器独占", () => {
    const flat = {
      keyPoints: [],
      branches: [{ id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "离开" }] }],
    };
    const chunkPart = {
      keyPointConditions: [{ keyPointId: "kp-1", requires: { scene: "书房" } }],
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "错误场景" } }],
      plotEdges: [{ from: "br:br-final-1", to: "kp:kp-final-1", label: "离开", requires: [] }],
    };
    const finalPart = {
      keyPoints: [],
      branches: [],
      keyPointConditions: [],
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      plotEdges: [{ from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [] }],
      endings: [{ id: "end-1", branchId: "br-final-1", title: "离开结局", optionLabel: "离开", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "离开" }, endingKeywords: ["离开"] }],
    };
    const merged = mergeChunkedDeepParseParts(flat, [chunkPart], finalPart);
    expect(merged.deepParse.branchConditions.some((entry) => entry.requires.scene === "错误场景")).toBeFalse();
    expect(merged.deepParse.plotEdges.some((edge) => edge.to === "kp:kp-final-1")).toBeFalse();
    expect(merged.deepParse.plotEdges.some((edge) => edge.to === "end:end-1")).toBeTrue();
  });

  it("runDeepParseRuleReview：干净的最终分支/结局草稿通过（只报关键词低危项）", () => {
    const flat = {
      keyPoints: [],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "离开结局" }, { label: "留下", leadsTo: "留下结局" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "离开结局", optionLabel: "离开", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "离开" } },
        { id: "end-2", branchId: "br-final-1", title: "留下结局", optionLabel: "留下", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "留下" } },
      ],
      plotEdges: [
        { from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [] },
        { from: "br:br-final-1", to: "end:end-2", label: "留下", requires: [] },
      ],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBe(0);
    expect(report.medium).toBe(0);
    expect(report.low).toBeGreaterThanOrEqual(2);
    expect(report.pass).toBeTrue();
  });

  it("runDeepParseRuleReview：条件引用不存在的关键点/分支 id 时报 high", () => {
    const flat = {
      keyPoints: [],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "离开" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "离开结局", optionLabel: "离开", requires: { keyPointIds: ["kp-999"], branchChoiceIds: ["br-final-1"], optionLabel: "离开" } },
      ],
      plotEdges: [{ from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [{ keyPointIds: ["kp-999"] }] }],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((issue) => issue.problem.includes("不存在的关键点 id"))).toBeTrue();
  });

  it("runDeepParseRuleReview：同一最终分支两条结局 optionLabel 相同报 high", () => {
    const flat = {
      keyPoints: [],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "结局A" }, { label: "留下", leadsTo: "结局B" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "结局A", optionLabel: "离开", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "离开" } },
        { id: "end-2", branchId: "br-final-1", title: "结局B", optionLabel: "离开", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "离开" } },
      ],
      plotEdges: [
        { from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [] },
        { from: "br:br-final-1", to: "end:end-2", label: "离开", requires: [] },
      ],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((issue) => issue.problem.includes("optionLabel 相同"))).toBeTrue();
  });

  it("runDeepParseRuleReview：条件自相矛盾（keyPointIds 同时被 not 排除）报 high", () => {
    const flat = {
      keyPoints: [{ id: "kp-1", title: "关键点", scene: "结局" }],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "离开" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      endings: [
        {
          id: "end-1",
          branchId: "br-final-1",
          title: "离开结局",
          optionLabel: "离开",
          requires: { keyPointIds: ["kp-1"], branchChoiceIds: ["br-final-1"], optionLabel: "离开", not: { keyPointIds: ["kp-1"] } },
        },
      ],
      plotEdges: [{ from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [{ keyPointIds: ["kp-1"], not: { keyPointIds: ["kp-1"] } }] }],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((issue) => issue.problem.includes("自相矛盾"))).toBeTrue();
  });

  it("runDeepParseRuleReview：not.keyPointIds 未被其它最终分支正向引用时报 medium", () => {
    const flat = {
      keyPoints: [{ id: "kp-1", title: "关键点", scene: "结局" }],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "离开" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      endings: [
        {
          id: "end-1",
          branchId: "br-final-1",
          title: "离开结局",
          optionLabel: "离开",
          requires: { branchChoiceIds: ["br-final-1"], optionLabel: "离开", not: { keyPointIds: ["kp-1"] } },
        },
      ],
      plotEdges: [{ from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [{ not: { keyPointIds: ["kp-1"] } }] }],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBe(0);
    expect(report.medium).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((issue) => issue.problem.includes("过度限制"))).toBeTrue();
  });

  it("runDeepParseRuleReview：同分支兄弟结局正向引用该 key 时，not.keyPointIds 不报过度限制", () => {
    const flat = {
      keyPoints: [{ id: "kp-1", title: "克罗斯已死", scene: "结局" }],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "救", leadsTo: "救赎" }, { label: "杀", leadsTo: "毁灭" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "救赎", optionLabel: "救", requires: { keyPointIds: ["kp-1"], branchChoiceIds: ["br-final-1"], optionLabel: "救" } },
        { id: "end-2", branchId: "br-final-1", title: "毁灭", optionLabel: "杀", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "杀", not: { keyPointIds: ["kp-1"] } } },
      ],
      plotEdges: [
        { from: "br:br-final-1", to: "end:end-1", label: "救", requires: [{ keyPointIds: ["kp-1"] }] },
        { from: "br:br-final-1", to: "end:end-2", label: "杀", requires: [{ not: { keyPointIds: ["kp-1"] } }] },
      ],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBe(0);
    expect(report.issues.some((issue) => issue.problem.includes("过度限制"))).toBeFalse();
  });

  it("runDeepParseRuleReview：分支门控 not 排除本分支结局正向要求的关键点时报 high", () => {
    const flat = {
      keyPoints: [{ id: "kp-1", title: "克罗斯已死", scene: "结局" }],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "救", leadsTo: "救赎" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局", not: { keyPointIds: ["kp-1"] } } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "救赎", optionLabel: "救", requires: { keyPointIds: ["kp-1"], branchChoiceIds: ["br-final-1"], optionLabel: "救" } },
      ],
      plotEdges: [{ from: "br:br-final-1", to: "end:end-1", label: "救", requires: [{ keyPointIds: ["kp-1"] }] }],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((issue) => issue.problem.includes("本分支结局永远不可达"))).toBeTrue();
  });

  it("runDeepParseRuleReview：分支门控 not 排除本分支出边所需关键点时报 high", () => {
    const flat = {
      keyPoints: [{ id: "kp-1", title: "克罗斯已死", scene: "结局" }, { id: "kp-2", title: "下一阶段", scene: "结局" }],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "下一阶段" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局", not: { keyPointIds: ["kp-1"] } } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "离开结局", optionLabel: "离开", requires: { branchChoiceIds: ["br-final-1"], optionLabel: "离开" } },
      ],
      plotEdges: [
        { from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [] },
        { from: "br:br-final-1", to: "kp:kp-2", label: "下一阶段", requires: [{ keyPointIds: ["kp-1"] }] },
      ],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((issue) => issue.problem.includes("出边永远无法满足"))).toBeTrue();
  });

  it("runDeepParseRuleReview：结局 scene 与最终分支 scene 不一致报 high", () => {
    const flat = {
      keyPoints: [{ id: "kp-1", title: "书房关键点", scene: "书房" }],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "离开" }] },
      ],
      scenarioFacts: [
        { heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" },
        { heading: "书房", floor: "书房", keywords: ["书房"], original: "书房" },
      ],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "离开结局", optionLabel: "离开", requires: { scene: "书房", branchChoiceIds: ["br-final-1"], optionLabel: "离开" } },
      ],
      plotEdges: [{ from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [{ scene: "书房" }] }],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((issue) => issue.problem.includes("scene") && issue.problem.includes("不一致"))).toBeTrue();
  });

  it("runDeepParseRuleReview：结局前置关键点只能在最终分支选择后到达时报 high", () => {
    const flat = {
      keyPoints: [{ id: "kp-9", title: "结局后节点", scene: "结局" }],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "结局后节点" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "离开结局", optionLabel: "离开", requires: { keyPointIds: ["kp-9"], branchChoiceIds: ["br-final-1"], optionLabel: "离开" } },
      ],
      plotEdges: [{ from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [{ keyPointIds: ["kp-9"] }] }],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((issue) => issue.problem.includes("循环依赖"))).toBeTrue();
  });

  it("runDeepParseRuleReview：结局直接入边 requires 与结局 requires 不一致报 high", () => {
    const flat = {
      keyPoints: [{ id: "kp-1", title: "关键点", scene: "结局" }],
      branches: [
        { id: "br-final-1", title: "最终抉择", scene: "结局", finalChoice: true, options: [{ label: "离开", leadsTo: "离开" }] },
      ],
      scenarioFacts: [{ heading: "结局", floor: "结局", keywords: ["结局"], original: "结局" }],
      scenarioCheckpoints: [],
    };
    const deepParse = normalizeDeepParse({
      branchConditions: [{ branchId: "br-final-1", requires: { scene: "结局" } }],
      endings: [
        { id: "end-1", branchId: "br-final-1", title: "离开结局", optionLabel: "离开", requires: { keyPointIds: ["kp-1"], branchChoiceIds: ["br-final-1"], optionLabel: "离开" } },
      ],
      plotEdges: [{ from: "br:br-final-1", to: "end:end-1", label: "离开", requires: [] }],
    });
    const report = runDeepParseRuleReview(deepParse, flat);
    expect(report.high).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((issue) => issue.problem.includes("不一致"))).toBeTrue();
  });

  it("conditionSignature：列表顺序无关的等价条件签名相同", () => {
    const a = conditionSignature({ keyPointIds: ["kp-2", "kp-1"], scene: "书房" });
    const b = conditionSignature({ scene: "书房", keyPointIds: ["kp-1", "kp-2"] });
    expect(a).toBe(b);
    const c = conditionSignature({ keyPointIds: ["kp-1"], scene: "书房" });
    expect(a === c).toBeFalse();
  });

  it("buildChunkReviewPrompt：包含场景、草稿与审校约束", () => {
    const flat = {
      scenario: { name: "测试" },
      scenarioCheckpoints: [{ id: "chk-1", skill: "侦查", trigger: "发现日记", scene: "书房" }],
    };
    const chunk = {
      scene: "书房",
      keyPoints: [{ id: "kp-1", title: "进入书房", scene: "书房" }],
      branches: [],
      text: "书房里有一本日记。",
    };
    const chunkPart = {
      keyPointConditions: [{ keyPointId: "kp-1", requires: { checkpointGroups: [["chk-1"]] } }],
      branchConditions: [],
      plotEdges: [],
    };
    const prompt = buildChunkReviewPrompt(flat, chunk, chunkPart);
    expect(prompt.includes("书房")).toBeTrue();
    expect(prompt.includes("chk-1")).toBeTrue();
    expect(prompt.includes("书房里有一本日记。")).toBeTrue();
    expect(prompt.includes("high")).toBeTrue();
  });

  it("buildChunkRevisionPrompt：在生成 Prompt 基础上回灌审校意见", () => {
    const flat = {
      scenario: { name: "测试" },
      scenarioCheckpoints: [{ id: "chk-1", skill: "侦查", trigger: "发现日记", scene: "书房" }],
    };
    const chunk = {
      scene: "书房",
      keyPoints: [{ id: "kp-1", title: "进入书房", scene: "书房" }],
      branches: [],
      text: "书房里有一本日记。",
    };
    const chunkPart = { keyPointConditions: [], branchConditions: [], plotEdges: [] };
    const prompt = buildChunkRevisionPrompt(flat, chunk, chunkPart, "- [high] keyPointConditions[0]: 引用不存在");
    expect(prompt.includes("只允许 keyPointConditions / branchConditions / plotEdges 字段")).toBeTrue();
    expect(prompt.includes("引用不存在")).toBeTrue();
    expect(prompt.includes("本场景原文：")).toBeTrue();
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "deep-parse 单元测试"));

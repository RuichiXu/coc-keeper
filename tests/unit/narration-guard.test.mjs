/**
 * 叙事候选校验（线索门禁泄露 + 危险推荐动作）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  clueWordsForCheckpoint,
  findCheckpointClueLeak,
  findUnsafeRecommendation,
  selectRelevantCheckpoints,
  validateNarrationCandidate,
} from "../../lib/shared/chat/index.js";

const FACTS = [
  { heading: "一层：客厅与餐厅", floor: "一层", keywords: ["一层", "客厅", "餐厅", "酒柜", "暗门"], original: "", facts: [] },
  { heading: "三层：克罗斯的书房", floor: "三层", keywords: ["三层", "书房", "墨渊", "手稿", "日记"], original: "", facts: [] },
];

const CHECKPOINTS = [
  { skill: "侦查", difficulty: "hard", scene: "一层：客厅与餐厅", floor: "一层", keys: ["一层", "客厅", "餐厅", "酒柜", "暗门"], trigger: "困难侦查发现酒柜后方暗门" },
  { skill: "侦查", difficulty: "extreme", scene: "调查员若对书房进行侦察或者图书馆检定", floor: "三层", keys: ["书房", "地毯", "墨渊"], trigger: "侦查极难成功或仔细摸索地毯发现墨渊" },
  { skill: "理智", difficulty: "regular", scene: "调查员若对书房进行侦察或者图书馆检定", floor: "三层", keys: ["书房", "墨渊", "巨眼"], trigger: "san check 成功-1san 失败-1D3san" },
];

describe("线索词提取", () => {
  it("过滤通用场景词，保留线索词", () => {
    const words = clueWordsForCheckpoint(CHECKPOINTS[0]);
    expect(words).toContain("暗门");
    expect(words).notToContain("一层");
    expect(words).notToContain("客厅");
  });
});

describe("场景检定点匹配", () => {
  it("当前场景一层时选中一层检定点", () => {
    const relevant = selectRelevantCheckpoints("一层：客厅与餐厅", FACTS, CHECKPOINTS);
    expect(relevant).toHaveLength(1);
    expect(relevant[0].skill).toBe("侦查");
  });

  it("当前场景三层时选中书房检定点", () => {
    const relevant = selectRelevantCheckpoints("三层：克罗斯的书房", FACTS, CHECKPOINTS);
    expect(relevant.length).toBeGreaterThanOrEqual(2);
  });
});

describe("线索门禁泄露检测", () => {
  it("未明骰时叙述出现暗门线索 → 判定泄露", () => {
    const leak = findCheckpointClueLeak("你发现酒柜后方有一道暗门。", {
      currentScene: "一层：客厅与餐厅",
      scenarioFacts: FACTS,
      scenarioCheckpoints: CHECKPOINTS,
      rolledSkills: new Set(),
    });
    expect(leak).notToBeNull();
    expect(leak.skill).toBe("侦查");
    expect(leak.words).toContain("暗门");
  });

  it("本轮已明骰侦查 → 不判定泄露", () => {
    const leak = findCheckpointClueLeak("你发现酒柜后方有一道暗门。", {
      currentScene: "一层：客厅与餐厅",
      scenarioFacts: FACTS,
      scenarioCheckpoints: CHECKPOINTS,
      rolledSkills: new Set(["侦查"]),
    });
    expect(leak).toBeNull();
  });

  it("理智线索在本轮已做理智暗骰 → 不判定泄露（仅理智保护）", () => {
    const leak = findCheckpointClueLeak("漩涡中逐渐睁开一只巨眼。", {
      currentScene: "三层：克罗斯的书房",
      scenarioFacts: FACTS,
      scenarioCheckpoints: CHECKPOINTS,
      rolledSkills: new Set(),
      sanityChecked: true,
    });
    expect(leak).toBeNull();
  });

  it("三层场景下未检定就叙述墨渊 → 判定泄露（侦查极限门禁优先）", () => {
    const leak = findCheckpointClueLeak("你看到墨渊在屋顶上缓缓旋转。", {
      currentScene: "三层：克罗斯的书房",
      scenarioFacts: FACTS,
      scenarioCheckpoints: CHECKPOINTS,
      rolledSkills: new Set(),
    });
    expect(leak).notToBeNull();
    expect(leak.skill).toBe("侦查");
    expect(leak.difficulty).toBe("extreme");
  });
});

describe("危险推荐动作检测", () => {
  it("检测破坏线索的推荐", () => {
    const unsafe = findUnsafeRecommendation("你看着墙上的墨迹。可选行动：1) 擦掉墨渍 2) 观察四周");
    expect(unsafe).notToBeNull();
    expect(unsafe.reason).toBe("破坏或清除线索");
  });

  it("检测让 NPC 接触 SAN 源的推荐", () => {
    const unsafe = findUnsafeRecommendation("可选行动：叫艾茜来看墨渊 / 自己退后");
    expect(unsafe).notToBeNull();
  });

  it("检测拖延到坏结局时间点的推荐", () => {
    const unsafe = findUnsafeRecommendation("你感到不安。可选行动：等到明早再看看 / 继续调查");
    expect(unsafe).notToBeNull();
  });

  it("安全推荐不误报", () => {
    const unsafe = findUnsafeRecommendation("你感到不安。可选行动：观察四周 / 退回走廊 / 聆听动静");
    expect(unsafe).toBeNull();
  });
});

describe("综合候选校验", () => {
  it("返回线索泄露与危险推荐两类问题", () => {
    const issues = validateNarrationCandidate("你发现酒柜后方有一道暗门。可选行动：擦掉墨渍。", {
      currentScene: "一层：客厅与餐厅",
      scenarioFacts: FACTS,
      scenarioCheckpoints: CHECKPOINTS,
      rolledSkills: new Set(),
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((issue) => issue.kind === "clue-leak")).toBeTrue();
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "narration-guard 单元测试"));

/**
 * Scene Facts & Checkpoint Extraction 单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  extractSceneFacts,
  extractCheckpoints,
  selectSceneFacts,
  inferSceneFromText,
  hasSceneMovementPhrase,
  inferSceneTransition,
  splitScenarioSections,
  classifyFloor,
  buildRoomFloorRules,
  findRoomFloorConflict,
} from "../../lib/core/index.js";

const SAMPLE = `导入：
调查员们收到艾茜·沃什的委托信。

惴惴不安的宅邸主人：
沃什宅邸位于阿卡姆镇边缘的贵族旧区，这是一栋维多利亚式的三层老宅，外墙爬满枯萎的常春藤，周围只剩平整的土地，甚至连草坪都不曾见到。（此时通过困难的侦查鉴定可以发现屋顶边缘可以看见一截楼梯，似乎从侧边绕出来）

一层：客厅与餐厅：
玄关处铺着厚重舒适的波斯地毯。客厅内弥漫着陈旧纸张与某种甜腻腐臭混合的气味。
通过困难难度的侦查检定可以发现在酒柜的后方有一个暗门。

二层：家族肖像与卧室之门：
二层有多个用于休息的卧室，艾茜和克罗斯就用了其中的2个房间作为自己的卧室。白天里面有一间卧室是锁着的，那就是克罗斯的房间，此时他正在休息。

三层：克罗斯的书房：
书房是锁着的，调查员可以通过撬锁或者偷偷妙手克罗斯获取到书房钥匙。
侦察或者图书馆普通成功：发现书桌抽屉里有一本日记。
侦察或者图书馆困难成功：发现书桌抽屉里有四张手稿。
侦察极难成功或仔细摸索地毯：发现地毯中间有一条接缝，沿着接缝掀开地毯后，可以看到墨渊。
CG播放完毕，进行san check，成功-1san，失败-1D3san。`;

describe("Scene Facts", () => {
  it("splitScenarioSections 按短标题切分", () => {
    const sections = splitScenarioSections(SAMPLE);
    expect(sections.length).toBe(5);
    expect(sections[1].heading).toContain("惴惴不安的宅邸主人");
    expect(sections[4].heading).toContain("三层");
  });

  it("classifyFloor 正确识别楼层", () => {
    expect(classifyFloor("一层：客厅与餐厅", "客厅内弥漫着气味")).toBe("一层");
    expect(classifyFloor("二层：家族肖像与卧室之门", "二层有多个卧室")).toBe("二层");
    expect(classifyFloor("三层：克罗斯的书房", "书房是锁着的")).toBe("三层");
    expect(classifyFloor("剧情梗概", "克罗斯的书房下出现了墨渊")).toBe("导入");
  });

  it("extractSceneFacts 输出事实卡与原文块", () => {
    const facts = extractSceneFacts(SAMPLE);
    const third = facts.find((f) => f.heading === "三层：克罗斯的书房");
    expect(third !== undefined).toBeTrue();
    expect(third.floor).toBe("三层");
    expect(third.original).toContain("书房是锁着的");
    expect(third.facts.length).toBeGreaterThan(0);
  });

  it("extractCheckpoints 提取显式检定点（含难度）", () => {
    const checks = extractCheckpoints(SAMPLE);
    const hard = checks.filter((c) => c.skill === "侦查" && c.difficulty === "hard");
    expect(hard.length).toBe(3);
    const library = checks.filter((c) => c.skill === "图书馆使用");
    expect(library.some((c) => c.difficulty === "regular")).toBeTrue();
    expect(library.some((c) => c.difficulty === "hard")).toBeTrue();
    const extreme = checks.find((c) => c.skill === "侦查" && c.difficulty === "extreme");
    expect(extreme !== undefined).toBeTrue();
    const san = checks.find((c) => c.skill === "理智");
    expect(san !== undefined).toBeTrue();
    expect(san.sanLoss).toBe("1/1d3");
  });

  it("selectSceneFacts 匹配当前场景", () => {
    const facts = extractSceneFacts(SAMPLE);
    const selected = selectSceneFacts("三层书房", facts);
    expect(selected).notToBeNull();
    expect(selected.heading).toContain("三层");
  });

  it("inferSceneFromText 从叙述推断场景", () => {
    const facts = extractSceneFacts(SAMPLE);
    expect(inferSceneFromText("你推门走进书房，门在身后锁上了", facts)).toContain("三层");
    expect(inferSceneFromText("你来到宅邸外，铁栅栏围住整片土地", facts)).toContain("惴惴不安");
  });

  it("inferSceneTransition：仅提到他处场景词不切换，需位置转移动作", () => {
    const facts = extractSceneFacts(SAMPLE);
    // 当前在三层书房检查书桌，叙述里顺带提到“一层客厅”，不应漂移。
    expect(inferSceneTransition("你检查书桌，想起一层客厅的吊灯与餐厅的壁炉", "三层书房", facts)).toBeNull();
    expect(inferSceneTransition("你仔细检查书桌，桌上刻着墨渊的印记", "三层书房", facts)).toBeNull();
    // 有转移动作才切换。
    expect(inferSceneTransition("你沿楼梯走下一层，来到客厅与餐厅", "三层书房", facts)).toContain("一层");
    // 当前场景为空时无需动作直接推断。
    expect(inferSceneTransition("你推门走进书房", "", facts)).toContain("三层");
  });

  it("hasSceneMovementPhrase 识别位置转移动作", () => {
    expect(hasSceneMovementPhrase("你走到书桌前")).toBeTrue();
    expect(hasSceneMovementPhrase("你检查书桌")).toBeFalse();
  });

  it("buildRoomFloorRules 从标题提取房间-楼层规则", () => {
    const facts = extractSceneFacts(SAMPLE);
    const rules = buildRoomFloorRules(facts);
    expect(rules.some((r) => r.room === "书房" && r.floor === "三层")).toBeTrue();
    expect(rules.some((r) => r.room === "卧室" && r.floor === "二层")).toBeTrue();
    expect(rules.some((r) => r.room === "客厅" && r.floor === "一层")).toBeTrue();
  });

  it("findRoomFloorConflict 检测楼层-房间冲突", () => {
    const facts = extractSceneFacts(SAMPLE);
    expect(findRoomFloorConflict("你来到二楼的书房", facts)).notToBeNull();
    expect(findRoomFloorConflict("你沿楼梯走上三层，推开书房门", facts)).toBeNull();
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "scene-facts 单元测试"));

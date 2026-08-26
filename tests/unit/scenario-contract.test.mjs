/**
 * Scenario Contract 单元测试
 * 覆盖：契约归一化/校验、草拟、候选叙述校验、夜晚事件触发。
 */
import { run, describe, it, expect, summarize } from "../runner.js";
import {
  createScenarioContract,
  normalizeScenarioContract,
  validateScenarioContract,
  draftScenarioContract,
  ensureScenarioContract,
} from "../../lib/core/scenario/index.js";
import {
  evaluateNightEvents,
  validateCandidateNarration,
} from "../../lib/shared/chat/scenario-contract-validator.js";

describe("契约 schema", () => {
  it("normalize 补齐字段并过滤无效条目", () => {
    const normalized = normalizeScenarioContract({
      clueGates: [{ clueWords: ["墨渊"] }, { clueWords: [] }],
      npcKnowledge: [{ npcName: "克罗斯", unknown: ["墨渊"] }, { npcName: "" }],
      ritualConditions: [{ name: "仪式", requires: [{ value: "手稿" }] }, { name: "", requires: [] }],
      nightEvents: [{ title: "午夜梦游" }],
      finalBranchWhitelist: [{ branchId: "br-1", endingId: "结局1" }],
    });

    expect(normalized.version).toBe(1);
    expect(normalized.clueGates).toHaveLength(1);
    expect(normalized.clueGates[0].id).toBe("cg-1");
    expect(normalized.npcKnowledge).toHaveLength(1);
    expect(normalized.npcKnowledge[0].npcName).toBe("克罗斯");
    expect(normalized.ritualConditions).toHaveLength(1);
    expect(normalized.ritualConditions[0].requires[0].value).toBe("手稿");
    expect(normalized.nightEvents[0].trigger).toBe("onSleep");
    expect(normalized.nightEvents[0].sleepPolicy).toBe("force");
  });

  it("validate 报告结构问题", () => {
    const issues = validateScenarioContract({
      clueGates: [{ id: "cg-1", clueWords: [] }],
      ritualConditions: [{ id: "rc-1", name: "仪式", requires: [] }],
    });
    expect(issues.length > 0).toBe(true);
    expect(issues.join("|")).toContain("线索门禁");
    expect(issues.join("|")).toContain("仪式条件");
  });
});

describe("契约草拟", () => {
  it("从检定点/实体/分支/原文草拟契约", () => {
    const flat = {
      scenario: { text: "三层：书房\n午夜梦游，门外有哭声。\n仪式需要手稿与烛台。\n结局1（BE）" },
      scenarioCheckpoints: [
        { id: "chk-1", skill: "侦查", trigger: "侦查发现墨渊", keys: ["地毯", "墨渊"] },
      ],
      entities: [
        { id: "ent-npc-1", type: "npc", name: "克罗斯" },
        { id: "ent-item-1", type: "item", name: "手稿" },
      ],
      branches: [
        { id: "br-1", title: "调查员念出咒文", options: [{ label: "念", leadsTo: "结局1（BE）" }] },
      ],
      keyPoints: [],
    };

    const contract = draftScenarioContract(flat);

    expect(contract.clueGates.length > 0).toBe(true);
    expect(contract.clueGates[0].clueWords).toContain("墨渊");
    expect(contract.npcKnowledge.length > 0).toBe(true);
    expect(contract.npcKnowledge[0].npcName).toBe("克罗斯");
    expect(contract.nightEvents.length > 0).toBe(true);
    expect(contract.ritualConditions.length > 0).toBe(true);
    expect(contract.finalBranchWhitelist.length > 0).toBe(true);
    expect(contract.finalBranchWhitelist[0].branchId).toBe("br-1");
  });

  it("ensure 保留非空类别并补齐空类别", () => {
    const flat = {
      scenario: { text: "三层：书房\n午夜梦游。" },
      scenarioCheckpoints: [{ id: "chk-1", skill: "侦查", keys: ["墨渊"] }],
      entities: [],
      branches: [],
    };
    const merged = ensureScenarioContract(
      { clueGates: [{ id: "manual", clueWords: ["巨眼"] }] },
      flat
    );
    expect(merged.clueGates).toHaveLength(1);
    expect(merged.clueGates[0].id).toBe("manual");
    expect(merged.nightEvents.length > 0).toBe(true);
  });
});

describe("候选叙述校验", () => {
  const contract = normalizeScenarioContract({
    clueGates: [
      { id: "cg-1", skill: "侦查", clueWords: ["墨渊"] },
    ],
    npcKnowledge: [
      { id: "nk-1", npcName: "克罗斯", knows: [], unknown: ["巨眼"] },
    ],
    ritualConditions: [
      {
        id: "rc-1",
        name: "召回仪式",
        keywords: ["召回仪式"],
        requires: [{ kind: "item", value: "手稿" }],
      },
    ],
    finalBranchWhitelist: [
      { id: "fb-1", branchId: "br-1" },
    ],
  });

  it("线索门禁：检定通过前出现受保护词即违规，通过后放行", () => {
    const before = validateCandidateNarration(contract, "你看见墨渊", { rolledSkills: new Set() });
    expect(before.passed).toBe(false);
    expect(before.violations[0]).toContain("线索门禁");

    const after = validateCandidateNarration(contract, "你看见墨渊", { rolledSkills: new Set(["侦查"]) });
    expect(after.passed).toBe(true);
  });

  it("NPC 知识边界：NPC 说出 unknown 信息即违规", () => {
    const result = validateCandidateNarration(contract, "克罗斯低声道：那只巨眼在看着我们。", {
      rolledSkills: new Set(["侦查"]),
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toContain("克罗斯");
  });

  it("仪式条件：缺少道具即违规，道具入栏后放行", () => {
    const missing = validateCandidateNarration(contract, "你们完成了召回仪式。", {
      inventory: [],
    });
    expect(missing.passed).toBe(false);
    expect(missing.violations[0]).toContain("手稿");

    const satisfied = validateCandidateNarration(contract, "你们完成了召回仪式。", {
      inventory: ["四张手稿"],
    });
    expect(satisfied.passed).toBe(true);
  });

  it("最终分支白名单：分支标题不在白名单内即违规", () => {
    const result = validateCandidateNarration(contract, "你选择了放弃调查，离开宅邸。", {
      branches: [{ id: "br-9", title: "放弃调查，离开宅邸" }],
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toContain("白名单");
  });
});

describe("夜晚事件", () => {
  const contract = normalizeScenarioContract({
    nightEvents: [
      { id: "ne-1", title: "午夜梦游", trigger: "onSleep", sleepPolicy: "force" },
      { id: "ne-2", title: "定时钟声", trigger: "onTime", nightLabel: "午夜" },
      { id: "ne-3", title: "允许不睡", trigger: "onSleep", sleepPolicy: "allow" },
    ],
  });

  it("onSleep 只在入睡后触发；不入睡且夜里有 force 事件时返回 forcedSleep", () => {
    const sleeping = evaluateNightEvents(contract, {
      time: "1925年10月1日 下午3点",
      sleeping: true,
      narrationMentionsSleep: true,
      firedNightEventIds: [],
    });
    expect(sleeping.fired.map((event) => event.id)).toContain("ne-1");

    const awake = evaluateNightEvents(contract, {
      time: "1925年10月1日 晚上11点",
      sleeping: false,
      narrationMentionsSleep: false,
      firedNightEventIds: [],
    });
    expect(awake.fired).toHaveLength(0);
    expect(awake.forcedSleep).notToBeNull();
    expect(awake.forcedSleep.eventId).toBe("ne-1");
  });

  it("onTime 按 nightLabel 触发；已触发事件不重复", () => {
    const fired = evaluateNightEvents(contract, {
      time: "1925年10月1日 午夜",
      sleeping: false,
      narrationMentionsSleep: false,
      firedNightEventIds: [],
    });
    expect(fired.fired.map((event) => event.id)).toContain("ne-2");

    const again = evaluateNightEvents(contract, {
      time: "1925年10月1日 午夜",
      sleeping: false,
      narrationMentionsSleep: false,
      firedNightEventIds: ["ne-2"],
    });
    expect(again.fired.map((event) => event.id)).notToContain("ne-2");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "scenario-contract 单元测试"));

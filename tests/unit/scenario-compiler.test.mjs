/**
 * Scenario Compiler 单元测试
 */
import { describe, it, expect } from "../runner.js";
import {
  compileByPattern,
  buildAiParsePrompt,
  parseAiResult,
  toLegacyFormat,
} from "../../lib/core/scenario/compiler.js";

describe("Scenario Compiler", () => {
  describe("compileByPattern", () => {
    it("解析场景标记", () => {
      const model = compileByPattern("【场景】废弃宅邸\n调查员进入宅邸。", "测试");
      expect(model.scenes).toHaveLength(1);
      expect(model.scenes[0].name).toBe("废弃宅邸");
    });
    it("解析 NPC", () => {
      const model = compileByPattern("【NPC】老管家", "测试");
      expect(model.npcs).toHaveLength(1);
      expect(model.npcs[0].name).toBe("老管家");
    });
    it("解析地点", () => {
      const model = compileByPattern("【地点】仓库", "测试");
      expect(model.locations).toHaveLength(1);
    });
    it("解析物品", () => {
      const model = compileByPattern("【物品】旧怀表", "测试");
      expect(model.items).toHaveLength(1);
    });
    it("解析关键剧情点", () => {
      const model = compileByPattern("【关键剧情点】书房发现暗格", "测试");
      expect(model.plotNodes).toHaveLength(1);
      expect(model.plotNodes[0].title).toBe("书房发现暗格");
    });
    it("解析分支", () => {
      const model = compileByPattern("【分支】是否撬开暗格", "测试");
      expect(model.branches).toHaveLength(1);
      expect(model.branches[0].title).toBe("是否撬开暗格");
    });
    it("NPC 关联当前场景", () => {
      const model = compileByPattern("【场景】书房\n【NPC】老管家", "测试");
      expect(model.npcs[0].scenes).toContain("书房");
    });
  });

  describe("buildAiParsePrompt", () => {
    it("生成 prompt 包含剧本内容", () => {
      const prompt = buildAiParsePrompt("【场景】测试");
      expect(prompt).toMatch(/测试/);
      expect(prompt).toMatch(/JSON/);
    });
  });

  describe("parseAiResult", () => {
    it("解析 AI 返回的 JSON", () => {
      const aiResult = {
        scenes: [{ name: "废弃宅邸", description: "旧宅" }],
        npcs: [{ name: "老管家", role: "major", description: "管家" }],
        clues: [{ description: "暗格中的古书", acquisitionMethods: ["侦查"], isCritical: true }],
        plotNodes: [{ title: "发现暗格", type: "event", description: "" }],
        branches: [{ title: "选择", options: [{ label: "继续", leadsTo: "地下室" }] }],
        endings: [{ title: "好结局", type: "good", description: "" }],
        hiddenFacts: [{ fact: "管家是邪教徒", category: "secret" }],
        items: [],
        locations: [],
        triggers: [],
      };
      const model = parseAiResult(aiResult, "测试");
      expect(model.scenes).toHaveLength(1);
      expect(model.npcs).toHaveLength(1);
      expect(model.clues).toHaveLength(1);
      expect(model.clues[0].isCritical).toBeTrue();
      expect(model.plotNodes).toHaveLength(1);
      expect(model.branches).toHaveLength(1);
      expect(model.endings).toHaveLength(1);
      expect(model.hiddenFacts).toHaveLength(1);
    });
  });

  describe("toLegacyFormat", () => {
    it("转换为旧格式兼容", () => {
      const model = compileByPattern("【场景】书房\n【关键剧情点】发现暗格\n【分支】是否撬开\n【NPC】老管家\n【物品】古书", "测试");
      const legacy = toLegacyFormat(model);
      expect(legacy.keyPoints).toHaveLength(1);
      expect(legacy.branches).toHaveLength(1);
      expect(legacy.entities).toHaveLength(2); // NPC + 物品
    });
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "scenario-compiler 单元测试"));
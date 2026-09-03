/**
 * 结构分析管线单元测试：清洗、解析归一、切片与层级路由。
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  cleanScenarioText,
  parseStructureAnalysisResult,
  computeSectionTexts,
  applyStructureAnalysis,
  applyStructureEdits,
  buildStructureAnalysisPrompt,
  splitScenarioSections,
} from "../../lib/core/index.js";

const SAMPLE = `-- 1 of 4 --
5.6 约翰的书
斋
调查员进入书斋，发现书桌抽屉里有日记。
5.7 走廊
走廊很暗，墙上挂着肖像。
附录 1 地图
宅邸地图说明：一层为门厅。`;

function descriptor() {
  return {
    format: "numbered",
    sections: [
      { id: "s1", title: "约翰的书斋", displayName: "书斋", kind: "scene", flowRole: "main", desc: "调查员进入书斋调查。", level: 1, parentId: null, startLine: 2, endLine: 4, page: 1, order: 1 },
      { id: "s2", title: "走廊", displayName: "二层走廊", kind: "scene", flowRole: "main", desc: "二层走廊。", level: 1, parentId: null, startLine: 5, endLine: 6, page: 1, order: 2 },
      { id: "s3", title: "附录 1 地图", displayName: "宅邸地图", kind: "appendix", flowRole: null, desc: "地图说明。", level: 1, parentId: null, startLine: 7, endLine: 8, page: 1, order: 3 },
    ],
  };
}

describe("Structure Analysis", () => {
  it("cleanScenarioText 去掉页码标记并保留真实行号", () => {
    const doc = cleanScenarioText(SAMPLE);
    expect(doc.displayLineByNo.has(2)).toBeTrue();
    expect(doc.displayLineByNo.has(1)).toBeFalse();
    const line2 = doc.displayLineByNo.get(2);
    expect(line2.text).toBe("5.6 约翰的书");
    expect(doc.totalRawLines).toBe(8);
  });

  it("splitScenarioSections 返回真实行号", () => {
    const clean = SAMPLE.replace(/--\s*\d+\s+of\s+\d+\s*--/g, "").split(/\r?\n/).filter((line) => line.trim().length > 0).join("\n");
    const sections = splitScenarioSections(clean);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    const first = sections[0];
    expect(first.heading).toBe("5.6 约翰的书");
    expect(first.startLine).toBe(1);
  });

  it("parseStructureAnalysisResult 覆盖全文并修正行号", () => {
    const doc = cleanScenarioText(SAMPLE);
    const result = parseStructureAnalysisResult(JSON.stringify(descriptor()), doc);
    expect(result.sections.length).toBe(3);
    expect(result.sections[0].startLine).toBe(2);
    expect(result.sections[2].endLine).toBe(8);
    expect(result.sections[0].kind).toBe("scene");
    expect(result.sections[0].flowRole).toBe("main");
  });

  it("computeSectionTexts 计算 ownLines/bodyLines（子节从父节 own 中剔除）", () => {
    const doc = cleanScenarioText(SAMPLE);
    const descriptor2 = {
      format: "numbered",
      sections: [
        { id: "s1", title: "宅邸", displayName: "宅邸", kind: "scene", flowRole: "main", desc: "宅邸整体。", level: 1, parentId: null, startLine: 2, endLine: 6, page: 1, order: 1 },
        { id: "s2", title: "约翰的书斋", displayName: "书斋", kind: "scene", flowRole: "main", desc: "书斋。", level: 2, parentId: "s1", startLine: 2, endLine: 4, page: 1, order: 2 },
        { id: "s3", title: "走廊", displayName: "走廊", kind: "scene", flowRole: "main", desc: "走廊。", level: 2, parentId: "s1", startLine: 5, endLine: 6, page: 1, order: 3 },
      ],
    };
    const result = parseStructureAnalysisResult(JSON.stringify(descriptor2), doc);
    const sections = computeSectionTexts(doc, result.sections);
    const parent = sections.find((section) => section.id === "s1");
    const child = sections.find((section) => section.id === "s2");
    expect(parent.bodyText).toContain("书斋");
    expect(parent.ownText).notToContain("日记");
    expect(child.bodyText).toContain("日记");
    expect(child.ownText).toContain("日记");
  });

  it("applyStructureAnalysis 路由到 keyPoints/scenarioFacts/appendix 与场景关系", () => {
    const flat = { scenario: { text: SAMPLE, name: "测试" } };
    const doc = cleanScenarioText(SAMPLE);
    const result = parseStructureAnalysisResult(JSON.stringify(descriptor()), doc);
    const stats = applyStructureAnalysis(flat, doc, result);
    expect(stats.keyPoints).toBe(2);
    expect(stats.scenarioFacts).toBe(2);
    expect(stats.appendix).toBe(1);
    expect(flat.keyPoints[0].title).toBe("约翰的书斋");
    expect(flat.keyPoints[0].scene).toBe("约翰的书斋");
    expect(flat.keyPoints[0].kind).toBe("scene");
    expect(flat.keyPoints[0].flowRole).toBe("main");
    expect(flat.scenarioFacts[0].heading).toBe("约翰的书斋");
    expect(flat.scenarioStructure.sections.length).toBe(3);
    expect(flat.sceneRelations.length).toBeGreaterThanOrEqual(1);
    expect(flat.sceneRelations.some((rel) => rel.type === "after")).toBeTrue();
  });

  it("buildStructureAnalysisPrompt 小文本给全文，大文本给候选", () => {
    const doc = cleanScenarioText(SAMPLE);
    const prompt = buildStructureAnalysisPrompt(doc, "测试");
    expect(prompt).toContain("约翰的书");
    const big = cleanScenarioText("标题一\n" + "这是一段很长的正文内容。".repeat(3500));
    const bigPrompt = buildStructureAnalysisPrompt(big, "大剧本");
    expect(bigPrompt).toContain("候选");
  });

  it("applyStructureEdits 同步编辑后的 section 层级到 keyPoints/scenarioFacts", () => {
    const flat = { scenario: { text: SAMPLE, name: "测试" } };
    const doc = cleanScenarioText(SAMPLE);
    const result = parseStructureAnalysisResult(JSON.stringify(descriptor()), doc);
    applyStructureAnalysis(flat, doc, result);
    const sections = JSON.parse(JSON.stringify(flat.scenarioStructure.sections));
    sections[0].kind = "chapter";
    sections[0].flowRole = null;
    sections[0].displayName = "约翰章节";
    const stats = applyStructureEdits(flat, sections);
    expect(stats.keyPoints).toBe(1);
    expect(flat.keyPoints[0].displayName).toBe("二层走廊");
    expect(flat.scenarioStructure.sections[0].kind).toBe("chapter");
    expect(flat.sceneRelations.length).toBeGreaterThanOrEqual(0);
  });
});

run().then(summarize);

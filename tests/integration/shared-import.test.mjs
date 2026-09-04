/**
 * Shared 导入器集成测试：剧情图、flat 兼容字段与资产库同步。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "../runner.js";
import {
  ASSET_KINDS,
  AssetStore,
  cleanScenarioText,
  GameSession,
  JsonFilePersistence,
} from "../../lib/core/index.js";
import { createSharedToolDefs } from "../../lib/shared/tools/index.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "coc-shared-import-"));
  const deps = {
    dataDir,
    defaultGame: "g1",
    persistence: new JsonFilePersistence(dataDir),
    assetStore: new AssetStore(join(dataDir, "assets")),
    session: new GameSession({ id: "g1" }),
    stateKey: (gameId) => join("games", `${gameId}.json`),
    maxRollHistory: 200,
  };
  return { dataDir, deps, defs: createSharedToolDefs(deps) };
}


function validStructure(text) {
  const doc = cleanScenarioText(text);
  const first = doc.firstLineNo;
  const last = doc.lastLineNo;
  return {
    format: "labeled",
    sections: [
      {
        id: "s1",
        title: "书房",
        displayName: "书房",
        kind: "scene",
        flowRole: "main",
        desc: "书房场景。",
        level: 1,
        parentId: null,
        startLine: first,
        endLine: last,
        page: 1,
        order: 1,
      },
    ],
  };
}

describe("Shared 导入器", () => {
  it("剧本文本重建 flat 结构、PlotGraph 与剧本资产（结构分析路径）", async () => {
    const { dataDir, deps, defs } = fixture();
    const text = [
      "【剧本】雾中宅邸",
      "【场景】书房",
      "【关键剧情点】发现暗门",
      "【分支】是否进入暗门",
      "【NPC】老管家",
      "【地点】荒废宅邸",
      "【物品】黄铜钥匙",
    ].join("\n");
    deps.callLlmApi = async () => ({
      blocks: [{ type: "text", text: JSON.stringify(validStructure(text)) }],
    });
    const result = await defs.get("coc_import").execute({
      kind: "scenario",
      source: "text",
      text,
      game: "g1",
      overwrite: true,
    });

    expect(result.keyPoints).toBe(1);
    expect(result.entities).toBe(3);
    const flat = JSON.parse(
      readFileSync(join(dataDir, "games", "g1.json"), "utf8")
    );
    expect(flat.keyPoints[0].title).toBe("书房");
    expect(flat.keyPoints[0].kind).toBe("scene");
    expect(flat.entities.every((entity) => entity.revealed === false)).toBeTrue();
    expect(flat.entities.every((entity) => entity.playerDesc === "")).toBeTrue();
    expect(flat.core.plot.nodes).toHaveLength(1);
    expect(flat.scenarioId).toBe("sc-雾中宅邸");
    expect(deps.assetStore.list(ASSET_KINDS.SCENARIO)).toHaveLength(1);
  });

  it("D-2：LLM 深度解析成功时生成 draft 并合并补充分支与结局", async () => {
    const { dataDir, deps, defs } = fixture();
    const text = "这是一个剧本。调查员在书房发现一本日记。";
    deps.callLlmApi = async (_dataDir, messages) => {
      const prompt = messages[0]?.content?.[0]?.text ?? "";
      if (prompt.includes("结构分析师")) {
        return { blocks: [{ type: "text", text: JSON.stringify(validStructure(text)) }] };
      }
      if (prompt.includes("最终分支与结局")) {
        return {
          blocks: [{
            type: "text",
            text: JSON.stringify({
              branches: [{ id: "br-1", title: "是否阅读日记", scene: "书房", finalChoice: true, options: [{ label: "阅读", leadsTo: "发现日记" }, { label: "不读", leadsTo: "空手而归" }] }],
              branchConditions: [{ branchId: "br-1", requires: { scene: "书房" } }],
              plotEdges: [
                { from: "br:br-1", to: "end:end-1", label: "阅读", requires: [] },
                { from: "br:br-1", to: "end:end-2", label: "不读", requires: [] },
              ],
              endings: [
                { id: "end-1", branchId: "br-1", title: "阅读结局", optionLabel: "阅读", mutexGroup: "最终结局", requires: { branchChoiceIds: ["br-1"], optionLabel: "阅读" }, blockers: [], endingKeywords: ["阅读结局"] },
                { id: "end-2", branchId: "br-1", title: "空手而归", optionLabel: "不读", mutexGroup: "最终结局", requires: { branchChoiceIds: ["br-1"], optionLabel: "不读" }, blockers: [], endingKeywords: ["空手而归"] },
              ],
            }),
          }],
        };
      }
      return {
        blocks: [{
          type: "text",
          text: JSON.stringify({ keyPointConditions: [], branchConditions: [], plotEdges: [] }),
        }],
      };
    };

    const result = await defs.get("coc_import").execute({
      kind: "scenario",
      source: "text",
      game: "g1",
      text,
    });

    expect(result.deepParseStatus).toBe("draft");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.deepParse.status).toBe("draft");
    expect(flat.deepParse.source).toBe("llm");
    expect(flat.branches.some((branch) => branch.id === "br-1" && branch.title === "是否阅读日记")).toBeTrue();
    const finalBranch = flat.branches.find((branch) => branch.id === "br-1");
    expect(finalBranch.options.map((option) => option.label)).toEqual(["阅读", "不读"]);
    expect(flat.deepParse.endings.some((ending) => ending.title === "阅读结局")).toBeTrue();
  });

  it("D-2：LLM 深度解析失败时保留结构关键点并标记 skipped", async () => {
    const { dataDir, deps, defs } = fixture();
    const text = [
      "【剧本】雾中宅邸",
      "【场景】书房",
      "【关键剧情点】发现暗门",
      "【分支】是否进入暗门",
      "【NPC】老管家",
    ].join("\n");
    deps.callLlmApi = async (_dataDir, messages) => {
      const prompt = messages[0]?.content?.[0]?.text ?? "";
      if (prompt.includes("结构分析师")) {
        return { blocks: [{ type: "text", text: JSON.stringify(validStructure(text)) }] };
      }
      return { blocks: [{ type: "text", text: "这不是 JSON" }] };
    };

    const result = await defs.get("coc_import").execute({
      kind: "scenario",
      source: "text",
      game: "g1",
      text,
      overwrite: true,
    });

    expect(result.deepParseStatus).toBe("skipped");
    expect(result.keyPoints).toBe(1);
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.deepParse.status).toBe("skipped");
    expect(flat.keyPoints).toHaveLength(1);
    expect(flat.keyPoints[0].title).toBe("书房");
  });

  it("结构分析失败时直接报错，不落确定性切分", async () => {
    const { dataDir, deps, defs } = fixture();
    deps.callLlmApi = async () => ({ blocks: [{ type: "text", text: "这不是 JSON" }] });
    const text = "【剧本】雾中宅邸\n【场景】书房\n【关键剧情点】发现暗门\n【分支】是否进入暗门\n【NPC】老管家";
    let threw = false;
    try {
      await defs.get("coc_import").execute({
        kind: "scenario",
        source: "text",
        game: "g1",
        text,
        overwrite: true,
      });
    } catch (error) {
      threw = /结构分析失败/.test(error.message);
    }
    expect(threw).toBeTrue();
  });

  it("JSON 人物数组写入场次与调查员资产库", async () => {
    const { dataDir, deps, defs } = fixture();
    const result = await defs.get("coc_import").execute({
      kind: "characters",
      source: "text",
      game: "g1",
      text: JSON.stringify([
        {
          name: "林默",
          occupation: "记者",
          stats: { STR: 50, SAN: 60 },
          skills: { "侦查": 70 },
        },
      ]),
    });
    expect(result.characters).toBe(1);
    const flat = JSON.parse(
      readFileSync(join(dataDir, "games", "g1.json"), "utf8")
    );
    expect(flat.characters[0].name).toBe("林默");
    expect(flat.characters[0].occupation).toBe("记者");
    expect(deps.assetStore.list(ASSET_KINDS.INVESTIGATOR)).toHaveLength(1);
  });

  it("coc_read 与内置 coc_query_rule 可独立使用", async () => {
    const { defs } = fixture();
    await defs.get("coc_import").execute({
      kind: "rules",
      source: "text",
      game: "g1",
      name: "测试规则",
      text: "## 战斗规则\n攻击与闪避。\n## 理智规则\n进行 SAN 检定。",
    });
    const read = await defs.get("coc_read").execute({
      what: "rules",
      game: "g1",
      offset: 0,
      limit: 6,
    });
    expect(read.text).toBe("## 战斗规");
    const query = await defs.get("coc_query_rule").execute({
      game: "g1",
      topic: "理智",
    });
    expect(query.text).toContain("SAN 检定");
    expect(query.source).toBe("测试规则");
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "shared-import 集成测试"));

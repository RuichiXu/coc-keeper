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

describe("Shared 导入器", () => {
  it("剧本文本重建 flat 结构、PlotGraph 与剧本资产", async () => {
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
    const result = await defs.get("coc_import").execute({
      kind: "scenario",
      source: "text",
      text,
      game: "g1",
      overwrite: true,
    });

    expect(result.keyPoints).toBe(1);
    expect(result.branches).toBe(1);
    expect(result.entities).toBe(3);
    const flat = JSON.parse(
      readFileSync(join(dataDir, "games", "g1.json"), "utf8")
    );
    expect(flat.keyPoints[0].title).toBe("发现暗门");
    expect(flat.entities.every((entity) => entity.revealed === false)).toBeTrue();
    expect(flat.entities.every((entity) => entity.playerDesc === "")).toBeTrue();
    expect(flat.core.plot.nodes).toHaveLength(1);
    expect(flat.scenarioId).toBe("sc-雾中宅邸");
    expect(deps.assetStore.list(ASSET_KINDS.SCENARIO)).toHaveLength(1);
  });

  it("D-2：LLM 深度解析成功时生成 draft 并合并新关键点/分支", async () => {
    const { dataDir, deps, defs } = fixture();
    deps.callLlmApi = async (_dataDir, messages) => {
      const prompt = messages[0]?.content?.[0]?.text ?? "";
      if (prompt.includes("深度剧情解析")) {
        return {
          blocks: [{
            type: "text",
            text: JSON.stringify({
              keyPoints: [{ id: "kp-1", title: "发现日记", scene: "书房" }],
              branches: [{ id: "br-1", title: "是否阅读日记", options: [{ label: "阅读", leadsTo: "发现日记" }] }],
              keyPointConditions: [{ keyPointId: "kp-1", requires: { scene: "书房" } }],
              branchConditions: [{ branchId: "br-1", requires: { scene: "书房" } }],
              plotEdges: [{ from: "br:br-1", to: "kp:kp-1", label: "阅读", requires: [], consequences: { setFlags: { "branch:br-1:chosen": "阅读" } } }],
              endings: [{ branchId: "br-1", title: "阅读结局", requires: { branchChoiceIds: ["br-1"] }, blockers: [], endingKeywords: ["阅读结局"] }],
            }),
          }],
        };
      }
      return {
        blocks: [{
          type: "text",
          text: JSON.stringify({ clueGates: [], npcKnowledge: [], ritualConditions: [], nightEvents: [], finalBranchWhitelist: [] }),
        }],
      };
    };

    const result = await defs.get("coc_import").execute({
      kind: "scenario",
      source: "text",
      game: "g1",
      text: "这是一个剧本。调查员在书房发现一本日记。",
    });

    expect(result.deepParseStatus).toBe("draft");
    const flat = JSON.parse(readFileSync(join(dataDir, "games", "g1.json"), "utf8"));
    expect(flat.deepParse.status).toBe("draft");
    expect(flat.deepParse.source).toBe("llm");
    expect(flat.keyPoints.some((kp) => kp.id === "kp-1" && kp.title === "发现日记")).toBeTrue();
    expect(flat.branches.some((branch) => branch.id === "br-1" && branch.title === "是否阅读日记")).toBeTrue();
  });

  it("D-2：LLM 深度解析失败时保留确定性结构并标记 skipped", async () => {
    const { dataDir, deps, defs } = fixture();
    deps.callLlmApi = async () => ({ blocks: [{ type: "text", text: "这不是 JSON" }] });
    const text = [
      "【剧本】雾中宅邸",
      "【场景】书房",
      "【关键剧情点】发现暗门",
      "【分支】是否进入暗门",
      "【NPC】老管家",
    ].join("\n");

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
    expect(flat.keyPoints[0].title).toBe("发现暗门");
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

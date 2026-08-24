/**
 * Legacy / Shared 导入器影子对比。
 *
 * 两条路径分别写入隔离临时目录，绝不触碰 ~/.dsh/coc。
 */
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "../runner.js";
import {
  ASSET_KINDS,
  AssetStore,
  compileByPattern,
  GameSession,
  JsonFilePersistence,
  sanitizeMetaText,
} from "../../lib/core/index.js";
import { apply as legacyApply } from "../../lib/legacy-index.js";
import { createSharedToolDefs } from "../../lib/shared/tools/index.js";
import {
  commitSession,
  loadSession,
} from "../../lib/shared/tools/helpers.js";

function createPdf(lines) {
  const escaped = lines.map((line) =>
    line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  );
  const commands = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    ...escaped.flatMap((line, index) =>
      index === 0 ? [`(${line}) Tj`] : ["0 -18 Td", `(${line}) Tj`]
    ),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += String(offset).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

function mockCtx() {
  const registered = new Map();
  return {
    registered,
    ctx: {
      tools: {
        register(def) {
          registered.set(def.name, def);
        },
      },
      systemPrompt: {
        section() {},
        context() {},
      },
      skills: { register() {} },
      get() {
        return undefined;
      },
      inject() {},
    },
  };
}

function sharedFixture(dataDir, gameId) {
  const deps = {
    dataDir,
    defaultGame: gameId,
    persistence: new JsonFilePersistence(dataDir),
    assetStore: new AssetStore(join(dataDir, "assets")),
    session: new GameSession({ id: gameId }),
    stateKey: (id) => join("games", `${id}.json`),
    maxRollHistory: 200,
  };
  return { deps, defs: createSharedToolDefs(deps) };
}

function legacyFixture(dataDir, gameId) {
  const legacy = mockCtx();
  legacyApply(legacy.ctx, {
    dataDir,
    defaultGame: gameId,
    maxRollHistory: 200,
    maxChatRounds: 4,
    maxChatLog: 120,
    autoImportBuiltinRules: false,
  });
  const deps = {
    dataDir,
    defaultGame: gameId,
    persistence: new JsonFilePersistence(dataDir),
    assetStore: new AssetStore(join(dataDir, "assets")),
    session: new GameSession({ id: gameId }),
    stateKey: (id) => join("games", `${id}.json`),
    maxRollHistory: 200,
  };
  return { ...legacy, deps };
}

function finishLegacyImport(deps, args) {
  const gameId = args.game;
  const { session, flat } = loadSession(deps, gameId);
  flat.keyPoints = (flat.keyPoints ?? []).map((item) => ({
    ...item,
    desc: sanitizeMetaText(item.desc ?? item.description ?? ""),
  }));
  flat.branches = (flat.branches ?? []).map((item) => ({
    ...item,
    desc: sanitizeMetaText(item.desc ?? item.description ?? ""),
  }));
  flat.entities = (flat.entities ?? []).map((item) => ({
    ...item,
    desc: sanitizeMetaText(item.desc ?? item.description ?? ""),
    revealed: item.revealed === true,
    playerDesc: item.playerDesc ?? "",
    playerState: item.playerState ?? "",
  }));
  session.syncFromFlat(flat);

  const scenarioText = flat.scenario?.text ?? "";
  if (scenarioText.trim().length > 0) {
    const existing = deps.assetStore.findByName(
      ASSET_KINDS.SCENARIO,
      flat.scenario.name
    );
    const payload = {
      name: flat.scenario.name,
      text: scenarioText,
      summary: flat.scenario.summary ?? "",
      chars: flat.scenario.chars,
      lines: flat.scenario.lines,
      source: flat.scenario.source ?? "import",
      keyPoints: flat.keyPoints ?? [],
      branches: flat.branches ?? [],
      entities: flat.entities ?? [],
    };
    const asset =
      existing === null
        ? deps.assetStore.save(ASSET_KINDS.SCENARIO, payload)
        : deps.assetStore.update(ASSET_KINDS.SCENARIO, existing.id, payload);
    session.scenarioId = asset.id;
    const model = compileByPattern(scenarioText, flat.scenario.name ?? "剧本");
    session.importScenarioModel(model, {
      replace: true,
      activateInitial: true,
    });
  }

  if (args.kind === "characters" || args.kind === "auto") {
    for (const pc of flat.characters ?? []) {
      if (
        pc?.name &&
        deps.assetStore.findByNameLoose(
          ASSET_KINDS.INVESTIGATOR,
          pc.name
        ) === null
      ) {
        deps.assetStore.save(ASSET_KINDS.INVESTIGATOR, {
          name: pc.name,
          player: pc.player ?? "",
          occupation: pc.occupation ?? "",
          stats: pc.stats ?? {},
          hp: pc.hp ?? pc.stats?.HP ?? 0,
          san: pc.san ?? pc.stats?.SAN ?? 0,
          mp: pc.mp ?? pc.stats?.MP ?? 0,
          luck: pc.luck ?? pc.stats?.LUCK ?? 0,
          skills: pc.skills ?? {},
          inventory: pc.inventory ?? [],
          notes: pc.notes ?? "",
        });
      }
    }
  }
  commitSession(deps, gameId, session, flat);
}

function normalizeCharacter(character) {
  return {
    name: character.name ?? "",
    player: character.player ?? "",
    occupation: character.occupation ?? "",
    stats: character.stats ?? {},
    hp: character.hp ?? 0,
    san: character.san ?? 0,
    mp: character.mp ?? 0,
    luck: character.luck ?? 0,
    skills: character.skills ?? {},
    inventory: character.inventory ?? [],
    notes: character.notes ?? "",
  };
}

function normalizeFlat(flat) {
  return {
    kpMode: flat.kpMode,
    rules:
      flat.rules === null
        ? null
        : {
            name: flat.rules.name,
            summary: flat.rules.summary,
            text: flat.rules.text,
          },
    scenario:
      flat.scenario === null
        ? null
        : {
            name: flat.scenario.name,
            summary: flat.scenario.summary,
            text: flat.scenario.text,
          },
    keyPoints: (flat.keyPoints ?? []).map((item) => ({
      title: item.title,
      scene: item.scene ?? "",
      desc: item.desc ?? "",
      revealed: item.revealed === true,
    })),
    branches: (flat.branches ?? []).map((item) => ({
      title: item.title,
      scene: item.scene ?? "",
      desc: item.desc ?? "",
      options: (item.options ?? []).map((option) => ({
        label: option.label,
        leadsTo: option.leadsTo ?? "",
      })),
      reached: item.reached === true,
      chosen: item.chosen ?? null,
    })),
    entities: (flat.entities ?? []).map((item) => ({
      type: item.type,
      name: item.name,
      desc: item.desc ?? "",
      state: item.state ?? "",
      scene: item.scene ?? "",
      revealed: item.revealed === true,
      playerDesc: item.playerDesc ?? "",
      playerState: item.playerState ?? "",
    })),
    characters: (flat.characters ?? []).map(normalizeCharacter),
    currentScene: flat.currentScene ?? "",
    currentBranchId: flat.currentBranchId ?? "",
    time: flat.time ?? "",
    synopsis: flat.synopsis ?? "",
    tasks: flat.tasks ?? [],
    log: flat.log ?? [],
    reminders: flat.reminders ?? [],
    scheduledEvents: flat.scheduledEvents ?? [],
    events: flat.events ?? [],
    plot: (flat.core?.plot?.nodes ?? []).map((node) => ({
      title: node.title,
      description: node.description ?? "",
      scene: node.scene ?? "",
      status: node.status,
    })),
  };
}

function normalizeAssets(store, importedNames) {
  return {
    scenarios: store.list(ASSET_KINDS.SCENARIO).map((asset) => ({
      name: asset.name,
      summary: asset.summary ?? "",
      text: asset.text ?? "",
      keyPoints: (asset.keyPoints ?? []).map((item) => item.title),
      branches: (asset.branches ?? []).map((item) => item.title),
      entities: (asset.entities ?? []).map((item) => ({
        type: item.type,
        name: item.name,
      })),
    })),
    investigators: store
      .list(ASSET_KINDS.INVESTIGATOR)
      .filter((asset) => importedNames.has(asset.name))
      .map(normalizeCharacter),
  };
}

async function compareCase(testCase, roots) {
  const legacyGame = `${testCase.id}-legacy`;
  const sharedGame = `${testCase.id}-shared`;
  const legacy = legacyFixture(roots.legacy, legacyGame);
  const shared = sharedFixture(roots.shared, sharedGame);

  const legacyArgs = {
    ...testCase.args,
    game: legacyGame,
    ...(testCase.filePath ? { filePath: testCase.filePath } : {}),
  };
  const sharedArgs = {
    ...testCase.args,
    game: sharedGame,
    ...(testCase.filePath ? { filePath: testCase.filePath } : {}),
  };
  await legacy.registered.get("coc_import").execute(legacyArgs, {});
  finishLegacyImport(legacy.deps, legacyArgs);
  await shared.defs.get("coc_import").execute(sharedArgs, {});

  const legacyFlat = JSON.parse(
    readFileSync(join(roots.legacy, "games", `${legacyGame}.json`), "utf8")
  );
  const sharedFlat = JSON.parse(
    readFileSync(join(roots.shared, "games", `${sharedGame}.json`), "utf8")
  );
  const names = new Set((sharedFlat.characters ?? []).map((item) => item.name));
  const legacyStore = new AssetStore(join(roots.legacy, "assets"));
  const sharedStore = new AssetStore(join(roots.shared, "assets"));
  expect(normalizeFlat(sharedFlat)).toEqual(normalizeFlat(legacyFlat));
  expect(normalizeAssets(sharedStore, names)).toEqual(
    normalizeAssets(legacyStore, names)
  );
  return {
    id: testCase.id,
    keyPoints: sharedFlat.keyPoints.length,
    branches: sharedFlat.branches.length,
    entities: sharedFlat.entities.length,
    characters: sharedFlat.characters.length,
  };
}

describe("导入器影子对比", () => {
  it("5 组输入的关键存档字段与资产写入一致", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "coc-import-fixtures-"));
    const pdfPath = join(fixtureDir, "scenario.pdf");
    const txtPath = join(fixtureDir, "scenario.txt");
    writeFileSync(
      pdfPath,
      createPdf([
        "SCENE: Library",
        "KEY POINT: Hidden Door",
        "BRANCH: Enter or Leave",
        "NPC: Butler",
      ])
    );
    writeFileSync(
      txtPath,
      "【场景】码头\n【关键剧情点】发现血迹\n【分支】追踪或报警\n【地点】旧仓库",
      "utf8"
    );
    const cases = [
      {
        id: "pdf",
        filePath: pdfPath,
        args: {
          kind: "scenario",
          source: "file",
          name: "PDF 剧本",
          overwrite: true,
        },
      },
      {
        id: "txt",
        filePath: txtPath,
        args: {
          kind: "scenario",
          source: "file",
          name: "TXT 剧本",
          overwrite: true,
        },
      },
      {
        id: "scenario-text",
        args: {
          kind: "scenario",
          source: "text",
          name: "粘贴剧本",
          overwrite: true,
          text: "【场景】书房\n【NPC】老管家\n【关键剧情点】暗门\n【分支】进入或离开\n【物品】黄铜钥匙",
        },
      },
      {
        id: "character-text",
        args: {
          kind: "characters",
          source: "text",
          text: "姓名：沈岚\n职业：记者\n力量：50\n体质：55\n理智：60\n侦查：70",
        },
      },
      {
        id: "character-json",
        args: {
          kind: "characters",
          source: "text",
          text: JSON.stringify([
            {
              name: "顾川",
              occupation: "医生",
              stats: { STR: 45, CON: 60, SAN: 65 },
              skills: { "急救": 75 },
              inventory: ["急救包"],
            },
            {
              name: "周宁",
              occupation: "教授",
              stats: { INT: 80, EDU: 85, SAN: 70 },
              skills: { "图书馆使用": 70 },
            },
          ]),
        },
      },
    ];

    const previousKey = process.env.COC_API_KEY;
    process.env.COC_API_KEY = "";
    const report = [];
    try {
      for (const testCase of cases) {
        const root = mkdtempSync(join(tmpdir(), `coc-parity-${testCase.id}-`));
        report.push(
          await compareCase(testCase, {
            legacy: join(root, "legacy"),
            shared: join(root, "shared"),
          })
        );
      }
    } finally {
      if (previousKey === undefined) delete process.env.COC_API_KEY;
      else process.env.COC_API_KEY = previousKey;
    }
    console.log("  parity:", JSON.stringify(report));
    expect(report).toHaveLength(5);
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "import-parity 集成测试"));

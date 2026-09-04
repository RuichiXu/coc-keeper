/**
 * DSH-free 导入工具：coc_import / coc_read / coc_query_rule。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSET_KINDS,
  applyStructureAnalysis,
  buildStructureWindowPlan,
  buildStructureWindowPrompt,
  cleanScenarioText,
  compileByPattern,
  detectDeadEndScenes,
  ensureScenarioContract,
  extractCheckpoints,
  extractFileText,
  extractSceneFacts,
  mergeDeepParseDraft,
  mergeStructureWindowResults,
  normalizeCharacter,
  parseCharacters,
  parseStructureWindowResult,
  applyTopologySkeleton,
  repairDeepParseConnectivity,
  repairDeepParseFinalWiring,
  renderPdfPages,
  sanitizeMetaText,
} from "../../core/index.js";
import { commitSession, gameIdOf, loadSession } from "./helpers.js";
import { enrichStoryPrerequisites } from "../chat/story-prereqs.js";
import { runDeepParseGenerationLoop } from "./deep-parse-loop.js";
import { loadLlmConfig } from "../llm.js";

const sharedDir = dirname(fileURLToPath(import.meta.url));
let BUILTIN_RULES = { name: "", text: "", summary: "", chars: 0, lines: 0 };
try {
  const rulesFile = join(sharedDir, "..", "..", "rules-content.json");
  if (existsSync(rulesFile)) {
    BUILTIN_RULES = JSON.parse(readFileSync(rulesFile, "utf8"));
  }
} catch {
  // 内置规则不可用时，coc_query_rule 会返回空目录而不是让插件启动失败。
}

function summarize(content, max = 4000) {
  const text = String(content ?? "");
  return text.length > max
    ? `${text.slice(0, max)}\n……[截断，全文可用 coc_read 阅读]`
    : text;
}

function detectKind(content, requestedKind) {
  if (requestedKind !== "auto") return requestedKind;
  const head = content.slice(0, 2000);
  if (head.trimStart().startsWith("[") || head.trimStart().startsWith("{")) {
    return "characters";
  }
  if (/(调查员档案|角色卡|人物卡|INVESTIGATOR DOSSIER|CHARACTER SHEET)/i.test(head)) {
    return "characters";
  }
  if (
    /^(?:姓名|名字|名称|人物|NAME|Name)[：:\s]+/m.test(head) &&
    /(?:STR|CON|SIZ|DEX|POW|APP|EDU|LUCK|SAN|HP|MP|力量|体质|体型|敏捷|意志|外貌|教育|幸运)/i.test(head)
  ) {
    return "characters";
  }
  if (
    /(?:STR|CON|SIZ|DEX|POW|APP|EDU|LUCK|SAN|HP|MP)\s*[:：]?\s*\d{1,3}/i.test(head) &&
    /(力量|体质|体型|敏捷|意志|外貌|教育|幸运|职业|occupation)/i.test(head)
  ) {
    return "characters";
  }
  if (/(剧本|模组|场景|scenario|module|chapter|故事|剧情|npc|地点|物品|线索|秘密|调查)/i.test(head)) {
    return "scenario";
  }
  if (/NPC[：:]/.test(head)) return "scenario";
  if (/(规则书|技能表|属性表|调查员手册)/i.test(head)) return "rules";
  if (/(规则|技能|属性|调查员)/i.test(head)) return "rules";
  return "scenario";
}

function importName(args, kind, content) {
  let name =
    typeof args.name === "string" && args.name.trim().length > 0
      ? args.name.trim()
      : args.source === "file"
        ? typeof args.fileName === "string" && args.fileName.trim().length > 0
          ? args.fileName.trim()
          : args.filePath
            ? String(args.filePath).split(/[\\/]/).pop()
            : kind
        : kind;

  if (name === kind && kind === "scenario") {
    const match =
      /【剧本】\s*([^\n|｜]+)|^#+\s*(.+)$|^(?:剧本|模组)[：:]\s*(.+)$/m.exec(content);
    if (match) {
      name = (match[1] ?? match[2] ?? match[3]).trim() || kind;
    } else {
      const first = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (first !== undefined && first.length <= 40) name = first;
    }
  }
  return name;
}

function entityScenes(text) {
  const scenes = new Map();
  let currentScene = "";
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const scene =
      /^(?:【场景】|场景|SCENE)[：:\s]*(\d*)[：:\s]*(.*)$/i.exec(line);
    if (scene && (scene[1] || scene[2])) {
      currentScene = scene[2] || `场景 ${scene[1]}`;
      continue;
    }
    const location =
      /^(?:【地点】|地点|场所)[：:\s]*(\S.+)$/i.exec(line);
    if (location) scenes.set(`location:${location[1].trim()}`, currentScene);
  }
  return scenes;
}

function legacyStructure(model, scenarioName, text) {
  const sceneMap = entityScenes(text);
  const keyPoints = (model.plotNodes ?? []).map((node, index) => ({
    id: `kp-${index + 1}`,
    scene: node.scene ?? "",
    title: node.title ?? `剧情点 ${index + 1}`,
    desc: sanitizeMetaText(node.description ?? ""),
    revealed: false,
    scenarioId: scenarioName,
  }));
  const branches = (model.branches ?? []).map((branch, index) => ({
    id: branch.id ?? `br-${index + 1}`,
    scene: branch.scene ?? "",
    title: branch.title ?? `分支 ${index + 1}`,
    desc: sanitizeMetaText(branch.description ?? ""),
    options: (branch.options ?? []).map((option) => ({
      label: option.label ?? "继续",
      leadsTo: option.leadsTo ?? "",
    })),
    reached: false,
    chosen: null,
    scenarioId: scenarioName,
  }));
  const entities = [];
  for (const npc of model.npcs ?? []) {
    entities.push({
      id: `ent-${entities.length + 1}`,
      type: "npc",
      name: npc.name ?? "未命名",
      desc: sanitizeMetaText(npc.description ?? ""),
      state: "",
      scene: (npc.scenes ?? [])[0] ?? "",
      scenarioId: scenarioName,
      revealed: false,
      playerDesc: "",
      playerState: "",
    });
  }
  for (const location of model.locations ?? []) {
    entities.push({
      id: `ent-${entities.length + 1}`,
      type: "location",
      name: location.name ?? "未命名",
      desc: sanitizeMetaText(location.description ?? ""),
      state: "",
      scene: sceneMap.get(`location:${location.name ?? "未命名"}`) ?? "",
      scenarioId: scenarioName,
      revealed: false,
      playerDesc: "",
      playerState: "",
    });
  }
  for (const item of model.items ?? []) {
    entities.push({
      id: `ent-${entities.length + 1}`,
      type: "item",
      name: item.name ?? "未命名",
      desc: sanitizeMetaText(item.description ?? ""),
      state: "",
      scene: (item.locationIds ?? [])[0] ?? "",
      scenarioId: scenarioName,
      revealed: false,
      playerDesc: "",
      playerState: "",
    });
  }
  return { keyPoints, branches, entities };
}

function stampScenarioId(flat) {
  const scenarioId = flat?.scenario?.name ?? "";
  if (scenarioId.length === 0) return;
  for (const item of flat?.keyPoints ?? []) {
    if (item !== null && item !== undefined && String(item.scenarioId ?? "").length === 0) {
      item.scenarioId = scenarioId;
    }
  }
  for (const item of flat?.branches ?? []) {
    if (item !== null && item !== undefined && String(item.scenarioId ?? "").length === 0) {
      item.scenarioId = scenarioId;
    }
  }
}

function upsertScenarioAsset(deps, flat, session) {
  const text = flat.scenario?.text ?? "";
  if (text.trim().length === 0) return;
  const assets = deps.assetStore;
  const existing = assets.findByName(ASSET_KINDS.SCENARIO, flat.scenario.name);
  const payload = {
    name: flat.scenario.name,
    text,
    summary: flat.scenario.summary ?? "",
    chars: flat.scenario.chars,
    lines: flat.scenario.lines,
    source: flat.scenario.source ?? "import",
    keyPoints: flat.keyPoints ?? [],
    branches: flat.branches ?? [],
    entities: flat.entities ?? [],
    scenarioFacts: flat.scenarioFacts ?? [],
    checkpoints: flat.scenarioCheckpoints ?? [],
    scenarioContract: flat.scenarioContract ?? null,
    contractStatus: flat.scenarioContract?.status ?? "none",
    deepParse: flat.deepParse ?? null,
    deepParseStatus: flat.deepParse?.status ?? "none",
    kpNotes: flat.kpNotes ?? [],
    chapterNotes: flat.chapterNotes ?? [],
    specialRules: flat.specialRules ?? [],
    appendix: flat.appendix ?? [],
    sceneRelations: flat.sceneRelations ?? [],
    scenarioStructure: flat.scenarioStructure ?? null,
  };
  const asset =
    existing === null
      ? assets.save(ASSET_KINDS.SCENARIO, payload)
      : assets.update(ASSET_KINDS.SCENARIO, existing.id, payload);
  session.scenarioId = asset.id;

  const model = compileByPattern(text, flat.scenario.name ?? "剧本");
  session.importScenarioModel(model, { replace: true, activateInitial: true });
  session.recordTrace({
    kind: "scenario-compile",
    scenarioId: asset.id,
    plotNodes: model.plotNodes.length,
    clues: model.clues.length,
  });
}

function saveInvestigatorAssets(deps, characters) {
  for (const pc of characters) {
    if (!pc?.name) continue;
    if (
      deps.assetStore.findByNameLoose(ASSET_KINDS.INVESTIGATOR, pc.name) !==
      null
    ) {
      continue;
    }
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

function sanitizeStructure(flat) {
  flat.keyPoints = (flat.keyPoints ?? []).map((item) => ({
    ...item,
    desc: sanitizeMetaText(item.desc ?? item.description ?? ""),
    displayName: sanitizeMetaText(item.displayName ?? ""),
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
  flat.kpNotes = (flat.kpNotes ?? []).map((item) => ({
    ...item,
    title: sanitizeMetaText(item.title ?? ""),
    body: item.body ?? "",
  }));
  flat.chapterNotes = (flat.chapterNotes ?? []).map((item) => ({
    ...item,
    title: sanitizeMetaText(item.title ?? ""),
    body: item.body ?? "",
  }));
  flat.specialRules = (flat.specialRules ?? []).map((item) => ({
    ...item,
    title: sanitizeMetaText(item.title ?? ""),
    body: item.body ?? "",
  }));
  flat.appendix = (flat.appendix ?? []).map((item) => ({
    ...item,
    title: sanitizeMetaText(item.title ?? ""),
    body: item.body ?? "",
  }));
  return flat;
}

function importDef(deps) {
  const render = (_args, value) => [{
    type: "text",
    text:
      `已导入${value.kind === "rules" ? "规则" : value.kind === "scenario" ? "剧本" : "人物"}「${value.name ?? ""}」到游戏 ${value.game}（${value.chars} 字符 / ${value.lines} 行）` +
      (value.characters > 0 ? `，人物 ${value.characters} 个` : "") +
      (value.keyPoints > 0 ? `，草拟关键剧情点 ${value.keyPoints} 个` : "") +
      (value.branches > 0 ? `，草拟分支 ${value.branches} 个` : "") +
      (value.entities > 0 ? `，草拟实体 ${value.entities} 个（NPC/地点/物品）` : "") +
      (value.checkpoints > 0 ? `，提取显式检定点 ${value.checkpoints} 个` : "") +
      (value.sceneFacts > 0 ? `，场景事实卡 ${value.sceneFacts} 段` : "") +
      (value.contractSource !== "none" ? `，剧本执行契约 ${value.contractSource}/${value.contractStatus ?? "draft"}` : "") +
      (value.deepParseStatus !== undefined && value.deepParseStatus !== "none" ? `，深度剧情解析 ${value.deepParseStatus}` : "") +
      `\n预览：${value.preview}`,
  }];
  return {
    name: "coc_import",
    description: "导入克苏鲁的呼唤跑团内容到游戏状态：规则书、剧本（模组）或人物卡。支持 PDF 文件（自动提取文本）、TXT/MD 文本文件，或直接粘贴文本。人物导入支持 JSON 数组或「姓名：xxx / 职业：xxx / 力量：50」式文本。剧本可自动草拟关键剧情点与分支结构供 KP 校对。导入后可用 coc_read 阅读全文、coc_status 查看状态。",
    parameters: {
      kind: { type: "string", enum: ["auto", "rules", "scenario", "characters"], required: true, description: "导入内容类型；auto 自动识别" },
      source: { type: "string", enum: ["file", "text"], required: true, description: "来源：file 表示文件路径，text 表示直接粘贴文本" },
      filePath: { type: "string", description: "source=file 时的文件路径（PDF/TXT/MD/JSON）" },
      text: { type: "string", description: "source=text 时的内容" },
      name: { type: "string", description: "规则/剧本名称（缺省用文件名或自动命名）" },
      game: { type: "string", description: "游戏 ID（缺省使用默认游戏）" },
      parseStructure: { type: "boolean", description: "剧本导入时是否自动草拟关键剧情点与分支（默认 true）" },
      overwrite: { type: "boolean", description: "剧本/规则是否覆盖旧内容，人物是否按同名覆盖（默认 false 追加）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          game: { type: "string" },
          name: { type: "string" },
          chars: { type: "integer" },
          lines: { type: "integer" },
          characters: { type: "integer" },
          keyPoints: { type: "integer" },
          branches: { type: "integer" },
          entities: { type: "integer" },
          checkpoints: { type: "integer" },
          sceneFacts: { type: "integer" },
          contractSource: { type: "string" },
          contractStatus: { type: "string" },
          deepParseStatus: { type: "string" },
          preview: { type: "string" },
        },
      },
      render,
    },
    render,
    timeoutMs: 1800000,
    async execute(args, execCtx = {}) {
      const gameId = gameIdOf(args, deps.defaultGame);
      const { session, flat } = loadSession(deps, gameId);
      const onProgress =
        typeof execCtx.onProgress === "function" ? execCtx.onProgress : null;
      const content =
        args.source === "file"
          ? await extractFileText(String(args.filePath ?? ""), onProgress)
          : String(args.text ?? "");
      if (content.trim().length === 0) throw new Error("导入内容为空");

      const kind = detectKind(content, args.kind);
      const chars = content.length;
      const lines = content.split(/\r?\n/).length;
      let name = importName(args, kind, content);
      let characters = 0;
      let keyPoints = 0;
      let branches = 0;
      let entities = 0;
      let contractSource = "none";
      let deepParseStatus = "none";
      let deepParseAddedKeyPoints = 0;
      let deepParseAddedBranches = 0;
      const preview = summarize(content, 200);
      const pdfFilePath =
        args.source === "file" && String(args.filePath ?? "").toLowerCase().endsWith(".pdf")
          ? String(args.filePath ?? "")
          : "";

      if (kind === "rules") {
        if (args.overwrite === true || flat.rules === null) {
          flat.rules = {
            name,
            source: args.source,
            text: content,
            summary: summarize(content),
            chars,
            lines,
          };
        } else {
          flat.rules.text += `\n\n${content}`;
          flat.rules.chars += chars;
          flat.rules.lines += lines;
          flat.rules.summary = summarize(flat.rules.text);
        }
      } else if (kind === "scenario") {
        onProgress?.("parsing", "解析剧本结构（关键剧情点/分支/实体）…", 70);
        const structure = legacyStructure(
          compileByPattern(content, name),
          name,
          content
        );
        if (args.overwrite === true || flat.scenario === null) {
          flat.scenario = {
            name,
            source: args.source,
            text: content,
            summary: summarize(content),
            chars,
            lines,
          };
          if (args.overwrite === true) {
            // 覆盖导入：清空旧剧本派生的剧情结构，避免旧剧本的最终分支/结局
            // 关键点（尤其 scenarioId 为空或旧剧本名的 deep-parse 节点）残留。
            // entities 只保留无 scenarioId 的场次手工实体（coc_entity 创建）。
            flat.keyPoints = [];
            flat.branches = [];
            flat.entities = (flat.entities ?? []).filter((item) => String(item.scenarioId ?? "").length === 0);
            flat.deepParse = null;
            flat.scenarioContract = null;
            flat.scenarioStructure = null;
            flat.scenarioFacts = [];
            flat.scenarioCheckpoints = [];
            flat.kpNotes = [];
            flat.chapterNotes = [];
            flat.specialRules = [];
            flat.appendix = [];
            flat.sceneRelations = [];
          }
        } else {
          flat.scenario.text += `\n\n${content}`;
          flat.scenario.chars += chars;
          flat.scenario.lines += lines;
          flat.scenario.summary = summarize(flat.scenario.text);
        }
        // 场景事实卡与显式检定点：确定性规则从全文提取（每次导入重算，避免脏数据）。
        if (args.parseStructure === false) {
          flat.scenarioFacts = extractSceneFacts(flat.scenario.text);
          flat.scenarioCheckpoints = extractCheckpoints(flat.scenario.text);
        } else {
          // 结构分析管线（窗口分片）：按行号窗口让 LLM 只输出局部 sections，
          // 再确定性合并/建树/切片路由。失败直接报错，不落确定性切分。
          if (typeof deps.callLlmApi !== "function") {
            throw new Error("剧本结构分析失败：未配置 LLM API。请先在设置面板配置 API Key，再重新导入。");
          }
          {
            const doc = cleanScenarioText(flat.scenario.text);
            const windows = buildStructureWindowPlan(doc, { maxLines: 200 });
            const windowResults = [];
            const concurrency = 2;
            for (let start = 0; start < windows.length; start += concurrency) {
              const batch = windows.slice(start, start + concurrency);
              const batchResults = await Promise.all(
                batch.map(async (window) => {
                  const prompt = buildStructureWindowPrompt(doc, window, flat.scenario.name);
                  let parsed = { format: "mixed", sections: [] };
                  let lastError = null;
                  const tokenBudgets = [24000, 32000];
                  for (let attempt = 1; attempt <= 2; attempt += 1) {
                    try {
                      const llmResult = await Promise.race([
                        deps.callLlmApi(
                          deps.dataDir,
                          [{ role: "user", content: [{ type: "text", text: prompt }] }],
                          { temperature: 0, max_tokens: tokenBudgets[attempt - 1] ?? 24000, reasoningEffort: "low" }
                        ),
                        new Promise((_, reject) => setTimeout(() => reject(new Error(`结构分析窗口 ${window.index + 1}/${window.total} 超时（300s）`)), 300000)),
                      ]);
                      const rawText = (llmResult.blocks ?? [])
                        .filter((block) => block?.type === "text")
                        .map((block) => block.text ?? "")
                        .join("");
                      parsed = parseStructureWindowResult(rawText, doc, window);
                      if (parsed.sections.length > 0) break;
                      lastError = new Error("LLM 输出为空");
                    } catch (error) {
                      lastError = error;
                    }
                    if (attempt < 2) {
                      onProgress?.("parsing", `结构分析窗口 ${window.index + 1}/${window.total} 第 ${attempt} 次失败（${String(lastError?.message ?? "输出为空")}），重试…`, 62);
                    }
                  }
                  if (parsed.sections.length === 0) {
                    throw new Error(`结构分析失败：窗口 ${window.index + 1}/${window.total} 两次尝试均失败（${String(lastError?.message ?? "输出为空")}）），已中止导入（不落确定性切分）`);
                  }
                  return { format: parsed.format, sections: parsed.sections, _windowIndex: window.index };
                })
              );
              windowResults.push(...batchResults);
              onProgress?.("parsing", `结构分析窗口 ${Math.min(start + concurrency, windows.length)}/${windows.length}`, 60 + Math.round((Math.min(start + concurrency, windows.length) / windows.length) * 12));
            }
            const result = mergeStructureWindowResults(doc, windowResults);
            if (result.sections.length === 0) {
              throw new Error("剧本结构分析失败：所有窗口的 LLM 输出都无法解析。请重试导入。");
            }
            applyStructureAnalysis(flat, doc, result);
            stampScenarioId(flat);
            onProgress?.("parsing", `结构分析完成：${result.sections.length} 个 section`, 72);
          }
          flat.entities.push(...structure.entities);
        }
        // 执行契约：确定性草拟先落底；LLM 可用时覆盖为 AI 草拟（status=draft，KP 校对确认后生效）。
        flat.scenarioContract = ensureScenarioContract(null, flat);
        flat.scenarioContract.status = "draft";
        flat.scenarioContract.source = "deterministic";
        flat.scenarioContract.reviewed = false;
        contractSource = "deterministic";
        // 执行契约保持确定性草拟：LLM 契约生成耗时且经常为空，价值有限，
        // 按「规则/状态确定性」原则不调用 LLM，导入后 KP 可直接在面板校对。
        keyPoints = (flat.keyPoints ?? []).length;
        branches = (flat.branches ?? []).length;
        entities = (flat.entities ?? []).length;
      } else if (kind === "characters") {
        const normalized = parseCharacters(content).map((raw, index) =>
          normalizeCharacter(raw, index)
        );
        for (const pc of normalized) {
          const existing = flat.characters.find((item) => item.name === pc.name);
          if (existing !== undefined && args.overwrite === true) {
            flat.characters[flat.characters.indexOf(existing)] = {
              ...existing,
              ...pc,
              id: existing.id,
            };
          } else if (existing === undefined) {
            flat.characters.push(pc);
          }
        }
        characters = normalized.length;
        name = name === "characters" ? "人物卡" : name;
      }

      sanitizeStructure(flat);
      if (kind === "scenario") {
        // 结构化剧情前置条件：从检定点/关键点/分支草拟 requires（B-3）。
        // 这是确定性兜底；LLM 深度解析成功时只存草稿，运行时替换在 D-4 完成。
        enrichStoryPrerequisites(flat);

        // D-2：LLM 深度剧情解析——确定性骨架 + 分块生成 + 最终分支/结局 + 3 轮取最优。
        if (typeof deps.callLlmApi === "function") {
          onProgress?.("parsing", "LLM 生成深度剧情解析…", 85);
          try {
            let loopOptions = {};
            try {
              loopOptions = loadLlmConfig(deps.dataDir)?.deepParse ?? {};
            } catch {
              loopOptions = {};
            }
            const loop = await runDeepParseGenerationLoop(flat, deps, onProgress, loopOptions);
            if (loop.deepParse !== null) {
              const merged = mergeDeepParseDraft(flat, loop.deepParse);
              stampScenarioId(flat);
              flat.deepParse = {
                status: loop.status,
                source: "llm",
                reviewed: false,
                generatedAt: new Date().toISOString(),
                quality: loop.quality,
                ...merged.deepParse,
              };
              repairDeepParseFinalWiring(flat);
              applyTopologySkeleton(flat, flat.deepParse);
              repairDeepParseConnectivity(flat);
              deepParseStatus = loop.status;
              deepParseAddedKeyPoints = merged.keyPointsAdded;
              deepParseAddedBranches = merged.branchesAdded;
              if (merged.keyPointsAdded > 0 || merged.branchesAdded > 0) {
                // 新节点也过一遍确定性兜底：能草拟出条件的就补上，不能的保持无结构化条件。
                sanitizeStructure(flat);
                enrichStoryPrerequisites(flat);
              }
            } else {
              flat.deepParse = {
                status: loop.status,
                source: "none",
                reviewed: false,
                generatedAt: new Date().toISOString(),
                issues: loop.quality?.issues ?? ["LLM 深度解析不可用"],
              };
              deepParseStatus = loop.status;
            }
          } catch (error) {
            flat.deepParse = {
              status: "skipped",
              source: "none",
              reviewed: false,
              generatedAt: new Date().toISOString(),
              issues: [String(error?.message ?? "LLM 深度解析不可用")],
            };
            deepParseStatus = "skipped";
          }
        }
        if (flat.deepParse !== null && flat.deepParse !== undefined) {
          // 引擎规则 3：确定性扫描“没有出口分支的场景”，作为导入后的 KP 提示。
          flat.deepParse.graphIssues = detectDeadEndScenes(
            { keyPoints: flat.keyPoints ?? [], branches: flat.branches ?? [] },
            flat.deepParse
          );
        }
        keyPoints += deepParseAddedKeyPoints;
        branches += deepParseAddedBranches;
      }

      session.syncFromFlat(flat);
      if (kind === "scenario") {
        upsertScenarioAsset(deps, flat, session);
        if (pdfFilePath.length > 0 && deps.assetStore?.rootDir !== undefined) {
          // PDF 页面图片资产 v1：渲染失败不阻断导入。
          try {
            const pagesDir = join(deps.assetStore.rootDir, ASSET_KINDS.SCENARIO, String(session.scenarioId ?? ""), "pages");
            const pdfPages = await renderPdfPages(pdfFilePath, pagesDir, typeof onProgress === "function" ? onProgress : undefined, 1.5);
            flat.scenario.pdfPages = pdfPages.filter((page) => page.file.length > 0);
            if (flat.scenarioStructure !== null && flat.scenarioStructure !== undefined) {
              flat.scenarioStructure.pdfPages = flat.scenario.pdfPages;
            }
            deps.assetStore.update(ASSET_KINDS.SCENARIO, String(session.scenarioId ?? ""), { pdfPages: flat.scenario.pdfPages });
            onProgress?.("pages", "PDF 页图已生成 " + flat.scenario.pdfPages.length + "/" + pdfPages.length + " 页", 95);
          } catch (error) {
            onProgress?.("pages", "PDF 页图生成跳过：" + String(error?.message ?? error), 95);
          }
        }
      }
      if (kind === "characters") {
        saveInvestigatorAssets(deps, flat.characters ?? []);
      }

      onProgress?.("saving", "保存数据中…", 90);
      commitSession(deps, gameId, session, flat);
      onProgress?.("done", "导入完成", 100);
      return {
        kind,
        game: flat.id,
        name,
        chars,
        lines,
        characters,
        keyPoints,
        branches,
        entities,
        contractSource,
        contractStatus: kind === "scenario" ? (flat.scenarioContract?.status ?? "none") : "none",
        deepParseStatus: kind === "scenario" ? deepParseStatus : "none",
        checkpoints: kind === "scenario" ? (flat.scenarioCheckpoints ?? []).length : 0,
        sceneFacts: kind === "scenario" ? (flat.scenarioFacts ?? []).length : 0,
        preview,
      };
    },
  };
}

function readDef(deps) {
  const render = (_args, value) => [{
    type: "text",
    text: `[${value.what === "rules" ? "规则" : "剧本"}「${value.name}」 第 ${value.offset + 1}-${value.end} 字符 / 共 ${value.totalChars}]\n${value.text}`,
  }];
  return {
    name: "coc_read",
    description: "分段阅读已导入的规则书或剧本全文（coc_import 只存摘要，需要细节时用本工具）。返回指定偏移的一段文本，配合 offset/limit 顺序阅读。",
    parameters: {
      what: { type: "string", enum: ["rules", "scenario"], required: true, description: "读取规则还是剧本" },
      game: { type: "string", description: "游戏 ID" },
      offset: { type: "integer", description: "起始字符偏移（默认 0）" },
      limit: { type: "integer", description: "本次返回的最大字符数（默认 4000，最大 20000）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          what: { type: "string" },
          name: { type: "string" },
          totalChars: { type: "integer" },
          offset: { type: "integer" },
          end: { type: "integer" },
          text: { type: "string" },
        },
      },
      render,
    },
    render,
    execute(args) {
      const gameId = gameIdOf(args, deps.defaultGame);
      const { flat } = loadSession(deps, gameId);
      const doc = args.what === "rules" ? flat.rules : flat.scenario;
      if (doc === null || doc === undefined) {
        throw new Error(
          `尚未导入${args.what === "rules" ? "规则" : "剧本"}（请先调用 coc_import）`
        );
      }
      const totalChars = doc.text.length;
      const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)));
      const limit = Math.min(
        20000,
        Math.max(1, Math.floor(Number(args.limit ?? 4000)))
      );
      const end = Math.min(totalChars, offset + limit);
      return {
        what: args.what,
        name: doc.name,
        totalChars,
        offset,
        end,
        text: doc.text.slice(offset, end),
      };
    },
  };
}

function queryRuleDef(deps) {
  const render = (_args, value) => [{
    type: "text",
    text: `【规则查询：${value.topic}】\n${value.text}`,
  }];
  return {
    name: "coc_query_rule",
    description: "查询 CoC 7e 规则详情。当你需要了解某个具体规则的数值、判定方式或流程时调用此工具，而不是凭记忆自行编造。支持按主题查询（技能、战斗、理智、属性、职业、装备、治疗等）。",
    parameters: {
      game: { type: "string", description: "游戏 ID" },
      topic: { type: "string", required: true, description: "查询主题，如「技能列表」「理智损失」「战斗规则」「伤害加值」「职业模板」「急救」「克苏鲁神话」" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          text: { type: "string" },
          source: { type: "string" },
        },
      },
      render,
      presentCall: () => ({
        card: "generic",
        title: "规则查询",
        kind: "查询",
        rawInput: "",
      }),
    },
    render,
    execute(args) {
      const gameId = gameIdOf(args, deps.defaultGame);
      const { flat } = loadSession(deps, gameId);
      const rulesText = flat.rules?.text || BUILTIN_RULES.text || "";
      const topic = String(args.topic ?? "").trim().toLowerCase();
      const sections = [];
      let currentSection = "";
      let currentHeading = "";
      for (const line of rulesText.split("\n")) {
        if (line.startsWith("## ") || line.startsWith("### ")) {
          if (currentSection.length > 0) {
            sections.push({
              heading: currentHeading,
              text: currentSection.trim(),
            });
          }
          currentHeading = line.replace(/^###?\s+/, "").trim();
          currentSection = line + "\n";
        } else {
          currentSection += line + "\n";
        }
      }
      if (currentSection.length > 0) {
        sections.push({ heading: currentHeading, text: currentSection.trim() });
      }
      const keywords = topic
        .split(/[\s,，、]+/)
        .filter((keyword) => keyword.length > 0);
      const matched = sections.filter((section) => {
        const lower = `${section.heading} ${section.text}`.toLowerCase();
        return keywords.some(
          (keyword) => keyword.length >= 2 && lower.includes(keyword)
        );
      });
      if (matched.length === 0) {
        const headings = sections
          .map((section) => `- ${section.heading}`)
          .join("\n");
        return {
          topic: args.topic,
          text: `未找到「${args.topic}」的精确匹配。以下为规则目录，请选择具体主题重新查询：\n\n${headings}`,
          source: flat.rules?.name || "内置规则",
        };
      }
      const result = matched.map((section) => section.text).join("\n\n---\n\n");
      return {
        topic: args.topic,
        text:
          result.length > 3000
            ? result.slice(0, 3000) +
              "\n\n…（结果过长已截断，请缩小查询范围）"
            : result,
        source: flat.rules?.name || "内置规则",
      };
    },
  };
}

export function createImportToolDefs(deps) {
  return [importDef(deps), readDef(deps), queryRuleDef(deps)];
}

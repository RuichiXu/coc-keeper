/**
 * 宿主 HTTP API（/coc-api）
 *
 * Step 4：从 legacy-index.js 迁移而来，契约不变。
 * 内部使用 adapter 新工具 defs（Core → Event → State）+ persistence。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_KINDS, KNOWLEDGE_LAYERS, buildKnowledgeView, compileByPattern, extractStoryIntro, sanitizeMetaText } from "../../core/index.js";
import { loadSession, commitSession, nowIso } from "../tools/helpers.js";
import { callLlmApi, createChatBridge } from "../chat/chat-bridge.js";

const __dirname_api = dirname(fileURLToPath(import.meta.url));

// ── 内置规则（供 import-builtin-rules） ───────────────────
let BUILTIN_RULES = { name: "", text: "", summary: "", chars: 0, lines: 0 };
try {
  const rulesJsonPath = join(__dirname_api, "..", "..", "rules-content.json");
  if (existsSync(rulesJsonPath)) BUILTIN_RULES = JSON.parse(readFileSync(rulesJsonPath, "utf8"));
} catch { /* ignore */ }

// ── HTTP 辅助 ─────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 50e6) {
        req.destroy();
        resolve({});
      }
    });
    req.on("end", () => {
      if (data.length === 0) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendSSEProgress(res, phase, message, percent) {
  if (res.writableEnded) return;
  res.write("event: progress\ndata: " + JSON.stringify({ phase, message, percent }) + "\n\n");
}

function sendSSEResult(res, ok, payload) {
  if (res.writableEnded) return;
  res.write("event: result\ndata: " + JSON.stringify({ ok, ...payload }) + "\n\n");
  res.end();
}

async function callCocTool(res, def, args) {
  try {
    const data = await def.execute(args, {});
    const rendered = def.output.render(args, data);
    const text = Array.isArray(rendered) && rendered[0]?.text !== undefined ? rendered[0].text : "";
    sendJson(res, 200, { ok: true, data, render: text });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// ── 路由处理 ──────────────────────────────────────────────

async function handleCocApi(req, res, deps) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    if (req.method === "GET") {
      const params = url.searchParams;
      const gameId = params.get("game")?.trim() || deps.defaultGame;
      const key = deps.stateKey(gameId);
      if (path === "/coc-api" || path === "/coc-api/status") {
        const existing = deps.persistence.load(key);
        if (existing === null) {
          return sendJson(res, 200, {
            ok: true,
            data: null,
            render: "尚未创建游戏数据。可在对话中让 AI 导入规则/剧本/人物，或直接在面板上掷骰/登记分支（会自动创建游戏）。",
          });
        }
        return await callCocTool(res, deps.toolDefs.get("coc_status"), { game: gameId, view: "all", includeSecretRolls: true });
      }
      if (path === "/coc-api/state") {
        const existing = deps.persistence.load(key);
        if (existing === null) return sendJson(res, 200, { ok: true, data: null, entries: [], seq: 0 });
        const after = Math.max(0, Number(params.get("after")) || 0);
        const digest = stateDigestOf(existing);
        return sendJson(res, 200, { ok: true, data: digest, entries: existing.log.slice(after), seq: existing.log.length });
      }
      if (path === "/coc-api/games") {
        return sendJson(res, 200, { ok: true, data: listGames(deps) });
      }
      if (path === "/coc-api/player-view") {
        const existing = deps.persistence.load(key);
        if (existing === null) return sendJson(res, 200, { ok: true, data: null });
        const view = buildKnowledgeView(existing, KNOWLEDGE_LAYERS.PLAYER);
        const after = Math.max(0, Number(params.get("after")) || 0);
        const limit = Math.min(100, Number(params.get("limit")) || 20);
        const log = (existing.log ?? []).slice(after, after + limit);
        const knownClues = existing.core?.world?.discoveredClues ?? existing.discoveredClues ?? [];
        return sendJson(res, 200, {
          ok: true,
          data: {
            game: existing.id,
            title: existing.title,
            kpMode: existing.kpMode,
            currentScene: view.currentScene,
            time: existing.time,
            characters: existing.characters,
            entities: view.entities,
            knownClues,
            keyPoints: view.keyPoints,
            log,
            logLength: (existing.log ?? []).length,
            logHasMore: after + log.length < (existing.log ?? []).length,
            recentRolls: view.recentRolls,
            tasks: existing.tasks,
          },
        });
      }
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (path === "/coc-api/roll") {
        const { secret, ...rest } = body;
        return await callCocTool(res, secret === true || secret === "true" ? deps.toolDefs.get("coc_roll_secret") : deps.toolDefs.get("coc_roll"), rest);
      }
      if (path === "/coc-api/branch") return await callCocTool(res, deps.toolDefs.get("coc_branch"), body);
      if (path === "/coc-api/remind") return await callCocTool(res, deps.toolDefs.get("coc_remind"), body);
      if (path === "/coc-api/kp") return await callCocTool(res, deps.toolDefs.get("coc_kp"), body);
      if (path === "/coc-api/status") return await callCocTool(res, deps.toolDefs.get("coc_status"), { ...body, view: "all", includeSecretRolls: true });
      if (path === "/coc-api/read") return await callCocTool(res, deps.toolDefs.get("coc_read"), body);
      if (path === "/coc-api/tool") {
        const def = deps.toolDefs.get(body.name);
        if (def === undefined) return sendJson(res, 400, { ok: false, error: `未知工具 ${body.name}` });
        return await callCocTool(res, def, body.args ?? {});
      }
      if (path === "/coc-api/import") {
        const gameId = body.game?.trim() || deps.defaultGame;
        const importArgs = { kind: body.kind ?? "auto", game: gameId };
        if (body.name !== undefined) importArgs.name = body.name;
        if (body.fileName !== undefined) importArgs.fileName = body.fileName;
        if (body.parseStructure !== undefined) importArgs.parseStructure = body.parseStructure;
        if (body.overwrite !== undefined) importArgs.overwrite = body.overwrite;

        const wantsSSE = body.stream === true || req.headers.accept?.includes("text/event-stream");
        const importDef = deps.toolDefs.get("coc_import");
        const executeImport = async (onProgress) => {
          if (typeof body.fileBase64 === "string" && body.fileBase64.length > 0) {
            const fileName = String(body.fileName ?? "import.pdf");
            const tmpDir = join(deps.dataDir, "tmp");
            mkdirSync(tmpDir, { recursive: true });
            const tmpPath = join(tmpDir, `import-${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
            writeFileSync(tmpPath, Buffer.from(body.fileBase64, "base64"));
            try {
              return await importDef.execute({ ...importArgs, source: "file", filePath: tmpPath }, { onProgress });
            } finally {
              try { unlinkSync(tmpPath); } catch { /* ignore */ }
            }
          }
          if (typeof body.source === "string" && body.source === "file" && typeof body.filePath === "string" && body.filePath.length > 0) {
            return await importDef.execute({ ...importArgs, source: "file", filePath: body.filePath }, { onProgress });
          }
          return await importDef.execute({ ...importArgs, source: "text", text: String(body.text ?? "") }, { onProgress });
        };

        if (wantsSSE) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          res.write("event: start\ndata: {}\n\n");
          const onProgress = (phase, message, percent) => {
            try {
              sendSSEProgress(res, phase, message, percent);
            } catch (e) {
              console.error("[coc_import] onProgress 异常:", e.message);
            }
          };
          onProgress("init", "开始导入处理…", 5);
          try {
            const result = await executeImport(onProgress);
            const rendered = importDef.output.render(body, result);
            const text = rendered[0]?.text ?? "导入完成";
            sendSSEResult(res, true, { data: result, render: text });
          } catch (error) {
            sendSSEResult(res, false, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        const result = await executeImport();
        const rendered = importDef.output.render(body, result);
        sendJson(res, 200, { ok: true, data: result, render: rendered[0]?.text ?? "导入完成" });
        return;
      }
      if (path === "/coc-api/clear-scenario") {
        const gameId = body.game?.trim() || deps.defaultGame;
        const key = deps.stateKey(gameId);
        let flat = deps.persistence.load(key);
        if (flat === null) return sendJson(res, 400, { ok: false, error: "游戏数据不存在" });
        flat.scenario = null;
        flat.keyPoints = [];
        flat.branches = [];
        flat.entities = [];
        syncAndSave(deps, gameId, flat);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === "/coc-api/clear-rules") {
        const gameId = body.game?.trim() || deps.defaultGame;
        const key = deps.stateKey(gameId);
        let flat = deps.persistence.load(key);
        if (flat === null) return sendJson(res, 400, { ok: false, error: "游戏数据不存在" });
        flat.rules = null;
        syncAndSave(deps, gameId, flat);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === "/coc-api/config") {
        const configFile = join(deps.dataDir, "config.json");
        if (body.action === "get") {
          let cfg = {};
          try {
            if (existsSync(configFile)) cfg = JSON.parse(readFileSync(configFile, "utf8"));
          } catch { /* ignore */ }
          return sendJson(res, 200, { ok: true, data: cfg });
        }
        if (body.action === "set") {
          const cfg = {
            llmProvider: String(body.llmProvider ?? "").trim(),
            llmModel: String(body.llmModel ?? "").trim(),
            apiKey: String(body.apiKey ?? "").trim(),
            apiBaseUrl: String(body.apiBaseUrl ?? "").trim(),
          };
          try {
            mkdirSync(deps.dataDir, { recursive: true });
            writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf8");
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: "保存配置失败: " + (e.message || e) });
          }
          return sendJson(res, 200, { ok: true, data: cfg });
        }
        return sendJson(res, 400, { ok: false, error: "未知 action" });
      }
      if (path === "/coc-api/import-builtin-rules") {
        const gameId = body.game?.trim() || deps.defaultGame;
        try {
          const key = deps.stateKey(gameId);
          let flat = deps.persistence.load(key);
          if (flat === null) {
            flat = { id: gameId, title: gameId, updatedAt: nowIso(), kpMode: "ai", rules: null, scenario: null, characters: [], keyPoints: [], branches: [], currentScene: "", currentBranchId: "", time: "", synopsis: "", tasks: [], entities: [], log: [], toolTrace: [], rollHistory: [], reminders: [], events: [] };
          }
          flat.rules = {
            name: BUILTIN_RULES.name,
            source: "builtin",
            text: BUILTIN_RULES.text,
            summary: BUILTIN_RULES.summary,
            chars: BUILTIN_RULES.chars,
            lines: BUILTIN_RULES.lines,
          };
          syncAndSave(deps, gameId, flat);
          sendJson(res, 200, { ok: true, data: { name: BUILTIN_RULES.name, chars: BUILTIN_RULES.chars } });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: "导入失败: " + (e.message || e) });
        }
        return;
      }
      if (path === "/coc-api/test-llm") {
        try {
          const result = await callLlmApi(deps.dataDir, [
            { role: "user", content: [{ type: "text", text: "回复一句简短的话：你好！" }] },
          ], { temperature: 0.1, max_tokens: 100 });
          const text = result.blocks?.[0]?.text || "";
          sendJson(res, 200, { ok: true, data: "连接成功！响应：" + text.slice(0, 100) });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: "连接失败: " + (e.message || e) });
        }
        return;
      }
      if (path === "/coc-api/game-create") {
        const gameId = String(body.game ?? "").trim();
        if (gameId.length === 0) return sendJson(res, 400, { ok: false, error: "游戏 ID 不能为空" });
        const key = deps.stateKey(gameId);
        if (deps.persistence.load(key) !== null) return sendJson(res, 400, { ok: false, error: "游戏已存在" });
        const flat = emptyFlat(gameId);
        flat.updatedAt = nowIso();
        deps.persistence.save(key, flat);
        return sendJson(res, 200, { ok: true, data: { id: flat.id, title: flat.title } });
      }
      if (path === "/coc-api/game-setup") {
        const gameId = String(body.game ?? "").trim();
        if (gameId.length === 0) return sendJson(res, 400, { ok: false, error: "游戏 ID 不能为空" });
        const key = deps.stateKey(gameId);
        if (deps.persistence.load(key) !== null) return sendJson(res, 400, { ok: false, error: "游戏已存在" });
        const flat = emptyFlat(gameId);
        flat.updatedAt = nowIso();
        const setup = { scenario: null, scenarioId: null, characters: [], keyPoints: 0, branches: 0, entities: 0 };

        // 1) 剧本：加载资产并草拟剧情结构
        const scenarioId = String(body.scenarioId ?? "").trim();
        if (scenarioId.length > 0) {
          const asset = deps.assetStore.load(ASSET_KINDS.SCENARIO, scenarioId);
          if (asset === null) return sendJson(res, 404, { ok: false, error: "剧本资产不存在：" + scenarioId });
          flat.scenario = {
            name: asset.name,
            text: asset.text ?? "",
            summary: asset.summary ?? "",
            chars: asset.chars ?? String(asset.text ?? "").length,
            lines: asset.lines ?? 0,
            source: "asset",
          };
          flat.scenarioId = scenarioId;
          setup.scenario = { id: scenarioId, name: asset.name };
          setup.scenarioId = scenarioId;
          try {
            let model = null;
            // 导入时已由「确定性 + LLM」解析过结构并存入资产，优先复用；否则现场编译
            const cached = Array.isArray(asset.keyPoints) || Array.isArray(asset.branches) || Array.isArray(asset.entities);
            if (cached) {
              model = {
                plotNodes: (asset.keyPoints ?? []).map((kp) => ({ id: kp.id, title: kp.title ?? kp.name ?? "剧情点", scene: kp.scene ?? "", description: kp.desc ?? kp.description ?? "" })),
                branches: (asset.branches ?? []).map((b) => ({ id: b.id, title: b.title ?? b.name ?? "分支", scene: b.scene ?? "", description: b.desc ?? b.description ?? "", options: b.options ?? [] })),
                npcs: (asset.entities ?? []).filter((e) => e.type === "npc").map((e) => ({ id: e.id, name: e.name, description: e.desc ?? "", scenes: e.scene ? [e.scene] : [] })),
                locations: (asset.entities ?? []).filter((e) => e.type === "location").map((e) => ({ id: e.id, name: e.name, description: e.desc ?? "" })),
                items: (asset.entities ?? []).filter((e) => e.type === "item" || e.type === "other").map((e) => ({ id: e.id, name: e.name, description: e.desc ?? "", locationIds: e.scene ? [e.scene] : [] })),
              };
            } else {
              model = compileByPattern(asset.text ?? "", asset.name);
            }
            // ScenarioModel → flat 兼容结构（剧情页/实体页读取 flat 字段）
            flat.keyPoints = (model.plotNodes ?? []).map((pn, i) => ({
              id: pn.id ?? `kp-${i + 1}`,
              title: pn.title ?? `剧情点 ${i + 1}`,
              scene: pn.scene ?? "",
              desc: pn.description ?? "",
              revealed: false,
              scenarioId: asset.name,
            }));
            flat.branches = (model.branches ?? []).map((b, i) => ({
              id: b.id ?? `br-${i + 1}`,
              title: b.title ?? `分支 ${i + 1}`,
              scene: b.scene ?? "",
              desc: b.description ?? "",
              options: (b.options ?? []).map((o) => ({ label: o.label ?? "", leadsTo: o.leadsTo ?? "" })),
              scenarioId: asset.name,
            }));
            const entities = [];
            for (const npc of (model.npcs ?? [])) {
              entities.push({ id: npc.id ?? `ent-${entities.length + 1}`, name: npc.name ?? "未命名NPC", type: "npc", desc: sanitizeMetaText(npc.description ?? ""), scene: (npc.scenes ?? [])[0] ?? "", scenarioId: asset.name, revealed: false, playerDesc: "", playerState: "" });
            }
            for (const loc of (model.locations ?? [])) {
              entities.push({ id: loc.id ?? `ent-${entities.length + 1}`, name: loc.name ?? "未命名地点", type: "location", desc: sanitizeMetaText(loc.description ?? ""), scene: "", scenarioId: asset.name, revealed: false, playerDesc: "", playerState: "" });
            }
            for (const item of (model.items ?? [])) {
              entities.push({ id: item.id ?? `ent-${entities.length + 1}`, name: item.name ?? "未命名物品", type: "item", desc: sanitizeMetaText(item.description ?? ""), scene: (item.locationIds ?? [])[0] ?? "", scenarioId: asset.name, revealed: false, playerDesc: "", playerState: "" });
            }
            flat.entities = entities;
            setup.keyPoints = flat.keyPoints.length;
            setup.branches = flat.branches.length;
            setup.entities = flat.entities.length;
          } catch (e) {
            console.error("[coc-api/game-setup] 剧本结构草拟失败:", e.message);
          }
        }

        // 2) 调查员卡：从资产库 copy-on-write 实例化
        const characterIds = Array.isArray(body.characterAssetIds) ? body.characterAssetIds : [];
        for (const idOrName of characterIds) {
          const asset = deps.assetStore.load(ASSET_KINDS.INVESTIGATOR, String(idOrName));
          if (asset === null) continue;
          const pc = { ...asset };
          delete pc.id; delete pc.kind; delete pc.createdAt; delete pc.updatedAt; delete pc.legacyGameId;
          pc.id = `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          flat.characters.push(pc);
          setup.characters.push(pc.name);
        }

        // 3) AI 调查员（参与但不主导剧情，由 KP 代管）
        const aiIds = Array.isArray(body.aiInvestigatorIds) ? body.aiInvestigatorIds : [];
        for (const idOrName of aiIds) {
          const asset = deps.assetStore.load(ASSET_KINDS.INVESTIGATOR, String(idOrName));
          if (asset === null) continue;
          const pc = { ...asset };
          delete pc.id; delete pc.kind; delete pc.createdAt; delete pc.updatedAt; delete pc.legacyGameId;
          pc.id = `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          pc.aiControlled = true;
          flat.characters.push(pc);
          setup.characters.push(pc.name + "（AI）");
        }

        // 4) 开场白：LLM 基于剧本 + 角色列表生成；失败时回退模板
        let opening = "";
        let openingSource = "template";
        const names = flat.characters.map((c) => c.name).join("、") || "调查员们";
        if (flat.scenario !== null) {
          try {
            const namesWithNotes = flat.characters.map((c) => {
              const note = String(c.notes ?? "").trim();
              return c.name + (note.length > 0 ? "（" + note.slice(0, 80) + "）" : "");
            }).join("、") || names;
            const storyIntro = extractStoryIntro(flat.scenario.text ?? "", 1600);
            let openingPrompt;
            if (storyIntro.length > 0) {
              openingPrompt = [
                "你是 CoC 7e 守秘人。请根据以下剧本的开场导入，为调查团写一段开场白（200-400 字）：",
                "剧本：" + flat.scenario.name,
                "开场导入原文：\n" + storyIntro,
                "调查员：" + namesWithNotes,
                "要求：以第二人称面对玩家，忠实还原导入原文中的时间、天气、信件或访客等关键信息；默认采用“收到委托信”的开场版本并完整引用信中内容（信中原文可原样保留）；若某位调查员的背景明确写明与艾茜·沃什相识或为旧识，则改为她亲自登门，并补充她三个月来听到呓语、看到鬼影、昨晚听到拍门和抓门声；把“如果调查员与艾茜·沃什相识”这类条件分支改写为确定叙述；只写到准备前往或抵达沃什宅之前为止，不要推进到进入宅邸后的探索；禁止出现“模组”“玩家”“调查员”“剧情”“关键点”“实体”等元词汇；不要以清单形式罗列；不要替玩家做决定；必须完整结束、以句号结尾，不要在中途截断。",
              ].join("\n");
            } else {
              // 只给 LLM 干净的剧情前提：过滤版权/规则书/游玩人数等元信息，
              // 并把“本模组”改写为“故事”，避免开场白出现超出剧本维度的措辞。
              const premise = String(flat.scenario.summary ?? "")
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .filter((line) => !/(版权|登记|联系方式|qq|推荐游玩|预计游玩|前言|适用于|规则书|自由传播|保留作者)/i.test(line))
                .join(" ")
                .replace(/本模组/g, "故事")
                .replace(/\s+/g, " ")
                .slice(0, 320);
              openingPrompt = [
                "你是 CoC 7e 守秘人。为以下调查团写一段 60-120 字的开场白：",
                "剧本：" + flat.scenario.name,
                "剧情前提：" + premise,
                "调查员：" + namesWithNotes,
                "要求：营造氛围、交代初始场景，以第二人称面对玩家；只描写调查员到场后能直接感知的事物；禁止出现“模组”“玩家”“调查员”“剧情”“关键点”“实体”等元词汇；不要以清单形式罗列地点或物品；不要替玩家做决定，不要推进剧情；必须完整结束、以句号结尾，不要在中途截断。",
              ].join("\n");
            }
            const llm = await callLlmApi(deps.dataDir, [
              { role: "user", content: [{ type: "text", text: openingPrompt }] },
            ], { temperature: 0.7, max_tokens: 1600 });
            const text = llm.blocks?.[0]?.text ?? "";
            if (text.trim().length > 0) { opening = text.trim(); openingSource = "llm"; }
          } catch (e) {
            console.error("[coc-api/game-setup] 开场白 LLM 失败:", e.message);
          }
        }
        if (opening.length === 0) {
          opening = `欢迎，${names}。${flat.scenario !== null ? `《${flat.scenario.name}》的调查即将开始。` : "调查即将开始。"}先熟悉一下彼此和所处的环境吧。`;
        }
        flat.log.push({
          seq: 1,
          at: nowIso(),
          kind: "kp",
          player: "",
          text: opening,
          source: openingSource,
        });
        deps.persistence.save(key, flat);
        return sendJson(res, 200, { ok: true, data: { game: flat.id, title: flat.title, ...setup, opening, openingSource } });
      }
      if (path === "/coc-api/game-delete") {
        const gameId = body.game?.trim() || deps.defaultGame;
        const key = deps.stateKey(gameId);
        const file = deps.persistence.filePath(key);
        if (!existsSync(file)) return sendJson(res, 400, { ok: false, error: "游戏不存在" });
        unlinkSync(file);
        return sendJson(res, 200, { ok: true });
      }
      if (path === "/coc-api/scenario-delete") {
        const scenarioId = String(body.scenarioId ?? "").trim();
        if (scenarioId.length === 0) return sendJson(res, 400, { ok: false, error: "缺少 scenarioId" });
        const asset = deps.assetStore.load(ASSET_KINDS.SCENARIO, scenarioId);
        if (asset === null) return sendJson(res, 404, { ok: false, error: "剧本资产不存在" });
        // 级联删除引用该剧本的所有场次
        const deletedGames = [];
        for (const game of listGames(deps)) {
          const flat = deps.persistence.load(deps.stateKey(game.id));
          if (flat !== null && flat.scenarioId === scenarioId) {
            unlinkSync(deps.persistence.filePath(deps.stateKey(game.id)));
            deletedGames.push(game.id);
          }
        }
        deps.assetStore.delete(ASSET_KINDS.SCENARIO, scenarioId);
        return sendJson(res, 200, { ok: true, data: { scenarioId, deletedGames } });
      }
      if (path === "/coc-api/assets") {
        const kind = String(body.kind ?? "").trim();
        const kinds = [ASSET_KINDS.SCENARIO, ASSET_KINDS.INVESTIGATOR, ASSET_KINDS.ENTITY];
        if (!kinds.includes(kind)) return sendJson(res, 400, { ok: false, error: "kind 非法" });
        if (body.action === "list") {
          const items = deps.assetStore.list(kind);
          const data = items.map((asset) => {
            const item = { ...asset };
            if (kind === ASSET_KINDS.SCENARIO) {
              delete item.text; // 列表不携带全文，避免面板过大
              const m = /(\d+)\s*[-~到至]\s*(\d+)\s*人|(\d+)\s*人/.exec((asset.summary ?? "") + " " + (asset.text ?? ""));
              item.recommendedPlayers = m !== null ? (m[1] !== undefined ? `${m[1]}-${m[2]} 人` : `${m[3]} 人`) : "2-4 人（默认）";
            }
            return item;
          });
          return sendJson(res, 200, { ok: true, data });
        }
        if (body.action === "delete") {
          const assetId = String(body.assetId ?? "").trim();
          if (assetId.length === 0) return sendJson(res, 400, { ok: false, error: "缺少 assetId" });
          const asset = deps.assetStore.load(kind, assetId);
          if (asset === null) return sendJson(res, 404, { ok: false, error: "资产不存在" });
          if (kind === ASSET_KINDS.SCENARIO) {
            // 剧本资产：级联删除引用场次
            const deletedGames = [];
            for (const game of listGames(deps)) {
              const flat = deps.persistence.load(deps.stateKey(game.id));
              if (flat !== null && flat.scenarioId === assetId) {
                unlinkSync(deps.persistence.filePath(deps.stateKey(game.id)));
                deletedGames.push(game.id);
              }
            }
            deps.assetStore.delete(kind, assetId);
            return sendJson(res, 200, { ok: true, data: { assetId, deletedGames } });
          }
          deps.assetStore.delete(kind, assetId);
          return sendJson(res, 200, { ok: true, data: { assetId, deletedGames: [] } });
        }
        if (body.action === "add-from-game") {
          const gameId = body.game?.trim() || deps.defaultGame;
          const flat = deps.persistence.load(deps.stateKey(gameId));
          if (flat === null) return sendJson(res, 404, { ok: false, error: "场次不存在" });
          const entityId = String(body.entityId ?? "").trim();
          const entity = (flat.entities ?? []).find((e) => e.id === entityId);
          if (entity === undefined) return sendJson(res, 404, { ok: false, error: "场次实体不存在" });
          const existing = deps.assetStore.findByName(ASSET_KINDS.ENTITY, entity.name);
          let asset = existing;
          if (existing !== null) {
            asset = deps.assetStore.update(ASSET_KINDS.ENTITY, existing.id, {
              type: entity.type ?? existing.type ?? "npc",
              desc: entity.desc ?? existing.desc ?? "",
              state: entity.state ?? existing.state ?? "",
              scene: entity.scene ?? existing.scene ?? "",
            });
          } else {
            asset = deps.assetStore.save(ASSET_KINDS.ENTITY, {
              name: entity.name,
              type: entity.type ?? "npc",
              desc: entity.desc ?? "",
              state: entity.state ?? "",
              scene: entity.scene ?? "",
            });
          }
          return sendJson(res, 200, { ok: true, data: { id: asset.id, name: asset.name, updated: existing !== null } });
        }
        if (body.action === "instantiate") {
          const assetId = String(body.assetId ?? "").trim();
          if (assetId.length === 0) return sendJson(res, 400, { ok: false, error: "缺少 assetId" });
          const asset = deps.assetStore.load(kind, assetId);
          if (asset === null) return sendJson(res, 404, { ok: false, error: "资产不存在" });
          const gameId = body.game?.trim() || deps.defaultGame;
          const { session, flat } = loadSession(deps, gameId);
          if (kind === ASSET_KINDS.INVESTIGATOR) {
            const copy = { ...asset, assetId: asset.id };
            delete copy.id;
            delete copy.kind;
            delete copy.createdAt;
            delete copy.updatedAt;
            if (!flat.characters.some((c) => c.name === copy.name)) flat.characters.push(copy);
            session.world.characters = [...flat.characters];
          } else if (kind === ASSET_KINDS.ENTITY) {
            const copy = { ...asset, assetId: asset.id };
            delete copy.id;
            delete copy.kind;
            delete copy.createdAt;
            delete copy.updatedAt;
            if (!flat.entities.some((e) => e.name === copy.name)) flat.entities.push(copy);
            session.world.entities = [...flat.entities];
          } else {
            return sendJson(res, 400, { ok: false, error: "剧本资产请用导入，不支持实例化" });
          }
          commitSession(deps, gameId, session, flat);
          return sendJson(res, 200, { ok: true, data: { id: asset.id, name: asset.name } });
        }
        return sendJson(res, 400, { ok: false, error: "未知 action" });
      }
      if (path === "/coc-api/kp-command") {
        const gameId = body.game?.trim() || deps.defaultGame;
        const command = String(body.command ?? "").trim();
        if (command.length === 0) return sendJson(res, 400, { ok: false, error: "指令为空" });
        if (body.action === "execute") {
          if (body.calls === undefined || !Array.isArray(body.calls)) return sendJson(res, 400, { ok: false, error: "缺少 calls" });
          const results = [];
          for (const call of body.calls) {
            const def = deps.toolDefs.get(call.name);
            if (def === undefined) {
              results.push({ name: call.name, ok: false, error: `未知工具 ${call.name}` });
              continue;
            }
            try {
              const data = await def.execute({ ...call.args, game: gameId }, {});
              const rendered = def.output.render({ ...call.args, game: gameId }, data);
              results.push({ name: call.name, ok: true, data, render: rendered[0]?.text ?? "" });
            } catch (error) {
              results.push({ name: call.name, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return sendJson(res, 200, { ok: true, data: results });
        }
        // 默认 preview：LLM 解析自然语言为结构化工具调用
        const toolCatalog = [...deps.toolDefs.values()].map((def) => ({
          name: def.name,
          description: def.description,
          parameters: def.parameters,
        }));
        const prompt = [
          "你是 CoC 跑团的 KP 助手。把 KP 的自然语言指令解析为对 coc_* 工具的调用列表。",
          "只输出 JSON 数组，每个元素 { name, args }。不要调用工具，不要输出解释。",
          "可用工具：",
          JSON.stringify(toolCatalog),
          "当前游戏状态：",
          JSON.stringify(stateDigestOf(deps.persistence.load(deps.stateKey(gameId)) ?? emptyFlat(gameId))),
          "KP 指令：",
          command,
        ].join("\n");
        const llmResult = await callLlmApi(deps.dataDir, [
          { role: "user", content: [{ type: "text", text: prompt }] },
        ], { temperature: 0, max_tokens: 1200 });
        const rawText = llmResult.blocks?.map((block) => block.text ?? "").join("") ?? "";
        let calls = [];
        try {
          const parsed = JSON.parse(rawText);
          if (Array.isArray(parsed)) calls = parsed;
        } catch {
          calls = [];
        }
        if (calls.length === 0) return sendJson(res, 200, { ok: true, data: { calls: [], raw: rawText.slice(0, 400), warning: "LLM 未能解析出工具调用" } });
        return sendJson(res, 200, { ok: true, data: { calls } });
      }
      if (path === "/coc-api/chat") {
        const gameId = body.game?.trim() || deps.defaultGame;
        const text = String(body.text ?? "").trim();
        if (text.length === 0) return sendJson(res, 400, { ok: false, error: "消息为空" });
        const player = String(body.player ?? "游客").trim() || "游客";
        const result = await deps.chatBridge.runKpTurn(gameId, text, player);
        sendJson(res, 200, { ok: true, data: result });
        return;
      }
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// ── 状态辅助 ──────────────────────────────────────────────

function emptyFlat(gameId) {
  return {
    id: gameId,
    title: gameId,
    updatedAt: nowIso(),
    kpMode: "ai",
    rules: null,
    scenario: null,
    scenarioId: null,
    characters: [],
    keyPoints: [],
    branches: [],
    currentScene: "",
    currentBranchId: "",
    time: "",
    synopsis: "",
    tasks: [],
    entities: [],
    log: [],
    toolTrace: [],
    rollHistory: [],
    reminders: [],
    scheduledEvents: [],
    events: [],
    busy: false,
  };
}

function listGames(deps) {
  const gamesDir = join(deps.dataDir, "games");
  if (!existsSync(gamesDir)) return [];
  const out = [];
  for (const file of readdirSync(gamesDir)) {
    if (!file.endsWith(".json")) continue;
    const flat = deps.persistence.load(join("games", file));
    if (flat === null) continue;
    out.push({
      id: flat.id,
      title: flat.title,
      updatedAt: flat.updatedAt,
      kpMode: flat.kpMode,
      scenario: flat.scenario === null ? null : { name: flat.scenario.name, chars: flat.scenario.chars },
      scenarioId: flat.scenarioId ?? null,
      characters: (flat.characters ?? []).map((c) => c.name),
    });
  }
  out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return out;
}

function stateDigestOf(flat) {
  return {
    id: flat.id,
    title: flat.title,
    kpMode: flat.kpMode,
    currentScene: flat.currentScene,
    currentBranchId: flat.currentBranchId,
    time: flat.time,
    synopsis: flat.synopsis,
    rules: flat.rules === null ? null : { name: flat.rules.name, chars: flat.rules.chars },
    scenario: flat.scenario === null ? null : { name: flat.scenario.name, chars: flat.scenario.chars },
    scenarioId: flat.scenarioId ?? null,
    characters: flat.characters,
    keyPoints: flat.keyPoints,
    branches: flat.branches,
    tasks: flat.tasks,
    entities: flat.entities,
    reminders: flat.reminders,
    recentRolls: flat.rollHistory.slice(-12).reverse(),
    toolTrace: flat.toolTrace.slice(-10).reverse(),
    logLength: flat.log.length,
  };
}

function syncAndSave(deps, gameId, flat) {
  deps.session.id = flat.id ?? gameId;
  deps.session.syncFromFlat(flat);
  deps.session.hydrateCore(flat.core);
  flat.core = deps.session.toJSON();
  flat.updatedAt = nowIso();
  deps.persistence.save(deps.stateKey(gameId), flat);
}

// ── 注册入口 ──────────────────────────────────────────────

/**
 * 注册 /coc-api 路由。
 * @param {object} ctx - 真实 Cordis ctx
 * @param {object} deps - { dataDir, defaultGame, persistence, session, stateKey, toolDefs, maxChatRounds, maxChatLog, llmProvider, llmModel }
 */
export function registerCocApi(ctx, deps) {
  const chatBridge = createChatBridge({
    ctx,
    dataDir: deps.dataDir,
    defaultGame: deps.defaultGame,
    persistence: deps.persistence,
    session: deps.session,
    stateKey: deps.stateKey,
    toolDefs: deps.toolDefs,
    llmProvider: deps.llmProvider,
    llmModel: deps.llmModel,
    maxChatRounds: deps.maxChatRounds,
    maxChatLog: deps.maxChatLog,
  });
  deps.chatBridge = chatBridge;

  ctx.inject(["webServer"], (serverCtx) => {
    const disposer = serverCtx.webServer.register({
      kind: "prefix",
      path: "/coc-api",
      handler: (req, res) => {
        void handleCocApi(req, res, { ...deps, chatBridge });
      },
    });
    return disposer;
  });
}

/**
 * 宿主 HTTP API（/coc-api）
 *
 * Step 4：从 legacy-index.js 迁移而来，契约不变。
 * 内部使用 adapter 新工具 defs（Core → Event → State）+ persistence。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

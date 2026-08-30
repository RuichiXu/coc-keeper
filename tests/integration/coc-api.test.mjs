/**
 * 集成测试：/coc-api 路由（真实 Cordis Context + webServer 服务 mock）
 *
 * 验证：
 * - /coc-api 注册成功（webServer.register 被调用）
 * - GET /coc-api/status 返回 200 且契约字段齐全
 * - POST /coc-api/roll 走 adapter 新工具并写入 core 持久化
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Context, Service } from "@deepseek-ai/cordis";
import { apply } from "../../lib/index.js";

class TestTools extends Service {
  constructor(ctx) {
    super(ctx, "tools");
    this.registered = new Map();
  }
  register(def) {
    this.registered.set(def.name, def);
  }
}

class TestSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, "systemPrompt");
    this.sections = [];
    this.contexts = [];
  }
  section(value) {
    this.sections.push(value);
    return () => {};
  }
  context(value) {
    this.contexts.push(value);
    return () => {};
  }
}

class TestWebServer extends Service {
  constructor(ctx) {
    super(ctx, "webServer");
    this.routes = [];
  }
  register(route) {
    this.routes.push(route);
    return () => {};
  }
}

function createFakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { accept: "application/json" };
  req.destroy = () => {};
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit("data", Buffer.from(JSON.stringify(body)));
      req.emit("end");
    });
  } else {
    process.nextTick(() => req.emit("end"));
  }
  return req;
}

function createFakeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.body = "";
  res.writableEnded = false;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.write = (chunk) => {
    res.body += chunk;
  };
  res.end = (chunk) => {
    if (chunk !== undefined) res.body += chunk;
    res.writableEnded = true;
    res.emit("finish");
  };
  return res;
}

async function handle(handler, req, res) {
  handler(req, res);
  await new Promise((resolve) => {
    if (res.writableEnded) return resolve();
    res.once("finish", resolve);
    setTimeout(resolve, 200);
  });
  return JSON.parse(res.body || "{}");
}

describe("/coc-api 集成", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("webServer.register 被调用并注册 /coc-api 前缀路由", async () => {
    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const webServer = new TestWebServer(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-api-"));

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });
    await tick();

    expect(webServer.routes.length).toBe(1);
    expect(webServer.routes[0].path).toBe("/coc-api");
    expect(webServer.routes[0].kind).toBe("prefix");
  });

  it("GET /coc-api/status 返回契约字段", async () => {
    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const webServer = new TestWebServer(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-api-"));

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });
    await tick();
    const handler = webServer.routes[0].handler;

    const json = await handle(handler, createFakeReq("GET", "/coc-api/status?game=g1"), createFakeRes());
    expect(json.ok).toBeTrue();
    expect(json.data.game).toBe("g1");
  });

  it("GET /coc-api/state 返回 debug 快照，POST /coc-api/debug 可清空门禁", async () => {
    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const webServer = new TestWebServer(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-api-"));
    mkdirSync(join(dir, "games"), { recursive: true });

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });
    await tick();
    const handler = webServer.routes[0].handler;

    writeFileSync(
      join(dir, "games", "g1.json"),
      JSON.stringify({
        id: "g1", title: "g1", updatedAt: new Date().toISOString(), kpMode: "ai",
        rules: null, scenario: null, characters: [], keyPoints: [], branches: [],
        tasks: [], entities: [], reminders: [], rollHistory: [], toolTrace: [], log: [],
        pendingChecks: [{ id: "chk1", skill: "侦查", difficulty: "regular", action: "查看抽屉", hidden: false }],
        pendingChoice: null, resolvedChecks: [], passedCheckpointIds: [], sanitySettled: [],
        skippedChecks: [], firedNightEventIds: [],
        core: { trace: [{ kind: "auto-reveal", count: 1, at: new Date().toISOString() }] },
      })
    );

    const state = await handle(handler, createFakeReq("GET", "/coc-api/state?game=g1"), createFakeRes());
    expect(state.ok).toBeTrue();
    expect(state.data.debug.pendingChecks).toHaveLength(1);
    expect(state.data.debug.events).toHaveLength(1);
    expect(state.data.debug.events[0].kind).toBe("auto-reveal");
    // C-4：debug 快照应始终带 frontier 字段（无路线时为空字符串）。
    expect(typeof state.data.debug.frontier).toBe("string");

    const core = await handle(handler, createFakeReq("POST", "/coc-api/debug", { action: "dumpCore", game: "g1" }), createFakeRes());
    expect(core.ok).toBeTrue();
    expect(Array.isArray(core.data.eventLog)).toBeTrue();
    expect(core.data.plot.nodes).toEqual([]);
    expect(core.data.flags).toEqual({});

    const removed = await handle(handler, createFakeReq("POST", "/coc-api/debug", { action: "removeGate", gateId: "chk1", game: "g1" }), createFakeRes());
    expect(removed.ok).toBeTrue();
    const flat = JSON.parse(readFileSync(join(dir, "games", "g1.json"), "utf8"));
    expect(flat.pendingChecks).toHaveLength(0);
  });

  it("POST /coc-api/debug gotoPreset / exportFixture 支持剧情点跳转与夹具导出", async () => {
    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const webServer = new TestWebServer(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-api-"));
    mkdirSync(join(dir, "games"), { recursive: true });

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });
    await tick();
    const handler = webServer.routes[0].handler;

    writeFileSync(
      join(dir, "games", "g1.json"),
      JSON.stringify({
        id: "g1", title: "g1", updatedAt: new Date().toISOString(), kpMode: "ai",
        rules: null, scenario: null, characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
        keyPoints: [], branches: [], tasks: [], entities: [], reminders: [], rollHistory: [],
        toolTrace: [], log: [], pendingChecks: [], pendingChoice: null, resolvedChecks: [],
        passedCheckpointIds: [], sanitySettled: [], skippedChecks: [], firedNightEventIds: [],
        core: { trace: [] },
      })
    );

    const jumped = await handle(handler, createFakeReq("POST", "/coc-api/debug", { action: "gotoPreset", preset: "diary-found", game: "g1" }), createFakeRes());
    expect(jumped.ok).toBeTrue();
    expect(jumped.data.currentScene).toBe("三层书房");
    const flatAfterJump = JSON.parse(readFileSync(join(dir, "games", "g1.json"), "utf8"));
    expect(flatAfterJump.passedCheckpointIds).toContain("chk-5");
    expect(flatAfterJump.characters[0].inventory).toContain("克罗斯的日记");

    const fixture = await handle(handler, createFakeReq("POST", "/coc-api/debug", { action: "exportFixture", game: "g1" }), createFakeRes());
    expect(fixture.ok).toBeTrue();
    expect(fixture.data.currentScene).toBe("三层书房");
    expect(fixture.data.passedCheckpointIds).toContain("chk-5");
    expect(fixture.data.keyPoints.find((kp) => kp.id === "ai-kp-4").revealed).toBeTrue();
  });

  it("POST /coc-api/roll 走新工具并写入 core", async () => {
    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const webServer = new TestWebServer(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-api-"));

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });
    await tick();
    const handler = webServer.routes[0].handler;

    const restore = mockRandom([0.5]); // d100 = 51
    const json = await handle(
      handler,
      createFakeReq("POST", "/coc-api/roll", { expression: "d100", target: 60, player: "张三", label: "侦查", game: "g1" }),
      createFakeRes()
    );
    restore();

    expect(json.ok).toBeTrue();
    expect(json.data.rolled).toBe(51);
    expect(json.data.tier).toBe("regular");

    const flat = JSON.parse(readFileSync(join(dir, "games", "g1.json"), "utf8"));
    expect(flat.rollHistory).toHaveLength(1);
    expect(flat.core.world.rollHistory).toHaveLength(1);
  });

  it("games 列表 / 创建 / 删除", async () => {
    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const webServer = new TestWebServer(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-api-"));
    mkdirSync(join(dir, "games"), { recursive: true });

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });
    await tick();
    const handler = webServer.routes[0].handler;

    const created = await handle(handler, createFakeReq("POST", "/coc-api/game-create", { game: "g2" }), createFakeRes());
    expect(created.ok).toBeTrue();

    const list = await handle(handler, createFakeReq("GET", "/coc-api/games"), createFakeRes());
    expect(list.ok).toBeTrue();
    expect(list.data.map((g) => g.id)).toContain("g2");

    const deleted = await handle(handler, createFakeReq("POST", "/coc-api/game-delete", { game: "g2" }), createFakeRes());
    expect(deleted.ok).toBeTrue();
    expect(existsSync(join(dir, "games", "g2.json"))).toBeFalse();
  });

  it("scenario-delete 级联删除引用场次", async () => {
    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const webServer = new TestWebServer(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-api-"));
    mkdirSync(join(dir, "games"), { recursive: true });
    mkdirSync(join(dir, "assets", "scenarios"), { recursive: true });
    writeFileSync(join(dir, "assets", "scenarios", "sc-x.json"), JSON.stringify({ id: "sc-x", kind: "scenarios", name: "测试剧本", text: "..." }));
    writeFileSync(join(dir, "games", "linked.json"), JSON.stringify({ id: "linked", title: "关联场次", updatedAt: new Date().toISOString(), kpMode: "ai", rules: null, scenario: null, scenarioId: "sc-x", characters: [], keyPoints: [], branches: [], currentScene: "", currentBranchId: "", time: "", synopsis: "", tasks: [], entities: [], log: [], toolTrace: [], rollHistory: [], reminders: [], busy: false }));

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });
    await tick();
    const handler = webServer.routes[0].handler;

    const json = await handle(handler, createFakeReq("POST", "/coc-api/scenario-delete", { scenarioId: "sc-x" }), createFakeRes());
    expect(json.ok).toBeTrue();
    expect(json.data.deletedGames).toContain("linked");
    expect(existsSync(join(dir, "assets", "scenarios", "sc-x.json"))).toBeFalse();
    expect(existsSync(join(dir, "games", "linked.json"))).toBeFalse();
  });

  it("player-view 仅返回已揭示实体且只输出玩家认知字段", async () => {
    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const webServer = new TestWebServer(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-api-"));
    mkdirSync(join(dir, "games"), { recursive: true });
    writeFileSync(join(dir, "games", "g1.json"), JSON.stringify({
      id: "g1", title: "g1", updatedAt: new Date().toISOString(), kpMode: "ai", rules: null, scenario: null, scenarioId: null,
      characters: [], keyPoints: [], branches: [], currentScene: "", currentBranchId: "", time: "", synopsis: "", tasks: [],
      entities: [
        { id: "e1", type: "location", name: "墨渊", desc: "活化的黑色深渊", scene: "", revealed: false, playerDesc: "", playerState: "" },
        { id: "e2", type: "location", name: "沃什宅邸", desc: "维多利亚式三层老宅，是模组主要探索场景。", scene: "", revealed: true, playerDesc: "你们来到一栋被铁栅栏围住的三层老宅前", playerState: "已抵达" },
      ],
      log: [], toolTrace: [], rollHistory: [], reminders: [], busy: false,
    }));

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });
    await tick();
    const handler = webServer.routes[0].handler;

    const json = await handle(handler, createFakeReq("GET", "/coc-api/player-view?game=g1"), createFakeRes());
    expect(json.ok).toBeTrue();
    expect(json.data.entities).toHaveLength(1);
    expect(json.data.entities[0].id).toBe("e2");
    expect(json.data.entities[0].desc).toBe("你们来到一栋被铁栅栏围住的三层老宅前");
    expect(json.data.entities[0].desc).notToContain("模组");
    expect(json.data.entities[0].state).toBe("已抵达");
  });

  it("assets instantiate 复制通用卡到游戏内（copy-on-write）", async () => {
    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const webServer = new TestWebServer(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-api-"));
    mkdirSync(join(dir, "assets", "investigators"), { recursive: true });
    writeFileSync(join(dir, "assets", "investigators", "inv-pc.json"), JSON.stringify({ id: "inv-pc", kind: "investigators", name: "李四", occupation: "医生", stats: {}, skills: {}, inventory: ["急救包"] }));

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });
    await tick();
    const handler = webServer.routes[0].handler;

    const json = await handle(handler, createFakeReq("POST", "/coc-api/assets", { kind: "investigators", action: "instantiate", assetId: "inv-pc", game: "g1" }), createFakeRes());
    expect(json.ok).toBeTrue();
    const flat = JSON.parse(readFileSync(join(dir, "games", "g1.json"), "utf8"));
    expect(flat.characters.some((c) => c.name === "李四")).toBeTrue();
    // 原始资产未变
    const asset = JSON.parse(readFileSync(join(dir, "assets", "investigators", "inv-pc.json"), "utf8"));
    expect(asset.inventory).toHaveLength(1);
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "coc-api 集成测试"));

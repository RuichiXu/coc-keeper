/**
 * 集成测试：/coc-api 路由（真实 Cordis Context + webServer 服务 mock）
 *
 * 验证：
 * - /coc-api 注册成功（webServer.register 被调用）
 * - GET /coc-api/status 返回 200 且契约字段齐全
 * - POST /coc-api/roll 走 adapter 新工具并写入 core 持久化
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import { mkdtempSync, readFileSync } from "node:fs";
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

    const flat = JSON.parse(readFileSync(join(dir, "g1.json"), "utf8"));
    expect(flat.rollHistory).toHaveLength(1);
    expect(flat.core.world.rollHistory).toHaveLength(1);
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "coc-api 集成测试"));

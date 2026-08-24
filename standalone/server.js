import "dotenv/config";
import express from "express";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";
import { registerCocRoutes } from "./routes.js";

const standaloneDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(standaloneDir);

function resolveDataDir(raw) {
  if (!raw) return join(standaloneDir, "data");
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function isSafeGameId(value) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(String(value));
}

function createChatLimiter(limit = 12, windowMs = 60_000) {
  const hits = new Map();
  return (req, res, next) => {
    if (req.method !== "POST" || req.path !== "/coc-api/chat") return next();
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
    if (recent.length >= limit) {
      return res.status(429).json({ ok: false, error: "请求过于频繁，请稍后再试" });
    }
    recent.push(now);
    hits.set(key, recent);
    return next();
  };
}

export function createApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "50mb" }));

  const password =
    options.password ?? process.env.COC_ACCESS_PASSWORD ?? "coc-keeper";
  const auth = createAuth({ password });
  const publicDir = join(standaloneDir, "public");

  app.get("/coc-api/healthz", (_req, res) => res.json({ ok: true }));
  app.post("/coc-api/login", auth.login);
  app.get("/login.html", (_req, res) =>
    res.sendFile(join(publicDir, "login.html"))
  );

  app.use(auth.requireAccess);
  app.use(createChatLimiter());
  app.use((req, res, next) => {
    const game = req.body?.game ?? req.query?.game;
    if (game !== undefined && !isSafeGameId(game)) {
      return res.status(400).json({ ok: false, error: "game id 非法" });
    }
    return next();
  });

  app.get("/client.js", (_req, res) =>
    res.sendFile(join(repoRoot, "lib", "client.js"))
  );
  app.get("/", (_req, res) => res.sendFile(join(publicDir, "index.html")));
  app.use(express.static(publicDir, { index: false }));

  const dataDir =
    options.dataDir ?? resolveDataDir(process.env.COC_DATA_DIR);
  registerCocRoutes(app, {
    dataDir,
    defaultGame: "default",
    mockLlm: options.mockLlm ?? process.env.COC_LLM_MOCK === "1",
  });

  app.use((_req, res) =>
    res.status(404).json({ ok: false, error: "not found" })
  );
  return { app, dataDir, usingDefaultPassword: password === "coc-keeper" };
}

export function startServer(options = {}) {
  const { app, dataDir, usingDefaultPassword } = createApp(options);
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const server = app.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort =
      typeof address === "object" && address !== null ? address.port : port;
    console.log(`[coc-keeper] standalone: http://127.0.0.1:${actualPort}`);
    console.log(`[coc-keeper] 数据目录：${dataDir}`);
    if (usingDefaultPassword) {
      console.warn(
        "[coc-keeper] 警告：正在使用默认访问口令 coc-keeper，请设置 COC_ACCESS_PASSWORD"
      );
    }
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}

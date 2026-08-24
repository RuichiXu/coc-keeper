import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const standaloneDir = dirname(fileURLToPath(import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl) {
  let lastError;
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(baseUrl + "/coc-api/healthz");
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("server startup timeout");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log("✓ " + message);
}

const port = await freePort();
const dataDir = mkdtempSync(join(tmpdir(), "coc-standalone-smoke-"));
const password = "smoke-secret";
const baseUrl = `http://127.0.0.1:${port}`;
let output = "";
const child = spawn(process.execPath, ["server.js"], {
  cwd: standaloneDir,
  env: {
    ...process.env,
    PORT: String(port),
    COC_DATA_DIR: dataDir,
    COC_ACCESS_PASSWORD: password,
    COC_LLM_MOCK: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });

try {
  await waitForHealth(baseUrl);
  const health = await fetch(baseUrl + "/coc-api/healthz");
  assert(
    health.status === 200 && (await health.json()).ok === true,
    "healthz"
  );

  const unauthorized = await fetch(baseUrl + "/coc-api/status", {
    redirect: "manual",
  });
  assert(unauthorized.status === 401, "未登录 API 返回 401");

  const login = await fetch(baseUrl + "/coc-api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert(login.ok && cookie.startsWith("coc_access="), "登录并取得 cookie");

  const request = (path, body) =>
    fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  const created = await request("/coc-api/game-create", { game: "smoke" });
  assert(created.ok && (await created.json()).ok === true, "创建游戏");

  const chat = await request("/coc-api/chat", {
    game: "smoke",
    player: "测试员",
    text: "我推开门。",
  });
  assert(chat.ok && (await chat.json()).ok === true, "Mock chat");

  const stateResponse = await fetch(
    baseUrl + "/coc-api/state?game=smoke&after=0",
    { headers: { cookie } }
  );
  const state = await stateResponse.json();
  assert(
    state.entries.map((entry) => entry.kind).join(",") === "user,kp",
    "状态包含 user 与 kp 日志"
  );

  const configSet = await request("/coc-api/config", {
    action: "set",
    llmProvider: "openai-compatible",
    llmModel: "mock",
    apiKey: "smoke-api-key",
    apiBaseUrl: "https://example.invalid/v1/chat/completions",
  });
  assert(configSet.ok, "保存服务端 LLM 配置");
  const configGet = await request("/coc-api/config", { action: "get" });
  const configJson = await configGet.json();
  assert(
    configJson.data.apiKey === "••••••••" &&
      JSON.stringify(configJson).includes("smoke-api-key") === false,
    "API Key 不回显到浏览器"
  );

  const deleted = await request("/coc-api/game-delete", { game: "smoke" });
  assert(deleted.ok && (await deleted.json()).ok === true, "删除游戏");
  console.log("\nstandalone smoke: 全绿");
} catch (error) {
  console.error("\nstandalone smoke 失败:", error.message);
  if (output.trim()) console.error(output.trim());
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}

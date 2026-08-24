/**
 * 前端 UI 冒烟检查（Playwright + dsh web 真实启动）。
 *
 * 用法：node tests/ui-check.mjs
 *
 * 检查项（与本次更新对应的前端按钮是否“有反应”）：
 * 1. Keeper 面板挂载
 * 2. 调试 tab 的 导入/实体/人物/卡库/设置 子按钮能切换并渲染内容
 * 3. 新建场次向导能打开，step1→step2（含 AI 调查员选项）→step3
 * 4. 玩家面板挂载
 *
 * 注意：这是冒烟检查，不替代真实 E2E。真实 E2E 仍需用户配合验证。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

// ── 找到可用的 headless chromium ────────────────────────────
function findChromiumExecutable() {
  const roots = [
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith("chromium")) continue;
      const candidates = [
        join(root, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
        join(root, dir, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
        join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        join(root, dir, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
        join(root, dir, "chrome-mac", "headless_shell"),
        join(root, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join(root, dir, "chrome-linux", "headless_shell"),
        join(root, dir, "chrome-linux", "chrome"),
        join(root, dir, "chrome-win", "headless_shell.exe"),
        join(root, dir, "chrome-win", "chrome.exe"),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

// ── 启动 dsh web 并解析端口 ────────────────────────────────
function startDshWeb() {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["@deepseek-ai/dsh", "web", "--port", "0"], {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === "win32",
    });
    let buffer = "";
    let port = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("dsh web 启动超时"));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer);
      if (m !== null && port === null) {
        port = Number(m[1]);
        clearTimeout(timer);
        resolve({ child, port });
      }
    });
    child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer);
      if (m !== null && port === null) {
        port = Number(m[1]);
        clearTimeout(timer);
        resolve({ child, port });
      }
    });
    child.on("exit", (code) => {
      if (port === null) {
        clearTimeout(timer);
        reject(new Error(`dsh web 提前退出（code ${code}）：${buffer.slice(-800)}`));
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 主流程 ─────────────────────────────────────────────────
const executablePath = findChromiumExecutable();
if (executablePath === null) {
  console.error("✗ 未找到 Playwright chromium，请先 `npx playwright install chromium`");
  process.exit(1);
}
console.log("chromium:", executablePath);

const { child, port } = await startDshWeb();
console.log("dsh web: http://127.0.0.1:" + port);

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log((ok ? "✓" : "✗") + " " + name + (extra ? " — " + extra : ""));
};

try {
  page.on("dialog", async (dialog) => { await dialog.accept(); });
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2500);

  // 1. Keeper 面板挂载
  const keeper = await page.$("#coc-keeper-panel");
  check("Keeper 面板挂载", keeper !== null);

  // 2. 调试 tab 切换
  const debugTabBtn = await page.locator("#coc-keeper-panel .coc-tabs button", { hasText: "调试" }).first();
  if (await debugTabBtn.count() === 0) {
    check("找到「调试」tab", false, "面板 tab 未渲染");
  } else {
    await debugTabBtn.click();
    await sleep(600);
    check("找到「调试」tab", true);
  }

  // 3. 调试子按钮逐个点击
  const subtabChecks = [
    ["导入", "import"],
    ["实体", "ents"],
    ["人物", "chars"],
    ["卡库", "assets"],
    ["设置", "settings"],
  ];
  for (const [label, key] of subtabChecks) {
    const btn = page.locator("#coc-keeper-panel button", { hasText: label }).first();
    if (await btn.count() === 0) {
      check(`子按钮「${label}」存在`, false, "未找到按钮");
      continue;
    }
    await btn.click();
    await sleep(450);
    const panel = await page.locator(`#coc-keeper-panel [data-subpanel="${key}"]`).first();
    const style = await panel.evaluate((node) => ({ display: node.style.display, text: node.textContent.length }));
    check(`子按钮「${label}」有反应`, style.display === "block" && style.text > 0, `display=${style.display}, 文本长度=${style.text}`);
  }

  // 3b. 实体行揭示/隐藏按钮（本次更新对应按钮）
  {
    const entsTab = page.locator("#coc-keeper-panel button", { hasText: "实体" }).first();
    if (await entsTab.count() > 0) {
      await entsTab.click();
      await sleep(450);
      const entityItem = page.locator('#coc-keeper-panel [data-subpanel="ents"] .coc-kp-item').first();
      if (await entityItem.count() > 0) {
        const revealBtn = entityItem.locator("button", { hasText: /揭示|隐藏/ }).first();
        check("实体行揭示/隐藏按钮存在", await revealBtn.count() > 0);
      } else {
        check("实体行揭示/隐藏按钮存在（无实体跳过）", true, "当前场次无实体");
      }
    } else {
      check("实体行揭示/隐藏按钮存在（无实体跳过）", true, "未找到实体 tab");
    }
  }

  // 4. 新建场次向导
  const newBtn = page.locator("#coc-keeper-panel button", { hasText: "＋" }).first();
  if (await newBtn.count() === 0) {
    check("新建场次按钮存在", false, "未找到＋按钮");
  } else {
    await newBtn.click();
    await sleep(600);
    const wizard = await page.$(".coc-wizard");
    check("新建场次向导打开", wizard !== null);
    if (wizard !== null) {
      const next1 = page.locator(".coc-wizard button", { hasText: "下一步：选择调查员" }).first();
      check("向导 step1 下一步按钮存在", await next1.count() > 0);
      if (await next1.count() > 0) {
        await next1.click();
        await sleep(800);
        const step2Visible = await page.locator(".coc-wizard-step").nth(1).evaluate((node) => node.style.display === "block");
        check("向导 step2 显示", step2Visible);
        const aiSelect = page.locator(".coc-wizard select").nth(1);
        check("AI 调查员下拉存在", await aiSelect.count() > 0);
        const next2 = page.locator(".coc-wizard button", { hasText: "下一步：确认创建" }).first();
        if (await next2.count() > 0) {
          await next2.click();
          await sleep(600);
          const step3Visible = await page.locator(".coc-wizard-step").nth(2).evaluate((node) => node.style.display === "block");
          check("向导 step3 显示（未选调查员时 confirm 放行）", step3Visible);
        }
      }
    }
  }

  // 5. 玩家面板挂载
  const player = await page.$("#coc-keeper-player-panel");
  check("玩家面板挂载", player !== null);
} catch (error) {
  check("UI 检查执行", false, error.message);
} finally {
  await browser.close().catch(() => {});
  child.kill();
  await sleep(300);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== UI 冒烟检查：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const r of failed) console.log("  - " + r.name + (r.extra ? "：" + r.extra : ""));
  process.exit(1);
}
process.exit(0);

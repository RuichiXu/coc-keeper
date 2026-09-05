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

// 结束整个进程树：npx → npm/node → dsh web，避免留下孤儿服务进程。
function killTree(child) {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGTERM");
      return;
    }
  } catch {
    // 进程组已退出时回退到只杀 npx 本身。
  }
  child.kill();
}

// ── 启动 dsh web 并解析端口 ────────────────────────────────
function startDshWeb() {
  return new Promise((resolve, reject) => {
    // 支持 DSH_WEB_BIN 直接指定 dsh 可执行文件，绕过 npm cache 权限问题。
    const bin = process.env.DSH_WEB_BIN;
    const child = bin
      ? spawn(bin, ["web", "--port", "0", "--no-open"], {
          cwd: process.cwd(),
          env: process.env,
          shell: process.platform === "win32",
          detached: process.platform !== "win32",
        })
      : spawn("npx", ["@deepseek-ai/dsh", "web", "--port", "0", "--no-open"], {
          cwd: process.cwd(),
          env: process.env,
          shell: process.platform === "win32",
          detached: process.platform !== "win32",
        });
    let buffer = "";
    let port = null;
    let url = null;
    const finish = () => {
      clearTimeout(timer);
      resolve({ child, port, url: url ?? `http://127.0.0.1:${port}/` });
    };
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error("dsh web 启动超时"));
    }, 30000);
    const scan = (chunk) => {
      buffer += String(chunk);
      if (port === null) {
        // 优先捕获带 token 的完整 URL（dsh web 新版要求 token 鉴权）。
        const tokenMatch = /http:\/\/127\.0\.0\.1:(\d+)(\/[^\s"']*token=[^\s"']*)/.exec(buffer);
        if (tokenMatch !== null) {
          port = Number(tokenMatch[1]);
          url = `http://127.0.0.1:${tokenMatch[1]}${tokenMatch[2]}`;
          finish();
          return;
        }
        const portMatch = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer);
        if (portMatch !== null) {
          port = Number(portMatch[1]);
        }
      }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
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

const { child, port, url } = await startDshWeb();
console.log("dsh web: port " + port);

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const results = [];
const pageErrors = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log((ok ? "✓" : "✗") + " " + name + (extra ? " — " + extra : ""));
};

try {
  page.on("dialog", async (dialog) => { await dialog.accept(); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2500);

  // 1. Keeper 面板挂载
  const keeper = await page.$("#coc-keeper-panel");
  check("Keeper 面板挂载", keeper !== null);

  // 四个工作区均使用真实点击，并验证专属内容可见。
  for (const [label, key] of [["主持", "dm"], ["剧情", "plot"], ["解析", "net"], ["调试", "debug"]]) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    await tab.click();
    const content = page.locator(`#coc-keeper-panel [data-panel="${key}"]`);
    check(`工作区「${label}」可达`, await content.isVisible());
  }
  await page.getByRole("tab", { name: "主持", exact: true }).click();
  check("主持对话与快捷骰可见", await page.locator("#coc-keeper-panel .coc-composer").isVisible() && await page.getByRole("button", {name:"🎲 明骰",exact:true}).isVisible());
  await page.getByRole("tab", { name: "剧情", exact: true }).click();
  await page.getByRole("button", { name: "剧情结构", exact: true }).click();
  check("剧情结构子页可达", await page.locator('[data-subpanel="plotInner"]').isVisible());
  await page.getByRole("button", { name: "状态总览", exact: true }).click();
  check("状态总览子页可达", await page.locator('[data-subpanel="status"]').isVisible());

  // 2. 调试 tab 切换
  const debugTabBtn = await page.locator("#coc-keeper-panel .coc-tabs button", { hasText: "调试" }).first();
  if (await debugTabBtn.count() === 0) {
    check("找到「调试」tab", false, "面板 tab 未渲染");
  } else {
    // 用 JS click 绕过可拖拽面板头部对 tab 按钮的命中遮挡（面板位置持久化可能导致 Playwright 命中测试失败）。
    await debugTabBtn.evaluate((node) => node.click());
    await sleep(600);
    check("找到「调试」tab", true);
  }

  // 2b. 解析 tab（新增：深度剧情解析网络结构）
  {
    const netTab = page.locator("#coc-keeper-panel .coc-tabs button", { hasText: "解析" }).first();
    if (await netTab.count() === 0) {
      check("找到「解析」tab", false, "面板 tab 未渲染");
    } else {
      await netTab.evaluate((node) => node.click());
      await sleep(700);
      const panel = await page.locator("#coc-keeper-panel [data-panel=\"net\"]").first();
      const style = await panel.evaluate((node) => ({ display: node.style.display, text: node.textContent.length }));
      check("「解析」tab 有反应", style.display === "flex" && style.text > 0, `display=${style.display}, 文本长度=${style.text}`);
    }
  }

  // 回到调试 tab 再检查子按钮（解析 tab 检查会切走当前 tab）
  {
    const debugAgain = page.locator("#coc-keeper-panel .coc-tabs button", { hasText: "调试" }).first();
    if (await debugAgain.count() > 0) {
      await debugAgain.evaluate((node) => node.click());
      await sleep(500);
    }
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
    await btn.evaluate((node) => node.click());
    await sleep(450);
    const panel = await page.locator(`#coc-keeper-panel [data-subpanel="${key}"]`).first();
    const style = await panel.evaluate((node) => ({ display: node.style.display, text: node.textContent.length }));
    check(`子按钮「${label}」有反应`, style.display === "block" && style.text > 0, `display=${style.display}, 文本长度=${style.text}`);
  }

  for (const label of ["运行", "契约"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    check(`调试「${label}」可达`, await page.locator('[data-panel="debug"] .coc-card').count() > 0);
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
  await page.getByRole("button", {name:"关闭向导",exact:true}).click();
  check("向导可关闭", await page.locator(".coc-wizard").count() === 0);
  await page.getByTitle("最小化到面板坞（右下角 🧩 恢复）",{exact:true}).click();
  check("Keeper 可最小化", !(await page.locator("#coc-keeper-panel").isVisible()));
  await page.locator("#dsh-panel-dock .dock-fab").click();
  await page.locator("#dsh-panel-dock .dock-row").filter({hasText:"CoC 跑团"}).click();
  check("面板坞可恢复 Keeper", await page.locator("#coc-keeper-panel").isVisible());
  check("无页面错误", pageErrors.length === 0, pageErrors.join("; "));
} catch (error) {
  check("UI 检查执行", false, error.message);
} finally {
  await browser.close().catch(() => {});
  killTree(child);
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

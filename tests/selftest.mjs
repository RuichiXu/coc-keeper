// coc-keeper 自测：用模拟 ctx 执行 apply()，验证工具注册与核心逻辑。
import { apply, Config, name } from "/Users/eeo/Documents/deepseek harness/coc-keeper/lib/index.js";

const registered = new Map();
const sections = [];
const contexts = [];

const ctx = {
	tools: {
		register(def) {
			if (registered.has(def.name)) throw new Error(`重复注册工具 ${def.name}`);
			registered.set(def.name, def);
		}
	},
	systemPrompt: {
		section(s) { sections.push(s); },
		context(c) { contexts.push(c); }
	},
	// 模拟 cordis ctx.inject：本测试没有 webServer 服务，回调不执行
	inject() { return void 0; }
};

// 用默认配置（数据目录指向临时目录）
const config = { dataDir: "/tmp/coc-keeper-test-data", defaultGame: "test-game-" + Date.now(), maxRollHistory: 200 };
const validated = Config["~standard"].validate(config);
if (validated.issues) { console.error("Config 校验失败", validated.issues); process.exit(1); }
apply(ctx, config);

console.log("注册工具:", [...registered.keys()].join(", "));
console.log("提示词 section:", sections.map((s) => s.name).join(", "), "| context:", contexts.map((c) => c.name).join(", "));

const run = async (toolName, args) => {
	const def = registered.get(toolName);
	if (!def) throw new Error(`工具 ${toolName} 未注册`);
	try {
		return await def.execute(args, {});
	} catch (e) {
		return { __error: e.message };
	}
};
const show = (label, r) => {
	if (r.__error) console.log(`  ${label} FAIL: ${r.__error}`);
	else console.log(`  ${label} OK`);
};

// ── 1. 导入规则（文本） ──
// 上面通过空文本+overwrite 清理旧剧本和关联的关键剧情点/分支/实体
// 但手动添加的通用实体（无 scenarioId）不会被清除，用以下方式重置：
// 先获取当前状态，再逐个删除实体
const initState = await run("coc_status", { view: "overview" });
// 忽略旧状态，直接继续

let r = await run("coc_import", { kind: "rules", source: "text", text: "克苏鲁的呼唤 7e 规则：检定 d100，常规成功≤技能值。", name: "CoC 7e" });
console.log("\n[import rules]", r.kind, r.name, r.chars, "字符");
if (r.__error) console.log("  FAIL:", r.__error);

// ── 2. 导入剧本（文本，带结构标记） ──
r = await run("coc_import", { kind: "scenario", source: "text", text: "【场景】废弃宅邸\n调查员进入宅邸。\n【关键剧情点】书房发现暗格\n【分支】是否撬开暗格", name: "暗黑边缘", overwrite: true, parseStructure: true });
console.log("[import scenario]", r.keyPoints, "关键点 /", r.branches, "分支");
if (r.keyPoints !== 1 || r.branches !== 1) console.log("  FAIL: 结构草拟数量不符（期望 1/1，实际 " + r.keyPoints + "/" + r.branches + "）");

// ── 3. 导入人物（文本） ──
r = await run("coc_import", { kind: "characters", source: "text", text: "姓名：张三\n职业：侦探\n力量：50\n敏捷：60\n侦查：70\n物品：手枪、笔记本" });
console.log("[import characters]", r.characters, "人");
if (r.characters !== 1) console.log("  FAIL: 人物数不符");

// ── 4. 明骰（d100，目标 60，常规） ──
const roll = await run("coc_roll", { expression: "d100", target: 60, difficulty: "regular", player: "张三", label: "侦查书房" });
console.log("[roll open]", JSON.stringify(roll));
if (roll.__error) console.log("  FAIL:", roll.__error);
else if (!(roll.rolled >= 1 && roll.rolled <= 100)) console.log("  FAIL: 骰值越界");

// 校验判定档位逻辑：构造确定性的滚动（用注入？这里只能统计边界）
// 手工验证 evaluate 档位语义：rolled<=12 → extreme; <=30 → hard; <=60 → regular; 96+ → fumble
// 通过 target 边界观察 tier 分布（随机，跑 200 次统计）
let tiers = {};
for (let i = 0; i < 200; i++) {
	const res = await run("coc_roll", { expression: "d100", target: 60 });
	const t = res.tier ?? "none";
	tiers[t] = (tiers[t] ?? 0) + 1;
}
console.log("[roll tiers over 200 runs]", JSON.stringify(tiers));
const allowed = ["critical", "extreme", "hard", "regular", "fail", "fumble"];
for (const t of Object.keys(tiers)) if (!allowed.includes(t)) console.log("  FAIL: 未知档位", t);

// ── 5. 暗骰 ──
const secret = await run("coc_roll_secret", { expression: "d100", target: 40, difficulty: "hard", label: "潜行" });
console.log("[roll secret]", JSON.stringify(secret));
if (secret.__error) console.log("  FAIL:", secret.__error);
else if (secret.secret !== true) console.log("  FAIL: secret 标记缺失");

// ── 6. 普通骰（3d6） ──
const multi = await run("coc_roll", { expression: "3d6", label: "伤害" });
console.log("[roll 3d6]", JSON.stringify(multi));
if (multi.__error || multi.total < 3 || multi.total > 18) console.log("  FAIL: 3d6 越界");

// ── 7. KP 状态 ──
const status = await run("coc_status", { view: "all", includeSecretRolls: true });
console.log("[status]", JSON.stringify({ scene: status.currentScene, chars: status.characters.length, kps: status.keyPoints?.length, brs: status.branches?.length, rolls: status.recentRolls?.length }));
if (status.characters.length !== 1) console.log("  FAIL: 人物数不符");

// ── 8. 分支管理 ──
r = await run("coc_branch", { action: "add", type: "branch", item: { title: "是否撬开暗格", scene: "书房", options: [{ label: "撬开暗格", leadsTo: "地下室" }, { label: "先不碰", leadsTo: "走廊" }] } });
show("branch add", r);
r = await run("coc_branch", { action: "reached", branchId: "br-2" });
show("branch reached", r);
console.log("  branch reached:", r.message, "| currentBranchId:", r.currentBranchId);
r = await run("coc_branch", { action: "choose", branchId: "br-2", optionLabel: "撬开暗格" });
show("branch choose", r);
console.log("  branch choose:", r.message, "| scene:", r.currentScene);
if (r.currentScene !== "地下室") console.log("  FAIL: choose 未推进到 leadsTo 场景");
r = await run("coc_branch", { action: "add", type: "keypoint", item: { title: "发现古书", scene: "地下室" } });
show("keypoint add", r);
r = await run("coc_branch", { action: "reveal", keyPointId: "kp-2" });
show("keypoint reveal", r);

// ── 9. 提醒 ──
r = await run("coc_remind", { action: "add", scene: "地下室", text: "玩家即将面对古书守护者，提示是否献祭物品" });
console.log("[remind add]", r.message);
const ctxText = contexts[0].text();
console.log("[dynamic context]");
console.log(ctxText);
if (!ctxText.includes("地下室")) console.log("  FAIL: 动态上下文未包含当前场景");

// ── 10. KP 模式切换 ──
r = await run("coc_kp", { action: "human" });
console.log("[kp human]", r.kpMode, "|", r.message.slice(0, 30));
r = await run("coc_kp", { action: "ai" });
console.log("[kp ai]", r.kpMode);

// ── 11. 人物管理 ──
r = await run("coc_character", { action: "list" });
console.log("[character list]", r.characters.length, "人:", r.characters.map((c) => c.name).join(","));
r = await run("coc_character", { action: "update", name: "张三", character: { san: 55, skills: { 侦查: 75 } } });
show("character update", r);
console.log("[character update]", r.message);
const updated = await run("coc_character", { action: "list" });
console.log("  updated san:", updated.characters[0].san, "| 侦查:", updated.characters[0].skills["侦查"]);
if (updated.characters[0].san !== 55 || updated.characters[0].skills["侦查"] !== 75) console.log("  FAIL: 人物更新未生效");

// ── 12. coc_read ──
r = await run("coc_read", { what: "scenario" });
console.log("[read scenario]", r.totalChars, "字符, 返回", r.text.length);

// ── 13. 新工具：剧情状态/任务/实体/人物状态 ──
r = await run("coc_scene", { scene: "地下室", time: "1925年10月1日 下午3点", synopsis: "调查员在废弃宅邸中发现暗格" });
show("coc_scene", r);
console.log("  scene:", r.scene, "| time:", r.time);
if (r.scene !== "地下室" || !r.time.includes("1925")) console.log("  FAIL: coc_scene 未生效");
r = await run("coc_task", { action: "add", title: "调查暗格里的古书" });
show("coc_task add", r);
r = await run("coc_task", { action: "add", title: "寻找宅邸主人" });
r = await run("coc_task", { action: "complete", taskId: "task-1" });
show("coc_task complete", r);
if (r.tasks[0]?.status !== "done") console.log("  FAIL: 任务未完成");
r = await run("coc_entity", { action: "add", entity: { type: "npc", name: "老管家", desc: "沉默寡言", scene: "门厅" } });
show("coc_entity add", r);
r = await run("coc_entity", { action: "update", entityId: "ent-1", entity: { state: "已起疑" } });
show("coc_entity update", r);
if (r.entities.find((e) => e.id === "ent-1")?.state !== "已起疑") console.log("  FAIL: 实体更新未生效");
r = await run("coc_pc", { name: "张三", hp: 11, san: 50, inventoryAdd: "古书残页" });
show("coc_pc", r);
const pcAfter = await run("coc_character", { action: "list" });
console.log("  张三: hp", pcAfter.characters[0].hp, "san", pcAfter.characters[0].san, "物品:", pcAfter.characters[0].inventory.join(","));
if (pcAfter.characters[0].hp !== 11 || pcAfter.characters[0].san !== 50 || !pcAfter.characters[0].inventory.includes("古书残页")) console.log("  FAIL: coc_pc 未生效");

// ── 14. 实体草拟（剧本带实体标记） ──
r = await run("coc_import", { kind: "scenario", source: "text", text: "【场景】码头\n【NPC】走私船长\n【地点】仓库\n【物品】旧怀表", name: "码头疑云", game: "test-entity-" + Date.now(), overwrite: true });
show("scenario with entities", r);
console.log("  实体:", r.entities, "个");
if (r.entities !== 3) console.log("  FAIL: 实体草拟数量不符（期望 3，实际 " + r.entities + "）");

// ── 15. 动态上下文含时间与最近检定 ──
const ctxText2 = contexts[0].text();
console.log("[digest context 含时间]", ctxText2.includes("1925") ? "OK" : "FAIL: 时间未进上下文");

console.log("\n✅ 自测完成");

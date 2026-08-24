//#region imports
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { parseCharacters as parseCharactersCore, normalizeCharacter as normalizeCharacterCore } from "./core/index.js";
//#endregion

//#region 内置规则内容
/** 克苏鲁的呼唤第七版核心规则（内置摘要） */
const __dirname_rules = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
let BUILTIN_RULES = { name: "", text: "", summary: "", chars: 0, lines: 0 };
try {
	const rulesJsonPath = join(__dirname_rules, "rules-content.json");
	if (existsSync(rulesJsonPath)) {
		BUILTIN_RULES = JSON.parse(readFileSync(rulesJsonPath, "utf8"));
	}
} catch (e) {
	console.error("[coc-keeper] 加载内置规则失败:", e.message);
}
const BUILTIN_RULES_NAME = BUILTIN_RULES.name;
const BUILTIN_RULES_TEXT = BUILTIN_RULES.text;
const BUILTIN_RULES_SUMMARY = BUILTIN_RULES.summary;
const BUILTIN_RULES_CHARS = BUILTIN_RULES.chars;
const BUILTIN_RULES_LINES = BUILTIN_RULES.lines;
//#endregion


//#region 插件元信息
const name = "coc-keeper";
const inject = ["tools", "systemPrompt"];

/** 插件配置：数据目录、默认游戏、骰点历史上限、面板聊天桥所用模型。 */
const Config = z.object({
	dataDir: z.string().default(""),
	defaultGame: z.string().default("default"),
	maxRollHistory: z.number().min(10).max(2000).default(200),
	llmProvider: z.string().default("deepseek-official"),
	llmModel: z.string().default("deepseek-v4-flash"),
	maxChatRounds: z.number().min(1).max(8).default(4),
	maxChatLog: z.number().min(20).max(500).default(120)
});
//#endregion

//#region 基础工具
function dshHome() {
	const env = process.env.DSH_HOME;
	return env !== void 0 && env.length > 0 ? env : join(homedir(), ".dsh");
}
function safeGameId(id) {
	const clean = String(id).trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return clean.length > 0 ? clean.slice(0, 64) : "default";
}
function stateFile(dataDir, gameId) {
	return join(dataDir, "games", `${safeGameId(gameId)}.json`);
}
function emptyState(gameId) {
	return {
		id: safeGameId(gameId),
		title: gameId,
		updatedAt: new Date().toISOString(),
		kpMode: "ai",
		rules: null,
		scenario: null,
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
		reminders: []
	};
}
/** 旧状态迁移：补齐新增字段。 */
function ensureState(state) {
	if (state.time === void 0) state.time = "";
	if (state.synopsis === void 0) state.synopsis = "";
	if (!Array.isArray(state.tasks)) state.tasks = [];
	if (!Array.isArray(state.entities)) state.entities = [];
	if (!Array.isArray(state.log)) state.log = [];
	if (!Array.isArray(state.toolTrace)) state.toolTrace = [];
	return state;
}
function loadState(dataDir, gameId) {
	const file = stateFile(dataDir, gameId);
	if (!existsSync(file)) return null;
	try {
		return ensureState(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}
function saveState(dataDir, state) {
	const file = stateFile(dataDir, state.id);
	mkdirSync(dirname(file), { recursive: true });
	state.updatedAt = new Date().toISOString();
	writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
	return state;
}
function touchState(dataDir, gameId) {
	const id = safeGameId(gameId);
	const existing = loadState(dataDir, id);
	if (existing !== null) return existing;
	return saveState(dataDir, emptyState(id));
}
function findBranch(state, id) {
	return state.branches.find((b) => b.id === id) ?? null;
}
function findKeyPoint(state, id) {
	return state.keyPoints.find((k) => k.id === id) ?? null;
}
function summarize(content, max = 4000) {
	const text = String(content ?? "");
	return text.length > max ? `${text.slice(0, max)}\n……[截断，全文可用 coc_read 阅读]` : text;
}
function now() {
	return new Date().toISOString();
}
/** 推进游戏内时间：解析「1925年10月1日 下午3点」式文本；解析失败则在原时间后标注。 */
function advanceGameTime(current, mode) {
	const label = mode === "hour" ? "+1小时" : mode === "day" ? "+1天" : "到夜晚";
	if (typeof current !== "string" || current.trim().length === 0) {
		return mode === "night" ? "1925年10月1日 晚上9点" : `1925年10月1日 上午9点（${label}）`;
	}
	const m = /^(\d{1,4})年(\d{1,2})月(\d{1,2})日(?:\s*(上午|下午|晚上)?\s*(\d{1,2})?点?)?/.exec(current.trim());
	if (m === null) return `${current.trim()}（${label}）`;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const period = m[4] ?? "";
	let hour = m[5] ? Number(m[5]) : 9;
	if (period === "下午" && hour < 12) hour += 12;
	else if (period === "晚上" && hour < 12) hour += 12;
	else if (period === "上午" && hour === 12) hour = 0;
	const date = new Date(year, month - 1, day, hour, 0, 0);
	if (mode === "hour") date.setHours(date.getHours() + 1);
	else if (mode === "day") date.setDate(date.getDate() + 1);
	else if (mode === "night") date.setHours(21);
	const h = date.getHours();
	const periodOut = h >= 18 ? "晚上" : h >= 12 ? "下午" : "上午";
	const hOut = h % 12 === 0 ? 12 : h % 12;
	return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${periodOut}${hOut}点`;
}
//#endregion

//#region 骰点引擎（CoC 7e 判定）
const TIER_LABELS = {
	critical: "大成功",
	extreme: "极限成功",
	hard: "困难成功",
	regular: "常规成功",
	pass: "成功",
	fail: "失败",
	fumble: "大失败"
};
const DIFFICULTY_LABELS = { regular: "常规", hard: "困难", extreme: "极限" };
const DIFFICULTY_ORDER = { regular: 0, hard: 1, extreme: 2 };

function parseDiceExpression(expr) {
	const m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(String(expr).trim());
	if (m === null) throw new Error(`无法解析骰式 "${expr}"；支持格式：d100、3d6、d20+2、2d10-1`);
	const count = m[1] === "" ? 1 : Number.parseInt(m[1], 10);
	const sides = Number.parseInt(m[2], 10);
	const mod = m[3] === void 0 ? 0 : Number.parseInt(m[3], 10);
	if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error(`骰子个数 ${count} 无效（1-100）`);
	if (!Number.isInteger(sides) || sides < 2 || sides > 1000) throw new Error(`骰面 ${sides} 无效（2-1000）`);
	return { count, sides, mod };
}
function rollDice(count, sides) {
	const dice = [];
	for (let i = 0; i < count; i += 1) dice.push(Math.floor(Math.random() * sides) + 1);
	return dice;
}
/**
 * CoC 7e 判定：百分骰时按 1/5、1/2、目标值分档；
 * 01 大成功；技能 <50 时 01–05 大成功；96–100 失败（技能 <50 时 96–100 大失败，≥50 时仅 100 大失败）。
 */
function evaluateCoC(target, rolled, percentile) {
	if (!percentile) {
		return { tier: rolled <= target ? "pass" : "fail" };
	}
	const fifth = Math.floor(target / 5);
	const half = Math.floor(target / 2);
	let tier;
	if (rolled <= fifth) tier = "extreme";
	else if (rolled <= half) tier = "hard";
	else if (rolled <= target) tier = "regular";
	else if (rolled >= 96) tier = "fumble";
	else tier = "fail";
	if (rolled === 1) tier = "critical";
	else if (target < 50 && rolled <= 5 && rolled <= target) tier = "critical";
	return { tier };
}
function passedFor(tier, difficulty, percentile) {
	if (!percentile) return tier === "pass" || tier === "critical";
	if (tier === "critical" || tier === "extreme") return true;
	if (tier === "fumble" || tier === "fail") return false;
	if (difficulty === "extreme") return false;
	if (difficulty === "hard") return tier === "hard";
	return tier === "regular" || tier === "hard";
}
function performRoll(expression, target, difficulty) {
	const parsed = parseDiceExpression(expression);
	const dice = rollDice(parsed.count, parsed.sides);
	const percentile = parsed.sides === 100 && parsed.count === 1;
	const total = dice.reduce((a, b) => a + b, 0) + parsed.mod;
	const rolled = percentile ? total : total;
	const hasTarget = Number.isFinite(target) && target > 0;
	let tier = null;
	let passed = null;
	if (hasTarget) {
		const evaluation = evaluateCoC(target, rolled, percentile);
		tier = evaluation.tier;
		passed = passedFor(tier, difficulty, percentile);
	}
	return { dice, rolled, total, percentile, target: hasTarget ? target : null, difficulty, tier, passed };
}
//#endregion

//#region 导入解析
const STAT_ALIASES = {
	力量: "STR", 体质: "CON", 体型: "SIZ", 敏捷: "DEX", 智力: "INT", 灵感: "INT",
	意志: "POW", 外貌: "APP", 教育: "EDU", 幸运: "LUCK", 生命值: "HP", 理智: "SAN", 魔法值: "MP"
};
const STAT_KEYS = new Set(["STR", "CON", "SIZ", "DEX", "INT", "POW", "APP", "EDU", "LUCK", "HP", "SAN", "MP"]);

/** 提取文件文本，可选 onProgress(phase, message, percent) 回调报告进度。 */
async function extractFileText(filePath, onProgress) {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".pdf")) {
		if (onProgress) onProgress("reading", "读取 PDF 文件中…", 10);
		let PDFParse;
		try {
			PDFParse = (await import("pdf-parse")).PDFParse;
		} catch (error) {
			throw new Error(`无法加载 PDF 解析器（pdf-parse）：${error.message}；请确认插件依赖已安装`);
		}
		let parser;
		let text;
		try {
			parser = new PDFParse({ data: readFileSync(filePath) });
			if (onProgress) onProgress("extracting", "PDF 解析中，提取文本…", 40);
			const result = await parser.getText();
			text = result?.text;
		} catch (error) {
			throw new Error(`PDF 解析失败：${error.message}`);
		} finally {
			if (parser !== void 0) await parser.destroy().catch(() => {});
		}
		if (typeof text !== "string" || text.trim().length === 0) {
			throw new Error("PDF 未提取到可读文本（可能是扫描件/图片型 PDF，暂不支持 OCR）");
		}
		if (onProgress) onProgress("done", "PDF 文本提取完成", 60);
		return text;
	}
	if (lower.endsWith(".docx")) {
		if (onProgress) onProgress("reading", "读取 DOCX 文件中…", 10);
		const text = extractDocxText(filePath);
		if (onProgress) onProgress("done", "DOCX 文本提取完成", 60);
		return text;
	}
	if (lower.endsWith(".doc")) {
		if (onProgress) onProgress("reading", "读取 DOC 文件中…", 10);
		const text = extractDocLegacyText(filePath);
		if (onProgress) onProgress("done", "DOC 文本提取完成", 60);
		return text;
	}
	if (onProgress) onProgress("reading", "读取文本文件中…", 30);
	const text = readFileSync(filePath, "utf8");
	if (onProgress) onProgress("done", "文本文件读取完成", 60);
	return text;
}

//#region doc/docx 文本提取（无外部依赖）
/**
 * 最小 ZIP 读取器：只实现读取单个条目内容所需的部分
 * （EOCD 定位 → 中央目录 → 本地文件头 → 解压）。docx 即 ZIP 容器，
 * 正文在 word/document.xml（通常 deflate 压缩）。
 */
function readZipEntry(buffer, entryName) {
	// 1) 从文件尾部向前找 EOCD 签名 0x06054b50（注释最长 65535 字节）
	let eocd = -1;
	const minEocd = Math.max(0, buffer.length - 22 - 65535);
	for (let i = buffer.length - 22; i >= minEocd; i -= 1) {
		if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) throw new Error("不是有效的 docx（ZIP 结构缺失）");
	const entryCount = buffer.readUInt16LE(eocd + 10);
	const cdSize = buffer.readUInt32LE(eocd + 12);
	const cdOffset = buffer.readUInt32LE(eocd + 16);
	// 2) 遍历中央目录条目
	let pos = cdOffset;
	for (let i = 0; i < entryCount; i += 1) {
		if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error("docx 中央目录损坏");
		const method = buffer.readUInt16LE(pos + 10);
		const compSize = buffer.readUInt32LE(pos + 20);
		const nameLen = buffer.readUInt16LE(pos + 28);
		const extraLen = buffer.readUInt16LE(pos + 30);
		const commentLen = buffer.readUInt16LE(pos + 32);
		const localOffset = buffer.readUInt32LE(pos + 42);
		const name = buffer.toString("utf8", pos + 46, pos + 46 + nameLen);
		if (name === entryName) {
			// 3) 读本地文件头拿压缩数据
			const local = localOffset;
			if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("docx 本地文件头损坏");
			const localNameLen = buffer.readUInt16LE(local + 26);
			const localExtraLen = buffer.readUInt16LE(local + 28);
			const dataStart = local + 30 + localNameLen + localExtraLen;
			const data = buffer.subarray(dataStart, dataStart + compSize);
			if (method === 0) return data;
			if (method === 8) return inflateRawSync(data);
			throw new Error(`docx 使用不支持的压缩方式（${method}），请用 Word/WPS 另存为后再试`);
		}
		pos += 46 + nameLen + extraLen + commentLen;
	}
	throw new Error(`docx 中缺少 ${entryName}（文件可能已损坏）`);
}

/** 提取 docx 正文：拼接 word/document.xml 中所有 <w:t> 文本，段落换行。 */
function extractDocxText(filePath) {
	let buffer;
	try {
		buffer = readFileSync(filePath);
	} catch (error) {
		throw new Error(`读取文件失败：${error.message}`);
	}
	if (buffer.length < 4 || buffer.toString("ascii", 0, 4) !== "PK\u0003\u0004") {
		throw new Error("不是有效的 docx 文件（缺少 ZIP 头，请确认扩展名）");
	}
	let xml;
	try {
		xml = readZipEntry(buffer, "word/document.xml").toString("utf8");
	} catch (error) {
		throw new Error(`docx 解析失败：${error.message}`);
	}
	// 段落边界：</w:p> 换行；表格行 </w:tr> 换行
	const paragraphs = xml.split(/<\/w:p>|<\/w:tr>/i);
	const lines = [];
	for (const paragraph of paragraphs) {
		const texts = [];
		const regex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi;
		let match;
		while ((match = regex.exec(paragraph)) !== null) {
			texts.push(match[1]
				.replace(/<[^>]+>/g, "")           // 去掉嵌套标签（如 <w:tab/>）
				.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&").replace(/&quot;/g, "\"")
				.replace(/&apos;/g, "'"));
		}
		const line = texts.join("").replace(/\s+/g, " ").trim();
		if (line.length > 0) lines.push(line);
	}
	const text = lines.join("\n");
	if (text.trim().length === 0) throw new Error("docx 未提取到可读文本（可能是纯图片文档）");
	return text;
}

/** 尽力而为提取老版 .doc（OLE 二进制）：扫描 UTF-16LE 可读文本片段。 */
function extractDocLegacyText(filePath) {
	let buffer;
	try {
		buffer = readFileSync(filePath);
	} catch (error) {
		throw new Error(`读取文件失败：${error.message}`);
	}
	const isAsciiReadable = (code) =>
		code === 9 || code === 10 || code === 13 ||
		(code >= 32 && code <= 126);
	const isCjk = (code) =>
		(code >= 0x4e00 && code <= 0x9fff) ||   // CJK 统一表意
		(code >= 0x3000 && code <= 0x303f) ||   // CJK 标点
		(code >= 0xff00 && code <= 0xffef) ||   // 全角
		(code >= 0x3400 && code <= 0x4dbf);
	const isReadable = (code) => isAsciiReadable(code) || isCjk(code) || code === 0x20;
	// 按 UTF-16LE 成对扫描，收集连续可读序列
	const runs = [];
	let current = null;
	for (let i = 0; i + 1 < buffer.length; i += 2) {
		const code = buffer.readUInt16LE(i);
		if (isReadable(code)) {
			if (current === null) current = { start: i, chars: [] };
			current.chars.push(code);
		} else if (current !== null) {
			if (current.chars.length >= 2) {
				const chunk = String.fromCharCode(...current.chars);
				const cjkCount = current.chars.filter(isCjk).length;
				const readableRatio = cjkCount > 0 ? cjkCount / current.chars.length : 1;
				if (readableRatio >= 0.5) runs.push({ start: current.start, chunk });
			}
			current = null;
		}
	}
	// 合并间隔 < 3 字节的相邻片段，取最长连续块
	runs.sort((a, b) => a.start - b.start);
	const merged = [];
	for (const run of runs) {
		const last = merged[merged.length - 1];
		if (last !== void 0 && run.start - (last.start + last.chunk.length * 2) < 8) {
			last.chunk += run.chunk;
		} else {
			merged.push({ start: run.start, chunk: run.chunk });
		}
	}
	const blocks = merged.filter((m) => m.chunk.length >= 8).sort((a, b) => b.chunk.length - a.chunk.length);
	const best = blocks.slice(0, 12).sort((a, b) => a.start - b.start);
	const text = best.map((b) => b.chunk).join("\n");
	if (text.trim().length === 0) {
		throw new Error("未能从 .doc 提取到可读文本（老版二进制格式）。请用 Word/WPS 另存为 .docx 或 .txt 后再导入");
	}
	return text;
}
//#endregion

function parseCharacters(text) {
	return parseCharactersCore(text);
}
function normalizeCharacter(raw, index) {
	return normalizeCharacterCore(raw, index);
}

/** 剧本结构草稿：按行标记提取关键剧情点、分支与实体（NPC/地点/物品，供 KP 校对）。 */
function draftStructure(text, scenarioId) {
	const keyPoints = [];
	const branches = [];
	const entities = [];
	let currentScene = "";
	const sid = scenarioId || "";
	for (const raw of String(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		const scene = /^(?:【场景】|场景|SCENE)[：:\s]*(\d*)[：:\s]*(.*)$/i.exec(line);
		if (scene !== null && (scene[1] !== "" || scene[2] !== "")) {
			currentScene = scene[2] || `场景 ${scene[1]}`;
			continue;
		}
		const kp = /^(?:【关键剧情点】|关键剧情点|关键点|剧情点|KEY ?POINT)[：:\s]*(\S.+)$/i.exec(line);
		if (kp !== null) {
			keyPoints.push({ id: `kp-${keyPoints.length + 1}`, scene: currentScene, title: kp[1].trim(), desc: "", revealed: false, scenarioId: sid });
			continue;
		}
		const br = /^(?:【剧情分支】|【分支】|剧情分支|分支|选择点|BRANCH)[：:\s]*(\S.+)$/i.exec(line);
		if (br !== null) {
			branches.push({ id: `br-${branches.length + 1}`, scene: currentScene, title: br[1].trim(), desc: "", options: [], reached: false, chosen: null, scenarioId: sid });
			continue;
		}
		const ENTITY_MARKERS = [
			["npc", "【NPC】|【人物】|NPC|人物"],
			["location", "【地点】|地点|场所"],
			["item", "【物品】|【道具】|物品|道具"]
		];
		for (const [type, markers] of ENTITY_MARKERS) {
			const match = new RegExp(`^(?:${markers})[：:\\s]*(\\S.+)$`, "i").exec(line);
			if (match !== null) {
				entities.push({ id: `ent-${entities.length + 1}`, type, name: match[1].trim(), desc: "", state: "", scene: currentScene, scenarioId: sid });
				break;
			}
		}
	}
	return { keyPoints, branches, entities };
}
//#endregion

//#region 渲染辅助
function rollRenderLine(result) {
	const player = result.player ? ` · ${result.player}` : "";
	const label = result.label ? `（${result.label}）` : "";
	const target = result.target !== null ? ` 目标 ${result.target}${result.difficulty ? `（${DIFFICULTY_LABELS[result.difficulty]}）` : ""}` : "";
	const tier = result.tier !== null ? ` → ${TIER_LABELS[result.tier]}${result.passed ? " ✓" : ""}` : "";
	const dice = result.dice.length > 1 ? ` [${result.dice.join("+")}]` : "";
	return `掷 ${result.expression}${dice} = ${result.rolled}${target}${tier}`;
}
//#endregion

//#region 插件主体
function apply(ctx, config) {
	// 加载 .env 文件（如存在）
	const __dirname = join(dirname(fileURLToPath(import.meta.url)), "..");  // 插件根目录（lib/..）
	const envPath = join(__dirname, ".env");
	if (existsSync(envPath)) {
		const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			let value = trimmed.slice(eq + 1).trim();
			// 去除引号
			if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (key && !process.env[key]) {
				process.env[key] = value;
			}
		}
	}
	/** 工具定义表：供宿主 HTTP API（前端面板）复用同一套校验与逻辑。 */
	const defs = {};
	const dataDir = config.dataDir && config.dataDir.length > 0 ? config.dataDir : join(dshHome(), "coc");
	const defaultGame = config.defaultGame;
	const maxRollHistory = config.maxRollHistory;

	const gameId = (args, key = "game") => {
		const raw = args?.[key];
		return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : defaultGame;
	};
	const state = (args) => touchState(dataDir, gameId(args));
	const persist = (current) => saveState(dataDir, current);
	const pushRoll = (current, entry) => {
		current.rollHistory.push({ at: now(), ...entry });
		if (current.rollHistory.length > maxRollHistory) current.rollHistory = current.rollHistory.slice(-maxRollHistory);
	};

	const characterSchema = {
		type: "object",
		additionalProperties: true,
		properties: {
			name: { type: "string", description: "角色名（add 时必须；update 可省略以保留原名）" },
			player: { type: "string", description: "玩家名（可空）" },
			occupation: { type: "string", description: "职业" },
			stats: {
				type: "object",
				additionalProperties: true,
				description: "属性，键如 STR/CON/SIZ/DEX/INT/POW/APP/EDU/LUCK/HP/SAN/MP"
			},
			hp: { type: "number", description: "生命值" },
			san: { type: "number", description: "理智值" },
			mp: { type: "number", description: "魔法值" },
			luck: { type: "number", description: "幸运" },
			skills: { type: "object", additionalProperties: true, description: "技能名→数值，如 侦查:60" },
			inventory: { type: "array", items: { type: "string" }, description: "随身物品" },
			notes: { type: "string", description: "备注/背景" }
		}
	};

	
/** AI 智能解析剧本结构：调用 LLM 从自由文本中提取关键剧情点、分支、实体。 */
async function aiDraftStructure(text, scenarioId, onProgress) {
	// 获取默认模型配置（优先用 agent 默认模型，回退到插件配置）
	let provider = void 0;
	let model = void 0;
	const defaultModel = ctx.get("agentDefaultModel");
	if (defaultModel !== void 0 && typeof defaultModel.currentSelection === "function") {
		const selection = defaultModel.currentSelection();
		if (selection?.provider) provider = selection.provider;
		if (selection?.model) model = selection.model;
	}
	if (!provider) provider = config.llmProvider || "deepseek-official";
	if (!model) model = config.llmModel || "deepseek-v4-flash";
	
	const prompt = `你是一个克苏鲁的呼唤跑团剧本分析助手。请分析以下剧本内容，提取出结构化的游戏元素。

请严格按照以下 JSON 格式返回（不要加 Markdown 代码块标记，直接返回纯 JSON）：

{
  "keyPoints": [
    { "title": "关键剧情点标题", "scene": "所属场景（如未知留空）", "desc": "简要描述" }
  ],
  "branches": [
    { "title": "分支标题", "scene": "所属场景", "desc": "分支描述", "options": [{ "label": "选项1", "leadsTo": "导向场景" }] }
  ],
  "entities": [
    { "type": "npc|location|item", "name": "实体名称", "scene": "出现场景", "desc": "描述" }
  ]
}

要求：
1. keyPoints：提取重要的剧情节点、发现、事件、转折点（建议 3-10 个）
2. branches：提取关键的决策点/选择分支（建议 2-5 个），options 每个至少 2 个选项
3. entities：提取 NPC（npc）、重要地点（location）、关键物品（item）
4. 如果某个分类没有内容，返回空数组 []
5. 所有字段用中文
6. 不要返回任何额外文字，只返回 JSON

剧本内容：
${text.slice(0, 8000)}`;

	if (onProgress) onProgress("ai_parsing", "AI 智能解析剧本结构…", 75);
	
	let responseText = "";
	let llmError = null;
	try {
		// 调用 streamBlocks，它会自动处理 LLM 服务不可用时回退到配置的 API
		const result = await streamBlocks(ctx, {
			llmProvider: provider,
			llmModel: model,
			dataDir: dataDir
		}, {
			messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
		});
		
		
		if (result.finish?.kind === "error") {
			llmError = result.finish.failure?.message || "LLM 调用失败";
			console.error("[coc_import] AI 解析 LLM 错误:", llmError);
		} else {
			// 从 blocks 中提取文本
			for (const block of (result.blocks || [])) {
				if (block.type === "text") {
					responseText += block.text || "";
				}
			}
		}
	} catch (e) {
		console.error("[coc_import] AI 解析异常:", e.message);
		if (onProgress) onProgress("ai_parsing", "⚠️ AI 解析异常: " + e.message.slice(0, 60), 75);
		return { keyPoints: [], branches: [], entities: [] };
	}
	
	if (llmError) {
		if (onProgress) onProgress("ai_parsing", "⚠️ AI 解析失败: " + llmError.slice(0, 60), 75);
		return { keyPoints: [], branches: [], entities: [] };
	}
	
	const raw = responseText || "";
	if (raw.length === 0) {
		console.warn("[coc_import] AI 解析返回空响应");
		if (onProgress) onProgress("ai_parsing", "⚠️ AI 解析返回空，跳过", 75);
		return { keyPoints: [], branches: [], entities: [] };
	}
	
	// 尝试解析 JSON（可能包含 Markdown 代码块）
	let jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	const jsonStr = jsonMatch ? jsonMatch[1] : raw;
	
	try {
		const parsed = JSON.parse(jsonStr);
		const keyPoints = (parsed.keyPoints || []).map((kp, i) => ({
			id: `ai-kp-${i + 1}`,
			scene: kp.scene || "",
			title: kp.title || "未命名",
			desc: kp.desc || "",
			revealed: false,
			scenarioId: scenarioId || ""
		}));
		const branches = (parsed.branches || []).map((br, i) => ({
			id: `ai-br-${i + 1}`,
			scene: br.scene || "",
			title: br.title || "未命名",
			desc: br.desc || "",
			options: (br.options || []).map((o) => ({ label: o.label || "继续", leadsTo: o.leadsTo || "" })),
			reached: false,
			chosen: null,
			scenarioId: scenarioId || ""
		}));
		const entities = (parsed.entities || []).map((e, i) => ({
			id: `ai-ent-${i + 1}`,
			type: e.type || "other",
			name: e.name || "未命名",
			desc: e.desc || "",
			state: "",
			scene: e.scene || "",
			scenarioId: scenarioId || ""
		}));
		return { keyPoints, branches, entities };
	} catch (e) {
		console.error("[coc_import] AI 解析 JSON 解析失败:", e.message, "原始响应:", raw.slice(0, 200));
		if (onProgress) onProgress("ai_parsing", "⚠️ AI 返回格式异常，跳过", 75);
		return { keyPoints: [], branches: [], entities: [] };
	}
}
/** AI 兜底解析人物卡：把不规范文本解析成结构化人物数组。 */
	async function parseCharactersWithLlm(content, dataDir) {
		const prompt = [
			"你是 CoC 7e 人物卡解析器。把下面的文本解析成 JSON 数组，每个元素为：",
			'{"name":"姓名","occupation":"职业","stats":{"STR":50,"CON":50,"SIZ":50,"DEX":50,"INT":50,"POW":50,"APP":50,"EDU":50,"LUCK":50,"HP":10,"SAN":50,"MP":10},"skills":{"侦查":60},"inventory":["物品"],"notes":"备注"}',
			"只输出 JSON 数组，不要输出解释。属性值必须是数字；缺失的属性不要编造，留空对象即可。",
			"文本：\n" + content.slice(0, 6000)
		].join("\n");
		const result = await callLlmApi(dataDir, [
			{ role: "user", content: [{ type: "text", text: prompt }] }
		], { temperature: 0, max_tokens: 3000 });
		const rawText = (result.blocks ?? []).map((block) => block.text ?? "").join("");
		const match = /\[[\s\S]*\]/.exec(rawText);
		if (match === null) return [];
		const parsed = JSON.parse(match[0]);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item) => typeof item === "object" && item !== null && (item.name ?? "").length > 0);
	}

// ── coc_import：导入规则 / 剧本 / 人物（支持 PDF） ─────────────────────────
	defs['coc_import'] = defineTool({
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
			overwrite: { type: "boolean", description: "剧本/规则是否覆盖旧内容，人物是否按同名覆盖（默认 false 追加）" }
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
					preview: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `已导入${value.kind === "rules" ? "规则" : value.kind === "scenario" ? "剧本" : "人物"}「${value.name ?? ""}」到游戏 ${value.game}（${value.chars} 字符 / ${value.lines} 行）` +
					(value.characters > 0 ? `，人物 ${value.characters} 个` : "") +
					(value.keyPoints > 0 ? `，草拟关键剧情点 ${value.keyPoints} 个` : "") +
					(value.branches > 0 ? `，草拟分支 ${value.branches} 个` : "") +
					(value.entities > 0 ? `，草拟实体 ${value.entities} 个（NPC/地点/物品）` : "") +
					`\n预览：${value.preview}`
			}]
		},
		timeoutMs: 120000,
		async execute(args, execCtx) {
			const current = state(args);
			// 从执行上下文获取进度回调（供 HTTP SSE 端点使用）
			const onProgress = typeof execCtx?.onProgress === "function" ? execCtx.onProgress : null;
			const content = args.source === "file"
				? await extractFileText(args.filePath, onProgress)
				: String(args.text ?? "");
			if (content.trim().length === 0) throw new Error("导入内容为空");
			let kind = args.kind;
			if (kind === "auto") {
				const head = content.slice(0, 2000);
				if (head.trimStart().startsWith("[") || head.trimStart().startsWith("{")) kind = "characters";
				// 人物卡特征优先（角色卡/档案/属性缩写/姓名标签），避免误判为剧本
				else if (/(调查员档案|角色卡|人物卡|INVESTIGATOR DOSSIER|CHARACTER SHEET)/i.test(head)) kind = "characters";
				else if (/^(?:姓名|名字|名称|人物|NAME|Name)[：:\s]+/m.test(head) && /(?:STR|CON|SIZ|DEX|POW|APP|EDU|LUCK|SAN|HP|MP|力量|体质|体型|敏捷|意志|外貌|教育|幸运)/i.test(head)) kind = "characters";
				else if (/(?:STR|CON|SIZ|DEX|POW|APP|EDU|LUCK|SAN|HP|MP)\s*[:：]?\s*\d{1,3}/i.test(head) && /(力量|体质|体型|敏捷|意志|外貌|教育|幸运|职业|occupation)/i.test(head)) kind = "characters";
				// 剧本/剧情关键词（含 NPC 标记）
				else if (/(剧本|模组|场景|scenario|module|chapter|故事|剧情|npc|地点|物品|线索|秘密|调查)/i.test(head)) kind = "scenario";
				else if (/NPC[：:]/.test(head)) kind = "scenario";
				// 然后检查规则书关键词（仅当无剧本关键词时）
				else if (/(规则书|技能表|属性表|调查员手册)/i.test(head)) kind = "rules";
				else if (/(规则|技能|属性|调查员)/i.test(head)) kind = "rules";
				else kind = "scenario";
			}
			const chars = content.length;
			const lines = content.split(/\r?\n/).length;
			let nameText =
				typeof args.name === "string" && args.name.trim().length > 0
					? args.name.trim()
					: args.source === "file"
						? (typeof args.fileName === "string" && args.fileName.trim().length > 0
							? args.fileName.trim()
							: (args.filePath !== undefined && args.filePath !== null ? args.filePath.split(/[\\/]/).pop() : kind))
						: kind;
			let characters = 0;
			let keyPoints = 0;
			let branches = 0;
			let entities = 0;
			const preview = summarize(content, 200);
			if (kind === "rules") {
				if (args.overwrite === true || current.rules === null) {
					current.rules = { name: nameText, source: args.source, text: content, summary: summarize(content), chars, lines };
				} else {
					current.rules.text += `\n\n${content}`;
					current.rules.chars += chars;
					current.rules.lines += lines;
					current.rules.summary = summarize(current.rules.text);
				}
			} else if (kind === "scenario") {
				if (onProgress) onProgress("parsing", "解析剧本结构（关键剧情点/分支/实体）…", 70);
				let structure = draftStructure(content, nameText);
				if (onProgress) onProgress("ai_parsing", "AI 智能解析剧本结构…", 75);
				try {
					const aiStructure = await aiDraftStructure(content, nameText, onProgress)
					// 合并 AI 解析结果
					if (aiStructure.keyPoints.length > 0) structure.keyPoints = aiStructure.keyPoints;
					if (aiStructure.branches.length > 0) structure.branches = aiStructure.branches;
					if (aiStructure.entities.length > 0) structure.entities = aiStructure.entities;
					if (onProgress) onProgress("ai_parsing", "AI 解析完成，提取到 " + structure.keyPoints.length + " 个关键剧情点、" + structure.branches.length + " 个分支、" + structure.entities.length + " 个实体", 85);
				} catch (e) {
					console.error("[coc_import] AI 解析失败:", e.message);
					if (onProgress) onProgress("ai_parsing", "⚠️ AI 解析失败: " + e.message.slice(0, 80), 70);
				}if (args.overwrite === true || current.scenario === null) {
					current.scenario = { name: nameText, source: args.source, text: content, summary: summarize(content), chars, lines };
					// 清除旧剧本的同名关键剧情点/分支/实体（保留通用和他人剧本的）
					if (args.overwrite === true) {
						current.keyPoints = current.keyPoints.filter((k) => k.scenarioId !== nameText);
						current.branches = current.branches.filter((b) => b.scenarioId !== nameText);
						current.entities = current.entities.filter((e) => e.scenarioId !== nameText);
					}
					if (args.parseStructure !== false) {
						current.keyPoints.push(...structure.keyPoints);
						current.branches.push(...structure.branches);
						current.entities.push(...structure.entities);
					}
				} else {
					current.scenario.text += `

${content}`;
					current.scenario.chars += chars;
					current.scenario.lines += lines;
					current.scenario.summary = summarize(current.scenario.text);
					if (args.parseStructure !== false) {
						current.keyPoints.push(...structure.keyPoints);
						current.branches.push(...structure.branches);
						current.entities.push(...structure.entities);
					}
				}
				keyPoints = structure.keyPoints.length;
				branches = structure.branches.length;
				entities = structure.entities.length;
			} else if (kind === "rules") {
				if (onProgress) onProgress("parsing", "处理规则书内容…", 70);
			} else if (kind === "characters") {
				let parsed = parseCharacters(content);
				let normalized = parsed.map((raw, index) => normalizeCharacter(raw, index));
				// 确定性解析未识别出人物卡（或没有任何属性数值）时，用 LLM 兜底
				if (normalized.length === 0 || normalized.every((pc) => Object.keys(pc.stats ?? {}).length === 0)) {
					if (onProgress) onProgress("ai_parsing", "确定性解析未识别出人物卡，AI 解析中…", 60);
					try {
						const llmParsed = await parseCharactersWithLlm(content, dataDir);
						if (llmParsed.length > 0) {
							normalized = llmParsed.map((raw, index) => normalizeCharacter(raw, index));
							if (onProgress) onProgress("ai_parsing", "AI 已解析出 " + normalized.length + " 张人物卡", 80);
						} else if (onProgress) {
							onProgress("ai_parsing", "⚠️ AI 未能解析出结构化人物卡", 70);
						}
					} catch (e) {
						console.error("[coc_import] 人物卡 AI 解析失败:", e.message);
						if (onProgress) onProgress("ai_parsing", "⚠️ 人物卡 AI 解析失败：" + e.message.slice(0, 60), 70);
					}
				}
				for (const pc of normalized) {
					const existing = current.characters.find((c) => c.name === pc.name);
					if (existing !== void 0 && args.overwrite === true) {
						current.characters[current.characters.indexOf(existing)] = { ...existing, ...pc, id: existing.id };
					} else if (existing === void 0) {
						current.characters.push(pc);
					}
				}
				characters = normalized.length;
				nameText = nameText === "characters" ? "人物卡" : nameText;
			}
			if (onProgress) onProgress("saving", "保存数据中…", 90);
			persist(current);
			if (onProgress) onProgress("done", "导入完成", 100);
			return { kind, game: current.id, name: nameText, chars, lines, characters, keyPoints, branches, entities, preview };
		}
	});
	ctx.tools.register(defs['coc_import']);

	// ── coc_read：分段阅读已导入的规则/剧本全文 ──────────────────────────────
	defs['coc_read'] = defineTool({
		name: "coc_read",
		description: "分段阅读已导入的规则书或剧本全文（coc_import 只存摘要，需要细节时用本工具）。返回指定偏移的一段文本，配合 offset/limit 顺序阅读。",
		parameters: {
			what: { type: "string", enum: ["rules", "scenario"], required: true, description: "读取规则还是剧本" },
			game: { type: "string", description: "游戏 ID" },
			offset: { type: "integer", description: "起始字符偏移（默认 0）" },
			limit: { type: "integer", description: "本次返回的最大字符数（默认 4000，最大 20000）" }
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
					text: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `[${value.what === "rules" ? "规则" : "剧本"}「${value.name}」 第 ${value.offset + 1}-${value.end} 字符 / 共 ${value.totalChars}]\n${value.text}`
			}]
		},
		execute(args) {
			const current = state(args);
			const doc = args.what === "rules" ? current.rules : current.scenario;
			if (doc === null || doc === void 0) throw new Error(`尚未导入${args.what === "rules" ? "规则" : "剧本"}（请先调用 coc_import）`);
			const total = doc.text.length;
			const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)));
			const limit = Math.min(20000, Math.max(1, Math.floor(Number(args.limit ?? 4000))));
			const end = Math.min(total, offset + limit);
			return { what: args.what, name: doc.name, totalChars: total, offset, end, text: doc.text.slice(offset, end) };
		}
	});
	ctx.tools.register(defs['coc_read']);

	// ── coc_roll：明骰 ───────────────────────────────────────────────────────
	defs['coc_roll'] = defineTool({
		name: "coc_roll",
		description: "明骰（公开检定）：掷骰结果对所有人可见。支持任意骰式（d100、3d6、d20+2 等）。CoC 7e 中提供 target（技能值）与 difficulty（常规/困难/极限）时按 7e 规则判定成功档次（含大成功/大失败）。玩家提出的检定一律用本工具，不要自行编造结果。",
		parameters: {
			expression: { type: "string", required: true, description: "骰式，如 d100、3d6、d20+2" },
			target: { type: "number", description: "目标技能值（如 60）；百分骰时按 CoC 7e 分档判定" },
			difficulty: { type: "string", enum: ["regular", "hard", "extreme"], description: "检定难度：常规/困难/极限" },
			player: { type: "string", description: "掷骰人（玩家名或 NPC 名）" },
			label: { type: "string", description: "检定说明，如「侦查走廊」" },
			skill: { type: "string", description: "技能名（记录用），如「侦查」" },
			game: { type: "string", description: "游戏 ID" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					expression: { type: "string" },
					dice: { type: "array", items: { type: "integer" } },
					rolled: { type: "integer" },
					total: { type: "integer" },
					target: { type: "number" },
					difficulty: { type: "string" },
					tier: { type: "string" },
					passed: { type: "boolean" },
					player: { type: "string" },
					label: { type: "string" }
				}
			},
			render: (args, value) => [{
				type: "text",
				text: `🎲【明骰】${value.player ? `${value.player} ` : ""}${value.label ? `· ${value.label} ` : ""}${rollRenderLine({ ...value, expression: value.expression })}`
			}],
			presentCall: (args) => ({ card: "generic", title: "明骰", kind: "掷骰", rawInput: `${args.player ?? ""} ${args.label ?? ""} ${args.expression}` })
		},
		execute(args) {
			const current = state(args);
			const result = performRoll(args.expression, args.target, args.difficulty);
			const outcome = {
				expression: args.expression,
				dice: result.dice,
				rolled: result.rolled,
				total: result.total,
				target: result.target,
				difficulty: result.difficulty ?? "regular",
				tier: result.tier,
				passed: result.passed,
				player: args.player ?? "",
				label: args.label ?? ""
			};
			pushRoll(current, {
				kind: "open",
				player: args.player ?? "",
				label: args.label ?? "",
				skill: args.skill ?? "",
				expression: args.expression,
				rolled: result.rolled,
				target: result.target,
				difficulty: result.difficulty ?? "regular",
				tier: result.tier
			});
			persist(current);
			return outcome;
		}
	});
	ctx.tools.register(defs['coc_roll']);

	// ── coc_roll_secret：暗骰 ────────────────────────────────────────────────
	defs['coc_roll_secret'] = defineTool({
		name: "coc_roll_secret",
		description: "暗骰（秘密检定）：只有 KP 能看到具体数值，玩家只应看到效果描述。用于潜行、侦查陷阱、灵感、NPC 暗判定等不应让玩家知道结果的场合。调用后请勿向玩家透露具体骰值与成功档位，只描述剧情效果。",
		parameters: {
			expression: { type: "string", required: true, description: "骰式，如 d100、3d6、d20+2" },
			target: { type: "number", description: "目标技能值（如 60）；百分骰时按 CoC 7e 分档判定" },
			difficulty: { type: "string", enum: ["regular", "hard", "extreme"], description: "检定难度" },
			player: { type: "string", description: "掷骰人（玩家名或 NPC 名）" },
			label: { type: "string", description: "检定说明" },
			skill: { type: "string", description: "技能名（记录用）" },
			game: { type: "string", description: "游戏 ID" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					expression: { type: "string" },
					dice: { type: "array", items: { type: "integer" } },
					rolled: { type: "integer" },
					total: { type: "integer" },
					target: { type: "number" },
					difficulty: { type: "string" },
					tier: { type: "string" },
					passed: { type: "boolean" },
					player: { type: "string" },
					label: { type: "string" },
					secret: { type: "boolean" }
				}
			},
			render: (args, value) => [{
				type: "text",
				text: `🔒【暗骰】${value.label ? `· ${value.label} ` : ""}${rollRenderLine({ ...value, expression: value.expression })}\n（此结果仅 KP 可见，请勿向玩家透露具体数值）`
			}],
			presentCall: (args) => ({ card: "generic", title: "暗骰", kind: "秘密检定", rawInput: `${args.label ?? ""} ${args.expression}` })
		},
		execute(args) {
			const current = state(args);
			const result = performRoll(args.expression, args.target, args.difficulty);
			const outcome = {
				expression: args.expression,
				dice: result.dice,
				rolled: result.rolled,
				total: result.total,
				target: result.target,
				difficulty: result.difficulty ?? "regular",
				tier: result.tier,
				passed: result.passed,
				player: args.player ?? "",
				label: args.label ?? "",
				secret: true
			};
			pushRoll(current, {
				kind: "secret",
				player: args.player ?? "",
				label: args.label ?? "",
				skill: args.skill ?? "",
				expression: args.expression,
				rolled: result.rolled,
				target: result.target,
				difficulty: result.difficulty ?? "regular",
				tier: result.tier
			});
			persist(current);
			return outcome;
		}
	});
	ctx.tools.register(defs['coc_roll_secret']);

	// ── coc_query_rule：查询规则（渐进式披露，替代嵌入完整规则文本） ─────────
	defs['coc_query_rule'] = defineTool({
		name: "coc_query_rule",
		description: "查询 CoC 7e 规则详情。当你需要了解某个具体规则的数值、判定方式或流程时调用此工具，而不是凭记忆自行编造。支持按主题查询（技能、战斗、理智、属性、职业、装备、治疗等）。",
		parameters: {
			game: { type: "string", description: "游戏 ID" },
			topic: { type: "string", required: true, description: "查询主题，如「技能列表」「理智损失」「战斗规则」「伤害加值」「职业模板」「急救」「克苏鲁神话」" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { topic: { type: "string" }, text: { type: "string" }, source: { type: "string" } } },
			render: (_args, value) => [{ type: "text", text: `【规则查询：${value.topic}】\n${value.text}` }],
			presentCall: () => ({ card: "generic", title: "规则查询", kind: "查询", rawInput: "" })
		},
		execute(args) {
			const current = state(args);
			const rulesText = current.rules?.text || BUILTIN_RULES_TEXT || "";
			const topic = String(args.topic ?? "").trim().toLowerCase();
			
			// 按主题关键词分段查找
			const sections = [];
			const lines = rulesText.split("\n");
			let currentSection = "";
			let currentHeading = "";
			for (const line of lines) {
				if (line.startsWith("## ")) {
					if (currentSection.length > 0) {
						sections.push({ heading: currentHeading, text: currentSection.trim() });
					}
					currentHeading = line.replace(/^##\s+/, "").trim();
					currentSection = line + "\n";
				} else if (line.startsWith("### ")) {
					if (currentSection.length > 0) {
						sections.push({ heading: currentHeading, text: currentSection.trim() });
					}
					currentHeading = line.replace(/^###\s+/, "").trim();
					currentSection = line + "\n";
				} else {
					currentSection += line + "\n";
				}
			}
			if (currentSection.length > 0) {
				sections.push({ heading: currentHeading, text: currentSection.trim() });
			}
			
			// 匹配主题关键词
			const keywords = topic.split(/[\s,，、]+/).filter(k => k.length > 0);
			const matched = sections.filter(sec => {
				const lower = (sec.heading + " " + sec.text).toLowerCase();
				return keywords.some(k => k.length >= 2 && lower.includes(k));
			});
			
			if (matched.length === 0) {
				// 返回所有一级标题作为索引
				const headings = sections.filter(s => !s.heading.startsWith(" "))
					.map(s => `- ${s.heading}`).join("\n");
				return {
					topic: args.topic,
					text: `未找到「${args.topic}」的精确匹配。以下为规则目录，请选择具体主题重新查询：\n\n${headings}`,
					source: current.rules?.name || "内置规则"
				};
			}
			
			const result = matched.map(m => m.text).join("\n\n---\n\n");
			return {
				topic: args.topic,
				text: result.length > 3000 ? result.slice(0, 3000) + "\n\n…（结果过长已截断，请缩小查询范围）" : result,
				source: current.rules?.name || "内置规则"
			};
		}
	});
	ctx.tools.register(defs['coc_query_rule']);

	// ── coc_sanity_check：理智检定（SAN 损失、疯狂判定） ─────────────────────
	defs['coc_sanity_check'] = defineTool({
		name: "coc_sanity_check",
		description: "执行理智检定：根据 SAN 损失值（如「0/1d3」「1/1d6+1」）进行掷骰判定，自动应用 SAN 损失，检查是否触发临时性/不定性疯狂，并更新人物状态。适用于看到神话生物、恐怖场景、超自然事件等场合。",
		parameters: {
			game: { type: "string", description: "游戏 ID" },
			player: { type: "string", required: true, description: "调查员姓名" },
			sanLoss: { type: "string", required: true, description: "SAN 损失格式，如「0/1d3」表示成功损失 0、失败损失 1d3；「1/1d6+1」表示成功损失 1、失败损失 1d6+1；也可直接写固定值如「1d3」" },
			description: { type: "string", description: "导致 SAN 损失的事件描述，如「目睹深潜者」" },
			difficulty: { type: "string", enum: ["regular", "hard", "extreme"], description: "检定难度（默认常规）" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { player: { type: "string" }, result: { type: "string" }, sanLost: { type: "number" }, sanBefore: { type: "number" }, sanAfter: { type: "number" }, madness: { type: "string" }, rolled: { type: "number" }, tier: { type: "string" } } },
			render: (_args, value) => [{ type: "text", text: `【理智检定】${value.player}：${value.result}` }],
			presentCall: () => ({ card: "generic", title: "理智检定", kind: "SAN", rawInput: "" })
		},
		execute(args) {
			const current = state(args);
			const playerName = String(args.player ?? "").trim();
			const pc = current.characters.find((c) => c.name === playerName);
			if (pc === void 0) throw new Error(`未找到调查员「${playerName}」`);
			
			const sanLossStr = String(args.sanLoss ?? "").trim();
			const difficulty = args.difficulty || "regular";
			const san = pc.san ?? pc.stats?.SAN ?? 50;
			
			// 解析 SAN 损失格式
			let successLoss = 0;
			let failLoss = 0;
			let successLossExpr = "0";
			let failLossExpr = "0";
			
			const slashIdx = sanLossStr.indexOf("/");
			if (slashIdx >= 0) {
				successLossExpr = sanLossStr.slice(0, slashIdx).trim() || "0";
				failLossExpr = sanLossStr.slice(slashIdx + 1).trim();
			} else {
				failLossExpr = sanLossStr;
				successLossExpr = "0";
			}
			
			// 掷骰
			const rolled = Math.floor(Math.random() * 100) + 1;
			const target = san;
			const half = Math.floor(target / 2);
			const fifth = Math.floor(target / 5);
			
			let tier;
			if (rolled <= fifth) tier = "critical";
			else if (rolled <= half) tier = "hard";
			else if (rolled <= target) tier = "regular";
			else if (rolled >= 96) tier = "fumble";
			else tier = "fail";
			if (rolled === 1) tier = "critical";
			else if (target < 50 && rolled <= 5 && rolled <= target) tier = "critical";
			
			const passed = tier === "critical" || tier === "extreme" || tier === "hard" || tier === "regular";
			
			// 计算实际损失
			const lossExpr = passed ? successLossExpr : failLossExpr;
			let loss = 0;
			if (lossExpr.length > 0) {
				// 解析骰式如 1d3, 1d6+1
				const diceMatch = lossExpr.match(/(\d+)d(\d+)(?:\s*[+-]\s*(\d+))?/);
				if (diceMatch) {
					const count = parseInt(diceMatch[1], 10);
					const sides = parseInt(diceMatch[2], 10);
					const mod = diceMatch[3] ? parseInt(diceMatch[3], 10) : 0;
					for (let i = 0; i < count; i++) loss += Math.floor(Math.random() * sides) + 1;
					loss += mod;
				} else {
					loss = parseInt(lossExpr, 10) || 0;
				}
			}
			
			const sanBefore = san;
			const sanAfter = Math.max(0, san - loss);
			pc.san = sanAfter;
			if (pc.stats) pc.stats.SAN = sanAfter;
			
			// 疯狂判定
			let madness = "无";
			if (loss >= 5 && sanAfter > 0) {
				// 临时性疯狂：INT 检定
				const intVal = pc.stats?.INT ?? 50;
				const intRoll = Math.floor(Math.random() * 100) + 1;
				if (intRoll > intVal) {
					madness = `临时性疯狂（INT 检定失败，出目 ${intRoll}/${intVal}）`;
				} else {
					madness = `临时性疯狂（已通过 INT 检定，出目 ${intRoll}/${intVal}）——暂未陷入疯狂，但 SAN 损失巨大`;
				}
			}
			if (loss >= san * 0.2 && sanAfter > 0) {
				madness = `不定性疯狂（24 小时内损失 ${loss} ≥ ${Math.floor(san * 0.2)}）`;
			}
			if (sanAfter <= 0) {
				madness = "永久性疯狂（SAN 归零）";
			}
			
			persist(current);
			
			const tierLabel = TIER_LABELS[tier] || tier;
			const resultStr = `${passed ? "成功" : "失败"}（出目 ${rolled}/${target}，${tierLabel}）${loss > 0 ? `，损失 ${loss} SAN（${sanBefore} → ${sanAfter}）` : "，未损失 SAN"}${madness !== "无" ? `\n⚡ ${madness}` : ""}`;
			
			return {
				player: playerName,
				result: resultStr,
				sanLost: loss,
				sanBefore,
				sanAfter,
				madness,
				rolled,
				tier
			};
		}
	});
	ctx.tools.register(defs['coc_sanity_check']);

	// ── coc_combat_resolve：战斗结算 ─────────────────────────────────────────
	defs['coc_combat_resolve'] = defineTool({
		name: "coc_combat_resolve",
		description: "执行战斗回合结算：攻击方对防御方进行一次攻击判定，包含命中检定、闪避/反击、伤害掷骰（含伤害加值 DB）、护甲减免，并自动更新双方 HP 状态。适用于近战和远程战斗。",
		parameters: {
			game: { type: "string", description: "游戏 ID" },
			attacker: { type: "string", required: true, description: "攻击方名称（调查员或 NPC 实体名）" },
			defender: { type: "string", required: true, description: "防御方名称" },
			weapon: { type: "string", description: "武器名，如「格斗（斗殴）」「.38 左轮手枪」「猎刀」" },
			skill: { type: "string", description: "使用的技能，如「格斗（斗殴）」「射击（手枪）」；缺省根据武器自动推断" },
			attackerIsEntity: { type: "boolean", description: "攻击方是否为 NPC 实体（而非调查员）" },
			defenderIsEntity: { type: "boolean", description: "防御方是否为 NPC 实体" },
			defenderDodge: { type: "boolean", description: "防御方是否尝试闪避" },
			range: { type: "string", enum: ["point-blank", "close", "medium", "far", "extreme"], description: "远程攻击的射程（point-blank=近距/close=中距/medium=远距/far=极远/extreme=超远）" },
			cover: { type: "string", description: "防御方掩蔽情况，如「半身掩体」「全掩体」" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { result: { type: "string" }, hit: { type: "boolean" }, damage: { type: "number" }, hpBefore: { type: "number" }, hpAfter: { type: "number" }, attackerRoll: { type: "number" }, defenderRoll: { type: "number" }, details: { type: "string" } } },
			render: (_args, value) => [{ type: "text", text: `【战斗结算】${value.result}` }],
			presentCall: () => ({ card: "generic", title: "战斗结算", kind: "战斗", rawInput: "" })
		},
		execute(args) {
			const current = state(args);
			const attackerName = String(args.attacker ?? "").trim();
			const defenderName = String(args.defender ?? "").trim();
			const weapon = String(args.weapon ?? "格斗（斗殴）").trim();
			const skill = String(args.skill ?? "").trim();
			const range = args.range || "close";
			const defenderDodge = args.defenderDodge === true;
			
			// 查找攻击方和防御方的技能值
			const attacker = args.attackerIsEntity
				? current.entities.find((e) => e.name === attackerName)
				: current.characters.find((c) => c.name === attackerName);
			const defender = args.defenderIsEntity
				? current.entities.find((e) => e.name === defenderName)
				: current.characters.find((c) => c.name === defenderName);
			
			if (attacker === void 0) throw new Error(`未找到攻击方「${attackerName}」`);
			if (defender === void 0) throw new Error(`未找到防御方「${defenderName}」`);
			
			// 获取攻击技能值
			let attackSkill = 25; // 默认
			if (skill) {
				attackSkill = attacker.skills?.[skill] || 25;
			} else {
				// 根据武器推断
				const weaponSkillMap = {
					"格斗（斗殴）": "格斗（斗殴）",
					"拳": "格斗（斗殴）",
					"踢": "格斗（斗殴）",
					"剑": "格斗（剑）",
					"刀": "格斗（剑）",
					"斧": "格斗（斧）",
					"矛": "格斗（矛）",
					"手枪": "射击（手枪）",
					".38": "射击（手枪）",
					".45": "射击（手枪）",
					"步枪": "射击（步枪/霰弹枪）",
					"霰弹": "射击（步枪/霰弹枪）",
					"冲锋枪": "射击（冲锋枪）",
					"机枪": "射击（机枪）",
					"投掷": "投掷",
					"弓": "射击（步枪/霰弹枪）"
				};
				const matchedKey = Object.keys(weaponSkillMap).find(k => weapon.includes(k));
				const skillName = matchedKey ? weaponSkillMap[matchedKey] : "格斗（斗殴）";
				attackSkill = attacker.skills?.[skillName] || 25;
			}
			
			// 攻击检定
			const attackRoll = Math.floor(Math.random() * 100) + 1;
			const half = Math.floor(attackSkill / 2);
			const fifth = Math.floor(attackSkill / 5);
			
			let attackTier;
			if (attackRoll <= fifth) attackTier = "critical";
			else if (attackRoll <= half) attackTier = "hard";
			else if (attackRoll <= attackSkill) attackTier = "regular";
			else if (attackRoll >= 96) attackTier = "fumble";
			else attackTier = "fail";
			if (attackRoll === 1) attackTier = "critical";
			else if (attackSkill < 50 && attackRoll <= 5 && attackRoll <= attackSkill) attackTier = "critical";
			
			const hit = attackTier === "critical" || attackTier === "hard" || attackTier === "regular";
			
			// 闪避判定
			let defenderRoll = 0;
			let dodgeSuccess = false;
			if (defenderDodge && hit) {
				const dodgeSkill = (defender.skills?.["闪避"] || 50);
				defenderRoll = Math.floor(Math.random() * 100) + 1;
				dodgeSuccess = defenderRoll <= dodgeSkill;
			}
			
			// 伤害计算
			let damage = 0;
			let damageExpr = "1d3";
			const weaponDamage = {
				"格斗（斗殴）": "1d3", "拳": "1d3", "踢": "1d3",
				"格斗（剑）": "1d8", "刀": "1d6", "猎刀": "1d4+2",
				"格斗（斧）": "1d8+1", "斧": "1d8+1",
				"格斗（矛）": "1d6", "矛": "1d6",
				"格斗（鞭）": "1d2",
				"格斗（链锯）": "2d8",
				"投掷": "1d4",
				".22 手枪": "1d6", ".32 手枪": "1d8", ".38 手枪": "1d10", ".45 手枪": "1d10+2",
				"9mm 手枪": "1d10",
				"步枪": "2d6", ".22 步枪": "1d6+1", ".30 步枪": "2d6+2",
				"霰弹枪": "4d6/2d6/1d6", "霰弹": "4d6/2d6/1d6",
				"冲锋枪": "1d10",
				"机枪": "2d6+2"
			};
			const matchedWeapon = Object.keys(weaponDamage).find(k => weapon.includes(k));
			damageExpr = matchedWeapon ? weaponDamage[matchedWeapon] : "1d3";
			
			// 处理霰弹枪射程递减
			if (damageExpr.includes("/")) {
				const parts = damageExpr.split("/");
				if (range === "point-blank" || range === "close") damageExpr = parts[0];
				else if (range === "medium") damageExpr = parts[1] || parts[0];
				else damageExpr = parts[2] || parts[0];
			}
			
			// 掷伤害
			const diceMatch = damageExpr.match(/(\d+)d(\d+)(?:\s*[+-]\s*(\d+))?/);
			if (diceMatch) {
				const count = parseInt(diceMatch[1], 10);
				const sides = parseInt(diceMatch[2], 10);
				const mod = diceMatch[3] ? parseInt(diceMatch[3], 10) : 0;
				for (let i = 0; i < count; i++) damage += Math.floor(Math.random() * sides) + 1;
				damage += mod;
			}
			
			// 伤害加值 DB（仅近战和投掷）
			const isRanged = ["手枪", "步枪", "霰弹", "冲锋枪", "机枪"].some(k => weapon.includes(k));
			if (!isRanged && attacker.stats) {
				const str = attacker.stats.STR || 50;
				const siz = attacker.stats.SIZ || 50;
				const strSiz = str + siz;
				let db = 0;
				if (strSiz <= 64) db = -Math.floor(Math.random() * 4) + 1;
				else if (strSiz <= 84) db = 0;
				else if (strSiz <= 124) { db = Math.floor(Math.random() * 4) + 1; }
				else if (strSiz <= 164) { db = Math.floor(Math.random() * 6) + 1; }
				else if (strSiz <= 204) { db = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1; }
				else { db = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1; }
				damage += db;
				if (damage < 0) damage = 0;
			}
			
			// 成功档次加伤
			if (attackTier === "critical") damage = Math.max(damage, damageExpr.match(/\d+/) ? parseInt(damageExpr.match(/\d+/)[0]) : 1);
			
			// 最终伤害
			let finalDamage = dodgeSuccess ? 0 : damage;
			if (finalDamage < 0) finalDamage = 0;
			
			// 更新防御方 HP
			const hpKey = args.defenderIsEntity ? "state" : "hp";
			const hpBefore = defender.hp ?? defender.stats?.HP ?? 10;
			const hpAfter = Math.max(0, hpBefore - finalDamage);
			
			if (args.defenderIsEntity) {
				defender.state = `受伤（HP: ${hpAfter}）`;
			} else {
				defender.hp = hpAfter;
				if (defender.stats) defender.stats.HP = hpAfter;
			}
			
			persist(current);
			
			const tierLabel = TIER_LABELS[attackTier] || attackTier;
			let details = `攻击方 ${attackerName}（${weapon}，技能 ${attackSkill}）→ 出目 ${attackRoll}（${tierLabel}）`;
			if (defenderDodge && hit) {
				details += `\n防御方 ${defenderName} 尝试闪避 → 出目 ${defenderRoll}${dodgeSuccess ? "（成功）" : "（失败）"}`;
			}
			if (hit && !dodgeSuccess) {
				details += `\n伤害 ${damageExpr}${!isRanged ? ` + DB` : ""} = ${damage} → 实际伤害 ${finalDamage}`;
				details += `\n${defenderName} HP：${hpBefore} → ${hpAfter}`;
			} else if (hit && dodgeSuccess) {
				details += `\n闪避成功，未造成伤害`;
			} else {
				details += `\n未命中`;
			}
			
			return {
				result: `${hit && !dodgeSuccess ? "命中" : hit ? "被闪避" : "未命中"}${hit && !dodgeSuccess ? `，造成 ${finalDamage} 点伤害` : ""}`,
				hit: hit && !dodgeSuccess,
				damage: finalDamage,
				hpBefore,
				hpAfter,
				attackerRoll: attackRoll,
				defenderRoll,
				details
			};
		}
	});
	ctx.tools.register(defs['coc_combat_resolve']);

	// ── coc_skill_growth：技能成长 ───────────────────────────────────────────
	defs['coc_skill_growth'] = defineTool({
		name: "coc_skill_growth",
		description: "在冒险结束时，为调查员尝试技能成长：在技能旁打勾标记，掷 d100 若大于当前技能值则增加 1d10。适用于冒险结束阶段或 KP 允许的时机。",
		parameters: {
			game: { type: "string", description: "游戏 ID" },
			player: { type: "string", required: true, description: "调查员姓名" },
			skill: { type: "string", required: true, description: "技能名称，如「侦查」「潜行」「格斗（斗殴）」" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { player: { type: "string" }, skill: { type: "string" }, before: { type: "number" }, after: { type: "number" }, rolled: { type: "number" }, grown: { type: "boolean" }, result: { type: "string" } } },
			render: (_args, value) => [{ type: "text", text: `【技能成长】${value.player} - ${value.skill}：${value.result}` }],
			presentCall: () => ({ card: "generic", title: "技能成长", kind: "成长", rawInput: "" })
		},
		execute(args) {
			const current = state(args);
			const playerName = String(args.player ?? "").trim();
			const skillName = String(args.skill ?? "").trim();
			const pc = current.characters.find((c) => c.name === playerName);
			if (pc === void 0) throw new Error(`未找到调查员「${playerName}」`);
			if (!pc.skills) pc.skills = {};
			
			const before = pc.skills[skillName] || 0;
			const rolled = Math.floor(Math.random() * 100) + 1;
			let grown = false;
			let after = before;
			if (rolled > before) {
				const gain = Math.floor(Math.random() * 10) + 1;
				after = before + gain;
				pc.skills[skillName] = after;
				grown = true;
			}
			
			persist(current);
			
			const resultStr = grown
				? `成功！出目 ${rolled} > ${before}，技能提升 ${after - before} 点（${before} → ${after}）`
				: `失败。出目 ${rolled} ≤ ${before}，技能未提升（仍为 ${before}）`;
			
			return { player: playerName, skill: skillName, before, after, rolled, grown, result: resultStr };
		}
	});
	ctx.tools.register(defs['coc_skill_growth']);

	// ── coc_status：KP 全局状态视图 ──────────────────────────────────────────
	defs['coc_status'] = defineTool({
		name: "coc_status",
		description: "查看跑团全局状态（KP 面板）：当前场景、当前分支与选项、关键剧情点（已揭示/未揭示）、分支列表、人物卡、待触发提醒、最近骰点。KP 在推进剧情、场景切换后调用，以掌握关键剧情点与当前剧情分支；重要分支点临近时主动提醒玩家。",
		parameters: {
			game: { type: "string", description: "游戏 ID" },
			view: { type: "string", enum: ["overview", "plot", "characters", "rolls", "reminders", "all"], description: "视图：overview 总览（默认）/ plot 剧情结构 / characters 人物 / rolls 骰点 / reminders 提醒 / all 全部" },
			includeSecretRolls: { type: "boolean", description: "骰点视图是否包含暗骰记录（默认 false，暗骰仅 KP 可看）" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					game: { type: "string" },
					title: { type: "string" },
					kpMode: { type: "string" },
					currentScene: { type: "string" },
					currentBranch: { type: "object", additionalProperties: true },
					rules: { type: "string" },
					scenario: { type: "string" },
					characters: { type: "array", items: { type: "object", additionalProperties: true } },
					keyPoints: { type: "array", items: { type: "object", additionalProperties: true } },
					branches: { type: "array", items: { type: "object", additionalProperties: true } },
					reminders: { type: "array", items: { type: "object", additionalProperties: true } },
					recentRolls: { type: "array", items: { type: "object", additionalProperties: true } }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderStatus(value)
			}],
			presentCall: () => ({ card: "generic", title: "KP 状态面板", kind: "查看", rawInput: "" })
		},
		execute(args) {
			const current = state(args);
			const view = args.view ?? "overview";
			const output = {
				game: current.id,
				title: current.title,
				kpMode: current.kpMode,
				currentScene: current.currentScene
			};
			if (current.currentBranchId) {
				const branch = findBranch(current, current.currentBranchId);
				if (branch !== null) output.currentBranch = branch;
			}
			if (current.rules !== null) output.rules = current.rules.name;
			if (current.scenario !== null) output.scenario = current.scenario.name;
			if (view === "plot" || view === "all") {
				output.keyPoints = current.keyPoints;
				output.branches = current.branches;
			}
			if (view === "characters" || view === "all") output.characters = current.characters;
			if (view === "reminders" || view === "all") output.reminders = current.reminders;
			if (view === "rolls" || view === "all" || view === "overview") {
				output.recentRolls = current.rollHistory
					.filter((roll) => args.includeSecretRolls === true || roll.kind !== "secret")
					.slice(-8)
					.reverse();
			}
			if (view === "overview") {
				output.keyPoints = current.keyPoints;
				output.branches = current.branches;
			}
			return output;
		}
	});
	ctx.tools.register(defs['coc_status']);

	// ── coc_branch：关键剧情点与分支管理 ─────────────────────────────────────
	defs['coc_branch'] = defineTool({
		name: "coc_branch",
		description: "管理剧本的关键剧情点与剧情分支（KP 专用）：add 添加、update 修改、remove 删除、list 列出、reached 标记某分支已抵达并设为当前分支、choose 记录玩家在某分支的选择并推进场景、reveal 揭示某个关键剧情点。剧本导入时 coc_import 会草拟结构，可用本工具校对修正。",
		parameters: {
			action: { type: "string", enum: ["add", "update", "remove", "list", "reached", "choose", "reveal"], required: true, description: "操作" },
			type: { type: "string", enum: ["branch", "keypoint"], description: "add/update/remove 的对象类型" },
			game: { type: "string", description: "游戏 ID" },
			item: {
				type: "object",
				additionalProperties: true,
				description: "add/update 的内容。分支：{id?, title, scene?, desc?, options:[{label, leadsTo?}]}；关键点：{id?, title, scene?, desc?}"
			},
			branchId: { type: "string", description: "分支 ID（reached/choose/update/remove 用）" },
			keyPointId: { type: "string", description: "关键点 ID（reveal/update/remove 用）" },
			optionLabel: { type: "string", description: "choose 时玩家所选选项的 label" },
			nextScene: { type: "string", description: "choose 时推进到的下一个场景名" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string" },
					game: { type: "string" },
					message: { type: "string" },
					keyPoints: { type: "array", items: { type: "object", additionalProperties: true } },
					branches: { type: "array", items: { type: "object", additionalProperties: true } },
					currentScene: { type: "string" },
					currentBranchId: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `[剧情结构] ${value.message}\n当前场景：${value.currentScene ?? ""}${value.currentBranchId ? ` · 当前分支：${value.currentBranchId}` : ""}\n关键剧情点 ${value.keyPoints?.length ?? 0} 个，分支 ${value.branches?.length ?? 0} 个`
			}]
		},
		execute(args) {
			const current = state(args);
			const action = args.action;
			let message = "";
			if (action === "add") {
				if (args.type === "keypoint") {
					const item = args.item ?? {};
					const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `kp-${current.keyPoints.length + 1}`;
					if (current.keyPoints.some((k) => k.id === id)) throw new Error(`关键剧情点 ${id} 已存在`);
					current.keyPoints.push({ id, scene: item.scene ?? current.currentScene, title: String(item.title ?? "未命名关键点"), desc: String(item.desc ?? ""), revealed: false });
					message = `已添加关键剧情点「${item.title}」`;
				} else {
					const item = args.item ?? {};
					const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `br-${current.branches.length + 1}`;
					if (current.branches.some((b) => b.id === id)) throw new Error(`分支 ${id} 已存在`);
					const options = Array.isArray(item.options) ? item.options.map((o, i) => ({ id: `opt-${i + 1}`, label: String(o.label ?? `选项${i + 1}`), leadsTo: typeof o.leadsTo === "string" ? o.leadsTo : "" })) : [];
					current.branches.push({ id, scene: item.scene ?? current.currentScene, title: String(item.title ?? "未命名分支"), desc: String(item.desc ?? ""), options, reached: false, chosen: null });
					message = `已添加分支「${item.title}」（${options.length} 个选项）`;
				}
			} else if (action === "update") {
				if (args.type === "keypoint") {
					const target = findKeyPoint(current, args.keyPointId);
					if (target === null) throw new Error(`关键剧情点 ${args.keyPointId} 不存在`);
					const item = args.item ?? {};
					if (item.title !== void 0) target.title = String(item.title);
					if (item.desc !== void 0) target.desc = String(item.desc);
					if (item.scene !== void 0) target.scene = String(item.scene);
					message = `已更新关键剧情点 ${target.id}`;
				} else {
					const target = findBranch(current, args.branchId);
					if (target === null) throw new Error(`分支 ${args.branchId} 不存在`);
					const item = args.item ?? {};
					if (item.title !== void 0) target.title = String(item.title);
					if (item.desc !== void 0) target.desc = String(item.desc);
					if (item.scene !== void 0) target.scene = String(item.scene);
					if (Array.isArray(item.options)) target.options = item.options.map((o, i) => ({ id: `opt-${i + 1}`, label: String(o.label ?? `选项${i + 1}`), leadsTo: typeof o.leadsTo === "string" ? o.leadsTo : "" }));
					message = `已更新分支 ${target.id}`;
				}
			} else if (action === "remove") {
				if (args.type === "keypoint") {
					const before = current.keyPoints.length;
					current.keyPoints = current.keyPoints.filter((k) => k.id !== args.keyPointId);
					if (current.keyPoints.length === before) throw new Error(`关键剧情点 ${args.keyPointId} 不存在`);
					message = `已删除关键剧情点 ${args.keyPointId}`;
				} else {
					const before = current.branches.length;
					current.branches = current.branches.filter((b) => b.id !== args.branchId);
					if (current.branches.length === before) throw new Error(`分支 ${args.branchId} 不存在`);
					if (current.currentBranchId === args.branchId) current.currentBranchId = "";
					message = `已删除分支 ${args.branchId}`;
				}
			} else if (action === "list") {
				message = "当前剧情结构如下";
			} else if (action === "reached") {
				const branch = findBranch(current, args.branchId);
				if (branch === null) throw new Error(`分支 ${args.branchId} 不存在`);
				branch.reached = true;
				current.currentBranchId = branch.id;
				message = `已标记抵达分支「${branch.title}」并设为当前分支`;
			} else if (action === "choose") {
				const branch = findBranch(current, args.branchId);
				if (branch === null) throw new Error(`分支 ${args.branchId} 不存在`);
				const option = branch.options.find((o) => o.label === args.optionLabel);
				if (option === void 0) throw new Error(`分支「${branch.title}」没有选项「${args.optionLabel}」（可用 coc_branch list 查看选项）`);
				branch.chosen = option.label;
				current.currentBranchId = "";
				if (args.nextScene !== void 0 && args.nextScene.length > 0) current.currentScene = args.nextScene;
				else if (option.leadsTo !== void 0 && option.leadsTo.length > 0) current.currentScene = option.leadsTo;
				message = `玩家选择了「${option.label}」` + (current.currentScene ? `，推进到场景「${current.currentScene}」` : "");
			} else if (action === "reveal") {
				const target = findKeyPoint(current, args.keyPointId);
				if (target === null) throw new Error(`关键剧情点 ${args.keyPointId} 不存在`);
				target.revealed = true;
				message = `已揭示关键剧情点「${target.title}」`;
			}
			persist(current);
			return {
				action,
				game: current.id,
				message,
				keyPoints: current.keyPoints,
				branches: current.branches,
				currentScene: current.currentScene,
				currentBranchId: current.currentBranchId
			};
		}
	});
	ctx.tools.register(defs['coc_branch']);

	// ── coc_remind：分支/剧情提醒 ────────────────────────────────────────────
	defs['coc_remind'] = defineTool({
		name: "coc_remind",
		description: "设置/查看/触发剧情提醒（KP 专用）：在某场景（scene）临近关键分支或重要剧情点时登记一条提醒，当当前场景匹配时动态提示；fire 标记已提醒。也可用 add 的 scene 留空表示任何时候都提醒。",
		parameters: {
			action: { type: "string", enum: ["add", "list", "fire", "remove"], required: true, description: "操作" },
			game: { type: "string", description: "游戏 ID" },
			scene: { type: "string", description: "add 时：提醒触发的场景名（留空表示任何时候）" },
			text: { type: "string", description: "add 时：提醒内容（向玩家提示什么）" },
			reminderId: { type: "string", description: "fire/remove 时的提醒 ID" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string" },
					game: { type: "string" },
					message: { type: "string" },
					pending: { type: "array", items: { type: "object", additionalProperties: true } },
					fired: { type: "array", items: { type: "object", additionalProperties: true } }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `[提醒] ${value.message}\n待提醒 ${value.pending?.length ?? 0} 条，已提醒 ${value.fired?.length ?? 0} 条`
			}]
		},
		execute(args) {
			const current = state(args);
			const action = args.action;
			let message = "";
			if (action === "add") {
				current.reminders.push({ id: `rm-${current.reminders.length + 1}`, scene: args.scene ?? "", text: String(args.text ?? ""), fired: false });
				message = `已登记提醒：${args.scene ? `场景「${args.scene}」` : "任何时候"} → ${args.text}`;
			} else if (action === "fire") {
				const target = current.reminders.find((r) => r.id === args.reminderId);
				if (target === void 0) throw new Error(`提醒 ${args.reminderId} 不存在`);
				target.fired = true;
				message = `已触发提醒「${target.text}」`;
			} else if (action === "remove") {
				const before = current.reminders.length;
				current.reminders = current.reminders.filter((r) => r.id !== args.reminderId);
				if (current.reminders.length === before) throw new Error(`提醒 ${args.reminderId} 不存在`);
				message = `已删除提醒 ${args.reminderId}`;
			} else {
				message = "当前提醒列表";
			}
			persist(current);
			return {
				action,
				game: current.id,
				message,
				pending: current.reminders.filter((r) => !r.fired),
				fired: current.reminders.filter((r) => r.fired)
			};
		}
	});
	ctx.tools.register(defs['coc_remind']);

	// ── coc_character：人物卡管理 ────────────────────────────────────────────
	defs['coc_character'] = defineTool({
		name: "coc_character",
		description: "管理人物卡（KP/玩家通用）：list 列出全部人物，add 添加人物，update 修改，remove 删除。批量导入请用 coc_import（kind=characters）。",
		parameters: {
			action: { type: "string", enum: ["list", "add", "update", "remove"], required: true, description: "操作" },
			game: { type: "string", description: "游戏 ID" },
			characterId: { type: "string", description: "update/remove 时的人物 ID（也可用 name）" },
			name: { type: "string", description: "update/remove 时的人物名（characterId 缺省时按姓名匹配）" },
			character: { ...characterSchema, description: "add/update 时的人物数据" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string" },
					game: { type: "string" },
					message: { type: "string" },
					characters: { type: "array", items: { type: "object", additionalProperties: true } }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `[人物] ${value.message}（共 ${value.characters?.length ?? 0} 人）`
			}]
		},
		execute(args) {
			const current = state(args);
			const action = args.action;
			let message = "";
			if (action === "list") {
				message = `共 ${current.characters.length} 个人物`;
			} else if (action === "add") {
				const pc = normalizeCharacter(args.character ?? { name: args.name }, current.characters.length);
				if (current.characters.some((c) => c.name === pc.name)) throw new Error(`人物「${pc.name}」已存在（可用 update 修改）`);
				current.characters.push(pc);
				message = `已添加人物「${pc.name}」`;
			} else if (action === "update") {
				const index = current.characters.findIndex((c) => c.id === args.characterId || (args.characterId === void 0 && c.name === args.name));
				if (index < 0) throw new Error(`人物 ${args.characterId ?? args.name} 不存在`);
				const merged = normalizeCharacter({ ...current.characters[index], ...(args.character ?? {}), id: current.characters[index].id, name: args.character?.name ?? current.characters[index].name }, index);
				current.characters[index] = merged;
				message = `已更新人物「${merged.name}」`;
			} else if (action === "remove") {
				const index = current.characters.findIndex((c) => c.id === args.characterId || (args.characterId === void 0 && c.name === args.name));
				if (index < 0) throw new Error(`人物 ${args.characterId ?? args.name} 不存在`);
				const removed = current.characters.splice(index, 1)[0];
				message = `已删除人物「${removed.name}」`;
			}
			persist(current);
			return { action, game: current.id, message, characters: current.characters };
		}
	});
	ctx.tools.register(defs['coc_character']);

	// ── coc_kp：KP 模式切换 ──────────────────────────────────────────────────
	defs['coc_kp'] = defineTool({
		name: "coc_kp",
		description: "切换/查看 KP 模式：ai 模式由 AI 担任 KP（叙述世界、扮演 NPC、主持检定）；human 模式由人类玩家担任 KP，AI 转为玩家助手（查规则、代掷、记录状态、提示剧情结构）。玩家可随时要求切换，实现「AI 扮演 KP / 随时接替」。",
		parameters: {
			action: { type: "string", enum: ["status", "ai", "human"], required: true, description: "status 查看当前模式；ai 切换为 AI 当 KP；human 切换为人类当 KP" },
			game: { type: "string", description: "游戏 ID" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					game: { type: "string" },
					kpMode: { type: "string" },
					message: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `[KP 模式] ${value.message}`
			}]
		},
		execute(args) {
			const current = state(args);
			const action = args.action;
			let message = "";
			if (action === "ai" || action === "human") {
				current.kpMode = action;
				message = action === "ai" ? "已切换：AI 担任 KP（请以主持人身份继续，保持剧情连贯并主动提示分支）" : "已切换：人类担任 KP，AI 转为玩家助手（只查规则、代掷骰、记录状态，不再替 KP 叙述剧情）";
			} else {
				message = current.kpMode === "ai" ? "当前由 AI 担任 KP" : "当前由人类担任 KP（AI 为玩家助手）";
			}
			persist(current);
			return { game: current.id, kpMode: current.kpMode, message };
		}
	});
	ctx.tools.register(defs['coc_kp']);

	// ── coc_scene：推进剧情状态（场景 / 游戏内时间 / 剧情概述） ──────────────
	defs['coc_scene'] = defineTool({
		name: "coc_scene",
		description: "更新剧情状态（KP/面板用）：设置当前场景、游戏内时间或剧情概述。scene/time/synopsis 至少提供一个，或单独用 timeAdvance 快捷推进时间；只更新提供的字段。",
		parameters: {
			game: { type: "string", description: "游戏 ID" },
			scene: { type: "string", description: "当前场景名，如「废弃宅邸-书房」" },
			time: { type: "string", description: "游戏内时间/日期，如「1925年10月1日 下午3点」" },
			synopsis: { type: "string", description: "剧情概述（一句话或一段）" },
			timeAdvance: { type: "string", enum: ["hour", "day", "night"], description: "快捷推进时间：hour=+1小时，day=+1天，night=到夜晚21点（基于现有游戏时间解析；解析失败则在原时间后标注）" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					game: { type: "string" },
					message: { type: "string" },
					scene: { type: "string" },
					time: { type: "string" },
					synopsis: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `[剧情状态] ${value.message}\n场景：${value.scene || "（未设定）"}${value.time ? `\n时间：${value.time}` : ""}${value.synopsis ? `\n概述：${value.synopsis}` : ""}`
			}]
		},
		execute(args) {
			const current = state(args);
			const changed = [];
			if (typeof args.scene === "string" && args.scene.trim().length > 0) {
				current.currentScene = args.scene.trim();
				changed.push(`场景→${current.currentScene}`);
			}
			if (typeof args.time === "string" && args.time.trim().length > 0) {
				current.time = args.time.trim();
				changed.push(`时间→${current.time}`);
			}
			if (typeof args.synopsis === "string" && args.synopsis.trim().length > 0) {
				current.synopsis = args.synopsis.trim();
				changed.push("概述已更新");
			}
			if (typeof args.timeAdvance === "string" && args.timeAdvance.length > 0) {
				current.time = advanceGameTime(current.time, args.timeAdvance);
				changed.push(`时间→${current.time}`);
			}
			if (changed.length === 0) throw new Error("scene/time/synopsis/timeAdvance 至少提供一个");
			persist(current);
			return { game: current.id, message: changed.join("；"), scene: current.currentScene, time: current.time, synopsis: current.synopsis };
		}
	});
	ctx.tools.register(defs['coc_scene']);

	// ── coc_task：任务栏管理 ─────────────────────────────────────────────────
	defs['coc_task'] = defineTool({
		name: "coc_task",
		description: "管理任务栏（KP/面板用）：add 添加任务、complete 标记完成、reopen 重新打开、remove 删除。",
		parameters: {
			action: { type: "string", enum: ["add", "complete", "reopen", "remove"], required: true, description: "操作" },
			game: { type: "string", description: "游戏 ID" },
			title: { type: "string", description: "add 时的任务标题" },
			note: { type: "string", description: "add 时的任务备注（可选）" },
			taskId: { type: "string", description: "complete/reopen/remove 时的任务 ID" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string" },
					game: { type: "string" },
					message: { type: "string" },
					tasks: { type: "array", items: { type: "object", additionalProperties: true } }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `[任务] ${value.message}（共 ${value.tasks?.length ?? 0} 条）`
			}]
		},
		execute(args) {
			const current = state(args);
			const action = args.action;
			let message = "";
			if (action === "add") {
				current.tasks.push({ id: `task-${current.tasks.length + 1}`, title: String(args.title ?? "未命名任务"), note: String(args.note ?? ""), status: "open" });
				message = `已添加任务「${args.title}」`;
			} else if (action === "complete" || action === "reopen") {
				const task = current.tasks.find((t) => t.id === args.taskId);
				if (task === void 0) throw new Error(`任务 ${args.taskId} 不存在`);
				task.status = action === "complete" ? "done" : "open";
				message = `任务「${task.title}」${action === "complete" ? "已完成" : "已重新打开"}`;
			} else if (action === "remove") {
				const before = current.tasks.length;
				current.tasks = current.tasks.filter((t) => t.id !== args.taskId);
				if (current.tasks.length === before) throw new Error(`任务 ${args.taskId} 不存在`);
				message = `已删除任务 ${args.taskId}`;
			}
			persist(current);
			return { action, game: current.id, message, tasks: current.tasks };
		}
	});
	ctx.tools.register(defs['coc_task']);

	// ── coc_entity：可交互实体（NPC/地点/物品/组织）管理 ─────────────────────
	defs['coc_entity'] = defineTool({
		name: "coc_entity",
		description: "管理剧情中的可交互实体（KP/面板用）：NPC、地点、物品、组织等。add 添加、update 修改、remove 删除、list 列出。剧本导入时会按标记草拟实体，可在此基础上校对。",
		parameters: {
			action: { type: "string", enum: ["add", "update", "remove", "list"], required: true, description: "操作" },
			game: { type: "string", description: "游戏 ID" },
			entity: {
				type: "object",
				additionalProperties: true,
				description: "add/update 的实体：{id?, type: npc|location|item|org|other, name, desc?, state?, scene?}"
			},
			entityId: { type: "string", description: "update/remove 时的实体 ID" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string" },
					game: { type: "string" },
					message: { type: "string" },
					entities: { type: "array", items: { type: "object", additionalProperties: true } }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `[实体] ${value.message}（共 ${value.entities?.length ?? 0} 个）`
			}]
		},
		execute(args) {
			const current = state(args);
			const action = args.action;
			let message = "";
			if (action === "add") {
				const item = args.entity ?? {};
				const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `ent-${current.entities.length + 1}`;
				if (current.entities.some((e) => e.id === id)) throw new Error(`实体 ${id} 已存在`);
				current.entities.push({
					id,
					type: String(item.type ?? "other"),
					name: String(item.name ?? "未命名实体"),
					desc: String(item.desc ?? ""),
					state: String(item.state ?? ""),
					scene: String(item.scene ?? "")
				});
				message = `已添加实体「${item.name}」（${item.type ?? "other"}）`;
			} else if (action === "update") {
				const target = current.entities.find((e) => e.id === args.entityId);
				if (target === void 0) throw new Error(`实体 ${args.entityId} 不存在`);
				const item = args.entity ?? {};
				if (item.type !== void 0) target.type = String(item.type);
				if (item.name !== void 0) target.name = String(item.name);
				if (item.desc !== void 0) target.desc = String(item.desc);
				if (item.state !== void 0) target.state = String(item.state);
				if (item.scene !== void 0) target.scene = String(item.scene);
				message = `已更新实体「${target.name}」`;
			} else if (action === "remove") {
				const before = current.entities.length;
				current.entities = current.entities.filter((e) => e.id !== args.entityId);
				if (current.entities.length === before) throw new Error(`实体 ${args.entityId} 不存在`);
				message = `已删除实体 ${args.entityId}`;
			} else {
				message = `共 ${current.entities.length} 个实体`;
			}
			persist(current);
			return { action, game: current.id, message, entities: current.entities };
		}
	});
	ctx.tools.register(defs['coc_entity']);

	// ── coc_pc：更新玩家人物状态（HP/SAN/MP/LUCK/物品） ──────────────────────
	defs['coc_pc'] = defineTool({
		name: "coc_pc",
		description: "更新玩家人物状态（KP/面板用）：按姓名修改 hp/san/mp/luck、增删随身物品。只更新提供的字段；物品增减用 inventoryAdd/inventoryRemove。",
		parameters: {
			game: { type: "string", description: "游戏 ID" },
			name: { type: "string", required: true, description: "人物名（按姓名匹配）" },
			hp: { type: "number", description: "生命值" },
			san: { type: "number", description: "理智值" },
			mp: { type: "number", description: "魔法值" },
			luck: { type: "number", description: "幸运" },
			inventoryAdd: { type: "string", description: "要加入物品栏的物品名" },
			inventoryRemove: { type: "string", description: "要从物品栏移除的物品名" },
			notes: { type: "string", description: "追加到备注的文本" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					game: { type: "string" },
					message: { type: "string" },
					character: { type: "object", additionalProperties: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `[人物状态] ${value.message}`
			}]
		},
		execute(args) {
			const current = state(args);
			const pc = current.characters.find((c) => c.name === args.name);
			if (pc === void 0) throw new Error(`人物「${args.name}」不存在（可用 coc_character add 或 coc_import 导入）`);
			const changed = [];
			if (typeof args.hp === "number") { pc.hp = args.hp; changed.push(`HP→${pc.hp}`); }
			if (typeof args.san === "number") { pc.san = args.san; changed.push(`SAN→${pc.san}`); }
			if (typeof args.mp === "number") { pc.mp = args.mp; changed.push(`MP→${pc.mp}`); }
			if (typeof args.luck === "number") { pc.luck = args.luck; changed.push(`LUCK→${pc.luck}`); }
			if (typeof args.inventoryAdd === "string" && args.inventoryAdd.trim().length > 0) {
				pc.inventory.push(args.inventoryAdd.trim());
				changed.push(`获得物品「${args.inventoryAdd.trim()}」`);
			}
			if (typeof args.inventoryRemove === "string" && args.inventoryRemove.trim().length > 0) {
				const index = pc.inventory.indexOf(args.inventoryRemove.trim());
				if (index >= 0) {
					pc.inventory.splice(index, 1);
					changed.push(`失去物品「${args.inventoryRemove.trim()}」`);
				}
			}
			if (typeof args.notes === "string" && args.notes.trim().length > 0) {
				pc.notes = `${pc.notes}${pc.notes.length > 0 ? "\n" : ""}${args.notes.trim()}`;
				changed.push("备注已追加");
			}
			if (changed.length === 0) throw new Error("没有提供任何要更新的字段");
			persist(current);
			return { game: current.id, message: `「${pc.name}」${changed.join("；")}`, character: pc };
		}
	});
	ctx.tools.register(defs['coc_pc']);

	// ── KP 人设提示词 section ────────────────────────────────────────────────
	ctx.systemPrompt.section({
		name: "coc:kp",
		order: 3000,
		text: [
			"【克苏鲁的呼唤 · 跑团插件】本会话搭载 CoC 跑团插件（coc_* 工具）。",
			"1. KP 模式：默认 kpMode=ai，由你担任 KP——叙述场景、扮演 NPC、主持检定与战斗、维持恐怖氛围；玩家用 coc_kp 可随时切换为 human 模式（人类当 KP，你转为玩家助手，不再替 KP 叙述剧情，只查规则/代掷/记录）。",
			"2. 检定纪律：所有判定必须调用 coc_roll（明骰）或 coc_roll_secret（暗骰），严禁自行编造骰点。",
			"3. 暗骰纪律：coc_roll_secret 的结果（含数值与成功档位）只属于 KP，向玩家只描述效果、不披露数值。",
			"4. 剧情掌控：每进入/切换一个场景调用一次 coc_status 查看关键剧情点、当前分支与提醒；当玩家临近关键剧情点或到达分支（coc_branch reached/choose 标记）时，主动以 KP 口吻提示存在的重要选择，但不要替玩家做决定。",
			"5. 导入与阅读：开局可让玩家提供规则/剧本（支持 PDF）/人物卡并用 coc_import 导入；导入后 coc_read 分段阅读全文、coc_branch 校对草拟的剧情结构、coc_remind 登记重要分支提醒。",
			"6. 规则冲突：以导入的规则文本为准；未导入时按 CoC 7e 常见规则（常规≤技能值、困难≤1/2、极限≤1/5、96-100 大失败、01 大成功）。"
		].join("\n")
	});

	// ── 动态游戏状态 context（每轮自动注入当前场景/分支/提醒） ──────────────
	ctx.systemPrompt.context({
		name: "coc:state",
		order: 3050,
		text: () => {
			const current = loadState(dataDir, defaultGame);
			if (current === null) return "";
			const lines = [`【当前跑团状态 · ${current.title}】`];
			lines.push(`KP 模式：${current.kpMode === "ai" ? "AI 担任 KP" : "人类担任 KP（AI 为玩家助手）"}`);
			lines.push(`当前场景：${current.currentScene || "（未设定）"}`);
			if (current.time !== "") lines.push(`游戏内时间：${current.time}`);
			if (current.currentBranchId !== "") {
				const branch = findBranch(current, current.currentBranchId);
				if (branch !== null) lines.push(`当前分支：${branch.title}（选项：${(branch.options ?? []).map((o) => o.label).join(" / ") || "无"}）`);
			}
			const pending = current.reminders.filter((r) => !r.fired && (r.scene === "" || r.scene === current.currentScene));
			if (pending.length > 0) lines.push(`⚠ 待提醒：${pending.map((r) => r.text).join("；")}`);
			const unrevealed = current.keyPoints.filter((k) => !k.revealed);
			const unReached = current.branches.filter((b) => !b.reached);
			if (unrevealed.length > 0) lines.push(`未揭示关键剧情点：${unrevealed.length} 个`);
			if (unReached.length > 0) lines.push(`未抵达分支：${unReached.length} 个`);
			const recent = current.rollHistory.slice(-2);
			if (recent.length > 0) lines.push(`最近检定：${recent.map((roll) => `${roll.kind === "secret" ? "🔒" : ""}${roll.player ? `${roll.player} ` : ""}${roll.label ? `${roll.label} ` : ""}${roll.expression}=${roll.rolled}${roll.target !== null && roll.target !== void 0 ? `/${roll.target}` : ""}${roll.tier ? ` ${TIER_LABELS[roll.tier] ?? roll.tier}` : ""}`).join("；")}`);
			return lines.join("\n");
		}
	});
	
	// ── 自动导入内置规则（首次启动时自动加载；Config.autoImportBuiltinRules=false 可关闭） ──
	if (config.autoImportBuiltinRules !== false && BUILTIN_RULES_TEXT && BUILTIN_RULES_TEXT.length > 0) {
		try {
			const cur = touchState(dataDir, defaultGame);
			if (cur.rules === null) {
				cur.rules = {
					name: BUILTIN_RULES_NAME,
					source: "builtin",
					text: BUILTIN_RULES_TEXT,
					summary: BUILTIN_RULES_SUMMARY,
					chars: BUILTIN_RULES_CHARS,
					lines: BUILTIN_RULES_LINES
				};
				saveState(dataDir, cur);
				console.log(`[coc-keeper] 内置规则已自动导入到游戏「${defaultGame}」`);
			}
		} catch (e) {
			console.error("[coc-keeper] 自动导入内置规则失败:", e.message);
		}
	}
	
	// ── 宿主 HTTP API 已迁移到 lib/adapter/api/coc-api.js（Step 4） ──
	// legacy 不再注册 /coc-api；handleCocApi/runKpTurn 等函数保留在下方作为参考/回退。
}
//#endregion

//#region 宿主 HTTP API（/coc-api）
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
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** SSE 辅助：发送一个 progress 事件（用于导入进度流式报告）。 */
function sendSSEProgress(res, phase, message, percent) {
	if (res.writableEnded) return;
	res.write("event: progress\ndata: " + JSON.stringify({ phase, message, percent }) + "\n\n");
}
/** SSE 辅助：发送最终 result 事件并关闭流。 */
function sendSSEResult(res, ok, payload) {
	if (res.writableEnded) return;
	res.write("event: result\ndata: " + JSON.stringify({ ok, ...payload }) + "\n\n");
	res.end();
}
/** 调用一个已注册工具定义（复用其参数校验与逻辑），返回 {ok, data, render} 或 {ok:false, error}。 */
async function callCocTool(res, def, args) {
	try {
		const data = await def.execute(args, {});
		const rendered = def.output.render(args, data);
		const text = Array.isArray(rendered) && rendered[0]?.text !== void 0 ? rendered[0].text : "";
		sendJson(res, 200, { ok: true, data, render: text });
	} catch (error) {
		sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}
/** 执行一个工具定义（供聊天桥调用），成功返回渲染文本，失败返回 {error}。 */
async function executeToolForLoop(def, args) {
	try {
		const data = await def.execute(args, {});
		const rendered = def.output.render(args, data);
		const text = Array.isArray(rendered) && rendered[0]?.text !== void 0 ? rendered[0].text : JSON.stringify(data);
		return { ok: true, text };
	} catch (error) {
		return { ok: false, text: `错误：${error instanceof Error ? error.message : String(error)}` };
	}
}
/** /coc-api 路由分发：GET status/state；POST roll/branch/remind/kp/status/chat/import/read。 */
async function handleCocApi(req, res, defs, store) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname;
	try {
		if (req.method === "GET") {
			const params = url.searchParams;
			const gameId = params.get("game")?.trim() || store.defaultGame;
			if (path === "/coc-api" || path === "/coc-api/status") {
				const existing = loadState(store.dataDir, gameId);
				if (existing === null) {
					return sendJson(res, 200, { ok: true, data: null, render: "尚未创建游戏数据。可在对话中让 AI 导入规则/剧本/人物，或直接在面板上掷骰/登记分支（会自动创建游戏）。" });
				}
				return await callCocTool(res, defs.coc_status, { game: gameId, view: "all", includeSecretRolls: true });
			}
			if (path === "/coc-api/state") {
				const existing = loadState(store.dataDir, gameId);
				if (existing === null) return sendJson(res, 200, { ok: true, data: null, entries: [], seq: 0 });
				const after = Math.max(0, Number(params.get("after")) || 0);
				const digest = stateDigest(existing);
				return sendJson(res, 200, { ok: true, data: digest, entries: existing.log.slice(after), seq: existing.log.length });
			}
		}
		if (req.method === "POST") {
			const body = await readJsonBody(req);
			if (path === "/coc-api/roll") {
				const { secret, ...rest } = body;
				return await callCocTool(res, secret === true || secret === "true" ? defs.coc_roll_secret : defs.coc_roll, rest);
			}
			if (path === "/coc-api/branch") return await callCocTool(res, defs.coc_branch, body);
			if (path === "/coc-api/remind") return await callCocTool(res, defs.coc_remind, body);
			if (path === "/coc-api/kp") return await callCocTool(res, defs.coc_kp, body);
			if (path === "/coc-api/status") return await callCocTool(res, defs.coc_status, { ...body, view: "all", includeSecretRolls: true });
			if (path === "/coc-api/read") return await callCocTool(res, defs.coc_read, body);
			if (path === "/coc-api/tool") {
				const def = defs[body.name];
				if (def === void 0) return sendJson(res, 400, { ok: false, error: `未知工具 ${body.name}` });
				return await callCocTool(res, def, body.args ?? {});
			}
			if (path === "/coc-api/import") {
				const gameId = body.game?.trim() || store.defaultGame;
				const state = touchState(store.dataDir, gameId);
				const importArgs = { kind: body.kind ?? "auto", game: gameId };
				if (body.name !== void 0) importArgs.name = body.name;
				if (body.parseStructure !== void 0) importArgs.parseStructure = body.parseStructure;
				if (body.overwrite !== void 0) importArgs.overwrite = body.overwrite;
				// 检查客户端是否接受 SSE（通过参数 stream=true 或 Accept 头）
				const wantsSSE = body.stream === true || req.headers.accept?.includes("text/event-stream");
				if (wantsSSE) {
					// SSE 流式响应：实时报告导入进度
					res.writeHead(200, {
						"content-type": "text/event-stream; charset=utf-8",
						"cache-control": "no-cache",
						"connection": "keep-alive",
						"x-accel-buffering": "no"
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
					let result;
					try {
						if (typeof body.fileBase64 === "string" && body.fileBase64.length > 0) {
							const fileName = String(body.fileName ?? "import.pdf");
							const tmpDir = join(store.dataDir, "tmp");
							mkdirSync(tmpDir, { recursive: true });
							const tmpPath = join(tmpDir, `import-${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
							writeFileSync(tmpPath, Buffer.from(body.fileBase64, "base64"));
							try {
								result = await defs.coc_import.execute({ ...importArgs, source: "file", filePath: tmpPath }, { onProgress });
							} finally {
								try { unlinkSync(tmpPath); } catch { /* ignore */ }
							}
						} else if (typeof body.source === "string" && body.source === "file" && typeof body.filePath === "string" && body.filePath.length > 0) {
							result = await defs.coc_import.execute({ ...importArgs, source: "file", filePath: body.filePath }, { onProgress });
						} else {
							result = await defs.coc_import.execute({ ...importArgs, source: "text", text: String(body.text ?? "") }, { onProgress });
						}
						const rendered = defs.coc_import.output.render(body, result);
						const text = rendered[0]?.text ?? "导入完成";
						sendSSEResult(res, true, { data: result, render: text });
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						sendSSEResult(res, false, { error: msg });
					}
				} else {
					// 传统 JSON 响应（兼容旧客户端）
					let result;
					if (typeof body.fileBase64 === "string" && body.fileBase64.length > 0) {
						const fileName = String(body.fileName ?? "import.pdf");
						const tmpDir = join(store.dataDir, "tmp");
						mkdirSync(tmpDir, { recursive: true });
						const tmpPath = join(tmpDir, `import-${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
						writeFileSync(tmpPath, Buffer.from(body.fileBase64, "base64"));
						try {
							result = await defs.coc_import.execute({ ...importArgs, source: "file", filePath: tmpPath }, {});
						} finally {
							try { unlinkSync(tmpPath); } catch { /* ignore */ }
						}
					} else if (typeof body.source === "string" && body.source === "file" && typeof body.filePath === "string" && body.filePath.length > 0) {
						result = await defs.coc_import.execute({ ...importArgs, source: "file", filePath: body.filePath }, {});
					} else {
						result = await defs.coc_import.execute({ ...importArgs, source: "text", text: String(body.text ?? "") }, {});
					}
					const rendered = defs.coc_import.output.render(body, result);
					sendJson(res, 200, { ok: true, data: result, render: rendered[0]?.text ?? "导入完成" });
				}
				return;
			}
			if (path === "/coc-api/clear-scenario") {
				const gameId = body.game?.trim() || store.defaultGame;
				const state = touchState(store.dataDir, gameId);
				state.scenario = null;
				state.keyPoints = [];
				state.branches = [];
				state.entities = [];
				saveState(store.dataDir, state);
				sendJson(res, 200, { ok: true });
				return;
			}
			if (path === "/coc-api/clear-rules") {
				const gameId = body.game?.trim() || store.defaultGame;
				const state = touchState(store.dataDir, gameId);
				state.rules = null;
				saveState(store.dataDir, state);
				sendJson(res, 200, { ok: true });
				return;
			}
			if (path === "/coc-api/config") {
				// 保存/读取 LLM 配置
				const configFile = join(store.dataDir, "config.json");
				if (body.action === "get") {
					let cfg = {};
					try {
						if (existsSync(configFile)) {
							cfg = JSON.parse(readFileSync(configFile, "utf8"));
						}
					} catch (e) { /* ignore */ }
					return sendJson(res, 200, { ok: true, data: cfg });
				}
				if (body.action === "set") {
					const cfg = {
						llmProvider: String(body.llmProvider ?? "").trim(),
						llmModel: String(body.llmModel ?? "").trim(),
						apiKey: String(body.apiKey ?? "").trim(),
						apiBaseUrl: String(body.apiBaseUrl ?? "").trim()
					};
					try {
						mkdirSync(store.dataDir, { recursive: true });
						writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf8");
					} catch (e) {
						return sendJson(res, 500, { ok: false, error: "保存配置失败: " + (e.message || e) });
					}
					return sendJson(res, 200, { ok: true, data: cfg });
				}
				return sendJson(res, 400, { ok: false, error: "未知 action" });
			}
			if (path === "/coc-api/import-builtin-rules") {
				// 手动重新导入内置规则
				const gameId = body.game?.trim() || store.defaultGame;
				try {
					const cur = touchState(store.dataDir, gameId);
					cur.rules = {
						name: BUILTIN_RULES_NAME,
						source: "builtin",
						text: BUILTIN_RULES_TEXT,
						summary: BUILTIN_RULES_SUMMARY,
						chars: BUILTIN_RULES_CHARS,
						lines: BUILTIN_RULES_LINES
					};
					saveState(store.dataDir, cur);
					sendJson(res, 200, { ok: true, data: { name: BUILTIN_RULES_NAME, chars: BUILTIN_RULES_CHARS } });
				} catch (e) {
					sendJson(res, 500, { ok: false, error: "导入失败: " + (e.message || e) });
				}
				return;
			}
			if (path === "/coc-api/test-llm") {
				// 测试 LLM 连接
				try {
					const result = await callLlmApi(store.dataDir, [
						{ role: "user", content: [{ type: "text", text: "回复一句简短的话：你好！" }] }
					], { temperature: 0.1, max_tokens: 100 });
					const text = result.blocks?.[0]?.text || "";
					sendJson(res, 200, { ok: true, data: "连接成功！响应：" + text.slice(0, 100) });
				} catch (e) {
					sendJson(res, 200, { ok: false, error: "连接失败: " + (e.message || e) });
				}
				return;
			}
			if (path === "/coc-api/chat") {
				const gameId = body.game?.trim() || store.defaultGame;
				const text = String(body.text ?? "").trim();
				if (text.length === 0) return sendJson(res, 400, { ok: false, error: "消息为空" });
				const player = String(body.player ?? "游客").trim() || "游客";
				const result = await runKpTurn(store, defs, gameId, text, player);
				sendJson(res, 200, { ok: true, data: result });
				return;
			}
		}
		sendJson(res, 404, { ok: false, error: "not found" });
	} catch (error) {
		sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}
//#endregion

//#region 面板聊天桥（KP 迷你循环：LLM + coc 工具调用）
/** 渲染给 LLM 的游戏状态摘要（不含大段原文）。 */
function stateDigest(state) {
	return {
		id: state.id,
		title: state.title,
		kpMode: state.kpMode,
		currentScene: state.currentScene,
		currentBranchId: state.currentBranchId,
		time: state.time,
		synopsis: state.synopsis,
		rules: state.rules === null ? null : { name: state.rules.name, chars: state.rules.chars },
		scenario: state.scenario === null ? null : { name: state.scenario.name, chars: state.scenario.chars },
		characters: state.characters,
		keyPoints: state.keyPoints,
		branches: state.branches,
		tasks: state.tasks,
		entities: state.entities,
		reminders: state.reminders,
		recentRolls: state.rollHistory.slice(-12).reverse(),
		toolTrace: state.toolTrace.slice(-10).reverse(),
		logLength: state.log.length
	};
}
/** KP 系统提示：人设 + 完整状态快照。 */
function buildKpSystemPrompt(state) {
	const lines = [
		"你是《克苏鲁的呼唤》（CoC 7e）跑团的 KP（守秘人）。当前由 AI 担任 KP，主持一场文字跑团。",
		"【硬性规则】",
		"1. 检定纪律（最高优先级）：玩家要求检定，或你判定某个行为存在成败可能（侦查、潜行、说服、灵感、聆听、战斗等）时，必须【先调用工具】得到结果，再把结果融入叙述。coc_roll 是明骰；coc_roll_secret 是暗骰（潜行、侦查陷阱、灵感、NPC 暗判定等不宜让玩家知道结果的场合）。",
		"2. 绝对禁止：在叙述中自行写出骰点、自行宣告检定成败。未经工具检定不得判定成败。",
		"3. 暗骰纪律：coc_roll_secret 的具体数值与档位只属于 KP，绝不允许出现在你输出的剧情文字中，只描述效果。",
		"4. 状态必须落地：玩家状态变化（HP/SAN/MP/LUCK、获得/失去物品）调用 coc_pc；场景/游戏内时间/剧情概述变化调用 coc_scene；任务增减调用 coc_task；NPC/地点/物品实体调用 coc_entity；分支抵达与选择、关键点揭示调用 coc_branch；提醒登记调用 coc_remind。",
		"5. 叙述职责：用中文叙述场景、扮演 NPC、制造恐怖氛围；每次回复以剧情推进为主，最后简短提示玩家可选行动，但不要替玩家做决定。",
		"6. 接近关键剧情点或分支时，主动以 KP 口吻提示存在的重要选择。",
		"7. 游戏内时间与事件要连贯（当前时间见状态快照），开场或时间跳转时用 coc_scene 记录。",
		"【规则概要】CoC 7e 规则已内置，你不需要记住完整规则文本。需要了解具体规则时，调用 coc_query_rule 查询。",
		"  - 常规成功 ≤ 技能值，困难成功 ≤ 技能值/2，极限成功 ≤ 技能值/5",
		"  - 01 大成功；技能 < 50 时 96-00 大失败，技能 ≥ 50 时仅 00 大失败",
		"  - 奖励骰：有利条件时额外掷一个十位骰取最优；惩罚骰取最差",
		"【可用工具列表】",
		"  ■ 基础检定：",
		"    - coc_roll(expression, target, difficulty, player, label) — 明骰，用于玩家可见的检定",
		"    - coc_roll_secret(expression, target, difficulty, player, label) — 暗骰，用于潜行、侦查陷阱、灵感、NPC 暗判定",
		"  ■ 规则查询：",
		"    - coc_query_rule(topic) — 查询 CoC 7e 规则详情（技能列表、战斗规则、理智值、职业、装备等）。需要了解具体规则数值时调用此工具，不要凭记忆编造",
		"  ■ 战斗结算：",
		"    - coc_combat_resolve(attacker, defender, weapon, skill, range, defenderDodge, ...) — 执行完整的战斗回合结算，包含命中、闪避、伤害（含 DB）、护甲，自动更新 HP",
		"  ■ 理智值：",
		"    - coc_sanity_check(player, sanLoss, description, difficulty) — 执行理智检定，自动计算 SAN 损失，判定临时性/不定性/永久性疯狂，更新人物状态",
		"  ■ 技能成长：",
		"    - coc_skill_growth(player, skill) — 冒险结束时尝试技能成长，掷 d100 若大于当前值则增加 1d10",
		"  ■ 状态管理：",
		"    - coc_scene(scene, time, synopsis) — 设置场景/时间/剧情概述",
		"    - coc_pc(name, hp, san, mp, luck, inventoryAdd, inventoryRemove) — 更新调查员状态",
		"    - coc_task(action, title, note) — 管理任务",
		"    - coc_entity(action, entity) — 管理 NPC/地点/物品实体",
		"    - coc_branch(action, ...) — 管理关键剧情点与分支",
		"    - coc_remind(action, scene, text) — 管理提醒",
		"    - coc_kp(action) — 切换 KP 模式",
		"【工具使用指引】",
		"  - 需要技能检定（侦查、潜行、说服、灵感、聆听等）→ 用 coc_roll 或 coc_roll_secret",
		"  - 需要查询规则数值（技能默认值、伤害公式、职业模板等）→ 用 coc_query_rule",
		"  - 战斗场景 → 用 coc_combat_resolve（自动结算命中/伤害/HP）",
		"  - 目睹恐怖/超自然事件 → 用 coc_sanity_check（自动计算 SAN 损失和疯狂）",
		"  - 冒险结束 → 用 coc_skill_growth 处理技能成长",
		"  - 人物状态变化 → 用 coc_pc 更新 HP/SAN/MP",
		"  - 场景推进 → 用 coc_scene 记录场景/时间",
		"【输出】直接输出剧情叙述文本，不需要任何元信息前缀；需要判定时先调用工具，工具结果返回后再写叙述。"
	];
	const s = state;
	lines.push("", "【当前状态快照】");
	lines.push(`标题：${s.title}｜KP 模式：${s.kpMode === "human" ? "人类 KP（你只做玩家助手，不叙述剧情）" : "AI KP"}`);
	lines.push(`当前场景：${s.currentScene || "（未设定）"}`);
	lines.push(`游戏内时间：${s.time || "（未设定）"}`);
	if (s.synopsis) lines.push(`剧情概述：${s.synopsis}`);
	if (s.scenario !== null) lines.push(`剧本：${s.scenario.name}（${s.scenario.chars} 字符）`);
	if (s.rules !== null) lines.push(`规则：${s.rules.name}`);
	if (s.currentBranchId) {
		const branch = s.branches.find((b) => b.id === s.currentBranchId);
		if (branch !== void 0) lines.push(`当前分支：${branch.title}（选项：${(branch.options ?? []).map((o) => o.label).join(" / ") || "无"}）`);
	}
	if (s.characters.length > 0) {
		lines.push("调查员：");
		for (const pc of s.characters) {
			lines.push(`- ${pc.name}${pc.occupation ? `（${pc.occupation}）` : ""}：HP ${pc.hp} / SAN ${pc.san} / MP ${pc.mp} / LUCK ${pc.luck}${pc.inventory.length > 0 ? `｜物品：${pc.inventory.join("、")}` : ""}`);
		}
	}
	if (s.tasks.length > 0) lines.push(`任务：${s.tasks.map((t) => `${t.title}${t.status === "done" ? "（完成）" : ""}`).join("；")}`);
	if (s.entities.length > 0) {
		lines.push("实体（NPC/地点/物品）：");
		for (const e of s.entities) lines.push(`- [${e.type}] ${e.name}${e.state ? `（${e.state}）` : ""}${e.desc ? `：${e.desc}` : ""}`);
	}
	const hidden = s.keyPoints.filter((k) => !k.revealed);
	if (hidden.length > 0) lines.push(`未揭示关键剧情点：${hidden.length} 个（背景信息，勿直接透露给玩家）`);
	const pending = s.reminders.filter((r) => !r.fired && (r.scene === "" || r.scene === s.currentScene));
	if (pending.length > 0) lines.push(`待提醒（当前场景触发）：${pending.map((r) => r.text).join("；")}`);
	const recent = s.rollHistory.slice(-4);
	if (recent.length > 0) lines.push(`最近检定：${recent.map((r) => `${r.kind === "secret" ? "🔒" : ""}${r.player ? `${r.player} ` : ""}${r.label ? `${r.label} ` : ""}${r.expression}=${r.rolled}${r.tier ? `（${TIER_LABELS[r.tier] ?? r.tier}）` : ""}`).join("；")}`);
	return lines.join("\n");
}
/** 从游戏日志构建模型对话消息（最近 maxLog 条，去掉系统/掷骰噪音只保留 user/kp）。 */
function buildLoopMessages(state, maxLog) {
	const messages = [];
	const tail = state.log.slice(-maxLog);
	for (const entry of tail) {
		if (entry.kind === "user") {
			messages.push({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: entry.player ? `${entry.player}：${entry.text}` : entry.text }] });
		} else if (entry.kind === "kp") {
			messages.push({ role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: entry.text }] });
		}
	}
	if (messages.length === 0) messages.push({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "（开始游戏）" }] });
	return messages;
}
/** 从环境变量或配置文件中读取 LLM 配置。 */
function loadLlmConfig(dataDir) {
	const configFile = join(dataDir, "config.json");
	try {
		if (existsSync(configFile)) {
			return JSON.parse(readFileSync(configFile, "utf8"));
		}
	} catch (e) { /* ignore */ }
	return {};
}
/** 直接调用 OpenAI/DeepSeek 兼容的 LLM API（非流式，用于无 LLM 服务的场景）。 */
async function callLlmApi(dataDir, messages, options = {}) {
	const cfg = loadLlmConfig(dataDir);
	const provider = cfg.llmProvider || process.env.COC_LLM_PROVIDER || "deepseek";
	const apiKey = cfg.apiKey || process.env.COC_API_KEY || "";
	const model = cfg.llmModel || process.env.COC_LLM_MODEL || "deepseek-chat";
	const baseUrl = cfg.apiBaseUrl || process.env.COC_API_BASE_URL || "";
	
	// 根据 provider 确定 API URL
	let url = baseUrl;
	if (!url) {
		if (provider === "deepseek") {
			url = "https://api.deepseek.com/v1/chat/completions";
		} else if (provider === "openai" || provider === "openai-compatible") {
			url = "https://api.openai.com/v1/chat/completions";
		} else {
			url = "https://api.deepseek.com/v1/chat/completions";
		}
	}
	
	if (!apiKey) {
		throw new Error("未配置 API Key，请在设置面板中填写");
	}
	
	const body = {
		model: model,
		messages: messages,
		temperature: options.temperature ?? 0.3,
		max_tokens: options.max_tokens ?? 4096,
		stream: false
	};
	
	// 使用 Node.js 内置 fetch
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": "Bearer " + apiKey
		},
		body: JSON.stringify(body)
	});
	
	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error("LLM API 错误 " + response.status + ": " + errText.slice(0, 200));
	}
	
	const json = await response.json();
	const text = json.choices?.[0]?.message?.content || "";
	return { blocks: [{ type: "text", text }], finish: { kind: "complete" }, usage: json.usage || {} };
}
/** 流式调用 LLM 并组装文本/工具调用块。 */
async function streamBlocks(ctx, store, options) {
	const llm = ctx.get("llm");
	if (llm === void 0) {
		// 尝试使用配置的 API 直接调用
		return callLlmApi(store.dataDir, options.messages, options);
	}
	let model = store.llmModel;
	let provider = store.llmProvider;
	const defaultModel = ctx.get("agentDefaultModel");
	if (defaultModel !== void 0 && typeof defaultModel.currentSelection === "function") {
		const selection = defaultModel.currentSelection();
		if (selection?.provider) provider = selection.provider;
		if (selection?.model) model = selection.model;
	}
	const assembler = new BlockAssembler();
	for await (const chunk of llm.stream({ provider, model, ...options })) assembler.push(chunk);
	return { blocks: assembler.blocks(), finish: assembler.finish, usage: assembler.usage };
}
/** 追加一条游戏日志。 */
function appendLog(state, kind, text, player = "") {
	state.log.push({ seq: state.log.length + 1, at: now(), kind, player, text });
	if (state.log.length > 600) state.log = state.log.slice(-600);
	return state.log[state.log.length - 1];
}
/**
 * KP 迷你循环：追加玩家消息 → 携带状态快照与 coc 工具调 LLM →
 * 执行工具调用 → 继续，直到模型输出纯叙述（上限 maxChatRounds 轮）→ 叙述入日志。
 */
async function runKpTurn(store, defs, gameId, text, player) {
	let state = touchState(store.dataDir, gameId);
	if (state.busy === true) throw new Error("KP 正在回复中，请稍候");
	state.busy = true;
	saveState(store.dataDir, state);
	const panelTools = ["coc_roll", "coc_roll_secret", "coc_scene", "coc_task", "coc_entity", "coc_pc", "coc_branch", "coc_remind", "coc_kp", "coc_query_rule", "coc_sanity_check", "coc_combat_resolve", "coc_skill_growth", "coc_status"];
	try {
		appendLog(state, "user", text, player);
		const messages = buildLoopMessages(state, store.maxChatLog);
		let narration = "";
		let rounds = 0;
		let lastFinish = null;
		for (; rounds < store.maxChatRounds; rounds += 1) {
			const response = await streamBlocks(store.ctx, store, {
				system: buildKpSystemPrompt(state),
				messages,
				tools: panelTools.map((toolName) => {
					const def = defs[toolName];
					return { name: def.name, description: def.description, parameters: def.parameters };
				})
			});
			const blocks = response.blocks;
			lastFinish = response.finish;
			const textBlocks = blocks.filter((block) => block.type === "text");
			const calls = blocks.filter((block) => block.type === "tool-call");
			messages.push({
				role: "assistant",
				source: { kind: "model" },
				content: [
					...textBlocks.map((block) => ({ type: "text", text: block.text })),
					...calls.map((block) => ({ type: "tool-call", id: block.id, name: block.name, arguments: block.arguments }))
				]
			});
			if (calls.length === 0) {
				narration = textBlocks.map((block) => block.text).join("").trim();
				break;
			}
			const traceEntries = [];
			for (const call of calls) {
				const def = defs[call.name];
				let parsed = {};
				try { parsed = JSON.parse(call.arguments || "{}"); } catch { /* 非法参数按空处理 */ }
				const outcome = def === void 0
					? { ok: false, text: `未知工具 ${call.name}` }
					: await executeToolForLoop(def, parsed);
				traceEntries.push({ at: now(), round: rounds + 1, tool: call.name, args: parsed, ok: outcome.ok, text: outcome.text.slice(0, 240) });
				messages.push({
					role: "user",
					source: { kind: "tool", callId: call.id },
					content: [{ type: "tool-result", toolCallId: call.id, content: [{ type: "text", text: outcome.text }], isError: !outcome.ok }]
				});
			}
			// 工具执行已各自持久化状态（骰点/状态变化等）；重新加载最新状态，再合并本轮 trace 写回
			state = loadState(store.dataDir, gameId) ?? state;
			state.toolTrace.push(...traceEntries);
			if (state.toolTrace.length > 200) state.toolTrace = state.toolTrace.slice(-200);
			saveState(store.dataDir, state);
		}
		if (narration.length === 0) {
			if (lastFinish !== null && lastFinish.kind === "error") {
				narration = `（模型调用失败：${lastFinish.failure?.message ?? "未知错误"}）`;
			} else {
				narration = "（本轮未产生叙述，请再说一次你的行动）";
			}
		}
		appendLog(state, "kp", narration);
		saveState(store.dataDir, state);
		return {
			rounds,
			busy: false,
			narration,
			finish: lastFinish ?? null,
			logLength: state.log.length,
			digest: stateDigest(state)
		};
	} finally {
		state.busy = false;
		saveState(store.dataDir, state);
	}
}
//#endregion

/** 渲染 KP 状态面板文本。 */
function renderStatus(value) {
	const lines = [`【跑团状态 · ${value.title ?? value.game}】`];
	lines.push(`KP 模式：${value.kpMode === "ai" ? "AI 担任 KP" : "人类担任 KP"}`);
	lines.push(`当前场景：${value.currentScene || "（未设定）"}`);
	if (value.currentBranch !== void 0 && value.currentBranch !== null) {
		const branch = value.currentBranch;
		lines.push(`当前分支：${branch.title}${branch.chosen ? `（已选择：${branch.chosen}）` : `（选项：${(branch.options ?? []).map((o) => o.label).join(" / ") || "无"}）`}`);
	}
	if (value.rules !== void 0) lines.push(`规则：${value.rules}`);
	if (value.scenario !== void 0) lines.push(`剧本：${value.scenario}`);
	if (Array.isArray(value.characters) && value.characters.length > 0) {
		lines.push(`人物（${value.characters.length}）：${value.characters.map((c) => `${c.name}${c.occupation ? `（${c.occupation}）` : ""}`).join("、")}`);
	}
	if (Array.isArray(value.keyPoints)) {
		const revealed = value.keyPoints.filter((k) => k.revealed);
		const hidden = value.keyPoints.filter((k) => !k.revealed);
		if (revealed.length > 0) lines.push(`已揭示关键剧情点：${revealed.map((k) => k.title).join("、")}`);
		if (hidden.length > 0) lines.push(`未揭示关键剧情点（${hidden.length}）：${hidden.slice(0, 10).map((k) => k.title).join("、")}${hidden.length > 10 ? "…" : ""}`);
	}
	if (Array.isArray(value.branches)) {
		const reached = value.branches.filter((b) => b.reached);
		const open = value.branches.filter((b) => !b.reached);
		if (open.length > 0) lines.push(`待抵达分支（${open.length}）：${open.slice(0, 10).map((b) => `${b.title}${b.scene ? `@${b.scene}` : ""}`).join("、")}${open.length > 10 ? "…" : ""}`);
		if (reached.length > 0) lines.push(`已抵达分支：${reached.map((b) => b.title).join("、")}`);
	}
	if (Array.isArray(value.reminders)) {
		const pending = value.reminders.filter((r) => !r.fired);
		if (pending.length > 0) lines.push(`待提醒（${pending.length}）：${pending.map((r) => `${r.scene ? `[${r.scene}] ` : ""}${r.text}`).join("；")}`);
	}
	if (Array.isArray(value.recentRolls) && value.recentRolls.length > 0) {
		lines.push("最近骰点：");
		for (const roll of value.recentRolls) {
			const tag = roll.kind === "secret" ? "🔒" : "🎲";
			lines.push(`  ${tag} ${roll.player ? `${roll.player} ` : ""}${roll.label ? `${roll.label} ` : ""}${roll.expression} = ${roll.rolled}${roll.target !== null && roll.target !== void 0 ? ` / 目标 ${roll.target}` : ""}${roll.tier ? ` → ${TIER_LABELS[roll.tier] ?? roll.tier}` : ""}${roll.kind === "secret" ? "（暗骰）" : ""}`);
		}
	}
	return lines.join("\n");
}

export { Config, apply, inject, name };

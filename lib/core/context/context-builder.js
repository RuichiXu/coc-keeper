/**
 * Context Builder（LLM 上下文构建器）
 *
 * 从结构化状态 + 知识分层构建：
 * - KP 系统提示（硬性规则 + 工具指引 + 状态快照）
 * - 对话消息（游戏日志 → LLM messages）
 * - 面板摘要文本（供 status / dynamic context 复用）
 *
 * 纯函数，零 DSH 依赖。
 */
import {
  KNOWLEDGE_LAYERS,
  buildKnowledgeView,
  filterRolls,
} from "../knowledge/knowledge-layers.js";

const TIER_LABELS = {
  critical: "大成功",
  extreme: "极限成功",
  hard: "困难成功",
  regular: "常规成功",
  fail: "失败",
  fumble: "大失败",
};

const HARD_RULES = [
  "你是《克苏鲁的呼唤》（CoC 7e）跑团的 KP（守秘人）。当前由 AI 担任 KP，主持一场文字跑团。",
  "【硬性规则】",
  "1. 检定纪律（最高优先级）：玩家要求检定，或你判定某个行为存在成败可能（侦查、潜行、说服、灵感、聆听、战斗等）时，必须【先调用工具】得到结果，再把结果融入叙述。coc_roll 是明骰；明骰的“🎲【明骰】掷 d100 = …”结果行会由系统自动插入会话日志，你不要在叙述中重复这行，只根据结果描写成功或失败的效果。coc_roll_secret 是暗骰（潜行、侦查陷阱、灵感、NPC 暗判定等不宜让玩家知道结果的场合）。",
  "2. 绝对禁止：在叙述中自行编造骰点、自行宣告检定成败。未经工具检定不得判定成败。",
  "3. 暗骰纪律：coc_roll_secret 的具体数值与档位只属于 KP，绝不允许出现在你输出的剧情文字中，只描述效果。",
  "4. 状态必须落地：玩家状态变化（HP/SAN/MP/LUCK、获得/失去物品）调用 coc_pc；场景/游戏内时间/剧情概述变化调用 coc_scene；任务增减调用 coc_task；NPC/地点/物品实体调用 coc_entity；分支抵达与选择、关键点揭示调用 coc_branch；提醒登记调用 coc_remind。",
  "5. 叙述职责：用中文叙述场景、扮演 NPC、制造恐怖氛围；每次回复以剧情推进为主，最后简短提示玩家可选行动，但不要替玩家做决定。",
  "6. 接近关键剧情点或分支时，主动以 KP 口吻提示存在的重要选择。",
  "7. 游戏内时间与事件要连贯（当前时间见状态快照），开场或时间跳转时用 coc_scene 记录。",
  "【规则概要】CoC 7e 规则已内置，你不需要记住完整规则文本。需要了解具体规则时，调用 coc_query_rule 查询。",
  "  - 常规成功 ≤ 技能值，困难成功 ≤ 技能值/2，极限成功 ≤ 技能值/5",
  "  - 01 大成功；技能 < 50 时 96-00 大失败，技能 ≥ 50 时仅 00 大失败",
  "  - 奖励骰：有利条件时额外掷一个十位骰取最优；惩罚骰取最差",
];

const TOOL_GUIDE = [
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
  "【输出】直接输出剧情叙述文本，不需要任何元信息前缀；需要判定时先调用工具，工具结果返回后再写叙述。",
];

/**
 * 渲染一条骰点记录。
 * @param {object} roll
 * @returns {string}
 */
export function renderRollLineForState(roll) {
  const tag = roll.kind === "secret" ? "🔒" : "🎲";
  const who = roll.player ? `${roll.player} ` : "";
  const what = roll.label ? `${roll.label} ` : "";
  const target = roll.target !== null && roll.target !== undefined ? ` / 目标 ${roll.target}` : "";
  const tier = roll.tier ? ` → ${TIER_LABELS[roll.tier] ?? roll.tier}` : "";
  const secretTag = roll.kind === "secret" ? "（暗骰）" : "";
  return `${tag} ${who}${what}${roll.expression} = ${roll.rolled}${target}${tier}${secretTag}`;
}

/**
 * 构建 KP 系统提示（硬性规则 + 工具指引 + 按知识层过滤的状态快照）。
 * @param {object} state - 普通对象状态
 * @param {string} [layer="kp-full"]
 * @returns {string}
 */
export function buildKpSystemPrompt(state, layer = KNOWLEDGE_LAYERS.KP_FULL) {
  const view = buildKnowledgeView(state, layer);
  const lines = [...HARD_RULES, ...TOOL_GUIDE];
  const s = view;

  lines.push("", "【当前状态快照】");
  lines.push(`标题：${s.title}｜KP 模式：${s.kpMode === "human" ? "人类 KP（你只做玩家助手，不叙述剧情）" : "AI KP"}`);
  lines.push(`当前场景：${s.currentScene || "（未设定）"}`);
  lines.push(`游戏内时间：${s.time || "（未设定）"}`);
  if (s.synopsis) lines.push(`剧情概述：${s.synopsis}`);
  if (s.scenario !== null && s.scenario !== undefined) lines.push(`剧本：${s.scenario.name}（${s.scenario.chars} 字符）`);
  if (s.rules !== null && s.rules !== undefined) lines.push(`规则：${s.rules.name}`);
  if (s.endingStatus) lines.push(`结局可达性：${s.endingStatus}`);

  if (s.currentBranchId && s.branches.length > 0) {
    const branch = s.branches.find((b) => b.id === s.currentBranchId);
    if (branch !== undefined) {
      lines.push(`当前分支：${branch.title}（选项：${(branch.options ?? []).map((o) => o.label).join(" / ") || "无"}）`);
    }
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
  const revealed = s.keyPoints.filter((k) => k.revealed);
  if (revealed.length > 0) lines.push(`已揭示关键剧情点：${revealed.map((k) => k.title).join("、")}`);

  const pending = s.reminders.filter((r) => !r.fired && (r.scene === "" || r.scene === s.currentScene));
  if (pending.length > 0) lines.push(`待提醒（当前场景触发）：${pending.map((r) => r.text).join("；")}`);

  if (s.recentRolls.length > 0) {
    lines.push(`最近检定：${s.recentRolls.map((r) => `${r.kind === "secret" ? "🔒" : ""}${r.player ? `${r.player} ` : ""}${r.label ? `${r.label} ` : ""}${r.expression}=${r.rolled}${r.tier ? `（${TIER_LABELS[r.tier] ?? r.tier}）` : ""}`).join("；")}`);
  }
  return lines.join("\n");
}

/**
 * 从游戏日志构建 LLM 对话消息。
 * @param {Array<object>} log
 * @param {number} [maxLog=120]
 * @returns {Array<object>}
 */
export function buildLoopMessages(log, maxLog = 120) {
  const messages = [];
  const tail = (log ?? []).slice(-maxLog);
  for (const entry of tail) {
    if (entry.kind === "user") {
      messages.push({
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: entry.player ? `${entry.player}：${entry.text}` : entry.text }],
      });
    } else if (entry.kind === "kp") {
      messages.push({
        role: "assistant",
        source: { kind: "model" },
        content: [{ type: "text", text: entry.text }],
      });
    }
  }
  if (messages.length === 0) {
    messages.push({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "（开始游戏）" }] });
  }
  return messages;
}

/**
 * 构建面板状态摘要文本（供 coc_status render / dynamic context 复用）。
 * @param {object} value - coc_status 输出结构
 * @returns {string}
 */
export function renderStatusText(value) {
  const lines = [`【跑团状态 · ${value.title ?? value.game}】`];
  lines.push(`KP 模式：${value.kpMode === "ai" ? "AI 担任 KP" : "人类担任 KP"}`);
  lines.push(`当前场景：${value.currentScene || "（未设定）"}`);
  if (value.currentBranch !== undefined && value.currentBranch !== null) {
    const branch = value.currentBranch;
    lines.push(`当前分支：${branch.title}${branch.chosen ? `（已选择：${branch.chosen}）` : `（选项：${(branch.options ?? []).map((o) => o.label).join(" / ") || "无"}）`}`);
  }
  if (value.rules !== undefined) lines.push(`规则：${value.rules}`);
  if (value.scenario !== undefined) lines.push(`剧本：${value.scenario}`);
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
    for (const roll of value.recentRolls) lines.push(`  ${renderRollLineForState(roll)}`);
  }
  return lines.join("\n");
}

/**
 * 构建完整 LLM 上下文。
 * @param {object} state
 * @param {object} [opts]
 * @param {string} [opts.layer="kp-full"]
 * @param {number} [opts.maxLog=120]
 * @param {number} [opts.maxRecentRolls=12]
 * @returns {{ system: string, messages: Array<object>, view: object }}
 */
export function buildContext(state, opts = {}) {
  const layer = opts.layer ?? KNOWLEDGE_LAYERS.KP_FULL;
  const maxLog = opts.maxLog ?? 120;
  const view = buildKnowledgeView({ ...state, maxRecentRolls: opts.maxRecentRolls ?? 12 }, layer);
  return {
    system: buildKpSystemPrompt(state, layer),
    messages: buildLoopMessages(state.log, maxLog),
    view,
  };
}

export { KNOWLEDGE_LAYERS, buildKnowledgeView, filterRolls };

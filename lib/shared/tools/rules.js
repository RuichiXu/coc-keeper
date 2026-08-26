/**
 * 规则裁决工具：coc_sanity_check / coc_combat_resolve / coc_skill_growth
 *
 * 全部走 Core Rule Engine → 事件 → WorldState。
 */
import {
  performSanityCheck,
  performCombatRound,
  performSkillGrowth,
} from "../../core/index.js";
import {
  loadSession,
  commitSession,
  gameIdOf,
} from "./helpers.js";
import { clueWordsForCheckpoint } from "../chat/narration-guard.js";

/**
 * 从剧本检定点推导 SAN 事件的规范幂等键。
 * 同一超自然现象（巨眼/漩涡/墨渊…）无论 LLM 如何换描述和 eventId，
 * 都映射到同一 scenarioCheckpoint.id，避免重复扣 SAN。
 * @param {object} flat
 * @param {string} description
 * @returns {string|null} 规范键 "scenario:<checkpoint.id>"
 */
function canonicalSanityEventId(flat, description) {
  const text = String(description ?? "");
  const checkpoints = (flat.scenarioCheckpoints ?? []).filter(
    (check) => check?.skill === "理智"
  );
  let best = null;
  let bestScore = 0;
  for (const check of checkpoints) {
    const words = clueWordsForCheckpoint(check);
    let score = 0;
    for (const word of words) {
      if (word.length >= 2 && text.includes(word)) score += 1;
    }
    if (score > bestScore) {
      best = check;
      bestScore = score;
    }
  }
  if (best === null || bestScore <= 0) return null;
  const id = typeof best.id === "string" && best.id.length > 0 ? best.id : `chk-${best.skill}-${best.scene}`;
  return `scenario:${id}`;
}

/**
 * 注册 SAN / 战斗 / 技能成长工具。
 * @param {object} ctx
 * @param {object} deps
 */
export function createRuleToolDefs(deps) {
  const defs = [];
  defs.push({
      name: "coc_sanity_check",
      description:
        "执行理智检定：根据 SAN 损失值（如「0/1d3」「1/1d6+1」）进行掷骰判定，自动应用 SAN 损失，检查是否触发临时性/不定性疯狂，并更新人物状态。适用于看到神话生物、恐怖场景、超自然事件等场合。",
      parameters: {
        game: { type: "string", description: "游戏 ID" },
        player: { type: "string", required: true, description: "调查员姓名" },
        sanLoss: {
          type: "string",
          required: true,
          description:
            "SAN 损失格式，如「0/1d3」表示成功损失 0、失败损失 1d3；「1/1d6+1」表示成功损失 1、失败损失 1d6+1；也可直接写固定值如「1d3」",
        },
        description: { type: "string", description: "导致 SAN 损失的事件描述，如「目睹深潜者」" },
        eventId: { type: "string", description: "SAN 事件幂等键，如「墨渊首次目击」。同一角色+同一事件只应结算一次；提供后系统自动去重，重复调用不会再次掷骰/扣 SAN" },
        difficulty: { type: "string", enum: ["regular", "hard", "extreme"], description: "检定难度（默认常规）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            player: { type: "string" },
            result: { type: "string" },
            passed: { type: "boolean" },
            sanLost: { type: "number" },
            sanBefore: { type: "number" },
            sanAfter: { type: "number" },
            madness: { type: "string" },
            rolled: { type: "number" },
            tier: { type: "string" },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `【理智检定】${value.player}：${value.result}` },
        ],
      },
      presentCall: () => ({
        card: "generic",
        title: "理智检定",
        kind: "SAN",
        rawInput: "",
      }),
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);

        const playerName = String(args.player ?? "").trim();
        const pc = session.world.findCharacter(playerName);
        if (pc === undefined) throw new Error(`未找到调查员「${playerName}」`);

        let eventId = String(args.eventId ?? "").trim();
        // 剧本检定点提供稳定规范 ID：LLM 换描述/换 eventId 也会映射到同一 ID，防止重复扣 SAN。
        const canonical = canonicalSanityEventId(flat, args.description ?? "");
        if (canonical !== null) eventId = canonical;

        const settled = Array.isArray(flat.sanitySettled) ? flat.sanitySettled : (flat.sanitySettled = []);

        // 幂等：同一角色 + 同一事件只结算一次（LLM 重试/空叙述重写不得重复扣 SAN）。
        // 兼容升级前的旧事件键：旧 eventId 若也能映射到同一规范键，同样视为已结算。
        if (eventId.length > 0) {
          const existing = settled.find(
            (entry) =>
              entry.player === playerName &&
              (entry.eventId === eventId ||
                canonicalSanityEventId(flat, entry.eventId ?? "") === eventId)
          );
          if (existing !== undefined) {
            const resultStr = `（已结算，未重复扣减）${existing.result}`;
            return {
              player: playerName,
              result: resultStr,
              passed: existing.passed,
              sanLost: 0,
              sanBefore: existing.sanAfter,
              sanAfter: existing.sanAfter,
              madness: "无",
              rolled: existing.rolled,
              tier: existing.tier,
            };
          }
        }

        const result = performSanityCheck({
          characterName: playerName,
          currentSan: pc.san ?? pc.stats?.SAN ?? 50,
          intValue: pc.stats?.INT ?? 50,
          sanLoss: args.sanLoss,
          description: args.description ?? "",
          eventId,
          gameId,
        });

        const resultStr = `${result.passed ? "成功" : "失败"}（出目 ${result.rolled}/${result.sanBefore}，${result.tier}）${result.sanLost > 0 ? `，损失 ${result.sanLost} SAN（${result.sanBefore} → ${result.sanAfter}）` : "，未损失 SAN"}${result.madness !== "无" ? `\n⚡ ${result.madness}` : ""}`;

        if (eventId.length > 0) {
          settled.push({
            player: playerName,
            eventId,
            description: args.description ?? "",
            at: new Date().toISOString(),
            result: resultStr,
            passed: result.passed,
            rolled: result.rolled,
            tier: result.tier,
            sanAfter: result.sanAfter,
          });
          if (settled.length > 80) flat.sanitySettled = settled.slice(-80);
        }

        commitSession(deps, gameId, session, flat, result.events);

        return {
          player: playerName,
          result: resultStr,
          passed: result.passed,
          sanLost: result.sanLost,
          sanBefore: result.sanBefore,
          sanAfter: result.sanAfter,
          madness: result.madness,
          rolled: result.rolled,
          tier: result.tier,
        };
      },
  });

  defs.push({
      name: "coc_combat_resolve",
      description:
        "执行战斗回合结算：攻击方对防御方进行一次攻击判定，包含命中检定、闪避/反击、伤害掷骰（含伤害加值 DB）、护甲减免，并自动更新双方 HP 状态。适用于近战和远程战斗。",
      parameters: {
        game: { type: "string", description: "游戏 ID" },
        attacker: { type: "string", required: true, description: "攻击方名称（调查员或 NPC 实体名）" },
        defender: { type: "string", required: true, description: "防御方名称" },
        weapon: { type: "string", description: "武器名，如「格斗（斗殴）」「.38 左轮手枪」「猎刀」" },
        skill: { type: "string", description: "使用的技能，如「格斗（斗殴）」「射击（手枪）」；缺省根据武器自动推断" },
        attackerIsEntity: { type: "boolean", description: "攻击方是否为 NPC 实体（而非调查员）" },
        defenderIsEntity: { type: "boolean", description: "防御方是否为 NPC 实体" },
        defenderDodge: { type: "boolean", description: "防御方是否尝试闪避" },
        range: {
          type: "string",
          enum: ["point-blank", "close", "medium", "far", "extreme"],
          description: "远程攻击的射程（point-blank=近距/close=中距/medium=远距/far=极远/extreme=超远）",
        },
        cover: { type: "string", description: "防御方掩蔽情况，如「半身掩体」「全掩体」" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            result: { type: "string" },
            hit: { type: "boolean" },
            damage: { type: "number" },
            hpBefore: { type: "number" },
            hpAfter: { type: "number" },
            attackerRoll: { type: "number" },
            defenderRoll: { type: "number" },
            details: { type: "string" },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `【战斗结算】${value.result}` },
        ],
      },
      presentCall: () => ({
        card: "generic",
        title: "战斗结算",
        kind: "战斗",
        rawInput: "",
      }),
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);

        const attackerName = String(args.attacker ?? "").trim();
        const defenderName = String(args.defender ?? "").trim();
        const attacker = args.attackerIsEntity
          ? session.world.findEntityByName(attackerName)
          : session.world.findCharacter(attackerName);
        const defender = args.defenderIsEntity
          ? session.world.findEntityByName(defenderName)
          : session.world.findCharacter(defenderName);

        if (attacker === undefined) throw new Error(`未找到攻击方「${attackerName}」`);
        if (defender === undefined) throw new Error(`未找到防御方「${defenderName}」`);

        const result = performCombatRound({
          attackerName,
          defenderName,
          attacker,
          defender,
          weapon: args.weapon ?? "格斗（斗殴）",
          skill: args.skill ?? "",
          defenderDodge: args.defenderDodge === true,
          range: args.range ?? "close",
          defenderIsEntity: args.defenderIsEntity === true,
          gameId,
        });

        commitSession(deps, gameId, session, flat, result.events);

        return {
          result: `${result.hit ? "命中" : result.dodgeSuccess ? "被闪避" : "未命中"}${result.hit ? `，造成 ${result.damage} 点伤害` : ""}`,
          hit: result.hit,
          damage: result.damage,
          hpBefore: result.hpBefore,
          hpAfter: result.hpAfter,
          attackerRoll: result.attackerRoll,
          defenderRoll: result.defenderRoll,
          details: result.details,
        };
      },
  });

  defs.push({
      name: "coc_skill_growth",
      description:
        "在冒险结束时，为调查员尝试技能成长：在技能旁打勾标记，掷 d100 若大于当前技能值则增加 1d10。适用于冒险结束阶段或 KP 允许的时机。",
      parameters: {
        game: { type: "string", description: "游戏 ID" },
        player: { type: "string", required: true, description: "调查员姓名" },
        skill: { type: "string", required: true, description: "技能名称，如「侦查」「潜行」「格斗（斗殴）」" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            player: { type: "string" },
            skill: { type: "string" },
            before: { type: "number" },
            after: { type: "number" },
            rolled: { type: "number" },
            grown: { type: "boolean" },
            result: { type: "string" },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `【技能成长】${value.player} - ${value.skill}：${value.result}` },
        ],
      },
      presentCall: () => ({
        card: "generic",
        title: "技能成长",
        kind: "成长",
        rawInput: "",
      }),
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);

        const playerName = String(args.player ?? "").trim();
        const skillName = String(args.skill ?? "").trim();
        const pc = session.world.findCharacter(playerName);
        if (pc === undefined) throw new Error(`未找到调查员「${playerName}」`);

        const result = performSkillGrowth({
          characterName: playerName,
          skillName,
          currentValue: pc.skills?.[skillName] ?? 0,
          gameId,
        });

        commitSession(deps, gameId, session, flat, result.events);

        const resultStr = result.grown
          ? `成功！出目 ${result.rolled} > ${result.before}，技能提升 ${result.gain} 点（${result.before} → ${result.after}）`
          : `失败。出目 ${result.rolled} ≤ ${result.before}，技能未提升（仍为 ${result.before}）`;

        return {
          player: playerName,
          skill: skillName,
          before: result.before,
          after: result.after,
          rolled: result.rolled,
          grown: result.grown,
          result: resultStr,
        };
      },
  });

  return defs;
}



/**
 * 骰点工具：coc_roll（明骰）/ coc_roll_secret（暗骰）
 *
 * Tool → Core dice.performRoll → RollPerformed 事件 → WorldState
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { performRoll, renderRollLine } from "../../core/index.js";
import {
  loadSession,
  commitSession,
  gameIdOf,
  rollEvent,
} from "./helpers.js";

/**
 * 注册 coc_roll 与 coc_roll_secret。
 * @param {object} ctx - DSH ctx
 * @param {object} deps - { session, persistence, stateKey, defaultGame, maxRollHistory }
 */
export function registerRollTools(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: "coc_roll",
      description:
        "明骰（公开检定）：掷骰结果对所有人可见。支持任意骰式（d100、3d6、d20+2 等）。CoC 7e 中提供 target（技能值）与 difficulty（常规/困难/极限）时按 7e 规则判定成功档次（含大成功/大失败）。玩家提出的检定一律用本工具，不要自行编造结果。",
      parameters: {
        expression: { type: "string", required: true, description: "骰式，如 d100、3d6、d20+2" },
        target: { type: "number", description: "目标技能值（如 60）；百分骰时按 CoC 7e 分档判定" },
        difficulty: { type: "string", enum: ["regular", "hard", "extreme"], description: "检定难度：常规/困难/极限" },
        player: { type: "string", description: "掷骰人（玩家名或 NPC 名）" },
        label: { type: "string", description: "检定说明，如「侦查走廊」" },
        skill: { type: "string", description: "技能名（记录用），如「侦查」" },
        game: { type: "string", description: "游戏 ID" },
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
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `🎲【明骰】${value.player ? `${value.player} ` : ""}${value.label ? `· ${value.label} ` : ""}${renderRollLine({ ...value, expression: value.expression })}`,
          },
        ],
      },
      presentCall: (args) => ({
        card: "generic",
        title: "明骰",
        kind: "掷骰",
        rawInput: `${args.player ?? ""} ${args.label ?? ""} ${args.expression}`,
      }),
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);

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
        };

        commitSession(deps, gameId, session, flat, [
          rollEvent(gameId, {
            kind: "open",
            player: args.player ?? "",
            label: args.label ?? "",
            skill: args.skill ?? "",
            expression: args.expression,
            dice: result.dice,
            rolled: result.rolled,
            total: result.total,
            target: result.target,
            difficulty: result.difficulty ?? "regular",
            tier: result.tier,
            passed: result.passed,
          }),
        ]);

        return outcome;
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "coc_roll_secret",
      description:
        "暗骰（秘密检定）：只有 KP 能看到具体数值，玩家只应看到效果描述。用于潜行、侦查陷阱、灵感、NPC 暗判定等不应让玩家知道结果的场合。调用后请勿向玩家透露具体骰值与成功档位，只描述剧情效果。",
      parameters: {
        expression: { type: "string", required: true, description: "骰式，如 d100、3d6、d20+2" },
        target: { type: "number", description: "目标技能值（如 60）；百分骰时按 CoC 7e 分档判定" },
        difficulty: { type: "string", enum: ["regular", "hard", "extreme"], description: "检定难度" },
        player: { type: "string", description: "掷骰人（玩家名或 NPC 名）" },
        label: { type: "string", description: "检定说明" },
        skill: { type: "string", description: "技能名（记录用）" },
        game: { type: "string", description: "游戏 ID" },
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
            secret: { type: "boolean" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `🔒【暗骰】${value.player ? `${value.player} ` : ""}${value.label ? `· ${value.label} ` : ""}${renderRollLine({ ...value, expression: value.expression })}`,
          },
        ],
      },
      presentCall: (args) => ({
        card: "generic",
        title: "暗骰",
        kind: "掷骰",
        rawInput: `${args.player ?? ""} ${args.label ?? ""} ${args.expression}`,
      }),
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);

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
          secret: true,
        };

        commitSession(deps, gameId, session, flat, [
          rollEvent(gameId, {
            kind: "secret",
            player: args.player ?? "",
            label: args.label ?? "",
            skill: args.skill ?? "",
            expression: args.expression,
            dice: result.dice,
            rolled: result.rolled,
            total: result.total,
            target: result.target,
            difficulty: result.difficulty ?? "regular",
            tier: result.tier,
            passed: result.passed,
          }),
        ]);

        return outcome;
      },
    })
  );
}

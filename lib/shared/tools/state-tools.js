/**
 * 状态管理工具：coc_scene / coc_kp / coc_pc / coc_task / coc_entity / coc_character
 *
 * 世界状态类数据操作 session.world（唯一事实来源），
 * 剧情结构类数据（keyPoints/branches/reminders）暂时仍操作 flat 兼容字段，
 * 待 Trigger/Director 模块成熟后迁入 PlotGraph。
 */
import { advanceGameTime, normalizeCharacter, evaluateScheduledEvents } from "../../core/index.js";
import { formatCheckLine } from "../chat/check-command.js";
import { checkKey, gateTargetKey, sanitizeGateAction } from "../chat/check-gates.js";
import { findCheckpointMatch } from "../chat/checkpoint-match.js";
import { expireSceneGates } from "../chat/gate-lifecycle.js";
import {
  loadSession,
  commitSession,
  gameIdOf,
  gateCreatedEvent,
  nextId,
  nowIso,
} from "./helpers.js";

/**
 * @param {object} ctx
 * @param {object} deps
 */
export function createStateToolDefs(deps) {
  const defs = [];
  // ── coc_scene ───────────────────────────────────────────
  defs.push({
      name: "coc_scene",
      description:
        "更新剧情状态（KP/面板用）：设置当前场景、游戏内时间或剧情概述。scene/time/synopsis 至少提供一个，或单独用 timeAdvance 快捷推进时间；只更新提供的字段。",
      parameters: {
        game: { type: "string", description: "游戏 ID" },
        scene: { type: "string", description: "当前场景名，如「废弃宅邸-书房」" },
        time: { type: "string", description: "游戏内时间/日期，如「1925年10月1日 下午3点」" },
        synopsis: { type: "string", description: "剧情概述（一句话或一段）" },
        timeAdvance: {
          type: "string",
          enum: ["hour", "day", "night"],
          description: "快捷推进时间：hour=+1小时，day=+1天，night=到夜晚21点",
        },
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
            synopsis: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[剧情状态] ${value.message}\n场景：${value.scene || "（未设定）"}${value.time ? `\n时间：${value.time}` : ""}${value.synopsis ? `\n概述：${value.synopsis}` : ""}`,
          },
        ],
      },
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        const world = session.world;
        const changed = [];
        const events = [];

        if (typeof args.scene === "string" && args.scene.trim().length > 0) {
          world.currentScene = args.scene.trim();
          changed.push(`场景→${world.currentScene}`);
          events.push({ type: "SceneChanged", at: nowIso(), gameId, from: flat.currentScene ?? "", to: world.currentScene });
          // Scene 事件：场景切走后立即清理绑定旧场景的门禁（不再等下一轮聊天）。
          const expired = expireSceneGates(flat, world.currentScene, nowIso());
          if (expired > 0) {
            session.recordTrace({ kind: "gate-expired-scene", count: expired, at: nowIso() });
          }
        }
        if (typeof args.time === "string" && args.time.trim().length > 0) {
          world.time = args.time.trim();
          changed.push(`时间→${world.time}`);
          events.push({ type: "TimeAdvanced", at: nowIso(), gameId, from: flat.time ?? "", to: world.time });
        }
        if (typeof args.synopsis === "string" && args.synopsis.trim().length > 0) {
          world.synopsis = args.synopsis.trim();
          changed.push("概述已更新");
        }
        if (typeof args.timeAdvance === "string" && args.timeAdvance.length > 0) {
          const from = world.time;
          world.time = advanceGameTime(world.time, args.timeAdvance);
          changed.push(`时间→${world.time}`);
          events.push({ type: "TimeAdvanced", at: nowIso(), gameId, from, to: world.time });
        }
        if (changed.length === 0) throw new Error("scene/time/synopsis/timeAdvance 至少提供一个");

        // 时间推进后评估定时事件（Game Clock）
        if ((args.time !== undefined || args.timeAdvance !== undefined) && world.scheduledEvents?.length > 0) {
          const { fired } = evaluateScheduledEvents(world.scheduledEvents, world.time);
          for (const event of fired) {
            event.fired = true;
            session.recordTrace({ kind: "scheduled-event", id: event.id, at: event.at, text: event.text });
            // 时间事件桥接：事件可产出 checkpointId，写入已通过检定点，
            // 供 deepParse 的 checkpointGroups 条件引用（如“22:00 夜宴开始”）。
            const checkpointId = String(event.checkpointId ?? "").trim();
            if (checkpointId.length > 0) {
              if (!Array.isArray(flat.passedCheckpointIds)) flat.passedCheckpointIds = [];
              if (!flat.passedCheckpointIds.includes(checkpointId)) flat.passedCheckpointIds.push(checkpointId);
            }
          }
        }

        commitSession(deps, gameId, session, flat, events);
        return {
          game: gameId,
          message: changed.join("；"),
          scene: world.currentScene,
          time: world.time,
          synopsis: world.synopsis,
        };
      },
  });

  // ── coc_check ──────────────────────────────────────────
  // KP 登记“必须由玩家 .ra 才能推进”的检定门禁。
  defs.push({
      name: "coc_check",
      description:
        "登记一个需要玩家明骰的技能检定门禁（KP 专用）。当某个动作需要玩家过检定时调用；系统会渲染 [团检：技能] [.ra技能] 提示，并在玩家完成检定前阻止该动作推进剧情。action 填写与该检定绑定的动作文本（推荐选项原文）；hidden=true 表示该检定要求剧透、不要在推荐选项中展示（战斗/追逐/剧透场景用）。",
      parameters: {
        game: { type: "string", description: "游戏 ID" },
        skill: { type: "string", description: "技能名，如「侦查」「攀爬」「图书馆使用」" },
        difficulty: {
          type: "string",
          enum: ["regular", "hard", "extreme"],
          description: "检定难度，默认 regular",
        },
        action: { type: "string", description: "与该检定绑定的玩家动作文本（推荐选项原文）；自由动作可不填" },
        hidden: { type: "boolean", description: "是否剧透检定要求（true 则不在推荐选项中展示）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            game: { type: "string" },
            message: { type: "string" },
            skill: { type: "string" },
            difficulty: { type: "string" },
            action: { type: "string" },
            hidden: { type: "boolean" },
            line: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[检定门禁] ${value.message}\n${value.line}${value.action ? `\n绑定动作：${value.action}` : ""}${value.hidden ? "（剧透模式）" : ""}\n玩家发送对应 .ra 前，不要叙述该动作的结果。`,
          },
        ],
      },
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const skill = String(args.skill ?? "").trim();
        if (skill.length === 0) throw new Error("skill 必填");
        if (skill === "理智" || /^SAN$/i.test(skill)) {
          throw new Error("理智检定请调用 coc_sanity_check（明骰结算并应用 SAN 损失，带 eventId），不要登记普通技能门禁");
        }
        const difficulty =
          args.difficulty === "hard" || args.difficulty === "extreme" ? args.difficulty : "regular";
        const action = sanitizeGateAction(args.action ?? "");
        const hidden = args.hidden === true;

        const { session, flat } = loadSession(deps, gameId);
        const pending = Array.isArray(flat.pendingChecks) ? flat.pendingChecks : (flat.pendingChecks = []);
        // 门禁创建时直接绑定检定点与目标键：后续消费/短路不再依赖掷骰时的启发式匹配。
        const checkpoint = findCheckpointMatch(flat, skill, difficulty, action);
        const gate = {
          skill,
          difficulty,
          action,
          hidden,
          target: gateTargetKey(action),
          ...(checkpoint?.id !== undefined && checkpoint?.id !== null && String(checkpoint.id).length > 0
            ? { checkpointId: String(checkpoint.id) }
            : {}),
        };
        const key = checkKey(gate);
        const existing = pending.find((check) => checkKey(check) === key);
        let createdGate = null;
        if (existing === undefined) {
          createdGate = {
            id: nextId("chk", pending, "id"),
            ...gate,
            at: nowIso(),
            scene: session.world.currentScene ?? "",
            source: "kp-tool",
          };
        } else if (existing.checkpointId === undefined || existing.checkpointId === null || String(existing.checkpointId).length === 0) {
          // 同键旧门禁缺少 checkpointId 时补齐（旧数据升级）。
          if (gate.checkpointId !== undefined) existing.checkpointId = gate.checkpointId;
          if (existing.target === undefined && gate.target.length > 0) existing.target = gate.target;
        }
        commitSession(deps, gameId, session, flat, createdGate !== null ? [gateCreatedEvent(gameId, createdGate)] : []);
        const line = formatCheckLine(skill, difficulty);
        return {
          game: gameId,
          skill,
          difficulty,
          action,
          hidden,
          line,
          message: existing !== undefined ? "该检定门禁已存在，未重复登记" : "已登记玩家明骰门禁",
        };
      },
  });

  // ── coc_kp ──────────────────────────────────────────────
  defs.push({
      name: "coc_kp",
      description:
        "切换/查看 KP 模式：ai 模式由 AI 担任 KP（叙述世界、扮演 NPC、主持检定）；human 模式由人类玩家担任 KP，AI 转为玩家助手（查规则、代掷、记录状态、提示剧情结构）。玩家可随时要求切换，实现「AI 扮演 KP / 随时接替」。",
      parameters: {
        action: { type: "string", enum: ["status", "ai", "human"], required: true, description: "status 查看当前模式；ai 切换为 AI 当 KP；human 切换为人类当 KP" },
        game: { type: "string", description: "游戏 ID" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            game: { type: "string" },
            kpMode: { type: "string" },
            message: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: `[KP 模式] ${value.message}` }],
      },
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        const world = session.world;
        let message = "";

        if (args.action === "ai" || args.action === "human") {
          world.kpMode = args.action;
          message =
            args.action === "ai"
              ? "已切换：AI 担任 KP（请以主持人身份继续，保持剧情连贯并主动提示分支）"
              : "已切换：人类担任 KP，AI 转为玩家助手（只查规则、代掷骰、记录状态，不再替 KP 叙述剧情）";
        } else {
          message =
            world.kpMode === "ai"
              ? "当前由 AI 担任 KP"
              : "当前由人类担任 KP（AI 为玩家助手）";
        }

        commitSession(deps, gameId, session, flat);
        return { game: gameId, kpMode: world.kpMode, message };
      },
  });

  // ── coc_pc ──────────────────────────────────────────────
  defs.push({
      name: "coc_pc",
      description:
        "更新玩家人物状态（KP/面板用）：按姓名修改 hp/san/mp/luck、增删随身物品。只更新提供的字段；物品增减用 inventoryAdd/inventoryRemove。",
      parameters: {
        game: { type: "string", description: "游戏 ID" },
        name: { type: "string", required: true, description: "人物名（按姓名匹配）" },
        hp: { type: "number", description: "生命值" },
        san: { type: "number", description: "理智值" },
        mp: { type: "number", description: "魔法值" },
        luck: { type: "number", description: "幸运" },
        inventoryAdd: { type: "string", description: "要加入物品栏的物品名" },
        inventoryRemove: { type: "string", description: "要从物品栏移除的物品名" },
        notes: { type: "string", description: "追加到备注的文本" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            game: { type: "string" },
            message: { type: "string" },
            character: { type: "object", additionalProperties: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: `[人物状态] ${value.message}` }],
      },
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        const pc = session.world.findCharacter(args.name);
        if (pc === undefined) {
          throw new Error(`人物「${args.name}」不存在（可用 coc_character add 或 coc_import 导入）`);
        }

        const changed = [];
        const updates = {};
        if (typeof args.hp === "number") { updates.hp = args.hp; changed.push(`HP→${args.hp}`); }
        if (typeof args.san === "number") { updates.san = args.san; changed.push(`SAN→${args.san}`); }
        if (typeof args.mp === "number") { updates.mp = args.mp; changed.push(`MP→${args.mp}`); }
        if (typeof args.luck === "number") { updates.luck = args.luck; changed.push(`LUCK→${args.luck}`); }
        session.world.updateCharacter(args.name, updates);

        if (typeof args.inventoryAdd === "string" && args.inventoryAdd.trim().length > 0) {
          session.world.addInventoryItem(args.name, args.inventoryAdd.trim());
          changed.push(`获得物品「${args.inventoryAdd.trim()}」`);
        }
        if (typeof args.inventoryRemove === "string" && args.inventoryRemove.trim().length > 0) {
          session.world.removeInventoryItem(args.name, args.inventoryRemove.trim());
          changed.push(`失去物品「${args.inventoryRemove.trim()}」`);
        }
        if (typeof args.notes === "string" && args.notes.trim().length > 0) {
          pc.notes = `${pc.notes}${pc.notes.length > 0 ? "\n" : ""}${args.notes.trim()}`;
          changed.push("备注已追加");
        }
        if (changed.length === 0) throw new Error("没有提供任何要更新的字段");

        commitSession(deps, gameId, session, flat);
        return { game: gameId, message: `「${pc.name}」${changed.join("；")}`, character: pc };
      },
  });

  // ── coc_task ────────────────────────────────────────────
  defs.push({
      name: "coc_task",
      description: "管理任务栏（KP/面板用）：add 添加任务、complete 标记完成、reopen 重新打开、remove 删除。",
      parameters: {
        action: { type: "string", enum: ["add", "complete", "reopen", "remove"], required: true, description: "操作" },
        game: { type: "string", description: "游戏 ID" },
        title: { type: "string", description: "add 时的任务标题" },
        note: { type: "string", description: "add 时的任务备注（可选）" },
        taskId: { type: "string", description: "complete/reopen/remove 时的任务 ID" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string" },
            game: { type: "string" },
            message: { type: "string" },
            tasks: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        render: (_args, value) => [{ type: "text", text: `[任务] ${value.message}（共 ${value.tasks?.length ?? 0} 条）` }],
      },
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        const tasks = session.world.tasks;
        let message = "";

        if (args.action === "add") {
          tasks.push({
            id: nextId("task", tasks),
            title: String(args.title ?? "未命名任务"),
            note: String(args.note ?? ""),
            status: "open",
          });
          message = `已添加任务「${args.title}」`;
        } else if (args.action === "complete" || args.action === "reopen") {
          const task = tasks.find((t) => t.id === args.taskId);
          if (task === undefined) throw new Error(`任务 ${args.taskId} 不存在`);
          task.status = args.action === "complete" ? "done" : "open";
          message = `任务「${task.title}」${args.action === "complete" ? "已完成" : "已重新打开"}`;
        } else if (args.action === "remove") {
          const before = tasks.length;
          session.world.tasks = tasks.filter((t) => t.id !== args.taskId);
          if (session.world.tasks.length === before) throw new Error(`任务 ${args.taskId} 不存在`);
          message = `已删除任务 ${args.taskId}`;
        }

        commitSession(deps, gameId, session, flat);
        return { action: args.action, game: gameId, message, tasks: session.world.tasks };
      },
  });

  // ── coc_entity ──────────────────────────────────────────
  defs.push({
      name: "coc_entity",
      description:
        "管理剧情中的可交互实体（KP/面板用）：NPC、地点、物品、组织等。add 添加、update 修改、remove 删除、list 列出、reveal 揭示（对玩家可见）。实体分两层：desc/state 是 KP 底牌（玩家不可见），playerDesc/playerState 是玩家认知（reveal 时或 update 时写入，玩家视图只读取这两项）。剧本导入时会按标记草拟实体，可在此基础上校对；默认不向玩家视图透露实体。",
      parameters: {
        action: { type: "string", enum: ["add", "update", "remove", "list", "reveal"], required: true, description: "操作" },
        game: { type: "string", description: "游戏 ID" },
        entity: {
          type: "object",
          additionalProperties: true,
          description: "add/update 的实体：{id?, type: npc|location|item|org|other, name, desc?, state?, scene?, revealed?, playerDesc?, playerState?}",
        },
        entityId: { type: "string", description: "update/remove/reveal 时的实体 ID" },
        playerDesc: { type: "string", description: "reveal/update 时写入的玩家可见描述（玩家视图只读此项，不读 desc）" },
        playerState: { type: "string", description: "reveal/update 时写入的玩家可见状态（如：友善/敌意/已死亡/未知）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string" },
            game: { type: "string" },
            message: { type: "string" },
            entities: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        render: (_args, value) => [{ type: "text", text: `[实体] ${value.message}（共 ${value.entities?.length ?? 0} 个）` }],
      },
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        const entities = session.world.entities;
        let message = "";

        if (args.action === "add") {
          const item = args.entity ?? {};
          const id = typeof item.id === "string" && item.id.length > 0 ? item.id : nextId("ent", entities);
          if (entities.some((e) => e.id === id)) throw new Error(`实体 ${id} 已存在`);
          session.world.addEntity({
            id,
            type: String(item.type ?? "other"),
            name: String(item.name ?? "未命名实体"),
            desc: String(item.desc ?? ""),
            state: String(item.state ?? ""),
            scene: String(item.scene ?? ""),
            revealed: item.revealed === true,
            playerDesc: String(args.playerDesc ?? item.playerDesc ?? ""),
            playerState: String(args.playerState ?? item.playerState ?? ""),
          });
          message = `已添加实体「${item.name}」（${item.type ?? "other"}）`;
        } else if (args.action === "update") {
          const target = entities.find((e) => e.id === args.entityId);
          if (target === undefined) throw new Error(`实体 ${args.entityId} 不存在`);
          const item = args.entity ?? {};
          if (item.type !== undefined) target.type = String(item.type);
          if (item.name !== undefined) target.name = String(item.name);
          if (item.desc !== undefined) target.desc = String(item.desc);
          if (item.state !== undefined) target.state = String(item.state);
          if (item.scene !== undefined) target.scene = String(item.scene);
          if (item.revealed !== undefined) target.revealed = item.revealed === true;
          if (args.playerDesc !== undefined) target.playerDesc = String(args.playerDesc);
          else if (item.playerDesc !== undefined) target.playerDesc = String(item.playerDesc);
          if (args.playerState !== undefined) target.playerState = String(args.playerState);
          else if (item.playerState !== undefined) target.playerState = String(item.playerState);
          message = `已更新实体「${target.name}」`;
        } else if (args.action === "reveal") {
          const target = entities.find((e) => e.id === args.entityId);
          if (target === undefined) throw new Error(`实体 ${args.entityId} 不存在`);
          target.revealed = true;
          const playerDesc = args.playerDesc ?? args.entity?.playerDesc;
          const playerState = args.playerState ?? args.entity?.playerState;
          if (playerDesc !== undefined) target.playerDesc = String(playerDesc);
          if (playerState !== undefined) target.playerState = String(playerState);
          message = `已向玩家揭示实体「${target.name}」` + (playerDesc !== undefined ? "，并写入玩家可见描述" : "");
        } else if (args.action === "remove") {
          const before = entities.length;
          session.world.entities = entities.filter((e) => e.id !== args.entityId);
          if (session.world.entities.length === before) throw new Error(`实体 ${args.entityId} 不存在`);
          message = `已删除实体 ${args.entityId}`;
        } else {
          message = `共 ${entities.length} 个实体`;
        }

        commitSession(deps, gameId, session, flat);
        return { action: args.action, game: gameId, message, entities: session.world.entities };
      },
  });

  // ── coc_character ───────────────────────────────────────
  defs.push({
      name: "coc_character",
      description:
        "管理人物卡（KP/玩家通用）：list 列出全部人物，add 添加人物，update 修改，remove 删除。批量导入请用 coc_import（kind=characters）。",
      parameters: {
        action: { type: "string", enum: ["list", "add", "update", "remove"], required: true, description: "操作" },
        game: { type: "string", description: "游戏 ID" },
        characterId: { type: "string", description: "update/remove 时的人物 ID（也可用 name）" },
        name: { type: "string", description: "update/remove 时的人物名（characterId 缺省时按姓名匹配）" },
        character: {
          type: "object",
          additionalProperties: true,
          description: "add/update 时的人物数据",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string" },
            game: { type: "string" },
            message: { type: "string" },
            characters: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `[人物] ${value.message}（共 ${value.characters?.length ?? 0} 人）` },
        ],
      },
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        const characters = session.world.characters;
        let message = "";

        if (args.action === "list") {
          message = `共 ${characters.length} 个人物`;
        } else if (args.action === "add") {
          const pc = normalizeCharacter(args.character ?? { name: args.name }, characters.length);
          if (characters.some((c) => c.name === pc.name)) {
            throw new Error(`人物「${pc.name}」已存在（可用 update 修改）`);
          }
          session.world.addCharacter(pc);
          message = `已添加人物「${pc.name}」`;
        } else if (args.action === "update") {
          const index = characters.findIndex(
            (c) => c.id === args.characterId || (args.characterId === undefined && c.name === args.name)
          );
          if (index < 0) throw new Error(`人物 ${args.characterId ?? args.name} 不存在`);
          const merged = normalizeCharacter(
            { ...characters[index], ...(args.character ?? {}), id: characters[index].id, name: args.character?.name ?? characters[index].name },
            index
          );
          characters[index] = merged;
          message = `已更新人物「${merged.name}」`;
        } else if (args.action === "remove") {
          const index = characters.findIndex(
            (c) => c.id === args.characterId || (args.characterId === undefined && c.name === args.name)
          );
          if (index < 0) throw new Error(`人物 ${args.characterId ?? args.name} 不存在`);
          const removed = characters.splice(index, 1)[0];
          message = `已删除人物「${removed.name}」`;
        }

        commitSession(deps, gameId, session, flat);
        return { action: args.action, game: gameId, message, characters };
      },
  });

  return defs;
}



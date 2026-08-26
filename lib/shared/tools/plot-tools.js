/**
 * 剧情结构工具：coc_branch / coc_remind / coc_status
 *
 * keyPoints / branches / reminders 暂时保留在 flat 兼容字段，
 * 未来迁入 PlotGraph / Trigger Engine。
 */
import { renderStatusText } from "../../core/index.js";
import { loadSession, commitSession, gameIdOf } from "./helpers.js";

function findKeyPoint(flat, id) {
  return flat.keyPoints.find((k) => k.id === id) ?? null;
}

function findBranch(flat, id) {
  return flat.branches.find((b) => b.id === id) ?? null;
}

/**
 * @param {object} ctx
 * @param {object} deps
 */
export function createPlotToolDefs(deps) {
  const defs = [];
  // ── coc_branch ──────────────────────────────────────────
  defs.push({
      name: "coc_branch",
      description:
        "管理剧本的关键剧情点与剧情分支（KP 专用）：add 添加、update 修改、remove 删除、list 列出、reached 标记某分支已抵达并设为当前分支、choose 记录玩家在某分支的选择并推进场景、reveal 揭示某个关键剧情点。剧本导入时 coc_import 会草拟结构，可用本工具校对修正。",
      parameters: {
        action: {
          type: "string",
          enum: ["add", "update", "remove", "list", "reached", "choose", "reveal"],
          required: true,
          description: "操作",
        },
        type: { type: "string", enum: ["branch", "keypoint"], description: "add/update/remove 的对象类型" },
        game: { type: "string", description: "游戏 ID" },
        item: {
          type: "object",
          additionalProperties: true,
          description: "add/update 的内容。分支：{id?, title, scene?, desc?, options:[{label, leadsTo?}]}；关键点：{id?, title, scene?, desc?}",
        },
        branchId: { type: "string", description: "分支 ID（reached/choose/update/remove 用）" },
        keyPointId: { type: "string", description: "关键点 ID（reveal/update/remove 用）" },
        optionLabel: { type: "string", description: "choose 时玩家所选选项的 label" },
        nextScene: { type: "string", description: "choose 时推进到的下一个场景名" },
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
            currentBranchId: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[剧情结构] ${value.message}\n当前场景：${value.currentScene ?? ""}${value.currentBranchId ? ` · 当前分支：${value.currentBranchId}` : ""}\n关键剧情点 ${value.keyPoints?.length ?? 0} 个，分支 ${value.branches?.length ?? 0} 个`,
          },
        ],
      },
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        let message = "";

        if (args.action === "add") {
          if (args.type === "keypoint") {
            const item = args.item ?? {};
            const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `kp-${flat.keyPoints.length + 1}`;
            if (flat.keyPoints.some((k) => k.id === id)) throw new Error(`关键剧情点 ${id} 已存在`);
            flat.keyPoints.push({ id, scene: item.scene ?? flat.currentScene, title: String(item.title ?? "未命名关键点"), desc: String(item.desc ?? ""), revealed: false });
            message = `已添加关键剧情点「${item.title}」`;
          } else {
            const item = args.item ?? {};
            const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `br-${flat.branches.length + 1}`;
            if (flat.branches.some((b) => b.id === id)) throw new Error(`分支 ${id} 已存在`);
            const options = Array.isArray(item.options)
              ? item.options.map((o, i) => ({ id: `opt-${i + 1}`, label: String(o.label ?? `选项${i + 1}`), leadsTo: typeof o.leadsTo === "string" ? o.leadsTo : "" }))
              : [];
            flat.branches.push({ id, scene: item.scene ?? flat.currentScene, title: String(item.title ?? "未命名分支"), desc: String(item.desc ?? ""), options, reached: false, chosen: null });
            message = `已添加分支「${item.title}」（${options.length} 个选项）`;
          }
        } else if (args.action === "update") {
          if (args.type === "keypoint") {
            const target = findKeyPoint(flat, args.keyPointId);
            if (target === null) throw new Error(`关键剧情点 ${args.keyPointId} 不存在`);
            const item = args.item ?? {};
            if (item.title !== undefined) target.title = String(item.title);
            if (item.desc !== undefined) target.desc = String(item.desc);
            if (item.scene !== undefined) target.scene = String(item.scene);
            message = `已更新关键剧情点 ${target.id}`;
          } else {
            const target = findBranch(flat, args.branchId);
            if (target === null) throw new Error(`分支 ${args.branchId} 不存在`);
            const item = args.item ?? {};
            if (item.title !== undefined) target.title = String(item.title);
            if (item.desc !== undefined) target.desc = String(item.desc);
            if (item.scene !== undefined) target.scene = String(item.scene);
            if (Array.isArray(item.options)) target.options = item.options.map((o, i) => ({ id: `opt-${i + 1}`, label: String(o.label ?? `选项${i + 1}`), leadsTo: typeof o.leadsTo === "string" ? o.leadsTo : "" }));
            message = `已更新分支 ${target.id}`;
          }
        } else if (args.action === "remove") {
          if (args.type === "keypoint") {
            const before = flat.keyPoints.length;
            flat.keyPoints = flat.keyPoints.filter((k) => k.id !== args.keyPointId);
            if (flat.keyPoints.length === before) throw new Error(`关键剧情点 ${args.keyPointId} 不存在`);
            message = `已删除关键剧情点 ${args.keyPointId}`;
          } else {
            const before = flat.branches.length;
            flat.branches = flat.branches.filter((b) => b.id !== args.branchId);
            if (flat.branches.length === before) throw new Error(`分支 ${args.branchId} 不存在`);
            if (flat.currentBranchId === args.branchId) flat.currentBranchId = "";
            message = `已删除分支 ${args.branchId}`;
          }
        } else if (args.action === "list") {
          message = "当前剧情结构如下";
        } else if (args.action === "reached") {
          const branch = findBranch(flat, args.branchId);
          if (branch === null) throw new Error(`分支 ${args.branchId} 不存在`);
          branch.reached = true;
          flat.currentBranchId = branch.id;
          message = `已标记抵达分支「${branch.title}」并设为当前分支`;
        } else if (args.action === "choose") {
          const branch = findBranch(flat, args.branchId);
          if (branch === null) throw new Error(`分支 ${args.branchId} 不存在`);
          const option = branch.options.find((o) => o.label === args.optionLabel);
          if (option === undefined) throw new Error(`分支「${branch.title}」没有选项「${args.optionLabel}」（可用 coc_branch list 查看选项）`);
          branch.chosen = option.label;
          flat.currentBranchId = "";
          if (args.nextScene !== undefined && args.nextScene.length > 0) flat.currentScene = args.nextScene;
          else if (option.leadsTo !== undefined && option.leadsTo.length > 0) flat.currentScene = option.leadsTo;
          message = `玩家选择了「${option.label}」` + (flat.currentScene ? `，推进到场景「${flat.currentScene}」` : "");
        } else if (args.action === "reveal") {
          const target = findKeyPoint(flat, args.keyPointId);
          if (target === null) throw new Error(`关键剧情点 ${args.keyPointId} 不存在`);
          target.revealed = true;
          message = `已揭示关键剧情点「${target.title}」`;
        }

        // 同步 currentScene / currentBranchId 到 WorldState
        session.world.currentScene = flat.currentScene;
        commitSession(deps, gameId, session, flat);

        return {
          action: args.action,
          game: gameId,
          message,
          keyPoints: flat.keyPoints,
          branches: flat.branches,
          currentScene: flat.currentScene,
          currentBranchId: flat.currentBranchId,
        };
      },
  });

  // ── coc_remind ──────────────────────────────────────────
  defs.push({
      name: "coc_remind",
      description:
        "设置/查看/触发剧情提醒（KP 专用）：在某场景（scene）临近关键分支或重要剧情点时登记一条提醒，当当前场景匹配时动态提示；fire 标记已提醒。也可用 add 的 scene 留空表示任何时候都提醒。",
      parameters: {
        action: { type: "string", enum: ["add", "list", "fire", "remove"], required: true, description: "操作" },
        game: { type: "string", description: "游戏 ID" },
        scene: { type: "string", description: "add 时：提醒触发的场景名（留空表示任何时候）" },
        text: { type: "string", description: "add 时：提醒内容（向玩家提示什么）" },
        reminderId: { type: "string", description: "fire/remove 时的提醒 ID" },
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
            fired: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        render: (_args, value) => [{ type: "text", text: `[提醒] ${value.message}` }],
      },
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        let message = "";

        if (args.action === "add") {
          const text = String(args.text ?? "").trim();
          if (text.length === 0) throw new Error("提醒内容 text 不能为空");
          flat.reminders.push({
            id: `rem-${flat.reminders.length + 1}`,
            scene: String(args.scene ?? ""),
            text,
            fired: false,
          });
          message = `已登记提醒：场景「${args.scene ?? ""}」 → ${text}`;
        } else if (args.action === "list") {
          message = "当前提醒列表";
        } else if (args.action === "fire") {
          const reminder = flat.reminders.find((r) => r.id === args.reminderId);
          if (reminder === undefined) throw new Error(`提醒 ${args.reminderId} 不存在`);
          reminder.fired = true;
          message = `已触发提醒「${reminder.text}」`;
        } else if (args.action === "remove") {
          const before = flat.reminders.length;
          flat.reminders = flat.reminders.filter((r) => r.id !== args.reminderId);
          if (flat.reminders.length === before) throw new Error(`提醒 ${args.reminderId} 不存在`);
          message = `已删除提醒 ${args.reminderId}`;
        }

        commitSession(deps, gameId, session, flat);
        return {
          action: args.action,
          game: gameId,
          message,
          pending: flat.reminders.filter((r) => !r.fired),
          fired: flat.reminders.filter((r) => r.fired),
        };
      },
  });

  // ── coc_status ──────────────────────────────────────────
  defs.push({
      name: "coc_status",
      description:
        "查看跑团全局状态（KP 面板）：当前场景、当前分支与选项、关键剧情点（已揭示/未揭示）、分支列表、人物卡、待触发提醒、最近骰点。KP 在推进剧情、场景切换后调用，以掌握关键剧情点与当前剧情分支；重要分支点临近时主动提醒玩家。",
      parameters: {
        game: { type: "string", description: "游戏 ID" },
        view: {
          type: "string",
          enum: ["overview", "plot", "characters", "rolls", "reminders", "all"],
          description: "视图：overview 总览（默认）/ plot 剧情结构 / characters 人物 / rolls 骰点 / reminders 提醒 / all 全部",
        },
        includeSecretRolls: { type: "boolean", description: "骰点视图是否包含暗骰记录（默认 false，暗骰仅 KP 可看）" },
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
            recentRolls: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        render: (_args, value) => [{ type: "text", text: renderStatusText(value) }],
      },
      presentCall: () => ({ card: "generic", title: "KP 状态面板", kind: "查看", rawInput: "" }),
      execute(args) {
        const gameId = gameIdOf(args, deps.defaultGame);
        const { session, flat } = loadSession(deps, gameId);
        const view = args.view ?? "overview";

        const output = {
          game: gameId,
          title: flat.title,
          kpMode: session.world.kpMode,
          currentScene: session.world.currentScene,
        };
        if (flat.currentBranchId) {
          const branch = findBranch(flat, flat.currentBranchId);
          if (branch !== null) output.currentBranch = branch;
        }
        if (flat.rules !== null) output.rules = flat.rules.name;
        if (flat.scenario !== null) output.scenario = flat.scenario.name;
        if (view === "plot" || view === "all") {
          output.keyPoints = flat.keyPoints;
          output.branches = flat.branches;
        }
        if (view === "characters" || view === "all") output.characters = session.world.characters;
        if (view === "reminders" || view === "all") output.reminders = flat.reminders;
        if (view === "rolls" || view === "all" || view === "overview") {
          output.recentRolls = session.world.rollHistory
            .filter((roll) => args.includeSecretRolls === true || roll.kind !== "secret")
            .slice(-8)
            .reverse();
        }
        if (view === "overview") {
          output.keyPoints = flat.keyPoints;
          output.branches = flat.branches;
        }

        return output;
      },
  });

  return defs;
}



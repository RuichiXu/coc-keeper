/**
 * 集成测试：Adapter 新工具注册与执行（真实 Cordis Context + 轻量 mock）
 *
 * 验证：
 * - Cordis Context 的动态注入服务不会被 Adapter 包装丢失
 * - 17 个工具全部注册到模型上下文
 * - coc_roll 走 Core Rule Engine 并写入 core 持久化
 * - coc_sanity_check 走 Core Rule Engine 并更新 WorldState
 */
import { describe, it, expect, mockRandom } from "../runner.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context, Service } from "@deepseek-ai/cordis";
import { apply } from "../../lib/index.js";

function createMockCtx() {
  const registered = new Map();
  const sections = [];
  const contexts = [];
  return {
    registered,
    sections,
    contexts,
    ctx: {
      tools: {
        register(def) {
          if (registered.has(def.name)) throw new Error(`重复注册工具 ${def.name}`);
          registered.set(def.name, def);
        },
      },
      systemPrompt: {
        section(s) { sections.push(s); },
        context(c) { contexts.push(c); },
      },
      inject() { return void 0; },
    },
  };
}

describe("Adapter 工具集成", () => {
  it("在真实 Cordis Context 中保留注入服务并注册 Skills", () => {
    class TestTools extends Service {
      constructor(ctx) {
        super(ctx, "tools");
        this.registered = new Map();
      }

      register(def) {
        this.registered.set(def.name, def);
      }
    }

    class TestSystemPrompt extends Service {
      constructor(ctx) {
        super(ctx, "systemPrompt");
        this.sections = [];
        this.contexts = [];
      }

      section(value) {
        this.sections.push(value);
        return () => {};
      }

      context(value) {
        this.contexts.push(value);
        return () => {};
      }
    }

    class TestSkills extends Service {
      constructor(ctx) {
        super(ctx, "skills");
        this.registered = [];
      }

      register(skill) {
        this.registered.push(skill);
      }
    }

    const ctx = new Context();
    const tools = new TestTools(ctx);
    const systemPrompt = new TestSystemPrompt(ctx);
    const skills = new TestSkills(ctx);
    const dir = mkdtempSync(join(tmpdir(), "coc-cordis-context-"));

    apply(ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });

    expect(tools.registered.size).toBe(17);
    expect(systemPrompt.sections).toHaveLength(1);
    expect(systemPrompt.contexts).toHaveLength(1);
    expect(typeof ctx.get).toBe("function");
    expect(skills.registered).toHaveLength(4);
    expect(skills.registered.map((s) => s.name)).toContain("coc-rule-dice");
    expect(skills.registered.map((s) => s.name)).toContain("coc-rule-combat");
    expect(skills.registered.map((s) => s.name)).toContain("coc-rule-sanity");
    expect(skills.registered.map((s) => s.name)).toContain("coc-rule-growth");
  });

  it("注册全部 17 个工具", () => {
    const mock = createMockCtx();
    const dir = mkdtempSync(join(tmpdir(), "coc-adapter-"));
    apply(mock.ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });

    const expected = [
      "coc_import", "coc_read", "coc_roll", "coc_roll_secret", "coc_query_rule",
      "coc_sanity_check", "coc_combat_resolve", "coc_skill_growth", "coc_status",
      "coc_branch", "coc_remind", "coc_character", "coc_kp", "coc_scene",
      "coc_task", "coc_entity", "coc_pc",
    ];
    for (const name of expected) {
      expect(mock.registered.has(name)).toBeTrue();
    }
    expect(mock.registered.size).toBe(17);
  });

  it("coc_roll 走 Core：写入 core 持久化与 flat 投影", async () => {
    const mock = createMockCtx();
    const dir = mkdtempSync(join(tmpdir(), "coc-adapter-"));
    apply(mock.ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });

    const restore = mockRandom([0.5]); // d100 = 51
    const result = await mock.registered.get("coc_roll").execute(
      { expression: "d100", target: 60, difficulty: "regular", player: "张三", label: "侦查", game: "g1" },
      {}
    );
    restore();

    expect(result.rolled).toBe(51);
    expect(result.tier).toBe("regular");
    expect(result.passed).toBeTrue();

    const flat = JSON.parse(readFileSync(join(dir, "games", "g1.json"), "utf8"));
    expect(flat.rollHistory).toHaveLength(1);
    expect(flat.core.world.rollHistory).toHaveLength(1);
    expect(flat.core.world.rollHistory[0].tier).toBe("regular");
  });

  it("coc_sanity_check 走 Core：SAN 写入 WorldState 与 flat 投影", async () => {
    const mock = createMockCtx();
    const dir = mkdtempSync(join(tmpdir(), "coc-adapter-"));
    apply(mock.ctx, { dataDir: dir, defaultGame: "g1", maxRollHistory: 200 });

    // 先添加人物
    await mock.registered.get("coc_character").execute(
      {
        action: "add",
        game: "g1",
        character: { name: "张三", stats: { SAN: 60, INT: 70 }, san: 60, hp: 11, inventory: [] },
      },
      {}
    );

    // SAN 检定失败：d100=90，损失 1d3=2
    const restore = mockRandom([0.9, 0.5]); // d100=90；1d3=2
    const result = await mock.registered.get("coc_sanity_check").execute(
      { player: "张三", sanLoss: "0/1d3", description: "目睹深潜者", game: "g1" },
      {}
    );
    restore();

    expect(result.passed).toBeFalse();
    expect(result.sanLost).toBe(2);

    const flat = JSON.parse(readFileSync(join(dir, "games", "g1.json"), "utf8"));
    expect(flat.characters[0].san).toBe(58);
    expect(flat.core.world.characters[0].san).toBe(58);
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "adapter-tools 集成测试"));

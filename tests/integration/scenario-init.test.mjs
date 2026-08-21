/**
 * 集成测试：Scenario Compiler → GameSession（PlotGraph + ClueGraph）初始化
 */
import { describe, it, expect } from "../runner.js";
import { GameSession } from "../../lib/core/session/game-session.js";
import { compileByPattern } from "../../lib/core/scenario/compiler.js";

describe("Scenario → GameSession 初始化", () => {
  it("compileByPattern → importScenarioModel → PlotGraph 节点激活", () => {
    const text = `
【场景】废弃宅邸
调查员进入宅邸。
【关键剧情点】书房发现暗格
在书房发现暗格。
【关键剧情点】地下室对决
前置条件：发现暗格。
【分支】是否撬开暗格
`;
    const model = compileByPattern(text, "废弃宅邸");
    expect(model.plotNodes.length).toBeGreaterThanOrEqual(1);

    const session = new GameSession({ id: "test" });
    session.importScenarioModel(model, { replace: true, activateInitial: true });

    // plotNodes 全部导入
    expect(session.plot.nodes.length).toBe(model.plotNodes.length);
    // 无前置条件节点被自动激活
    const initialActive = session.plot.getFrontier();
    expect(initialActive.length).toBeGreaterThan(0);
  });

  it("importScenarioModel 导入线索到 ClueGraph（含替代路径）", () => {
    const model = compileByPattern("【场景】书房\n【关键剧情点】发现暗格", "书房");
    model.clues.push({
      id: "clue-1",
      description: "暗格中的古书",
      acquisitionMethods: ["侦查"],
      fallbackMethods: ["图书馆使用"],
      isCritical: true,
      category: "physical",
    });

    const session = new GameSession({ id: "test" });
    session.importScenarioModel(model);

    expect(session.clues.clues).toHaveLength(1);
    expect(session.clues.findClue("clue-1").isCritical).toBeTrue();
    expect(session.clues.getFallbackMethods("clue-1")).toContain("图书馆使用");
  });

  it("replace=false 时不清空旧图", () => {
    const session = new GameSession({ id: "test" });
    const model1 = compileByPattern("【关键剧情点】节点A", "剧本A");
    session.importScenarioModel(model1);

    const model2 = compileByPattern("【关键剧情点】节点B", "剧本B");
    model2.plotNodes[0].id = "pn-b";
    session.importScenarioModel(model2, { replace: false });

    expect(session.plot.nodes.length).toBe(2);
  });
});

// 直接运行
import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "scenario-init 集成测试"));

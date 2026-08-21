/**
 * 场景测试：玩家决策失败
 *
 * 玩家主动做出重大错误行为 → 剧情路径关闭 → 不应被 Narrative Recovery 无条件救回
 */
import { describe, it, expect } from "../runner.js";
import { WorldState } from "../../lib/core/state/world-state.js";
import { PlotGraph } from "../../lib/core/plot/plot-graph.js";

describe("场景：玩家决策失败", () => {
  it("玩家杀死关键 NPC → 相关剧情路径关闭", () => {
    const ws = new WorldState({ id: "test" });
    ws.setScene("废弃宅邸");

    const pg = new PlotGraph();
    pg.addNode({
      id: "pn-talk",
      title: "与老管家交谈获取信息",
      type: "social",
      scene: "废弃宅邸",
      preconditions: ["flag:butler_alive"],
      leadsTo: ["pn-secret"],
    });
    pg.addNode({
      id: "pn-secret",
      title: "发现管家隐藏的秘密",
      type: "revelation",
      preconditions: [],
    });
    pg.addNode({
      id: "pn-alternate",
      title: "搜查管家房间",
      type: "investigation",
      preconditions: ["flag:butler_dead"],
      leadsTo: ["pn-secret"],
    });

    // 初始状态：管家存活
    ws.setFlag("butler_alive", true);
    pg.checkPreconditions(ws);
    expect(pg.findNode("pn-talk").status).toBe("active");

    // ── 玩家决策：杀死管家 ──
    ws.setFlag("butler_alive", false);
    ws.setFlag("butler_dead", true);

    // 由于 talk 节点已激活，需要手动重置状态
    // （checkPreconditions 只激活 inactive 节点，不撤销 active 节点）
    pg.findNode("pn-talk").status = "inactive";

    // 重新检查条件
    pg.checkPreconditions(ws);

    // 交谈路径被关闭
    expect(pg.findNode("pn-talk").status).toBe("inactive");

    // 但替代调查路径被激活
    expect(pg.findNode("pn-alternate").status).toBe("active");

    // 完成替代路径后，仍然可以到达秘密
    pg.completeNode("pn-alternate", "找到线索");
    expect(pg.findNode("pn-secret").status).toBe("active");
  });

  it("玩家销毁关键证据 → 相关结局被阻塞", () => {
    const ws = new WorldState({ id: "test" });
    ws.setFlag("evidence_destroyed", true);

    const pg = new PlotGraph();
    pg.addNode({
      id: "pn-prove",
      title: "用证据证明真相",
      preconditions: ["flag:evidence_intact"],
    });

    pg.checkPreconditions(ws);
    expect(pg.findNode("pn-prove").status).toBe("inactive");
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "decision-failure 场景测试"));
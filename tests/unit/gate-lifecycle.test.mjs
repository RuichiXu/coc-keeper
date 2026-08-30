/**
 * 门禁生命周期（gate-lifecycle）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import { abandonAllGates, expireSceneGates } from "../../lib/shared/chat/index.js";

describe("expireSceneGates 场景失效", () => {
  it("当前场景与门禁场景相同或为其子场景时保留", () => {
    const flat = {
      pendingChecks: [
        { id: "chk-a", skill: "侦查", action: "检查书桌", scene: "三层书房" },
        { id: "chk-b", skill: "侦查", action: "检查仪式圈", scene: "三层书房·仪式终结" },
        { id: "chk-c", skill: "侦查", action: "检查门厅", scene: "一层" },
      ],
      skippedChecks: [],
    };
    const removed = expireSceneGates(flat, "三层书房");
    expect(removed).toBe(2);
    expect(flat.pendingChecks.map((gate) => gate.id)).toEqual(["chk-a"]);
    expect(flat.skippedChecks[0].id).toBe("chk-b");
    expect(flat.skippedChecks[0].reason).toBe("scene-invalid");
    expect(flat.skippedChecks[1].id).toBe("chk-c");
  });

  it("「三层书房门外」在进入「三层书房」后失效（前缀规则，修复旧包含误保留）", () => {
    const flat = {
      pendingChecks: [
        { id: "chk-door", skill: "力量", action: "继续撞门", scene: "三层书房门外" },
        { id: "chk-desk", skill: "侦查", action: "检查书桌", scene: "三层书房" },
      ],
      skippedChecks: [],
    };
    const removed = expireSceneGates(flat, "三层书房");
    expect(removed).toBe(1);
    expect(flat.pendingChecks[0].id).toBe("chk-desk");
    expect(flat.skippedChecks[0].id).toBe("chk-door");
  });

  it("scene 为空或导入的门禁永不因场景失效", () => {
    const flat = {
      pendingChecks: [
        { id: "chk-a", skill: "侦查", action: "检查门厅", scene: "" },
        { id: "chk-b", skill: "侦查", action: "检查门厅", scene: "导入" },
      ],
      skippedChecks: [],
    };
    const removed = expireSceneGates(flat, "三层书房");
    expect(removed).toBe(0);
    expect(flat.pendingChecks).toHaveLength(2);
  });
});

describe("abandonAllGates 全量废弃", () => {
  it("全部待处理门禁移入 skipped 并记录原因", () => {
    const flat = {
      pendingChecks: [
        { id: "chk-a", skill: "侦查", action: "检查书桌", scene: "三层书房" },
        { id: "chk-b", skill: "意志", action: "吟诵咒文", scene: "三层书房" },
      ],
      skippedChecks: [],
    };
    const removed = abandonAllGates(flat, "ending-resolved", "2026-08-28T10:00:00.000Z");
    expect(removed).toBe(2);
    expect(flat.pendingChecks).toHaveLength(0);
    expect(flat.skippedChecks).toHaveLength(2);
    expect(flat.skippedChecks[0].reason).toBe("ending-resolved");
    expect(flat.skippedChecks[0].skippedAt).toBe("2026-08-28T10:00:00.000Z");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "gate-lifecycle 单元测试"));

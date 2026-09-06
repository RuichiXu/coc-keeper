/**
 * coc_branch 工具辅助函数（分支解析/最终分支场景门禁）单元测试
 */
import { describe, it, expect } from "../runner.js";
import { resolveBranch, branchSceneMatches, branchSceneVisited, branchSceneKeywords, isFinalBranch } from "../../lib/shared/tools/plot-tools.js";

const branches = [
  { id: "br-1", title: "普通分支", scene: "一层门厅", reached: false, chosen: null, options: [] },
  { id: "br-final-1", title: "最终抉择：应对沸核与寒星", scene: "房间3：设施总控室", finalChoice: true, reached: false, chosen: null, options: [] },
];

describe("resolveBranch 分支解析", () => {
  it("按 id 精确匹配", () => {
    const resolved = resolveBranch({ branches }, "br-final-1");
    expect(resolved.error).toBeNull();
    expect(resolved.branch.id).toBe("br-final-1");
  });

  it("模型把标题当 id 时按标题精确匹配", () => {
    const resolved = resolveBranch({ branches }, "最终抉择：应对沸核与寒星");
    expect(resolved.error).toBeNull();
    expect(resolved.branch.id).toBe("br-final-1");
  });

  it("多候选时返回错误并列出候选", () => {
    const ambiguous = {
      branches: [
        { id: "br-1", title: "最终抉择", options: [] },
        { id: "br-2", title: "最终抉择", options: [] },
      ],
    };
    const resolved = resolveBranch(ambiguous, "最终抉择");
    expect(resolved.branch).toBeNull();
    expect(resolved.error).toBe("分支标题「最终抉择」匹配到多个分支：br-1「最终抉择」、br-2「最终抉择」，请改用 id");
  });

  it("未找到时返回不存在错误", () => {
    const resolved = resolveBranch({ branches }, "br-missing");
    expect(resolved.branch).toBeNull();
    expect(resolved.error.includes("不存在")).toBeTrue();
  });
});

describe("最终分支场景门禁", () => {
  it("finalChoice 分支判定", () => {
    expect(isFinalBranch({ id: "br-final-1" })).toBeTrue();
    expect(isFinalBranch({ finalChoice: true })).toBeTrue();
    expect(isFinalBranch({ id: "br-1" })).toBeFalse();
  });

  it("场景一致才允许 reached/choose", () => {
    const branch = branches[1];
    expect(branchSceneMatches(branch, "房间3：设施总控室")).toBeTrue();
    expect(branchSceneMatches(branch, "极光镇")).toBeFalse();
    expect(branchSceneMatches({ ...branch, scene: "" }, "任意场景")).toBeTrue();
  });

  it("场景历史中已切入过最终场景时，后续场景也允许补登记", () => {
    const branch = branches[1];
    const flat = {
      currentScene: "尾声",
      events: [
        { type: "SceneChanged", from: "极光镇", to: "房间3：设施总控室" },
        { type: "SceneChanged", from: "房间3：设施总控室", to: "外部控制室" },
        { type: "SceneChanged", from: "外部控制室", to: "尾声" },
      ],
    };
    expect(branchSceneVisited(flat, branch)).toBeTrue();
    expect(branchSceneVisited({ currentScene: "极光镇", events: [] }, branch)).toBeFalse();
  });

  it("旧存档无 SceneChanged 历史但对话日志提到最终场景时，允许补登记", () => {
    const branch = branches[1];
    const flat = {
      currentScene: "沸核过早释放",
      events: [],
      log: [
        { kind: "kp", text: "你进入房间3：设施总控室，屏幕亮着。" },
        { kind: "kp", text: "总控室里倒计时仍在跳动。" },
      ],
    };
    expect(branchSceneVisited(flat, branch)).toBeTrue();
    expect(branchSceneKeywords("房间3：设施总控室")).toContain("总控室");
  });
});

import { run, summarize } from "../runner.js";
const result = await run({ verbose: true });
process.exit(summarize(result, "plot-tools 单元测试"));

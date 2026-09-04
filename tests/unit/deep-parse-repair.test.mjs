/**
 * 最终接线修复与连通性修复 fixture 测试（对流真实导入产物）。
 *
 * fixture 来源：一次真实的《淡焱无生-对流》导入产物，保留了当时 LLM
 * 最终接线的典型问题（br-failure-final/br-success-final 无 options、
 * endings.branchId 为空、br→end 边无 label、结局场景点孤立）。
 * 后续拿到质量更优的 LLM 产物时，可替换 fixture 并保持断言方向不变。
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  repairDeepParseConnectivity,
  repairDeepParseFinalWiring,
  runDeepParseRuleReview,
} from "../../lib/core/index.js";
import { shouldRetryLlmError } from "../../lib/shared/tools/deep-parse-loop.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "convection-import.json");

function loadFixture() {
  return JSON.parse(readFileSync(fixturePath, "utf8")).flat;
}

describe("Deep Parse 修复（对流 fixture）", () => {
  it("修复前 R0 能捕获最终接线硬伤，修复后 R0 高危归零", () => {
    const before = loadFixture();
    const beforeReview = runDeepParseRuleReview(before.deepParse, before, { severityGate: { high: 0, medium: 2 } });
    const r0HighBefore = beforeReview.issues.filter(
      (issue) => issue.severity === "high" && /branchId|options|plotEdges\[\d+\]/.test(issue.where ?? "")
    );
    expect(r0HighBefore.length).toBeGreaterThan(0);

    repairDeepParseFinalWiring(before, before.deepParse);
    repairDeepParseConnectivity(before, before.deepParse);
    const afterReview = runDeepParseRuleReview(before.deepParse, before, { severityGate: { high: 0, medium: 2 } });
    const r0HighAfter = afterReview.issues.filter(
      (issue) => issue.severity === "high" && /branchId|options|plotEdges\[\d+\]/.test(issue.where ?? "")
    );
    expect(r0HighAfter.length).toBe(0);
  });

  it("最终接线修复：失败/成功最终分支有选项、endings.branchId 非空、br→end 边有 label", () => {
    const flat = loadFixture();
    const repaired = repairDeepParseFinalWiring(flat, flat.deepParse);
    expect(repaired).toBeGreaterThan(0);

    const failure = flat.branches.find((candidate) => candidate.id === "br-failure-final");
    expect(failure !== undefined && failure.autoChoose === true).toBeTrue();
    expect(failure.options.length === 0).toBeTrue();
    expect(failure.finalChoice !== true).toBeTrue();

    const success = flat.branches.find((candidate) => candidate.id === "br-success-final");
    expect(success !== undefined && success.options.length > 0).toBeTrue();
    expect(success.finalChoice === true).toBeTrue();
    const dpSuccess = flat.deepParse.branches.find((candidate) => candidate.id === "br-success-final");
    expect(dpSuccess !== undefined && dpSuccess.options.length > 0).toBeTrue();
    const dpFailure = flat.deepParse.branches.find((candidate) => candidate.id === "br-failure-final");
    expect(dpFailure !== undefined && dpFailure.autoChoose === true).toBeTrue();
    for (const ending of flat.deepParse.endings) {
      expect(String(ending.branchId ?? "").length > 0).toBeTrue();
    }
    for (const edge of flat.deepParse.plotEdges) {
      if (String(edge.from ?? "").startsWith("br:") && String(edge.to ?? "").startsWith("end:")) {
        expect(String(edge.label ?? "").length > 0).toBeTrue();
      }
    }
  });

  it("连通性修复：结局场景点不再孤立", () => {
    const flat = loadFixture();
    repairDeepParseFinalWiring(flat, flat.deepParse);
    repairDeepParseConnectivity(flat, flat.deepParse);
    const edges = flat.deepParse.plotEdges;
    const hasIn = new Set(edges.map((edge) => String(edge.to ?? "")));
    const hasOut = new Set(edges.map((edge) => String(edge.from ?? "")));
    const isolated = flat.keyPoints.filter((kp) => !hasIn.has(`kp:${kp.id}`) && !hasOut.has(`kp:${kp.id}`));
    expect(isolated.length).toBe(0);
  });

  it("连通性修复：主线缺出边补下一条主线，支线缺入边从前一主线补 hook", () => {
    const flat = {
      keyPoints: [
        { id: "kp-1", title: "场景A", scene: "场景A", kind: "scene", flowRole: "main", order: 1 },
        { id: "kp-2", title: "场景B", scene: "场景B", kind: "scene", flowRole: "main", order: 2 },
        { id: "kp-3", title: "支线C", scene: "支线C", kind: "scene", flowRole: "side", order: 3 },
      ],
      branches: [],
      deepParse: { plotEdges: [], endings: [], keyPoints: [], branches: [] },
    };
    repairDeepParseConnectivity(flat, flat.deepParse);
    const keys = new Set(flat.deepParse.plotEdges.map((edge) => `${edge.from}->${edge.to}`));
    expect(keys.has("kp:kp-1->kp:kp-2")).toBeTrue();
    expect(keys.has("kp:kp-2->kp:kp-3")).toBeTrue();
  });

  it("超时错误不再重试（避免超时翻倍）", () => {
    expect(shouldRetryLlmError(new Error("LLM 调用超时（90s）"), 1)).toBe(false);
    expect(shouldRetryLlmError(new Error("fetch failed"), 1)).toBe(true);
    expect(shouldRetryLlmError(new Error("fetch failed"), 2)).toBe(false);
  });
});

run().then(summarize);

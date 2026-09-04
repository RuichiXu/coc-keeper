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

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "convection-import.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const flat = fixture.flat;

describe("Deep Parse 修复（对流 fixture）", () => {
  it("最终接线修复：失败/成功最终分支有选项、endings.branchId 非空、br→end 边有 label", () => {
    const repaired = repairDeepParseFinalWiring(flat, flat.deepParse);
    expect(repaired).toBeGreaterThan(0);

    for (const id of ["br-failure-final", "br-success-final"]) {
      const branch = flat.branches.find((candidate) => candidate.id === id);
      expect(branch !== undefined && branch.options.length > 0).toBeTrue();
      expect(branch.finalChoice === true).toBeTrue();
      const dpBranch = flat.deepParse.branches.find((candidate) => candidate.id === id);
      expect(dpBranch !== undefined && dpBranch.options.length > 0).toBeTrue();
    }
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
    repairDeepParseConnectivity(flat, flat.deepParse);
    const edges = flat.deepParse.plotEdges;
    const hasIn = new Set(edges.map((edge) => String(edge.to ?? "")));
    const hasOut = new Set(edges.map((edge) => String(edge.from ?? "")));
    const isolated = flat.keyPoints.filter((kp) => !hasIn.has(`kp:${kp.id}`) && !hasOut.has(`kp:${kp.id}`));
    expect(isolated.length).toBe(0);
  });

  it("规则审校硬门禁：修复后 R0 级别的高危不再出现", () => {
    const review = runDeepParseRuleReview(flat.deepParse, flat, { severityGate: { high: 0, medium: 2 } });
    const r0High = review.issues.filter(
      (issue) => issue.severity === "high" && /branchId|options|plotEdges\[\d+\]/.test(issue.where ?? "")
    );
    expect(r0High.length).toBe(0);
  });
});

run().then(summarize);

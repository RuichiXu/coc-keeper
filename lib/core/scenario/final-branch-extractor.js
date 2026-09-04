/**
 * 玩家选择型最终分支提取器（确定性启发式，仅 bullet 型完整选项）
 *
 * 从结构分析给出的“最终抉择/结局”section 内提取 bullet 列表型选项
 * （如“- 毁灭：调查员可以轻易地给予最后一击，彻底消灭埃华斯。”）。
 *
 * 找不到 bullet 型完整选项时返回空，交给最终接线 prompt 由 LLM 建立
 * 最终分支与结局。宁可没有确定性骨架，也不用“若调查员…”截断半句。
 */

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

const FINAL_SECTION_RE =
  /最终抉择|最后的?选择|面临抉择|结局|终局|尾声|ENDING|TRUE\s*END|BAD\s*END|GOOD\s*END/i;

// bullet 列表型完整选项：项目符号 + 标题：内容（两项都必须有实质文本）。
const BULLET_OPTION_RE = /^[\t ]*[•·▪◦●○*\-–—]\s*([^：:\n]{1,80})[：:]\s*(.+)$/gm;

/**
 * @param {object} flat
 * @returns {{ keyPoints: Array<object>, branches: Array<object> }}
 */
export function extractFinalChoiceBranches(flat) {
  const facts = Array.isArray(flat?.scenarioFacts) ? flat.scenarioFacts : [];
  const structureSections = flat?.scenarioStructure?.sections ?? [];

  // 提取范围：结构分析给出的“最终抉择/结局”section。
  const finalSectionIds = new Set(
    structureSections
      .filter((section) => {
        const kind = nonEmptyString(section?.kind);
        if (kind !== "scene" && kind !== "scene_event") return false;
        const haystack = `${section?.title ?? ""} ${section?.displayName ?? ""} ${section?.desc ?? ""} ${section?.note ?? ""}`;
        return FINAL_SECTION_RE.test(haystack);
      })
      .map((section) => nonEmptyString(section?.id))
      .filter((id) => id.length > 0)
  );

  if (finalSectionIds.size === 0) return { keyPoints: [], branches: [] };

  const finalFacts = facts.filter((fact) => finalSectionIds.has(nonEmptyString(fact?.sectionId)));

  const options = [];
  const keyPoints = [];
  const seenLabels = new Set();
  let finalScene = "";

  for (const fact of finalFacts) {
    const scene = nonEmptyString(fact?.heading);
    if (finalScene.length === 0 && scene.length > 0) finalScene = scene;
    const original = String(fact?.original ?? "");

    for (const match of original.matchAll(BULLET_OPTION_RE)) {
      const label = `${nonEmptyString(match[1])}：${nonEmptyString(match[2])}`.trim();
      if (label.length < 4 || label.length > 200) continue;
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);
      options.push({ label, leadsTo: label });
      keyPoints.push({
        id: `kp-final-${keyPoints.length + 1}`,
        title: label,
        scene: finalScene.length > 0 ? finalScene : "结局",
        desc: `最终抉择选项：${label}`,
      });
    }
    if (options.length > 0) break;
  }

  if (options.length === 0) return { keyPoints: [], branches: [] };

  const branches = [{
    id: "br-final-1",
    title: "最终抉择",
    scene: finalScene.length > 0 ? finalScene : "结局",
    desc: "玩家选择型最终分支（确定性 bullet 提取）",
    finalChoice: true,
    options,
  }];

  return { keyPoints, branches };
}

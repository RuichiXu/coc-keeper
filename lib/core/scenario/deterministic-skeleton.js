/**
 * 确定性节点骨架：从场景事实（headings）与检定点生成 keyPoints/branches，
 * 供骨架锁定生成器使用。规则全部确定，不含 LLM。
 */

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

function truncate(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 从 flat.scenarioFacts / flat.scenarioCheckpoints 生成确定性骨架。
 * @param {object} flat
 * @returns {{ keyPoints: Array<object>, branches: Array<object> }}
 */
export function buildDeterministicSkeleton(flat) {
  const keyPoints = [];
  const branches = [];
  const seenHeadings = new Set();

  // 场景事实 → 关键点（每个 heading 一个）
  for (const fact of Array.isArray(flat?.scenarioFacts) ? flat.scenarioFacts : []) {
    const heading = nonEmptyString(fact?.heading);
    if (heading.length === 0 || seenHeadings.has(heading)) continue;
    seenHeadings.add(heading);
    const firstFact = Array.isArray(fact?.facts) && fact.facts.length > 0 ? nonEmptyString(fact.facts[0]) : "";
    keyPoints.push({
      id: `kp-${keyPoints.length + 1}`,
      title: heading,
      scene: heading,
      desc: truncate(firstFact || fact?.original || heading, 120),
    });
  }

  // 检定点 → 分支（每个检定点一个选项：对应技能检定）
  for (const checkpoint of Array.isArray(flat?.scenarioCheckpoints) ? flat.scenarioCheckpoints : []) {
    const scene = nonEmptyString(checkpoint?.scene);
    const skill = nonEmptyString(checkpoint?.skill);
    const trigger = nonEmptyString(checkpoint?.trigger);
    if (scene.length === 0 && skill.length === 0) continue;
    const branchId = `br-${branches.length + 1}`;
    branches.push({
      id: branchId,
      title: `${scene}·${skill}检定`.slice(0, 80),
      scene: scene.length > 0 ? scene : nonEmptyString(checkpoint?.floor),
      options: [{ label: `${skill}检定`, leadsTo: scene }],
      desc: truncate(trigger, 120),
      checkpointBranch: true,
    });
  }

  // 没有场景事实时，把检定点场景当作关键点。
  if (keyPoints.length === 0) {
    for (const checkpoint of Array.isArray(flat?.scenarioCheckpoints) ? flat.scenarioCheckpoints : []) {
      const scene = nonEmptyString(checkpoint?.scene);
      if (scene.length === 0 || seenHeadings.has(scene)) continue;
      seenHeadings.add(scene);
      keyPoints.push({
        id: `kp-${keyPoints.length + 1}`,
        title: scene,
        scene,
        desc: truncate(checkpoint?.trigger || scene, 120),
      });
    }
  }

  return { keyPoints, branches };
}

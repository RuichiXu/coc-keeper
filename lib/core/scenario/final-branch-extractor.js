/**
 * 玩家选择型最终分支提取器（确定性启发式）
 *
 * 从剧本原文/场景事实里识别“最终抉择”类分支：
 *  - 以“若/如果”引导的玩家可选动作；
 *  - 出现在结局/终局/尾声/最终抉择相关章节；
 *  - 每个选项同时生成一个关键点作为 leadsTo 落点。
 *
 * 这是补丁式提取器，后续应由更强的场景结构解析替代；登记在 PATCHES.md。
 */

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

const FINAL_SCENE_RE = /结局|最终|终局|尾声|抉择|ENDING|TRUE\s*END|BAD\s*END|GOOD\s*END|BE|GE|TE/i;
const CHOICE_CLAUSE_RE = /(?:若|如果|假如|倘若)(?:调查员们?|玩家们?|他们|KP)?[^，。；！？\n]{2,40}/g;
const NOISE_WORD_RE = /^(?:若|如果|假如|倘若)(?:调查员们?|玩家们?|他们|KP)?/;

/**
 * @param {object} flat
 * @returns {{ keyPoints: Array<object>, branches: Array<object> }}
 */
export function extractFinalChoiceBranches(flat) {
  const text = String(flat?.scenario?.text ?? "");
  const facts = Array.isArray(flat?.scenarioFacts) ? flat.scenarioFacts : [];
  const finalFacts = facts.filter((fact) => {
    const haystack = `${fact?.heading ?? ""}\n${(fact?.keywords ?? []).join(" ")}\n${fact?.original ?? ""}`;
    return FINAL_SCENE_RE.test(haystack);
  });

  const seenLabels = new Set();
  const options = [];
  const keyPoints = [];
  let finalScene = "";

  const addClause = (clause, scene) => {
    const label = clause.replace(NOISE_WORD_RE, "").trim();
    if (label.length < 2 || label.length > 40 || seenLabels.has(label)) return;
    seenLabels.add(label);
    options.push({ label, leadsTo: label });
    keyPoints.push({ id: `kp-final-${keyPoints.length + 1}`, title: label, scene, desc: `最终抉择选项：${label}` });
  };

  for (const fact of finalFacts) {
    const scene = nonEmptyString(fact?.heading);
    if (finalScene.length === 0 && scene.length > 0) finalScene = scene;
    const original = String(fact?.original ?? "");
    for (const match of original.matchAll(CHOICE_CLAUSE_RE)) {
      addClause(nonEmptyString(match[0]), scene);
    }
  }

  // 兜底：全文扫描“最终抉择”附近段落。
  if (options.length === 0) {
    const marker = /最终抉择|最后的?选择|面临抉择/;
    const markerIndex = text.search(marker);
    if (markerIndex >= 0) {
      const window = text.slice(markerIndex, markerIndex + 1200);
      for (const match of window.matchAll(CHOICE_CLAUSE_RE)) {
        addClause(nonEmptyString(match[0]), finalScene.length > 0 ? finalScene : "结局");
      }
    }
  }

  if (options.length === 0) return { keyPoints: [], branches: [] };

  const branches = [{
    id: "br-final-1",
    title: "最终抉择",
    scene: finalScene.length > 0 ? finalScene : "结局",
    desc: "玩家选择型最终分支（确定性提取）",
    options,
  }];

  return { keyPoints, branches };
}

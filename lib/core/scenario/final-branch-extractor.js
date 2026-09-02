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

const FINAL_SCENE_RE = /结局|最终|终局|尾声|抉择|最后的选择|最后选择|ENDING|TRUE\s*END|BAD\s*END|GOOD\s*END|BE|GE|TE/i;
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
    if (label.length < 2 || label.length > 60 || seenLabels.has(label)) return;
    seenLabels.add(label);
    options.push({ label, leadsTo: label });
    keyPoints.push({ id: `kp-final-${keyPoints.length + 1}`, title: label, scene, desc: `最终抉择选项：${label}` });
  };

  const extractWindow = (haystack, scene, maxOptions = 6, forceWindow = false) => {
    const markerRe = /最终抉择|最后的?选择|面临抉择|二选一|两条路|抉择/;
    const markerMatch = markerRe.exec(haystack);
    if (markerMatch === null && !forceWindow) return 0;
    if (finalScene.length === 0 && scene.length > 0) finalScene = scene;
    const start = forceWindow ? 0 : Math.max(0, markerMatch.index - 120);
    const end = forceWindow ? Math.min(haystack.length, 800) : Math.min(haystack.length, markerMatch.index + 800);
    const window = haystack.slice(start, end);
    let added = 0;

    // 优先：显式列表型选项（“毁灭：… / 封印：… / 救赎：…”）。
    // 很多模组最后的选择用项目符号+冒号给出明确选项，比“若/如果”句式更可靠。
    const bulletRe = /^[\t ]*[•·▪◦●○▪*\-–—]\s*([^：:\n]{1,60})[：:]\s*(.*)$/gm;
    const bulletMatches = [...window.matchAll(bulletRe)];
    if (bulletMatches.length > 0) {
      for (const match of bulletMatches) {
        if (added >= maxOptions) break;
        const label = nonEmptyString(match[1]);
        if (label.length < 2 || label.length > 60) continue;
        const before = options.length;
        addClause(`若调查员${label}`, scene);
        if (options.length > before) added += 1;
      }
      if (added > 0) return added;
    }

    for (const match of window.matchAll(CHOICE_CLAUSE_RE)) {
      if (added >= maxOptions) break;
      const before = options.length;
      addClause(nonEmptyString(match[0]), scene);
      if (options.length > before) added += 1;
    }
    return added;
  };

  // 优先：标题本身就是“最后的选择/最终抉择”的章节，再退到正文里只提到
  // “抉择”的章节。避免“正位意象的扭曲运用”这种正文碰巧出现“抉择”的
  // 章节抢先截出错误选项。
  const priorityFacts = finalFacts.filter((fact) => /最后的选择|最后选择|最终抉择|面临抉择|抉择/.test(nonEmptyString(fact?.heading)));
  const restFacts = finalFacts.filter((fact) => !priorityFacts.includes(fact));
  for (const fact of [...priorityFacts, ...restFacts]) {
    const scene = nonEmptyString(fact?.heading);
    const original = String(fact?.original ?? "");
    const isPriority = priorityFacts.includes(fact);
    extractWindow(original, scene, 6, isPriority);
    if (options.length > 0) break;
  }

  // 兜底：全文扫描“最终抉择”附近段落。
  if (options.length === 0) {
    const marker = /最终抉择|最后的?选择|面临抉择/;
    const markerIndex = text.search(marker);
    if (markerIndex >= 0) {
      const start = Math.max(0, markerIndex - 120);
      const window = text.slice(start, markerIndex + 800);
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
    finalChoice: true,
    options,
  }];

  return { keyPoints, branches };
}

/**
 * 分块深度解析：按场景事实切块，每块只让 LLM 生成局部条件/边，
 * 最终分支与结局单独生成，最后确定性合并。零 DSH 依赖。
 *
 * 产物与 deep-parse.js 相同：keyPointConditions / branchConditions /
 * plotEdges / branches / endings。
 */

import { canonicalizeDeepParse, validateDeepParse } from "./deep-parse.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return String(value ?? "").trim();
}

/**
 * 把确定性骨架按场景事实切成局部块。
 * @param {object} flat - { scenario:{text,name}, scenarioFacts, keyPoints, branches }
 * @returns {Array<{id:string, scene:string, keyPoints:Array<object>, branches:Array<object>, text:string}>}
 */
export function splitDeepParseChunks(flat) {
  const facts = asArray(flat?.scenarioFacts);
  const keyPoints = asArray(flat?.keyPoints);
  const branches = asArray(flat?.branches);
  const chunks = [];
  const seenKp = new Set();
  const seenBr = new Set();

  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];
    const scene = nonEmptyString(fact?.heading);
    if (scene.length === 0) continue;
    const sectionId = nonEmptyString(fact?.sectionId);
    const sceneKps = keyPoints.filter(
      (kp) =>
        nonEmptyString(kp?.scene) === scene ||
        nonEmptyString(kp?.title) === scene ||
        (sectionId.length > 0 && nonEmptyString(kp?.sectionId) === sectionId) ||
        nonEmptyString(kp?.scene) === nonEmptyString(fact?.scene)
    );
    const sceneBrs = branches.filter(
      (branch) => nonEmptyString(branch?.scene) === scene || nonEmptyString(branch?.scene) === nonEmptyString(fact?.scene)
    );
    if (sceneKps.length === 0 && sceneBrs.length === 0) continue;
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      scene,
      keyPoints: sceneKps,
      branches: sceneBrs,
      text: String(fact?.original ?? "").slice(0, 8000),
    });
    sceneKps.forEach((kp) => seenKp.add(String(kp?.id ?? "")));
    sceneBrs.forEach((branch) => seenBr.add(String(branch?.id ?? "")));
  }

  const orphanKps = keyPoints.filter((kp) => !seenKp.has(String(kp?.id ?? "")));
  const orphanBrs = branches.filter((branch) => !seenBr.has(String(branch?.id ?? "")));
  if (orphanKps.length > 0 || orphanBrs.length > 0) {
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      scene: "其他",
      keyPoints: orphanKps,
      branches: orphanBrs,
      text: String(flat?.scenario?.text ?? "").slice(0, 8000),
    });
  }

  return chunks;
}

/**
 * 单块生成 Prompt：输出本块节点的条件与边；允许并鼓励跨场景推进边。
 * @param {object} flat
 * @param {object} chunk
 * @returns {string}
 */
export function buildChunkPrompt(flat, chunk) {
  const name = String(flat?.scenario?.name ?? "剧本");
  const checkpoints = asArray(flat?.scenarioCheckpoints)
    .filter((item) => nonEmptyString(item?.scene) === chunk.scene || nonEmptyString(item?.scene) === nonEmptyString(chunk?.scene))
    .map((item) => ({
      id: item.id ?? "",
      skill: item.skill ?? "",
      trigger: String(item.trigger ?? "").slice(0, 200),
      scene: item.scene ?? "",
    }));

  const sceneDirectory = asArray(flat?.keyPoints).map((kp) => ({
    id: String(kp?.id ?? ""),
    title: nonEmptyString(kp?.title),
    scene: nonEmptyString(kp?.scene),
    kind: nonEmptyString(kp?.kind),
    flowRole: nonEmptyString(kp?.flowRole),
  })).filter((entry) => entry.id.length > 0);

  return [
    `你是 CoC 跑团剧本的结构化专家。请只处理剧本《${name}》的一个局部场景：${chunk.scene}。`,
    ``,
    `只输出一个 JSON 对象（不要 Markdown 代码块）：`,
    `{`,
    `  "keyPointConditions": [{"keyPointId":"kp-1","requires":{"checkpointGroups":[["chk-1"]]},"requiresAnyOf":[{"keyPointIds":["kp-2"]}]}],`,
    `  "branchConditions": [],`,
    `  "plotEdges": [{"from":"kp:kp-1","to":"kp:kp-2","label":"完成工厂调查后前往货运码头","requires":[{"keyPointIds":["kp-1"]}]}]`,
    `}`,
    ``,
    `约束：`,
    `- 条件对象只允许 scene / entryEvidence / checkpointGroups / sanityEventIds / keyPointIds / branchChoiceIds / optionLabel / not；能写 scene 就写 scene。`,
    `- 开场关键点不要用“检定成功”作唯一前提，避免玩家跳过检定就卡死。`,
    `- 标有 checkpointBranch 的分支不要写 branchCondition；单选项检定点分支不要自动代选。`,
    `- plotEdges 的 from/to 只能是 br:<branchId> / kp:<keyPointId>；不要写 endings（最终分支与结局由独立生成器负责）。`,
    `- 跨场景推进边：允许并鼓励写 kp:<本场景关键点> → kp:<其他场景关键点>，label 写推进方式或剧情条件（如“完成工厂调查后前往货运码头”），requires 可写 keyPointIds / checkpointGroups。`,
    `- 检定分支解锁的是线索/信息，不是场景推进；不要只写检定自环边（br→同场景kp）。`,
    `- 每个 flowRole=main 的关键点，如果原文明确提到之后可前往/将前往的下一可去场景，就尽量写一条出边指向那个场景；没有依据就不写。`,
    `- 支线场景用 hook 边建模：源场景 → [scene_event: 接到电话/传闻/委托] → 支线场景，label 写触发方式，requires 写触发条件。`,
    `- 线索型叶子场景不画去下一场景的边；线索用该场景 keyPointConditions/consequences 表达。`,
    `- 只能引用“本场景节点”或“全部场景速查表”里存在的 id；条件里 keyPointIds 可以引用其他场景关键点（表示此前已抵达）。`,
    `- 条件宁缺毋滥，不要编造空条件。`,
    ``,
    `本场景节点：`,
    JSON.stringify({ keyPoints: chunk.keyPoints, branches: chunk.branches, checkpoints }, null, 2),
    ``,
    `全部场景速查表（用于跨场景推进边；只读 id/title/scene/kind/flowRole）：`,
    JSON.stringify(sceneDirectory, null, 2),
    ``,
    `本场景原文：`,
    chunk.text,
  ].join("\n");
}

/**
 * 单块语义审校 Prompt：审校分块生成的关键点条件/分支条件/内部边是否忠实
 * 于该块原文。只输出 issues JSON，供 loop 第 2/3 轮回灌修复。
 * @param {object} flat
 * @param {object} chunk
 * @param {object} chunkPart - 该块生成的 keyPointConditions/branchConditions/plotEdges
 * @returns {string}
 */
export function buildChunkReviewPrompt(flat, chunk, chunkPart) {
  const name = String(flat?.scenario?.name ?? "剧本");
  const checkpoints = asArray(flat?.scenarioCheckpoints)
    .filter((item) => nonEmptyString(item?.scene) === chunk.scene)
    .map((item) => ({
      id: item.id ?? "",
      skill: item.skill ?? "",
      trigger: String(item.trigger ?? "").slice(0, 160),
      scene: item.scene ?? "",
    }));
  const part = {
    keyPointConditions: asArray(chunkPart?.keyPointConditions),
    branchConditions: asArray(chunkPart?.branchConditions),
    plotEdges: asArray(chunkPart?.plotEdges),
  };
  const sceneDirectory = asArray(flat?.keyPoints).map((kp) => ({
    id: String(kp?.id ?? ""),
    title: nonEmptyString(kp?.title),
    scene: nonEmptyString(kp?.scene),
    kind: nonEmptyString(kp?.kind),
    flowRole: nonEmptyString(kp?.flowRole),
  })).filter((entry) => entry.id.length > 0);
  return [
    `你是 CoC 跑团剧本的结构化审校员。请审校剧本《${name}》局部场景「${chunk.scene}」的剧情条件草稿是否忠实于原文：条件是否会卡死玩家、是否提前剧透、引用是否真实存在。`,
    ``,
    `只输出一个 JSON 对象：{"issues":[{"severity":"high","where":"keyPointConditions[0].requires","problem":"...","suggestion":"..."}]}`,
    `severity 只能是 high / medium / low。`,
    `high = 引用不存在的节点/检定点 id、条件与原文明显矛盾、scene 门控写错导致永远无法满足、开场关键点把检定成功当作唯一前置（玩家开局检定失败就卡死）；`,
    `medium = 条件过于空泛（只写 scene）、关键点缺少前置导致提前剧透、plotEdges 缺少 requires、把后续节点当作当前节点前置；`,
    `low = 优化建议。`,
    `如果没有 high/medium 问题，issues 可以是空数组；不确定的不要报。`,
    `只审校当前草稿，不要审校最终分支与结局（它们不在这里）。`,
    `注意：线索型关键点用 checkpointGroups 表达“检定成功才能获得线索”是正确建模，不要因为“检定失败会漏线索”就报 high/medium；`,
    `跨场景推进边审校：如果原文明确写到本场景之后可前往/将前往的下一可去场景，而草稿缺少 kp:<本场景> → kp:<目标场景> 的 plotEdge，记 medium「漏掉明显的场景推进边」；`,
    `不要审校 plotEdges 的 from/to 或分支 leadsTo 的指向内容是否存在（它们由骨架约束）；只审校 requires / branchConditions / keyPointConditions / 明显缺失的跨场景推进边。`,
    ``,
    `本场景节点：`,
    JSON.stringify({ keyPoints: asArray(chunk?.keyPoints), branches: asArray(chunk?.branches), checkpoints }, null, 2),
    ``,
    `全部场景速查表：`,
    JSON.stringify(sceneDirectory, null, 2),
    ``,
    `当前草稿：`,
    JSON.stringify(part, null, 2),
    ``,
    `本场景原文：`,
    String(chunk?.text ?? "").slice(0, 6000),
  ].join("\n");
}

/**
 * 单块修复 Prompt：把审校意见回灌给该块，只输出修正后的局部条件/边。
 * @param {object} flat
 * @param {object} chunk
 * @param {object} chunkPart
 * @param {string} reviewIssuesText - 该块审校问题的格式化文本
 * @returns {string}
 */
export function buildChunkRevisionPrompt(flat, chunk, chunkPart, reviewIssuesText) {
  const base = buildChunkPrompt(flat, chunk);
  const part = {
    keyPointConditions: asArray(chunkPart?.keyPointConditions),
    branchConditions: asArray(chunkPart?.branchConditions),
    plotEdges: asArray(chunkPart?.plotEdges),
  };
  return [
    base,
    ``,
    `上一轮审校发现的问题（只修复这些问题，其余保持不变）：`,
    reviewIssuesText.length > 0 ? reviewIssuesText : "（无）",
    ``,
    `上一轮草稿（供参考）：`,
    JSON.stringify(part, null, 2),
    ``,
    `请输出修正后的 JSON 对象（只允许 keyPointConditions / branchConditions / plotEdges 字段）。`,
  ].join("\n");
}

/**
 * 从原文提取结局相关段落（确定性按标记词切块）。
 * @param {object} flat
 * @param {number} maxChars
 * @returns {string[]}
 */
export function extractEndingParagraphs(flat, maxChars = 12000) {
  const text = String(flat?.scenario?.text ?? "");
  const markerRe = /结局|最终抉择|最后的选择|面临抉择|尾声|TRUE\s*END|BAD\s*END|GOOD\s*END|ENDING|TE\b|BE\b|GE\b/i;
  // 按行定位结局标记，取标记行前 2 行、后 20 行作为结局段落窗口；
  // 重叠窗口合并。比“按空行分段”更稳：不少模组全文只有一个段落，
  // 空行分段会把整篇原文当成一个结局段落塞进 prompt。
  const lines = text.split(/\r?\n/);
  const markerIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (markerRe.test(lines[index])) markerIndexes.push(index);
  }
  if (markerIndexes.length === 0) return [];

  const ranges = [];
  for (const index of markerIndexes) {
    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length - 1, index + 20);
    if (ranges.length === 0 || start > ranges[ranges.length - 1][1] + 1) {
      ranges.push([start, end]);
    } else {
      ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], end);
    }
  }

  const out = [];
  let total = 0;
  for (const [start, end] of ranges) {
    const block = lines.slice(start, end + 1).join("\n").trim();
    if (block.length === 0) continue;
    out.push(block);
    total += block.length;
    if (total >= maxChars) break;
  }
  return out;
}

/**
 * 最终分支与结局生成 Prompt。
 * @param {object} flat
 * @param {Array<{id:string, scene:string}>} chunks
 * @returns {string}
 */
export function buildFinalWiringPrompt(flat, chunks) {
  const name = String(flat?.scenario?.name ?? "剧本");
  const keyPoints = asArray(flat?.keyPoints).map((kp) => ({
    id: kp.id ?? "",
    title: kp.title ?? "",
    scene: kp.scene ?? "",
    finalChoice: kp?.finalChoice === true,
  }));
  const branches = asArray(flat?.branches).map((branch) => ({
    id: branch.id ?? "",
    title: branch.title ?? "",
    scene: branch.scene ?? "",
    finalChoice: branch?.finalChoice === true || String(branch?.id ?? "").startsWith("br-final"),
    checkpointBranch: branch?.checkpointBranch === true,
    options: asArray(branch?.options),
  }));
  const chunkScenes = chunks.map((chunk) => chunk.scene);
  const checkpointIds = asArray(flat?.scenarioCheckpoints).map((check) => nonEmptyString(check?.id)).filter((id) => id.length > 0);

  return [
    `你是 CoC 跑团剧本的结构化专家。请只处理剧本《${name}》的最终分支与结局，不要生成 keyPoints。`,
    ``,
    `只输出一个 JSON 对象（不要 Markdown 代码块）：`,
    `{`,
    `  "branches": [{"id":"br-final-x","title":"最终抉择","scene":"结局场景","finalChoice":true,"options":[{"label":"选项A","leadsTo":"结局A"},{"label":"选项B","leadsTo":"结局B"}]}],`,
    `  "branchConditions": [{"branchId":"br-final-x","requires":{"scene":"结局场景"}}],`,
    `  "plotEdges": [{"from":"br:br-final-x","to":"end:end-1","label":"选项A","requires":[]}],`,
    `  "endings": [{"id":"end-1","branchId":"br-final-x","title":"结局A","optionLabel":"选项A","mutexGroup":"最终结局","requires":{"branchChoiceIds":["br-final-x"],"optionLabel":"选项A"},"blockers":[],"endingKeywords":["结局A"]}]`,
    `}`,
    ``,
    `约束：`,
    `- 不允许生成 keyPoints。`,
    `- 如果下方骨架已有最终抉择分支（finalChoice=true），优先复用它，但必须根据“结局相关原文段落”重新确定它的 scene，并允许重写 options（以原文实际选项措辞为准）；如果没有，才允许在 branches 里补一个最终抉择分支。`,
    `- 最终分支必须有 branchCondition：requires.scene 为其真实发生场景，禁止 autoChooseLabel。`,
    `- 每个结局必须有一条 plotEdges 从 br:<最终分支 id> 指向 end:<endingId>。`,
    `- 每个结局的 requires 必须包含 branchChoiceIds:[<最终分支 id>] 和 optionLabel:<选项 label>；不要用“结局章节文案”作 entryEvidence（进入结局场景后天然满足）。`,
    `- 结局如需额外前置，用 keyPointIds / checkpointGroups 引用下方骨架真实存在的 id；不要编造不存在的 id。`,
    `- checkpointGroups 只能引用真实检定点 id（chk-*）；没有合适检定点就不要用 checkpointGroups，改用 keyPointIds / not 表达状态。`,
    `- 严禁用“结局章节内部的关键点”作为该结局的 requires 前置（如结局后续的苏醒/交流/葬礼等节点），那会造成循环依赖；结局章节内的节点只能放进 endingKeywords 或 blockers。`,  
    `- 同一最终分支的多个结局必须完全互斥：任意两条结局的 requires 不允许相同；每条结局至少有一个只属于它的 keyPointIds / checkpointGroups / not 条件来区分（例如“克罗斯已死亡”“已说服克罗斯”）。`,
    `- 结局集合必须穷尽：任意可能的前置关键点组合都必须恰好命中一个结局；如果某个组合没有自然对应的结局，就给兜底结局去掉 not 排除项，或补一个“其他情况”结局，确保不会出现所有结局都不满足的真空。`,
    `- 每个结局的 plotEdges 入边要能体现该结局的独有条件；不要把多条结局的入边都写成空 requires。`,
    `- 不要把结局挂在 checkpointBranch 分支上。`,
    `- 如果不同结局发生在完全不同的剧情阶段（如开局拒绝、时间耗尽、最终对决），不要把它们塞进同一个最终抉择分支的并列选项里；为不同阶段分别建立分支，或给每个结局的 requires 写明阶段前置（keyPointIds / entryEvidence），确保同一分支的选项只在对应阶段可达。`,
    ``,
    `确定性骨架（可引用 id）：`,
    JSON.stringify({ keyPoints, branches, chunkScenes, checkpointIds }, null, 2),
    ``,
    `结局相关原文段落（这些是判定结局的权威依据，必须逐一覆盖）：`,
    extractEndingParagraphs(flat).map((block) => `###\n${block}`).join("\n\n").slice(0, 12000),
    ``,
    `原文末尾参考：`,
    String(flat?.scenario?.text ?? "").slice(-4000),
  ].join("\n");
}

/**
 * 合并分块结果与最终分支结果：先组装原始产物，再走模型无关归一化，保证
 * 不同模型输出的字段形态变体在进入 preflight 前被折叠成运行时 schema。
 * @param {object} flat
 * @param {Array<object>} chunkResults - 每块 parsed.deepParse 或 null
 * @param {object} finalResult - parsed.deepParse 或 null
 * @returns {{ deepParse: object|null, issues: string[] }}
 */
export function mergeChunkedDeepParseParts(flat, chunkResults, finalResult) {
  const final = finalResult ?? {};
  // 所有权规则：最终抉择分支的 branchCondition 与出边由最终分支/结局生成器
  // 独占。分块结果里若出现 br:br-final-* 的边或 branchCondition，会与最终
  // 生成器的结局路由打架（例如无条件到 kp-final 的边抢先于条件结局边）。
  const finalChoiceIds = new Set(
    [...asArray(flat?.branches), ...asArray(final.branches)]
      .filter((branch) => branch?.finalChoice === true || String(branch?.id ?? "").startsWith("br-final"))
      .map((branch) => String(branch?.id ?? ""))
  );
  const isFinalOwnedEdge = (edge) => {
    const from = String(edge?.from ?? "");
    if (!from.startsWith("br:")) return false;
    return finalChoiceIds.has(from.slice(3));
  };

  const keyPointConditions = [];
  const branchConditions = [];
  const plotEdges = [];
  for (const part of chunkResults) {
    if (part === null || part === undefined) continue;
    keyPointConditions.push(...asArray(part.keyPointConditions));
    branchConditions.push(
      ...asArray(part.branchConditions).filter((entry) => !finalChoiceIds.has(String(entry?.branchId ?? "")))
    );
    plotEdges.push(...asArray(part.plotEdges).filter((edge) => !isFinalOwnedEdge(edge)));
  }
  branchConditions.push(...asArray(final.branchConditions));
  plotEdges.push(...asArray(final.plotEdges));

  const raw = {
    version: "1.0",
    keyPoints: [],
    branches: asArray(final.branches),
    keyPointConditions,
    branchConditions,
    plotEdges,
    endings: asArray(final.endings),
  };

  const canonical = canonicalizeDeepParse(raw);
  return { deepParse: canonical.deepParse, issues: [...canonical.issues, ...validateDeepParse(canonical.deepParse, flat)] };
}

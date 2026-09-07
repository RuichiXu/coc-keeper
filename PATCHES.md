# 开发补丁记录（Known Patches / Heuristics）

> 本文件记录当前为了快速止血而引入的**通用性较差的规则/方法**。
> 这些实现依赖部分词语组合、启发式匹配或补偿性回滚，后续会被
> 结构化实现替换。修改前请先读本表，避免在旧补丁上继续叠加。

| # | 位置 | 补丁内容 | 为什么是补丁 | 后续替换方向 |
|---|---|---|---|---|
| 1 | `lib/shared/chat/chat-bridge.js` `autoTrackInventory` / `cleanupJunkInventory` | 用 `ITEM_ACQUIRE_RE / ITEM_BA_RE / ITEM_STATE_CARRY_RE / ITEM_CONTAINED_RE` 等正则从叙述中提取物品入栏；`canonicalItemsFromEntities` 把候选归一到剧本实体物品名（含“稿纸/纸页→四张手稿”“日记→克罗斯的日记”）；清理物品栏时先做实体归一，避免实体名里的合法数量词（“四张手稿”）被旧垃圾规则误删；`ITEM_ABSTRACT_DENY` 增补“蛮力”、`ITEM_CONTAINER_DENY` 增补“文件袋”，`normalizeAcquiredItem` 剥前导“本”与尾部“沉甸甸地/沉甸甸” | 自然语言持有表达无穷尽，正则只能覆盖部分句式，仍有漏/误（如 NPC 主体“艾茜接过油灯”会误入油灯） | 物品获取/交付/放回应由验证后的结构化事件提交（coc_pc inventoryAdd/Remove 或 item-location event），提取器只做兜底 |
| 2 | `lib/shared/chat/chat-bridge.js` `revealKeyPointsFromNarration` | 标题去动作前缀/事件后缀 + “A与B”拆分 + 否定语境检测（“没能进入书房”不揭示）；过短剥离词（<4 字）不再命中，空间型标题（进入/来到/打开）交给事件驱动 | 标题包含关系不是真正的剧情触发判定，仍可能提前揭示 | 由 Trigger Engine 依据已获得线索/事件激活关键点（已由 `applyEventDrivenLanding` 部分替代） |
| 3 | `lib/shared/tools/rules.js` `canonicalSanityEventId` | 用 SAN 检定点 keys 与 description 的重叠打分映射规范幂等键 | 依赖描述文本碰巧包含“巨眼/漩涡/墨渊”等词 | 剧本导入时生成稳定 phenomenonId 并写入检定点；工具直接引用，不再靠描述匹配 |
| 4 | `lib/shared/chat/narration-guard.js` `findCheckpointClueLeak` | 当前场景检定点 clueWords 出现在叙述中就判泄露 | 词面匹配无法理解语义，存在误报/漏报 | 已部分落地为 `scenario-contract-validator.js` 的 clueGates（契约驱动）；旧 guard 待契约覆盖全量后删除 |
| 8 | `lib/core/scenario/contract-draft.js` | 用正则从原文识别仪式/夜晚事件行（仪式/召唤/午夜/入睡…）草拟契约 | 只是草拟，无法理解剧本语义，nightLabel/requires 常为空 | 已改为导入时仅用确定性草拟（status=draft，KP 面板校对后生效）；后续由剧本导入深度解析或契约校对面板补全 |
| 5 | `lib/shared/chat/chat-bridge.js` 副作用快照回滚 | 自由动作路径先 `snapshotSideEffects`，守卫发现 clue-leak 再回滚 characters/rollHistory/sanitySettled | 补偿式事务，不是真正的工具执行事务；回滚范围写死在字段列表 | 工具执行引入 staging/commit 事务层，守卫通过后再提交副作用事件 |
| 6 | `lib/shared/tools/rules.js` `findCharacterLoose` | 去掉引号/空白后按姓名匹配角色 | 只修了 coc_sanity_check 一处，其他工具仍可能因引号差异找不到人 | 在 WorldState/character-parser 层统一姓名归一化，所有工具共享 |
| 7 | `lib/shared/chat/chat-bridge.js` 理智门禁清洗 | 把 pendingChecks 里 skill=理智 的历史门禁移入 skipped(reason=sanity-handled-by-tool)，SC 统一由 coc_sanity_check 明骰结算 | 是对历史脏数据的清洗补丁 | 门禁 schema 增加 `kind: sanity`，从源头区分 SC（明骰+损失结算）与普通技能门禁 |
| 9 | `lib/shared/chat/chat-bridge.js` `runNarrationLoop` | 模型连续“只调工具不写正文”时，下一轮禁用工具并注入“请直接输出叙述”；连续两轮空正文则提前结束循环 | 是对 LLM 输出不稳定（tool-only 循环/空响应）的补偿式控制，不能根治上游问题 | Director 引入“工具轮次预算 + 强制叙述轮”的确定性状态机，并对空响应做结构化兜底叙述 |
| 10 | `lib/shared/chat/chat-bridge.js` `autoLandBranches` / `revealKeyPointsForBranchChoices` / 完整咒文正则 / 最终仪式轮指引 / 结局门禁冻结 | 玩家输入或叙述命中分支选项原文即标记 reached+chosen（取最晚出现且无否定语境的选项，并剥掉选项尾部“查看/进入”等动词以匹配“掀开地毯”）；分支选择后按 option.leadsTo 揭示关键点，场景型 leadsTo 需 currentScene 真正切入；完整十二字咒文用正则识别；最终仪式轮意志/SAN 掷骰后注入“按已选结局推进、不得回退”指引；结局关键词出现后废弃全部旧门禁并停止新增团检。C-3/C-4 后：结构化关键点/分支优先由 `KeyPointRevealed` / `BranchLanded` 事件 + PlotGraph frontier 驱动，本行正则仅作无结构数据兜底 | 分支落地本该由 `coc_branch` 工具/PlotGraph 事件完成，正则只能覆盖选项原文直引的窄场景 | 由 Trigger Engine 在“选项被选择”事件上确定性落地分支与关键点，并结构化识别咒文序列与仪式阶段（已部分完成，正则兜底保留至 D 阶段全量结构化） |
| 11 | ~~`lib/shared/chat/chat-bridge.js` `applyEventDrivenLanding` / `findCheckpointMatch` / `recordPassedCheckpoint`~~ | ~~事件驱动落地：空间型关键点（进入/来到/打开）在场景精确切入时揭示，发现型不因身处场景揭示；检定点通过 → 揭示“日记与手稿/十二字咒文”；SAN 结算（sanitySettled 映射 chk-9）→ 揭示“发现墨渊”并落地掀开地毯分支（chk-7 确认接缝不算目击）；咒文揭示或最终分支已选 → 揭示“克罗斯临终提示”；最终分支已选且咒文已揭示 → 揭示“最终抉择”~~ **已由 B-3 替代：`applyEventDrivenLanding` 改为读 keyPoints/branches 上的结构化 `requires/requiresAnyOf`，不再含《墨渊》ID 硬编码。** | 当前按《墨渊》剧本的关键点/检定点 ID 硬编码映射（ai-kp-4/5/6/7/8、chk-3/5/9/13、ai-br-2），尚未泛化到任意剧本 | 剧本导入时为每个关键点/分支生成结构化前置条件（requiresCheckpoints / requiresKeyPoints / requiresScene / requiresSanityEvent），由 Trigger Engine 统一激活（见行 18） |
| 12 | `lib/shared/chat/chat-bridge.js` `recordResolvedCheck` / `resolvedCheckKey` + 门禁合并过滤 | 成功 `.ra` 后把 skill+目标键写入 `flat.resolvedChecks` 并立即落盘（避免叙事循环重载覆盖）；后续同目标门禁（coc_check 或文本 [团检]）在合并时直接丢弃并注入“该检定已通过，自动忽略”日志 | 是对 LLM 反复要求同一检定这一上游问题的补偿式去重；目标键仍由词表/同义词启发式得到，词表外同义改写仍会漏 | 门禁 schema 增加 `checkpointId/kind`，由 Checkpoint 引擎按检定点 ID 幂等消费；文本门禁只做兜底 |
| 13 | `lib/shared/chat/ending.js` + `chat-bridge.js` 终局短路 | 最终咒文轮（意志/SAN）成功且叙述未出现结局关键词时，程序追加结局句、提交 `endingReached/endedAt/当前场景`、补揭示咒文/最终类关键点并清空全部门禁。B-4 收敛为 `createEndingResolvedEvent` / `applyEndingResolvedEvent`；C-4 起结局由 PlotGraph 结局节点（`end:<branch>:*`）完成后构造发布；2026-09-07 起 `endingSentenceFor` 只取分支选项关键词，不再含《墨渊》固定结局模板 | 聊天桥仍决定“最终仪式轮成功 = 结局成立” | 结局成立条件与渲染文本全部由 PlotGraph/ClueGraph 结局节点提供，聊天桥只消费 `EndingResolved` 事件 |
| 14 | `lib/shared/chat/chat-bridge.js` `autoLandBranches` 玩家输入优先 / `spellShown` 咒文展示 / `sanitizeSanityLine` SAN 玩家可见清洗 | 分支落地先搜玩家输入、命中即停，不再被叙述末尾菜单词（撬锁工具）覆盖；咒文关键点揭示或最终分支已选后展示咒文（2026-09-07 起由 `spell-text.js` 从剧本数据提取，不再固定写死《墨渊》文本）；`coc_sanity_check` 结算行只写损失结果，`knowledge-layers` 对 player 层隐藏理智骰。C-4 后：玩家选择/分支落地已有 `BranchLanded` 事件 + PlotGraph 结局节点，本行正则仅作兜底 | 仍是对 LLM 文本行为的补偿：玩家意图解析与线索展示本应由结构化事件/ClueGraph 完成；SAN 行清洗是展示层规则 | 玩家动作/选择由 `coc_branch` 事件驱动；线索展示由 ClueGraph `ClueRevealed` 事件渲染；SAN 展示由 Knowledge 层统一按 roll.kind/skill 过滤 |
| 15 | `lib/shared/chat/chat-bridge.js` 咒文解读兜底 / ~~`applyEventDrivenLanding` 进门证据~~ / `findEarlyDiaryLeak` / `sanitizeGateAction` / `ITEM_JUNK_EXTRA` | 智力在解谜语境下成功且“日记与手稿”已揭示时，程序记录咒文关键点结构化前置检定点（B-3 后不再硬编码 chk-13/ai-kp-4）；~~“进入书房”在场景精确切入基础上额外要求文本出现实际进门短语~~（B-3 后由 `entryEvidence` 生成器统一处理）；日记关键点自带文本在揭示前由守卫拦截（2026-09-07 起通用化，不再含《墨渊》固定句）；门禁动作清洗残缺提示尾；物品清理增补“隔层/两样/一并”等垃圾项 | 咒文解读兜底、日记拦截、门禁动作清洗、物品清理仍为 LLM 文本行为的补偿式兜底 | 咒文由 ClueGraph 的 `SpellDecoded` 事件驱动；关键点前置条件结构化（见行 18）；门禁动作由 `coc_check` schema 限制为短选项原文；物品由实体注册表白名单管理 |
| 16 | `lib/shared/chat/check-gates.js` `gateTargetKey` / `scoreTargetMatch` / `mergeCheckGates` 语义合并 / 自由动作不清空旧门禁 | 门禁动作经词表+同义词归一成目标键；同一目标换措辞只保留一条门禁并更新动作文本与难度；玩家输入用目标键匹配旧门禁，避免“同目标改写误删唯一门禁”；未命中门禁的自由动作不再清空 pendingChecks | 词表/同义词是启发式，目标键仍可能漏配或误并；旧门禁长期保留需要后续“场景失效/明确跳过”的清理规则 | 门禁 schema 增加 `checkpointId/target`，由 Checkpoint 引擎按检定点 ID 消费；目标失效由 Scene/Plot 事件自动清理 |
| 17 | `lib/shared/chat/chat-bridge.js` 检定点消费 / 失败消费 / `lib/shared/chat/gate-lifecycle.js` `expireSceneGates` | `.ra` 前先匹配检定点并绑定到 selectedGate，成功按 checkpointId 记录 passedCheckpointIds；门禁短路过滤同时看 resolvedChecks 与 passedCheckpointIds；失败记 gate-failed trace；`coc_check` 创建门禁时已直接写入 checkpointId/target；`coc_scene` 场景切换与每轮聊天开始时按前缀规则清理过期门禁 | 文本 [团检] 门禁仍依赖 `findCheckpointMatch` 的启发式匹配；前缀规则无法覆盖所有场景命名（见行 19） | 门禁创建时由场景事实/检定点直接写入 checkpointId（coc_check 已完成）；目标失效由 Scene/Plot 事件精确清理 |
| 18 | `lib/shared/chat/story-prereqs.js` `draftKeyPointPrerequisites` / `draftBranchPrerequisites` / `draftEndingKeyPointPrerequisites` / `entryEvidenceVariants` | 从关键点标题词 + 检定点 keys/trigger + 场景/楼层兼容 + 难度排序，草拟 `requires/requiresAnyOf/autoChooseLabel`；进门证据由动词表（进入/来到/打开…）扩展同义短语 | 仍是规则式草拟，无法理解剧本语义；标题词表与 keys 匹配会漏配/误配（如非《墨渊》剧本） | D-4 已落地：聊天桥先 `applyConfirmedDeepParse` 覆盖确认稿条件，本行仅在无 LLM / 未确认时兜底；D 阶段全量校对后可逐步删除 |
| 19 | `lib/shared/chat/gate-lifecycle.js` `expireSceneGates` 前缀边界规则 | 当前场景以门禁 scene 为前缀且剩余部分不是“门外/门口/外部/外”时保留，否则失效；`coc_scene` 切换时立即执行 | 仍是场景命名启发式，无法覆盖“三层书房门外”之外的同形场景（如“三层书房外间”） | 场景实体/SceneGraph 建立后按 sceneId 邻接关系精确失效；门禁绑定 sceneId 而非场景名 |
| 20 | `lib/shared/tools/helpers.js` `commitSession` 先 `hydratePlotFields` 再应用事件再投影 | C-1 过渡：旧工具/聊天桥仍直接改 flat 的剧情账本字段，提交时先收进 WorldState，再应用本轮事件，最后投影回 flat。C-1 续已把聊天桥主要副作用事件化（GateResolved/GateFailed/CheckpointPassed/KeyPointRevealed/BranchLanded/SpellShown/NightEventFired/EndingResolved/GateCreated），但 flat 双写入口仍在 | 双写入口仍然存在（flat 与 WorldState 都可改），未做到“flat 只读投影” | C-1 收尾：剩余 `abandonGates`/`expireSceneGates`/SAN 清理也纳入事件，旧工具全部改为 world-first，移除 hydratePlotFields 兼容层 |

## 使用约定

1. 新增工具/守卫时，如果实现依赖“关键词/正则/部分词语组合”，先问一句：
   **“这个行为能否由结构化状态或事件确定性判定？”** 能就不要加正则。
2. 必须新增补丁时，在本表登记，并写清替换方向。
3. 每次重构命中上表某项，删除或简化该补丁后，更新对应行状态并补回归测试。
| 21 | `lib/core/scenario/scene-facts.js` `inferSceneTransition` + `hasSceneMovementPhrase`；`chat-bridge.js` 场景落地改用 transition 版 | 当前场景非空时，必须「新场景词 + 位置转移动作（进入/来到/走到…）」同时命中才切换场景；避免“检查书桌”叙述里顺带提到“一层客厅”就把 currentScene 漂走 | 仍是动作词表启发式，复杂转移（“绕到宅邸后”“从暗门爬出”）可能漏配 | SceneGraph/地点实体建立后，按场景邻接关系与移动事件精确切换；动作词表只作兜底 |
| 22 | `lib/shared/chat/chat-bridge.js` 最终仪式轮失败重试 | 最终咒文仪式轮（意志/SAN）门禁失败后，程序自动以 `source:"final-rite-retry"` 重建同门禁并发布 GateCreated；裸 `.ra` 在多个意志候选门禁并存时优先消费该重试门禁（不进入候选确认） | 仍是《墨渊》终局特化；通用“失败后是否可重试/难度是否变化”应由门禁策略引擎决定 | Checkpoint 引擎支持 retryPolicy（可重试/难度递增/消耗时间），由场景契约配置 |
| 23 | `lib/shared/chat/ending.js` `confirmedEndingForBranch` optionLabel 匹配（相等/互相包含）+ 候选结局按 requires/blockers 筛选；`lib/core/scenario/deep-parse.js` `syncPlotGraphFromDeepParse` 为无落点 leadsTo 自动补 `kp:auto:*` 节点与边；`lib/shared/chat/chat-bridge.js` `applyEventDrivenLanding` 同一轮内使用 keyPoints/branches 快照防 cascade | 深度解析 v2 后引擎侧修复：选项级文本匹配仍是标签文本启发式；自动补点按“标题相等/互相包含”匹配现有节点；快照防塌缩是轮次级 gate | 标题匹配改为节点 id/场景实体邻接；自动补点改为由场景契约显式声明节点；轮次 gate 由时间/事件驱动引擎统一调度 | 三者均先经确定性函数实现，后续迁移到结构化状态后删除对应启发式 |
| 24 | `lib/shared/chat/chat-bridge.js` `applyEventDrivenLanding` 多选项分支无 `autoChooseLabel` 时只 reached 不代选；`lib/core/scenario/deep-parse.js` `applyConfirmedDeepParse` 无 scene 条件自动补目标节点 scene 门控、`detectDeadEndScenes` 无出口场景提示；`lib/client.js` DeepParse 卡片渲染 graphIssues | 深度解析 v2 后引擎规则：分支选择权保留、跨场景揭示 gate、死胡同场景提示 | 场景门控改为 sceneId/SceneGraph 邻接；死胡同提示改为 PlotGraph 可达性分析输出 | 三者均为确定性函数，后续并入剧情图引擎 |
| 25 | `lib/core/scenario/deep-parse.js` `runDeepParsePreflight` 用标题/关键词“相等或互相包含”匹配 leadsTo 与结局入边、`plotEdges` end: 端点 | 生成即校验：用文本匹配近似结构一致性，拦悬空边/无入边结局/未命中 leadsTo | 仍是文本匹配启发式，无法判断语义可达性（见 v4 实验结果） | 节点/场景实体 id 化后按图邻接精确校验 |
| 26 | `lib/core/scenario/deterministic-skeleton.js` 场景事实 heading→keyPoints、检定点→branches | 原始文本经 compileByPattern 无 keyPoints/branches 时，为骨架锁定生成提供确定性节点骨架 | 检定点分支是“技能检定分支”，不是玩家选择型最终分支（v6b 实验失败主因） | 场景结构解析器输出真正的玩家选择节点；检定点只作为 checkpoint 门禁，不冒充分支 |
| 27 | `lib/core/scenario/final-branch-extractor.js` 用“若/如果”句式 + 结局章节词表提取最终抉择分支与选项 | 为骨架锁定生成提供玩家选择型最终分支，避免 LLM 把结局挂到技能检定分支 | 句式词表启发式，长句/反问/隐喻式抉择可能漏提或误提 | 结构化场景解析 + 结局段条件句语法解析；LLM 仅在兜底时辅助 |
| 28 | `lib/core/scenario/deep-parse.js` `extractJsonObject` / `canonicalizeDeepParse` / `repairSkeletonWiringDeepParse`；`chunked-deep-parse.js` 结局段落提取 + 最终分支出边所有权；`deep-parse-loop.js` 修复式审校回灌 | 模型无关 JSON 提取（围栏/尾逗号/平衡扫描/外壳解包）；条件对象形态折叠（not/checkpointGroups/conditions 别名/孤儿 optionLabel）；最终分支 scene 门控与结局 requires/入边确定性补齐；第 2/3 轮只修订最终分支/结局并与第 1 轮分块结果合并；`reasoning_effort` 透传避免 flash 长 prompt 空输出 | 仍是“生成后清洗+规则修复”范式：审校是 LLM 且只覆盖最终分支/结局；分块局部条件的语义质量未纳入审校回灌 | 最终分支/结局由结构化场景解析器直接生成；审校由规则/图可达性分析替代；分块条件语义由 D 阶段全量结构化后逐步移除 |
| 29 | ~~`lib/core/scenario/deep-parse.js` `repairDeepParseConnectivity` 主线按扁平 `order` 串链 + 支线/线索从最后主场景拉 hook~~ | 已删除。旧逻辑不读结构树，会把并行幕/可选遭遇/支线拉成单链 | 已由 `lib/core/scenario/topology-skeleton.js` 的结构树 hub-and-spoke/编号顺序/幕级并行后处理替代；`repairDeepParseConnectivity` 现仅保留结局场景点归位 |
| 30 | `lib/core/scenario/deep-parse.js` `repairDeepParseFinalWiring` 结局 `requires` 没有任何区分条件（不含 branchChoiceIds/optionLabel 等）时，用 endingKeywords/title 生成 `entryEvidence` 兜底并同步到 br→end 边 requires | 最终接线 LLM 会给条件结局生成空前置（如《两面不是人》），用叙述命中词兜底只是缓解，不是真实结构化前置 | 最终接线 prompt/模型保证每条结局有真实独有前置，或结局条件草拟确定性化（见 `PLAN.md` 待办 0 两面最终接线强化）。本轮已收窄：已有 branchChoiceIds+optionLabel 的结局不再加 entryEvidence（这些词是结局发生后文本，不应作前置） |
| 31 | `lib/core/scenario/topology-skeleton.js` `sequenceRank` / `hasSequentialTitles` 用“房间1/地点一/第一幕”等标题正则判断同级 main 子节点是否按编号顺序补边 | 结构树没有显式顺序关系字段，标题编号是仅有的确定性顺序信号；否则默认 hub-and-spoke | 结构分析输出显式 `sequence`/`actOrder` 字段后，直接读结构化顺序，删除标题正则 |


| 32 | `lib/core/scenario/deep-parse.js` `repairDeepParseFinalWiring` 同最终分支结局正向前置相同但一方缺少 `not.keyPointIds` 时，复制另一方的排除项 | 最终接线 LLM 会给“同状态不同选项”的结局漏写阶段排除项（如《盲愚之眼》end-2 漏 not.kp-39，导致仪式完成后仍可命中干预结局）；审校能发现但修订不稳定 | 最终接线/结局条件确定性草拟，或结构化结局互斥模型输出 | 本轮为确定性兜底，后续并入结局互斥建模 |
| 33 | `lib/core/scenario/heading-rules.js` + `scene-facts.js` `splitScenarioSections` + `structure-analysis.js` `cleanScenarioText` 识别 `- ◆` 项目符号标题、裸露短标题（后随标题/页码/页标记才成节）、页码/目录点线行独立成行 | PDF 提取把页底标题与下一短标题、页码粘成一行（《两面不是人》“舞动的皮可能的发展”等），确定性切分与清洗此前只认编号/冒号标题 | 结构分析输出显式标题层级与页面布局信息后，按结构化标题行切分 | 本轮为确定性兜底，裸标题仍依赖“后随标题/页码”上下文判定 |
| 34 | `lib/core/scenario/structure-analysis.js` `splitSectionsAtBareHeadingBoundaries` 把被上一节吞掉的裸标题（如“胀妇之死”）拆成独立 scene_event section；`scene-facts.js` `parseBracketCheckpoints` 提取 `【技能】` 括号式检定点并排除战斗/对抗类 | 窗口 LLM 会把“胀妇之死”并入上一节，且旧检定点提取整类漏掉括号式 `【侦查】` 检定 | 结构分析保证每个标题成节；检定点由结构化技能字段生成 | 本轮为确定性兜底，后续并入结构分析器 |
| 35 | `lib/shared/chat/chat-bridge.js` `autoLandBranches` 对 `finalChoice`/`br-final-*` 分支：玩家输入精确命中选项原文且当前场景与分支场景一致时，落地 reached+chosen | 聊天 UI 里玩家的明确选择就是文本输入，但旧逻辑完全禁止文本代选最终分支；KP 不调用 `coc_branch` 时结局永远不可达（runtime smoke 暴露） | 前端分支选项点击统一走 `coc_branch choose` 事件后，此文本兜底可降级/删除 | 本轮为确定性兜底；仍要求场景匹配，不因叙述词落地 |
| 36 | `lib/shared/tools/plot-tools.js` `resolveBranch` 按 id 精确→标题精确→标题包含→id 前缀逐级解析 branchId，并对 finalChoice 分支加“当前场景 / SceneChanged 历史 / 对话日志提及最终场景”三级门禁；`context-builder.js` 在系统提示显式给出最终分支 id/选项 | Codex 实测模型两次把最终分支标题当 branchId 调用 `coc_branch` 返回“不存在”，且会提前标记未抵达的最终分支；复测中 KP 在外部控制室/尾声补登记最终分支，纯当前场景门禁误伤 11 次；r3 存档连 SceneChanged 历史都缺失（KP 漏调 coc_scene），只能回退到对话日志证据 | 模型工具调用稳定使用 id 后，标题解析可保留为容错；最终分支 id 应由工具 schema/前端选项直接传递 | 本轮为确定性容错；对话日志证据是旧存档恢复的最后兜底 |
| 37 | `lib/core/scenario/settlements.js` `extractSettlements`/`settlementMatches`：从剧本原文正则提取 `SC X/Y`、`全员HP-NdM`、`承受X/Y的伤害` 为结算点；SC 走 `coc_sanity_check`（eventId=scenario:<id> 幂等），HP 走 `coc_pc` 扣血；SC 行紧邻“体质检定+承受伤害”时生成带 `damage` 的 linkedGate，`.ra` 结算时按成败扣 1/1d4；`chat-bridge.js` 在叙述落地后确定性结算并剔除推荐选项行。2026-09-07 二次收紧：`settlementMatches` 改为句子级匹配（anyOf 与语境词须同句），结算点 scene 从最近的“房间N：/外部控制”标记解析（不再使用目录标题），并有 sceneTokens 约束 | Codex 复测《对流》：泄压阀 HP-1d6、直面沸核 SC 1d4/1d10、外出 SC 1/1d6 与体质 1/1d4 全部漏结算；r3 复测又出现“选项里的矿洞/便条里的沸核/靠近热源”误触发与错误 scene 归属 | 结构分析/导入管线直接输出 `settlements`（含触发场景/条件/表达式），不再从原文正则+语境词推断 | 本轮为确定性兜底；句子级语境词与 sceneTokens 仍属启发式 |
| 38 | ~~`lib/shared/chat/chat-bridge.js` `scenarioHasMoyuanSpell`：剧本全文同时含“启墨渊”与“归字主”才允许注入《墨渊》特化文本~~ **已删除。由 `lib/shared/chat/spell-text.js` 数据驱动提取替代（从关键点 spellGroups/spellText 或剧本原文“咒”字附近提取三字一组、四组的咒文，提取不到则不注入）；`ending.js` `endingSentenceFor` 已通用化，不再含任何剧本专属文本** | Codex 复测《对流》第 25 轮：`finalBranchChosen` 为 true 时共享代码无条件注入“启墨渊、引魂夜、临神名、归字主”，但《对流》剧本没有该咒文；早期《墨渊》专项兜底被做成共享路径后一直缺少剧本适用性闸门 | 未来由导入管线在咒文关键点上直接写入 `spellGroups`，聊天桥只读取结构化字段 | 已替换为数据驱动；`spell-text.js` 的原文扫描仍是兜底启发式 |
| 39 | `lib/shared/chat/damage-ledger.js` + `state-tools.js` `coc_pc` + `chat-bridge.js` 自动扣血路径：HP 损失统一记账（120 秒窗口、同角色、等额），`coc_pc` 手动扣血时若发现窗口内已自动结算过等额损失则跳过并提示；内部自动扣血带 `_auto` 旁路，不被账本误拦 | Codex r3：自动扣 1 HP 后，KP 又为同一事件调用 `coc_pc` 再扣 1 HP；LLM 与程序两个写入方无法靠结算点 ID 去重 | 工具执行引入 staging/commit 事务，所有 HP 变化走 WorldState 事件与幂等键 | 本轮为时间窗口+等额启发式去重，仍可能误拦短时间内两次等额但独立的伤害 |
| 40 | `lib/core/scenario/route-index.js` 地点白名单/路线邻接 + `context-builder.js` 注入地点清单与路线约束 + `chat-bridge.js` 玩家转移意图优先场景同步与“未登记地点词”守卫：地点候选用“房间/室/厅/舱/旋梯/拱道/通道…”后缀提取，叙述中出现原文与白名单都没有的地点词时追加纠正重写 | Codex 复测：KP 发明“下层阀门舱/矿洞钥匙/旋梯”等原文没有的地点与捷径，遗迹布局被改写；scene 长期误落 | 场景实体化（sceneId + 邻接关系结构化）后，地点/路线由 SceneGraph 精确判定；地点候选后缀提取可删除 | 本轮为确定性兜底；地点词提取仍属启发式 |

## 补丁现状审计（2026-09-05）

**结论**：行 1–34（除已划线的行 11、29）对应的实现**都仍然保留并被调用**，不是文档滞后；行 11 的旧实现已删除，行 29 的扁平串链已删除、仅存表内划线存档。行 30 本轮已收窄（已有 branchChoiceIds+optionLabel 的结局不再加 entryEvidence）；行 31 为网络拓扑保真新增，行 33/34 为《两面不是人》标题粘连与括号检定提取新增。

### 可以直接删除的实现

- **行 38 的 `scenarioHasMoyuanSpell` 已删除**（2026-09-07）：由 `lib/shared/chat/spell-text.js` 数据驱动提取替代，聊天桥不再含《墨渊》咒文与结局固定文本。
- 行 11 旧实现（《墨渊》ID 硬编码映射）此前已删除；行 29 的扁平串链已删除。
- 其余每个符号都能在 `lib/` 中找到定义与调用点，删除会破坏现有兜底路径。

### 下一步代办中会被替代（对应 `PLAN.md`「当前待办」）

| 行 | 补丁 | 替代来源 |
|---|---|---|
| 19 | `expireSceneGates` 前缀边界规则 | 待办 #3 场景实体化（sceneId 邻接失效） |
| 21 | `inferSceneTransition` 动作词表 | 待办 #3 场景实体化（移动事件） |
| 23 | `confirmedEndingForBranch` optionLabel 文本匹配、`kp:auto:*` 自动补点、轮次快照 | 待办 #1 多最终分支互斥 + #3 场景实体化 |
| 24 | `applyEventDrivenLanding` 多选项不代选、`applyConfirmedDeepParse` scene 门控、`detectDeadEndScenes` | 待办 #3 场景实体化 + 剧情图引擎 |
| 25 | `runDeepParsePreflight` 标题/关键词包含匹配 | 待办 #3 节点/场景实体 id 化 |
| 27 | `final-branch-extractor` 若/如果句式 + 词表 | 待办 #3 结构化场景解析 |
| 28 | 深度解析 loop 的生成后清洗 + LLM 审校 | 待办 0 规则化审校、分块语义审校、结构化生成 |
| 29 | ~~`repairDeepParseConnectivity` 扁平 order 串链 + hook~~ | 已由 `topology-skeleton.js` 替代（网络拓扑保真） |
| 30 | 结局 entryEvidence 兜底 | 待办 0 两面最终接线强化 |
| 31 | `topology-skeleton.js` 标题编号顺序正则 | 待办 #3 结构分析输出显式 sequence/actOrder |

### 暂时无法替代（保留兜底）

- 行 1–10、12–18、20、22、26。
- 这些补丁在等更底层能力落地：结构化事件全覆盖（行 1/5/9/13/14）、WorldState 单一事实源（行 20）、Checkpoint 引擎 retryPolicy（行 22）、场景实体化（行 19/21 已列入下一步，其余依赖它但还有墨渊特化逻辑需一并迁移）。
- 其中行 10/14 的部分正则兜底会随场景实体化逐步降级为“无结构数据时的最后兜底”，但暂时不能直接删除。

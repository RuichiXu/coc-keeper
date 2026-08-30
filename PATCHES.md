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
| 8 | `lib/core/scenario/contract-draft.js` | 用正则从原文识别仪式/夜晚事件行（仪式/召唤/午夜/入睡…）草拟契约 | 只是草拟，无法理解剧本语义，nightLabel/requires 常为空 | 已实现 `contract-ai.js` LLM 生成契约 JSON（导入时使用）；确定性正则仅作无 LLM 兜底 |
| 5 | `lib/shared/chat/chat-bridge.js` 副作用快照回滚 | 自由动作路径先 `snapshotSideEffects`，守卫发现 clue-leak 再回滚 characters/rollHistory/sanitySettled | 补偿式事务，不是真正的工具执行事务；回滚范围写死在字段列表 | 工具执行引入 staging/commit 事务层，守卫通过后再提交副作用事件 |
| 6 | `lib/shared/tools/rules.js` `findCharacterLoose` | 去掉引号/空白后按姓名匹配角色 | 只修了 coc_sanity_check 一处，其他工具仍可能因引号差异找不到人 | 在 WorldState/character-parser 层统一姓名归一化，所有工具共享 |
| 7 | `lib/shared/chat/chat-bridge.js` 理智门禁清洗 | 把 pendingChecks 里 skill=理智 的历史门禁移入 skipped(reason=sanity-handled-by-tool)，SC 统一由 coc_sanity_check 明骰结算 | 是对历史脏数据的清洗补丁 | 门禁 schema 增加 `kind: sanity`，从源头区分 SC（明骰+损失结算）与普通技能门禁 |
| 9 | `lib/shared/chat/chat-bridge.js` `runNarrationLoop` | 模型连续“只调工具不写正文”时，下一轮禁用工具并注入“请直接输出叙述”；连续两轮空正文则提前结束循环 | 是对 LLM 输出不稳定（tool-only 循环/空响应）的补偿式控制，不能根治上游问题 | Director 引入“工具轮次预算 + 强制叙述轮”的确定性状态机，并对空响应做结构化兜底叙述 |
| 10 | `lib/shared/chat/chat-bridge.js` `autoLandBranches` / `revealKeyPointsForBranchChoices` / 完整咒文正则 / 最终仪式轮指引 / 结局门禁冻结 | 玩家输入或叙述命中分支选项原文即标记 reached+chosen（取最晚出现且无否定语境的选项，并剥掉选项尾部“查看/进入”等动词以匹配“掀开地毯”）；分支选择后按 option.leadsTo 揭示关键点，场景型 leadsTo 需 currentScene 真正切入；完整十二字咒文用正则识别；最终仪式轮意志/SAN 掷骰后注入“按已选结局推进、不得回退”指引；结局关键词出现后废弃全部旧门禁并停止新增团检 | 分支落地本该由 `coc_branch` 工具/PlotGraph 事件完成，正则只能覆盖选项原文直引的窄场景 | 由 Trigger Engine 在“选项被选择”事件上确定性落地分支与关键点，并结构化识别咒文序列与仪式阶段 |
| 11 | ~~`lib/shared/chat/chat-bridge.js` `applyEventDrivenLanding` / `findCheckpointMatch` / `recordPassedCheckpoint`~~ | ~~事件驱动落地：空间型关键点（进入/来到/打开）在场景精确切入时揭示，发现型不因身处场景揭示；检定点通过 → 揭示“日记与手稿/十二字咒文”；SAN 结算（sanitySettled 映射 chk-9）→ 揭示“发现墨渊”并落地掀开地毯分支（chk-7 确认接缝不算目击）；咒文揭示或最终分支已选 → 揭示“克罗斯临终提示”；最终分支已选且咒文已揭示 → 揭示“最终抉择”~~ **已由 B-3 替代：`applyEventDrivenLanding` 改为读 keyPoints/branches 上的结构化 `requires/requiresAnyOf`，不再含《墨渊》ID 硬编码。** | 当前按《墨渊》剧本的关键点/检定点 ID 硬编码映射（ai-kp-4/5/6/7/8、chk-3/5/9/13、ai-br-2），尚未泛化到任意剧本 | 剧本导入时为每个关键点/分支生成结构化前置条件（requiresCheckpoints / requiresKeyPoints / requiresScene / requiresSanityEvent），由 Trigger Engine 统一激活（见行 18） |
| 12 | `lib/shared/chat/chat-bridge.js` `recordResolvedCheck` / `resolvedCheckKey` + 门禁合并过滤 | 成功 `.ra` 后把 skill+目标键写入 `flat.resolvedChecks` 并立即落盘（避免叙事循环重载覆盖）；后续同目标门禁（coc_check 或文本 [团检]）在合并时直接丢弃并注入“该检定已通过，自动忽略”日志 | 是对 LLM 反复要求同一检定这一上游问题的补偿式去重；目标键仍由词表/同义词启发式得到，词表外同义改写仍会漏 | 门禁 schema 增加 `checkpointId/kind`，由 Checkpoint 引擎按检定点 ID 幂等消费；文本门禁只做兜底 |
| 13 | `lib/shared/chat/ending.js` + `chat-bridge.js` 终局短路 | 最终咒文轮（意志/SAN）成功且叙述未出现结局关键词时，程序追加固定结局句、提交 `endingReached/endedAt/当前场景`、补揭示咒文/最终类关键点并清空全部门禁。B-4 已收敛为 `createEndingResolvedEvent` / `applyEndingResolvedEvent` 事件对象 | 仍是聊天桥在最终仪式轮成功后的补偿式兜底；结局句为固定模板，事件由聊天桥创建而非 Rule Engine/PlotGraph 发布 | C 阶段由 Rule Engine/PlotGraph 发布 `EndingResolved` 事件，Narrator 只渲染不决定结局是否发生；结局句由 ClueGraph/剧本结局渲染 |
| 14 | `lib/shared/chat/chat-bridge.js` `autoLandBranches` 玩家输入优先 / `spellShown` 咒文展示 / `sanitizeSanityLine` SAN 玩家可见清洗 | 分支落地先搜玩家输入、命中即停，不再被叙述末尾菜单词（撬锁工具）覆盖；咒文关键点揭示或最终分支已选后，程序固定展示十二字咒文原文；`coc_sanity_check` 结算行只写损失结果，`knowledge-layers` 对 player 层隐藏理智骰 | 仍是对 LLM 文本行为的补偿：玩家意图解析与线索展示本应由结构化事件/ClueGraph 完成；SAN 行清洗是展示层规则 | 玩家动作/选择由 `coc_branch` 事件驱动；线索展示由 ClueGraph `ClueRevealed` 事件渲染；SAN 展示由 Knowledge 层统一按 roll.kind/skill 过滤 |
| 15 | `lib/shared/chat/chat-bridge.js` 咒文解读兜底 / ~~`applyEventDrivenLanding` 进门证据~~ / `findEarlyDiaryLeak` / `sanitizeGateAction` / `ITEM_JUNK_EXTRA` | 智力在解谜语境下成功且“日记与手稿”已揭示时，程序记录咒文关键点结构化前置检定点（B-3 后不再硬编码 chk-13/ai-kp-4）；~~“进入书房”在场景精确切入基础上额外要求文本出现实际进门短语~~（B-3 后由 `entryEvidence` 生成器统一处理）；日记核心句在 ai-kp-4 揭示前由守卫拦截；门禁动作清洗残缺提示尾；物品清理增补“隔层/两样/一并”等垃圾项 | 咒文解读兜底、日记拦截、门禁动作清洗、物品清理仍为《墨渊》特化或 LLM 文本行为的补偿式兜底 | 咒文由 ClueGraph 的 `SpellDecoded` 事件驱动；关键点前置条件结构化（见行 18）；门禁动作由 `coc_check` schema 限制为短选项原文；物品由实体注册表白名单管理 |
| 16 | `lib/shared/chat/check-gates.js` `gateTargetKey` / `scoreTargetMatch` / `mergeCheckGates` 语义合并 / 自由动作不清空旧门禁 | 门禁动作经词表+同义词归一成目标键；同一目标换措辞只保留一条门禁并更新动作文本与难度；玩家输入用目标键匹配旧门禁，避免“同目标改写误删唯一门禁”；未命中门禁的自由动作不再清空 pendingChecks | 词表/同义词是启发式，目标键仍可能漏配或误并；旧门禁长期保留需要后续“场景失效/明确跳过”的清理规则 | 门禁 schema 增加 `checkpointId/target`，由 Checkpoint 引擎按检定点 ID 消费；目标失效由 Scene/Plot 事件自动清理 |
| 17 | `lib/shared/chat/chat-bridge.js` 检定点消费 / 失败消费 / `lib/shared/chat/gate-lifecycle.js` `expireSceneGates` | `.ra` 前先匹配检定点并绑定到 selectedGate，成功按 checkpointId 记录 passedCheckpointIds；门禁短路过滤同时看 resolvedChecks 与 passedCheckpointIds；失败记 gate-failed trace；`coc_check` 创建门禁时已直接写入 checkpointId/target；`coc_scene` 场景切换与每轮聊天开始时按前缀规则清理过期门禁 | 文本 [团检] 门禁仍依赖 `findCheckpointMatch` 的启发式匹配；前缀规则无法覆盖所有场景命名（见行 19） | 门禁创建时由场景事实/检定点直接写入 checkpointId（coc_check 已完成）；目标失效由 Scene/Plot 事件精确清理 |
| 18 | `lib/shared/chat/story-prereqs.js` `draftKeyPointPrerequisites` / `draftBranchPrerequisites` / `draftEndingKeyPointPrerequisites` / `entryEvidenceVariants` | 从关键点标题词 + 检定点 keys/trigger + 场景/楼层兼容 + 难度排序，草拟 `requires/requiresAnyOf/autoChooseLabel`；进门证据由动词表（进入/来到/打开…）扩展同义短语 | 仍是规则式草拟，无法理解剧本语义；标题词表与 keys 匹配会漏配/误配（如非《墨渊》剧本） | D 阶段 LLM 深度解析生成结构化前置条件，KP 校对确认后写入；规则草拟仅作无 LLM 兜底 |
| 19 | `lib/shared/chat/gate-lifecycle.js` `expireSceneGates` 前缀边界规则 | 当前场景以门禁 scene 为前缀且剩余部分不是“门外/门口/外部/外”时保留，否则失效；`coc_scene` 切换时立即执行 | 仍是场景命名启发式，无法覆盖“三层书房门外”之外的同形场景（如“三层书房外间”） | 场景实体/SceneGraph 建立后按 sceneId 邻接关系精确失效；门禁绑定 sceneId 而非场景名 |

## 使用约定

1. 新增工具/守卫时，如果实现依赖“关键词/正则/部分词语组合”，先问一句：
   **“这个行为能否由结构化状态或事件确定性判定？”** 能就不要加正则。
2. 必须新增补丁时，在本表登记，并写清替换方向。
3. 每次重构命中上表某项，删除或简化该补丁后，更新对应行状态并补回归测试。

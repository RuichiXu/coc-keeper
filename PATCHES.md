# 开发补丁记录（Known Patches / Heuristics）

> 本文件记录当前为了快速止血而引入的**通用性较差的规则/方法**。
> 这些实现依赖部分词语组合、启发式匹配或补偿性回滚，后续会被
> 结构化实现替换。修改前请先读本表，避免在旧补丁上继续叠加。

| # | 位置 | 补丁内容 | 为什么是补丁 | 后续替换方向 |
|---|---|---|---|---|
| 1 | `lib/shared/chat/chat-bridge.js` `autoTrackInventory` / `cleanupJunkInventory` | 用 `ITEM_ACQUIRE_RE / ITEM_BA_RE / ITEM_STATE_CARRY_RE / ITEM_CONTAINED_RE` 等正则从叙述中提取物品入栏；`canonicalItemsFromEntities` 把候选归一到剧本实体物品名（含“稿纸/纸页→四张手稿”“日记→克罗斯的日记”）；清理物品栏时先做实体归一，避免实体名里的合法数量词（“四张手稿”）被旧垃圾规则误删 | 自然语言持有表达无穷尽，正则只能覆盖部分句式，仍有漏/误 | 物品获取/交付/放回应由验证后的结构化事件提交（coc_pc inventoryAdd/Remove 或 item-location event），提取器只做兜底 |
| 2 | `lib/shared/chat/chat-bridge.js` `revealKeyPointsFromNarration` | 标题去动作前缀/事件后缀 + “A与B”拆分 + 否定语境检测（“没能进入书房”不揭示）；过短剥离词（<4 字）不再命中，空间型标题（进入/来到/打开）交给事件驱动 | 标题包含关系不是真正的剧情触发判定，仍可能提前揭示 | 由 Trigger Engine 依据已获得线索/事件激活关键点（已由 `applyEventDrivenLanding` 部分替代） |
| 3 | `lib/shared/tools/rules.js` `canonicalSanityEventId` | 用 SAN 检定点 keys 与 description 的重叠打分映射规范幂等键 | 依赖描述文本碰巧包含“巨眼/漩涡/墨渊”等词 | 剧本导入时生成稳定 phenomenonId 并写入检定点；工具直接引用，不再靠描述匹配 |
| 4 | `lib/shared/chat/narration-guard.js` `findCheckpointClueLeak` | 当前场景检定点 clueWords 出现在叙述中就判泄露 | 词面匹配无法理解语义，存在误报/漏报 | 已部分落地为 `scenario-contract-validator.js` 的 clueGates（契约驱动）；旧 guard 待契约覆盖全量后删除 |
| 8 | `lib/core/scenario/contract-draft.js` | 用正则从原文识别仪式/夜晚事件行（仪式/召唤/午夜/入睡…）草拟契约 | 只是草拟，无法理解剧本语义，nightLabel/requires 常为空 | 已实现 `contract-ai.js` LLM 生成契约 JSON（导入时使用）；确定性正则仅作无 LLM 兜底 |
| 5 | `lib/shared/chat/chat-bridge.js` 副作用快照回滚 | 自由动作路径先 `snapshotSideEffects`，守卫发现 clue-leak 再回滚 characters/rollHistory/sanitySettled | 补偿式事务，不是真正的工具执行事务；回滚范围写死在字段列表 | 工具执行引入 staging/commit 事务层，守卫通过后再提交副作用事件 |
| 6 | `lib/shared/tools/rules.js` `findCharacterLoose` | 去掉引号/空白后按姓名匹配角色 | 只修了 coc_sanity_check 一处，其他工具仍可能因引号差异找不到人 | 在 WorldState/character-parser 层统一姓名归一化，所有工具共享 |
| 7 | `lib/shared/chat/chat-bridge.js` 理智门禁清洗 | 把 pendingChecks 里 skill=理智 的历史门禁移入 skipped(reason=sanity-handled-by-tool)，SC 统一由 coc_sanity_check 明骰结算 | 是对历史脏数据的清洗补丁 | 门禁 schema 增加 `kind: sanity`，从源头区分 SC（明骰+损失结算）与普通技能门禁 |
| 9 | `lib/shared/chat/chat-bridge.js` `runNarrationLoop` | 模型连续“只调工具不写正文”时，下一轮禁用工具并注入“请直接输出叙述”；连续两轮空正文则提前结束循环 | 是对 LLM 输出不稳定（tool-only 循环/空响应）的补偿式控制，不能根治上游问题 | Director 引入“工具轮次预算 + 强制叙述轮”的确定性状态机，并对空响应做结构化兜底叙述 |
| 10 | `lib/shared/chat/chat-bridge.js` `autoLandBranches` / `revealKeyPointsForBranchChoices` / 完整咒文正则 / 最终仪式轮指引 / 结局门禁冻结 | 玩家输入或叙述命中分支选项原文即标记 reached+chosen（取最晚出现且无否定语境的选项，并剥掉选项尾部“查看/进入”等动词以匹配“掀开地毯”）；分支选择后按 option.leadsTo 揭示关键点，场景型 leadsTo 需 currentScene 真正切入；完整十二字咒文用正则识别；最终仪式轮意志/SAN 掷骰后注入“按已选结局推进、不得回退”指引；结局关键词出现后废弃全部旧门禁并停止新增团检 | 分支落地本该由 `coc_branch` 工具/PlotGraph 事件完成，正则只能覆盖选项原文直引的窄场景 | 由 Trigger Engine 在“选项被选择”事件上确定性落地分支与关键点，并结构化识别咒文序列与仪式阶段 |
| 11 | `lib/shared/chat/chat-bridge.js` `applyEventDrivenLanding` / `findCheckpointMatch` / `recordPassedCheckpoint` | 事件驱动落地：场景精确切入 → 揭示场景关键点；检定点通过（passedCheckpointIds）→ 揭示“日记与手稿/十二字咒文”；SAN 结算（sanitySettled 映射 chk-8）→ 揭示“发现墨渊”并落地掀开地毯分支；最终分支已选且咒文已揭示 → 揭示“最终抉择” | 当前按《墨渊》剧本的关键点/检定点 ID 硬编码映射（ai-kp-4/5/7/8、chk-3/5/7/8/13、ai-br-2），尚未泛化到任意剧本 | 剧本导入时为每个关键点/分支生成结构化前置条件（requiresCheckpoints / requiresKeyPoints / requiresScene / requiresSanityEvent），由 Trigger Engine 统一激活 |

## 使用约定

1. 新增工具/守卫时，如果实现依赖“关键词/正则/部分词语组合”，先问一句：
   **“这个行为能否由结构化状态或事件确定性判定？”** 能就不要加正则。
2. 必须新增补丁时，在本表登记，并写清替换方向。
3. 每次重构命中上表某项，删除或简化该补丁后，更新对应行状态并补回归测试。

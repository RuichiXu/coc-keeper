# 开发补丁记录（Known Patches / Heuristics）

> 本文件记录当前为了快速止血而引入的**通用性较差的规则/方法**。
> 这些实现依赖部分词语组合、启发式匹配或补偿性回滚，后续会被
> 结构化实现替换。修改前请先读本表，避免在旧补丁上继续叠加。

| # | 位置 | 补丁内容 | 为什么是补丁 | 后续替换方向 |
|---|---|---|---|---|
| 1 | `lib/shared/chat/chat-bridge.js` `autoTrackInventory` | 用 `ITEM_ACQUIRE_RE / ITEM_BA_RE / ITEM_STATE_CARRY_RE / ITEM_CONTAINED_RE` 等正则从叙述中提取物品入栏；`canonicalItemFromEntities` 把候选归一到剧本实体物品名，未命中实体的候选走严格过滤 | 自然语言持有表达无穷尽，正则只能覆盖部分句式，仍有漏/误 | 物品获取/交付/放回应由验证后的结构化事件提交（coc_pc inventoryAdd/Remove 或 item-location event），提取器只做兜底 |
| 2 | `lib/shared/chat/chat-bridge.js` `revealKeyPointsFromNarration` | 标题去动作前缀/事件后缀 + “A与B”拆分 + 4字以上标题 CJK 双字组兜底命中即揭示 | 标题包含关系不是真正的剧情触发判定，可能提前揭示 | 由 Trigger Engine 依据已获得线索/事件激活关键点 |
| 3 | `lib/shared/tools/rules.js` `canonicalSanityEventId` | 用 SAN 检定点 keys 与 description 的重叠打分映射规范幂等键 | 依赖描述文本碰巧包含“巨眼/漩涡/墨渊”等词 | 剧本导入时生成稳定 phenomenonId 并写入检定点；工具直接引用，不再靠描述匹配 |
| 4 | `lib/shared/chat/narration-guard.js` `findCheckpointClueLeak` | 当前场景检定点 clueWords 出现在叙述中就判泄露 | 词面匹配无法理解语义，存在误报/漏报 | 已部分落地为 `scenario-contract-validator.js` 的 clueGates（契约驱动）；旧 guard 待契约覆盖全量后删除 |
| 8 | `lib/core/scenario/contract-draft.js` | 用正则从原文识别仪式/夜晚事件行（仪式/召唤/午夜/入睡…）草拟契约 | 只是草拟，无法理解剧本语义，nightLabel/requires 常为空 | 已实现 `contract-ai.js` LLM 生成契约 JSON（导入时使用）；确定性正则仅作无 LLM 兜底 |
| 5 | `lib/shared/chat/chat-bridge.js` 副作用快照回滚 | 自由动作路径先 `snapshotSideEffects`，守卫发现 clue-leak 再回滚 characters/rollHistory/sanitySettled | 补偿式事务，不是真正的工具执行事务；回滚范围写死在字段列表 | 工具执行引入 staging/commit 事务层，守卫通过后再提交副作用事件 |
| 6 | `lib/shared/tools/rules.js` `findCharacterLoose` | 去掉引号/空白后按姓名匹配角色 | 只修了 coc_sanity_check 一处，其他工具仍可能因引号差异找不到人 | 在 WorldState/character-parser 层统一姓名归一化，所有工具共享 |
| 7 | `lib/shared/chat/chat-bridge.js` 理智门禁清洗 | 把 pendingChecks 里 skill=理智 的历史门禁移入 skipped(reason=sanity-secret) | 是对历史脏数据的清洗补丁 | 门禁 schema 增加 `kind: secret`，从源头不允许理智门禁入列 |
| 9 | `lib/shared/chat/chat-bridge.js` `runNarrationLoop` | 模型连续“只调工具不写正文”时，下一轮禁用工具并注入“请直接输出叙述”；连续两轮空正文则提前结束循环 | 是对 LLM 输出不稳定（tool-only 循环/空响应）的补偿式控制，不能根治上游问题 | Director 引入“工具轮次预算 + 强制叙述轮”的确定性状态机，并对空响应做结构化兜底叙述 |
| 10 | `lib/shared/chat/chat-bridge.js` `autoLandBranches` / `revealKeyPointsForBranchChoices` / 完整咒文正则 | 玩家输入或叙述命中分支选项原文即标记 reached+chosen；选择最终分支后揭示同结局关键点；完整十二字咒文用正则识别并提示 LLM 不要拆半句 | 分支落地本该由 `coc_branch` 工具/PlotGraph 事件完成，正则只能覆盖选项原文直引的窄场景 | 由 Trigger Engine 在“选项被选择”事件上确定性落地分支与关键点，并结构化识别咒文序列 |

## 使用约定

1. 新增工具/守卫时，如果实现依赖“关键词/正则/部分词语组合”，先问一句：
   **“这个行为能否由结构化状态或事件确定性判定？”** 能就不要加正则。
2. 必须新增补丁时，在本表登记，并写清替换方向。
3. 每次重构命中上表某项，删除或简化该补丁后，更新对应行状态并补回归测试。

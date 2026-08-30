# dsh-coc-keeper 开发计划

> 当前版本：v0.3.0-dev
> 最后更新：2026-08-28（A/B 完成，C 计划修订版）

---

## 当前工作主线（A → B → C → D）

- **A 测试工具** ✅ 完成（commit `0de54d3`）：故事预设、调试跳转、夹具导出、replay 回放。
- **B 补丁替换** ✅ 完成（commits `9d90e21` / `1f72c4f` / `7c73860` / `4abafd5`）：
  - 门禁语义目标键（同目标换措辞去重/匹配）
  - 门禁生命周期闭环（检定点消费、失败消费、场景失效清理）
  - 门禁创建时直接绑定 `checkpointId/target`
  - 结构化剧情前置条件 `requires/requiresAnyOf`（替换《墨渊》硬编码映射）
  - 结局事件化 `EndingResolved`
- **C 游戏引擎增强** ⏳ 下一步（计划见下）
- **D LLM 深度剧本解析** 待 C 完成后启动

---

## C 阶段目标（修订版）

> 核心思想：**程序管“什么是事实、什么已经发生、哪些路是通的、跳线要付出什么代价”；AI 管“怎么把这些演出来、怎么接玩家的怪招”。**
>
> 不做成传统 RPG 的线性任务机。跑团是语言类游戏，随机应变是精华；剧情推进采用网状结构（参考博德之门 3）：
> - 不设“当前唯一剧情线”，每轮根据世界事实重新计算**可达路线集合**；
> - 玩家可以从一条支线跳到另一条支线（新线索、直觉、好奇都可以触发），不硬锁；
> - 跳线有自然代价：时间消耗、缺少旧线获得的线索/物品/NPC 态度导致新线选项锁死或检定更难、旧线行为留下的世界事实影响新线与结局。

### 需要解决的现状问题

1. **两本账**：WorldState（世界状态）本该是唯一事实来源，但聊天桥仍直接改 `flat` 散装字段（门禁、关键点、分支、结局标记等）。
2. **流水账不规范**：事件以自由格式 `recordTrace` 记录，无法按类型查询、无法串起因果链。
3. **剧情图是摆设**：`PlotGraph` / `ClueGraph` / `TriggerEngine` / 结局模型都已存在，但跑团运行时基本没接入；分支落地和关键点揭示仍大量依赖 AI 叙述关键词 + 补丁。
4. **规则不完整**：SAN 疯狂、战斗重伤/死亡、技能成长等规则没有完全走 Rule Engine。

---

## C 阶段实施步骤

### C-1 统一账本 + 流水账（地基）

**目标**：所有重要状态变化都记成固定格式的事件；`flat` 变成 WorldState 的投影，不再被直接改。

**做法**
1. 在 `lib/core/events.js` 定义事件目录（类型常量 + 必填字段校验），至少覆盖：
   `RollPerformed / SanitySettled / CheckpointPassed / GateCreated / GateResolved / GateFailed / GateExpired / SceneChanged / TimeAdvanced / KeyPointRevealed / BranchLanded / ItemAcquired / SpellShown / NightEventFired / EndingResolved`。
2. 新增 `EventLog`：每条事件自动分配 `seq/id/at`，支持按类型查询、按 `correlationId` 串因果链（如一次 `.ra` → 通过 → 检定点 → 关键点揭示）。
3. 保留 `recordTrace` 作为兼容层（旧 `core.trace` 结构不破坏），内部从事件派生。
4. 把聊天桥直接改的剧情字段收进 WorldState：`pendingChecks / skippedChecks / resolvedChecks / passedCheckpointIds / sanitySettled / keyPoints / branches / spellShown / endingReached / endedAt / firedNightEventIds`。扩展 `projectToFlat` / `syncFromFlat`，旧存档自动迁移。
5. 聊天桥副作用改为：构造事件 → `session.applyEvent` → 投影到 flat；不再直接改 flat。

**验收**
- `lib/core/` 与 `lib/shared/` 保持 DSH-free。
- 新增 EventLog/迁移单测与集成测试。
- 全量 `node tests/run-tests.mjs` + `npm run ui-check` 通过。

---

### C-2 规则补全

**目标**：规则类结果统一由 Rule Engine 出，聊天桥只负责叙述。

**做法**
1. `lib/core/rules/sanity.js` 补：临时性疯狂、不定性疯狂、克苏鲁神话技能、理智恢复；`coc_sanity_check` 只发指令、Rule Engine 出事件。
2. `lib/core/rules/combat.js` 补：回合顺序（DEX）、HP≤0 的重伤/濒死/死亡状态；`coc_combat_resolve` 消费同一规则。
3. 技能成长规则与 `rules-content.json` 同步核对。
4. 所有规则结果进 C-1 的事件目录。

**验收**
- sanity/combat 单测扩展；规则工具集成测试不回归。
- 规则查询结果与规则书文本一致。

---

### C-3 多线剧情图 + 世界事实驱动（核心）

**目标**：把关键点/分支/结局接成一张真在用的网；程序算“哪条路通、走每条路的条件与影响”，AI 决定怎么演。

**做法**
1. 剧本导入时，把关键点/分支/结局正式建成 PlotGraph 节点与边；边带：
   - `requires`：进入条件（线索、物品、场景、NPC 态度、时间、已揭示关键点、已过检定点）；
   - `consequences`：进入后改变的世界事实（flags、clue 可见性、entity 态度、导向的结局）。
2. 把“世界事实”统一成第一等查询对象：`world.flags`（已有）+ ClueGraph 可见性（已有）+ 实体态度（已有 `entity.state`）+ 时间（Game Clock）。
3. 每轮结束后重新计算**可达路线集合**（frontier），注入 KP 提示词和调试面板；AI 看到的是“当前有几条路、各自缺什么、选哪条可能导向什么”，而不是“下一步任务”。
4. 分支落地/关键点揭示优先由事件驱动（`BranchLanded` / `KeyPointRevealed`），现有 `autoLandBranches` / `revealKeyPointsForBranchChoices` 里的选项原文正则降级为“无结构数据时的兜底”。
5. **跳线**：不设唯一剧情线。玩家新获得的线索/物品/态度变化，会让另一条线的进入条件被满足，这就是跳线。旧线推进留在世界事实里，自然影响新线选项与结局。
6. **玩家即兴解法**：如果玩家用剧本外的方式达成某个事实（如爬窗进入书房），只记录事实（场景=书房），后续依赖“人在书房”的节点自动解锁；不需要为每种解法预建节点。
7. `EndingResolved` 事件改由 PlotGraph 结局节点完成时发布（B-4 已把事件对象备好）。

**验收**
- PlotGraph 单测扩展：多线可达、跳线后旧线事实影响新线、结局 requirements/blockers。
- replay 夹具（final-rite）证明旧流程不回归。
- 删除正则主导路径后，旧 `state-autolanding` 用例迁移为事件驱动用例。

---

### C-4 统一触发入口 + 关键节点 E2E

**做法**
1. 把 B-3 的 `evaluatePrerequisites` 并入 `trigger-engine.js`：触发器类型增加 `keypoint-prereq / branch-prereq / ending`。
2. `applyEventDrivenLanding` 变成 TriggerEngine 的薄封装；`story-prereqs.js` 只负责草拟，不负责运行时判定。
3. 清点 PATCHES：C 完成后行 10/14 应标替代；行 2 叙述兜底保留但明确降级；行 13 在 PlotGraph 发布 `EndingResolved` 后关闭。
4. **E2E 关键节点**：跑《墨渊》全链路（复用 presets/replay），验证玩家视图/KP 面板/门禁/跳线/终局。

**E2E 约定**
- E2E 前必须重启 dsh web，并向用户报告新 PID。
- E2E 只在此关键节点跑，中途不反复跑。

---

## D 阶段（C 完成后）：LLM 深度剧本解析

- 剧本导入时用 LLM 直接生成：线索图（含获取方式/替代路径）、多线剧情图（节点/边/进入条件/影响）、结局 requirements/blockers、夜晚事件、NPC 知识边界。
- 输出进入 KP 校对面板，确认后才生效。
- 确定性规则草拟（现有 `compileByPattern` / `draftScenarioContract` / `draftStoryPrerequisites`）保留为无 LLM 兜底。
- 替换 PATCHES 行 18 的规则式前置条件草拟。

---

## 开发约定（每次动手前必读）

1. 读 `AGENTS.md`（开发约定）与 `TESTING.md`（测试要求）。
2. `lib/shared/` 与 `lib/core/` 必须 DSH-free。
3. 不要改变现有 `/coc-api` 接口与 JSON 结构；调试面板只做增量。
4. 启发式补丁必须登记 `PATCHES.md`，并写明替换方向。
5. 每步完成：`node tests/run-tests.mjs` + `npm run ui-check` 通过后提交；不提交 `node_modules` / 数据目录 / `artifacts/`。

---

## 历史记录（Phase 1 已完成）

- Step 0-12 已完成：Rule Engine 地基、入口切换、持久化迁移、工具迁移、/coc-api 与聊天桥迁移、Trigger Engine/ContextBuilder/Knowledge 分层、Director/Narrator、Narrative Recovery/Ending Reachability/Game Clock、资产库与场次分离、人物卡解析增强、Playwright UI 冒烟、ScenarioContract 一/二阶段。
- 详细过程见 `DEVLOG.md`。

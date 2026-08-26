# dsh-coc-keeper 开发计划

> 当前版本：v0.3.0-dev
> 最后更新：2026-08-19

---

## 项目目标

实现一个能够长期运行 CoC 7版跑团的 AI KP 系统。

核心原则：
- **LLM 负责理解、规划、模糊判断和叙事。**
- **程序负责规则、状态、事件、时间和数据一致性。**
- **自然语言上下文不能成为游戏世界的唯一事实来源。**

---

## 当前阶段：Phase 1（模块化重构 + 测试体系建设）

### 已完成 ✅

| 事项 | 状态 |
|---|---|
| 架构分析与重构计划 | ✅ 完成 |
| 目录结构建立（`lib/core/` + `lib/adapter/`） | ✅ 完成 |
| Core 接口定义（`interfaces.js`） | ✅ 完成 |
| EventBus 实现（`lib/core/events.js`） | ✅ 完成 |
| 骰点引擎提取（`lib/core/dice.js`） | ✅ 完成 |
| DOCX/DOC 提取提取（`lib/core/docx-extract.js`） | ✅ 完成 |
| 人物解析提取（`lib/core/character-parser.js`） | ✅ 完成 |
| 游戏时钟提取（`lib/core/clock.js`） | ✅ 完成 |
| WorldState 模块（`lib/core/state/`） | ✅ 完成 |
| Rule Engine 模块（`lib/core/rules/` - sanity/combat/skill-growth） | ✅ 完成 |
| Scenario Compiler（`lib/core/scenario/` - model + compiler） | ✅ 完成 |
| Plot Graph（`lib/core/plot/`） | ✅ 完成 |
| Clue Graph（`lib/core/clue/`） | ✅ 完成 |
| 新版 Adapter 骨架（`lib/adapter/plugin.js` + coc_roll 接入 EventBus） | ✅ 完成 |
| AGENTS.md 开发约定 | ✅ 完成 |
| TESTING.md 测试规范 | ✅ 完成 |
| 旧代码兼容性验证（`tests/selftest.mjs` 全部通过） | ✅ 完成 |

### Step 1 已完成 ✅（入口切换 + GameSession 容器）

| 事项 | 状态 |
|---|---|
| `core/session/game-session.js` 容器（EventBus + WorldState + PlotGraph + ClueGraph + Trace） | ✅ |
| `WorldState.hydrate()` 原地同步方法 | ✅ |
| 旧入口备份为 `lib/legacy-index.js`；`lib/index.js` 改为 re-export 新 `adapter/plugin.js` | ✅ |
| 新 `adapter/plugin.js`：包装 ctx.tools.register，旧工具执行后映射 GameEvent → EventBus + WorldState 镜像 | ✅ |
| `tests/unit/game-session.test.mjs`（6 用例） | ✅ |
| 全套测试 19 个文件通过；`selftest.mjs` 通过（工具 17 个全部注册） | ✅ |

### Step 2 已完成 ✅（持久化迁移 + 剧本初始化）

| 事项 | 状态 |
|---|---|
| `core/session/persistence.js`：Persistence 接口 + `JsonFilePersistence` 实现 | ✅ |
| 新存档格式：旧 flat JSON 扩展 `core` 字段（version/sceneMode/world/plot/clues/trace） | ✅ |
| `GameSession.importScenarioModel()`：ScenarioModel → PlotGraph + ClueGraph（自动激活无前置条件节点） | ✅ |
| `GameSession.hydrateCore()`：从 core 字段恢复 plot/clues/trace/sceneMode | ✅ |
| `WorldState.hydrate()` 数组字段浅拷贝修复（避免与旧 flat 共享引用导致 rollHistory 重复） | ✅ |
| `plugin.js`：工具执行后 reload flat → sync WorldState → 剧本导入时 compileByPattern 重建 Plot/Clue → 发布事件 → 保存 core 字段 | ✅ |
| 新增 `tests/unit/persistence.test.mjs`、`tests/integration/scenario-init.test.mjs` | ✅ |
| 全套测试 21 个文件通过；`selftest.mjs` 通过；验证 core 字段正确持久化 | ✅ |

### Step 3 已完成 ✅（工具迁移到 adapter/tools/*）

| 事项 | 状态 |
|---|---|
| `lib/adapter/tools/` 目录：helpers / roll / rules / state-tools / plot-tools / import / index | ✅ |
| 模型可见的 17 个工具全部来自新 adapter（legacy 工具不再注册到模型上下文） | ✅ |
| 规则类工具（roll/roll_secret/sanity/combat/skill_growth）走 Core Rule Engine + 事件 | ✅ |
| 状态类工具（scene/kp/pc/task/entity/character）直接操作 WorldState，flat 为兼容投影 | ✅ |
| 剧情类工具（branch/remind/status）操作 flat 兼容字段（待迁入 PlotGraph/Trigger） | ✅ |
| 导入类工具（import/read/query_rule）委托旧实现执行 + Core 收尾（同步/保存 core/剧本重建 Plot） | ✅ |
| legacy 只负责 /coc-api + 聊天桥；旧工具 defs 收集到 legacyDefs 供委托 | ✅ |
| 新增 `tests/integration/adapter-tools.test.mjs`（3 用例）；全套 22 测试通过；selftest 通过 | ✅ |

### Step 4 已完成 ✅（/coc-api 与聊天桥迁移）

| 事项 | 状态 |
|---|---|
| `lib/adapter/api/coc-api.js`：/coc-api 路由迁移（契约不变，内部用 adapter 新工具） | ✅ |
| `lib/adapter/chat/chat-bridge.js`：面板聊天桥迁移（LLM + coc 新工具循环，每轮同步 GameSession + core 持久化） | ✅ |
| legacy-index.js 停用内部 /coc-api 注册（handleCocApi/runKpTurn 保留作参考/回退） | ✅ |
| plugin.js 收集 adapter 工具 defs（Cordis 安全：ctx.extend + Object.create）供 API/聊天桥使用 | ✅ |
| 新增 `tests/integration/coc-api.test.mjs`（3 用例，真实 Cordis Context + webServer mock） | ✅ |
| 测试 runner 修复 async 测试假阳性（`await test.fn()`），全部测试文件改为 `await run()` | ✅ |
| 修复 coc_sanity_check 返回值缺 `passed` 字段 | ✅ |
| 全套测试 23 文件通过；selftest 通过；dsh web 启动验证通过；/coc-api status/roll 实测正常 | ✅ |

### Step 5 已完成 ✅（Trigger Engine + ContextBuilder + Knowledge 分层）

| 事项 | 状态 |
|---|---|
| `lib/core/knowledge/knowledge-layers.js`：kp-full / player / public 三层过滤（骰点/关键点/分支/提醒/实体） | ✅ |
| `lib/core/context/context-builder.js`：KP 系统提示、对话消息、面板摘要统一构建 | ✅ |
| `lib/core/trigger/trigger-engine.js`：scene / branch-pending / keypoint-pending / state 条件触发器 + TriggerEngine 类 | ✅ |
| 聊天桥改用 Core ContextBuilder（删除 adapter 内重复 buildKpSystemPrompt/buildLoopMessages） | ✅ |
| plot-tools 的 coc_status 渲染改用 Core renderStatusText | ✅ |
| 新增单测：knowledge-layers / context-builder / trigger-engine（共 17 用例） | ✅ |
| 全套测试 26 文件通过；selftest 通过；dsh web 启动验证通过 | ✅ |

### Step 6 已完成 ✅（Director / Narrator + 规则域 Skills）

| 事项 | 状态 |
|---|---|
| `lib/core/director/director.js`：LLM 输出块解析、下一步决策、工具结果消息组装 | ✅ |
| `lib/core/narrator/narrator.js`：叙述兜底、截断、日志条目构造 | ✅ |
| 聊天桥 runKpTurn 改用 Director/Narrator 纯函数（parseAssistantBlocks/decideNext/buildToolResultMessages/formatNarration） | ✅ |
| `lib/adapter/skills/rule-skills.js`：注册 4 个规则域 Skills（dice/combat/sanity/growth） | ✅ |
| inject 增加 `skills` 依赖；无 skills 服务时防御性跳过 | ✅ |
| 新增 `tests/unit/director-narrator.test.mjs`（11 用例）；Cordis 回归测试验证 4 个 Skills 注册 | ✅ |
| 全套测试 27 文件通过；selftest 通过；dsh web 启动验证通过（skills 注册成功） | ✅ |

### Step 7 已完成 ✅（Narrative Recovery + Ending Reachability + Game Clock）

| 事项 | 状态 |
|---|---|
| `lib/core/clock-scheduler.js`：定时事件评估（isTimeReached/evaluateScheduledEvents/fireScheduledEvent） | ✅ |
| `lib/core/plot/reachability.js`：结局可达性分析（BFS 可达集 + 叶子结局候选 + 摘要） | ✅ |
| `lib/core/recovery/recovery.js`：busy 卡死检测、恢复提示、叙述丢失检测、trace 摘要 | ✅ |
| WorldState 增加 `scheduledEvents` 字段（hydrate/toJSON/投影） | ✅ |
| coc_scene 时间推进后评估定时事件并记录 trace | ✅ |
| 聊天桥接入 busy 恢复（stale > 5 分钟自动恢复）与结局可达性提示 | ✅ |
| ContextBuilder 系统提示支持 `endingStatus` 行 | ✅ |
| 新增单测：clock-scheduler / reachability / recovery（共 14 用例） | ✅ |
| 全套测试 30 文件通过；selftest 通过；dsh web 启动验证通过 | ✅ |

### 全部 Step 完成 ✅

| Step | 内容 |
|---|---|
| 0 | Rule Engine 地基修正 + 测试 |
| 1 | 入口切换 + GameSession 容器 |
| 2 | 旧 flat state → WorldState 持久化迁移 |
| 3 | 17 个工具迁移到 adapter/tools/* |
| 4 | /coc-api 与聊天桥迁移 |
| 5 | Trigger Engine + ContextBuilder + Knowledge 分层 |
| 6 | Director / Narrator + 规则域 Skills |
| 7 | Narrative Recovery + Ending Reachability + Game Clock 定时事件 |
| 8 | 全局资产库 + 场次分离 + 前端拆分（Player / Keeper Console） |

### Step 8 已完成 ✅（全局资产库 + 场次分离 + 前端拆分）

| 事项 | 状态 |
|---|---|
| `lib/core/assets/asset-store.js`：scenarios/investigators/entities 全局资产库（模板） | ✅ |
| `GameSession.scenarioId`：场次引用全局剧本资产 | ✅ |
| 数据布局迁移：`dataDir/games/<id>.json` + `dataDir/assets/**`，旧根目录文件自动迁移 | ✅ |
| 删除剧本级联删除引用场次（`POST /coc-api/scenario-delete`） | ✅ |
| 场次列表/创建/删除（`GET /coc-api/games`、`game-create`、`game-delete`） | ✅ |
| 资产实例化 copy-on-write（`POST /coc-api/assets` instantiate） | ✅ |
| 玩家视图（`GET /coc-api/player-view`，按 player 知识层过滤） | ✅ |
| KP 自然语言指令（`POST /coc-api/kp-command`：预览 → 确认执行） | ✅ |
| 规则开关 `Config.autoImportBuiltinRules`（默认 true） | ✅ |
| 前端拆分：Player Panel（用户视图）+ Keeper Console（主持/剧情/调试 3 tab） | ✅ |
| 新增集成测试：games/scenario-delete/assets instantiate；asset-store 单测 | ✅ |
| 全套测试 31 文件通过；selftest 通过；dsh web 启动验证通过（迁移成功） | ✅ |

### Step 9 已完成 ✅（人物卡解析增强 + 人物展示 + 玩家视图扩展 + 场次向导）

| 事项 | 状态 |
|---|---|
| 人物卡解析增强：档案式 docx（姓名/职业/属性标签行/技能三列/技能名+数值行）+ LLM 兜底 | ✅ |
| 调试页「人物」子页：HP/SAN/MP/LUCK 快速更新、属性/物品展示 | ✅ |
| 玩家视图扩展：调查员卡详情、已知线索、最近 20 条动态 + 加载更多 | ✅ |
| 场次创建向导：选剧本（含人数建议）→ 选调查员（玩家 + AI 调查员）→ 确认 → LLM 开场白 | ✅ |
| 内置 3 张 AI 调查员卡（艾伦·卡特/格蕾丝·周/汤姆·米勒，aiControlled） | ✅ |
| 后端 `POST /coc-api/game-setup`；assets list 附带剧本建议人数 | ✅ |
| 导入成功反馈保留（不再被调试页重建清掉） | ✅ |

### Step 10 已完成 ✅（导入/向导/资产库修复 + Playwright UI 冒烟检查）

| 事项 | 状态 |
|---|---|
| legacy 人物卡解析委托到 core 增强版（不再误报“确定性解析未识别”） | ✅ |
| 剧本资产 upsert：重复导入同名剧本会更新资产；删除剧本可从卡库操作 | ✅ |
| 调试页新增「卡库」子页：剧本/调查员/实体资产独立于场次查看、删除、加入场次、开新场次 | ✅ |
| 新建场次向导：剧本列表可刷新、预选剧本；step2 调查员改为显式“加入/移除”按钮 + AI 调查员下拉 | ✅ |
| `POST /coc-api/assets` 增加 `action=delete`（剧本级联删除场次） | ✅ |
| Playwright UI 冒烟检查：`npm run ui-check`，13 项按钮/面板交互检查 | ✅ |

### Step 11 已完成 ✅（ScenarioContract 第一阶段：契约 schema + 草拟 + 候选叙述校验 + 夜晚事件）

| 事项 | 状态 |
|---|---|
| `lib/core/scenario/contract.js`：契约 schema（clueGates/npcKnowledge/ritualConditions/nightEvents/finalBranchWhitelist）+ normalize/validate | ✅ |
| `lib/core/scenario/contract-draft.js`：从检定点/实体/分支/原文确定性草拟契约（无 LLM 兜底） | ✅ |
| `lib/shared/chat/scenario-contract-validator.js`：候选叙述校验（线索门禁/NPC 知识/仪式条件/最终分支白名单）+ 夜晚事件评估 | ✅ |
| 夜晚事件设计约定：onSleep 默认“调查员入睡后触发”；不入睡按 sleepPolicy（force=强制入睡/penalty=惩罚/allow）提示 | ✅ |
| 聊天桥接线：自动草拟契约落盘、候选叙述先过契约校验（违规则重写并回滚副作用）、入睡触发夜晚事件并持久化 firedNightEventIds | ✅ |
| 新增单测 10 例 + 集成测试 2 例，全套 43 文件通过；ui-check 14/14 | ✅ |

### 待办 📋

| 事项 | 状态 |
|---|---|
| **真实端到端测试（重启 dsh web 后验证双面板/工具/Skills/聊天桥全链路）** | ⏳ 待用户配合执行 |
| 前端调试 tab 状态 JSON 查看器（可后续加） | ⏳ 观察 |
| Session Trace 完整记录 | 🔄 持续补充 |
| 测试体系建设 | 🔄 持续补充 |

| 事项 | 状态 |
|---|---|
| **真实端到端测试（重启 dsh web 后验证工具/Skills/前端/聊天桥全链路）** | ⏳ 待用户配合执行 |
| 前端面板对接新 API（如需） | ⏳ 观察 |
| Session Trace 完整记录 | 🔄 持续补充 |
| 测试体系建设 | 🔄 持续补充 |

### Step 0 已完成 ✅（Rule Engine 地基修正）

| 事项 | 状态 |
|---|---|
| `evaluateCoC` 大成功/大失败修正为 CoC 7e 标准（技能≥50 时 01-05 大成功、96-99 普通失败；技能<50 时 96-00 大失败） | ✅ |
| `combat.js` DB 表修正为标准 CoC 7e（-2/-1/0/+1d4/+1d6/+2d6/+3d6），`dbExpression`/`rollDb` 独立导出可测 | ✅ |
| 重伤判定修正：单次伤害 ≥ 最大 HP 的一半（原来错误使用 `(hpBefore + damage)/2`） | ✅ |
| `skill-growth` 事件改为 `SkillGrown`，`WorldState.applyEvent` 正确写入角色技能 | ✅ |
| `rules-content.json` 成功档次与 DB 表文本修正 | ✅ |
| 新增 `tests/unit/combat.test.mjs`（16 用例）、`tests/unit/skill-growth.test.mjs`（3 用例） | ✅ |
| 全套测试 18 个文件全部通过；旧 `selftest.mjs` 仍通过 | ✅ |

### 待办 📋

| 事项 | 优先级 | 预计 |
|---|---|---|
| Context Builder 模块 | P1 | Phase 2 |
| Trigger Engine 模块 | P1 | Phase 2 |
| Director 模块（AI KP 大脑） | P1 | Phase 2 |
| Narrator 模块（AI KP 嘴） | P1 | Phase 2 |
| Narrative Recovery 模块 | P2 | Phase 3 |
| Game Clock 定时事件 | P2 | Phase 3 |
| Knowledge 分层（World Truth / Player Knowledge） | P2 | Phase 3 |
| 迁移所有旧 Tool 到新架构 | P1 | Phase 2 |
| 前端面板对接新 API | P2 | Phase 3 |
| Session Trace 完整记录 | P2 | Phase 3 |

---

## 架构概览

```
┌─────────────────────────────────────────────────┐
│  Harness Adapter（lib/adapter/）                 │
│  plugin.js — 唯一 import DSH 包的模块            │
│  Tool 注册 / Skill 注册 / Context 注入 / API     │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────┐
│  CoC Core（lib/core/）— 零 DSH 依赖              │
│                                                  │
│  dice.js ← events.js ← interfaces.js            │
│  clock.js ← docx-extract.js ← character-parser.js│
│  state/world-state.js                            │
│  rules/sanity.js + combat.js + skill-growth.js  │
│  scenario/model.js + compiler.js                │
│  plot/plot-graph.js                              │
│  clue/clue-graph.js                              │
│  index.js（统一导出）                             │
└─────────────────────────────────────────────────┘
```

---

## 模块依赖方向

```
Scenario Compiler → Scenario Model
Plot Graph → WorldState (flags, clues)
Clue Graph → WorldState (discoveredClues)
Rule Engine → EventBus
WorldState ← EventBus（applyEvent）
Trigger Engine → EventBus + WorldState（未来）
Game Clock → EventBus（未来）
Director → WorldState(read) + EventBus(publish)（未来）
Narrator → WorldState(filtered)（未来）
```

---

## 下一步

1. **真实 E2E 测试（当前）**：全部 Step 已完成，重启 dsh web 验证工具/Skills/前端/聊天桥全链路

---

## 相关文档

- `AGENTS.md` — 开发约定
- `TESTING.md` — 测试规范
- `TECHNICAL.md` — 技术文档
- `README.md` — 项目说明
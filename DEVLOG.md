# dsh-coc-keeper 开发日志

> 保存跨会话上下文，防止因窗口容量问题丢失开发进度。

---

## 版本状态

- 当前版本：`v0.2.0`
- 包名：`@dsh-external/dsh-coc-keeper`
- 类型：DSH 双面插件（宿主端 + 浏览器端）
- 状态：已装配到 web profile，正在运行
- 最近里程碑：ScenarioContract 第二阶段已落地（LLM 生成契约 + 主持页校对/确认生效）

---

## 环境信息

| 项目 | 值 |
|---|---|
| DSH 主目录 | `/Users/eeo/.dsh` |
| 插件目录 | `/Users/eeo/Documents/deepseek harness/coc-keeper` |
| 宿主端入口 | `lib/index.js` |
| 浏览器端入口 | `lib/client.js` |
| 自测文件 | `tests/selftest.mjs` |
| 配置文件 | `cordis.patch.yml` |

### LLM 配置

- **Provider**: `tencent-cloud`（tokenhub.tencentmaas.com）
- **模型**: `deepseek-v4-flash`
- **上下文窗口**: 131072（已覆盖 catalog 的 1M，见 `settings.yaml`）
- **API Key 环境变量**: `TENCENT_CLOUD_API_KEY`

---

## 已知问题 / 待办

### 1. 上下文窗口容量问题（已修复 ✅）

**2026-08-18**: `deepseek-v4-flash` 在 pi-ai catalog 中 contextWindow = 1,000,000，导致 `compaction-basic` 的压缩阈值 = 800K，永不触发压缩。已在 `settings.yaml` 中为 `tencent-cloud` provider 的 `deepseek-v4-flash` 模型覆盖 `contextWindow: 131072`。

### 2. 待办项

- [ ] 检查是否还有其他因 catalog 大窗口导致的问题
- [ ] 完善前端面板的交互体验
- [ ] 考虑添加更多 CoC 7e 规则支持（如战斗、追逐规则）
- [ ] 优化 PDF 文本提取（目前依赖 pdf-parse，对扫描件不支持 OCR）

---

## 架构概览

### 宿主端 (`lib/index.js`)

```
┌──────────────────────────────────────────────┐
│  apply(ctx, config)                           │
│  ├─ 注册 13 个 coc_* 工具                     │
│  ├─ 注入 KP 系统提示词 section                │
│  ├─ 注入实时游戏状态动态 context               │
│  ├─ 挂载 /coc-api HTTP 路由（GET/POST）       │
│  └─ 提供聊天桥（kpChatLoop）                  │
├──────────────────────────────────────────────┤
│ 数据存储                                       │
│  └─ $DSH_HOME/coc/<gameId>.json (JSON 文件)   │
└──────────────────────────────────────────────┘
```

### 浏览器端 (`lib/client.js`)

```
┌──────────────────────────────────────────────┐
│  window.__ModuleLoader__.load()               │
│  ├─ 酒馆式面板（右下角浮窗）                  │
│  │  ├─ 聊天（Chat）标签页                     │
│  │  ├─ 状态（Status）标签页                   │
│  │  ├─ 剧情（Plot）标签页                     │
│  │  ├─ 人物（Characters）标签页               │
│  │  ├─ 实体（Entities）标签页                 │
│  │  └─ 导入（Import）标签页                   │
│  └─ 通过 /coc-api 与宿主端通信               │
└──────────────────────────────────────────────┘
```

### 工具清单

| 工具名 | 用途 | 权限 |
|---|---|---|
| `coc_import` | 导入规则/剧本/人物（PDF/文本/JSON） | 公开 |
| `coc_read` | 分段阅读已导入全文 | 公开 |
| `coc_roll` | 明骰（公开检定） | 公开 |
| `coc_roll_secret` | 暗骰（秘密检定） | 仅 KP 可见 |
| `coc_kp` | 切换 AI/Human KP 模式 | 公开 |
| `coc_status` | 查看剧情状态总览 | 公开 |
| `coc_branch` | 管理关键剧情点与分支 | 公开 |
| `coc_remind` | 分支提醒管理 | 公开 |
| `coc_scene` | 设置场景/时间/概述 | 公开 |
| `coc_task` | 任务栏管理 | 公开 |
| `coc_entity` | 管理 NPC/地点/物品/组织实体 | 公开 |
| `coc_pc` | 更新玩家人物状态 | 公开 |
| `coc_character` | 管理人物卡 | 公开 |

### 数据模型

```
GameState {
  id: string           // 游戏 ID（安全化后的字符串）
  title: string        // 游戏标题
  kpMode: "ai"|"human" // KP 模式
  rules: {...}         // 规则书（摘要 + 全文）
  scenario: {...}      // 剧本（摘要 + 全文）
  characters: [...]    // 人物卡数组
  keyPoints: [...]     // 关键剧情点
  branches: [...]      // 剧情分支
  currentScene: string // 当前场景
  currentBranchId: string
  time: string         // 游戏内时间
  synopsis: string     // 剧情概述
  tasks: [...]         // 任务栏
  entities: [...]      // 可交互实体
  log: [...]           // 剧情日志
  toolTrace: [...]     // 工具调用审计
  rollHistory: [...]   // 骰点历史
  reminders: [...]     // 提醒
}
```

---

## 插件配置

在 `cordis.patch.yml` 中：

```yaml
- insert:
    - id: coc-keeper
      name: '@dsh-external/dsh-coc-keeper'
```

支持配置项（在 profile 的 patch 中覆盖）：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/coc` | 数据存储目录 |
| `defaultGame` | `"default"` | 默认游戏 ID |
| `maxRollHistory` | 200 | 骰点历史上限 |
| `llmProvider` | `"deepseek-official"` | 面板聊天桥所用 provider |
| `llmModel` | `"deepseek-v4-flash"` | 面板聊天桥所用模型 |
| `maxChatRounds` | 4 | 聊天桥最大工具调用轮数 |
| `maxChatLog` | 120 | 聊天桥上下文保留的日志条数 |

---

## 测试

```bash
# 运行自测（需要先构建）
node /Users/eeo/Documents/deepseek\ harness/coc-keeper/tests/selftest.mjs
```

自测覆盖：
- 规则/剧本/人物导入（文本 + 结构草拟）
- 明骰/暗骰（含成功档位判定）
- 多面骰（3d6）
- 分支管理（添加/抵达/选择/推进场景）
- 关键剧情点管理（添加/揭示）
- 提醒管理
- KP 模式切换
- 人物管理（列表/更新）
- 场景/时间/概述设置
- 任务栏（添加/完成）
- 实体管理（添加/更新）
- 玩家状态更新（HP/SAN/物品栏）
- 动态上下文（含时间/最近检定）

---

## 跨会话恢复指南

如果本会话中断，下次启动时：

1. **检查窗口容量**：确认 `settings.yaml` 中 `contextWindow` 设置是否仍生效
2. **读取本文件**：`cat /Users/eeo/Documents/deepseek\ harness/coc-keeper/DEVLOG.md`
3. **检查插件状态**：`curl http://127.0.0.1:3080/coc-api/status`
4. **运行测试**：`node tests/selftest.mjs`
5. **查看代码**：`lib/index.js`（宿主端）、`lib/client.js`（浏览器端）

---

## 重要文件路径

```
/Users/eeo/Documents/deepseek harness/
├── coc-keeper/
│   ├── package.json          # 插件元信息
│   ├── cordis.patch.yml      # 装配 patch
│   ├── README.md             # 使用文档
│   ├── DEVLOG.md             # ← 本文件（开发日志）
│   ├── lib/
│   │   ├── index.js          # 宿主端（1876 行）
│   │   └── client.js         # 浏览器端（1123 行）
│   └── tests/
│       └── selftest.mjs      # 自测（172 行）
├── dsh-routing-suite/        # 路由套件（mode-boost 等）
├── package.json
└── pnpm-lock.yaml
```

DSH 配置：
```
/Users/eeo/.dsh/
├── settings.yaml             # 全局设置（含 LLM provider 配置）
├── profiles/web/             # web profile
│   ├── cordis.patch.yml      # profile patch
│   └── node_modules/         # 依赖
├── .agent-presets/           # agent preset
│   └── router-standard/
│       ├── agent.cordis.yml  # 路由配置
│       └── preset.yml
├── sessions/                 # 会话数据
└── coc/                      # 跑团游戏数据
```

---

## 会话记录

### Session `cd2f7de7`（前序会话，2026-08-18）

因 `deepseek-v4-flash` 的 contextWindow 为 1M 导致压缩永不触发，上下文爆掉。

### Session `db8cbc32`（当前会话，2026-08-18）

修复了 contextWindow 设置，创建了本开发日志。
---

## Session `db8cbc32`（当前会话，2026-08-18）

### 完成的工作

#### 1. 上下文窗口容量修复（✅）
- 在 `settings.yaml` 中为 `tencent-cloud` provider 的 `deepseek-v4-flash` 模型覆盖 `contextWindow: 131072`
- 解决了 catalog 中 1M 窗口导致压缩永不触发的问题

#### 2. 创建开发日志（✅）
- 创建 `DEVLOG.md`，记录环境信息、架构概览、已知问题、跨会话恢复指南

#### 3. 实时导入进度显示（SSE 流式响应）（✅）

**后端变更**（`lib/index.js`）：
- `extractFileText()` 新增 `onProgress` 回调参数，在读取 PDF/DOCX/DOC/TXT 各阶段报告进度
- `coc_import.execute()` 新增第二个参数 `execCtx`，从中提取 `onProgress` 回调，传递给 `extractFileText` 并在各阶段（解析结构/规则/人物、保存数据）调用
- 新增 `sendSSEProgress()` 和 `sendSSEResult()` 辅助函数，发送 SSE 格式的进度事件
- `/coc-api/import` 端点支持 SSE 流式响应：检查 `body.stream === true` 或 `Accept: text/event-stream` 头，如果客户端支持则返回 SSE 流
- 传统 JSON 响应路径保留作为兼容后备
- 新增 `source: "file"` + `filePath` 支持（之前只支持 `fileBase64` 上传或 `text` 文本）
- 增大 HTTP 请求体大小限制从 2MB 到 50MB

**前端变更**（`lib/client.js`）：
- 导入面板的「开始导入」按钮使用 `fetch` 读取 SSE 流
- 添加进度条（`coc-progress-bar` + `coc-progress-fill`）和进度消息文本
- 解析 SSE 事件流：`progress` 事件更新进度条百分比和消息，`result` 事件显示完成/失败结果

**SSE 事件格式**：
```
event: start
data: {}

event: progress
data: {"phase":"reading","message":"读取 DOCX 文件中…","percent":10}

event: progress
data: {"phase":"done","message":"DOCX 文本提取完成","percent":60}

event: progress
data: {"phase":"parsing","message":"解析剧本结构（关键剧情点/分支/实体）…","percent":70}

event: progress
data: {"phase":"saving","message":"保存数据中…","percent":90}

event: progress
data: {"phase":"done","message":"导入完成","percent":100}

event: result
data: {"ok":true,"data":{...},"render":"已导入…"}
```

### 前端修复（2026-08-18）

**问题**：导入面板点击后进度条瞬间拉满，但没有看到结果

**根因**：
1. `ReadableStream` 的 `reader.read()` 在响应体很小时，首次调用可能返回 `{value: <data>, done: true}`，但旧代码 `if (result.done) return;` 跳过了数据处理
2. `handleSSEEvent` 处理 `result` 事件时立即调用 `poll(true)`，导致面板重新渲染，清空了结果框

**修复**：
1. `readStream`：先处理 `result.value`（即使 `done=true`），再检查是否继续读取
2. `handleSSEEvent`：收到 `result` 事件后，隐藏进度条，在结果框中显示清晰的「✅ 导入成功」或「❌ 导入失败」消息，2秒后才调用 `poll(true)` 刷新面板
3. 使用 `white-space: pre-wrap` 保留 `render` 文本中的换行

---

## Session（2026-08-20）：架构分析 + Step 0 Rule Engine 地基修正

### 完成的工作

#### 1. 架构分析（✅）
- 阅读 README / TECHNICAL / PLAN / DEVLOG / AGENTS / TESTING 全部文档
- 核对 `lib/core/*`、`lib/adapter/plugin.js`、旧 `lib/index.js` 关键区域、`lib/client.js` 集成点
- 确认：当前 `package.json.main` 仍指向旧 `lib/index.js`，新 adapter 未接管运行；两套状态模型并存
- 输出架构分析（能力盘点、模块边界、依赖方向、Turn Flow、重构顺序），用户选择先做 Step 0

#### 2. Rule Engine 地基修正（✅）
- `evaluateCoC` 大成功/大失败修正为 CoC 7e 标准：
  - 技能 ≥ 50：01-05 大成功；96-99 普通失败；仅 00 大失败
  - 技能 < 50：仅 01 大成功；96-00 大失败
- `combat.js` DB 表修正为标准 CoC 7e（-2/-1/0/+1d4/+1d6/+2d6/+3d6），新增导出 `dbExpression`/`rollDb`（支持负常量，可测）
- 重伤判定修正：单次伤害 ≥ 最大 HP 的一半（原错误 `(hpBefore + damage)/2`）
- `skill-growth` 事件改为 `SkillGrown`，`WorldState.applyEvent` 正确写入 `pc.skills[skill]`
- `rules-content.json` 成功档次与 DB 表文本修正

#### 3. 测试补齐（✅）
- 新增 `tests/unit/combat.test.mjs`（16 用例）
- 新增 `tests/unit/skill-growth.test.mjs`（3 用例）
- 更新 `tests/unit/dice.test.mjs` 以匹配 CoC 7e 大成功/大失败
- 强化 `tests/integration/rule-event-state.test.mjs` 验证技能成长真正写入 WorldState
- 全套测试 18 个文件全部通过；旧 `selftest.mjs` 仍通过

### 下一步
- Step 1：GameSession 容器 + 入口切换 `lib/adapter/plugin.js`
- Step 2：旧 flat state → WorldState 持久化迁移

---

## Session（2026-08-20）：Step 1 入口切换 + GameSession 容器

### 完成的工作

#### 1. Core 会话容器（✅）
- 新增 `lib/core/session/game-session.js`：GameSession 容器，组装 EventBus + WorldState + PlotGraph + ClueGraph + Trace
- `WorldState` 新增 `hydrate(data)` 原地同步方法（保留实例引用）
- `core/index.js` 统一导出 `GameSession`
- 新增 `tests/unit/game-session.test.mjs`（6 用例）

#### 2. 入口切换（✅）
- 旧 `lib/index.js` 备份为 `lib/legacy-index.js`（作为过渡实现与参考）
- 新 `lib/index.js` re-export `lib/adapter/plugin.js`
- 新 `lib/adapter/plugin.js`：
  - 初始化 GameSession，从旧 flat 状态同步 WorldState 镜像
  - 包装 `ctx.tools.register`：每个旧工具执行后记录 trace、同步 flat → WorldState、映射 GameEvent → EventBus
  - 已映射事件：coc_roll / coc_roll_secret → RollPerformed；coc_sanity_check → RollPerformed + SanityLost；coc_combat_resolve → RollPerformed + DamageApplied；coc_skill_growth → RollPerformed + SkillGrown；coc_scene → SceneChanged / TimeAdvanced
- `package.json.main` 仍指向 `lib/index.js`，无需修改；装配与前端零感知

#### 3. 验证（✅）
- 全套测试 19 个文件通过（新增 game-session）
- `tests/selftest.mjs` 通过：17 个工具全部注册，旧功能与前端契约未破坏

### 当前架构状态
- 运行入口：`lib/index.js` → `lib/adapter/plugin.js` → `lib/legacy-index.js`（旧实现）
- Core：GameSession 容器开始接收真实事件，WorldState 为镜像（Step 2 升级为唯一事实来源）

### 下一步
- Step 2：旧 flat state → WorldState 持久化迁移
- Step 3：迁移 17 个工具到 `adapter/tools/*`

---

## Session（2026-08-20）：Step 2 持久化迁移 + 剧本初始化

### 完成的工作

#### 1. Persistence 层（✅）
- 新增 `lib/core/session/persistence.js`：Persistence 接口（JSDoc）+ `JsonFilePersistence` 实现
- 新增 `tests/unit/persistence.test.mjs`（4 用例）

#### 2. 新存档格式（✅）
- 旧 flat JSON 扩展 `core` 字段：`{ id, sceneMode, world, plot, clues, trace }`
- 旧 flat 字段继续由旧工具维护，前端 `/coc-api` 零感知
- `GameSession.toJSON()/fromJSON()` 承载 core 数据

#### 3. GameSession 扩展（✅）
- `importScenarioModel(model, opts)`：ScenarioModel → PlotGraph + ClueGraph（replace/activateInitial 可选，自动激活无前置条件节点）
- `hydrateCore(coreData)`：恢复 plot/clues/trace/sceneMode
- `WorldState.hydrate()` 修复数组字段共享引用 bug（曾导致 flat.rollHistory 被 core 追加污染，出现重复检定）

#### 4. plugin.js 收尾流程（✅）
- 工具执行后：reload flat → sync WorldState → 剧本导入时 `compileByPattern` 重建 Plot/Clue → 发布事件 → 保存 `flat.core`
- 旧存档首次加载自动补写 core 字段

#### 5. 验证（✅）
- 新增 `tests/integration/scenario-init.test.mjs`（3 用例）
- 全套测试 21 个文件通过；`selftest.mjs` 通过
- 验证 selftest 状态文件：core 字段正确持久化（world 场景/角色/实体、plot 节点、trace 207 条）

### 下一步
- Step 3：迁移 17 个工具到 `adapter/tools/*`（Tool → Event → State）

---

## Session（2026-08-20）：Step 3 工具迁移到 adapter/tools/*

### 完成的工作

#### 1. 新工具目录（✅）
- `lib/adapter/tools/helpers.js`：loadSession / commitSession / projectToFlat / 事件构造
- `lib/adapter/tools/roll.js`：coc_roll / coc_roll_secret（Core performRoll）
- `lib/adapter/tools/rules.js`：coc_sanity_check / coc_combat_resolve / coc_skill_growth（Core Rule Engine）
- `lib/adapter/tools/state-tools.js`：coc_scene / coc_kp / coc_pc / coc_task / coc_entity / coc_character（操作 WorldState）
- `lib/adapter/tools/plot-tools.js`：coc_branch / coc_remind / coc_status（flat 兼容字段）
- `lib/adapter/tools/import.js`：coc_import / coc_read / coc_query_rule（委托旧实现 + Core 收尾）

#### 2. plugin.js 装配策略（✅）
- 先 legacyApply（收集旧 defs 到 legacyDefs，不注册到模型上下文）→ 保留 /coc-api + 聊天桥
- 再 registerAllTools(ctx, deps) 注册 17 个新工具到模型上下文
- 模型可见工具全部来自 adapter/tools/*

#### 3. 验证（✅）
- 新增 `tests/integration/adapter-tools.test.mjs`（3 用例）
- 全套测试 22 个文件通过；selftest.mjs 通过
- 验证新工具写入：flat 投影与 core.world 一致（characters/entities/scene/rollHistory/plot nodes）

### 当前架构状态
- 模型上下文：adapter/tools/*（17 个新工具）
- /coc-api + 聊天桥：legacy-index.js（旧 defs，读写 flat）
- 数据：flat JSON + core 字段；WorldState 是新工具运行期唯一事实来源，flat 是兼容投影

### 下一步
- 真实 E2E 测试（启动 dsh web 验证）
- Step 4：迁移 /coc-api 与聊天桥

---

## Session（2026-08-20）：Cordis ctx 包装事故修复 + 启动验证

### 问题
- Step 3 中 `plugin.js` 用 `{ ...ctx }` / `{ ...ctx.tools }` 包装 Cordis 上下文，
  把 Proxy + 原型链依赖容器降级为普通对象，导致插件无法启动。

### 修复（Codex 协助）
- `plugin.js` 改为 `Object.assign(Object.create(ctx.tools), {...})` 包装服务；
  `ctx.extend({ tools })` 包装上下文（fallback 保留原型链）。
- `tests/integration/adapter-tools.test.mjs` 新增真实 Cordis Context 回归测试
  （`@deepseek-ai/cordis` 的 `Context`/`Service`）。

### 新增规范（AGENTS.md）
- 禁止对 Cordis ctx/服务对象使用对象展开/浅复制。
- 修改 Adapter 后必须跑真实 Cordis Context 回归测试 + `npx @deepseek-ai/dsh web --port 0` 启动验证。

### 验证结果
- 全套测试 22 文件通过（含真实 Cordis Context 用例）
- `npx @deepseek-ai/dsh web --port 0` 启动成功（Step 3 日志正常，/coc-api 返回 200，随后停止临时实例）
- 端口 3080 上的现有 dsh web 实例 `/coc-api/status` 正常

---

## Session（2026-08-20）：Step 4 /coc-api 与聊天桥迁移

### 完成的工作

#### 1. /coc-api 迁移（✅）
- 新增 `lib/adapter/api/coc-api.js`：路由分发、SSE 导入、配置、内置规则导入、LLM 测试、聊天入口
- 契约不变：GET status/state；POST roll/branch/remind/kp/status/read/tool/import/clear-scenario/clear-rules/config/import-builtin-rules/test-llm/chat
- 内部全部使用 adapter 新工具 defs（Core → Event → State）

#### 2. 面板聊天桥迁移（✅）
- 新增 `lib/adapter/chat/chat-bridge.js`：stateDigest / buildKpSystemPrompt / buildLoopMessages / streamBlocks / runKpTurn
- runKpTurn 使用 adapter 新工具 defs；每轮工具执行后重载 flat → 同步 GameSession → 合并 toolTrace 到 session.trace → 保存 core

#### 3. legacy 瘦身（✅）
- legacy-index.js 停用内部 /coc-api 注册（handleCocApi/runKpTurn 保留作参考/回退）

#### 4. plugin.js 装配（✅）
- 收集 adapter 工具 defs 到 toolDefs（Cordis 安全：ctx.extend + Object.create）
- 注册 /coc-api + 聊天桥到真实 ctx

#### 5. 测试体系修复（✅）
- 测试 runner 修复 async 测试假阳性（改为 `await test.fn()`）
- 全部 23 个测试文件末尾改为 `await run(...)`
- 新增 `tests/integration/coc-api.test.mjs`（真实 Cordis Context + webServer mock，3 用例）
- 修复 coc_sanity_check 返回缺 `passed` 字段

#### 6. 验证（✅）
- 全套测试 23 文件通过；selftest 通过
- `npx @deepseek-ai/dsh web --port 0` 启动成功
- 实测 /coc-api/status、/coc-api/state、/coc-api/roll 全部 200 正常

### 下一步
- 真实 E2E 测试（用户重启 dsh web 后验证面板聊天桥 + 前端全链路）
- Step 5：Trigger Engine + ContextBuilder + Knowledge 分层

---

## Session（2026-08-20）：Step 5 Trigger Engine + ContextBuilder + Knowledge 分层

### 完成的工作

#### 1. Knowledge 分层（✅）
- `lib/core/knowledge/knowledge-layers.js`
- 三层：kp-full（KP 完整）/ player（玩家可见）/ public（公开摘要）
- 过滤规则：暗骰仅 KP 可见；未揭示关键点仅 KP 可见；未抵达分支仅 KP 可见；实体按场景过滤；提醒仅 KP 可见

#### 2. Context Builder（✅）
- `lib/core/context/context-builder.js`
- `buildKpSystemPrompt(state, layer)`：硬性规则 + 工具指引 + 按知识层过滤的状态快照
- `buildLoopMessages(log)`：游戏日志 → LLM messages
- `renderStatusText(value)`：面板状态摘要（coc_status 复用）

#### 3. Trigger Engine（✅）
- `lib/core/trigger/trigger-engine.js`
- 触发器类型：scene / branch-pending / keypoint-pending / state（数值比较）
- `evaluateTriggers` / `pendingReminders` / `TriggerEngine` 类（fire + history）

#### 4. 接入（✅）
- 聊天桥改用 Core ContextBuilder（删除 adapter 内重复实现）
- plot-tools 的 coc_status 渲染改用 Core renderStatusText

#### 5. 验证（✅）
- 新增单测：knowledge-layers（5 用例）/ context-builder（5 用例）/ trigger-engine（7 用例）
- 全套测试 26 文件通过；selftest 通过；dsh web 启动验证通过

### 下一步
- 真实 E2E 测试（用户重启 dsh web）
- Step 6：Director / Narrator 替换 runKpTurn，注册规则域 Skills

---

## Session（2026-08-20）：Step 6 Director / Narrator + 规则域 Skills

### 完成的工作

#### 1. Director（Core 纯函数）（✅）
- `lib/core/director/director.js`
- `parseAssistantBlocks`：分离 LLM 文本块与工具调用块
- `decideNext`：决定 narrate 或 tools
- `buildToolResultMessages` / `parseToolArguments` / `buildAssistantContent`

#### 2. Narrator（Core 纯函数）（✅）
- `lib/core/narrator/narrator.js`
- `formatNarration`：空叙述兜底 + finish.error 处理
- `clampNarration`：叙述截断
- `makeKpLogEntry` / `makeUserLogEntry`

#### 3. 聊天桥重构（✅）
- runKpTurn 改用 Director/Narrator 纯函数，删除内联的 blocks 解析与消息组装

#### 4. 规则域 Skills（✅）
- `lib/adapter/skills/rule-skills.js`
- 注册 4 个 skills：coc-rule-dice / coc-rule-combat / coc-rule-sanity / coc-rule-growth
- inject 增加 `skills`；无 skills 服务时防御性跳过

#### 5. 验证（✅）
- 新增 `tests/unit/director-narrator.test.mjs`（11 用例）
- Cordis 回归测试验证 4 个 Skills 注册到 ctx.skills
- 全套测试 27 文件通过；selftest 通过
- dsh web 启动验证：skills 注册成功，/coc-api 正常

### 下一步
- Step 7：Narrative Recovery + Ending Reachability + Game Clock 定时事件

---

## Session（2026-08-20）：Step 7 Narrative Recovery + Ending Reachability + Game Clock

### 完成的工作

#### 1. Game Clock 定时事件（✅）
- `lib/core/clock-scheduler.js`
- `isTimeReached` / `evaluateScheduledEvents` / `fireScheduledEvent` / `formatScheduledEvent`
- WorldState 增加 `scheduledEvents` 字段（hydrate/toJSON/flat 投影）
- coc_scene 时间推进后自动评估并记录 trace

#### 2. Ending Reachability（✅）
- `lib/core/plot/reachability.js`
- BFS 可达集 + 叶子结局候选 + `analyzeReachability` + `summarizeReachability`
- 聊天桥系统提示接入结局可达性

#### 3. Narrative Recovery（✅）
- `lib/core/recovery/recovery.js`
- `isBusyStale` / `buildRecoveryPrompt` / `hasMissingNarration` / `summarizeToolTrace`
- 聊天桥接入 busy 卡死恢复（> 5 分钟自动恢复并记录 trace）

#### 4. 验证（✅）
- 新增单测：clock-scheduler（4）/ reachability（4）/ recovery（6）
- 全套测试 30 文件通过；selftest 通过
- dsh web 启动验证通过

### 七个 Step 全部完成
- Step 0-7 已全部落地：Rule Engine / GameSession / 持久化 / 工具迁移 / API+聊天桥 / Trigger+Context+Knowledge / Director+Narrator+Skills / Recovery+Reachability+Clock

### 下一步
- 真实 E2E 测试（重启 dsh web 全链路验证）

---

## Session（2026-08-21）：Step 8 全局资产库 + 场次分离 + 前端拆分

### 完成的工作

#### 1. 全局资产库（✅）
- `lib/core/assets/asset-store.js`：scenarios/investigators/entities 模板资产库
- `GameSession.scenarioId`：场次引用全局剧本资产
- 资产语义：模板永不修改；实例化 = copy-on-write

#### 2. 数据布局迁移（✅）
- `~/.dsh/coc/games/<id>.json` + `~/.dsh/coc/assets/**`
- 启动自动迁移旧根目录 `*.json` → games/ + assets/
- legacy 的 stateFile 同步改到 games/

#### 3. API 扩展（✅）
- `GET /coc-api/games` / `POST /coc-api/game-create` / `POST /coc-api/game-delete`
- `POST /coc-api/scenario-delete`：删除剧本并级联删除引用场次
- `POST /coc-api/assets`：list / instantiate（copy-on-write）
- `GET /coc-api/player-view`：按 player 知识层过滤的玩家视图
- `POST /coc-api/kp-command`：自然语言 → LLM 结构化工具调用（预览 → 确认执行）

#### 4. 规则开关（✅）
- `Config.autoImportBuiltinRules`（默认 true），false 时不再自动导入内置规则

#### 5. 前端拆分（✅）
- Player Panel：当前场景/时间、调查员状态、当前场景实体、最近动态、行动输入
- Keeper Console：主持（聊天 + KP 指令）/ 剧情（状态+剧情图）/ 调试（导入·实体·设置）
- header 游戏场次下拉 + 新建按钮

#### 6. 验证（✅）
- 新增 asset-store 单测（5 用例）；coc-api 集成测试新增 games/级联删除/实例化
- 全套测试 31 文件通过；selftest 通过
- dsh web 启动验证：旧数据迁移成功、新 API 正常

### 下一步
- 真实 E2E：重启 dsh web 后验证双面板/工具/Skills/聊天桥全链路

---

## Session（2026-08-24）：Step 9 人物卡解析增强 + 场次向导

### 完成
1. **人物卡解析增强**：`character-parser.js` 支持档案式 docx（中英文字段标签、属性标签行+数值行、技能段、技能三列/技能名+数值行）；`legacy-index.js` 人物导入增加 LLM 兜底（确定性解析无属性数值时触发）。
2. **人物展示**：调试页新增「人物」子页（HP/SAN/MP/LUCK 快速更新、属性、物品）；玩家视图显示调查员卡详情。
3. **玩家视图扩展**：`player-view` 新增 knownClues、log 分页（after/limit），前端「最近 20 条 + 加载更多」。
4. **场次创建向导**：前端三步向导（场次名+剧本 → 调查员多选（含 AI 调查员）→ 确认）；后端 `POST /coc-api/game-setup`（编译剧本结构 + copy-on-write 实例化角色 + LLM 开场白，失败回退模板）。
5. **内置 AI 调查员卡**：艾伦·卡特/格蕾丝·周/汤姆·米勒（完整参数，aiControlled 标记），启动时幂等入库。
6. **导入反馈修复**：导入成功结果框保留，不再被调试页重建清掉。
7. assets list 为剧本附加 recommendedPlayers（正则提取，缺省 2-4 人）。

### 验证
- 全套测试 31 文件通过；selftest 通过；dsh web 启动验证通过（内置卡入库、game-setup 正常）。

---

## Session（2026-08-24 下午）：Step 10 导入/向导修复 + UI 冒烟检查

### 修复
1. **“确定性解析未识别”误报**：legacy-index.js 内的旧 parseCharacters/normalizeCharacter 未升级。改为委托 `core/index.js` 的增强版（档案式 docx 可直接确定性解析）。
2. **剧本资产 upsert**：coc_import wrapper 原来 `session.scenarioId === null` 才保存资产，导致重复导入不更新/不建卡；现在无条件 upsert。
3. **卡库页（全局资产库）**：调试 tab 新增「卡库」，独立于场次管理剧本/调查员/实体资产（查看/删除/加入当前场次/开新场次）。
4. **向导交互**：step1 剧本列表可刷新、卡库可预选剧本打开向导；step2 玩家调查员改为显式“加入/移除”按钮 + AI 调查员下拉。
5. **assets delete 路由**：`action=delete`（剧本级联删除引用场次）。

### 测试
- 新增 `tests/ui-check.mjs`（Playwright + dsh web 真实启动），`npm run ui-check`。
- 13/13 通过：面板挂载、调试 5 个子按钮切换、向导三步（含 AI 下拉）、玩家面板挂载。
- 全套 31 文件通过；selftest 通过。

---

## Session（2026-08-27）：E2E 缺陷修复（ScenarioContract 第二阶段回归）

### 修复（针对 Codex E2E 报告 F-01~F-09）
1. **聊天循环 tool-only 悬挂**（F-01/F-02）：`runNarrationLoop` 连续只调工具不写正文时，下一轮禁用工具并注入“直接输出叙述”；连续两轮空正文提前结束循环，避免 busy 长时间悬挂。
2. **检定前泄露 chk-1 线索**（F-05）：`narration-guard` 的通用场景词移除 屋顶/铁栅栏/常春藤/屋顶边缘；KP 系统提示明确“本场景检定点线索词未过检定不得写入叙述”。
3. **确定性契约夜晚事件误分类**（F-03）：`contract-draft` 夜晚事件只保留“明确夜晚 + 夜间事件词 + 非剧透/非背景”行，宁缺毋滥。
4. **仪式/最终分支缺少前置条件**（F-04）：`contract-draft` 为最终分支派生 requires（关键点+分支已抵达）与 endingKeywords；`contract` 归一化保留 endingKeywords；`scenario-contract-validator` 强制执行最终分支前置条件、onSleep 事件按场景匹配。
5. **导入提示缺少契约元数据**（F-08）：`coc_import` 输出 schema/render 增加 contractSource/contractStatus。
6. **KP 指令解析失败**（F-07）：`/coc-api/kp-command` 剥离代码围栏并容错截取 JSON 数组。
7. **关键点未揭示**（F-06）：关键点标题变体增加事件后缀剥离（委托到来→委托）。
8. **KP 臆造分支 id**（F-09）：KP 系统提示明确 branchId/keyPointId 必须存在，严禁臆造。

### 验证
- 全套 43 文件测试通过；ui-check 14/14 通过。
- 新增单元测试：夜晚事件草拟过滤、onSleep 场景匹配、最终分支前置条件拦截/放行、关键点后缀匹配。

---

## Session（2026-08-27 续）：v3 状态落地修复 + SC 明骰

### 修复（针对 E2E v3 B 阶段 P1 缺陷 + 用户规则修正）
1. **关键点/分支自动落地**（P1-01）：`autoLandBranches` 玩家输入或叙述命中分支选项原文即标记 reached+chosen；最终分支选择后揭示同结局关键点；game-setup 开场白直接揭示 scene=导入 的关键点。
2. **关键点标题 CJK 双字组兜底**：4 字以上标题（如“发现一层墨渍”）正文出现 2 个双字组即揭示。
3. **物品实体归一 + 垃圾过滤**（P1-04）：`canonicalItemFromEntities` 把候选物品归一到剧本实体物品名（纸页→四张手稿）；未命中实体的候选走严格过滤，拒绝句子残片。
4. **SAN 结算提示**（P1-05）：`coc_sanity_check` 结算行以明骰写入玩家可见日志。
5. **完整十二字咒文识别**（P1-06）：正则识别正序/逆序完整咒文，注入系统提示避免拆半句。
6. **SC 明骰**（用户规则修正）：`core/rules/sanity.js` RollPerformed 由 kind=secret 改为 kind=open；`.ra理智` 不再拒绝（resolveRaTarget 支持顶层 pc.san 回退）；KP 提示与工具说明全部改为“SC 是明骰，玩家可随时查看自己的 SC”。
7. `.ra理智` 目标值修复：resolveRaTarget 对 理智/SAN 回退 pc.san 顶层字段。

### 验证
- 全套 43 文件测试通过；ui-check 14/14 通过。
- 新增单元测试：分支自动落地、最终分支揭示、纸页→四张手稿归一、叙述残片拒绝入栏。

---

## Session（2026-08-27 续 2）：v4 复测修复（提前揭示/选项误判/物品残片/结局回退）

### 修复（针对 E2E v4）
1. **关键点提前揭示**：删除 CJK 双字组兜底（“克罗斯”不再命中“克罗斯临终提示”）；关键点标题匹配增加否定语境检测（“并没能进入书房”不揭示）；`revealKeyPointsForBranchChoices` 只按 option.leadsTo 与标题/场景精确匹配，不再用 branch.scene 宽匹配（修复 ai-kp-4/7/8 在掀地毯时被批量揭示）。
2. **分支选项误判**：`autoLandBranches` 改为取“最晚出现且无否定语境”的选项匹配；玩家“放弃撬锁，选择撞门”→ chosen=撞门。
3. **物品残片/漏收**：`canonicalItemsFromEntities` 一次返回多个命中实体名（“日记和手稿”→克罗斯的日记+四张手稿）；实体别名扫描（叠空白稿纸→四张手稿）；未命中实体的候选加严拒绝（又放下/叠/空白/仔细/翻看/和/或…）。
4. **最终结局回退**：`.ra` 路径检测 ai-br-3 已选后，对意志/SAN 掷骰注入“按已选结局推进、禁止回退掀地毯/书房”指引；context-builder 在最终分支已选时只展示仪式轮（理智/意志）检定点，不再混入侦查极限。
5. **玩家面板 SAN 刷新**：`lib/client.js` 玩家视图增量轮询时比较角色 HP/SAN/MP/物品数，变化则整页重绘，SAN 无需切换场次即可刷新。

### 验证
- 全套 43 文件测试通过；ui-check 14/14 通过。
- 新增单元测试：否定语境不揭示关键点、放弃撬锁选撞门、纸页归一手稿。

---

## Session（2026-08-27 续 3）：v5 复测修复（提前揭示/手稿丢失/结局后团检/选项匹配）

### 修复
1. **ai-kp-3 门外提前揭示**：`revealKeyPointsForBranchChoices` 场景型 leadsTo 改为要求 currentScene 精确切入（scene === currentScene），门外/门前不再落地；事件型 leadsTo（“发现墨渊”）仍按标题命中。
2. **四张手稿跨轮丢失**：`cleanupJunkInventory` 先做实体名归一，实体名里的合法数量词（“四张手稿”）不再被旧垃圾规则（含数量词即垃圾）误删；“原稿一张张”归一到“四张手稿”。
3. **结局后又追加侦查团检**：结局关键词出现且 ai-br-3 已选时，废弃全部旧门禁并跳过文本团检合并，结局后不再生成新门禁。
4. **ai-br-2 未落地**：`autoLandBranches` 选项匹配新增“短核心”候选（剥掉尾部 查看/调查/进入/尝试），叙述只出现“掀开地毯”也能落地“掀开地毯查看”。

### 验证
- 全套 43 文件测试通过；ui-check 14/14 通过。
- 新增单元测试：门外不揭示进入书房、掀开地毯落地 ai-br-2、清理物品栏保留四张手稿并归一原稿一张张。

---

## Session（2026-08-28 续 1）：v6 复测失败后——事件驱动落地收口（替代词面补丁）

### 结论
v6 复测证明：靠“叙述里出现某个词”来落地关键点/分支，在 LLM 改写文本后必然失效（“把地毯整片掀开”匹配不到“掀开地毯”；“漆黑深渊”匹配不到“发现墨渊”），并且宽变体（“进入书房”→“书房”）会造成提前揭示。开始把关键点/分支落地从“叙述词面启发式”切换到“结构化事件驱动”。

### 实现
1. 新增 `applyEventDrivenLanding(flat)`：场景精确切入揭示场景关键点；`passedCheckpointIds` 驱动“日记与手稿/十二字咒文”；`sanitySettled` 映射 chk-8 驱动“发现墨渊”并落地掀开地毯分支；最终分支已选且咒文已揭示才揭示“最终抉择”。
2. 新增 `findCheckpointMatch` / `recordPassedCheckpoint`：`.ra` 成功后把命中的剧本检定点 ID 写入 `flat.passedCheckpointIds`（动作文本缺失时只在场景池唯一匹配时记录，避免误配）。
3. 收紧 `keypointTitleVariants`：剥离词至少 4 字，“书房/墨渊/委托”等 2 字变体不再参与词面命中；`revealKeyPointsFromNarration` 跳过“进入/来到/抵达/打开”类空间动作标题，交给事件驱动。
4. `revealKeyPointsFromNarration` / `autoLandBranches` 降级为兜底：事件驱动先执行，叙述词面命中仅作为兜底。

### 验证
- `state-autolanding` 单测新增 3 个事件驱动用例（SAN 结算落地、检定点落地、场景精确切入），并更新 2 个过短剥离词回归用例。
- 全套测试 43/43 通过；ui-check 14/14 通过。

### 备注
- 事件驱动映射目前按《墨渊》关键点/检定点 ID 硬编码（PATCHES 行 11），下一步在剧本导入时为关键点/分支生成结构化前置条件，由 Trigger Engine 统一激活。

---

## Session（2026-08-28 续 2）：事件驱动补充——最终抉择门禁与物品清洁快修

### 补充
1. `revealKeyPointsForBranchChoices` 不再按分支 leadsTo 揭示“最终抉择”（ai-kp-8），统一由 `applyEventDrivenLanding` 判定：最终分支已选 + 十二字咒文已揭示 才揭示，堵住 ai-kp-8 先于 ai-kp-7 的时序洞。
2. 物品提取快修：`ITEM_ABSTRACT_DENY` 增加“蛮力”；`ITEM_CONTAINER_DENY` 增加“文件袋”；`normalizeAcquiredItem` 剥掉前导量词“本”（本笔记本→笔记本）和尾部“沉甸甸地/沉甸甸”（手枪沉甸甸地→手枪）。
3. 单测新增/更新：最终抉择门禁 2 例、分支选择不直接揭示最终抉择 1 例、蛮力/文件袋拒绝、手枪沉甸甸地清洗。

### 验证
- state-autolanding 单测 33/33；全套 43/43；ui-check 14/14。

### 备注
- “底片/油灯”等由 NPC 主体或场景道具句误提的问题仍在，根因是提取器不判断主语；下一步改为只采信 PC 主语的获得/持有事件，或仅认 `coc_pc inventoryAdd` 结构化事件。

---

## Session（2026-08-28 续 3）：聚焦更新（门禁消费短路/终局短路/.ra候选解析）+ KP 调试面板

### 聚焦更新
1. **门禁消费短路**：成功 `.ra` 后写入 `flat.resolvedChecks`（skill+action 稳定键）；后续 coc_check/文本 [团检] 同键门禁在合并时丢弃，并注入“该检定已通过，自动忽略”日志，打 74 轮循环。
2. **终局短路**：最终咒文轮（意志/SAN）成功时，若叙述未出现结局关键词，程序追加固定结局句（逆序→墨渊消散 / 正序→夏拉卡拉布降临），提交 `endingReached/endedAt/场景=三层书房·仪式终结`，补揭示 ai-kp-7/8，清空全部门禁并冻结场景推断回退。
3. **`.ra侦查 2` 候选解析**：`resolveRaCandidateChoice` 在 pendingChoice 存在时把 `.ra技能 N` 解析为第 N 个候选动作，不再当技能名“侦查 2”。
4. trace 增加 `gate-resolved` / `checkpoint-pass` / `ending-short-circuit` / `gate-resolved-dropped`。

### KP 调试面板
1. `/coc-api/state` 的 digest 增加 `debug` 只读快照：pendingChecks / pendingChoice / resolvedChecks / passedCheckpointIds / sanitySettled / skippedChecks / firedNightEventIds / endingReached / events（core.trace 倒序）。
2. 新增 `POST /coc-api/debug`：removeGate / clearGates / clearChoice / clearResolved（仅 KP 面板调用，不注册为模型工具）。
3. 前端主持页新增“运行调试（只读）”卡：状态徽章、门禁列表（掷骰/移除/清空）、候选确认按钮、已通过检定点与 resolvedChecks、SAN 结算、程序事件流；KP 指令输入草稿在刷新后保留。
4. 调试操作走正常 API 路径：掷骰/选候选发 `/coc-api/chat`，移除/清空走 `/coc-api/debug`，不旁路状态机。

### 验证
- 新增单测：`.ra侦查 2` 候选解析、resolvedCheckKey 去重；coc-api 集成测试新增 debug 快照与 removeGate（8/8 通过）。
- 全套 43/43；ui-check 14/14。

### 备注
- 终局短路与门禁去重仍登记在 PATCHES 行 12/13，后续由 Checkpoint 幂等消费与 EndingResolved 事件替代。

---

## Session（2026-08-28 续 4）：v7 复测修复——事件驱动校正/门禁持久化/咒文展示/SAN 玩家视图隔离

### 修复
1. **关键点校正**：`applyEventDrivenLanding` 场景规则只对空间型标题（进入/来到/打开）生效，“发现一层墨渍”不再因身处门厅而揭示；`ai-kp-5/ai-br-2` 改为仅由 `sanitySettled` 的 `scenario:chk-9`（墨渊首次目击）驱动，chk-7 确认接缝不再提前触发；新增 `ai-kp-6` 规则（咒文已揭示或最终分支已选）。
2. **门禁/检定点持久化**：成功 `.ra` 后写入 `resolvedChecks / passedCheckpointIds` 后立即 `saveFlat` 落盘，修复叙事循环从磁盘重载把记录覆盖丢失的问题（v7 终值两者为空）。
3. **分支落地玩家优先**：`autoLandBranches(flat, playerText, narration)` 先搜玩家输入，命中即停；叙述末尾菜单里的“撬锁工具”不再覆盖玩家选择的撞门。
4. **十二字咒文确定性展示**：咒文关键点已揭示或最终分支已选后，程序追加固定系统行展示“启墨渊、引魂夜、临神名、归字主”及逆序，避免 LLM 只写“已抄下”不展示内容。
5. **SAN 玩家视图隔离**：`sanitizeSanityLine` 只保留“损失 X SAN（A→B）”，隐藏出目/成功等级；`knowledge-layers.isRollVisible` 对 player 层隐藏理智/SAN 骰记录。
6. **物品清洁**：候选按“和/与/及”拆分后分别归一（“克罗斯的日记和四张手稿分别装进…”两件都入栏）；ITEM 捕获上限 12→16 字；`ITEM_STRICT_DENY` 增补 手套/抄录纸/皮面册子/之后；尾部清洗增补“分别”。

### 验证
- state-autolanding 单测 41/41（新增 chk-9 驱动、chk-7 不触发、一层门厅不揭示、玩家输入优先、A和B拆分、SAN 清洗等）。
- 全套 43/43；ui-check 14/14。

### 备注
- 仍为《墨渊》硬编码映射；PATCHES 行 11/12/13/14 已更新。
- “门禁错配/重复”与“残缺团检文案”仍主要受 LLM 输出影响，待下一轮观察持久化修复后的改善幅度。

---

## Session（2026-08-28 续 5）：v8 复测修复——咒文解码兜底/进门证据/日记越权拦截/门禁动作清洗

### 修复
1. **咒文解码兜底**：智力在解谜语境下成功且“发现日记与手稿”已揭示时，程序直接记录 `chk-13` 通过（即使 LLM 的门禁动作与检定点匹配词不一致），随后事件驱动揭示 `ai-kp-7` 并固定展示正确十二字，避免 LLM 智力大成功后不落地咒文、反而生成错误十二字并被 NPC 确认。
2. **进入书房不再提前**：`applyEventDrivenLanding` 对 `ai-kp-3` 在场景精确切入基础上，额外要求本轮玩家输入/叙述出现实际进门短语（进入书房/走进书房/踏进书房等，带否定排除）；LLM 在门外提前把 currentScene 设为“三层书房”不再触发揭示。
3. **日记越权拦截**：新增 `findEarlyDiaryLeak`，`ai-kp-4` 揭示前叙述出现“它在梦里给我讲故事/正着念是邀请/倒着念是告别”等日记核心句时，守卫判违规并触发重写。
4. **门禁动作清洗**：新增 `sanitizeGateAction`，截掉残缺提示尾（破折号/省略号/“请发送 `”），40 字截断；`coc_check` 与 `checkKey/resolvedCheckKey` 统一使用，减少“演算完毕，你审视图上那十二个字——”这类候选。
5. **物品清洁**：新增 `ITEM_JUNK_EXTRA`（隔层/两样/一并/手套/抄录纸/皮面册子/之后），`cleanupJunkInventory` 对非实体名条目额外剔除；`ITEM_STRICT_DENY` 同步增补。
6. `findEarlyDiaryLeak`、`sanitizeGateAction` 从 chat/index 导出。

### 验证
- state-autolanding 单测 46/46（新增进门证据 2 例、日记越权拦截 2 例、gate action 清洗 1 例）。
- 全套 43/43；ui-check 14/14。

### 备注
- P1-1/P1-3 修复为《墨渊》特化兜底，PATCHES 行 15 已登记。
- 残缺团检文案与门禁语义去重仍主要受 LLM 输出影响，下轮继续观察。

---

## Session（2026-08-28 续 6）：A——测试工具（剧情点预设/调试跳转/夹具导出/Replay）

### 交付
1. **`lib/shared/testing/story-presets.js`（纯数据，DSH-free）**：
   - 7 个《墨渊》标准剧情点预设：arrival / door / study-entered / diary-found / rug-revealed / spell-decoded / final-rite。
   - `applyStoryPreset(flat, name)` 原地重置剧情/门禁/关键点/分支/物品/场景字段，保留角色属性与剧本。
   - `exportStoryFixture(flat)` 把当前场次导出为可复用夹具 JSON。
2. **`/coc-api/debug` 新增两个动作**：
   - `gotoPreset {preset}`：跳到标准剧情点并保存。
   - `exportFixture`：导出当前状态夹具。
3. **前端调试卡新增“剧情点跳转（测试）”**：7 个预设按钮 + “导出状态”按钮（JSON 显示在只读 textarea，方便复制）。
4. **测试**：
   - `tests/unit/story-presets.test.mjs`（8 例）验证预设字段与夹具导出。
   - `tests/integration/coc-api.test.mjs` 新增 gotoPreset/exportFixture 路由测试（9/9）。
   - `tests/replay/final-rite-replay.test.mjs`：从 final-rite 预设回放 `.ra意志` 成功，断言程序收敛到墨渊消散结局。
   - `tests/run-tests.mjs` 新增 replay 套件；全量 45/45。
5. **TESTING.md 新增第九节**：标准剧情点跳转、夹具导出、Replay 测试的使用约定。

### 验证
- 全量 45/45；ui-check 14/14。

### 备注
- 预设是《墨渊》特化数据，后续 B（结构化前置条件）完成后应改为由 ScenarioContract 自动生成预设。
- 前端 `DEBUG_PRESETS` 与 `STORY_PRESET_NAMES` 需同步维护，已在两处注释标明。

---

## Session（2026-08-28 续 7）：B 第一批——门禁语义目标键 / 旧门禁保留 / 自由动作不清空

### 背景
v9 定点复测暴露：同目标换措辞会把唯一 pending 清空（未命中→free-action→abandonGates(undefined)），
导致“还没掷骰就得到结论”；同义改写又会重复建门禁。本轮开始用结构化方向替换该处启发式。

### 交付
1. **`gateTargetKey(action)`**：动作文本 → 稳定目标键（去动作动词/功能字/同义归一 地板→地面、墙脚→墙角、原稿/稿纸→手稿）。
2. **`scoreTargetMatch` / `matchActionToGates`**：玩家输入匹配门禁时同时计算原文分与目标键分，取最大；同目标换措辞也能命中旧门禁。
3. **`mergeCheckGates` 语义合并**：按目标键去重；同一目标保留旧门禁、更新动作文本为新措辞、难度取更难。
4. **`resolvedCheckKey` 改用目标键**：成功后同目标换措辞的门禁也会被短路丢弃。
5. **自由动作不再清空 pendingChecks**：未命中门禁时旧门禁保留到 `.ra` 消费、失败结算、明确跳过或场景失效；修复 v9 误删唯一门禁。
6. 集成测试更新为新语义：旧门禁保留（shared-chat / check-gates）。

### 验证
- check-gates 单测 11/11（新增目标键归一、同义匹配、语义合并）。
- 全量 45/45；ui-check 14/14。

### 备注
- 这是 B 的第一批（门禁消费/去重结构化），仍保留词表+同义词启发式，已登记 PATCHES 行 16。
- 下一步 B：门禁 schema 增加 `checkpointId/target`、失败消费与场景失效自动清理，并开始结构化前置条件（PATCHES 11/15 的替换）。

---

## Session（2026-08-28 续 8）：B 第二批——检定点消费 / 失败消费 / 场景失效清理

### 交付
1. **门禁 checkpointId 消费**：
   - `.ra` 掷骰前先 `findCheckpointMatch`，命中则把 `checkpointId` 绑到 selectedGate；
   - 成功记录 `passedCheckpointIds` 时优先使用门禁绑定的 checkpointId；
   - `mergeCheckGates` 同目标合并时保留已有/传入的 checkpointId；
   - 门禁短路过滤新增：`gate.checkpointId ∈ passedCheckpointIds` 直接丢弃（不再只靠 skill+目标键）。
2. **失败消费**：`.ra` 失败且命中门禁时，门禁同样结束（原逻辑），并新增 `gate-failed` trace，失败指引继续要求 LLM 给出替代路径。
3. **场景失效清理**：新增 `expireSceneGates(flat, currentScene)`；门禁 `scene` 与当前场景互不包含时移入 skipped(reason=scene-invalid)，trace `gate-expired-scene`。每轮聊天开始时执行。
4. 测试：check-gates 12/12（checkpointId 保留）；state-autolanding 47/47（expireSceneGates）；全量 45/45；ui-check 14/14。

### 备注
- PATCHES 行 17 登记；门禁 schema 的 checkpointId/target 已可承载，后续在 `coc_check` 创建时直接写入 checkpointId（需把检定点匹配下沉到 shared 层，避免状态工具反向依赖 chat-bridge）。

---

## Session（2026-08-28 续 9）：B 第三批——结构化剧情前置条件（替换 PATCHES 11）

### 交付
1. **新模块 `lib/shared/chat/story-prereqs.js`**：
   - 条件判定 `evaluatePrerequisites` / `evaluateRequiresAnyOf`：支持 scene / entryEvidence / checkpointGroups（组内 OR 组间 AND）/ sanityEventIds / keyPointIds / branchChoiceIds。
   - 草拟规则 `draftKeyPointPrerequisites` / `draftBranchPrerequisites` / `draftEndingKeyPointPrerequisites`：从关键点标题词 + 检定点 keys/trigger + 场景/楼层兼容 + 难度排序生成 `requires/requiresAnyOf`，不再含《墨渊》ID。
   - 结构化查找 `findSpellKeyPoint` / `findFinalBranch` / `findKeyPointsRequiringBranch` / `requiredCheckpointIdsOf`。
   - `enrichStoryPrerequisites(flat)`：只补写缺失条件，已手工配置的不覆盖；导入时与每轮聊天开始前调用。
2. **`applyEventDrivenLanding` 改为通用触发器**：只读 keyPoints/branches 上的 `requires/requiresAnyOf`，删掉全部 ai-kp/ai-br/chk 硬编码；无结构化条件的不由事件驱动落地（交给叙述兜底）。
3. **`revealKeyPointsForBranchChoices`**：带结构化条件的关键点不再按 branch.leadsTo 提前揭示；旧数据保留“结局分支已选时最终/抉择类不提前揭示”的语义兜底。
4. **咒文解读兜底/咒文展示/终局短路/结局门禁冻结**：改用 `findSpellKeyPoint` / `findFinalBranch` / `findKeyPointsRequiringBranch` / `requiredCheckpointIdsOf` 做结构化查找，去除 chk-13/ai-kp-4/ai-br-3 等硬编码引用。
5. **story-presets**：预设补挂与生产草拟一致的结构化前置条件；`exportStoryFixture` 导出 requires/requiresAnyOf/autoChooseLabel。
6. 测试：新增 `tests/unit/story-prereqs.test.mjs`（20 用例）；state-autolanding 更新为带结构化条件的断言；全量 46 套通过；ui-check 14/14。

### 备注
- PATCHES 11 标记为已替代；PATCHES 15 的进门证据/咒文兜底部分改为结构化，剩余日记拦截/门禁动作清洗/物品清理仍待后续。
- 草拟规则本身仍是启发式（PATCHES 行 18），D 阶段由 LLM 深度解析替代并 KP 校对。

---

## Session（2026-08-28 续 10）：B 第四批——门禁创建绑定检定点 / 场景事件失效 / 结局事件化

### 交付
1. **`checkpoint-match.js`**：`findCheckpointMatch` / `findCheckpointReveal` 从 chat-bridge 下沉到共享层，chat-bridge 保留 re-export 兼容。
2. **`gate-lifecycle.js`**：`expireSceneGates`（前缀边界规则：当前场景以门禁 scene 为前缀且剩余不是“门外/门口/外部/外”时保留；修复“三层书房门外”在进入“三层书房”后误保留）+ `abandonAllGates`。
3. **`coc_check` 创建门禁时直接写入 `checkpointId` 与 `target`**：后续消费/短路不再依赖掷骰时匹配；同键旧门禁缺 checkpointId 时补齐。
4. **`coc_scene` 场景切换立即清理过期门禁**（Scene 事件），trace `gate-expired-scene`；不再只等下一轮聊天开始。
5. **结局事件化 `ending.js`**：`createEndingResolvedEvent` / `applyEndingResolvedEvent` / `buildEndingKeywords` / `endingSentenceFor`；聊天桥终局短路改为先创建 `EndingResolved` 事件再应用（为 C 阶段 Rule Engine/PlotGraph 发布事件留好接口）；结局门禁冻结改用 `abandonAllGates`。
6. 测试：新增 gate-lifecycle 4 用例、ending 5 用例；check-gates 集成新增 coc_check checkpointId 绑定用例；全量 48 套通过；ui-check 14/14。

### 备注
- PATCHES 13/17 更新，新增行 19（场景名前缀边界仍是启发式，待 SceneGraph 按 sceneId 精确失效）。
- B 收尾完成。下一步 C：游戏引擎增强（Typed Event Log / PlotGraph-Director / Rule Engine 扩展 / World State 一致性）。

---

## Session（2026-08-28 续 11）：C-1 统一账本 + 流水账（地基）

### 交付
1. **事件目录**（`lib/core/events.js`）：`GAME_EVENT_TYPES`（15+ 类型）、`EVENT_REQUIRED_FIELDS`、`validateGameEvent`、`createGameEvent`。
2. **EventLog 流水账**：`append` 自动分配 `id/seq/at`；`query({type, correlationId, afterSeq, limit})` 串因果链；`toJSON/fromJSON` 持久化。
3. **WorldState 剧情执行账本字段**：`currentBranchId / pendingChecks / skippedChecks / resolvedChecks / passedCheckpointIds / sanitySettled / keyPoints / branches / spellShown / endingReached / endedAt / firedNightEventIds`；新增 `hydratePlotFields`、`addPendingGate/removePendingGate/skipGate/recordResolvedCheck/recordPassedCheckpoint/recordSanitySettled/revealKeyPoint/landBranch/markSpellShown/recordNightEventFired/markEndingResolved`。
4. **WorldState.applyEvent 新事件实现**：GateCreated/GateResolved/GateFailed/GateExpired/CheckpointPassed/SanitySettled/KeyPointRevealed/BranchLanded/ItemAcquired/SpellShown/NightEventFired/EndingResolved。
5. **GameSession 集成 EventLog**：`applyEvent` 先盖章再入 WorldState/EventBus；`toJSON/hydrateCore/fromJSON` 携带 eventLog；`syncFromFlat` 吸收剧情账本字段。
6. **投影/迁移**：`projectToFlat` 从 WorldState 投影剧情账本字段；`commitSession` 先 `hydratePlotFields(flat)` 再应用事件再投影（旧工具直接改 flat 的兼容过渡，见 PATCHES 行 20）。
7. **事件化改造起步**：`coc_check` 新门禁走 `GateCreated` 事件；`coc_scene` 场景/时间变更走 `SceneChanged/TimeAdvanced` 事件。
8. 测试：新增 event-log 7 用例、world-plot-fields 5 用例；全量 50 套通过；ui-check 14/14。

### 备注
- 聊天桥内部多数副作用仍直接改 flat，由 `commitSession`/`saveFlat` 收进 WorldState；C-1 后续继续把聊天桥副作用改为“构造事件 → applyEvent → 投影”。
- 下一步：C-1 续（聊天桥副作用事件化），然后 C-2 规则补全。

---

## Session（2026-08-28 续 12）：C-1 续——聊天桥副作用事件化

### 交付
1. **聊天桥事件提交器 `commitChatEvents`**：先同步 flat → WorldState（保留本轮内存 trace/eventLog）→ `session.applyEvent` → `projectToFlat` → 保存；无事件时退化为 `saveFlat`。
2. **`syncSession` 调整**：从 flat.core 恢复 plot/clues/sceneMode，但保留本轮内存 trace/eventLog，避免事件与轨迹在同步时被旧 core 回滚。
3. **`.ra` 路径事件化**：
   - 掷骰同时提交 `RollPerformed` + `GateResolved`（带 resolvedKey）/ `GateFailed` + `CheckpointPassed`；
   - 咒文解读兜底改为 `CheckpointPassed` 事件。
4. **自动落地事件化**：关键点揭示 → `KeyPointRevealed`；分支落地 → `BranchLanded`（先快照 before 集合，再按新增发事件）。
5. **咒文展示 / 夜晚事件 / 终局事件化**：`SpellShown` / `NightEventFired` / `EndingResolved`（短路径与叙述确认路径都发）。
6. **文本团检门禁事件化**：新合并的 pendingChecks 发 `GateCreated`。
7. 全量 50 套通过；ui-check 14/14；EventLog 已能在工具与聊天桥两侧捕获事件。

### 备注
- 聊天桥仍保留直接 flat 修改作为过渡（PATCHES 行 20），但所有重要状态变化现在都有对应事件进 EventLog，因果链可查。
- 下一步 C-1 可选收尾：把 `abandonGates` / `expireSceneGates` / SAN 清理也纳入事件；然后进入 C-2 规则补全。

---

## Session（2026-08-28 续 13）：C-2 规则补全

### 交付
1. **SAN 规则补全**（`lib/core/rules/sanity.js`）：
   - `evaluateTemporaryMadness`：单次损失 ≥5 时 INT 检定，失败触发临时性疯狂；
   - `evaluateIndefiniteMadness`：24h 累计损失 ≥ 当前 SAN 20% 触发不定性疯狂；
   - `learnCthulhuMythos`：+1d6 克苏鲁神话技能，同时 -1d6 SAN，产出 SanityLost + SkillGrown 事件；
   - `recoverSanity`：精神分析 1d3 / 冒险奖励 1d6+4 / 战胜神话生物 1d10，产出 StateChanged 事件。
   - `performSanityCheck` 复用上述判定，新增 `temporaryMadness / indefiniteMadness` 返回字段。
2. **战斗规则补全**（`lib/core/rules/combat.js`）：
   - `rollInitiative`：DEX×5 先攻，成功者按出目升序，失败者按 DEX 降序排后；
   - `evaluateWoundState`：重伤（单次 ≥ 最大 HP 一半）/ 濒死（HP≤0）/ 死亡（HP≤-maxHp）；
   - `resolveArmor`：数字或骰式护甲解析；`performCombatRound` 应用护甲（至少保留 1 点）并返回 `majorWound/dying/dead/status`，DamageApplied 事件带 `status`。
3. **工具层同步**（`lib/shared/tools/rules.js`）：
   - `coc_combat_resolve` 增加 `armor` 参数与 `majorWound/status` 输出；
   - `coc_sanity_check` 的幂等结算改为发 `SanitySettled` 事件（WorldState 投影 flat.sanitySettled），不再手动写 flat。
4. 规则文本核对：`rules-content.json` 已含先攻/疯狂/恢复/成长/护甲条目，与新实现一致，无需改文。
5. 测试：新增 `tests/unit/rules-c2.test.mjs` 9 用例；全量 51 套通过；ui-check 14/14。

### 备注
- C-2 完成。下一步 C-3：多线剧情图 + 世界事实驱动（PlotGraph 边 requires/consequences、frontier 可达路线、跳线）。

---

## Session（2026-08-28 续 14）：C-3 多线剧情图 + 世界事实驱动（第一批）

### 交付
1. **PlotGraph 节点/边增强**：节点支持 `requires/consequences/missing`；新增 `addEdge(from,to,{label,requires,consequences})`（同向同目标去重）。
2. **故事结构同步**：`PlotGraph.syncFromStory({keyPoints,branches})` 建立 `kp:<id>` / `br:<id>` 节点；分支选项 `leadsTo` 命中关键点标题时建边；节点状态由 revealed/reached/chosen 驱动。
3. **可达路线集合（frontier）**：`computeStoryFrontier(flat)` 纯函数——对每个带结构化前置条件的未揭示关键点，计算其 `requires/requiresAnyOf` 在当前世界事实下是否满足，输出 `{id,title,scene,status,missing,requiresSummary}`；`storyFrontierText(routes)` 渲染“哪条路通、缺什么”。
4. **每轮注入 KP 提示**：`buildKpSystemPrompt` 新增 `frontier` 行（并修复 `endingStatus` 未透传问题）；聊天桥在叙事循环里每轮重算 frontier。
5. **调试面板**：`stateDigest.debug.frontier` + 主持页新增「可达路线（程序计算）」卡片。
6. **测试**：新增 `tests/unit/plot-frontier.test.mjs` 7 用例；全量 52 套通过；ui-check 14/14。

### 备注
- 本批完成了“程序算哪条路通、缺什么”；边上的 `consequences` 与跳线代价应用留待 C-3 第二批（frontier 注入触发/世界事实变更）。
- C-4 将把 `evaluatePrerequisites` 并入 trigger-engine，`applyEventDrivenLanding` 变薄封装，`EndingResolved` 改由 PlotGraph 结局节点发布。

---

## Session（2026-08-28 续 15）：C-3 第二批——剧情后果与跳线代价基础

### 交付
1. **剧情后果（consequences）**：`applyConsequences(world, consequences)` 支持 `setFlags / clearFlags / discoverClues / setEntityState / endingInfluence`；`PlotGraph.completeNode` 可在完成时应用后果；`applyCompletedConsequences(world)` 幂等应用所有已完成节点的后果。
2. **默认后果生成**：`syncFromStory` 为关键点/分支节点补默认后果（关键点揭示 → flag `kp:<id>:revealed`；分支选定 → flag `branch:<id>:chosen`）。
3. **聊天桥接入**：每轮结束时同步剧情图、重算 frontier、应用已完成节点后果，并把剧情图与 flags 持久化回 core。
4. **世界 Flag 修复**：`GameSession.syncFromFlat` 不再用空 flags 覆盖 core.world.flags（旧 flat 无 flags 字段时保留已恢复的 Flag）。
5. **调试面板事实卡**：`stateDigest.debug.facts` 输出 flags / discoveredClues / 实体态度 / 时间。
6. 测试：plot-frontier 增至 9 用例（新增 applyConsequences 与幂等）；全量 52 套通过；ui-check 14/14。

### 备注
- 跳线代价目前体现为「frontier 列出旧线未完成/缺条件」，机械性代价（时间消耗、检定难度提升、选项锁死）待 C-4 触发器/PlotGraph 发布 EndingResolved 后进一步结构化。
- C-3 完成度：节点/边/可达路线/后果已闭环。进入 C-4。

---

## Session（2026-08-28 续 16）：C-4 统一触发入口（后端验证先行）

### 交付
1. **前置条件判定并入 Trigger Engine**：`lib/core/trigger/trigger-engine.js` 新增 `evaluatePrerequisites / evaluateRequiresAnyOf / prerequisitesSatisfied / prerequisiteContextFromState`；触发器类型新增 `keypoint-prereq / branch-prereq / ending`。
2. **`story-prereqs.js` 只负责草拟**：`evaluatePrerequisites / evaluateRequiresAnyOf` 改为 re-export Core Trigger Engine，不再本地重复实现。
3. **`applyEventDrivenLanding` 薄封装**：聊天桥直接使用 Core Trigger Engine 的条件判定，不再持有条件求值实现。
4. **PlotGraph 结局节点**：`syncFromStory` 为选项指向结局/END 的分支建 `end:<branch>:*` 节点（含 branchId/chosen/optionLabel），选定后 completed；`completedEndingNodes()` 供聊天桥取已完成结局。
5. **`EndingResolved` 由 PlotGraph 结局节点驱动**：终局短路先同步剧情图，取已完成结局节点构造最终分支，再 `createEndingResolvedEvent`。
6. PATCHES 10/13/14 状态更新。
7. 测试：trigger-engine 10 用例（+keypoint-prereq/branch-prereq/ending）；plot-frontier 10 用例（+结局节点）；全量 52 套通过；ui-check 14/14。

### 备注
- 本轮只做后端验证，未跑 E2E（用户要求 E2E 前充分后端测试）。
- E2E 前还需要：重启 dsh web 报告新 PID，并准备《墨渊》全链路（复用 presets/replay/fixture export）。

---

## Session（2026-08-28 续 17）：C-4 后端测试加固（E2E 前）

### 交付
1. 新增 `tests/integration/c4-hardening.test.mjs`（3 用例）：
   - runKpTurn 全链路：KeyPointRevealed 入 EventLog、PlotGraph 节点 completed、WorldState flags 有剧情后果、digest.debug.frontier 有可达路线；
   - 旧存档迁移：无 core.eventLog / 无 flags 的旧档加载后正常补建 core（eventLog/world.flags/plot）；
   - 状态/规则工具一致性：coc_scene/coc_check/coc_sanity_check/coc_combat_resolve 的 WorldState 投影与 flat 一致，且 SceneChanged/GateCreated/SanitySettled/DamageApplied 均入 EventLog。
2. `tests/replay/final-rite-replay.test.mjs` 扩展断言：EndingResolved 由 PlotGraph 结局节点驱动（`end:<branch>:*` completed）、EndingResolved 进入 EventLog、kp flags 写入 WorldState。
3. 全量 53 套通过；ui-check 14/14。

### 备注
- E2E 前纯后端测试已通过：run-tests 53 套（含新加固集成 + replay 扩展）。
- E2E 操作指令见交付说明（重启 dsh web、验证 PID、按测试清单执行）。

---

## Session（2026-08-28 续 18）：E2E 反馈修复（场景漂移 + state/debug 暴露）

### E2E 发现与修复
1. **场景漂移**（study 预设聊天后 currentScene 从三层书房漂到一层）：`inferSceneFromText` 只要叙述提到他处场景词就会切换。新增 `inferSceneTransition` / `hasSceneMovementPhrase`：当前场景非空时，必须「新场景词 + 位置转移动作」同时命中才切换；`chat-bridge` 场景落地改用 transition 版。补单元（scene-facts +2）与集成回归（c4-hardening +1）。
2. **`/coc-api/state.debug.frontier` 缺失**：`coc-api.js` 有本地 `stateDigestOf` 副本，未同步 chat-bridge 的 `stateDigest`。补齐 `debug.frontier` / `debug.facts`（与聊天桥一致）。补 coc-api 集成断言。
3. **core 验证通道**：`/coc-api/debug` 新增 `dumpCore` action，返回 `eventLog / plot.nodes+edges / world.flags / world 关键字段`（只读、增量，不改旧 action）。
4. PATCHES 增补行 21（场景转移动作词启发式）。

### 测试
- 全量 53 套通过；ui-check 14/14。
- c4-hardening 扩到 4 用例；scene-facts 扩到 10 用例；coc-api 扩到 9 用例。

### 备注
- E2E 中“scenario-compile plotNodes:0 / game-setup keyPoints=0”为确定性编译器对《墨渊》提取不足 + LLM 契约未生成剧情点，属 D 阶段 LLM 深度解析范围；E2E 用 presets 注入结构后主线通过。
- 待 Codex 复测：state 路径为 `data.debug.frontier`；core 验证走 `POST /coc-api/debug {action:"dumpCore"}`。

---

## Session（2026-08-28 续 19）：复测反馈修复（GateResolved 缺失 / endingReached 暴露 / 结局事件去重）

### 复测发现与修复
1. **最终仪式轮重试成功缺 GateResolved**：第一次意志失败后门禁被消费，LLM 未再建门禁，第二次 `.ra意志` 成了自由掷骰。修复：最终仪式轮意志/SAN 门禁失败后，程序以 `source:"final-rite-retry"` 自动重建同门禁并发布 GateCreated；重试成功即消费门禁发布 GateResolved。
2. **EndingResolved 重复**：终局短路发布一次后，后续 `endingReached` 块又按叙述关键词再发一次。修复：`flat.endingReached === true` 时不再重复发布。
3. **`/coc-api/state` 顶层缺 `endingReached`**：`stateDigestOf` 与聊天桥 `stateDigest` 均补顶层 `endingReached` 字段。
4. 测试：c4-hardening 新增“失败重试 → GateResolved 入账且 EndingResolved 不重复”用例（5 用例）；全量 53 套通过；ui-check 14/14。
5. PATCHES 增补行 22。

### 备注
- 待 Codex 按修正后路径复测：`data.endingReached`、`dumpCore.eventLog` 应含 `GateResolved`。

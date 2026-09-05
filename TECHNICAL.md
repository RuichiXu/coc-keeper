# dsh-coc-keeper 技术文档

> **维护范围**：2026-09-05 按 `main`（`228e32f`）更新前端与共享加载边界。当前前端以 [FRONTEND.md](FRONTEND.md) 为准，操作路径见 [USER_GUIDE.md](USER_GUIDE.md)。本文第 4 节和附录中的旧宿主函数/行号为历史索引，其他后端细节并未在本次文档更新中逐项重验；实现已迁往 `lib/core/`、`lib/shared/`、`lib/adapter/`，修改前须查实际源码。
>
> **目标**：为重构 Agent 提供完整的代码库分析，包括架构、数据流、关键实现细节、已知问题及可移植性评估。

---

## 目录

1. [项目概览](#1-项目概览)
2. [架构总览](#2-架构总览)
3. [数据模型](#3-数据模型)
4. [宿主端索引（lib/index.js）](#4-宿主端索引libindexjs)
5. [浏览器端面板（lib/client.js）](#5-浏览器端面板libclientjs)
6. [内置规则系统](#6-内置规则系统)
7. [LLM 集成策略](#7-llm-集成策略)
8. [渐进式规则披露（Tools + Skills）](#8-渐进式规则披露tools--skills)
9. [关键技术细节](#9-关键技术细节)
10. [已知问题与坑](#10-已知问题与坑)
11. [可移植性与共享前端](#11-可移植性与共享前端)
12. [文件清单](#12-文件清单)

---

## 1. 项目概览

| 项目 | 值 |
|---|---|
| 包名 | `@dsh-external/dsh-coc-keeper` |
| 当前版本 | `v0.2.0` |
| 类型 | DSH 双面插件（宿主端 + 浏览器端） |
| 宿主端入口 | `lib/index.js`（兼容导出，装配位于 `lib/adapter/plugin.js`） |
| 浏览器端入口 | `lib/client.js`（DSH 与独立网页版共用的唯一源码） |
| 内置规则 | `lib/rules-content.json`（5968 字符，342 行） |
| 自测文件 | `tests/selftest.mjs`（178 行） |
| 装配方式 | DSH bundle patch（`cordis.patch.yml`） |
| 数据存储 | `~/.dsh/coc/games/<gameId>.json`（JSON 文件） |
| 内置场次 | `presets/games/*.json`（随包剧本 DB；启动时缺失才播种到 `dataDir/games/`） |
| LLM 配置 | `~/.dsh/coc/config.json`（前端设置面板保存） |

---

## 2. 架构总览

### 2.1 当前共享架构

```text
lib/core/                    规则、结构化状态、剧情图
    ↑
lib/shared/                  工具、主持循环、导入、通用 API
    ↑                              ↑
lib/adapter/                 standalone/
DSH/Cordis 装配              独立 HTTP 服务与登录
    ↓                              ↓
                   /coc-api
                       ↓
                lib/client.js
   Keeper：主持 / 剧情 / 解析 / 调试
   玩家视图 + 新建场次向导 + 面板坞
```

前端以 `window.__ModuleLoader__.load` 注册；独立网页版提供兼容加载器，直接服务同一文件。共享业务与 Core 不引入 DSH 依赖。前端细分职责及生命周期见 [FRONTEND.md](FRONTEND.md)。

### 2.2 数据流

以下保留聊天桥的概念流程，具体签名与工具执行入口以 `lib/shared/chat/` 为准。

```
用户输入（面板聊天区）
  │
  ▼
POST /coc-api/chat { text, player }
  │
  ▼
runKpTurn(store, defs, gameId, text, player)
  │
  ├─ 1. appendLog(state, "user", text, player)
  ├─ 2. buildLoopMessages(state, maxChatLog) → messages[]
  ├─ 3. 循环（最多 maxChatRounds 轮）：
  │     ├─ streamBlocks() → LLM 回复（文本 + 工具调用）
  │     ├─ 执行工具调用（executeToolForLoop）
  │     ├─ 工具结果入 messages
  │     └─ 如果无工具调用 → 叙事完成，跳出循环
  ├─ 4. appendLog(state, "kp", narration)
  └─ 5. 返回 { narration, rounds, digest, ... }
```

### 2.3 核心依赖

| 依赖 | 用途 |
|---|---|
| `@deepseek-ai/dsh-tools` | `defineTool()` — 工具注册 |
| `@deepseek-ai/dsh-llm` | `BlockAssembler` — LLM 流式组装 |
| `@deepseek-ai/schemastery` | `z.object()` — 配置校验 |
| `@deepseek-ai/cordis` | 插件系统（`ctx.inject`、`ctx.get`） |
| `pdf-parse` | PDF 文本提取（运行时依赖） |

---

## 3. 数据模型

### 3.1 游戏状态 GameState

```typescript
interface GameState {
  id: string;              // 安全化后的游戏 ID
  title: string;           // 游戏标题
  kpMode: "ai" | "human";  // KP 模式
  rules: RuleDoc | null;   // 规则书
  scenario: Scenario | null; // 剧本
  characters: Character[]; // 调查员数组
  keyPoints: KeyPoint[];   // 关键剧情点
  branches: Branch[];      // 剧情分支
  currentScene: string;    // 当前场景
  currentBranchId: string; // 当前分支 ID
  time: string;            // 游戏内时间（自由文本）
  synopsis: string;        // 剧情概述
  tasks: Task[];           // 任务栏
  entities: Entity[];      // 可交互实体（NPC/地点/物品）
  log: LogEntry[];         // 剧情日志（上限 600 条）
  toolTrace: ToolTrace[];  // 工具调用审计（上限 200 条）
  rollHistory: RollEntry[]; // 骰点历史（上限 maxRollHistory）
  reminders: Reminder[];   // 提醒
  busy: boolean;           // 是否正在回复
}
```

### 3.2 子数据结构

```typescript
interface Character {
  id: string;
  name: string;
  player: string;
  occupation: string;
  stats: Partial<Record<"STR"|"CON"|"SIZ"|"DEX"|"INT"|"POW"|"APP"|"EDU"|"LUCK"|"HP"|"SAN"|"MP", number>>;
  hp: number;
  san: number;
  mp: number;
  luck: number;
  skills: Record<string, number>; // 技能名 → 数值
  inventory: string[];
  notes: string;
}

interface KeyPoint {
  id: string;           // "kp-1", "ai-kp-1"
  scene: string;
  title: string;
  desc: string;
  revealed: boolean;
  scenarioId?: string;  // 关联剧本名
}

interface Branch {
  id: string;           // "br-1", "ai-br-1"
  scene: string;
  title: string;
  desc: string;
  options: BranchOption[];
  reached: boolean;
  chosen: string | null; // 已选择的 option label
  scenarioId?: string;
}

interface BranchOption {
  label: string;
  leadsTo: string;     // 选择后推进到的场景
}

interface Entity {
  id: string;           // "ent-1", "ai-ent-1"
  type: "npc" | "location" | "item" | "org" | "other";
  name: string;
  desc: string;
  state: string;       // 当前状态（如"受伤"、"已起疑"）
  scene: string;
  scenarioId?: string;
}

interface Reminder {
  id: string;           // "rm-1"
  scene: string;        // 触发场景（空字符串表示任何时候）
  text: string;         // 提醒内容
  fired: boolean;
}
```

---

## 4. 宿主端索引（lib/index.js）

> **历史索引**：以下函数表与行号描述旧单体实现，不能用于定位当前 `lib/index.js`。当前入口仅转导出 Adapter；旧实现保留在 `lib/legacy-index.js`，通用 API 已迁入 `lib/shared/api/coc-api.js`。

### 4.1 文件结构（按区域）

| 行号 | 区域 | 说明 |
|---|---|---|
| 1-10 | 导入 | 依赖导入 |
| 12-29 | 内置规则加载 | 从 `rules-content.json` 加载内置规则 |
| 32-46 | 插件元信息 | `name`, `inject`, `Config` schema |
| 48-152 | 基础工具 | 文件路径、状态读写、时间推进等辅助函数 |
| 154-226 | 骰点引擎 | CoC 7e 判定逻辑（`evaluateCoC`, `performRoll`） |
| 228-543 | 导入解析 | 文件提取、人物解析、结构草稿 |
| 546-555 | 渲染辅助 | 骰点结果渲染 |
| 558-2174 | 插件主体 `apply()` | 工具注册 + 提示词 + 路由 |
| 2177-2449 | HTTP API | `/coc-api` 路由分发 |
| 2452-2737 | 聊天桥 | `runKpTurn`, `streamBlocks`, `buildKpSystemPrompt` |
| 2739-2777 | 渲染函数 | `renderStatus` |
| 2779-2780 | 导出 | `export { Config, apply, inject, name }` |

### 4.2 14 个工具注册清单

| 工具名 | 行号 | 用途 | 关键参数 |
|---|---|---|---|
| `coc_import` | ~620 | 导入规则/剧本/人物(S/F/T) | `kind`, `source`, `filePath`/`text`/`fileBase64` |
| `coc_read` | ~892 | 分段阅读已导入全文 | `what`, `offset`, `limit` |
| `coc_roll` | ~933 | 明骰 | `expression`, `target`, `difficulty`, `player` |
| `coc_roll_secret` | ~1001 | 暗骰 | 同上，输出含 `secret: true` |
| `coc_query_rule` | ~1071 | 查询规则（渐进式披露） | `topic`（关键词匹配章节） |
| `coc_sanity_check` | ~1150 | 理智检定 | `player`, `sanLoss`（格式 "0/1d3"） |
| `coc_combat_resolve` | ~1261 | 战斗回合结算 | `attacker`, `defender`, `weapon` |
| `coc_skill_growth` | ~1461 | 技能成长 | `player`, `skill` |
| `coc_status` | ~1505 | 全局状态视图 | `view`, `includeSecretRolls` |
| `coc_branch` | ~1560 | 剧情结构管理 | `action`, `type`, `item` |
| `coc_remind` | ~1701 | 提醒管理 | `action`, `scene`, `text` |
| `coc_character` | ~1761 | 人物卡管理 | `action`, `character` |
| `coc_kp` | ~1817 | KP 模式切换 | `action`（"ai"/"human"/"status"） |
| `coc_scene` | ~1856 | 场景/时间/概述 | `scene`, `time`, `synopsis`, `timeAdvance` |
| `coc_task` | ~1900 | 任务栏管理 | `action`, `title`, `note` |
| `coc_entity` | ~1950 | 实体管理 | `action`, `entity` |
| `coc_pc` | ~2032 | 玩家状态更新 | `name`, `hp`, `san`, `inventoryAdd` |

### 4.3 关键函数

#### `streamBlocks(ctx, store, options)`
- **位置**：行 2629-2646
- **功能**：流式调用 LLM 并组装文本/工具调用块
- **逻辑**：
  1. 尝试 `ctx.get("llm")` 获取 DSH LLM 服务
  2. 如果可用 → 使用 `llm.stream()` + `BlockAssembler`
  3. 如果不可用（undefined）→ 回退到 `callLlmApi()` 直接 HTTP 调用
- **注意**：`ctx.get("llm")` 在非 GUI 会话中返回 `undefined`，这是本插件最常见的坑

#### `callLlmApi(dataDir, messages, options)`
- **位置**：行 2578-2627
- **功能**：直接调用 OpenAI/DeepSeek 兼容的 REST API（非流式）
- **配置来源**（优先级从高到低）：
  1. `~/.dsh/coc/config.json`（前端设置面板保存）
  2. 环境变量 `COC_LLM_PROVIDER`, `COC_API_KEY`, `COC_LLM_MODEL`, `COC_API_BASE_URL`
  3. 硬编码默认值
- **API 地址**：由 `provider` 决定，支持 `deepseek` 和 `openai` 预设 URL
- **注意**：使用 Node.js 内置 `fetch`（无需额外依赖）

#### `runKpTurn(store, defs, gameId, text, player)`
- **位置**：行 2657-2736
- **功能**：面板聊天桥的核心——KP 迷你循环
- **流程**：
  1. 设置 `state.busy = true`（防止并发调用）
  2. 追加用户消息到日志
  3. 构建消息列表（最近 `maxChatLog` 条）
  4. 循环（最多 `maxChatRounds` 轮，默认 4）：
     - 调用 `streamBlocks()` 带系统提示 + 工具列表
     - 如果模型只输出文本（无工具调用）→ 跳出循环
     - 如果模型调用工具 → 执行工具，结果入消息，继续循环
  5. 追加 KP 叙事到日志
  6. `finally` 中设置 `state.busy = false`

#### `buildKpSystemPrompt(state)`
- **位置**：行 2477-2552
- **功能**：构建给 AI KP 的系统提示词
- **内容**：
  1. KP 人设与硬性规则（检定纪律、暗骰纪律、状态落地要求）
  2. 规则概要（3 行基础判定规则）
  3. 可用工具列表（14 个工具的签名描述）
  4. 工具使用指引（什么场景用什么工具）
  5. 当前状态快照（场景/时间/人物/实体/分支/提醒/最近检定）

#### `aiDraftStructure(text, scenarioId, onProgress)`
- **位置**：行 621-737
- **功能**：LLM 智能解析剧本结构
- **流程**：
  1. 构建 prompt（要求返回 JSON 格式的 keyPoints/branches/entities）
  2. 调用 `streamBlocks()` 
  3. 解析 LLM 返回的 JSON（支持 Markdown 代码块剥离）
  4. 映射为带有 `ai-*` 前缀 ID 的结构化数据
- **注意**：这是导入剧本时自动调用的，如果 LLM 不可用则返回空数组

#### `draftStructure(text, scenarioId)`
- **位置**：行 505-543
- **功能**：正则表达式模式匹配提取剧情结构（后备方案）
- **匹配模式**：`【场景】`/`【关键剧情点】`/`【分支】`/`【NPC】`/`【地点】`/`【物品】`
- **注意**：对 DOCX 提取的文本几乎不匹配（格式不标准），绝大多数情况下 fallback 返回空

### 4.4 自动导入内置规则

- **位置**：行 2135-2153（在 `apply()` 函数末尾）
- **逻辑**：
  1. 检查 `BUILTIN_RULES_TEXT` 是否非空
  2. 调用 `touchState()` 确保状态存在
  3. 如果 `cur.rules === null`（首次启动）→ 自动写入内置规则
  4. 打印日志 `[coc-keeper] 内置规则已自动导入到游戏「${defaultGame}」`

### 4.5 HTTP API 路由

前缀 `/coc-api`；DSH web profile 与独立网页版接入共享实现。下表是历史路由子集，不是完整清单；场次、资产、玩家视图、解析、结构、契约等当前路由见 `lib/shared/api/coc-api.js`，前端调用约定见 [FRONTEND.md](FRONTEND.md)。

**GET 路由：**
| 路径 | 功能 |
|---|---|
| `/coc-api/status` | 返回游戏状态摘要（含所有内容） |
| `/coc-api/state?game=&after=` | 前端轮询接口：返回状态摘要 + 增量日志 |

**POST 路由：**
| 路径 | 功能 |
|---|---|
| `/coc-api/roll` | 明骰/暗骰 |
| `/coc-api/branch` | 分支管理 |
| `/coc-api/remind` | 提醒管理 |
| `/coc-api/kp` | KP 模式切换 |
| `/coc-api/status` | 状态查询 |
| `/coc-api/read` | 阅读全文 |
| `/coc-api/tool` | 通用工具执行（前端面板用） |
| `/coc-api/import` | 导入（支持 SSE 流式进度） |
| `/coc-api/chat` | 面板聊天（调用 `runKpTurn`） |
| `/coc-api/config` | 读取/保存 LLM 配置 |
| `/coc-api/test-llm` | 测试 LLM 连接 |
| `/coc-api/import-builtin-rules` | 手动重新导入内置规则 |
| `/coc-api/clear-rules` | 清除规则 |
| `/coc-api/clear-scenario` | 清除剧本及关联结构 |

---

## 5. 浏览器端面板（lib/client.js）

本节只保留全局概览，详细实现与维护约束统一维护在 **[FRONTEND.md](FRONTEND.md)**，避免重复的行号与旧导航长期失效。

### 5.1 加载与布局

唯一前端是原生 DOM 的单文件 IIFE；无裸导入、`require()` 或构建工具。`exports.apply` 挂载 Keeper 与玩家面板并注册清理。DSH 客户端加载该文件，独立网页版由 `standalone/public/index.html` 的加载器兼容同一模块。

Keeper 默认宽度不超过 1080px / 96vw、高度不超过 900px / 90vh，支持拖动、缩放、最大化、重置与最小化；位置、尺寸、场次和一级 Tab 通过 localStorage 记忆。面板坞统一管理显隐。窄面板使用容器断点调整分栏，解析检查栏可折叠。

### 5.2 四个工作区

| Tab | 核心内容 |
|---|---|
| 主持 `dm` | 对话、输入与快捷骰；待处理检定、KP 指令预览/执行 |
| 剧情 `plot` | 状态总览、剧情结构 |
| 解析 `net` | 骨架总览、场景总览、搜索/筛选、缩放/平移、迷你导航与检查栏 |
| 调试 `debug` | 导入、实体、人物、卡库、运行、契约、设置 |

新建场次向导有三个准备步骤和创建后的开场白页。玩家视图消费 `/coc-api/player-view` 的公开投影，和 Keeper 共用当前场次；它不是独立的前端权限边界。

### 5.3 网络渲染与状态流

`createNetModel` 建索引与边表 → `createNetLayout` / 两个 view builder 计算展示投影与坐标 → `paintNetSvg` 批量生成 SVG → `bindNetViewport` 统一交互。主线金色、左向右推进、分支/汇聚、场景聚合、hover 高亮及返回角标均保留。

布局按视图缓存；筛选只更新样式与结果列表；指针事件委托到视口并利用邻接索引；缩放/平移合并到动画帧。检查栏包含节点/边详情、质量与来源、显示选项、深度解析 JSON 校对和结构编辑。质量计数为保存记录，零值与确认状态均不能证明执行过语义审校。

Keeper 约 2.5 秒轮询状态，玩家约 3 秒轮询公开视图；请求序号和场次检查避免旧回包覆盖新场次。重绘和销毁需释放事件、定时器、动画帧及 `ResizeObserver`。

### 5.4 验证与迁移

运行语法检查、当前 28 项 UI 冒烟与 58 个测试文件；网络相关变更还要跑星孩/两面两种视图的真实浏览器探针。命令、测试限制与计时口径见 [TESTING.md](TESTING.md)。

旧七 Tab、演化视图、场景条带与聚焦最终结局开关不再是当前 UI 约定。新操作路径见 [USER_GUIDE.md](USER_GUIDE.md)，不要据历史截图恢复已合并的入口。

---

## 6. 内置规则系统

### 6.1 文件

- **源文件**：`lib/rules-content.json`（5968 字符，342 行）
- 历史：曾存在 `lib/rules-content.js`（ESM 导出），因运行时统一读取 JSON 已删除

### 6.2 加载方式

```javascript
// 通过 fs.readFileSync 加载（非 ESM import）
const __dirname_rules = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const rulesJsonPath = join(__dirname_rules, "rules-content.json");
BUILTIN_RULES = JSON.parse(readFileSync(rulesJsonPath, "utf8"));
```

### 6.3 规则内容覆盖

| 章节 | 内容 |
|---|---|
| 一、属性 | 8 项基本属性（STR/CON/SIZ/DEX/INT/POW/APP/EDU）+ 衍生属性（HP/SAN/MP/DB） |
| 二、技能 | 完整技能列表（约 60+ 个技能，含默认值） |
| 三、检定规则 | 成功档次、奖励/惩罚骰、对抗检定 |
| 四、战斗规则 | 先攻、行动、命中、闪避、伤害表、DB 速查表、射程、护甲、治疗 |
| 五、理智值 | SAN 损失触发、临时性/不定性/永久性疯狂、恢复 |
| 六、幸运 | 使用规则 |
| 七、职业模板 | 16 个常见职业及本职技能 |
| 八、装备与消耗品 | 1920 年代价格表 |
| 九、游戏流程 | 调查/推演/高潮/结尾 |
| 十、KP 规则 | 原则、奖励与惩罚、神话生物、克苏鲁神话技能 |

### 6.4 使用方式

1. **自动导入**：首次启动时自动写入状态（`cur.rules === null`）
2. **手动导入**：前端设置面板「重新导入内置规则」按钮（调用 `/coc-api/import-builtin-rules`）
3. **查询**：AI KP 通过 `coc_query_rule(topic)` 按关键词搜索规则章节

---

## 7. LLM 集成策略

### 7.1 双路径设计

```
streamBlocks(ctx, store, options)
  │
  ├─ ctx.get("llm") !== undefined
  │   └─ llm.stream() + BlockAssembler（DSH 原生 LLM 服务）
  │
  └─ ctx.get("llm") === undefined
      └─ callLlmApi(dataDir, messages, options)（直接 HTTP 调用）
```

### 7.2 配置来源

```javascript
// 优先级：环境变量 > 配置文件 > 硬编码默认
const provider = cfg.llmProvider || process.env.COC_LLM_PROVIDER || "deepseek";
const apiKey = cfg.apiKey || process.env.COC_API_KEY || "";
const model = cfg.llmModel || process.env.COC_LLM_MODEL || "deepseek-chat";
const baseUrl = cfg.apiBaseUrl || process.env.COC_API_BASE_URL || "";
```

### 7.3 配置存储

- **文件**：`~/.dsh/coc/config.json`
- **格式**：`{ llmProvider, llmModel, apiKey, apiBaseUrl }`
- **管理**：前端设置面板读写 `/coc-api/config` 端点
- **环境变量**：也支持 `COC_LLM_PROVIDER` 等环境变量（`.env` 文件自动加载）

### 7.4 已知限制

- `ctx.get("llm")` 在非 GUI 会话中返回 `undefined`
- 直接 HTTP 调用不支持流式响应（`stream: false`）
- 需要在设置面板中手动配置 API Key（无自动检测）

### 7.5 深度剧本解析（deepParse）与质量门禁

**流水线**（`lib/shared/tools/import.js` → `deep-parse-loop.js` → `lib/core/scenario/*`）：

```
提取文本 → 窗口结构分析(LLM, 200行/窗, 预算24000/32000) → 确定性合并/建树
→ enrichStoryPrerequisites（确定性草拟条件）
→ 深度解析 loop：分块生成(并发) + 最终分支/结局生成(finalModel)
→ canonicalizeDeepParse（字段别名折叠）→ repairDeepParseFinalWiring → repairDeepParseConnectivity
→ runDeepParsePreflight + runDeepParseRuleReview
→ 确定性检查干净则跳过语义审校，否则按配置执行 LLM review / chunk review
→ 第 2/3 轮修复式修订（只修订有问题的分块 + 最终分支/结局）
```

**两档门禁**：

- **硬门禁（必须全绿）**：`preflight h0/m0`、`rule h0/m0`、未连线场景点 = 0。
- **语义门禁（B 级）**：`review ≤ h0/m2`、`chunk ≤ h0/m2`。

**当前审校执行策略**：`43a8680` 起，preflight 与规则审校均无 high/medium 时可跳过语义审校；`runReview: true` 不强制执行。`quality` 的零值不能说明模型已经审过，前端必须展示这一数据局限。

**4 剧本后端历史验证基线（2026-09-05，跳过优化之前）**：

| 剧本 | 字符 | preflight | rule | review | chunk | 未连线 | 硬门禁 |
|---|---|---|---|---|---|---|---|
| 对流（短） | 16,298 | 0h/0m | 0h/0m | 0h/2m | 0h/0m | 0 | ✅ |
| 两面不是人（中） | 63,873 | 0h/0m | 0h/0m | 3h/0m | 0h/2m | 0 | ✅ |
| 盲愚之眼（中） | 63,629 | 0h/0m | 0h/0m | 0h/0m | 0h/1m | 0 | ✅ |
| 星孩（长） | 166,486 | 0h/0m | 0h/0m | 0h/0m | 0h/1m | 0 | ✅ |

复跑脚本：`scripts/import-verify-4scenarios.mjs`（本地缓存目录：`artifacts/import-verify/4scenarios/cache`）。

---

## 8. 渐进式规则披露（Tools + Skills）

### 8.1 设计思路

**问题**：CoC 7e 规则文本（~6000 字符）如果直接塞入系统提示词，每次对话都消耗大量 token。

**解决方案**：**系统提示词只放规则概要**（3 行基础判定），AI KP 需要具体规则时调用 `coc_query_rule` 工具查询。

### 8.2 工具分工

| 工具 | 替代了原来的什么 | 节省 token 量 |
|---|---|---|
| `coc_query_rule` | 完整规则文本嵌入 | ~6000 字符/轮 |
| `coc_sanity_check` | AI 手动计算 SAN 损失 | 约 500 字符/次 |
| `coc_combat_resolve` | AI 手动判定战斗 | 约 1000 字符/次 |
| `coc_skill_growth` | AI 手动技能成长 | 约 200 字符/次 |

### 8.3 系统提示词变化

**之前**（~7000 字符）：
```
KP 人设 + 完整规则文本 + 工具列表 + 状态快照
```

**现在**（~2000 字符）：
```
KP 人设 + 硬性规则（6 条）+ 3 行规则概要 + 工具列表 + 工具使用指引 + 状态快照
```

### 8.4 coc_query_rule 实现

```javascript
// 按 Markdown 标题分割规则文本为 sections
// 用户输入关键词 → 匹配 section 标题和正文
// 无匹配时返回所有一级标题作为索引
```

---

## 9. 关键技术细节

### 9.1 骰点引擎（CoC 7e 判定）

```javascript
// 位置：行 154-226
// 核心函数：evaluateCoC(target, rolled, percentile)
// 判定规则：
//   - 01 → 大成功（critical）
//   - ≤ 技能值/5 → 极限成功（extreme）
//   - ≤ 技能值/2 → 困难成功（hard）
//   - ≤ 技能值 → 常规成功（regular）
//   - ≥ 96 → 大失败（fumble）
//   - 技能 < 50 时 01-05 且 ≤ 技能值 → 大成功
//   - 技能 < 50 时 96-00 → 大失败
//   - 技能 ≥ 50 时仅 00 → 大失败
```

### 9.2 DOCX 文本提取（无外部依赖）

```javascript
// 位置：行 282-364
// 手动实现最小 ZIP 读取器：
//   1. 从文件尾部找 EOCD 签名 (0x06054b50)
//   2. 遍历中央目录条目
//   3. 读取 word/document.xml 的本地文件头
//   4. 支持 store (method=0) 和 deflate (method=8) 压缩
// 使用 Node.js 内置 zlib.inflateRawSync 解压
// 正则提取 <w:t> 标签中的文本，段落换行
```

### 9.3 时间推进

```javascript
// 位置：行 128-151
// 解析格式：/^(\d{1,4})年(\d{1,2})月(\d{1,2})日(?:\s*(上午|下午|晚上)?\s*(\d{1,2})?点?)/
// 支持：+1小时、+1天、到夜晚（21点）
// 失败时在原时间后标注
```

### 9.4 导入类型自动检测

```javascript
// 位置：行 790-806
// 检测顺序（优先级）：
//   1. args.kind 是否明确指定
//   2. 文件扩展名判断（.json → characters）
//   3. 内容前 2000 字符关键词匹配：
//      - 先检查剧本关键词（模组/场景/故事/剧情/NPC：）
//      - 再检查规则书关键词（规则书/技能表/属性表）
//      - 默认视为 scenario
```

### 9.5 武器伤害表

```javascript
// 位置：行 1358-1372（coc_combat_resolve 内部）
// 内置武器伤害映射，含：
//   - 徒手/小型武器：1d3 + DB
//   - 剑/刀：1d8 / 1d6 / 1d4+2
//   - 火器：.22/.32/.38/.45/9mm/步枪/霰弹/冲锋枪/机枪
// 霰弹枪射程递减：4d6/2d6/1d6
// DB 计算：根据 STR+SIZ 总和查表
```

### 9.6 SAN 损失解析

```javascript
// 位置：行 1193-1215（coc_sanity_check 内部）
// 支持格式："0/1d3"（成功0/失败1d3）
//              "1/1d6+1"（成功1/失败1d6+1）
//              "1d3"（固定损失）
// 疯狂判定：
//   - 单次损失 ≥ 5 → INT 检定 → 临时性疯狂
//   - 24h 内损失 ≥ 20% 总 SAN → 不定性疯狂
//   - SAN 归零 → 永久性疯狂
```

### 9.7 状态迁移

```javascript
// 位置：行 84-92
// ensureState() 补齐新增字段，确保旧状态兼容
// 目前检查：time, synopsis, tasks, entities, log, toolTrace
```

---

## 10. 已知问题与坑

### 10.1 开发环境坑

| 问题 | 描述 | 解决方案 |
|---|---|---|
| **`ctx.get("llm")` 返回 undefined** | DSH LLM 服务仅在 GUI 会话中可用，面板聊天桥和 AI 解析需要它 | 实现了 `callLlmApi()` 回退函数，直接 HTTP 调用 |
| **`dev_reload_package` 卡死** | 热重载工具经常挂起，插件状态卡在 `[reloading]` | 手动重启 DSH 或使用 `dev_inject_plugin` |
| **ESM import 本地文件失败** | `import { ... } from "./rules-content.js"` 报错 `Received an instance of ModuleJob` | 改用 JSON 文件 + `fs.readFileSync` |
| **`defineTool` 输出 schema 要求** | 每个 object 类型的 schema 必须显式声明 `additionalProperties` | 所有工具输出 schema 已加 `additionalProperties: false` |
| **自动导入代码位置错误** | 自动导入代码曾放在 `ctx.systemPrompt.context()` 内部，导致语法错误 | 移到 `apply()` 末尾，在其他注册之后 |

### 10.2 运行时坑

| 问题 | 描述 | 解决方案 |
|---|---|---|
| **DOCX 内容匹配不到 `draftStructure`** | 正则模式匹配假设文本有 `【场景】` 等标记，但 DOCX 提取的文本没有这些标记 | 实现了 `aiDraftStructure()` LLM 智能解析 |
| **AI 解析返回空** | 当 `ctx.get("llm")` 不可用时，`aiDraftStructure` 直接返回空数组 | 实现了 `callLlmApi()` 回退 |
| **SSE 导入进度条卡住** | 小响应体时 `reader.read()` 可能返回 `{done: true, value: <data>}` 但旧代码跳过了 | 修复：先处理 value，再检查 done |
| **导入完成后结果框消失** | 收到 `result` 事件后立即调用 `poll(true)` 导致面板重渲染清空结果框 | 修复：延迟 2 秒后刷新 |
| **面板聊天桥并发** | 如果用户快速发多条消息，`runKpTurn` 会并发执行 | 使用 `state.busy` 互斥锁 |
| **配置密码框显示** | API Key 输入框显示 `••••••••` 但保存时没有正确传递原值 | 修复：检测到 `••••••••` 时使用缓存的原值 |

### 10.3 设计局限

| 局限 | 说明 | 建议改进方向 |
|---|---|---|
| **复杂多结局最终接线** | 两面不是人这类“多个条件结局 + 兜底结局”的剧本，最终接线 LLM 仍可能给条件结局生成空前置（review 3h） | 最终接线 prompt 约束 + 结局条件确定性草拟（见 `PLAN.md` 待办 0） |
| **分块审校 medium 残留** | 分块审校的 m 级问题（补 requires/补边建议）经 3 轮修订仍可能残留，修订模型无法稳定消除 | 分块审校口径对齐确定性能力边界，或引入更强的修订模型 |
| **文件存储** | 使用 `JSON.stringify` 写整个文件，大状态时性能差 | 改用 SQLite 或增量存储 |
| **无用户认证** | 所有操作基于 `gameId` 字符串，无权限控制 | 添加用户/权限系统 |
| **无 OCR** | PDF 扫描件无法提取文本 | 集成 OCR 库（如 Tesseract） |
| **面板坞鼠标点击** | Playwright 与部分真实鼠标环境点击 dock fab 不触发 click 监听（JS `dispatchEvent` 正常），待修 | 检查 `lib/client.js` dock fab 的事件绑定与命中区域 |
| **单章节 hub 不可达** | 《盲愚之眼》唯一 `chapter` 的虚拟枢纽只有 `return->hub` 入边，BFS 不可达，preflight `0h/5m` | `topHub->chapterHub` + `开场主场景->topHub`（见 PLAN） |
| **无网络同步** | 数据只存本地 | 添加云端同步或多端共享 |
| **无截图/图片支持** | 不能处理地图/线索图片 | 添加图片上传和 AI 分析 |
| **无追逐规则** | CoC 7e 的追逐系统未实现 | 扩展 `coc_combat_resolve` 或新增工具 |
| **无奖励骰/惩罚骰** | 骰点引擎不支持奖励/惩罚骰机制 | 扩展 `coc_roll` 参数 |
| **无神话生物图鉴** | 没有内置神话生物数据 | 添加内置生物图鉴 |
| **无自动化场景流程** | 场景切换全靠手动 | 实现自动化场景推进引擎 |

---

## 11. 可移植性与共享前端

独立网页版已经存在，旧的“另起前端、替换加载器为 ESM/CommonJS、复制样式与 DOM”建议不再适用。两个宿主共同加载 `lib/client.js`，保持 `/coc-api` 的调用和数据结构兼容。

| 组件 | 当前边界 |
|---|---|
| 规则与状态 | `lib/core/`，保持 DSH-free |
| 工具、主持、导入、API | `lib/shared/`，两个宿主复用 |
| DSH 专属装配与 LLM 适配 | `lib/adapter/`，由 `lib/index.js` 兼容导出 |
| 独立服务与加载页面 | `standalone/`；服务端提供兼容 API，页面提供现有模块加载器 shim |
| 前端样式、DOM、网络图 | `lib/client.js`；文件内拆分职责，不复制成第二套实现 |
| 面板坞 | 前端现有 `window.__dshPanelDock__` 注册接口，保留两个面板的显隐与销毁逻辑 |
| 导入流式进度 | 浏览器 `fetch` / `ReadableStream`，保持接口格式 |

新前端功能应在两个入口复用；涉及宿主差异时先确认 [AGENTS.md](AGENTS.md) 的改动边界。加载与生命周期细节见 [FRONTEND.md](FRONTEND.md)，独立服务启动见 [standalone/README.md](standalone/README.md)。

---

## 12. 文件清单

```text
coc-keeper/
├── AGENTS.md / AGENTS.local.md  # 开发与本地输出约定
├── README.md                   # 项目概览与启动
├── USER_GUIDE.md               # 用户操作手册
├── FRONTEND.md                 # 当前前端开发与维护指南
├── TECHNICAL.md / TESTING.md    # 全局技术背景与测试规范
├── PLAN.md / DEVLOG.md         # 计划与历史记录
├── lib/
│   ├── index.js                # Adapter 兼容导出
│   ├── client.js               # 唯一共享前端
│   ├── core/                   # 规则与结构化状态
│   ├── shared/                 # 共享业务和 API
│   ├── adapter/                # DSH/Cordis 适配
│   └── legacy-index.js         # 过渡期旧实现
├── standalone/                 # 独立服务和前端加载页
└── tests/
    ├── run-tests.mjs           # 全量自动测试
    ├── ui-check.mjs            # DSH 真实启动的 UI 冒烟
    └── tmp/                    # 本地临时探针，已忽略，不保证存在
```

运行数据在配置的 `dataDir` 下（DSH 默认 `$DSH_HOME/coc`，独立版可设 `COC_DATA_DIR`）：`games/<gameId>.json` 是场次，`assets/` 是共享资产，`config.json` 是模型配置。数据、配置与临时产物不提交。

---

## 附录：关键代码片段速查

> 以下为旧单体实现的历史示例。新增工具与路由请依据当前 shared/adapter 实现，不能直接把主逻辑写回 `lib/index.js`。

### A. 注册一个新工具的模式

```javascript
defs['coc_tool_name'] = defineTool({
  name: "coc_tool_name",
  description: "工具描述",
  parameters: {
    param1: { type: "string", required: true, description: "..." },
    param2: { type: "number", description: "..." }
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,  // 必须显式声明！
      properties: {
        result: { type: "string" }
      }
    },
    render: (_args, value) => [{ type: "text", text: `[标题] ${value.result}` }],
    presentCall: () => ({ card: "generic", title: "标题", kind: "分类", rawInput: "" })
  },
  execute(args) {
    const current = state(args);
    // ... 逻辑 ...
    persist(current);
    return { result: "完成" };
  }
});
ctx.tools.register(defs['coc_tool_name']);
```

### B. 添加到 panelTools 数组

```javascript
// 位置：runKpTurn 内，行 2662
const panelTools = ["coc_roll", "coc_roll_secret", "coc_scene", "coc_task",
  "coc_entity", "coc_pc", "coc_branch", "coc_remind", "coc_kp",
  "coc_query_rule", "coc_sanity_check", "coc_combat_resolve",
  "coc_skill_growth", "coc_status"];
```

### C. 添加到 buildKpSystemPrompt 的工具列表

在 `buildKpSystemPrompt()` 函数（行 2477）中，找到 `【可用工具列表】` 和 `【工具使用指引】` 部分，添加对应的工具描述。

### D. 添加 HTTP API 路由

在 `handleCocApi()` 函数（行 2241）中，在 `if (path === "/coc-api/...")` 分支中注册新的路由处理。

---

*文档生成日期：2026-08-18*
*目标：为重构 Agent 提供完整的代码库分析*
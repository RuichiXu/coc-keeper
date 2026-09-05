# dsh-coc-keeper — 克苏鲁的呼唤（CoC）跑团插件

一个 DeepSeek Harness 插件：让 AI 担任 KP（守秘人）主持克苏鲁的呼唤跑团，支持导入规则书 / 剧本（模组）/ 人物卡（含 PDF）、明骰与暗骰、随时切换 KP、关键剧情点与分支跟踪、分支提醒，前端提供**主持、剧情、解析、调试四个工作区和独立玩家视图**。

## 功能

### 对话工具（GUI 会话内）

| 功能 | 工具 | 说明 |
|---|---|---|
| 导入规则 / 剧本 / 人物 | `coc_import` | 支持 PDF / DOCX / DOC（自动提取文本）、TXT/MD、直接粘贴文本；人物支持 JSON 或「姓名：xxx / 力量：50」式文本；剧本自动草拟关键剧情点、分支与实体（NPC/地点/物品） |
| 阅读导入全文 | `coc_read` | 分段阅读规则书 / 剧本全文（导入时只存摘要） |
| 明骰 | `coc_roll` | 公开检定，结果所有人可见；CoC 7e 成功档次判定 |
| 暗骰 | `coc_roll_secret` | 秘密检定，数值仅 KP 可见，提示不要向玩家披露 |
| AI 扮演 KP / 随时接替 | `coc_kp` | `ai` 模式 AI 主持；`human` 模式人类当 KP、AI 转为玩家助手；随时可切 |
| KP 查看剧情 | `coc_status` | 当前场景、当前分支与选项、关键剧情点（已/未揭示）、分支列表、人物、提醒、最近骰点 |
| 剧情结构管理 | `coc_branch` | 添加/修改/删除关键剧情点与分支；标记分支抵达、记录玩家选择并推进场景、揭示关键点 |
| 分支提醒 | `coc_remind` | 在指定场景登记提醒；当前场景匹配时自动进入 AI 上下文，KP 主动提示玩家 |
| 剧情状态 | `coc_scene` | 设置当前场景 / 游戏内时间 / 剧情概述；`timeAdvance` 快捷推进时间（+1小时/+1天/到夜晚） |
| 任务栏 | `coc_task` | 添加 / 完成 / 重新打开 / 删除任务 |
| 可交互实体 | `coc_entity` | 管理 NPC / 地点 / 物品 / 组织实体（含当前状态），剧本导入可草拟 |
| 人物状态 | `coc_pc` | 按姓名更新 HP/SAN/MP/LUCK、增减物品栏、追加备注 |

### 前端面板

| 一级 Tab | 内容 |
|---|---|
| **主持** | 对话、行动输入、快捷明骰/暗骰、待处理检定、KP 指令预览与执行 |
| **剧情** | 状态总览（概述、场景、时间、人物数值、物品、任务）；剧情结构（关键点、分支、提醒） |
| **解析** | 骨架总览与场景总览；搜索/筛选、缩放/平移、迷你导航；节点/边详情、质量报告、JSON 校对与确认生效 |
| **调试** | 导入、实体、人物、卡库、运行诊断、契约、设置 |

面板通过 `/coc-api` 与对话工具读写同一份游戏状态，定时轮询更新。独立的「玩家视图」显示服务端返回的公开信息并支持输入行动；同一浏览器中的两个面板共用当前场次。

Keeper 支持标题栏拖动、边缘/右下角缩放、最大化及位置/尺寸记忆。右下角 **🧩 面板坞** 用于恢复最小化的面板，也可打开/隐藏玩家视图。更多菜单 **···** 集中放置重置位置与大小、删除当前场次。

完整操作路径见 **[用户手册](USER_GUIDE.md)**；开发者与 agent 请读 **[前端维护指南](FRONTEND.md)**。

### 面板聊天桥（AI-KP 独立主持）

面板聊天区输入后，宿主直接驱动 LLM（复用当前会话的模型配置）运行一个 **KP 迷你循环**：携带完整状态快照（场景/时间/概述/人物/任务/实体/分支/最近检定）与 KP 人设，可调用 `coc_roll` / `coc_roll_secret` / `coc_scene` / `coc_pc` / `coc_task` / `coc_entity` / `coc_branch` / `coc_remind` / `coc_kp`，多轮工具调用后产出叙述。检定纪律与暗骰纪律写入系统提示（暗骰结果绝不出现在叙述中）；工具调用有 `toolTrace` 审计记录。

此外，插件会：
- 向会话系统提示词注入 **KP 人设段**；每轮自动注入 **实时游戏状态上下文**（场景 / 时间 / 分支 / 提醒 / 最近检定）。
- 宿主端暴露 **`/coc-api` HTTP 接口**：`GET status|state`；`POST roll|branch|remind|kp|status|read|tool|import|chat`。

### 深度剧本解析（LLM）

导入剧本时，插件会运行一个 **深度解析 loop**（≤24 块 2 轮，更长剧本 3 轮；模型与轮数可配置）：

1. **确定性骨架**：场景事实 → 关键点，检定点 → 技能分支，并提取玩家选择型最终分支。
2. **分块生成**：按场景切块生成 `keyPointConditions / branchConditions / plotEdges`；最终分支与结局单独生成。
3. **模型无关归一化 + 修复**：`extractJsonObject` 提取 JSON，`canonicalizeDeepParse` 折叠不同模型的字段形态变体（`label/name→title`、`condition→requires` 等），`repairSkeletonWiringDeepParse` + `repairDeepParseFinalWiring` + `repairDeepParseConnectivity` 补齐最终分支/结局标题、branchCondition、选项 leadsTo、主线/支线连通边。
4. **两档门禁**：
   - **硬门禁（必须全绿）**：`runDeepParsePreflight` 结构校验 h0/m0、`runDeepParseRuleReview` 规则化审校 h0/m0、未连线场景点 = 0。
   - **语义门禁（B 级）**：LLM 最终分支/结局语义审校 `review ≤ h0/m2`、分块语义审校 `chunk ≤ h0/m2`（`buildChunkReviewPrompt`，逐块审校局部条件）。
5. **修复式修订**：第 2/3 轮把审校意见与 preflight 问题回灌给模型；有 high/medium 问题的分块只重生成对应块，最终分支/结局整体修订，不推倒重写。

生成结果存为 `flat.deepParse`（draft），可通过 `coc_status` 查看；确认后由 `syncPlotGraphFromDeepParse` 汇入剧情图。前端「解析」提供**骨架总览与场景总览**，保留左向右推进、金色主线、分支/汇聚、悬停线路高亮及返回角标；在检查栏中可读质量报告、编辑 JSON、保存草稿并确认生效。

**4 剧本后端历史验证基线（语义审校跳过优化之前，2026-09-05，`scripts/import-verify-4scenarios.mjs`）**：

| 剧本 | preflight | rule | review | chunk | 未连线 | 硬门禁 |
|---|---|---|---|---|---|---|
| 对流（短） | 0h/0m | 0h/0m | 0h/2m | 0h/0m | 0 | ✅ |
| 两面不是人（中） | 0h/0m | 0h/0m | 3h/0m | 0h/2m | 0 | ✅（语义门禁待最终接线强化） |
| 盲愚之眼（中） | 0h/0m | 0h/0m | 0h/0m | 0h/1m | 0 | ✅ |
| 星孩（长） | 0h/0m | 0h/0m | 0h/0m | 0h/1m | 0 | ✅ |

> 两面不是人的语义门禁未过：复杂多结局剧本的最终接线 LLM 仍会给条件结局生成空前置，已在 `PLAN.md` 记录为下一步重点。

> 当前策略：结构 preflight 与规则审校均无高/中问题时，可以跳过 LLM 语义审校和分块审校；`runReview: true` 不保证实际执行。前端计数来自保存的报告，0 条问题记录不能证明已执行审校，“确认生效”也不代表质量通过。

模型配置示例（`~/.dsh/coc/config.json`）：

```json
{
  "llmModel": "deepseek-v4-flash-202605",
  "deepParse": {
    "finalModel": "deepseek-v4-flash-202605",
    "finalTemperature": 0,
    "finalTimeoutMs": 180000,
    "chunkConcurrency": 4,
    "maxRounds": 3,
    "reviewGate": { "high": 0, "medium": 2 },
    "runReview": true,
    "runChunkReview": true,
    "chunkReviewMaxTokens": 4000,
    "chunkRevisionMaxTokens": 8000
  }
}
```

- `llmModel` 是默认模型：分块生成、审校、修订都会用它（`finalModel` 不设时最终生成也用它）。
- `deepParse.finalModel` 只用于第 1 轮“最终分支与结局”的初始生成，之后修订仍走 `llmModel`；建议与 `llmModel` 一致并保持 `finalTemperature: 0`（温度 1 会导致最终接线输出方差过大）。
- `deepParse` 块还支持 `chunkModel / reviewModel / revisionModel` 单独指定各阶段模型，以及 `maxRounds / chunkConcurrency / chunkMaxTokens / finalMaxTokens / finalTimeoutMs / reviewMaxTokens / revisionMaxTokens / chunkReasoningEffort / finalReasoningEffort / reviewReasoningEffort / revisionReasoningEffort / runReview / runChunkReview / reviewGate`。

## 安装

```sh
# 在 coc-keeper 的父目录执行（把插件装进 web profile）
dsh plugin --profile web add ./coc-keeper
```

然后重启 `dsh web`，并刷新浏览器加载新前端。重启后：

- 新会话中模型获得 `coc_*` 工具与 KP 人设；
- 页面右下角出现「🎲 CoC Keeper」（默认宽度不超过 1080px / 96vw，高度不超过 900px / 90vh，可缩放与最小化）。

确认生效：

```sh
dsh --profile web --dump-config | rg coc-keeper
```

浏览器使用服务启动时输出的完整 URL 访问（可能包含访问令牌）；确认 Keeper、玩家视图和四个 Tab 出现。不必假设固定端口或使用未认证的 API URL。

游戏数据默认保存在 `$DSH_HOME/coc/games/<game-id>.json`（可在 profile 的 `cordis.patch.yml` 中通过 `coc-keeper` 行的 `config.dataDir` 覆盖）。

## 使用示例

**方式一：GUI 会话**（工具驱动，适合 AI-KP 主持）

```
玩家：我们开始跑《暗黑边缘》吧，这是我的调查员卡，还有规则书 PDF 在 ~/Downloads/coc7e.pdf
AI：好的，我先导入规则与剧本。
    → coc_import(kind=rules, source=file, filePath=~/Downloads/coc7e.pdf)
    → coc_import(kind=scenario, source=text, text=…, parseStructure=true)
    → coc_character(action=add, character={name:…, stats:{STR:50,…}})
玩家：我想调查书房里的那幅画。
AI：请做一次「侦查」检定。→ coc_roll(expression=d100, target=60, skill=侦查, player=张三)
    你悄悄靠近画框……（发现画后有暗格）→ 用 coc_roll_secret 做潜行暗骰，只描述结果
玩家：换个主持人来当吧。
AI：→ coc_kp(action=human)
```

**方式二：面板**

1. 「调试 → 设置」检查模型连接；「调试 → 导入」准备剧本和人物卡。
2. 标题栏「＋」打开新建场次向导：选择剧本 → 调查员 → 确认；创建后点击「进入场次」。
3. 「剧情 → 状态总览」核对场景、人物与任务；「主持」输入行动并处理检定。
4. 「解析」阅读网络、条件与质量报告；「调试 → 实体」管理 NPC 等公开信息。

详见 [从第一次开团到日常主持的用户手册](USER_GUIDE.md)。

## 剧情结构约定

- **关键剧情点**（keyPoints）：推动主线的线索/事件，`revealed` 标记是否已向玩家揭示。
- **分支**（branches）：玩家面临的选择点，含 `options`（label + leadsTo 下一场景）。`reached` 标记已抵达，`chosen` 记录玩家选择。
- **提醒**（reminders）：`scene` 匹配当前场景（留空则总是提醒）时，自动出现在 AI 上下文中。
- **实体**（entities）：`type` 为 npc/location/item/org/other；剧本导入按 `【NPC】`/`【地点】`/`【物品】` 标记草拟。
- **任务**（tasks）：`status` open/done；**时间**（time）为自由文本（支持「1925年10月1日 下午3点」式解析以便快捷推进）。

剧本导入时的结构提取是**草稿**，请用面板「剧情 → 剧情结构」「调试 → 实体」或 `coc_branch`/`coc_entity` 校对；PDF 需为文字版（扫描件暂不支持 OCR）；DOC 为尽力提取，建议优先用 DOCX。LLM 深度解析（`flat.deepParse`）同样以 draft 落库，结构 preflight 与语义审校结果记录在 `quality` 中。

## 开发说明

- 共享业务位于 `lib/shared/`，DSH/Cordis 适配位于 `lib/adapter/`，`lib/index.js` 保持宿主入口兼容；`lib/client.js` 为浏览器端自包含 bundle（`window.__ModuleLoader__.load` 注册，纯 DOM + fetch，无裸导入，无需前端构建管线）。
- 依赖：`pdf-parse`（PDF 文本提取）；peer 依赖 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis` 由运行环境提供。
- 文档入口：[开发约定](AGENTS.md)、[前端维护指南](FRONTEND.md)、[测试规范](TESTING.md)、[用户手册](USER_GUIDE.md)。
- 后端全量测试：`node tests/run-tests.mjs`（含 unit / integration / scenarios / e2e / replay）。只改后端内容时不用跑 ui-check；动了 client/DSH adapter 再跑 `npm run ui-check`。
- `/coc-api`（含聊天桥与真实 LLM 调用、暗骰纪律、骰点持久化）已在真实启动的 web profile 上端到端验证。

## 独立网页版 + Cloudflare Tunnel

不安装 DSH 也可以直接运行同一套工具、主持循环和前端面板：

```sh
cd standalone
npm install
COC_ACCESS_PASSWORD='换成强口令' npm run server
```

浏览器打开 <http://127.0.0.1:3000>。要复用 DSH 的场次、资产和 LLM
配置，使用：

```sh
COC_DATA_DIR=$HOME/.dsh/coc COC_ACCESS_PASSWORD='换成强口令' npm run server
```

服务器运行后，可在另一个终端执行 `npm run tunnel`，将 Cloudflare 输出的
`https://xxxx.trycloudflare.com` 分享给好友。免费 Quick Tunnel 地址会变化，
电脑关机或进程退出即停止；对外开放前必须更改默认口令。更多说明见
`standalone/README.md`。

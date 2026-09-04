# dsh-coc-keeper — 克苏鲁的呼唤（CoC）跑团插件

一个 DeepSeek Harness 插件：让 AI 担任 KP（守秘人）主持克苏鲁的呼唤跑团，支持导入规则书 / 剧本（模组）/ 人物卡（含 PDF）、明骰与暗骰、随时切换 KP、关键剧情点与分支跟踪、分支提醒，并附带一个**酒馆（SillyTavern）式完整前端面板**。

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

### 前端面板（酒馆式，浏览器右下角）

| 标签页 | 内容 |
|---|---|
| **聊天** | 玩家与 KP 的对话流（用户气泡 / KP 叙述 / 系统提示），输入框推进剧情（回车发送），快捷明骰/暗骰 |
| **状态** | 剧情概述（可编辑）、KP 模式切换、当前场景、游戏内时间（+1小时/+1天/到夜晚）、玩家状态栏（HP/SAN/MP/LUCK 进度条 + 增减按钮）、物品栏（增删）、任务栏（勾选完成/删除/新增） |
| **剧情** | 关键剧情点（一键揭示）、剧情分支（选择选项推进场景、标记抵达）、提醒（登记/触发） |
| **人物** | 人物卡查看与编辑（职业/属性/技能/备注）、添加人物、粘贴导入人物 |
| **实体** | 按类型分组的 NPC/地点/物品实体，编辑状态、增删 |
| **导入** | 文件上传（PDF/DOC/DOCX/TXT/MD/JSON）或粘贴文本，自动识别类型，剧本自动草拟结构；已导入内容 + 分段阅读全文 |

面板通过宿主 `/coc-api` 与对话工具**读写同一份游戏状态**，完全同步。

**面板坞（右下角 🧩）**：所有带面板的插件统一注册到右下角的常驻面板坞，点击 🧩 弹出面板列表（名称 + 开/关状态），点击行即可打开/隐藏对应面板——面板最小化后也能从这里找回。面板支持**拖动标题栏移动**、**右下角手柄缩放**，位置与尺寸自动记忆（localStorage）。其他插件可用 `window.__dshPanelDock__.register({id, title, icon, isVisible, toggle})` 注册自己的面板。

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

生成结果存为 `flat.deepParse`（draft），可通过 `coc_status` 查看；确认后由 `syncPlotGraphFromDeepParse` 汇入剧情图。

**4 剧本后端验证基线（2026-09-05，`scripts/import-verify-4scenarios.mjs`）**：

| 剧本 | preflight | rule | review | chunk | 未连线 | 硬门禁 |
|---|---|---|---|---|---|---|
| 对流（短） | 0h/0m | 0h/0m | 0h/2m | 0h/0m | 0 | ✅ |
| 两面不是人（中） | 0h/0m | 0h/0m | 3h/0m | 0h/2m | 0 | ✅（语义门禁待最终接线强化） |
| 盲愚之眼（中） | 0h/0m | 0h/0m | 0h/0m | 0h/1m | 0 | ✅ |
| 星孩（长） | 0h/0m | 0h/0m | 0h/0m | 0h/1m | 0 | ✅ |

> 两面不是人的语义门禁未过：复杂多结局剧本的最终接线 LLM 仍会给条件结局生成空前置，已在 `PLAN.md` 记录为下一步重点。

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
# 在插件仓库目录执行（把 coc-keeper 装进 web profile）
dsh plugin --profile web add ./coc-keeper
```

然后重启 `dsh web`（宿主与客户端插件变更都需要重启生效）。重启后：
- 新会话中模型获得 `coc_*` 工具与 KP 人设；
- 页面右下角出现「🎲 CoC 面板」（约 460×86vh，可折叠）。

确认生效：

```sh
dsh --profile web --dump-config | grep coc-keeper
curl http://127.0.0.1:3080/coc-api/status   # 应返回 JSON（未建游戏时为 data:null 提示）
```

游戏数据默认保存在 `$DSH_HOME/coc/<game-id>.json`（可在 profile 的 `cordis.patch.yml` 中通过 `coc-keeper` 行的 `config.dataDir` 覆盖）。

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

**方式二：面板**（酒馆式，适合直接开跑）

1. 「导入」页上传剧本 PDF / DOCX / DOC / 粘贴文本 / 导入人物卡；
2. 「状态」页设置游戏内时间与概述，确认玩家状态栏与任务栏；
3. 「聊天」页输入行动，AI-KP 自动主持（检定自动暗骰/明骰，状态自动落地）；
4. 「剧情」「实体」页跟进分支选择与 NPC 状态。

## 剧情结构约定

- **关键剧情点**（keyPoints）：推动主线的线索/事件，`revealed` 标记是否已向玩家揭示。
- **分支**（branches）：玩家面临的选择点，含 `options`（label + leadsTo 下一场景）。`reached` 标记已抵达，`chosen` 记录玩家选择。
- **提醒**（reminders）：`scene` 匹配当前场景（留空则总是提醒）时，自动出现在 AI 上下文中。
- **实体**（entities）：`type` 为 npc/location/item/org/other；剧本导入按 `【NPC】`/`【地点】`/`【物品】` 标记草拟。
- **任务**（tasks）：`status` open/done；**时间**（time）为自由文本（支持「1925年10月1日 下午3点」式解析以便快捷推进）。

剧本导入时的结构提取是**草稿**，请用面板「剧情/实体」页或 `coc_branch`/`coc_entity` 校对；PDF 需为文字版（扫描件暂不支持 OCR）；DOC 为尽力提取，建议优先用 DOCX。LLM 深度解析（`flat.deepParse`）同样以 draft 落库，结构 preflight 与语义审校结果记录在 `quality` 中。

## 开发说明

- 双面插件：`lib/index.js` 为宿主端（13 个工具 + 提示词/上下文 + `/coc-api` 路由 + KP 聊天桥）；`lib/client.js` 为浏览器端自包含 bundle（`window.__ModuleLoader__.load` 注册，纯 DOM + fetch，无裸导入，无需前端构建管线）。
- 依赖：`pdf-parse`（PDF 文本提取）；peer 依赖 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis` 由运行环境提供。
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

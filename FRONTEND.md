# 前端开发与维护指南

> 面向开发者与 agent。2026-09-05 按合并后的 `main`（`228e32f`）核对；入口与交互以 [lib/client.js](lib/client.js) 为准。面向玩家和 KP 的操作说明见 [用户手册](USER_GUIDE.md)，验收步骤见 [TESTING.md](TESTING.md)。

## 1. 开发边界

- **唯一源码是 `lib/client.js`**：原生 JavaScript IIFE、DOM、SVG、Canvas 与 CSS，按单文件加载。在文件内按职责分区，不引入构建工具、React/Vue、`require()`、裸导入或第二份前端。
- `window.__ModuleLoader__.load` 注册模块，`exports.apply(ctx)` 挂载 Keeper 与玩家面板，并通过 `ctx.effect` 注册销毁逻辑。独立网页版的 [加载页面](standalone/public/index.html) 提供兼容加载器，直接加载同一份文件。
- 前端只消费 `/coc-api`，保持现有请求方式和 JSON 结构；业务规则、状态写入和解析校验由后端承担。共享 API 实现在 [lib/shared/api/coc-api.js](lib/shared/api/coc-api.js)。
- 开工先读 [AGENTS.md](AGENTS.md)、[AGENTS.local.md](AGENTS.local.md) 和 [PLAN.md](PLAN.md)。包括注释、测试、文档在内，都遵守本地输出安全规则。

## 2. 当前信息架构

| 一级 Tab / 面板 | 子区域 | 实现入口 |
|---|---|---|
| 主持 `dm` | 对话、输入与快捷骰；待处理检定、KP 指令预览/执行 | `renderChatEntries`、`renderDmPanel`、`renderLiveChecks` |
| 剧情 `plot` | 状态总览 `status`、剧情结构 `plotInner` | `renderStatusPanel`、`renderPlotPanel` |
| 解析 `net` | 骨架总览、场景总览；搜索/筛选、视口、检查栏 | `renderNetPanel`、`renderNetContent` |
| 调试 `debug` | 导入、实体、人物、卡库、运行、契约、设置 | `renderDebugPanel` 及各子区域函数 |
| 新建场次 | 选择剧本 → 调查员 → 确认；创建成功后显示开场白 | `openGameWizard` |
| 玩家视图 | 场景、人物、已公开信息、动态与行动输入 | `mountPlayerPanel` |
| 面板管理 | 场次选择、新建、刷新、更多、最大化、最小化与面板坞 | `mountPanel`、`registerDockPanel` |

`mountPanel` 创建四个工作区并保留原有子面板容器。不要依赖旧的七个顶级 Tab：聊天已归入主持；状态归入剧情；人物、实体、导入、设置归入调试。运行诊断与契约也在调试中。

Keeper 默认宽度不超过 1080px / 96vw，高度不超过 900px / 90vh；已保存的尺寸优先。主持区在宽面板中左右分栏，窄面板上下排列。解析页以图为主，右侧检查栏可收起；面板宽度不超过 760px 时检查栏覆盖在图上。断点按面板容器计算，不能只检查浏览器窗口宽度。

### DOM 与冒烟测试约定

| 用途 | 当前选择器 / 属性 |
|---|---|
| Keeper / 玩家根节点 | `#coc-keeper-panel` / `#coc-keeper-player-panel` |
| 四个 Tab | `.coc-tabs [role="tab"][data-tab]`，值为 `dm / plot / net / debug` |
| 工作区 | `[data-panel]`，`role="tabpanel"`，ID 为 `coc-workspace-<key>` |
| 可复用子面板 | `[data-subpanel]`：`status / plotInner / import / ents / chars / assets / settings` |
| 向导 | `#coc-game-wizard`、`.coc-wizard-step`；前三个为准备步骤，第四个为成功页 |
| 网络视口 | `.coc-net-viewport`，`data-layout` 与 `data-render-ms` |
| 网络节点 / 边 | `.node[data-type][data-id]`；`.edge[data-edge]` 与透明 `.edge-hit` |
| 检查栏 / 质量问题列表 | `.coc-net-inspector` / `.coc-quality-issues` |
| 面板坞 | `#dsh-panel-dock` |

运行、契约直接向调试区渲染卡片，没有同名 `data-subpanel`。测试优先按 role、可访问名称和稳定属性定位。重排 DOM 时同步维护 [tests/ui-check.mjs](tests/ui-check.mjs) 的同等覆盖。

## 3. 单文件职责分区

通过函数名定位，避免在文档里维护容易失效的行号。

| 分区 | 关键符号 | 职责 |
|---|---|---|
| 公共工具与样式 | `el`、`textValue`、`api`、`post`、`STYLE` | 安全文本节点、请求封装、全局样式 |
| 面板壳与生命周期 | `mountPanel`、`mountPlayerPanel`、`registerDockPanel` | 挂载、布局记忆、拖拽缩放、面板坞、清理 |
| 会话与工作区 | `resetSession`、`poll`、`renderPanel`、`openGameWizard` | 当前场次、增量状态、页面分发、向导 |
| 主持与剧情 | `renderChatEntries`、`renderLiveChecks`、`renderStatusPanel`、`renderPlotPanel` | 对话、检定和可写的游戏状态操作 |
| 网络模型与布局 | `createNetModel`、`createNetLayout`、`buildSkeletonView`、`buildSceneOverview` | 建立节点/边索引、视图投影与坐标 |
| 网络绘制与交互 | `paintNetSvg`、`paintNetNodes`、`paintNetEdges`、`bindNetViewport` | 读取布局生成 SVG，统一视口事件与相机 |
| 网络详情与校对 | `renderNetNodeDetail`、`renderNetEdgeDetail`、`renderNetStatus`、`renderQualityIssues`、`renderDpEditorCard`、`renderStructureCard` | 详情、来源与质量、JSON 校对 |
| 管理工具 | `renderDebugPanel` 及 `renderImportPanel` 等 | 导入、资产、实体、设置、运行与契约 |

`renderNetContent` 负责组装工具栏、检查栏、筛选与绘图生命周期；新的布局算法不要直接塞进这个编排函数。`el` 的内容参数使用 `textContent`，`textValue` 只负责转字符串；不要把它误当 HTML 转义器，再将结果拼入 HTML。

## 4. 状态、请求与销毁

### 状态的归属

| 状态 | 存储 | 注意事项 |
|---|---|---|
| 当前场次 | localStorage `coc-keeper:game` | Keeper 与玩家视图共享，默认为 `default` |
| 一级 Tab | localStorage `coc-keeper:tab` | 当前值为四个 Tab 的 key；旧 `chat` 偏好兼容到主持 |
| Keeper 位置与尺寸 | localStorage `coc-keeper:rect` | 重置位置与大小会清除；恢复时钳制标题栏位置 |
| Keeper 显隐 | localStorage `coc-keeper:visible` | `1 / 0`；最小化后可从面板坞恢复 |
| 网络查询、选择、视图相机 | 内存 `NET_UI` | 不保证刷新后保留；切场次清空查询、选择与相机 |
| 游戏数据、草稿、质量报告 | 后端；前端 `S.digest` 等为快照 | 不从 SVG 或布局坐标反写业务状态 |

普通请求走 `api` / `post`；`post` 补入当前 `game`。导入进度使用流式响应。Keeper 约每 2.5 秒轮询 `/coc-api/state`，玩家约每 3 秒轮询 `/coc-api/player-view`，不是 WebSocket 实时同步。

`stateRequest` 与 `netRequest` 序号及请求场次校验，阻止迟到响应覆盖新场次；网络回包还检查容器是否连接。修改异步加载时延续这一约定。不要让旧场次数据重新进入新场次画布。

网络重绘前调用相机 `dispose`，使用 `AbortController` 解除委托监听，取消动画帧并断开 `ResizeObserver`。解析容器的 `_dispose` 同时清除筛选定时器。面板销毁还需移除轮询、DOM、面板坞注册和相关全局回调。

## 5. 网络图数据流与必须保留的语义

```text
/coc-api/deep-parse + S.digest
        ↓ createNetModel
原始节点 Map（type:id）与去重边表
        ↓ createNetLayout
骨架投影 / 场景聚合 → 可见节点、可见边、坐标与画布尺寸
        ↓ paintNetSvg
离线组装 SVG → 一次替换视口内容
        ↓ bindNetViewport
事件委托、邻接索引、缩放/平移、迷你导航 → DOM 详情
```

`createNetModel` 合并运行时摘要与深度解析，保留运行时揭示/抵达等信息，补入解析语义字段。节点按 `kp / br / end` 分类；端点解析集中在 `netResolveNode`，兼容既有 ID 与旧数据引用，避免各 renderer 自行匹配端点。边去重与选项补边发生在模型阶段。

布局阶段建立当前视图的投影，计算 `_x / _y`，并附带 `_main`、`_returnBadge`、`_sceneAgg` 等展示信息及合成节点/边。绘制阶段只读取布局结果，不再次推导拓扑或改写接口数据。

两种视图都必须保留：

1. **剧情从左向右推进**，主线、并行分支和汇聚可以辨认。
2. **主线为金色**；条件连接和推断连接有不同线型，详见检查栏图例。
3. **骨架总览**显示主线、枢纽、分支与结局，减少检定细节占用；被折叠的检定节点仍可从索引搜索并查看条件。
4. **场景总览**聚合场景关键点，保留场景之间的关系及分支/结局；聚合节点详情可进入成员关键点，聚合边可追溯原始边。
5. **hover 看线路**：节点与边悬停时突出关联部分，离开后恢复；点击查看详情。
6. **返回语义**以 `↩` 角标表达；独立虚拟返回节点被收敛，返回边默认隐藏，可在「显示与图例」打开。

标题栏数量是**当前投影的可见节点/边数量**，可能包含合成骨架边，也可能因场景聚合或隐藏返回边减少。它不应与原始 JSON 数量强行相等。图中存在一个结局、索引能打开结局详情，也不等于运行时所有前置条件都可满足；后者要用后端图与门禁测试验证。

## 6. 性能与交互维护

- **布局缓存**：一次 `renderNetContent` 生命周期内按视图缓存；切视图复用布局，返回边选项变化时清缓存。搜索和筛选只更新匹配样式与结果列表，不重新布局或替换 SVG。
- **委托与邻接索引**：节点/边共用视口监听，hover 查询预建邻接关系，只更新上一次和本次关联元素。不要在每次指针移动时遍历所有 SVG 元素或给每条边绑定监听。
- **批量写入**：SVG 离线组装后提交；搜索结果和聊天增量用 `DocumentFragment`；检定快照不变时不重画检定卡。
- **相机更新**：平移/缩放合并到 `requestAnimationFrame`，通过 CSS transform 应用；视口尺寸由 `ResizeObserver` 缓存，避免逐帧读取布局。拖动超过阈值后抑制点击，防止平移结束误开详情。
- **渐进显示**：缩放小于 30% 时隐藏节点文字；可见节点与边合计超过 200 时省去节点原生 SVG title。边的完整说明放在点击详情中，减少画布文字负担。
- **筛选**：100ms 防抖，非匹配节点淡化以保留上下文。搜索命中的折叠节点可以打开详情，但未必有独立图形可居中。
- **大图导航**：滚轮以指针位置为缩放锚点；缩放按钮、适应画布、100% 与 Canvas 迷你导航复用相机。不要重引入场景条带换行布局。
- **对话滚动**：用户接近底部时才跟随新消息，阅读历史消息时不强制拉回底部。

键盘交互包括向导焦点循环与 Escape 关闭、网络节点 Enter/空格打开详情、迷你导航左右箭头移动。继续使用原生按钮及 `aria-selected / aria-pressed / aria-expanded`；这不代表已完成全部屏幕阅读器或移动端兼容性验收。

## 7. 检查栏、质量与写入操作

检查栏包含结局导航/匹配节点、节点与边详情，以及按需首次渲染的四个折叠区：质量统计与审校报告、显示与图例、校对编辑与确认生效、剧本结构编辑。

### 质量报告的准确解释

`renderNetStatus` 读取保存的 `deepParse.quality`，显示结构、规则、审校记录与分块记录计数。没有质量报告时显示「暂无质量报告」，不要填出看似通过的零值。

当前后端在 preflight 与规则审校均为 0 high / 0 medium 时，可以跳过 LLM 语义审校和分块审校（`43a8680`）；`runReview: true` 也不代表强制执行。现有质量数据没有充分标明这两项是否实际执行，因此 **0 条问题记录不能标成“已审校通过”**。`meta.status === "confirmed"` 仅表示确认生效，也不是质量保证。

`renderQualityIssues` 管理自己的 `.coc-quality-issues` 卡片。展开/收起或切严重程度只替换问题列表，必须保留来源、质量计数与解释文字；不要清空其父容器。

### 两类编辑

| 操作 | 请求 | 使用约定 |
|---|---|---|
| 深度解析保存草稿 | `POST /coc-api/deep-parse`，`deepParse`、`status: "draft"`、`source: "manual"` | 先解析 textarea JSON，再由服务端归一化、保存 |
| 深度解析确认生效 | 同端点，`action: "confirm"` | 确认的是**已保存版本**，不会提交 textarea 中未保存的改动 |
| 剧本结构编辑 | `POST /coc-api/structure`，`sections` | 保存结构数组并刷新状态，影响剧本结构，不能当作画布排版保存 |

当前编辑器是 JSON 校对闭环，没有拖拽节点改业务拓扑的图形编辑模式。写入前后需要校验当前场次与服务端返回结果；不要把移动画布、搜索或选择视图变成保存操作。

## 8. 重构后的维护清单

已删除演化视图 `buildEvolutionView` / `flowMode` 分支、旧条带布局残余，以及无入口的 `NET_UI.focus / foldChecks` 状态。原先的聚焦最终结局改为结局导航与搜索定位；检定节点通过索引查看；返回边开关集中到显示与图例。删除和重置面板操作集中在标题栏更多菜单。

修改前端后运行语法检查、UI 冒烟和全量测试；修改网络图还要完成《星孩》《两面不是人》两种视图的真实浏览器探针。完整步骤、数据准备和计时口径见 [TESTING.md](TESTING.md)。不要只凭静态截图或空场次 smoke 判断大图流畅性。

开发文档以本文维护当前前端；[TECHNICAL.md](TECHNICAL.md) 保留全局技术背景；[NETWORK-TOPOLOGY.md](NETWORK-TOPOLOGY.md) 保留拓扑设计依据。新功能要同时更新本文、[用户手册](USER_GUIDE.md) 和受影响测试，避免把历史计划当成现状。

# dsh-coc-keeper 测试规范

> 文档版本：v1.0
> 适用范围：开发、重构、Bug 修复、测试编写

---

## 一、基本开发节奏

遵循：

```
开发模块 → 单元测试 → 接入已有模块 → 集成测试 → 更新 Vertical Slice → 再继续开发
```

每完成一个核心模块，都应至少保证其主要行为可以独立测试。

每形成一条新的跨模块业务链路，都应补充对应的集成测试。

不要采用"所有模块全部完成后再第一次整体联调"的方式。

---

## 二、测试层级

### 1. Unit Test（单元测试）

测试单个模块自身逻辑。

重点覆盖：

- Rule Engine（dice, sanity, combat, skill-growth）
- Event（EventBus publish/subscribe/history）
- WorldState（character/entity/flag/clue/relationship 操作）
- Game Clock（parseGameTime, advanceGameTime, formatGameTime）
- Plot Graph（node activation, frontier, precondition check）
- Clue Graph（clue management, visibility, fallback methods）
- Scenario Compiler（pattern compilation, AI prompt building）
- Character Parser（parseCharacters, normalizeCharacter）
- Narrative Recovery（未来）

要求：

- **确定性、快速、无需 LLM、无需 UI。**
- 对于骰点等随机逻辑，测试时固定随机种子或使用 `Math.random` mock。
- 每个测试文件独立运行，不依赖全局状态。

### 2. Integration Test（集成测试）

当两个或多个模块开始连接时，立即测试模块边界。

例如：

- Rule Engine → Event → WorldState
- ClueDiscovered → Trigger → Plot Frontier 更新
- Scenario Compiler → PlotGraph + ClueGraph 初始化

重点测试：

- 数据结构是否一致
- Event 是否正确传递
- State 是否正确变化
- 模块是否出现不必要的相互依赖
- 异常输入是否被合理处理

**发现模块接口不合理时，优先修正接口，不要通过增加临时兼容代码掩盖问题。**

### 3. Scenario Test（场景测试）

维护少量固定的跑团场景，用于验证跨模块剧情逻辑。

至少逐渐覆盖：

#### 正常推进

```
合理调查 → 检定成功 → 获得线索 → Trigger → Plot 推进
```

#### 随机失败

```
合理调查 → 连续骰点失败 → 原线索未获得 → Narrative Recovery → 出现替代机会 → 剧情仍然可推进
```

#### 玩家决策失败

```
玩家主动做出重大错误行为 → 剧情路径关闭 → 不应被 Narrative Recovery 无条件救回
```

#### 时间事件

```
时间推进 → 到达触发时间 → Event/Trigger → 世界状态与剧情变化
```

要求：

- 固定玩家输入、WorldState、骰点结果、Trigger 条件
- 使测试结果可复现

### 4. E2E / Vertical Slice Test（端到端测试）

始终维护至少一条完整的最小闭环：

```
玩家输入 → Director → Skill/Rule Tool → Rule Result → Event → State
→ Trigger → Clue/Plot → Narrative Recovery → Narrator
```

- 早期允许其中部分模块使用 Mock
- 随着真实模块完成，逐步替换 Mock
- 每次重大架构修改后都运行这条 Vertical Slice

---

## 三、LLM 测试与程序测试分离

**不要让普通单元测试依赖真实 LLM。**

程序正确性测试主要验证：

- Rule
- State
- Event
- Trigger
- Plot
- Clue
- Clock

这些测试应保持确定性。

LLM 相关能力单独作为 AI Behavior Eval（未来实现），例如：

- 是否正确判断需要检定
- 是否选择合理规则
- 是否泄露隐藏信息
- 是否凭空修改核心剧情
- 是否错误使用 Narrative Recovery
- 是否遵守 Director 的信息披露范围
- Narrator 是否忠实于规则结果

**LLM 表现波动不能导致整个基础测试体系变得不稳定。**

---

## 四、Bug 定位原则

完整流程出现问题时，按照：

```
E2E 发现问题 → Integration 定位模块边界 → Unit 定位具体实现
```

进行排查。不要只修复最终表现。

需要找到：

- 哪个模块首先产生了错误状态
- 哪个 Event 或 Contract 出现问题
- 是否属于架构边界设计错误

并补充对应的回归测试，防止同类问题再次出现。

---

## 五、当前阶段要求

当前仍处于早期开发阶段，因此：

1. 测试应轻量，不要过度建设测试框架。
2. 优先测试核心业务逻辑，而不是 UI 细节。
3. 核心模块新增功能必须同步增加测试。
4. 新的跨模块链路必须有集成测试。
5. 始终维护一条可运行的 Vertical Slice。
6. 测试尽可能固定输入和随机结果。
7. LLM 尽量使用 Mock，真实模型测试单独执行。
8. 每发现一个重要 Bug，都尽量增加对应回归测试。
9. 重构后旧测试失效时，应判断是测试过时还是行为发生了非预期变化，不要直接删除。
10. 优先保证测试能够帮助快速开发和重构，而不是追求形式上的高覆盖率。

---

## 六、测试文件组织

```
tests/
├── run-tests.mjs           # 测试运行器（入口）
├── runner.js               # 轻量测试 harness（assert, describe, it）
├── unit/
│   ├── dice.test.mjs
│   ├── events.test.mjs
│   ├── clock.test.mjs
│   ├── character-parser.test.mjs
│   ├── world-state.test.mjs
│   ├── sanity.test.mjs
│   ├── combat.test.mjs
│   ├── skill-growth.test.mjs
│   ├── plot-graph.test.mjs
│   ├── clue-graph.test.mjs
│   └── scenario-compiler.test.mjs
├── integration/
│   ├── rule-event-state.test.mjs
│   ├── clue-trigger-plot.test.mjs
│   └── scenario-init.test.mjs
├── scenarios/
│   ├── normal-investigation.test.mjs
│   ├── random-failure-recovery.test.mjs
│   ├── decision-failure.test.mjs
│   └── time-event.test.mjs
└── e2e/
    └── vertical-slice.test.mjs
```

---

## 七、测试运行

```bash
# 运行所有测试
node tests/run-tests.mjs

# 运行指定测试文件
node tests/run-tests.mjs unit/dice

# 运行指定层级
node tests/run-tests.mjs unit
node tests/run-tests.mjs integration
node tests/run-tests.mjs scenarios
node tests/run-tests.mjs e2e
```

---

## 八、总体原则

**边开发、边测试、边集成。**
不要等系统完成后才发现模块无法组合。
测试体系应该随着系统架构一起成长。
---

## 九、前端验收

前端结构与稳定 DOM 入口见 [FRONTEND.md](FRONTEND.md)，真实操作路径见 [USER_GUIDE.md](USER_GUIDE.md)。以下按 `main` 的 `228e32f` 核对。

### 9.1 常规命令

在仓库根目录执行：

```bash
node --check lib/client.js
npm run ui-check
node tests/run-tests.mjs
```

- 修改 `lib/client.js`、前端 UI 或 DSH 适配层时，执行以上三项；只改后端或 Markdown 文档时按 `AGENTS.md` 至少执行全量测试，无需重复 UI 冒烟。
- 全量测试当前基线为 **58/58 个测试文件通过**，不是只有 58 条内部断言。
- `ui-check` 使用 `playwright-core` 与已安装的 Chromium。缺少浏览器时执行 `npx playwright-core install chromium`。
- 脚本自动启动 `npx @deepseek-ai/dsh web --port 0 --no-open` 并解析启动 URL；也可通过 `DSH_WEB_BIN` 指定已有 DSH 可执行文件。
- **确认 web profile 装载的是待测仓库的插件路径。** 仅切换 shell 的 cwd 或 Git worktree 不会自动更新 profile 中的插件引用。并行开发可用独立 `DSH_HOME`、独立 web profile 和复制的测试场次，避免加载到另一份前端或修改正式游戏。
- DSH 启动 URL 可能包含访问令牌；在浏览器中使用完整 URL 完成访问，不把它写进提交、报告或截图。

### 9.2 UI 冒烟覆盖与边界

[tests/ui-check.mjs](tests/ui-check.mjs) 当前完整运行应为 **28/28**：

| 范围 | 检查内容 |
|---|---|
| 挂载与一级导航 | Keeper 挂载；主持、剧情、解析、调试均可达；主持输入/快捷骰可见 |
| 剧情子页 | 状态总览、剧情结构可切换 |
| 调试子页 | 导入、实体、人物、卡库、设置有内容；运行、契约可达 |
| 解析页 | 页面切换后有内容；空场次也可通过，因此不等于网络图验收 |
| 实体 | 有实体时检查揭示/隐藏入口；无实体时明确记录跳过 |
| 新建场次 | 向导挂载、三步切换、AI 调查员选项、关闭 |
| 玩家与面板坞 | 玩家面板挂载、Keeper 最小化、面板坞恢复 |
| 浏览器错误 | `pageerror` 为 0 |

其中部分旧子按钮通过 DOM click 触发，面板坞恢复使用事件派发。因此 28/28 不能代替真实指针命中测试。冒烟也不创建最终场次、不验证真实 LLM 主持/导入质量、不覆盖大图的完整数据及流畅度。UI 改动导致选择器失效时可以更新测试，但不能缩减上述覆盖来换取通过。

### 9.3 大图真实浏览器探针

修改网络图布局、渲染、交互或相关 CSS 时，额外测试《星孩》和《两面不是人》的**骨架总览、场景总览**共四个组合。

**准备数据与服务**：

1. 在待测服务的 `dataDir/games/` 准备已有解析的测试副本 `verify-xinghai` 和 `verify-liangmian`，不要覆盖正式场次。测试资料和临时探针放入已忽略的 `tests/tmp/` 或其他临时目录；这些本地夹具不保证存在于新克隆中。
2. 验收数据应覆盖长/中图规模：原要求约 109 节点/151 边与 39 节点/56 边。实际文件可能随解析更新而变化，先记录文件版本、原始数量与结局数。视图数量包括合成节点/边且受聚合影响，不能硬编码为原始数量。
3. 在仓库根目录启动：

```bash
npx @deepseek-ai/dsh web --port 0 --no-open
```

用启动输出的完整 URL 打开真实浏览器，访问成功后在同源页面设置：

```js
localStorage.setItem('coc-keeper:game', 'verify-xinghai');
localStorage.setItem('coc-keeper:tab', 'net');
localStorage.setItem('coc-keeper:visible', '1');
location.reload();
```

**每种视图检查**：

- 左向右推进、主线/分支/汇聚关系、金色主线、`↩` 返回语义存在；场景总览有聚合节点与场景间关系。
- 清除筛选，从结局导航逐一打开详情；星孩 **5 个结局**、两面 **4 个结局**均能找到。这里验证 UI 可访问性，运行时结局前置条件仍由后端测试验证。
- 使用真实鼠标 hover 节点与边，关联线路高亮，移开恢复；点击节点/边可打开正确详情，场景聚合可继续查看成员与原始边。
- 实际滚轮缩放、拖拽平移、迷你导航、适应画布、100% 均有效；拖动结束不误触详情。缩放小于 30% 的文字降级可以恢复。
- 搜索、类型/场景筛选和清除筛选有效；过滤时保留同一个 SVG，不重新排布整图；无结果有提示，被折叠的检定节点仍可从索引看详情。
- 展开/收起质量问题与切换严重程度后，来源、计数和解释仍保留；分别核对有问题记录、全零记录、缺失报告的显示，不能把后两者称为“审校通过”。
- 切换两种布局、开关返回边、收起检查栏、调整面板大小后交互仍有效；宽面板和不超过 760px 的窄面板均检查。
- 从场次选择器切到 `verify-liangmian` 后重复测试；快速切换时不能被旧响应覆盖，查询/选择不串场次。
- 浏览器全程 **0 `pageerror`**，控制台记录其他异常供排查。

**性能记录**：

可从 `.coc-net-viewport.dataset.renderMs` 读取最近一次 `draw` 的同步耗时（毫秒），同时记录 `data-layout`、可见节点/边数、浏览器、面板尺寸、缩放与是否命中布局缓存。它覆盖布局/绘制/绑定的同步工作，**不包含请求耗时、后续筛选、动画帧、浏览器绘制与合成**，不能单独用于宣称 60fps。

连续交互时另采集动画帧间隔或 Performance 面板中的长任务，注明采样时段、次数与设备。目标是两个样本的四种组合均无明显阻塞、拖动和 hover 能及时响应。不要拿单次最快渲染值掩盖长任务或交互停顿。

交付报告保留各组合结果、错误数与计时口径；临时脚本、截图、数据、访问令牌和日志不提交。结束后关闭本次启动的服务。

---

## 十、标准剧情点预设 / Replay 夹具（减少完整 E2E 频率）

完整剧本 E2E 只放在关键节点（一批 P1 合入后、发布前、前端调试工具大改后）。
中间暴露的问题按以下方式消化：

1. **标准剧情点跳转**：`lib/shared/testing/story-presets.js` 定义《墨渊》关键节点
   （arrival / door / study-entered / diary-found / rug-revealed / spell-decoded / final-rite）。
   - KP 调试面板“剧情点跳转（测试）”按钮 → `POST /coc-api/debug {action:"gotoPreset", preset}`。
   - 单元测试直接 `applyStoryPreset(flat, "diary-found")` 构造同一状态。
2. **夹具导出**：`POST /coc-api/debug {action:"exportFixture"}` 把当前场次导出为
   可复用 JSON；E2E 失败后先导出夹具，再固化成 replay/unit 测试。
3. **Replay 测试**：`tests/replay/` 用 stub LLM + 预设/夹具状态回放关键输入，
   断言 debug 快照（pendingChecks/resolvedChecks/passedCheckpointIds/keypoints/branches），
   不启动浏览器、不依赖真实 LLM。
4. **新增预设时**：同时更新 `STORY_PRESET_NAMES`、`lib/client.js` 的 `DEBUG_PRESETS`，
   并补 `tests/unit/story-presets.test.mjs`。

---

## 十一、LLM 导入验证（非自动化，真实模型）

真实 LLM 深度解析不进入常规自动化测试（见第三节）。批量验证导入质量时使用：

```bash
node scripts/import-verify-4scenarios.mjs          # 全部 4 个验证剧本
node scripts/import-verify-4scenarios.mjs 对流     # 只跑指定剧本（按 gameId/label 子串过滤）
```

- 脚本跑完整导入流程（结构窗口分析 → 深度解析 loop → 保存），保存状态与基线 JSON 到 `artifacts/import-verify/4scenarios/`。
- LLM 调用按 `{messages, options}` 做 SHA256 缓存（`artifacts/import-verify/4scenarios/cache/`），重跑自动命中缓存。
- 通过条件（两档）：
  - **硬门禁（必须全绿）**：`preflight h0/m0`、`rule h0/m0`、未连线场景点 = 0。
  - **语义门禁（B 级）**：`review ≤ h0/m2`、`chunk ≤ h0/m2`。
- 当前确定性检查干净时可跳过语义审校；报告里的零值不能证明审校实际执行。需要评估模型审校质量时，先检查本次运行是否进入相应阶段，不能只看 `review/chunk` 计数。
- 历史基线与限制见 `PLAN.md` E 阶段与 `TECHNICAL.md` 7.5；历史执行结果不等于当前运行重新通过。

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

## 五、UI 冒烟检查（Playwright）

自 Step 10 起，前端按钮/面板交互必须通过 `npm run ui-check`：

```bash
npm run ui-check
```

- 使用 `playwright-core` + 已安装的 headless chromium（`npx playwright-core install chromium`）。
- 真实启动 `dsh web --port 0`，检查面板挂载、调试子按钮切换、新建场次向导三步、玩家面板挂载。
- 交付前必须 14/14 通过；新增前端按钮时同步扩充检查项。
- 注意：这是冒烟检查，不替代真实 E2E（真实 E2E 需用户配合）。

---

## 九、标准剧情点预设 / Replay 夹具（减少完整 E2E 频率）

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

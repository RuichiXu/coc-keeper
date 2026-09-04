# 剧情网络拓扑保真设计（讨论稿）

> 状态：已讨论定方向，待实施。
> 关联：`PLAN.md` 当前待办 0。本文档是后续开发的详细说明，新对话请先读本文再动手。

---

## 1. 背景与问题

当前 deepParse 生成的剧情网络在视觉上接近单线：只有最终分支/结局附近出现分支，中段大量场景被串成一条链。

根因（详见 2026-09-05 讨论）：

1. **中段没有分支节点类型**：chunk 阶段只允许生成 `keyPointConditions / branchConditions / plotEdges`，不允许生成 `branches/endings`。中途路线选择只能被降维成“条件边”或“普通边”。
2. **连通性修复按扁平 `order` 串链**：`repairDeepParseConnectivity` 把所有 `flowRole=main` 场景按 `order` 排序，缺出边就补 `继续调查` 指向下一个，缺入边就从前一个补入边；支线/线索从最后一个主场景拉 hook。于是并行幕、可选遭遇、支线全被拉成一条链。
3. **门禁在奖励连通、惩罚悬空**：`preflight h0/m0 + 未连线=0` 不理解“可选/并行/条件可达”，导致确定性修复为了过门禁而牺牲拓扑保真。
4. **分块模型看不到全局结构**：chunk prompt 只给本场景原文 + 扁平场景速查表，看不到幕结构、`order/parentId`、可选遭遇标记、支线标记。

---

## 2. 目标

在不破坏“确定性优先、LLM 只做理解”原则的前提下，让剧情网络保留原文的：

- 固定场景触发的可选遭遇（条件入边 + 出边）；
- 同一枢纽下的多个并行可选场景（hub-and-spoke）；
- 多条并行主线/幕（幕级并行，可穿插、可任意顺序）；
- 长期悬空的可选遭遇暂不建模（豁免连通性门禁即可）。

---

## 3. 设计原则

1. **LLM 边优先**：LLM 分块/最终接线画出的边一律保留，确定性后处理只补“LLM 没画”的骨架边。
2. **确定性只做拓扑骨架，不猜语义**：确定性后处理利用结构树（`parentId / level / order / kind / flowRole`）搭骨架；`requires` 和 `label` 优先由 LLM 填写，确定性兜底只给通用 label（如“返回枢纽”）。
3. **兜底边必须标记**：确定性补的边带 `fallback: true`（或同类标记），前端渲染为更淡的虚线，避免与原文明确的边混淆。
4. **旧的扁平串链退役**：`repairDeepParseConnectivity` 中的主线按 `order` 串链逻辑不再使用；新逻辑在新后处理模块中实现，且必须识别 hub/spoke/条件可达。

---

## 4. 节点可达性属性（schema 扩展）

给关键点增加 `reachability` 属性，默认按 `flowRole` 推断：

```
reachability: "strict" | "conditional" | "optional"
```

| 值 | 含义 | 默认来源 |
|---|---|---|
| `strict` | 主线节点：必须有无条件可达路径，或条件只依赖更早可达的主线 | `flowRole=main` |
| `conditional` | 支线/固定场景触发的可选遭遇：条件闭包可达即可 | `flowRole=side/clue` |
| `optional` | 长期悬空可选内容：完全豁免连通性门禁 | 可选遭遇/附录类 section |

**默认档位兜底（开放点 2 已定案）**：无 `flowRole` 或旧数据/LLM 生成节点按以下顺序兜底，统一在 `canonicalizeDeepParse` 或 preflight 入口完成，不要散落各处：

- 有 `parentId` 且父节点是 `flowRole=main` 的场景类 `scene_event` → `strict`；
- 其余无 `flowRole` 的场景类节点 → `conditional`；
- 无 `flowRole` 且非场景类节点（纯事件/线索关键点）→ `conditional`；
- 明确标记为附录/可选遭遇/长期悬空的 section 派生的节点 → `optional`。

实施顺序：先实现统一的条件可达闭包，`strict` 与 `conditional` 先用同一判定；如果主线被条件边放水，再把 `strict` 收紧为“只允许无条件路径”。算法参数化，不硬编码。

---

## 5. 条件可达性判定（preflight 升级）

不再把所有边当无条件边做 BFS。改为**依赖闭包**：

1. 初始可达集 = 开场节点（结构树的入口主场景）。
2. 反复扫描所有入边：如果某条边 `requires` 只引用“已在可达集中的节点/检定点”，或无 `requires`，则把目标加入可达集。
3. 直到不动。

判定结果（开放点 1 已定案）：

- `strict` 节点不在可达集 → high/medium（按门禁口径）。
- `conditional` 节点不在可达集 → 仍报 medium（问题文案明确为“支线条件闭包不可达，需要 hook 边”），但**不要求**“非自环入边/出边”，也不要求“主线场景缺少推进边”；这样硬门禁 preflight m0 不会放水，同时不会把支线当主线要求推进边。
- `optional` 节点不参与判定。

这套判定同时能拦掉“A 依赖 B、B 依赖 A”的循环依赖。

---

## 6. 确定性后处理：结构树骨架

### 6.1 输入

结构分析已产出全局 section 树：`id / parentId / level / order / kind / flowRole / title / displayName`。分块是扁平的，但树是全局的——跨分块连接从这里做，不从块边界做。

### 6.2 同级兄弟的默认拓扑

对每个父节点，看其 `flowRole=main` 的子节点：

- **LLM 已画边**：保留，不覆盖。
- **LLM 没画**：
  - 若子节点标题呈顺序编号（`房间1/房间2`、`地点一/地点二`、`第一幕/第二幕`）→ 按编号顺序补边。
  - 否则 → hub-and-spoke：父章节入口 hub → 每个子场景；每个子场景 → 返回 hub。

### 6.3 返回点做成独立虚拟节点

辐条场景（如 b）的出口**不要直接指回原场景 a**，而是指向 `kp:a-return`（或带 `revisitable`/`virtual` 标记的枢纽节点）：

- 无原文、无事实卡，仅供拓扑；
- 运行时不会重新注入 a 的场景原文；
- 前端可渲染为“枢纽/返回点”样式。

### 6.4 一次性边 / 已消费边

hub → b 的边需要“完成后失效”语义，可选实现：

- `edge.once: true`：目标节点完成后边失效；
- 或入边 `requires.not.keyPointIds: [b]`：已过 b 就不能再进。

优先选 `once` 标记，语义更直观；运行时 PlotGraph 需要消费该标记。

### 6.5 跳过边（hub → 汇合点）

hub → 汇合点 e 的跳过边默认带条件，避免玩家一个辐条不探索就直达汇合点。条件优先由 LLM 填；LLM 没填时：

- 若原文/结构能确定“至少完成 N 个辐条”，写 `requiresAnyOf`；
- 否则保留为“KP 可裁量”的宽松边，并标记 `fallback: true`，不参与 strict 门禁。

### 6.6 幕级并行主线

同级 `chapter` 且 `flowRole=main`：

- **默认不串链**；
- 全剧 hub → 各幕入口；
- 各幕出口 → 终幕 hub；
- 若某两幕实际是顺序关系，LLM 边会画出，保留即可。

### 6.7 章节内缺口与章节间缺口

- **章内缺口**：优先 LLM 边；没有则按 6.2 的 hub 或编号顺序补。
- **章间缺口**：用树找上一章节最后一个 main 节点与下一章节第一个 main 节点补边；若下一章是并行幕，补到幕 hub 而非直接进某一幕。

---

## 7. 与现有修复/门禁的兼容

- 新后处理跑在 `mergeChunkedDeepParseParts` 之后、preflight 之前。
- `repairDeepParseConnectivity` 的“主线按 order 串链”逻辑删除或禁用；保留结局场景点归位等无争议修复。
- preflight 的“场景节点没有非自环入边”“主线场景缺少推进边”按 `reachability` 分级判定：
  - `strict` 节点缺入边/出边 → 仍报 medium；
  - `conditional` 节点只看条件闭包是否可达；
  - `optional` 节点不报。
- 两档门禁不变：硬门禁 `preflight h0/m0 + rule h0/m0 + 未连线=0`，语义门禁 `review ≤h0/m2 + chunk ≤h0/m2`；但“未连线”只统计 `strict` 节点。

---

## 8. 分头调查（明确不在图层面解决）

多人分头调查需要 WorldState 增加 party 维度（多个 currentScene、事件按队归属、context-builder 按队注入），这是引擎级改造，不在本拓扑设计内。图只需要允许“A 队场景与 B 队场景都条件可达”，实际切换靠 KP 叙事切镜头。

---

## 9. 实施顺序建议

1. schema 增加 `reachability` 字段 + 结构分析默认赋值；
2. preflight 改为条件可达闭包 + 分级判定；
3. 新增确定性骨架后处理：结构树 → hub/spoke/编号顺序/幕并行 + `fallback` 边标记；
4. 删除/禁用旧的扁平串链逻辑；
5. 前端把 `fallback` 边和虚拟枢纽渲染成可区分样式；
6. 用《星孩》《两面不是人》回归验证：硬门禁仍全绿，且网络图不再单线。

# dsh-coc-keeper 开发计划

> 当前版本：0.2.0（package.json）
> 最后更新：2026-09-02（D 阶段实际交付，已合并 `main` 并推送远端）

---

## 当前状态总览

- **A 测试工具** ✅ 完成：故事预设、调试跳转、夹具导出、replay 回放。
- **B 补丁替换** ✅ 完成：门禁语义目标键、门禁生命周期闭环、`checkpointId/target` 绑定、结构化剧情前置条件 `requires/requiresAnyOf`、结局事件化 `EndingResolved`。
- **C 游戏引擎增强** ✅ 核心完成：事件目录 + `EventLog`、`WorldState` 统一账本、Rule Engine（SAN/战斗/技能成长）、`PlotGraph` / `TriggerEngine` 接入。遗留的启发式补丁替换方向见 `PATCHES.md`。
- **D LLM 深度剧本解析** ✅ 实际交付并合并 `main`：
  - 分块生成 loop + 模型无关 JSON 提取/归一化/确定性修复 + 修复式审校回灌。
  - 现有 5 剧本 + 隐藏新剧本门禁 3 个全部达到 B 级（审校 h0/m≤2）。
- **下一步**：见下方「当前待办」。

---

## D 阶段实际交付（相对原计划的演进）

> 原计划：导入时 LLM 生成线索图 / 多线剧情图 / 结局条件，输出 KP 校对面板。
> 实际落地：聚焦「深度剧情解析 deepParse」，生成 `keyPointConditions / branchConditions / plotEdges / endings`；结构 preflight + 语义审校双层门禁。

- `lib/core/scenario/chunked-deep-parse.js`：按场景事实切块生成局部条件，最终分支与结局单独生成，确定性合并（最终分支出边/条件由最终生成器独占）。
- `lib/core/scenario/deep-parse.js`：
  - `extractJsonObject` / `canonicalizeDeepParse` / `repairSkeletonWiringDeepParse`：模型无关 JSON 提取 → 条件形态折叠 → 确定性结构修复 → preflight。
  - `runDeepParsePreflight`：校验 `checkpointGroups` 引用真实检定点 id、最终分支 scene 门控、结局 `requires`/直接入边。
- `lib/shared/tools/deep-parse-loop.js`：3 轮 loop；第 1 轮分块 + 最终生成（可配强模型），第 2/3 轮对同一份最终分支/结局草稿做修复式修订（默认廉价模型），审校问题回灌。
- `scripts/`：离线评测与审校脚本（`run-deep-parse-loop` / `run-final-wiring` / `review-deep-parse` / `deep-parse-preflight` 等）。

### B 级门禁结果

| 类别 | 剧本 | 结果 |
|---|---|---|
| 现有 5 剧本 | 墨渊 / 两面不是人 / 观止 / 淡焱 / 盲愚 | 全部 h0/m≤2 ✅ |
| 隐藏新剧本门禁 | 2001：太空漫游 / 无心漫谈 / 星影泠—坍圮之梦 | 3/3 h0/m≤2 ✅ |
| 可选长剧本 | 星孩v1.0（117 页） | h2/m0，未达 B 级 |

---

## 当前待办（下一步）

1. **多最终分支互斥建模** 🔄 进行中：已交付确定性互斥机制（缺口检测 + 自动补 `not.keyPointIds` + 同 scene 去重 + 分支标题场景保留 + 边/结局 requires 同步）。星孩v1.0 的结构性互斥问题已修复，但审校仍会挑出结局条件语义过严等新问题（最新 h1/m1），需与 #2/#4（分块语义审校、规则化审校）配合继续收敛。
2. **分块局部条件语义审校**：当前审校只覆盖最终分支/结局；分块生成的 `keyPointConditions / branchConditions` 只过 preflight 结构校验。
3. **场景实体化**：`currentScene` 是字符串匹配，同名场景标题无法区分；`final-branch-extractor` 与 `inferSceneTransition` 仍是启发式，替换方向见 `PATCHES.md` 行 21/26/27。
4. **审校稳定性** ✅ 已完成：新增 `runDeepParseRuleReview`（`lib/core/scenario/deep-parse-review.js`）确定性规则化审校——条件引用存在性、条件自相矛盾、结局互斥完备性（optionLabel/requires 重复、选项覆盖）、`not.keyPointIds` 过度限制、分支门控与本分支结局冲突、结局 scene 与最终分支 scene 一致性、结局前置关键点循环依赖（只能在抉择后到达的 kp 不能作前置）、入边 requires 与结局 requires 一致性、结局关键词缺失。loop 现为「preflight + 规则化审校 + LLM 审校」三层门禁：规则审校 h0/m≤2 且 LLM 审校 h0/m≤2 才 pass；LLM 审校 prompt 被告知不重复报告规则审校已判问题，修订 prompt 回灌规则审校问题。
5. **收尾清理**：`artifacts/`、`scenarios/` 加入 `.gitignore`；决定 `tests/fixtures/hidden_scenarios/` 是否入库；清理 `exp/deep-parse-quality-0045` 分支；把 `deepParse` 推荐配置写入 README/示例。
6. **KP 校对面板**（原 D 计划遗留）：deepParse 目前导入即 draft 生效；可补「确认/校对」面板，让 KP 手动修正后置为 `confirmed`。

---

## C 阶段实施记录（原计划，已完成核心）

- **C-1 统一账本 + 流水账**：`events.js` 事件目录 + `EventLog`；`flat` 投影到 `WorldState`。
- **C-2 规则补全**：SAN / 战斗 / 技能成长 Rule Engine 接入工具。
- **C-3 多线剧情图**：`PlotGraph` / `ClueGraph` / `TriggerEngine` 接入；deepParse 确认稿通过 `syncPlotGraphFromDeepParse` 汇入剧情图。
- **C-4 统一触发入口**：`TriggerEngine` 承载关键点/分支前置条件；`applyEventDrivenLanding` 作为薄封装。

---

## 开发约定（每次动手前必读）

1. 读 `AGENTS.md`（开发约定）与 `TESTING.md`（测试要求）。
2. `lib/shared/` 与 `lib/core/` 必须 DSH-free。
3. 不要改变现有 `/coc-api` 接口与 JSON 结构；调试面板只做增量。
4. 启发式补丁必须登记 `PATCHES.md`，并写明替换方向。
5. 只改后端内容时不用跑 ui-check；动了 client/DSH adapter 再跑。提交不包含 `node_modules` / 数据目录 / `artifacts/` / `scenarios/`。

---

## 历史记录

- Phase 1（Step 0-12）已完成：Rule Engine 地基、入口切换、持久化迁移、工具迁移、`/coc-api` 与聊天桥迁移、Trigger Engine/ContextBuilder/Knowledge 分层、Director/Narrator、Narrative Recovery/Ending Reachability/Game Clock、资产库与场次分离、人物卡解析增强、Playwright UI 冒烟、ScenarioContract 一/二阶段。
- A/B/C/D 详细过程见 `DEVLOG.md`。

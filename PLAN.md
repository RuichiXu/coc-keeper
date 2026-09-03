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

1. **多最终分支互斥建模** ✅ 已完成：已交付确定性互斥机制（缺口检测 + 自动补 `not.keyPointIds` + 同 scene 去重 + 分支标题场景保留 + 边/结局 requires 同步 + R5b 门控与本分支出边冲突检查）。星孩v1.0 复跑验证（43 块，1040s，3 轮）：最终审校 h0/m0、分块审校 h0/m0、规则审校 h0/m0、preflight h0/m30（leadsTo 指向 ending id、部分检定点分支/关键点不可达等体验项，不阻塞），pass=true，B 级达成。
2. **分块局部条件语义审校** ✅ 已完成：新增 `buildChunkReviewPrompt / buildChunkRevisionPrompt`，loop 第 1 轮对全部有内容的分块跑语义审校（廉价模型、并发、低 reasoning），第 2/3 轮只复审并修复有 high/medium 问题的分块（其余分块保持第 1 轮定稿），分块审校计入 pass 门禁（chunkHigh=0 且 chunkMedium≤2）。真实剧本验证：2001：太空漫游 3 轮 pass（最终审校 h0/m0，分块审校 h0/m0，规则 h0/m1）。
3. **场景实体化**：`currentScene` 是字符串匹配，同名场景标题无法区分；`final-branch-extractor` 与 `inferSceneTransition` 仍是启发式，替换方向见 `PATCHES.md` 行 21/26/27。
4. **审校稳定性** ✅ 已完成：新增 `runDeepParseRuleReview`（`lib/core/scenario/deep-parse-review.js`）确定性规则化审校——条件引用存在性、条件自相矛盾、结局互斥完备性（optionLabel/requires 重复、选项覆盖）、`not.keyPointIds` 过度限制、分支门控与本分支结局冲突、结局 scene 与最终分支 scene 一致性、结局前置关键点循环依赖（只能在抉择后到达的 kp 不能作前置）、入边 requires 与结局 requires 一致性、结局关键词缺失。loop 现为「preflight + 规则化审校 + LLM 审校」三层门禁：规则审校 h0/m≤2 且 LLM 审校 h0/m≤2 才 pass；LLM 审校 prompt 被告知不重复报告规则审校已判问题，修订 prompt 回灌规则审校问题。
5. **收尾清理** ✅ 已完成：`.gitignore` 加入 `/artifacts/`、`/scenarios/`、`/tests/fixtures/hidden_scenarios/`；决定隐藏门禁 PDF 不入库（体积 0.6–11MB、不参与自动化测试，`tests/fixtures/README.md` 说明本地目录结构与复跑方式）；删除本地 `exp/deep-parse-quality-0045` 分支（远端本就不存在）；README 补充 `deepParse` 推荐配置与全部 loopOptions 说明。
6. **KP 校对面板** 🔄 进行中：6a/6b 已交付——「解析」Tab 含 SVG 网络拓扑（场景条带布局、折叠检定分支、聚焦最终结局、搜索/筛选）+ DOM 节点/边详情卡（条件 chips 化、keyPointConditions/branchConditions 挂载条件展示、结局卡片）+ 可折叠审校/门禁问题面板（severity 筛选、通道标注、problem→suggestion）。解析页自动隐藏聊天/快速掷骰区。另修复 `canonicalizeDeepParse` 边端点归一化去重、`POST /coc-api/deep-parse` 改走 canonicalize 并支持保存 quality。待办 6c（编辑模式 + 确认生效闭环）仍待做。

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

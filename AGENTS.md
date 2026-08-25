# dsh-coc-keeper 开发约定

> 面向 AI Agent 和人类开发者的协作规范。

---

## 一、强制阅读要求

在开始以下类型的工作之前，**必须先阅读**对应的文档：

| 工作类型 | 必读文档 |
|---|---|
| 功能开发、重构、架构调整 | `PLAN.md`（当前开发计划） |
| 编写测试、测试策略调整、Bug 修复后的回归测试 | `TESTING.md`（测试要求文档） |
| 理解技术细节、数据流、已知问题 | `TECHNICAL.md`（技术文档） |
| 了解项目功能与使用方式 | `README.md` |

**阅读顺序建议**：

1. `README.md` — 了解项目是什么
2. `PLAN.md` — 了解当前在做什么、下一步做什么
3. `TECHNICAL.md` — 了解技术细节
4. `TESTING.md` — 了解如何测试

---

## 二、核心开发原则

1. **LLM 不是数据库、不是骰子、不是规则引擎。** LLM 负责理解、规划、模糊判断和叙事。
2. **确定性行为尽可能交给程序。** 骰点、伤害、SAN 变化、状态变化由 Rule Engine 执行。
3. **所有重要世界变化进入结构化状态。** WorldState 是唯一事实来源。
4. **重要状态变化尽可能产生 Event。** Event 是模块间的公共连接层。
5. **Core 层不依赖 DeepSeek Harness。** Core 零 DSH 依赖，Adapter 薄封装。
6. **模块通过接口通信，不直接修改其他模块内部数据。**

---

## 三、开发节奏

```
开发模块 → 单元测试 → 接入已有模块 → 集成测试 → 更新 Vertical Slice → 再继续开发
```

不要等所有模块完成后再第一次整体联调。

---

## 四、代码规范

1. 所有 Core 模块使用纯 JavaScript（ES Module），不包含 TypeScript 语法。
2. 使用 JSDoc 标注类型。
3. 每个模块文件建议不超过 500 行。
4. 模块间通过 Event 或明确的函数调用通信，避免直接修改其他模块的内部状态。
5. 新模块放在 `lib/core/<domain>/` 下，通过 `lib/core/index.js` 统一导出。
6. **禁止对 Cordis ctx 或服务对象使用对象展开/浅复制（`...ctx`、`{ ...ctx }`、`Object.assign({}, ctx)` 等）。** ctx 是 Proxy + 原型链依赖容器，展开会降级为普通对象并丢失动态服务解析。包装上下文必须使用 `ctx.extend()`；包装服务必须用 `Object.create(service)` 保留原型链（或在 Service 子类中重写）。
7. **修改 Adapter 层后必须执行真实 Cordis Context 回归测试**（`tests/integration/adapter-tools.test.mjs` 使用 `@deepseek-ai/cordis` 的 `Context`/`Service`），并执行 `npx @deepseek-ai/dsh web --port 0` 启动验证；不能只依赖普通 mock 对象。

---

## 五、架构分层与边界（重构后）

项目由「共享业务层 + DSH 插件薄壳 + 独立网页版」组成：

- `lib/shared/` — 共享业务层：工具逻辑、主持聊天循环、导入器、通用 API。
- `lib/adapter/` — DSH 插件薄壳：DSH/Cordis 专属的服务注册、依赖注入、流式 LLM 适配。
- `lib/client.js` — **唯一**前端源码；独立网页版直接加载同一文件，不复制、不 fork。

长期必须遵守的边界：

1. **通用事件、工具和主持逻辑改在 `lib/shared/tools/`、`lib/shared/chat/` 或 `lib/shared/api/`**；不要继续把主实现写回旧的 `lib/adapter/tools/*.js`。`coc_import`、`coc_read`、`coc_query_rule` 等导入工具已切换到 shared 实现。
2. **DSH/Cordis 专属的服务注册、依赖注入和流式 LLM 适配才放在 `lib/adapter/`。**
3. **前端 UI 统一修改 `lib/client.js`**，不要创建第二份前端；保持原生 DOM，不使用 `require()` 或 DSH 专属浏览器依赖。
4. **`lib/shared/` 和 `lib/core/` 必须保持 DSH-free**：禁止引入 `@deepseek-ai/dsh-tools`、`dsh-llm`、`schemastery`、`cordis` 等依赖。
5. **不要改变现有 `/coc-api` 接口和 JSON 结构。** 若需求确实涉及新接口，只实现插件范围内的改动并明确报告，不要自行修改网页版服务、standalone/**、Cloudflare Tunnel 或登录鉴权。
6. **保持 `lib/index.js` 的 `apply`、`Config`、`inject`、`name` 导出兼容。**
7. **修改后至少运行 `node tests/run-tests.mjs` 和 `npm run ui-check`**；不要提交 `node_modules`、数据目录、`.env` 或日志文件。
8. **场景事实与检定点由 `lib/core/scenario/scene-facts.js` 确定性规则提取**（规则为主、LLM 兜底）；运行时通过 `context-builder` 注入当前场景原文块、事实卡与检定点。KP 叙述的楼层/房间/门锁/人物位置一律以剧本原文为最高权威，事实卡只做摘要，冲突时以原文为准。

## 六、相关文档

- `TESTING.md` — 测试规范与要求
- `PLAN.md` — 开发计划
- `TECHNICAL.md` — 技术文档
- `DEVLOG.md` — 开发日志
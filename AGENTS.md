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

## 五、相关文档

- `TESTING.md` — 测试规范与要求
- `PLAN.md` — 开发计划
- `TECHNICAL.md` — 技术文档
- `DEVLOG.md` — 开发日志
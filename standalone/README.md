# CoC Keeper 独立网页版

独立网页版与 DSH 插件共用 `lib/client.js`。登录后四个工作区、玩家视图、新建场次和面板坞的操作见 **[用户手册](../USER_GUIDE.md)**；修改前端请读 **[前端维护指南](../FRONTEND.md)**，不要另建一套 UI。

## 本地启动

```sh
cd standalone
npm install
npm run server
```

默认地址为 <http://127.0.0.1:3000>，默认访问口令为
`coc-keeper`。公开访问前务必设置 `COC_ACCESS_PASSWORD`。

复用现有 DSH 数据与 `config.json`：

```sh
COC_DATA_DIR=$HOME/.dsh/coc COC_ACCESS_PASSWORD='换成强口令' npm run server
```

也可以复制 `.env.example` 为 `.env` 后修改。API Key 只保存在服务端，
不会发送给浏览器。

## Cloudflare Tunnel

先保持服务器运行，再开一个终端：

```sh
cd standalone
npm run tunnel
```

把输出的 `https://xxxx.trycloudflare.com` 发给好友，对方会先看到登录页。
Quick Tunnel 的免费地址每次可能变化，电脑关机或服务器退出后链接立即失效。
请不要使用默认口令对外开放。

## 冒烟测试

```sh
npm run smoke
```

冒烟测试使用隔离临时数据和 `COC_LLM_MOCK=1`，覆盖健康检查、登录、
创建游戏、聊天、状态日志与删除游戏。

前端改动还需按 [TESTING.md](../TESTING.md) 执行 UI 冒烟及必要的大图浏览器探针；上面的 `smoke` 检查服务端流程，不覆盖浏览器布局与指针交互。

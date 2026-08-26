# CoC Keeper 独立网页版

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

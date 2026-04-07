# CoPaw Integration MVP

这个 MVP 提供一套最小可用方案：

- 业务系统通过 `tenant_id + user_id` 接入
- 中间层统一鉴权、会话隔离、转发 CoPaw
- Vue 嵌入式聊天组件可直接挂在业务页面
- 先不做沙箱隔离

## 架构

1. 业务系统页面嵌入 `CopawChatWidget.vue`
2. 组件请求你自己的中间层 `server`
3. `server` 按 `(tenant_id, user_id, channel)` 管理会话
4. `server` 调 CoPaw webhook/channel 接口
5. CoPaw 返回结果后回传给页面

## 目录

```text
copaw-mvp/
  server/                  # Node.js 中间层
  client-vue/              # Vue 嵌入式组件示例
```

## 快速启动（后端）

```bash
cd copaw-mvp/server
npm install
cp .env.example .env
npm run dev
```

默认监听 `http://localhost:8787`。

## 会话隔离策略

- 隔离主键：`tenant_id + user_id + channel`
- 每个主键映射一个 `session_id`
- `session_id` 存在中间层 SQLite
- 可调用 `POST /api/chat/reset` 重置会话

这样多用户并发时，不会串会话。

## 你需要对接的关键点

1. 按 CoPaw 实际接口改 `.env`：
   - `COPAW_MESSAGE_URL`（默认建议 `http://localhost:8088/api/agent/process`）
   - `COPAW_API_MODE`（默认 `agent_process`）
   - `COPAW_API_KEY` / 鉴权头
2. 按 CoPaw 实际消息 schema，调整：
   - `server/src/copawClient.js` 的请求 payload
   - `server/src/copawClient.js` 的响应解析

## API（中间层）

- `GET /health`
- `POST /api/chat/session`
- `POST /api/chat/message`
- `POST /api/chat/stream`（SSE，支持思考过程和回答增量）
- `POST /api/chat/reset`
- `GET /api/files/content?name=<file>` 或 `?path=<relative/path>`（将工作区生成文件映射为 Web URL）
- `GET /api/admin/sessions`（需配置 `ADMIN_TOKEN` 并携带 `x-admin-token`）

请求头（MVP）：

- `x-tenant-id: your_tenant`
- `x-user-id: your_user`

## Vue 组件接入

见 `client-vue/README.md` 与 `client-vue/src/components/CopawChatWidget.vue`。

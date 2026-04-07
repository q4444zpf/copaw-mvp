# CoPaw MVP - AGENTS 交接文档

最后更新：2026-04-08

## 1. 项目目标

本项目是业务系统接入 CoPaw 的最小可用中间层 + 前端聊天组件方案，目标是：

- 支持多租户多用户会话隔离
- 通过嵌入式 Vue 组件接入业务系统
- 支持流式输出（思考过程、工具调用、最终回答）
- 支持历史会话切换、新建聊天、模型切换
- 暂不实现沙箱隔离

## 2. 当前实现状态

已完成：

- Node/Express 中间层
- SQLite 会话与消息持久化
- CoPaw 请求转发（普通 + 流式）
- SSE 事件转前端（reasoning/tool/assistant）
- 生成文件映射为可访问 URL
- Vue 聊天组件支持 Markdown 渲染与文件内联预览
- 右上角功能：聊天历史、新建聊天、模型切换

## 3. 目录与职责

```text
copaw-mvp/
  .gitignore
  server/
    src/index.js         # API 路由、会话管理、SSE 转发
    src/copawClient.js   # 调用 CoPaw，解析响应
    src/db.js            # SQLite 表与查询
  client-vue/
    src/components/CopawChatWidget.vue
    src/services/copawApi.js
  web-demo/
    src/components/CopawChatWidget.vue
    src/services/copawApi.js
  README.md
  AGENTS.md
```

约定：

- `client-vue` 与 `web-demo` 中的 `CopawChatWidget.vue`、`copawApi.js` 当前是镜像维护，修改时要同步。

## 4. 核心数据模型（server/src/db.js）

表结构：

- `sessions`
  - 主键语义：`tenant_id + user_id + channel` 唯一
  - 字段：`session_id`, `created_at`, `updated_at`
- `messages`
  - 字段：`tenant_id`, `user_id`, `channel`, `session_id`, `direction`, `content`, `created_at`

关键函数：

- `getSession(...)`
- `upsertSession(...)`
- `saveMessage(...)`
- `listMessages(...)`
- `listUserChatSessions(...)`（历史会话聚合）
- `hasSessionMessages(...)`（会话归属校验）

## 5. 后端 API 清单（server/src/index.js）

基础：

- `GET /health`

会话与消息：

- `POST /api/chat/session`：获取或创建当前 active session
- `GET /api/chat/sessions`：当前用户会话列表（用于“聊天历史”）
- `POST /api/chat/session/select`：切换 active session
- `GET /api/chat/history`：拉取历史消息（支持 `session_id`）
- `POST /api/chat/reset`：新建会话并设为 active（用于“新建聊天”）
- `POST /api/chat/message`：非流式消息
- `POST /api/chat/stream`：SSE 流式消息
- `GET /api/chat/models`：模型列表（本质是 agentId 映射）

文件映射：

- `GET /api/files/content?name=...`
- `GET /api/files/content?path=...`

管理排查：

- `GET /api/admin/sessions`（需 `x-admin-token`）

请求头：

- `x-tenant-id`
- `x-user-id`

## 6. 流式事件协议（前端显示依赖）

`/api/chat/stream` 通过 SSE 下发事件：

- `session`：下发 `sessionId`
- `reasoning_delta`：思考过程增量
- `tool_start`：工具调用开始
- `tool_delta`：工具输出增量
- `tool_output`：工具完整输出
- `assistant_delta`：助手回复增量
- `assistant_final`：助手最终文本兜底
- `done`：本轮结束
- `error`：异常

## 7. 前端组件能力（CopawChatWidget.vue）

已实现：

- 聊天消息渲染（user / assistant / reasoning / tool）
- Assistant/Thinking/Tool 输出统一走 Markdown 渲染
- 自动识别回复中的文件路径并生成“文件卡片”
- 图片内联预览、HTML iframe 预览、链接打开与复制
- 右上角操作
  - 聊天历史：展开会话列表并切换
  - 新建聊天：调用 reset 并清屏
  - 模型切换：调用 models 接口并记住选择

本地持久化：

- 模型选择保存在 `localStorage`（按 `tenantId + userId + channel` 维度）。

## 8. CoPaw 转发关键点（server/src/copawClient.js）

- 支持 `agentId` 覆盖请求头 `X-Agent-Id`
- 默认回退到环境变量 `COPAW_DEFAULT_AGENT`
- 支持超时中止：`COPAW_TIMEOUT_MS`
- 支持 `agent_process` 与 `channel_webhook` 两类 payload

## 9. 环境变量（server/.env）

核心：

- `COPAW_MESSAGE_URL`
- `COPAW_API_MODE=agent_process|channel_webhook`
- `COPAW_DEFAULT_AGENT`
- `COPAW_MODEL_OPTIONS`（示例：`reasoner:DeepSeek Reasoner,qa:Knowledge QA`）
- `COPAW_DEFAULT_MODEL`
- `COPAW_TIMEOUT_MS`

文件映射：

- `COPAW_WORKSPACE_ROOT`
- `COPAW_FILE_SEARCH_MAX_DEPTH`
- `COPAW_FILE_SEARCH_MAX_ENTRIES`

数据库与管理：

- `DB_PATH`
- `ADMIN_TOKEN`

## 10. 启动与验证

后端：

```bash
cd copaw-mvp/server
npm install
cp .env.example .env
npm run dev
```

前端（web-demo）：

```bash
cd copaw-mvp/web-demo
npm install
npm run dev
```

检查命令：

```bash
cd copaw-mvp/server && npm run check
cd copaw-mvp/web-demo && npm run build
```

## 11. 已知约束

- 前端 `client-vue` 目录本身无独立 `package.json`，它是组件源码目录。
- `web-demo` 才是可直接运行的 Vite 项目。
- 如果 CoPaw 端接口 schema 变化，优先调整 `server/src/copawClient.js` 的 payload 与解析逻辑。

## 12. 推荐下一步

- 在中间层引入业务系统 JWT 校验并自动解析租户/用户
- 增加会话标题生成与分页加载历史
- 将镜像维护改为 npm 包或 mono-repo 单源组件，减少双份修改风险

## 13. 仓库协作约定（GitHub）

- 远程仓库：`https://github.com/q4444zpf/copaw-mvp.git`
- 默认分支：`main`
- 提交前执行：
  - `cd server && npm run check`
  - `cd ../web-demo && npm run build`
- 根目录已配置 `.gitignore`，默认不提交以下内容：
  - `node_modules/`
  - `.env`（仅保留 `.env.example`）
  - `output/`、`.playwright-cli/`、`*.log`
- 推荐提交流程：
  - `git add .`
  - `git commit -m "<type>: <summary>"`
  - `git push origin main`
